import { readFileSync } from "node:fs";

interface PackageManifest {
  version: string;
}

// src/cli/ and dist/cli/ are both two levels below the package root.
const manifestUrl = new URL("../../package.json", import.meta.url);

export function readVersion(): string {
  const manifest = JSON.parse(readFileSync(manifestUrl, "utf8")) as PackageManifest;
  return manifest.version;
}
