import { createHash } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord, type JsonRecord } from "../agent/json.ts";
import { type InstallContext, runChecked } from "./install-context.ts";

const nodeArchitectures: Record<string, string> = { x64: "x64", arm64: "arm64" };
const goArchitectures: Record<string, string> = { x64: "amd64", arm64: "arm64" };
const sha256Pattern = /^[0-9a-f]{64}$/;
const archiveName = ".nibfin-download.tar.gz";

function architecture(names: Record<string, string>, arch: string): string {
  const name = names[arch];
  if (name === undefined) {
    throw new Error(`unsupported architecture ${arch}`);
  }
  return name;
}

/** GETs `url`, following redirects; anything but a 2xx answer fails. */
async function download(context: InstallContext, url: string): Promise<Buffer> {
  const response = await context.fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`GET ${url} answered HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/** Downloads the archive, checks the publisher's sha256 and unpacks it into `dir`. */
async function installArchive(
  context: InstallContext,
  url: string,
  sha256: string,
  dir: string,
): Promise<void> {
  const bytes = await download(context, url);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== sha256) {
    throw new Error(`${url} has sha256 ${actual}, not the published ${sha256}`);
  }
  const archive = join(dir, archiveName);
  await writeFile(archive, bytes);
  const args = ["-xzf", archive, "-C", dir, "--strip-components=1", "--no-same-owner"];
  await runChecked(context, context.executables.tar, args, dir, {});
  await rm(archive);
}

/** The checksum `SHASUMS256.txt` lists for `file`, if any. */
function publishedChecksum(sums: string, file: string): string | undefined {
  for (const line of sums.split("\n")) {
    const [hash, name] = line.trim().split(/\s+/) as [string, string?];
    if (name === file && sha256Pattern.test(hash)) {
      return hash;
    }
  }
  return undefined;
}

/** Node.js from nodejs.org, checked against the release's `SHASUMS256.txt`. */
export async function installNode(
  context: InstallContext,
  version: string,
  dir: string,
): Promise<void> {
  const arch = architecture(nodeArchitectures, context.arch);
  const base = `https://nodejs.org/dist/v${version}/`;
  const file = `node-v${version}-linux-${arch}.tar.gz`;
  const sums = (await download(context, `${base}SHASUMS256.txt`)).toString("utf8");
  const sha256 = publishedChecksum(sums, file);
  if (sha256 === undefined) {
    throw new Error(`no published checksum for ${file}`);
  }
  await installArchive(context, `${base}${file}`, sha256, dir);
}

function isGoArchive(entry: JsonRecord, arch: string): boolean {
  return (
    entry.os === "linux" &&
    entry.arch === arch &&
    entry.kind === "archive" &&
    typeof entry.filename === "string" &&
    /^[\w.-]+\.tar\.gz$/.test(entry.filename) &&
    typeof entry.sha256 === "string" &&
    sha256Pattern.test(entry.sha256)
  );
}

/** The release `go<version>` exactly; `1.20` never matches `go1.20.1`. */
function goArchive(catalog: unknown, version: string, arch: string): JsonRecord {
  if (!Array.isArray(catalog)) {
    throw new Error("go.dev returned an unexpected release list");
  }
  const release = catalog
    .filter(isRecord)
    .find((entry) => entry.version === `go${version}`);
  if (release === undefined) {
    throw new Error(`go${version} is not in the go.dev release list`);
  }
  const files: unknown[] = Array.isArray(release.files) ? release.files : [];
  const file = files.filter(isRecord).find((entry) => isGoArchive(entry, arch));
  if (file === undefined) {
    throw new Error(`go${version} has no linux-${arch} archive`);
  }
  return file;
}

/** Go from go.dev, checked against the sha256 in its release list. */
export async function installGo(
  context: InstallContext,
  version: string,
  dir: string,
): Promise<void> {
  const arch = architecture(goArchitectures, context.arch);
  const list = await download(context, "https://go.dev/dl/?mode=json&include=all");
  const file = goArchive(JSON.parse(list.toString("utf8")), version, arch);
  const url = `https://go.dev/dl/${file.filename as string}`;
  await installArchive(context, url, file.sha256 as string, dir);
}
