# Zeva Mandi & Grills — working notes

## Save every change, locally and in git

Whenever anything in this project is updated — page copy, styles, Worker code,
print bridge, tooling, generated documents — finish the update by:

1. Writing the change to the file on disk (the OneDrive folder is the source of
   truth; `deploy/dist` is edited directly, there is no build step).
2. Committing it to git with a message that says *why* the change was made.
3. Pushing the commit to `origin` (`github.com/afraznainar/zeva-official`,
   branch `main`) so the backup stays current.

Check `git status` before finishing: nothing the change touched should be left
uncommitted. Leave unrelated in-flight edits out of the commit.

## Never commit secrets

`.tools/`, `deploy/.print-token`, `deploy/*.secret`, `.env*`, `.dev.vars`, `node_modules/`, `*.sqlite` and log files are
gitignored and must stay that way. Credentials live on disk, never in the repo.

## App version

`apk/package.json`'s `version` is the only place the app version is written by
hand. `node scripts/bump-version.mjs` adds a patch (`--minor`/`--major` when the
change deserves it) and derives everything from it: `apk/version.json` (Android
`versionCode` is `major*10000 + minor*100 + patch`, so 1.2.1 → 10201 and an APK
always installs over the last one), `deploy/dist/version.json` (printed as
`Zeva app v…` at the bottom of the You tab, so a phone can prove which build it
is on) and the `deploy/dist/sw.js` cache name — without that the service worker
keeps serving the cached app shell after a deploy. It also writes the name the
phone shows under the icon: the Android launcher label (`Zeva 1.2.3`, applied by
`patch-android.mjs` into the gitignored `strings.xml`) and the home-screen name in
`manifest.webmanifest` / the iOS meta title in `app.html`. Two installs side by
side are then distinguishable at a glance.

`.githooks/pre-commit` runs the bump whenever a commit touches `deploy/dist/` or
`apk/` and stages the files it wrote, so an app change cannot ship without a new
version. It is enabled with `git config core.hooksPath .githooks` (already set in
this clone); a docs-only commit does not bump. `apk/patch-android.mjs` reads
`apk/version.json`, so never edit a version number in `build.gradle` by hand.

## Deploys

The live site is the Freebuff Sites preview
`https://site-67005eaaea074aab9c2d40a25debe4c7.freebuff.page`, deployed from
`deploy/sites.manifest.json`. Social share tags carry that origin absolutely —
if the site moves to a custom domain, run `node .tools/fix-og.js <new-origin>`.

## Android app (PWA)

`deploy/dist/app.html` is the installable ordering app at `/app`; it reads the
menu straight out of `menu.html` at runtime, so a menu edit needs no app change.
Its You tab opens with the tilting foil profile card (photo, name, saved
address, Zeva mark) driven by pointer CSS variables in `tiltAll()`, which also
drives the achievement cards.
`manifest.webmanifest` and `sw.js` make it installable and keep it readable
offline. Its icons come from `deploy/make-favicon.ps1` (rerun it after a logo
change) and its `start_url` is absolute, so a move to a custom domain means
updating the manifest too.

## Accounts, Zeva Gold and orders (D1)

Customer accounts, orders, wallet and Gold live in the Worker module
`deploy/worker/accounts.js` (imported by `deploy/worker/index.js`, both listed in
`deploy/sites.manifest.json`) against the D1 binding `DB`.

- Sign-in with a mobile number is the front door: **WhatsApp one-time codes**.
  `POST /api/auth/whatsapp/start {phone}` asks the provider to send a six-digit
  code, `POST /api/auth/whatsapp/verify {session, code}` checks it and sets the
  session cookie. `/api/config` reports `whatsapp:false` until
  `WHATSAPP_OTP_KEY` is set in Sites → Secrets, and then the You tab shows
  **Continue with WhatsApp**. Optional env: `WHATSAPP_OTP_API` (default
  `https://api.loginwa.com/api`), `WHATSAPP_OTP_TEXT` (`{code}` placeholder),
  `WHATSAPP_COUNTRY_CODE` (default `91`). The code is never generated or stored
  here — the provider sends it straight to the customer, so this server cannot
  leak it. `otp_sessions` holds only session → phone for 5 minutes.
  Guards: 3 codes per number per 10 minutes, 5 wrong tries, single use, and
  Indian numbers must be 10 digits starting 6-9 (autofilled junk is refused
  before a paid message is spent). A verified number signs into the account that
  already has that number saved, so a Google customer who adds their mobile
  keeps one account; the Google `sub` is never overwritten.
  LoginWA's free plan is 100 messages/month with no Meta approval; any provider
  exposing the same `auth/start` + `auth/verify` calls will do.
- Google OAuth is the second option, and is still switched off. Until
  `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set in Sites → Secrets,
  `/api/config` reports `google:false` and no Google button is drawn. Authorised
  redirect URIs (they must match Google's list character for character):
  `https://site-67005eaaea074aab9c2d40a25debe4c7.freebuff.page/api/auth/google/callback`,
  `http://localhost:4173/api/auth/google/callback` and
  `http://127.0.0.1:4173/api/auth/google/callback`. Locally the two credentials
  can live in `deploy/.env` (gitignored) instead of the shell env.
- The OAuth `state` is a signed token carrying `next` and the "opened from the
  Android shell" flag, because Google hands back nothing but `code` and `state`.
  A cancelled Google screen bounces back to `/app?auth=…` instead of an error
  page, and a failed token exchange shows Google's own reason.
- Sessions are HMAC-signed cookies (`zeva_sid`, 90 days; `zeva_admin`, 30 days)
  signed with `SESSION_SECRET` — there is no session table. Rotating that secret
  signs everybody out.
