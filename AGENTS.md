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

The live site is Production at **`https://www.zevamandiandgrills.in`**, deployed
from `deploy/sites.manifest.json`. Every page's canonical/OG/JSON-LD tags carry
that origin absolutely; `node .tools/fix-og.js <origin>` rewrites them off
whichever origin they last carried (it knows every address this site has had),
so run it if the domain ever changes. The platform's own Production address
(`https://site-4c9327bc34754be687ddbfa2271b7f56.freebuff.page`) still serves the
same Worker, which is how to tell "the domain" apart from "the deploy".

**The asset uploader refuses hidden files**, and `.well-known` is a hidden
folder: a card committed at `deploy/dist/.well-known/mcp/server-card.json`
(27 Nov 2026) made every deploy fail with *“Assets must contain only public
build output: no hidden files…”*, not just that file's. Anything under
`.well-known` is therefore a Worker route — `MCP_CARD` in `worker/index.js`
serves `/.well-known/mcp/server-card.json`.

**Two environments, two databases.** Preview (`site-67005eaa…`) is now staging:
its D1 holds the orders and accounts from before the domain launched.
Production (`site-4c9327bc34754be687ddbfa2271b7f56.freebuff.page`) is the
customer-facing copy, with its own D1 and its own secrets — the same secret name
is a separate value in each environment, so anything added to one has to be
added to the other by hand.

