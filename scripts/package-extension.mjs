import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { resolveExtensionVersion } from "./extension-version.mjs";

const rootDir = process.cwd();
const distDir = path.resolve(rootDir, "dist");
const artifactsDir = path.resolve(rootDir, "artifacts");
const FIXED_MTIME = new Date("1980-01-01T00:00:00.000Z");

function isDirectory(mode) {
  return (mode & 0o170000) === 0o040000;
}

async function collectFiles(dir, prefix = "") {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const files = [];
  for (const entry of entries) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath, relPath)));
      continue;
    }

    if (entry.isFile()) {
      files.push({ fullPath, relPath: relPath.replace(/\\/g, "/") });
    }
  }

  return files;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toDosDateTime(date) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const hour = date.getUTCHours();
  const minute = date.getUTCMinutes();
  const second = Math.floor(date.getUTCSeconds() / 2);

  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  const dosTime = (hour << 11) | (minute << 5) | second;
  return { dosDate, dosTime };
}

function normalizeMode(mode) {
  if (isDirectory(mode)) return 0o755;
  return mode & 0o111 ? 0o755 : 0o644;
}

function createZip(entries) {
  const chunks = [];
  const centralDirectory = [];
  let offset = 0;
  const { dosDate, dosTime } = toDosDateTime(FIXED_MTIME);

  for (const entry of entries) {
    const fileName = Buffer.from(entry.relPath, "utf8");
    const data = entry.data;
    const crc = crc32(data);
    const compressedSize = data.length;
    const uncompressedSize = data.length;
    const mode = normalizeMode(entry.mode);

    const localHeader = Buffer.alloc(30 + fileName.length);
    let cursor = 0;
    localHeader.writeUInt32LE(0x04034b50, cursor); cursor += 4;
    localHeader.writeUInt16LE(20, cursor); cursor += 2;
    localHeader.writeUInt16LE(0x0800, cursor); cursor += 2;
    localHeader.writeUInt16LE(0, cursor); cursor += 2;
    localHeader.writeUInt16LE(dosTime, cursor); cursor += 2;
    localHeader.writeUInt16LE(dosDate, cursor); cursor += 2;
    localHeader.writeUInt32LE(crc, cursor); cursor += 4;
    localHeader.writeUInt32LE(compressedSize, cursor); cursor += 4;
    localHeader.writeUInt32LE(uncompressedSize, cursor); cursor += 4;
    localHeader.writeUInt16LE(fileName.length, cursor); cursor += 2;
    localHeader.writeUInt16LE(0, cursor); cursor += 2;
    fileName.copy(localHeader, cursor);

    chunks.push(localHeader, data);

    const centralHeader = Buffer.alloc(46 + fileName.length);
    cursor = 0;
    centralHeader.writeUInt32LE(0x02014b50, cursor); cursor += 4;
    centralHeader.writeUInt16LE(0x0314, cursor); cursor += 2;
    centralHeader.writeUInt16LE(20, cursor); cursor += 2;
    centralHeader.writeUInt16LE(0x0800, cursor); cursor += 2;
    centralHeader.writeUInt16LE(0, cursor); cursor += 2;
    centralHeader.writeUInt16LE(dosTime, cursor); cursor += 2;
    centralHeader.writeUInt16LE(dosDate, cursor); cursor += 2;
    centralHeader.writeUInt32LE(crc, cursor); cursor += 4;
    centralHeader.writeUInt32LE(compressedSize, cursor); cursor += 4;
    centralHeader.writeUInt32LE(uncompressedSize, cursor); cursor += 4;
    centralHeader.writeUInt16LE(fileName.length, cursor); cursor += 2;
    centralHeader.writeUInt16LE(0, cursor); cursor += 2;
    centralHeader.writeUInt16LE(0, cursor); cursor += 2;
    centralHeader.writeUInt16LE(0, cursor); cursor += 2;
    centralHeader.writeUInt16LE(0, cursor); cursor += 2;
    centralHeader.writeUInt32LE(((mode & 0xffff) << 16) >>> 0, cursor); cursor += 4;
    centralHeader.writeUInt32LE(offset, cursor); cursor += 4;
    fileName.copy(centralHeader, cursor);

    centralDirectory.push(centralHeader);
    offset += localHeader.length + data.length;
  }

  const centralSize = centralDirectory.reduce((sum, buf) => sum + buf.length, 0);
  const eocd = Buffer.alloc(22);
  let cursor = 0;
  eocd.writeUInt32LE(0x06054b50, cursor); cursor += 4;
  eocd.writeUInt16LE(0, cursor); cursor += 2;
  eocd.writeUInt16LE(0, cursor); cursor += 2;
  eocd.writeUInt16LE(entries.length, cursor); cursor += 2;
  eocd.writeUInt16LE(entries.length, cursor); cursor += 2;
  eocd.writeUInt32LE(centralSize, cursor); cursor += 4;
  eocd.writeUInt32LE(offset, cursor); cursor += 4;
  eocd.writeUInt16LE(0, cursor);

  return [...chunks, ...centralDirectory, eocd];
}

async function main() {
  const stats = await fs.stat(distDir).catch(() => null);
  if (!stats?.isDirectory()) {
    throw new Error(`Missing dist directory at ${distDir}. Run npm run build:extension first.`);
  }

  const manifestPath = path.join(distDir, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (manifest.manifest_version !== 3) {
    throw new Error(`dist/manifest.json must have manifest_version=3. Found: ${manifest.manifest_version}`);
  }

  const version = await resolveExtensionVersion(rootDir);
  if (manifest.version !== version) {
    throw new Error(
      `dist/manifest.json version (${manifest.version}) does not match resolved extension version (${version}). Re-run npm run build:extension.`,
    );
  }

  const packageJson = JSON.parse(await fs.readFile(path.join(rootDir, "package.json"), "utf8"));
  const extensionName = String(packageJson.name || "extension")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "extension";

  const files = await collectFiles(distDir);
  if (files.length === 0) {
    throw new Error(`No files found in ${distDir}. Build output is empty.`);
  }

  const entries = await Promise.all(
    files.map(async ({ fullPath, relPath }) => {
      const [data, stat] = await Promise.all([fs.readFile(fullPath), fs.stat(fullPath)]);
      return { relPath, data, mode: stat.mode };
    }),
  );

  entries.sort((a, b) => a.relPath.localeCompare(b.relPath));

  await fs.mkdir(artifactsDir, { recursive: true });
  const outputFileName = `${extensionName}-v${version}.zip`;
  const outputPath = path.join(artifactsDir, outputFileName);

  const zipChunks = createZip(entries);
  await pipeline(Readable.from(zipChunks), createWriteStream(outputPath));

  console.log(`Created ${outputPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
