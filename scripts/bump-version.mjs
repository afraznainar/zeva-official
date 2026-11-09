#!/usr/bin/env node
// One place decides the app version, so it can never drift again.
//
// `apk/package.json` holds the version (`1.2.1`); everything else is derived:
//
//   apk/version.json        name + Android versionCode, read by patch-android.mjs
//   deploy/dist/version.json    what the app prints in the You tab
//   deploy/dist/sw.js       the service-worker cache name, so an update
//                           replaces the cached app shell instead of serving it
//
// The .githooks/pre-commit hook runs this whenever a commit touches the app, so
// "the app changed" always means "the version changed". Run it by hand with
// `node scripts/bump-version.mjs` (or `--minor` / `--major`).
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = path.join(root, "apk/package.json");
const lockPath = path.join(root, "apk/package-lock.json");
const apkVersionPath = path.join(root, "apk/version.json");
const webVersionPath = path.join(root, "deploy/dist/version.json");
const swPath = path.join(root, "deploy/dist/sw.js");

const bumpMinor = process.argv.includes("--minor");
const bumpMajor = process.argv.includes("--major");

function readJson(file) {
  return readFile(file, "utf8").then(JSON.parse);
}

async function writeJson(file, value) {
  await writeFile(file, JSON.stringify(value, null, 2) + "\n");
}

const pkg = await readJson(pkgPath);
const current = String(pkg.version || "0.0.0");
const parts = current.split(".").map(Number);
if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
  console.error("bump-version: apk/package.json version is not major.minor.patch: " + current);
  process.exit(1);
}

let [major, minor, patch] = parts;
if (bumpMajor) {
  major += 1;
  minor = 0;
  patch = 0;
} else if (bumpMinor) {
  minor += 1;
  patch = 0;
} else {
  patch += 1;
}

const name = major + "." + minor + "." + patch;
// Android refuses an APK whose versionCode is lower than the installed one, so
// this has to rise with every version — 1.2.1 -> 10201 keeps that obvious.
const code = major * 10000 + minor * 100 + patch;
const built = new Date().toISOString();

pkg.version = name;
await writeJson(pkgPath, pkg);

try {
  const lock = await readJson(lockPath);
  lock.version = name;
  if (lock.packages && lock.packages[""]) lock.packages[""].version = name;
  await writeJson(lockPath, lock);
} catch (error) {
  // No lockfile is not a failure — the version lives in package.json.
}

await writeJson(apkVersionPath, { name: name, code: code, built: built });
await writeJson(webVersionPath, { name: name, code: code, built: built });

const sw = await readFile(swPath, "utf8");
const nextSw = sw.replace(/var VERSION = '[^']*';/, "var VERSION = 'zeva-app-v" + code + "';");
if (nextSw !== sw) await writeFile(swPath, nextSw);

console.log("version " + name + " (android versionCode " + code + ")");
