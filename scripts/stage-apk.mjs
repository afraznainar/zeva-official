#!/usr/bin/env node
// Copies the built APK to deploy/dist/zeva.apk so `/apk` can hand it out, and
// refuses to do it quietly when the build is older than the version on the site.
// The APK itself stays out of git (a 4 MB binary per release is not worth it) —
// the deploy uploads the dist folder as it sits on disk.
import { copyFile, stat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apkPath = path.join(root, "apk/Zeva-Mandi-and-Grills.apk");
const versionPath = path.join(root, "apk/version.json");
const target = path.join(root, "deploy/dist/zeva.apk");

const version = JSON.parse(await readFile(versionPath, "utf8"));

let apk;
try {
  apk = await stat(apkPath);
} catch (error) {
  console.error("stage-apk: no APK at " + path.relative(root, apkPath) + " — build it first (see apk/README.md).");
  process.exit(1);
}

const built = Date.parse(version.built);
if (Number.isFinite(built) && apk.mtimeMs < built) {
  console.error(
    "stage-apk: the APK on disk was built before version " + version.name + ", so it would be served as the wrong build.\n" +
    "           Rebuild it with patch-android + gradle assembleDebug, then run this again."
  );
  process.exit(1);
}

await copyFile(apkPath, target);
const size = (apk.size / 1024 / 1024).toFixed(1);
console.log("stage-apk: " + path.relative(root, target) + " is version " + version.name + " (" + size + " MB)");
