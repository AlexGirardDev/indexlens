import path from "path"
import fs from "fs/promises"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react-swc"
import tailwindcss from "@tailwindcss/vite"

const CHROME_VERSION_RE = /^\d+(?:\.\d+){0,3}$/
const MAX_VERSION_PART = 65535

function validateExtensionVersion(version: string, source: string): string {
  if (!CHROME_VERSION_RE.test(version)) {
    throw new Error(
      `Invalid extension version from ${source}: "${version}". Expected 1-4 dot-separated numeric parts (e.g. 1.2.3).`,
    )
  }

  for (const part of version.split(".")) {
    const value = Number(part)
    if (!Number.isInteger(value) || value < 0 || value > MAX_VERSION_PART) {
      throw new Error(
        `Invalid extension version from ${source}: "${version}". Each part must be an integer between 0 and ${MAX_VERSION_PART}.`,
      )
    }
  }

  return version
}

async function resolveExtensionVersion(rootDir: string): Promise<string> {
  const overrideVersion = process.env.EXTENSION_VERSION?.trim()
  if (overrideVersion) {
    return validateExtensionVersion(overrideVersion, "EXTENSION_VERSION")
  }

  const packageJsonPath = path.resolve(rootDir, "package.json")
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as { version?: unknown }
  const packageVersion = typeof packageJson.version === "string" ? packageJson.version.trim() : ""

  if (!packageVersion) {
    throw new Error(`package.json at ${packageJsonPath} is missing a string "version" field.`)
  }

  validateExtensionVersion(packageVersion, "package.json version")

  const buildNumber = parseInt(process.env.BUILD_NUMBER || "0", 10)
  const version = buildNumber > 0 ? `${packageVersion}.${buildNumber}` : `${packageVersion}.0`
  return validateExtensionVersion(version, "package.json version + build number")
}

function manifestPlugin() {
  return {
    name: "extension-manifest-plugin",
    async writeBundle() {
      const rootDir = __dirname
      const manifestTemplatePath = path.resolve(rootDir, "public/manifest.json")
      const distManifestPath = path.resolve(rootDir, "dist/manifest.json")
      const manifestVersion = await resolveExtensionVersion(rootDir)
      const template = JSON.parse(await fs.readFile(manifestTemplatePath, "utf8"))

      if (template.manifest_version !== 3) {
        throw new Error(
          `public/manifest.json must define manifest_version as 3. Found: ${template.manifest_version}`,
        )
      }

      const manifest = {
        ...template,
        version: manifestVersion,
      }

      await fs.mkdir(path.dirname(distManifestPath), { recursive: true })
      await fs.writeFile(distManifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8")
      // Keep build output explicit for CI logs.
      console.log(`Generated dist/manifest.json with version ${manifestVersion}`)
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), manifestPlugin()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        background: path.resolve(__dirname, "src/extension/background.ts"),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          // Background service worker must be at the root as background.js
          if (chunkInfo.name === "background") return "background.js";
          return "assets/[name]-[hash].js";
        },
      },
    },
  },
})
