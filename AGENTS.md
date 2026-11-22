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

**Two environments, two databases.** Preview (`site-67005eaa…`) is now staging:
its D1 holds the orders and accounts from before the domain launched.
Production (`site-4c9327bc34754be687ddbfa2271b7f56.freebuff.page`) is the
customer-facing copy, with its own D1 and its own secrets — the same secret name
is a separate value in each environment, so anything added to one has to be
added to the other by hand.

**The custom domain is `www.zevamandiandgrills.in`.** The platform accepts a
subdomain for Production, never an apex, so the bare `zevamandiandgrills.in`
has to be forwarded at the registrar (Hostinger) rather than attached here.
Whichever hostname Production gets must also be in the Production secret
`SITE_ORIGINS` (comma separated, e.g.
`https://www.zevamandiandgrills.in,https://zevamandiandgrills.in`), because
`canonicalOrigin()` refuses writes from an origin it does not recognise — the
symptom is every order POST answering 403 on the new domain.
Once the domain is the address customers use, the canonical/OG tags, the
manifest `start_url` and the APK's `server.url` all move with it.

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
- Anyone can add a profile photo from the You tab: the app crops it square at
  320 px in the browser, encodes a JPEG and posts it to `/api/profile` as a
  `data:` URL, which lands in `users.picture` (the same column Google uses). No
  image bucket is involved, and the server refuses anything that is not a
  jpeg/png/webp data URL or is over ~200 kB. `picture` is only written when the
  request carries it, so saving the name and address never clears the photo.
  It shows on the foil profile card, the achievement cards and the avatar.
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

## Online UPI payments

Online UPI has two modes and the same order fields serve both. **Direct mode wins
whenever `UPI_ID` is set** — the customer pays the shop's own VPA or nothing at
all — and the gateway is only reached on a site that has no `UPI_ID`.

**Direct mode needs no hosting at all.** Set `UPI_ID` (the restaurant's VPA,
`Vyapar.175694251103@hdfcbank` — HDFC, changed 15 Nov 2026 — and the only address this code will ever ask a customer to
pay — there is no built-in fallback) and optionally `UPI_PAYEE_NAME` — the app then offers the
order's exact amount as a `upi://` intent to that ID, and the counter confirms
the money on the dashboard with **Mark UPI paid** (it asks first, and an undo
sits beside it for mistakes). This path sends nothing to any provider: the
bank's own app and SMS are the source of truth, so there is no per-transaction
fee and nothing new to host. It is what runs today, and a malformed value (a
paste with a stray space or newline) switches online UPI off rather than
producing a link to the wrong address.

**On the website** (`deploy/dist/menu.html`) choosing UPI pays first and sends
second. Tapping **Pay … by UPI** writes the order row, asks `POST /api/upi/pay`
for the shop's own request for that exact amount, and the drawer waits on
`GET /api/upi/status` — every four seconds, plus an immediate check on
`visibilitychange`, because Chrome throttles timers in the backgrounded tab
while the customer is inside their UPI app. The order only goes to WhatsApp when
they tap send, and that message says `UPI — PAID ₹X` (the counter confirmed it)
or `UPI — NOT PAID YET ₹X`; the printed bill says `UPI PAID` for the same
reason. Sending early is allowed, and simply lands as unpaid.

**In the app** (`deploy/dist/app.html`) there is no WhatsApp step: the checkout
button is **Confirm & pay ₹X by UPI** (or **Confirm order · ₹X** for cash), and
it posts `POST /api/orders` and `POST /api/print` and shows the order screen, so
the customer confirms and pays without leaving the app. On the order screen the
footer carries the `upi://` intent for the server's amount, and
`GET /api/upi/status` turns it into "UPI payment received" once the counter
confirms. WhatsApp is only a fallback: if the order post fails, the screen says
so, keeps the cart, and offers the counter's chat with the same order text.

The website's order body carries the real totals and `payment`, which matters
more than it looks: without them every website order was stored as cash with a
₹0 total, so there was nothing for the payment amount to come from. Each payment
attempt takes a fresh order id too — reusing a ref across carts made the second
order hit `duplicate order` and look like a failed payment.

