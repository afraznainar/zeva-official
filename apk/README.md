# Zeva Android app

`deploy/dist/app.html` is the ordering app. This folder wraps that same live
page in a native Android shell with [Capacitor](https://capacitorjs.com), so the
APK always shows the current menu — there is no second copy of the app to keep
in sync, and a menu or price edit on the site updates the installed app.

## What the app is

- App id `com.zeva.mandi`, name "Zeva Mandi & Grills".
- `capacitor.config.json` loads `https://site-67005eaaea074aab9c2d40a25debe4c7.freebuff.page/app`
  in the WebView. A custom domain means editing that one `server.url` line.
- Everything the app can do (order, Gold, wallet, history) is the same code the
  website runs, so features do not need to be rebuilt for Android.

## Building the APK (no Android SDK needed locally)

The APK is built by GitHub Actions:

1. Open the repository on GitHub → **Actions** → **Android APK** → **Run workflow**.
2. Wait for the run (first build ~4–6 min: it downloads Gradle and the SDK).
3. Open the finished run → **Artifacts** → download `zeva-app-debug-apk`.
4. Copy the `.apk` to the phone and install it. Android will ask you to allow
   installs from this source the first time.

The same workflow also runs for any `v*` tag push, e.g. `git tag v1.0.0 && git push --tags`.

`app-debug.apk` is signed with the debug key: fine for handing the app to
customers directly or for testing, but Play Store uploads need a release keystore
(keep that file out of git — see the "never commit secrets" rule).

## The APK you can hand out

`apk/Zeva-Mandi-and-Grills.apk` is a signed debug build (package
`com.zeva.mandi`, label "Zeva Mandi & Grills", min Android 5.1, target 34,
version 1.1). The next build is version 1.2, which adds in-app Google sign-in. It bundles `@capacitor/local-notifications`, so order updates and
counter messages arrive as real Android notifications while the app is running;
`@capacitor/app` and `@capacitor/browser` carry the Google sign-in round trip.
Native plugins are the only reason a rebuild is needed — reinstall the APK after
`npm install`, since the native side changed.
Copy it to a phone, tap it, allow "install unknown apps" once. It loads the live
`/app` page, so menu and price changes reach installed phones with no new build.

It is **not** Play Store ready: stores want a release-signed `.aab`, built with
your own keystore (`bundleRelease`). Keep that keystore out of git.

## Local build without Android Studio

The build needs a JDK 17, the Android command-line tools and Gradle. On the
counter laptop they were installed into `%TEMP%` only for the build:

```bash
# JDK 17 (Microsoft build)
curl -L -o jdk17.zip "https://aka.ms/download-jdk/microsoft-jdk-17-windows-x64.zip"
unzip -q jdk17.zip -d /tmp/jdk17

# Android SDK: platform-tools, platforms;android-34, build-tools;34.0.0
curl -L -o cmdtools.zip "https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip"
unzip -q cmdtools.zip -d /tmp/cmdtools-x
mkdir -p /tmp/android-sdk/cmdline-tools
mv /tmp/cmdtools-x/cmdline-tools /tmp/android-sdk/cmdline-tools/latest
JAVA_HOME=/tmp/jdk17/jdk-17.0.21.0.2+1 \
  /tmp/android-sdk/cmdline-tools/latest/bin/sdkmanager.bat --sdk_root=/tmp/android-sdk \
  "platform-tools" "platforms;android-34" "build-tools;34.0.0"

# Capacitor project + icons
cd apk && npm install && npx cap add android
powershell -NoProfile -ExecutionPolicy Bypass -File apk/make-icons.ps1
```

Gradle's own download host times out on this network, so fetch the distribution
from a mirror and run it directly instead of `gradlew`:

```bash
curl -L -o /tmp/gradle.zip "https://mirrors.cloud.tencent.com/gradle/gradle-8.2.1-bin.zip"
unzip -q /tmp/gradle.zip -d /tmp
```

Then, with `apk/android/local.properties` containing
`sdk.dir=C:/Users/HP/AppData/Local/Temp/android-sdk` (forward slashes — the
properties parser eats backslashes):

```bash
export JAVA_HOME=/tmp/jdk17/jdk-17.0.21.0.2+1
export ANDROID_HOME=C:/Users/HP/AppData/Local/Temp/android-sdk
cd apk/android && /tmp/gradle-8.2.1/bin/gradle assembleDebug --no-daemon
cp app/build/outputs/apk/debug/app-debug.apk ../Zeva-Mandi-and-Grills.apk
```

`apk/make-icons.ps1` repaints the launcher icons, adaptive-icon background and
splash screens from `deploy/dist/assets/img/icon-512.png`; rerun it after a logo
change and rebuild.

If the build stops with a resource-merge error naming `merged.dir\values`, the
intermediates are stale — `rm -rf apk/android/app/build` and build again.

## Local build with Android Studio

```bash
cd apk
npm install
npx cap add android
npx cap sync android
npx cap open android      # then Run
```

`npm run sync` after editing `capacitor.config.json`.

## Google sign-in inside the app

Google refuses OAuth inside an embedded WebView (`disallowed_useragent`), so the
app never shows the Google screen itself. Tapping **Continue with Google** in the
You tab (or the sign-in line at checkout) opens the phone's browser through
`@capacitor/browser` on `/api/auth/google/start?next=/app&app=1`; the Worker
finishes the flow there and redirects to `zeva://auth?code=…`. Android routes
that back into the app, `@capacitor/app` raises `appUrlOpen`, and `app.html`
posts the one-time code to `/api/auth/exchange` for the session cookie.

Two things make that work and are easy to lose:

- The `zeva://auth` `intent-filter`. It cannot live in the checked-in manifest
  because `android/` is gitignored and regenerated by `npx cap add android`, so
  `apk/patch-android.mjs` re-applies it (plus `versionCode`/`versionName`) after
  every `cap add`/`cap sync`. Both the GitHub Actions build and the npm scripts
  run it — edit the version numbers there, not in `build.gradle`.
- `@capacitor/app` and `@capacitor/browser` in `package.json`. The native side
  changed, so an APK built before this needs reinstalling; an app that opens the
  Google link inside the WebView shows Google's error instead.

The code is single-use and expires in five minutes. Guests can still order
without signing in.

## Icons and splash

`deploy/make-favicon.ps1` produces the site icons. For Android, copy
`deploy/dist/icon-512.png` over `android/app/src/main/res/mipmap-*/ic_launcher.png`,
or use `npx @capacitor/assets generate --iconBackgroundColor "#0e0a08"`.