**The custom domain is `www.zevamandiandgrills.in`, attached to Production and
live** (22 Nov 2026: CNAME `www` → the `customers.freebuff.page` target plus the
`_freebuff.www` TXT record, TTL 300). The platform accepts a subdomain for
Production, never an apex, and Hostinger refuses to forward a domain to its own
`www` (`[Domains:2047] Domain and redirect url cannot be the same`), so the bare
`zevamandiandgrills.in` is a GitHub Pages redirect instead: repo
`afraznainar/zeva-apex` (its `CNAME` is the apex, and the zone's `@` A/AAAA
records point at GitHub's Pages addresses) hands the visit to the `www` site with
the path and query intact. Never point `@` back at Hostinger's CDN
(`*.cdn.hstgr.net`): that is what answered 403 for the bare domain before it
launched.

**When the domain answers "This address does not serve the site", the zone has
drifted — the deploy is fine.** On 27 Nov 2026 both `www` and `@` pointed at
`217.21.85.253`, Hostinger's own vhost, so `www` served that plan's inert
placeholder (565 bytes, `platform: hostinger`) while Production, D1 and every
page were healthy the whole time. The same thing happened a second time that
day when a Node.js deploy on that plan was attached to the domain: it rewrote
`www` into `CNAME www -> zevamandiandgrills.in` (an alias of the apex), which put
the whole site — `/api/*` included — on that plan's Node app. `deploy/server.js`
is the *local* server (SQLite shim, `whatsapp:false`, `upi:false`, `dev:true`), so
sign-in and sign-up answered `503 whatsapp sign-in is not configured` and the
accounts/orders were an empty file instead of D1. `/api/config` is how to tell
where the domain points without guessing: `whatsapp:true`, `upi:true`,
`dev:false` is the Worker; `whatsapp:false`, `dev:true`, `Server: LiteSpeed` is
the Node app. Pointing `www` back at the `customers.freebuff.page` CNAME
restored it in one command and loses nothing, because the database never left
D1 — a Node deployment on that plan is a static copy with no secrets and no
data, not a replacement host. Tell the two apart before touching anything:
`https://site-4c9327bc34754be687ddbfa2271b7f56.freebuff.page` 307s to the domain,
and a 307 there means the Worker is alive and only DNS is wrong. The repair is
the two records the platform's own `domain_primary` receipt names —
`node scripts/hostinger-dns.mjs delete A www` then `cname www <cnameTarget>`, the
target being the receipt's `cnameTarget`
(`cc7ff30827dadf9175673080690ac80e1afdb7171afe2cc3.customers.freebuff.page`,
never guessed; the matching `_freebuff.www` TXT stays as it is) — plus the four
GitHub A/AAAA records for `@`. TTL is 300, so a resolver that cached the bad
record keeps answering for five minutes; `ipconfig /flushdns` clears the
machine but not the router, and `curl --resolve
www.zevamandiandgrills.in:443:104.21.85.171` shows the platform's answer
immediately.

`zeva-apex` must stay **public**: GitHub Pages is not available for a private
repo on the free plan, and when the repo went private the Pages site vanished
while the zone still pointed at GitHub, so the apex answered `404 Site not
found` under a `*.github.io` certificate until the repo was made public again
(24 Nov 2026). Re-creating the site is one call —
`gh api -X POST repos/afraznainar/zeva-apex/pages -f source[branch]=main -f
'source[path]=/'` — and the build picks its `CNAME` up on its own. `index.html`
and `404.html` carry the same hand-over script, so even a deep path like `/menu`
(which GitHub answers with a 404 status) still lands on the www page, and
`https_enforced` can only be turned on once GitHub finishes issuing the
certificate (`https_certificate.state` `dns_changed` → `approved`); until then
plain HTTP is served rather than redirected.

A real 301 is possible instead, because the domain's hosting plan also carries a
vhost for the apex (`/home/u199112185/domains/zevamandiandgrills.in/public_html`,
server 217.21.85.253). `.tools/apex-redirect.mjs on` uploads an
`.htaccess` there that 301s every path to `www` with the query intact, and with
`@` pointed at that IP the redirect is instant and certificate-backed — GitHub
Pages can only ever serve a page that redirects itself. Swapping between the two
is just the `@` A/AAAA records: GitHub's four `185.199.10x.153` /
`2606:50c0:800x::153`, or the one hosting IP.

The vhost carries that same 301 while GitHub Pages serves the apex, as a
backstop for resolvers that still cache the old address: GitHub's page hands
over in JavaScript only, so a visit that landed on `217.21.85.253` from a stale
record used to see the stood-down placeholder ("This address does not serve the
site", 27 Nov 2026) instead of the site. `node .tools/apex-redirect.mjs on`
leaves `.htaccess` plus a redirecting `index.html` there, so both routes end on
`www` with path and query intact. Hostinger's file API only uploads, lists and
reads — a file put there can be overwritten but never deleted, so `off` now only
reverts `index.html` and prints a reminder to remove `.htaccess` in hPanel.

Whichever hostname Production gets must also be in the Production secret
`SITE_ORIGINS` (comma separated, e.g.
`https://www.zevamandiandgrills.in,https://zevamandiandgrills.in`), because
`canonicalOrigin()` refuses writes from an origin it does not recognise — the
symptom is every order POST answering 403 on the new domain. `SITE` in
`worker/accounts.js` and `worker/index.js` is now the domain, which is the
fallback origin for anything that has to name one.

The zone itself is at Hostinger. `scripts/hostinger-dns.mjs list` prints it;
`cname`/`txt`/`record <TYPE> <name> <value>` write a record, `delete <TYPE>
<name>` removes one and `forward <url>` sets the registrar's own redirect. All of
it goes through Hostinger's public API, so the DNS step needs no hPanel clicks
once an account API token sits in the gitignored `deploy/hostinger.secret` — the
script reads that file and never prints it. A PUT appends to a record set rather
than replacing it, so an existing record of the same type has to be deleted first
(Hostinger answers 4005 for a second CNAME). SSH
into the hosting plan is a different thing entirely: it reaches files, not the
zone, and that plan cannot run this site (it is a Worker plus D1).

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
- **Every public page asks for the account on its own.**
  `deploy/dist/assets/signup-popup.js` is loaded by the ten content pages (home,
  menu, about, visit, faq, history, `best-mandi-mangalore`,
  `unlimited-mandi-mangalore`, review-us, download) and opens a sign-up sheet
  about 2.5 s after the page arrives — sign in, or a new number becomes an
  account with the same WhatsApp code. It asks `/api/me` first so a signed-in
  customer never sees it, and it stays shut when sign-in is switched off
  (`whatsapp:false`), when the visitor chose **Not now** on that tab
  (`sessionStorage.zeva.signup.skipped`) or while the chat panel or the cart
  drawer is open. `/app`, `/profile`, `/member`, `/join`, `/reserve` and
  `/admin` do not load it: each already leads with its own sign-in form.
  Signing up and signing in are one flow on the server — a verified number
  matches the account that already holds it — but the sheet, `/profile`'s popup
  and `/join` also carry a plain **Already signed up? Sign in with just my
  number** button for a returning customer: it hides the name field, sends the
  same code and verifies with no name, so Gold members are never asked to fill
  in a sign-up they do not need.
- **WhatsApp is the only sign-in the site offers.** The Google button used to
  sit beside it in the You tab, the checkout prompt and the `/profile` sign-up
  sheet; all three are gone (26 Nov 2026) so no page draws a Google choice and
  no copy tells a customer they have a Google account here. The Worker still
  carries the OAuth routes below, but nothing links to them and
  `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` are not set in Production, so
  `/api/config` reports `google:false`. Authorised
  redirect URIs, if the routes are ever switched back on, must match Google's
  list character for character:
  `https://www.zevamandiandgrills.in/api/auth/google/callback`,
  `http://localhost:4173/api/auth/google/callback` and
  `http://127.0.0.1:4173/api/auth/google/callback`. Locally the two credentials
  can live in `deploy/.env` (gitignored) instead of the shell env. Re-adding a
  button means re-adding its markup as well as the secrets.
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
- **Accepting prints two copies, and nothing else prints** (28 Nov 2026). The
  Accept button is `POST /api/admin/order {id, status:'preparing'}`, so
  `adminSetStatus` sends the order through the counter's print bridge twice: a
  kitchen ticket (`kind:'kitchen'` — quantities and the customer's note, no
  prices, rendered by `renderTicket` in `print-core.js`) and the customer's
  bill. The queue names are optional — `PRINT_KITCHEN_PRINTER` and
  `PRINT_BILL_PRINTER` override them in Sites, and with neither set the bridge
  uses its own `PRINT_KITCHEN_PRINTER` (default `KITCHEN`) and `PRINT_PRINTER`
  (default `BILL`), because the kind already routes the job. Both go to
  `PRINT_BRIDGE_URL`
  (`printer-bridge.js`), because the site runs in a data centre and the printers
  sit in the restaurant; the bridge picks the Windows queue from the job's
  `printer`. Only the first acceptance prints (`before !== 'preparing'`), so
  reopening and re-accepting never leaves a third copy, and **Print again** on an
  accepted card repeats both through `POST /api/admin/print {id}`. The answer
  carries `print: {kitchen, bill}` and the dashboard alerts on whichever copy
  failed, naming the queue — a missing kitchen queue is the usual first symptom,
  fixed with the printer's real Windows name in `PRINT_KITCHEN_PRINTER` (or
  `=BILL` on a single-printer counter).
  **The pages no longer print at checkout:** `menu.html` and `app.html` used to
  POST `/api/print` the moment the customer ordered, which would now print a
  second bill for an order the counter might still decline. `/api/print` still
  exists for a manual job, but the site does not call it.
- Zeva Money is the cashback wallet (`wallet` table). Cashback is credited in
  `adminSetStatus` when an order becomes `done`, never at order time, and a
  cancellation writes the matching negative row. Only once per order.
  **A signed-in customer may choose to spend it on the order** (28 Nov 2026),
  and only when they do: the checkout shows a **Redeem Zeva Money · ₹X
  available** button, and sends `use_wallet: true` only while the customer has
  switched it on. `createOrder` ignores the flag unless it is true, and then
  takes off as much of the bill as the wallet actually covers — never more, so
  a ₹0 order is possible but never a negative one — stores it in
  `orders.wallet_redeemed`, writes one `kind = 'redeem'` row and saves the net
  amount in `orders.total`. The browser only displays that sum (`walletUse()`
  in `menu.html` and `app.html`, from `/api/me`'s `wallet.balance`); a browser
  that sends a different total changes nothing, and no button means no debit.
  The printed bill carries a **Zeva Money used −₹X** line, the dashboard card
  shows it beside the delivery line, and the WhatsApp order text says it too.
  Cancelling an order writes one `kind = 'refund'` row for exactly what was
  spent, so a double cancel refunds nothing twice.
  **Two orders cannot spend the same rupees.** The spend is not computed from a
  balance read in JavaScript; it is one `INSERT ... SELECT` that reads the live
  `SUM(wallet.amount)` and writes the debit in the same statement, inside a
  `DB.batch` with the order insert and the total update. Whichever concurrent
  order gets there second sees the first one's row and stops at zero, so the
  wallet can never go negative. The order row is cut down from the amount the
  database actually debited, never from the earlier browser/JS figure.
  **The counter can pay in by hand**: `POST /api/admin/wallet {phone | user_id,
  amount, note}` (the **Zeva Money** box on `/admin`) writes one `kind =
  'credit'` row, optionally negative to take a wrong credit back, capped at
  `WALLET_ENTRY_MAX` = ₹5,000 per entry so a stray keystroke cannot hand out
  thousands, and answers the member's new balance. The app notice is written
  too, because a wallet entry the customer never hears about reads like a
  mistake — it is in-app only and spends no WhatsApp message.
  A visit stamp is money too: `recordVisit` writes a `kind = 'stamp'` wallet row
  of `MEMBERS.stampCashback` (₹10) after the visit row lands, so the same
  unique `visits.booking_id` that stops a double tap also stops a double ₹10,
  and a walk-in stamp or a typed member code pays it the same way. The amount
  raised from ₹5 an order to ₹10, and stamps from nothing to ₹10, on
  28 Nov 2026; both numbers are constants (`GOLD.cashback`,
  `MEMBERS.stampCashback`), never literals in a page.
  **The copy promises "up to ₹50 cashback", the wallet still pays ₹10.** That
  is the owner's call (28 Nov 2026): the wording changed and nothing else did.
  The ceiling is `GOLD.maxCashback` (50) for display only — `/member`, `/join`,
  `/profile`'s sign-up sheet and `llms.txt` carry the words, `app.html` builds
  them from `rupee(GOLD.maxCashback)` — while `GOLD.cashback` (10) is what
  `adminSetStatus` actually credits. The lines that name one order's money (the
  cart's *Zeva Gold cashback +₹10 to Zeva Money on delivery*, the
  `cashback_due` note after checkout, the Zeva Money ledger) keep the real
  number on purpose: only the standing promise says "up to". Raising the payout
  later means changing `GOLD.cashback`, not the copy.
  **One stamp a day per member** (`MEMBERS.stampsPerDay`), checked in
  `stampToday` at the top of `recordVisit` against midnight in India
  (`istEpoch(istDay(now), "00:00")`), so every path that gives a stamp — the
  member row's **+ stamp**, the walk-in box, a typed member code and **Mark
  visit** on a booking — pays the ₹10 at most once a day. A second attempt
  changes nothing and answers `409 {reason: "already_today", stamped_at,
  error}` whose `error` names the time of the first stamp; the typed member code
  is **not** burned in that case (it stays usable tomorrow, and is handed back
  even if a stamp lands mid-request), and **Mark visit** still marks the table
  arrived while its reply carries `stamp: {added: false, error}` for the
  dashboard to show. `GET /api/admin/members` also returns `stamped_today` per
  member, so the list shows **stamped today** on a disabled button instead of
  letting staff find out by being refused. A genuinely second visit in one day
  is therefore not stamped — that is the choice, because an accidental double
  tap handing out ₹10 was the real risk.
- Order updates: every status change inserts a row in `notices` for that
  customer, and the dashboard can send free-text messages (`/api/admin/notify`,
  all customers or one order's customer). The app polls `/api/notices?after=`
  and raises a system notification — the Capacitor LocalNotifications plugin in
  the APK, the Notification API in a browser. Delivery therefore needs the app
  open or the tab alive; true background push would need FCM.
- Zeva Gold: `GOLD = { price: 249, months: 12, cashback: 10, freeMetres: 6000 }`
  at the top of `accounts.js` (`app.html` mirrors it with `maxCashback: 50` for
  the "up to ₹50" words). Free delivery inside 6 km and the cashback are
  applied **server-side** in `createOrder`, never trusted from the browser.
  Ordinary delivery is free inside 2 km (`FREE_DELIVERY_M` in `menu.html` and
  `app.html`), then ₹55 for 2–3 km and ₹70 for 3–3.5 km; Gold widens the free
  zone to 6 km (the app raises Gold's radius check to `GOLD_FREE_M`). Joining is a request (`gold.status = 'pending'`) that staff activate
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
it posts `POST /api/orders` and shows the order screen, so the customer confirms
and pays without leaving the app (the printing happens at Accept on `/admin`). On the order screen the
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
message; the two counter copies print at Accept); then `POST /api/upi/pay {id}`
asks the gateway for a
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

## Table reservations

`deploy/dist/reserve.html` is `/reserve` — the booking page. The guest signs in
with **WhatsApp** (the existing one-time-code flow: `POST
/api/auth/whatsapp/start` then `/verify`), chooses a date, an arrival time,
adults and children, and gets a booking code on screen and on WhatsApp.

- Bookings live in the `reservations` table against the `DB` binding. Covers are
  counted per 30-minute slot, not per table: a party of nine takes nine of that
  slot's seats. `RESERVE` at the top of `worker/accounts.js` holds the numbers —
  `seats` (60 per slot), `holdMinutes` (10), `firstHour` 12 / `lastHour` 22 (last
  seating 10 PM), `stepMinutes` 30, `maxDays` 60, `maxUpcoming` 3 per guest,
  `maxAdults` 50 (one party can be up to fifty adults), `maxChildren` 12 and
  `advance` 500. The page reads them from `/api/config`, so the two never drift.
- **₹500 advance.** A booking is written with `advance_status = 'due'` and
  `advance_amount = 500`. `POST /api/reservations/pay {id}` returns the shop's own
  `upi://` intent (`am=500.00`, note “Zeva table CODE”) for the guest who owns the
  booking — same direct-mode VPA as the order flow, built in `advanceIntent`.
  `POST /api/reservations/paid {id}` is the guest saying they paid and only moves
  the row to `claimed`; the money is `paid` only when the counter confirms it on
  `/admin` (`POST /api/admin/reservation {id, advance:'paid'|'due'}`). The advance
  is adjusted in the bill, and a cancelled booking is refunded at the counter.
- The page is deliberately not the site's usual card grid: a lacquer-dark room
  with one brass lamp, the reservation as a cream perforated slip, and the hold as
  a brass ring that empties as the ten minutes run out. Motion is one entrance
  for the headline, the slot fill sweep and the ring — all of it off under
  `prefers-reduced-motion`.
- **The 10-minute hold is data, not a job.** Each row stores `arrive_at` and
  `hold_until` (arrival + 10 min) as epoch milliseconds, so an abandoned booking
  needs no cron to expire: the page's countdown and the staff list compare those
  times with the clock, and once `hold_until` passes the seats are bookable
  again. The page says so three times (marquee, the “how it works” card, and the
  live timer) and asks the guest to be at Zeva at the booked time. `arrive_at`
  is built from India time (`istEpoch`, no DST), so a guest in another timezone
  still sees the right slot; `/api/reservations/slots` returns `today`/`latest`
  too, so the date picker never guesses.
- **Notifications are automatic.** On a successful booking the Worker sends
  three WhatsApp messages through the provider already configured for OTP —
  `POST {WHATSAPP_OTP_API}/v1/messages/send` with `WHATSAPP_OTP_KEY`. The guest
  gets two, in this order: the booking details (code, date, time, party, the
  10-minute rule, menu link, cancel link), then a separate advance message with
  the shop's UPI ID, the ₹500, the note to write and the pay link — kept apart on
  purpose so the address is easy to copy out of the chat. The counter gets the
  table (`BOOKING_NOTIFY_PHONE`, default the restaurant's own number; set it to
  `off` to silence the staff copy). A failed message never fails the booking —
  the code is already on the guest's screen; the response says `notified: true`
  only when the guest's message went out. The booking also lands in `notices`,
  so the customer's app confirms it. `/admin` rings (chime + desktop
  notification) when a new booking appears in its 8-second poll.
- Routes: `GET /api/reservations/slots?day=`, `POST /api/reservations`
  (signed-in only; validates date, slot, party size, phone, capacity and the
  three-upcoming limit), `GET /api/reservations` (own bookings), `POST
  /api/reservations/cancel` (own booking), `POST /api/reservations/pay` and
  `POST /api/reservations/paid` (the advance), plus the staff pair
  `GET /api/admin/reservations` (today and tomorrow) and `POST
  /api/admin/reservation` (cancel a booking, or confirm/undo its advance).
  `/admin` shows **Bookings · today & tomorrow** above the message composer, with
  the advance state on each card.
- Google sign-in is not involved on this page: it is still switched off in
  Production (`/api/config` reports `google:false`) and WhatsApp is the number
  the customer is already on. If the booking needs an account, it needs a
  signed-in one — not specifically Google.
- Discovery is footer-only (no nav change): a **Reserve a table** item in the
  Explore list of every page that shares that footer, a *Book a table* button in
  the home hero, a *Reserve a table* button on `/visit`, and `/reserve` in
  `sitemap.xml` + `llms.txt`. The home page's Restaurant JSON-LD carries
  `potentialAction`: a `ReserveAction` to `/reserve` and an `OrderAction` naming
  both pickup and own-fleet delivery, which is what Google reads to offer
  booking or ordering.

## Membership card, visits and the wheel

`deploy/dist/member.html` is `/member` — the Zeva Gold card. Same lacquer room
and brass lamp as `/reserve`, because the card is the object: a brass plate with
ten stamps pressed into it, and the prize wheel beside it.

- Sign-in is WhatsApp only, through the same one-time-code flow as the rest of
  the site (`POST /api/auth/whatsapp/start` then `/verify`), and there is no
  Google button anywhere on this page. `/member` and `/join` also ask for a
  **name**, which `whatsappVerify` takes as an optional `name` and stores on an
  empty profile — so a new member reaches the counter's list with a name, not
  just a number. An account that already has a name keeps it, and the other
  sign-in pages (`/app`, `/profile`, `/reserve`) send no name at all.
- **A visit is a sit-down visit the counter records.** The staff card on `/admin`
  has **Mark visit** while a booking is live; it sets `reservations.arrived_at`
  and inserts one row into `visits`. `visits.booking_id` is uniquely indexed, so
  a double tap is a no-op, and only someone who signed in with WhatsApp when
  they booked has a user id to credit.
- **Spins are derived, never stored as a balance.** `earned = floor(visits /
  MEMBERS.visitsPerSpin)` and `spins_left = earned − spins taken`, so nothing has
  to run on a schedule and deleting a bad visit gives the arithmetic back.
  `MEMBERS` at the top of `worker/accounts.js` holds `visitsPerSpin` (10) and the
  prize table with weights.
- **The prize is picked on the server**, weighted (ras malai and “any fresh
  juice” once each, the named juices twice), and returned with a short claim code
  (`Z` + four characters). The wheel in the page rotates to that segment — the
  animation is the server's answer, not a local random. `spins.used_at` is set
  when the counter hands the prize over, on `/admin` or with `POST
  /api/admin/spin {code}`; the guest's open prizes stay listed on the card until
  then. Two phones spinning at once cannot spend the same tenth visit: the row
  is deleted if the count comes back over `earned`.
- **Gold is the same account.** `/member` shows the plan and, when signed in,
  the **Ask for Gold · ₹499** button, which is the existing `POST /api/gold/join`
  request the counter approves — no second signup path. The perks are free
  delivery inside 6 km, up to ₹50 cashback into Zeva Money per delivered order
  (₹10 in the wallet, as above), and a year for ₹249.
- **Every signed-up member is data the shop owns.** `GET /api/admin/members`
  lists the last 500 with name, WhatsApp number, visits, spins, open prizes,
  Gold state and joined date, plus counts (total, on WhatsApp, Gold, visits).
  Each member has a **four-digit member code** (`MEMBERS.memberCodeDigits`),
  minted once per account in `assignMemberCode` and shown in that list; the
  counter types it into the **Member code** box, which stamps one visit
  (`POST /api/admin/consume-code`) and burns that code. Codes minted before
  26 Nov 2026 were `Z` + five letters/digits — they are stored as they were and
  still match, so members who signed up earlier keep working.
  A walk-in who never booked online can still be stamped: `/admin` has an
  **Add a stamp** box that looks the member up by WhatsApp number
  (`POST /api/admin/visit {phone}` or `{user_id}`), records one walk-in visit
  and shows the new count, and each member row has a **+ stamp** button for the
  same thing. `visits.booking_id` is null for these, so the unique index does
  not block them and repeated taps each add a stamp. `POST /api/admin/marketing {message, audience, limit}` sends the message on
  WhatsApp to `all` / `gold` / `visited`, then writes the same words into each
  member's `notices` for the app. It batches five at a time, appends “reply STOP
  to stop these messages”, and is capped at `MARKETING_MAX` = 30 per send because
  the provider's free plan is 100 messages a month and a booking already spends
  two. The response reports sent, failed, how many were left for the next
  send, and — when anything failed — the provider's own reason in `reason`
  (`quota_exceeded`, `no_device_connected`, `unauthorized`, …), which the
  composer prints after the count. Two things make "sent" honest: the shop's
  own WhatsApp number is **skipped** (`self_skipped`, `self_numbers`) because a
  phone cannot deliver a message to itself — LoginWA still answers 200 and the
  message waits as `queued` for ever, which looked exactly like a send that
  arrived — and the accepted ids are polled through
  `GET /v1/messages/{message_id}` (up to `MARKETING_CHECK_MAX` = 12 of them,
  three rounds six seconds apart) so the reply also carries `checked`,
  `delivered` and `queued`. "Sent" is the provider taking the message;
  "delivered" is a phone having it.
  The same composer sends **pictures and links**. A link is just text: WhatsApp
  makes a URL tappable by itself, so `message` is sent untouched and the 600
  character cap leaves room for the link plus a sentence. A picture is the
  **Picture (optional)** box: the browser shrinks the photo to 1280 px JPEG
  (`createImageBitmap` + canvas, so a 5 MB phone photo becomes ~150 kB), posts
  it as a data URL to `POST /api/admin/media`, and the Worker stores the base64
  in the `media` table and answers `{id, url}`. The send then goes out as
  `type: "image"` with `media_url` — LoginWA fetches media **by public HTTPS
  URL**, which is why `GET /api/media/<id>` is deliberately unauthenticated
  (the provider has no cookie) and why the id is a 32-hex random UUID: the link
  is the only thing guarding the picture. The message becomes the image's
  `caption` (so words are optional when a picture is attached, and the shield
  line still rides along), and the app notice carries the picture's URL because
  a notice is text. Uploads are capped at 700 kB decoded to stay inside D1's
  1 MB row limit, only JPEG/PNG/WebP are accepted, and each upload deletes
  rows older than `MEDIA_KEEP_DAYS` = 60 so a year of promos cannot fill the
  database. A new table needs a line in `schemaReady`'s probe list too —
  `media` is probed there, otherwise an existing database reports itself up to
  date and the table is never created. `GET /api/admin/whatsapp` answers the
  question behind most failures: `WHATSAPP_OTP_API`/default host the key points
  at, and every device that key has with its online state and masked number;
  the **Check sender** button beside **Send on WhatsApp** shows that in the
  composer. A key can send sign-in codes through the provider's pool while
  having no linked device of its own, and only this tells that apart from a
  quota problem.
- Discovery is footer-only, like `/reserve`: a **Zeva Gold card** item in the
  Explore list of every page that shares that footer, a *Membership card & spins*
  link on the gold card in `/app`, and `/member` in `sitemap.xml` + `llms.txt`.

## Staff dashboard

`deploy/dist/admin.html` is `/admin` — passcode gate (`ADMIN_PASSCODE` secret),
order feed polled every 8 seconds with a WebAudio chime, desktop notification
and tab-title counter, the status filter tabs (Pending, Preparing, Out, Finished, Cancelled, All — the
choice is remembered per device), the Accept → Out for delivery → Delivered buttons, the
message composer that reaches customer phones, Zeva Gold approvals, the
**Members** list with its marketing composer, the **Zeva Money** box that
credits one member's wallet by hand, **Mark visit** on live bookings, and
**Handed over** on a prize code.

Sound only plays after someone taps **Enable sound** once on the device (browser
autoplay rules); the choice is remembered per device. Nothing here is in the
public nav — share `/admin` and the passcode with staff only. The passcode is
kept on disk at `deploy/admin-passcode.secret` (gitignored).

## Members page

`deploy/dist/members.html` is **`/members`** — the members list on a page of its
own, behind its own short passcode (**`MEMBERS_PIN` = `988051`** in
`worker/accounts.js`, overridable with `MEMBERS_PASSCODE` in Sites → Secrets).
The dashboard passcode still opens it, but the pin is not the dashboard: the
login route (`/api/admin/login`) answers with `role: "members"` for the pin and
the cookie carries that role, so a pin session may only reach the five routes
the page uses (`/api/admin/members`, `visit`, `wallet`, `notify`, `spin`) and
answers `403` everywhere else. `/api/admin/session` counts the pin as signed in
only when asked with `?page=members`, so `/admin` still wants the real passcode.
A search box filters by name, WhatsApp number (digits only, so spaces
and +91 still match) or member code, and the counts row stays above it. Tapping
a member opens a native `<dialog>` with their card facts (visits, spins, Zeva
Money balance, whether today's stamp is already given) and the three things the
counter does to one person: **Stamp** (`POST /api/admin/visit`, one a day, ₹10),
**Send money** (`POST /api/admin/wallet`, cap and minus-sign rules included) and
**Message** (`POST /api/admin/notify`, WhatsApp + app notice). Prize codes still
on the card carry a **Handed over** button (`POST /api/admin/spin`). `/admin`
keeps the counts, the **Add a stamp** and **Member code** boxes for a walk-in,
and the marketing composer, and links here instead of drawing the list itself —
so the list has one home. `GET /api/admin/members` carries `balance` and
`stamped_today` per member for this page.

## Android APK (Capacitor)

`apk/` wraps the same live `/app` page in a Capacitor WebView (`com.zeva.mandi`);
**Capacitor 6.2.4 is the floor** — GHSA-jjx3-p5hf-mvvc (25 Nov 2026) let
untrusted WebView content reach the bridge's internal `/_capacitor_file_`,
`/_capacitor_content_` and `/_capacitor_http_interceptor_` routes and a path
traversal in the app's own file serving, all at the app origin. `@capacitor/android`
and `@capacitor/core` are pinned at `^6.2.4` for it, and the Java that carries the
fix ships inside the Android project `cap add` generates, so an APK built from an
older `node_modules` stays vulnerable — rebuild after changing it.
`.github/workflows/android-apk.yml` builds `app-debug.apk` on GitHub Actions
because there is no Android SDK here — Actions → **Android APK** → Run workflow,
then download the artifact. See `apk/README.md`.

Sign-in in the app is the same WhatsApp one-time code as the website: the You
tab asks for the number and then the code, and the session cookie is set in the
WebView — no browser hand-off, so the Google/`zeva://auth` detour is no longer
part of the flow. The route still exists for the old exchange path: the Worker
can redirect to `zeva://auth?code=…`, `@capacitor/app` hands that URL to
`app.html`, and the code is swapped for the session cookie via
`POST /api/auth/exchange` (single-use, five minutes). The `zeva://auth` intent
filter cannot live in the manifest,
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
