import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const CHROME_VERSION_RE = /^\d+(?:\.\d+){0,3}$/;
const MAX_VERSION_PART = 65535;

export function validateExtensionVersion(version, source) {
  if (!CHROME_VERSION_RE.test(version)) {
    throw new Error(
      `Invalid extension version from ${source}: "${version}". Expected 1-4 dot-separated numeric parts (e.g. 1.2.3).`,
    );
  }

  const parts = version.split(".");
  if (parts.length > 4) {
    throw new Error(`Invalid extension version from ${source}: "${version}". Maximum 4 numeric parts are allowed.`);
  }

  for (const part of parts) {
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > MAX_VERSION_PART) {
      throw new Error(
        `Invalid extension version from ${source}: "${version}". Each part must be an integer between 0 and ${MAX_VERSION_PART}.`,
      );
    }
  }

  return version;
}

async function readPackageVersion(rootDir) {
  const packageJsonPath = path.resolve(rootDir, "package.json");
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));

  if (typeof packageJson.version !== "string" || packageJson.version.trim() === "") {
    throw new Error(`package.json at ${packageJsonPath} is missing a string \"version\" field.`);
  }

  return packageJson.version.trim();
}

export async function resolveExtensionVersion(rootDir = process.cwd(), { buildNumber = 0 } = {}) {
  const overrideVersion = process.env.EXTENSION_VERSION?.trim();
  if (overrideVersion) {
    return validateExtensionVersion(overrideVersion, "EXTENSION_VERSION");
  }

  const packageVersion = await readPackageVersion(rootDir);
  validateExtensionVersion(packageVersion, "package.json version");

  const version = buildNumber > 0 ? `${packageVersion}.${buildNumber}` : `${packageVersion}.0`;
  return validateExtensionVersion(version, "package.json version + build number");
}

export async function resolveBaseVersion(rootDir = process.cwd()) {
  const packageVersion = await readPackageVersion(rootDir);
  return validateExtensionVersion(packageVersion, "package.json version");
}
