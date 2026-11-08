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

## Local build (only if the Android SDK is installed)

```bash
cd apk
npm install
npx cap add android
npx cap sync android
npx cap open android      # opens Android Studio, then Run
```

`npm run sync` after editing `capacitor.config.json`.

## Known limitation: Google sign-in inside the WebView

Google refuses OAuth inside an embedded WebView (`disallowed_useragent`), so the
"Continue with Google" button does not complete inside the APK yet. Guests can
still order, and the same account works in the browser/PWA.

The escape hatch is already built into the Worker: opening
`/api/auth/google/start?app=1` finishes with a `zeva://auth?code=…` redirect and
`POST /api/auth/exchange` swaps that code for a session. Wiring it up needs:

1. An `intent-filter` for `zeva://auth` in `android/app/src/main/AndroidManifest.xml`.
2. A small handler that reads `code` and calls `/api/auth/exchange` inside the app.

Until that is done and tested, tell customers to sign in on the website once —
the Gold membership and wallet are attached to the same Google account.

## Icons and splash

`deploy/make-favicon.ps1` produces the site icons. For Android, copy
`deploy/dist/icon-512.png` over `android/app/src/main/res/mipmap-*/ic_launcher.png`,
or use `npx @capacitor/assets generate --iconBackgroundColor "#0e0a08"`.