- Any Google account can sign in: `upsertUser` creates a profile row on the
  first sign-in and there is no allowlist or email-domain check, so every
  customer gets their own orders, wallet and Gold. The only thing that narrows
  who can get in is Google's side — a consent screen left in **Testing** admits
  just its listed test users, so it has to be published.
- Because a new profile has a name and photo but no mobile or address, the You
  tab renders its details card first, titled **Finish your profile**, whenever
  `phone` or `address` is still empty; once both are saved the card drops back
  below Zeva Gold. Checkout prefills itself from the saved profile.
- Order statuses: `pending` (customer sees "Pending confirmation") → `preparing`
  (staff pressed **Accept order**) → `out` → `done`, plus `cancelled`. The
  schema batch also rewrites legacy `new`/`ready` rows into the new names.
- Zeva Money is the cashback wallet (`wallet` table). Cashback is credited in
  `adminSetStatus` when an order becomes `done`, never at order time, and a
  cancellation writes the matching negative row. Only once per order.
- Order updates: every status change inserts a row in `notices` for that
  customer, and the dashboard can send free-text messages (`/api/admin/notify`,
  all customers or one order's customer). The app polls `/api/notices?after=`
  and raises a system notification — the Capacitor LocalNotifications plugin in
  the APK, the Notification API in a browser. Delivery therefore needs the app
  open or the tab alive; true background push would need FCM.
- Zeva Gold: `GOLD = { price: 499, months: 6, cashback: 5, freeMetres: 5000 }`
  at the top of `accounts.js`. Free  delivery inside 5 km and ₹5 cashback per
  order are applied **server-side** in `createOrder`, never trusted from the
  browser. Joining is a request (`gold.status = 'pending'`) that staff activate
  once paid; cancelling an order reverses its cashback with a negative wallet row.
- Achievement cards: Zeva Gold members collect a card at 100 delivered orders
  (Silver), 500 (Gold) and 1000 (Diamond). `CARDS` at the top of `accounts.js`
  holds those thresholds; the tier is recomputed from delivered orders on every
  request rather than stored, and `adminSetStatus` folds a new unlock into the
  delivered notification. The You tab shows one full portrait card at a time
  behind Silver / Gold / Diamond tabs (non-Gold see "Zeva Gold only" locks).
  The card is lenticular: the customer's photo fades out as the Zeva mark fades
  in, driven by `--from-left` from the shared `tiltAll()` pointer tilt, so
  tilting the card dissolves one picture into the other.
- Local development: `wrangler` cannot run on this laptop (Device Guard blocks
  workerd), so `/api/*` is served by `deploy/server.js` through
  `deploy/local-accounts.js`, a `node:sqlite` shim of the D1 API using
  `deploy/.local-zeva.sqlite` (gitignored). Test data in that file is disposable.

## Staff dashboard

`deploy/dist/admin.html` is `/admin` — passcode gate (`ADMIN_PASSCODE` secret),
order feed polled every 8 seconds with a WebAudio chime, desktop notification
and tab-title counter, the status filter tabs (Pending, Preparing, Out, Finished, Cancelled, All — the
choice is remembered per device), the Accept → Out for delivery → Delivered buttons, the
message composer that reaches customer phones, and Zeva Gold approvals.

Sound only plays after someone taps **Enable sound** once on the device (browser
autoplay rules); the choice is remembered per device. Nothing here is in the
public nav — share `/admin` and the passcode with staff only. The passcode is
kept on disk at `deploy/admin-passcode.secret` (gitignored).

## Android APK (Capacitor)

`apk/` wraps the same live `/app` page in a Capacitor WebView (`com.zeva.mandi`);
`.github/workflows/android-apk.yml` builds `app-debug.apk` on GitHub Actions
because there is no Android SDK here — Actions → **Android APK** → Run workflow,
then download the artifact. See `apk/README.md`.

Google sign-in cannot run inside a WebView, so the app opens the phone's browser
(`@capacitor/browser`) on `/api/auth/google/start?app=1`; the Worker returns to
`zeva://auth?code=…`, `@capacitor/app` hands that URL to `app.html`, and the code
is exchanged for the session cookie via `POST /api/auth/exchange` (single-use,
five minutes). The `zeva://auth` intent filter cannot live in the manifest,
because `android/` is gitignored and regenerated by `cap add` — `apk/patch-android.mjs`
re-applies it and the app version after every `cap add`/`cap sync`; the version
comes from `apk/version.json` (see **App version**), never from the script.

## App download link

`/download` is the page customers land on: the Zeva mark inside a glowing canvas
card (the pointer drives the glow, tapping fires a burst and sends the browser to
`/apk`), plus a plain button and link for anyone without canvas. It reads
`version.json` for the build label. Keep it customer-only — it is not a shop
window for the web app.

The page's button and the home-page footer link point at `/apk`, the short
install link customers open on their phone: the Worker serves
`deploy/dist/zeva.apk` as `application/vnd.android.package-archive` with
`attachment; filename="Zeva.apk"` and `no-store`, so a phone never keeps an old
download. That file is gitignored — `node scripts/stage-apk.mjs` copies the built
`apk/Zeva-Mandi-and-Grills.apk` there and refuses when the APK predates the
current `apk/version.json`, which is the usual way a stale build gets published.
Rebuild after every version bump, stage, then deploy. The home-page footer links
to it; a deploy with no APK staged answers 404 with the counter's phone number.

## Menu spreadsheet

`Zeva-Menu.xlsx` is generated from `deploy/dist/menu.html` by
`node .tools/make-menu-xlsx.js`. Regenerate and commit it after any menu or
price change.
