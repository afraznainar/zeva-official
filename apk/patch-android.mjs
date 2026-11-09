#!/usr/bin/env node
// `npx cap add android` rebuilds android/ from the Capacitor template, and that
// folder is gitignored — so the `zeva://auth` intent filter and our version
// numbers cannot live in the checked-in project. This script re-applies them
// after every `cap add`/`cap sync`: the GitHub Actions build runs it, and so
// does a local build. It is safe to run twice.
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.join(here, "android/app/src/main/AndroidManifest.xml");
const gradlePath = path.join(here, "android/app/build.gradle");

// The version comes from apk/version.json, which scripts/bump-version.mjs writes
// (and the pre-commit hook keeps current) — never edit it by hand. Android
// refuses an APK whose versionCode is lower than the installed one.
async function appVersion() {
  if (existsSync(path.join(here, "version.json"))) {
    const parsed = JSON.parse(await readFile(path.join(here, "version.json"), "utf8"));
    if (parsed && parsed.name && Number(parsed.code) > 0) return { name: String(parsed.name), code: Number(parsed.code) };
  }
  const pkg = JSON.parse(await readFile(path.join(here, "package.json"), "utf8"));
  const parts = String(pkg.version || "0.0.0").split(".").map(Number);
  const [major = 0, minor = 0, patch = 0] = parts;
  return { name: String(pkg.version || "0.0.0"), code: major * 10000 + minor * 100 + patch };
}

const { name: VERSION_NAME, code: VERSION_CODE } = await appVersion();

// Google sign-in finishes in the phone's browser and comes back to the app on
// zeva://auth?code=… — that scheme has to be declared for Android to route it.
function filterBlock(indent) {
  const inner = indent + "    ";
  const deep = indent + "        ";
  return [
    inner + "<!-- zeva://auth?code=… — Google sign-in returns from the browser -->",
    inner + "<intent-filter>",
    deep + '<action android:name="android.intent.action.VIEW" />',
    deep + '<category android:name="android.intent.category.DEFAULT" />',
    deep + '<category android:name="android.intent.category.BROWSABLE" />',
    deep + '<data android:scheme="zeva" android:host="auth" />',
    inner + "</intent-filter>"
  ];
}

function fail(message) {
  console.error("patch-android: " + message);
  process.exit(1);
}

if (!existsSync(manifestPath)) {
  fail("no Android project yet — run `npx cap add android` first.");
}

let manifest = await readFile(manifestPath, "utf8");
if (manifest.includes('android:scheme="zeva"')) {
  console.log("patch-android: zeva:// filter already present");
} else {
  const lines = manifest.split("\n");
  const at = lines.findIndex(function (line) { return line.includes("</activity>"); });
  if (at === -1) fail("could not find </activity> in AndroidManifest.xml");
  const indent = (lines[at].match(/^\s*/) || [""])[0];
  lines.splice(at, 0, ...filterBlock(indent));
  await writeFile(manifestPath, lines.join("\n"));
  console.log("patch-android: added zeva://auth intent filter");
}

let gradle = await readFile(gradlePath, "utf8");
const before = gradle;
gradle = gradle.replace(/\bversionCode\s+\d+/, "versionCode " + VERSION_CODE);
gradle = gradle.replace(/\bversionName\s+"[^"]*"/, 'versionName "' + VERSION_NAME + '"');
if (gradle !== before) {
  await writeFile(gradlePath, gradle);
  console.log("patch-android: version set to " + VERSION_NAME + " (" + VERSION_CODE + ")");
} else {
  console.log("patch-android: version already " + VERSION_NAME + " (" + VERSION_CODE + ")");
}
