import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  name?: unknown;
  version?: unknown;
};

if (manifest.name !== "codexpro" || typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
  throw new Error("CodexPro package metadata is missing a valid version.");
}

export const CODEXPRO_VERSION = manifest.version;