**Gateway mode** is the self-hosted [UPI gateway](https://github.com/mynkdev-21/upi-gateway)
(Laravel 12 + MySQL, MIT), which cannot run on this Worker or on Sites, so it
lives on its own PHP hosting and Zeva is a merchant of it; `deploy/worker/upi.js`
is the client half. It only runs on a site with no `UPI_ID`; with one set the
gateway secrets are inert. Until either mode is configured, `/api/config`
reports `upi:false` and the app says nothing about paying online:

- `UPI_GATEWAY_URL` — e.g. `https://pay.zeva.example`
- `UPI_GATEWAY_KEY` / `UPI_GATEWAY_SECRET` — the merchant key and secret from
  the gateway dashboard; `test_key_…` / `test_sec_…` rehearse in its Sandbox
- `UPI_WEBHOOK_SECRET` — the webhook signing secret for that environment, with
  the dashboard's webhook URL set to `https://<site>/api/upi/webhook`

Flow: the order is placed exactly as before (`POST /api/orders`, WhatsApp
message, counter print); then `POST /api/upi/pay {id}` asks the gateway for a
payment and returns its hosted page plus the `upi://` intent. The amount comes
from the orders row, never from the browser, and a live link is reused until it
expires (a retry is `…-r2`, `…-r3`). `GET /api/upi/status?id=` is what the app
polls — at most one gateway read every four seconds — and is one of the two
ways a payment can be confirmed.

In gateway mode a payment is marked paid only by a verified webhook or by that
status read; in direct mode only the dashboard can mark one paid.
`orders.upi_status` runs `pending → paid | expired | review | mismatch`, with
`upi_utr`, `upi_amount` and `upi_paid_at` beside it. The webhook is
server-to-server, so it sits outside the same-origin rule and trusts only
`X-Signature: t=…,v1=…` (HMAC-SHA256 of `t.body`, five-minute window, deduped
by `event_id` in `upi_events`). A paid event always wins over an expiry; an
amount that does not equal the order total becomes `mismatch` with a notice to
the customer instead of a paid order. The dashboard shows the UPI state on each
order card, and the app's order list says "UPI paid".

Hosting the gateway needs PHP 8.2+, MySQL, `QUEUE_CONNECTION=database` and the
two cron entries from its `docs/CPANEL.md` (or `docs/VPS.md`) — scheduler plus
queue worker. Without those crons no webhook ever leaves the gateway, and the
app falls back to the status poll.

Local testing uses the gitignored stub: `node .tools/upi-stub.mjs` on 4198, and
`deploy/server.js` started with the four variables pointing at it
(`UPI_GATEWAY_URL=http://127.0.0.1:4198`, `key_test_zeva` / `sec_test_zeva`,
`UPI_WEBHOOK_SECRET=whsec_test_zeva`). Its `/_pay/<ref>`, `/_expire/<ref>`,
`/_review/<ref>` and `/_replay` routes fire the gateway's side by hand.

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
window for the web app. Every page's **App** nav item points here; the ordering
app itself stays at `/app` (this page links to it as "Open Zeva").

The page's button and the home-page footer link point at `/apk`, the short
install link customers open on their phone: the Worker serves
`deploy/dist/zeva.apk` as `application/vnd.android.package-archive` with
`attachment; filename="Zeva.apk"` and `no-store`, so a phone never keeps an old
download. That file is gitignored — `node scripts/stage-apk.mjs` copies the built
`apk/Zeva-Mandi-and-Grills.apk` there and refuses when the APK predates the
current `apk/version.json`, which is the usual way a stale build gets published.
Rebuild after every version bump, stage, then deploy. A deploy with no APK
staged answers 404 and names the counter's phone number.

## Short link

`zevamandi.foo.ng` is a printable address for the restaurant, and it is **not**
a custom domain on this site: the platform answers `403 Forbidden` to any Host
header that is not its own, so a CNAME straight at the site can never render.
Instead the name has one CNAME at the free `foo.ng` registry
(`Pokymon/foo.ng`, PR #382) pointing at `afraznainar.github.io`, where the
public repo `afraznainar/zeva-link` is a one-page redirect that forwards to the
live site with the path and query intact (`CNAME` file in that repo carries the
custom domain, and Pages issues the certificate once DNS lands). If the site
ever gets a real custom domain instead, the Worker's origin check
(`SITE` in `accounts.js` / `index.js`) has to learn the new origin or every
order POST answers 403.

## Keeping it fast

The pages carry their own inline CSS and load `assets/site.css` once; the brand
texture on every page is a CSS gradient lattice, not `zeva-pattern.webp` (that
113 kB photo was drawn at 8 % opacity and dominated the home page's weight).
Google Fonts is loaded with `media="print"` + `onload`, so first paint never
waits on Google or the woff2 files, with a `<noscript>` fallback.

`worker/index.js` rewrites the cache policy for `/assets/`: images and the logo
carry a week, CSS/JS an hour. Without it the platform's `must-revalidate` made
every repeat visit pay a round trip per photo while downloading nothing.
`deploy/server.js` applies the same rule so local testing matches the live site.

## Home page Instagram strip

`deploy/dist/index.html` builds the strip in script: 24 photo cards (six pictures
— `insta-11, 12, 2, 4, 6, 3` — repeated four times) drift past a brass scanner
bar at the strip's centre, which clips each photo into generated cypher text as
it crosses. One `--edge` percentage on the card drives both clip paths (photo
shows left of the bar, code right of it), the line wraps by half its own width
so the loop is seamless, and the code text is rewritten only for the card under
the bar — a card that has crossed the line turns back into a plain photo. Dragging flings the strip; `prefers-reduced-motion` gets still photos
and no loop. Ported from a card-stream scanner demo, minus its Three.js
particle canvas, which this page does not load.

## Menu spreadsheet

`Zeva-Menu.xlsx` is generated from `deploy/dist/menu.html` by
`node .tools/make-menu-xlsx.js`. Regenerate and commit it after any menu or
price change.
