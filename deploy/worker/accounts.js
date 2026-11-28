/* ============================================================
   Zeva accounts — customers, orders, wallet, Zeva Gold, admin
   ------------------------------------------------------------
   Everything here runs inside the Worker against the D1 binding
   (env.DB). Cookies are HMAC-signed, so no session table is
   needed. Secrets, never in the repo:
     GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET  -> Google sign-in
     WHATSAPP_OTP_KEY                         -> WhatsApp code sign-in
     SESSION_SECRET                           -> cookie signing
     ADMIN_PASSCODE                           -> staff dashboard
     MEMBERS_PASSCODE                         -> members list pin (default 988051)
     UPI_GATEWAY_URL / _KEY / _SECRET         -> online UPI payments (./upi.js)
     UPI_WEBHOOK_SECRET                       -> gateway webhook signatures
   ZEVA_DEV_LOGIN=1 exists only for local development.
   ============================================================ */

import { upiReady, directReady, directPayment, upiId, openPayment, pollPayment, verifyWebhook } from "./upi.js";

// Online UPI works in two modes and they share the same order fields:
//   gateway — the self-hosted gateway creates the payment and confirms it;
//   direct  — the app pays the shop's own UPI ID and the counter confirms.
// The gateway wins when both are configured.
function onlineUpi(env) {
  return directReady(env) || upiReady(env);
}

// Which mode is really in use. This must agree with startUpiPayment, where the
// shop's own UPI_ID is checked first — otherwise the app would draw the gateway
// screen for a payment that actually goes to the VPA.
function upiMode(env) {
  return directReady(env) ? "direct" : upiReady(env) ? "gateway" : "";
}

export const GOLD = {
  price: 249,
  months: 12,
  cashback: 10,
  freeMetres: 6000
};

/* Table reservations. A booking takes covers out of one 30-minute slot, and
   the table is only kept for HOLD_MINUTES after the booked time — after that
   the booking is over and the covers go back to the floor. Change the numbers
   here and the page, the API and the staff list all follow. */
export const RESERVE = {
  seats: 60,          // bookable covers per slot
  holdMinutes: 10,    // table kept this long after the booked time
  firstHour: 12,      // first seating, 12:00 PM
  lastHour: 22,       // last seating, 10:00 PM (kitchen closes at 11 PM)
  stepMinutes: 30,
  maxDays: 60,        // how far ahead a guest can book
  maxUpcoming: 3,     // one guest cannot hold the room
  maxAdults: 50,      // one party: up to 50 adults
  maxChildren: 12,
  advance: 500        // rupees of advance asked for a table
};

/* Membership. A visit is a guest who actually sat down — the counter taps
   Mark visit on their booking. Every MEMBERS.visitsPerSpin visits earns one
   turn of the wheel, and the wheel gives a juice or a ras malai. The counts are
   read from the visits and spins tables every time, so nothing has to run in
   the background and a correction in either table shows up immediately. */
export const MEMBERS = {
  visitsPerSpin: 10,
  // Every stamp the counter gives is Zeva Money too, not just a square on the
  // card: ₹10 a visit, credited in recordVisit.
  stampCashback: 10,
  // One stamp a day, in India time. Every stamp pays out, so an accidental
  // double tap or the same member entered twice must not pay twice.
  stampsPerDay: 1,
  prizes: [
    { key: "rasmalai", name: "Ras Malai", weight: 1 },
    { key: "anyjuice", name: "Any Fresh Juice", weight: 1 },
    { key: "lime", name: "Lime Juice", weight: 2 },
    { key: "mintlime", name: "Mint Lime", weight: 2 },
    { key: "watermelon", name: "Watermelon Juice", weight: 2 },
    { key: "orange", name: "Orange Juice", weight: 2 },
    { key: "pineapple", name: "Pineapple Juice", weight: 2 },
    { key: "musambi", name: "Musambi Juice", weight: 2 }
  ],
  // Four digits, read aloud at the counter. Codes minted before 26 Nov 2026
  // were "Z" + five letters/digits (Z67ZVZ); those rows are untouched and still
  // match, because the counter looks a code up by its exact stored value.
  memberCodeDigits: 4
};


/* Achievement cards. Zeva Gold members collect a physical-style card each
   time their delivered-order count passes a milestone — Silver at 100, Gold
   at 500, Diamond at 1000. Change the numbers here and the app, the progress
   bar and the unlock notification all follow. */
export const CARDS = [
  { key: "silver", name: "Silver", orders: 100 },
  { key: "gold", name: "Gold", orders: 500 },
  { key: "diamond", name: "Diamond", orders: 1000 }
];

// The address customers use. The preview keeps answering on its own platform
// host (that is what makes it staging), but anything that has to name one
// origin names this one.
export const SITE = "https://www.zevamandiandgrills.in";

// Every environment of this site is served by the platform from
// <name>.<this>, so a host under it is this site — never somebody else's page.
const PLATFORM_HOST = "freebuff.page";

const DB_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     id TEXT PRIMARY KEY,
     sub TEXT UNIQUE,
     email TEXT,
     name TEXT,
     picture TEXT,
     phone TEXT,
     address TEXT,
     created_at INTEGER NOT NULL,
     last_seen_at INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS orders (
     id TEXT PRIMARY KEY,
     user_id TEXT,
     name TEXT,
     phone TEXT,
     address TEXT,
     note TEXT,
     mode TEXT,
     payment TEXT,
     items TEXT NOT NULL,
     items_total REAL NOT NULL DEFAULT 0,
     cgst REAL NOT NULL DEFAULT 0,
     sgst REAL NOT NULL DEFAULT 0,
     delivery REAL NOT NULL DEFAULT 0,
     total REAL NOT NULL DEFAULT 0,
     wallet_redeemed REAL NOT NULL DEFAULT 0,
     distance_m INTEGER,
     status TEXT NOT NULL DEFAULT 'pending',
     gold_delivery INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     updated_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS orders_created ON orders (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS orders_user ON orders (user_id, created_at DESC)`,
  // Every signed webhook we accept, keyed by the gateway's event id. Delivery
  // is at-least-once and may repeat, so this is what makes handling it once.
  `CREATE TABLE IF NOT EXISTS upi_events (
     event_id TEXT PRIMARY KEY,
     event TEXT,
     order_id TEXT,
     sequence INTEGER NOT NULL DEFAULT 0,
     amount REAL NOT NULL DEFAULT 0,
     received_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS wallet (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id TEXT NOT NULL,
     amount REAL NOT NULL,
     kind TEXT NOT NULL,
     order_id TEXT,
     note TEXT,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS wallet_user ON wallet (user_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS gold (
     user_id TEXT PRIMARY KEY,
     status TEXT NOT NULL,
     requested_at INTEGER,
     started_at INTEGER,
     expires_at INTEGER,
     note TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS login_codes (
     code TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     expires_at INTEGER NOT NULL,
     used_at INTEGER
   )`,
  // One row per WhatsApp code we asked a provider to send. The provider keeps
  // the digits; this row only ties a session back to a phone number so one
  // person's session can never verify someone else's number.
  `CREATE TABLE IF NOT EXISTS otp_sessions (
     session TEXT PRIMARY KEY,
     phone TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     verified_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS otp_sessions_phone ON otp_sessions (phone, created_at DESC)`,
  // Messages the counter sends down to a customer's phone. user_id NULL = everyone.
  `CREATE TABLE IF NOT EXISTS notices (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id TEXT,
     title TEXT NOT NULL,
     body TEXT,
     order_id TEXT,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS notices_created ON notices (created_at DESC)`,
  // Table reservations. Seats are counted, not tables: a party of nine takes
  // nine of that slot's covers. arrive_at / hold_until are epoch milliseconds
  // so the page's countdown never has to guess at a timezone.
  `CREATE TABLE IF NOT EXISTS reservations (
     id TEXT PRIMARY KEY,
     user_id TEXT,
     name TEXT,
     email TEXT,
     phone TEXT,
     day TEXT NOT NULL,
     time TEXT NOT NULL,
     arrive_at INTEGER NOT NULL,
     hold_until INTEGER NOT NULL,
     adults INTEGER NOT NULL DEFAULT 1,
     children INTEGER NOT NULL DEFAULT 0,
     seats INTEGER NOT NULL DEFAULT 1,
     note TEXT,
     status TEXT NOT NULL DEFAULT 'booked',
     advance_status TEXT NOT NULL DEFAULT 'due',
     advance_amount REAL NOT NULL DEFAULT 0,
     advance_utr TEXT,
     advance_claimed_at INTEGER,
     advance_paid_at INTEGER,
     created_at INTEGER NOT NULL,
     cancelled_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS reservations_slot ON reservations (day, time)`,
  `CREATE INDEX IF NOT EXISTS reservations_user ON reservations (user_id, created_at DESC)`,
  // One row per sit-down visit. booking_id is unique, so tapping Mark visit
  // twice on the same table cannot count twice.
  `CREATE TABLE IF NOT EXISTS visits (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id TEXT NOT NULL,
     booking_id TEXT,
     source TEXT NOT NULL DEFAULT 'dine-in',
     created_at INTEGER NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS visits_booking ON visits (booking_id) WHERE booking_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS visits_user ON visits (user_id, created_at DESC)`,
  // Every turn of the wheel and what it gave. used_at is the counter handing
  // the prize over, so a rarer prize cannot be shown twice.
  `CREATE TABLE IF NOT EXISTS spins (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id TEXT NOT NULL,
     prize TEXT NOT NULL,
     code TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     used_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS spins_user ON spins (user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS spins_code ON spins (code)`,
  // A print-at-counter membership code, one per signed-up member. The member
  // types it at the counter instead of finding their own phone.
  `CREATE TABLE IF NOT EXISTS member_codes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL UNIQUE, code TEXT NOT NULL, used_at INTEGER, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS member_codes_user ON member_codes (user_id)`,
  // Codes are typed on the register: avoid the same confusing pairs as
  // booking codes, and make 'used' rows easy to skip if anyone ever goes back
  // through them.
  `CREATE INDEX IF NOT EXISTS member_codes_code ON member_codes (code) WHERE code IS NOT NULL AND used_at IS NULL`,
  // Pictures the counter sends from /admin. The provider fetches media by URL,
  // so the bytes live here and /api/media/<id> serves them back. base64 in a
  // text column keeps this inside D1's 1 MB row limit without a bucket.
  `CREATE TABLE IF NOT EXISTS media (
     id TEXT PRIMARY KEY,
     mime TEXT NOT NULL,
     bytes INTEGER NOT NULL,
     data TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS media_created ON media (created_at DESC)`,
  // Status rename: an order now waits for the counter ('pending') and leaves
  // the kitchen for 'out' — no more 'new' / 'ready'.
  `UPDATE orders SET status = 'pending' WHERE status = 'new'`,
  `UPDATE orders SET status = 'out' WHERE status = 'ready'`
];

/* The customer's saved address arrived after the first release, so the column
   is added on demand instead of another schema table. */
let userColumnsPromise = null;

async function ensureUserColumns(env) {
  if (!userColumnsPromise) {
    userColumnsPromise = env.DB.prepare("ALTER TABLE users ADD COLUMN address TEXT")
      .run()
      .catch(function () {
        /* already there */
      });
  }
  await userColumnsPromise;
}

/* Payment columns arrived with online UPI, after orders already existed. Each
   ALTER is a no-op once the column is there, so this stays cheap and the older
   rows simply read as "no payment". */
let orderColumnsPromise = null;

const ORDER_PAY_COLUMNS = [
  "ALTER TABLE orders ADD COLUMN upi_ref TEXT",
  "ALTER TABLE orders ADD COLUMN upi_url TEXT",
  "ALTER TABLE orders ADD COLUMN upi_intent TEXT",
  "ALTER TABLE orders ADD COLUMN upi_status TEXT",
  "ALTER TABLE orders ADD COLUMN upi_utr TEXT",
  "ALTER TABLE orders ADD COLUMN upi_amount REAL NOT NULL DEFAULT 0",
  "ALTER TABLE orders ADD COLUMN upi_seq INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE orders ADD COLUMN upi_attempts INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE orders ADD COLUMN upi_checked_at INTEGER",
  "ALTER TABLE orders ADD COLUMN upi_paid_at INTEGER",
  "ALTER TABLE orders ADD COLUMN wallet_redeemed REAL NOT NULL DEFAULT 0"
];

/* The ₹500 advance arrived after the first reservations were already booked,
   so its columns are added on demand too and older rows read as "advance due"
   with no amount. */
let reservationColumnsPromise = null;

const RESERVATION_ADVANCE_COLUMNS = [
  "ALTER TABLE reservations ADD COLUMN advance_status TEXT NOT NULL DEFAULT 'due'",
  "ALTER TABLE reservations ADD COLUMN advance_amount REAL NOT NULL DEFAULT 0",
  "ALTER TABLE reservations ADD COLUMN advance_utr TEXT",
  "ALTER TABLE reservations ADD COLUMN advance_claimed_at INTEGER",
  "ALTER TABLE reservations ADD COLUMN advance_paid_at INTEGER",
  "ALTER TABLE reservations ADD COLUMN arrived_at INTEGER"
];

async function ensureReservationColumns(env) {
  if (!reservationColumnsPromise) {
    reservationColumnsPromise = (async function () {
      for (const sql of RESERVATION_ADVANCE_COLUMNS) {
        await env.DB.prepare(sql)
          .run()
          .catch(function () {
            /* already there */
          });
      }
    })();
  }
  await reservationColumnsPromise;
}

async function ensureOrderColumns(env) {
  if (!orderColumnsPromise) {
    orderColumnsPromise = (async function () {
      for (const sql of ORDER_PAY_COLUMNS) {
        await env.DB.prepare(sql)
          .run()
          .catch(function () {
            /* already there */
          });
      }
    })();
  }
  await orderColumnsPromise;
}

/* ------------------------------------------------------------
   Small helpers
   ------------------------------------------------------------ */

export function json(status, payload, extraHeaders) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  };
  if (extraHeaders) for (const key in extraHeaders) headers[key] = extraHeaders[key];
  return new Response(JSON.stringify(payload), { status: status, headers: headers });
}

const enc = new TextEncoder();

function b64u(bytes) {
  let out = "";
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < view.length; i++) out += String.fromCharCode(view[i]);
  return btoa(out).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64u(text) {
  const padded = String(text || "").replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded + "===".slice((padded.length + 3) % 4));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

export function secretFor(env) {
  return String(env.SESSION_SECRET || env.ADMIN_PASSCODE || "zeva-local-development-only");
}

export async function sign(env, payload) {
  const body = b64u(enc.encode(JSON.stringify(payload)));
  const mac = b64u(await hmac(secretFor(env), body));
  return body + "." + mac;
}

export async function unseal(env, token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 2) return null;
  const mac = b64u(await hmac(secretFor(env), parts[0]));
  if (mac.length !== parts[1].length) return null;
  let diff = 0;
  for (let i = 0; i < mac.length; i++) diff |= mac.charCodeAt(i) ^ parts[1].charCodeAt(i);
  if (diff !== 0) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(unb64u(parts[0])));
    if (!payload || (payload.exp && Date.now() > payload.exp)) return null;
    return payload;
  } catch (error) {
    return null;
  }
}

function cookies(request) {
  const out = {};
  const header = request.headers.get("cookie") || "";
  header.split(";").forEach(function (part) {
    const index = part.indexOf("=");
    if (index < 0) return;
    const name = part.slice(0, index).trim();
    if (!name) return;
    out[name] = decodeURIComponent(part.slice(index + 1).trim());
  });
  return out;
}

function cookieHeader(name, value, maxAge) {
  return name + "=" + encodeURIComponent(value) + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + maxAge;
}

function clearCookie(name) {
  return name + "=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
}

// Every origin that is really us: the platform address, plus whatever hostname
// Production has been given. A custom domain reaches this same Worker with its
// own Host, so the allowlist has to live in config (env.SITE_ORIGINS, comma
// separated) — otherwise every order POST from the domain answers 403.
export function ourOrigins(env) {
  return [SITE].concat(
    String((env && env.SITE_ORIGINS) || "")
      .split(",")
      .map(function (s) { return s.trim().replace(/\/+$/, ""); })
      .filter(Boolean)
  );
}

// Any environment of this site, whichever address it was given: the platform
// serves every one of them from <name>.freebuff.page, so those hosts are us by
// definition. Without this, a request arriving on Production was compared
// against the Preview URL below and its own Origin looked foreign, so every
// order placed there answered "cross-origin request".
function platformHost(hostname) {
  return hostname === PLATFORM_HOST || hostname.endsWith("." + PLATFORM_HOST);
}

export function canonicalOrigin(request, env) {
  const url = new URL(request.url);
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname)) return url.origin;
  // Stay on the host the visitor came in on, so an OAuth return or an error
  // bounce never throws them onto a different address mid-flow.
  if (platformHost(url.hostname)) return url.origin;
  return ourOrigins(env).indexOf(url.origin) !== -1 ? url.origin : SITE;
}

// Guard cookie-authenticated writes against cross-site form posts.
export function sameOrigin(request, env) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const o = new URL(origin).origin;
    // Same host that answered this very request: same-origin, whatever address
    // that host happens to be.
    if (o === new URL(request.url).origin) return true;
    if (ourOrigins(env).indexOf(o) !== -1) return true;
    return o === new URL(canonicalOrigin(request, env)).origin;
  } catch (error) {
    return false;
  }
}

/* ------------------------------------------------------------
   Database
   ------------------------------------------------------------ */

let schemaPromise = null;

/* Every table and every later-added column is already in place on a site that
   has answered a request before, so the warm path needs no DDL at all: three
   reads against a column each bootstrap adds prove the schema is there, and
   anything missing falls back to the full batch below.

   The D1 batch used to run on the first request of every isolate and its
   failure was thrown at the caller, which the platform answers with its
   "Site unavailable" 502 — so one busy moment in D1 took out a third of the
   requests on the site: the admin feed, members, orders and sign-in all died
   while every table was present and the data was untouched. A transient
   bootstrap failure now just skips the batch; the query that follows reports a
   real problem honestly, and the next request tries again. */
async function schemaReady(env) {
  try {
    await env.DB.prepare("SELECT address FROM users LIMIT 1").first();
    await env.DB.prepare("SELECT upi_seq FROM orders LIMIT 1").first();
    await env.DB.prepare("SELECT wallet_redeemed FROM orders LIMIT 1").first();
    await env.DB.prepare("SELECT arrived_at FROM reservations LIMIT 1").first();
    // The newest table: a database that already had everything else still has
    // to pick up `media` (the pictures /admin sends), so it is probed too.
    await env.DB.prepare("SELECT created_at FROM media LIMIT 1").first();
    return true;
  } catch (error) {
    return false;
  }
}

export async function database(env) {
  if (!env || !env.DB) return null;
  if (!schemaPromise) {
    const boot = (async function () {
      if (await schemaReady(env)) return;
      try {
        await env.DB.batch(DB_SCHEMA.map(function (sql) { return env.DB.prepare(sql); }));
      } catch (error) {
        console.warn("[db] schema batch failed: " + String((error && error.message) || error).slice(0, 160));
        schemaPromise = null;
        return;
      }
      await ensureUserColumns(env);
      await ensureOrderColumns(env);
      await ensureReservationColumns(env);
    })();
    schemaPromise = boot;
  }
  await schemaPromise;
  return env.DB;
}

/* ------------------------------------------------------------
   Sessions and users
   ------------------------------------------------------------ */

const SESSION_DAYS = 90;

export async function currentUser(request, env) {
  const token = cookies(request).zeva_sid;
  if (!token) return null;
  const payload = await unseal(env, token);
  if (!payload || !payload.uid) return null;
  const db = await database(env);
  if (!db) return null;
  const row = await db.prepare("SELECT * FROM users WHERE id = ?").bind(payload.uid).first();
  return row || null;
}

async function startSession(env, userId) {
  return sign(env, { uid: userId, exp: Date.now() + SESSION_DAYS * 86400000 });
}

export async function upsertUser(env, profile) {
  const db = await database(env);
  const now = Date.now();
  const existing = await db.prepare("SELECT * FROM users WHERE sub = ?").bind(String(profile.sub)).first();
  if (existing) {
    await db
      .prepare("UPDATE users SET email = ?, name = ?, picture = ?, last_seen_at = ? WHERE id = ?")
      .bind(profile.email || existing.email, profile.name || existing.name, profile.picture || existing.picture, now, existing.id)
      .run();
    return { ...existing, email: profile.email || existing.email, name: profile.name || existing.name, picture: profile.picture || existing.picture };
  }
  const id = crypto.randomUUID();
  await db
    .prepare("INSERT INTO users (id, sub, email, name, picture, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, String(profile.sub), profile.email || "", profile.name || "", profile.picture || "", now, now)
    .run();
  return { id: id, sub: String(profile.sub), email: profile.email || "", name: profile.name || "", picture: profile.picture || "", phone: "", created_at: now };
}

export async function goldStatus(env, userId) {
  if (!userId) return { status: "none" };
  const db = await database(env);
  if (!db) return { status: "none" };
  const row = await db.prepare("SELECT * FROM gold WHERE user_id = ?").bind(userId).first();
  if (!row) return { status: "none" };
  if (row.status === "active" && (!row.expires_at || row.expires_at < Date.now())) {
    return { status: "expired", expires_at: row.expires_at || null };
  }
  const active = row.status === "active";
  return {
    status: row.status,
    active: active,
    expires_at: row.expires_at || null,
    requested_at: row.requested_at || null,
    free_metres: active ? GOLD.freeMetres : 0,
    cashback: active ? GOLD.cashback : 0
  };
}

export async function walletBalance(env, userId) {
  if (!userId) return 0;
  const db = await database(env);
  if (!db) return 0;
  const row = await db.prepare("SELECT COALESCE(SUM(amount), 0) AS balance FROM wallet WHERE user_id = ?").bind(userId).first();
  return Math.round(Number((row && row.balance) || 0) * 100) / 100;
}

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name || "",
    email: user.email || "",
    picture: user.picture || "",
    phone: user.phone || "",
    address: user.address || "",
    created_at: user.created_at
  };
}

/* ------------------------------------------------------------
   Google OAuth (authorization code flow, server side)
   ------------------------------------------------------------ */

export function googleReady(env) {
  return Boolean(env && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

function redirectUri(request, env) {
  return canonicalOrigin(request, env) + "/api/auth/google/callback";
}

export async function googleStart(request, env) {
  const url = new URL(request.url);
  const next = String(url.searchParams.get("next") || "/app").slice(0, 200);
  // Google only hands back code + state, so anything the callback needs to
  // remember (like "this came from the Android shell") has to ride in state.
  const app = url.searchParams.get("app") === "1" ? 1 : 0;
  const state = await sign(env, { n: next, a: app, exp: Date.now() + 10 * 60000 });
  const target = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  target.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  target.searchParams.set("redirect_uri", redirectUri(request, env));
  target.searchParams.set("response_type", "code");
  target.searchParams.set("scope", "openid email profile");
  target.searchParams.set("state", state);
  target.searchParams.set("prompt", "select_account");
  return Response.redirect(target.toString(), 302);
}

export async function googleCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  // Cancelling the Google screen is not an error page — just go back.
  const refusal = url.searchParams.get("error");
  if (refusal) return Response.redirect(canonicalOrigin(request, env) + "/app?auth=" + encodeURIComponent(refusal.slice(0, 60)), 302);
  const state = await unseal(env, url.searchParams.get("state"));
  if (!code || !state) return new Response("Sign-in could not be verified. Please try again.", { status: 400 });
  let next = String(state.n || "/app");
  if (!/^\//.test(next)) next = "/app";

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(request, env),
      grant_type: "authorization_code"
    })
  });
  if (!tokenResponse.ok) return new Response("Google rejected the sign-in. " + (await googleReason(tokenResponse)), { status: 400 });
  const tokens = await tokenResponse.json();
  const claims = decodeIdToken(tokens.id_token);
  if (!claims || !claims.sub) return new Response("Google did not return a profile.", { status: 400 });
  if (claims.aud && claims.aud !== env.GOOGLE_CLIENT_ID) return new Response("Sign-in audience mismatch.", { status: 400 });

  const user = await upsertUser(env, {
    sub: claims.sub,
    email: claims.email || "",
    name: claims.name || "",
    picture: claims.picture || ""
  });
  const session = await startSession(env, user.id);
  // Opening from the Android shell? Hand back a one-time code instead of a
  // cookie the WebView could not receive.
  if (state.a) {
    const code2 = b64u(crypto.getRandomValues(new Uint8Array(24)));
    await (await database(env))
      .prepare("INSERT INTO login_codes (code, user_id, expires_at) VALUES (?, ?, ?)")
      .bind(code2, user.id, Date.now() + 5 * 60000)
      .run();
    return Response.redirect("zeva://auth?code=" + encodeURIComponent(code2), 302);
  }
  return new Response(null, {
    status: 302,
    headers: { location: next, "set-cookie": cookieHeader("zeva_sid", session, SESSION_DAYS * 86400) }
  });
}

// Google's token endpoint explains itself ("redirect_uri_mismatch",
// "invalid_client"); showing that beats a generic failure while setting up.
async function googleReason(response) {
  try {
    const body = JSON.parse(await response.text());
    const detail = String(body.error_description || body.error || "").trim();
    if (detail) return "Google said: " + detail.slice(0, 160);
  } catch (error) {
    /* fall through to the generic message */
  }
  return "Please try again.";
}

function decodeIdToken(idToken) {
  try {
    const parts = String(idToken || "").split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(new TextDecoder().decode(unb64u(parts[1])));
  } catch (error) {
    return null;
  }
}

/* ------------------------------------------------------------
   WhatsApp sign-up
   ------------------------------------------------------------
   A customer types their mobile number, a provider sends a six-digit code over
   WhatsApp, and the number becomes the account. No password, no Google account
   needed — which is what most walk-in customers actually have.

   The provider is any service exposing the same two calls (LoginWA's free plan
   is 100 messages/month and needs no Meta approval):
     POST {WHATSAPP_OTP_API}/auth/start   {phone, otp_length, message_template}
                                         -> {session_id, expires_in}
     POST {WHATSAPP_OTP_API}/auth/verify  {session_id, otp_code}
                                         -> 200 when the code is right
   The code itself never touches this server: it goes from the provider straight
   to the customer's WhatsApp, so a leak here cannot reveal it.
   ============================================================ */

const WHATSAPP_API_DEFAULT = "https://api.loginwa.com/api";
const OTP_TTL_SECONDS = 300;
const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_PER_WINDOW = 3;
const OTP_WINDOW_MS = 10 * 60 * 1000;

export function whatsappReady(env) {
  return Boolean(env && env.WHATSAPP_OTP_KEY);
}

function whatsappApi(env) {
  return String((env && env.WHATSAPP_OTP_API) || WHATSAPP_API_DEFAULT).replace(/\/+$/, "");
}

// Accepts 9876543210, 09876543210, +91 98765 43210 or a full international
// number; returns digits only, or "" when it cannot be a real mobile. India is
// strict on purpose: a ten-digit mobile starts 6-9, so autofilled junk (or a
// mistyped 11-digit string) is refused here instead of burning a paid message.
export function normalizePhone(env, raw) {
  const cc = String((env && env.WHATSAPP_COUNTRY_CODE) || "91").replace(/\D/g, "") || "91";
  let digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (cc === "91") {
    if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
    if (digits.length !== 10 || !/^[6-9]/.test(digits)) return "";
    return "91" + digits;
  }
  if (digits.length === 10) digits = cc + digits;
  if (digits.length < 11 || digits.length > 15) return "";
  return digits;
}

function maskPhone(digits) {
  const s = String(digits || "");
  if (s.length < 6) return "" + s;
  return "+" + s.slice(0, s.length - 7) + " \u2022\u2022\u2022\u2022 " + s.slice(-4);
}

/* 12 s was too tight: the provider takes 8–17 s to answer an /auth/start in
   normal running and 11.3 s measured on 26 Nov 2026, so a slow minute made the
   Worker give up while the code was already on its way — the customer saw
   "WhatsApp is not reachable right now" and could not sign up. 25 s clears the
   slowest send we have measured without holding the button forever. */
async function whatsappCall(env, route, payload) {
  const response = await fetch(whatsappApi(env) + route, {
    method: "POST",
    headers: {
      authorization: "Bearer " + env.WHATSAPP_OTP_KEY,
      "content-type": "application/json"
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(25000)
  });
  const data = await response.json().catch(function () { return {}; });
  return { ok: response.ok, status: response.status, data: data || {} };
}

/* A plain WhatsApp message, as opposed to an OTP — the provider's
   /v1/messages/send call with the same API key. Bookings use it twice: the
   guest gets their code, and the counter gets the table. A failed message
   never fails the booking; the code is already on the guest's screen.

   Returns { ok, status, error } rather than a bare boolean: "1 failed" told
   the counter nothing, and the provider always says why (quota_exceeded,
   no_device_connected, unauthorized...). The reason is what /admin shows.
   A busy sender (502/503) gets one more try — those fail before WhatsApp sees the
   message. A timeout is not retried: the provider may already have delivered it,
   and a duplicate marketing message to a customer is worse than a failure the
   counter can see. The send is slow (8–17 s measured from Cloudflare), which is
   why the old 8-second cap failed every marketing message silently. */
async function whatsappSend(env, phone, message, mediaUrl) {
  if (!whatsappReady(env)) return { ok: false, status: 0, error: "WHATSAPP_OTP_KEY is not set on this site" };
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return { ok: false, status: 0, error: "that member has no phone number" };
  // A picture goes out as a WhatsApp image and the words become its caption:
  // type=image + media_url, which the provider fetches itself (a public https
  // URL is the only kind it accepts). Text keeps the plain message field.
  const picture = String(mediaUrl || "");
  const payload = picture
    ? { phone: digits, type: "image", media_url: picture, caption: String(message || "").slice(0, 900) }
    : { phone: digits, message: String(message).slice(0, 900) };
  const body = JSON.stringify(payload);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(whatsappApi(env) + "/v1/messages/send", {
        method: "POST",
        headers: {
          authorization: "Bearer " + env.WHATSAPP_OTP_KEY,
          "content-type": "application/json"
        },
        body: body,
        signal: AbortSignal.timeout(25000)
      });
      const data = await response.json().catch(function () { return {}; });
      // 200 only means the engine took the message, not that a phone got it.
      // Keep the provider's id so the delivery can be asked about afterwards.
      if (response.ok) {
        return {
          ok: true,
          status: response.status,
          error: "",
          id: String(data.message_id || ""),
          quota: Number(data.quota_remaining) || null
        };
      }
      const reason = String(data.error || data.message || "").slice(0, 160) || "HTTP " + response.status;
      console.warn("[whatsapp] message failed " + response.status + ": " + reason);
      if ((response.status === 502 || response.status === 503) && attempt === 0) continue;
      return { ok: false, status: response.status, error: reason };
    } catch (error) {
      const reason = String((error && error.message) || "network error").slice(0, 160);
      console.warn("[whatsapp] message failed: " + reason);
      return { ok: false, status: 0, error: reason };
    }
  }
  return { ok: false, status: 0, error: "send failed" };
}

async function whatsappText(env, phone, message) {
  return (await whatsappSend(env, phone, message)).ok;
}

/* GET /api/admin/whatsapp — what the sender looks like from inside this
   Worker: which API the key points at, which devices that key has, and
   whether any of them is online. A key can send sign-in codes through the
   provider's pool while having no device of its own, and then every
   marketing or booking message fails with no_device_connected. The counter
   can only tell that apart from a quota problem by seeing this. */
export async function adminWhatsappStatus(env) {
  const api = whatsappApi(env);
  const out = { configured: whatsappReady(env), api: api, online: 0, devices: [], error: "" };
  if (!out.configured) {
    out.error = "WhatsApp is not configured: WHATSAPP_OTP_KEY is missing on this site.";
    return json(200, out);
  }
  try {
    const response = await fetch(api + "/v1/devices", {
      headers: { authorization: "Bearer " + env.WHATSAPP_OTP_KEY },
      signal: AbortSignal.timeout(15000)
    });
    const data = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      out.error = "The provider refused the key (HTTP " + response.status + "): " + (String(data.error || data.message || "").slice(0, 120) || "no reason given");
      return json(200, out);
    }
    const list = Array.isArray(data.devices) ? data.devices : [];
    out.devices = list.map(function (device) {
      return {
        label: String(device.label || "device").slice(0, 40),
        status: String(device.status || "").slice(0, 24),
        online: Boolean(device.is_online),
        phone: maskPhone(String(device.phone_number || "").replace(/\D/g, ""))
      };
    });
    out.online = out.devices.filter(function (device) { return device.online; }).length;
    if (!out.online) {
      out.error = out.devices.length
        ? "No WhatsApp device is online, so messages cannot go out. Reconnect the sender phone in the provider dashboard."
        : "This API key has no WhatsApp device linked to it, so only sign-in codes go out. Link the shop's phone to this key in the provider dashboard.";
    }
  } catch (error) {
    out.error = "Could not reach the WhatsApp provider from this site: " + String((error && error.message) || "network error").slice(0, 120);
  }
  return json(200, out);
}

/* Delivery, as opposed to acceptance. /v1/messages/send answers 200 with a
   message id while the message is only queued; a phone that is asked to
   message its own number leaves it queued forever and the customer sees
   nothing. This asks the provider what became of one id: queued, sent,
   delivered, read, failed ("" when the answer cannot be had). */
async function whatsappDelivery(env, messageId) {
  if (!messageId || !whatsappReady(env)) return "";
  try {
    const response = await fetch(whatsappApi(env) + "/v1/messages/" + encodeURIComponent(messageId), {
      headers: { authorization: "Bearer " + env.WHATSAPP_OTP_KEY },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) return "";
    const data = await response.json().catch(function () { return {}; });
    return String(data.status || "").toLowerCase();
  } catch (error) {
    return "";
  }
}

// The numbers this key's own devices answer on. WhatsApp never delivers a
// message a phone sends to its own number, so these have to be skipped by name
// instead of being counted as sent.
async function whatsappSenderNumbers(env) {
  if (!whatsappReady(env)) return [];
  try {
    const response = await fetch(whatsappApi(env) + "/v1/devices", {
      headers: { authorization: "Bearer " + env.WHATSAPP_OTP_KEY },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) return [];
    const data = await response.json().catch(function () { return {}; });
    return (Array.isArray(data.devices) ? data.devices : [])
      .map(function (device) { return String(device.phone_number || "").replace(/\D/g, ""); })
      .filter(Boolean);
  } catch (error) {
    return [];
  }
}

const DELIVERY_VERIFIED = ["sent", "delivered", "read"];

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// The counter's own WhatsApp, unless BOOKING_NOTIFY_PHONE says otherwise
// ("off" turns the staff copy off).
const BOOKING_NOTIFY_DEFAULT = "917022771888";

function bookingDay(booking) {
  try {
    return new Date(booking.arrive_at).toLocaleDateString("en-IN", {
      timeZone: "Asia/Kolkata",
      weekday: "short",
      day: "numeric",
      month: "short"
    });
  } catch (error) {
    return booking.day;
  }
}

function clockLabel(epoch) {
  try {
    return new Date(Number(epoch)).toLocaleTimeString("en-IN", {
      timeZone: "Asia/Kolkata",
      hour: "numeric",
      minute: "2-digit",
      hour12: true
    }).toUpperCase();
  } catch (error) {
    return "";
  }
}

async function notifyBooking(env, booking) {
  const day = bookingDay(booking);
  const clock = clockLabel(booking.arrive_at) || booking.time;
  const party =
    booking.adults + (booking.adults === 1 ? " adult" : " adults") +
    (booking.children ? " + " + booking.children + (booking.children === 1 ? " child" : " children") : "");
  const guestMessage =
    "Zeva Mandi & Grills \u2014 table " + booking.id + " is booked for " + day + " at " + clock + ". " +
    "Party: " + party + " (" + booking.seats + " seats). " +
    "We hold the table for " + RESERVE.holdMinutes + " minutes from " + clock +
    " and release it automatically after that, so please be at the restaurant by " + clock + ". " +
    "Show code " + booking.id + " at the counter. " +
    "Advance \u20b9" + RESERVE.advance + " \u2014 the UPI ID is in the next message. " +
    "Menu: " + SITE + "/menu \u2014 Free to cancel: " + SITE + "/reserve";

  // The advance gets its own message so the UPI ID is not buried inside a
  // paragraph: one line to copy the address, one line for the amount.
  const upi = directReady(env) ? upiId(env) : "";
  const payMessage = upi
    ? "Advance for table " + booking.id + ": \u20b9" + RESERVE.advance + " to " + upi + " (UPI ID). " +
      "Pay \u20b9" + RESERVE.advance + " in your UPI app with the note \u201ctable " + booking.id + "\u201d, " +
      "or tap “Pay \u20b9" + RESERVE.advance + " by UPI” on " + SITE + "/reserve. " +
      "The advance is adjusted in your bill."
    : "Advance for table " + booking.id + ": \u20b9" + RESERVE.advance + ", payable at the counter. " +
      "The advance is adjusted in your bill.";

  const counterSetting = String(env.BOOKING_NOTIFY_PHONE || BOOKING_NOTIFY_DEFAULT);
  const counterNumber = counterSetting === "off" ? "" : counterSetting.replace(/\D/g, "");
  const counterJob = counterNumber && counterNumber !== String(booking.phone)
    ? whatsappText(
        env,
        counterNumber,
        "NEW TABLE " + booking.id + " \u2014 " + (booking.name || "Guest") + ", " + booking.phone + ". " +
          party + " (" + booking.seats + " seats) on " + day + " at " + clock + "." +
          (booking.note ? " Note: " + booking.note + "." : "") +
          " Hold " + RESERVE.holdMinutes + " min from " + clock + ". " +
          "Advance \u20b9" + RESERVE.advance + " due \u2014 confirm it in /admin when the UPI shows."
      )
    : Promise.resolve(false);

  // Sent in order: details first, then the advance with the UPI ID, while the
  // counter's copy goes out alongside them.
  const sent = await whatsappText(env, booking.phone, guestMessage);
  if (sent) await whatsappText(env, booking.phone, payMessage);
  await counterJob;
  return Boolean(sent);
}

function whatsappError(result) {
  const data = result.data || {};
  return String(data.error || data.message || data.detail || "").slice(0, 160);
}

// One account per verified number. If that number is already saved on a Google
// account, sign into that same account instead of creating a second one.
async function assignMemberCode(env, userId) {
  const db = await database(env);
  if (!userId) return null;
  const existing = await db
    .prepare("SELECT code FROM member_codes WHERE user_id = ?")
    .bind(userId)
    .first();
  if (existing && existing.code) return String(existing.code);
  let code;
  let tries = 0;
  do {
    code = memberCode();
    tries++;
    if (tries > 20) throw new Error("could not make a unique member code");
  } while (
    await db.prepare("SELECT 1 FROM member_codes WHERE code = ?").bind(code).first()
  );
  await db.prepare("INSERT INTO member_codes (user_id, code, created_at) VALUES (?, ?, ?)").bind(userId, code, Date.now()).run();
  return code;
}

async function upsertPhoneUser(env, phone, assignCode = true, name = "") {
  const db = await database(env);
  const now = Date.now();
  // The name is optional at sign-up, so a blank one changes nothing.
  const typedName = String(name || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const sub = "wa:" + phone;
  const existing = await db
    .prepare("SELECT * FROM users WHERE sub = ? OR (phone IS NOT NULL AND phone = ? AND phone <> '')")
    .bind(sub, phone)
    .first();
  if (existing) {
    // Keep a Google subject intact so that sign-in still lands here.
    const keepSub = existing.sub && !String(existing.sub).startsWith("wa:") ? existing.sub : sub;
    // A name filled in at sign-up only fills an empty profile; an account that
    // already has one keeps it.
    const keepName = String(existing.name || "").trim() || typedName;
    await db.prepare("UPDATE users SET phone = ?, sub = ?, name = ?, last_seen_at = ? WHERE id = ?")
      .bind(phone, keepSub, keepName, now, existing.id)
      .run();
    const user = { ...existing, phone: phone, sub: keepSub, name: keepName };
    if (assignCode) await assignMemberCode(env, user.id);
    return user;
  }
  const id = crypto.randomUUID();
  await db.prepare("INSERT INTO users (id, sub, email, name, picture, phone, created_at, last_seen_at) VALUES (?, ?, '', ?, '', ?, ?, ?)")
    .bind(id, sub, typedName, phone, now, now)
    .run();
  await assignMemberCode(env, id);
  return { id: id, sub: sub, email: "", name: typedName, picture: "", phone: phone, created_at: now };
}

export async function whatsappStart(env, body) {
  if (!whatsappReady(env)) return json(503, { error: "whatsapp sign-in is not configured" });
  const db = await database(env);
  if (!db) return json(503, { error: "accounts are not configured" });

  const phone = normalizePhone(env, body && body.phone);
  if (!phone) return json(400, { error: "Enter a mobile number with 10 digits." });

  const since = Date.now() - OTP_WINDOW_MS;
  const recent = await db
    .prepare("SELECT COUNT(*) AS n FROM otp_sessions WHERE phone = ? AND created_at > ?")
    .bind(phone, since)
    .first();
  if (recent && Number(recent.n) >= OTP_MAX_PER_WINDOW) {
    return json(429, { error: "Too many codes for this number. Try again in ten minutes." });
  }

  // LoginWA rejects a full E.164 number in `phone` ("Enter a valid WhatsApp
  // number with country code") and only sends when the local number and the
  // country code arrive as two fields, so split them. otp_sessions still keeps
  // the full digits, so one customer is one key whatever format they typed.
  const country = String((env.WHATSAPP_COUNTRY_CODE) || "91").replace(/\D/g, "") || "91";
  const national = phone.startsWith(country) ? phone.slice(country.length) : phone;

  let result;
  try {
    result = await whatsappCall(env, "/auth/start", {
      phone: national,
      country_code: country,
      otp_length: 6,
      message_template: String(env.WHATSAPP_OTP_TEXT || "Your Zeva code is {code}. It expires in 5 minutes.")
    });
  } catch (error) {
    console.error("[whatsapp] send failed: " + error.message);
    return json(502, { error: "WhatsApp is not reachable right now. Try again." });
  }

  const sessionId = String((result.data && result.data.session_id) || "");
  if (!result.ok || !sessionId) {
    console.error("[whatsapp] send rejected " + result.status + ": " + whatsappError(result));
    return json(502, { error: whatsappError(result) || "WhatsApp could not send the code." });
  }

  const ttl = Math.min(Number(result.data.expires_in) || OTP_TTL_SECONDS, 600);
  const expiresAt = Date.now() + ttl * 1000;
  await db
    .prepare("INSERT OR REPLACE INTO otp_sessions (session, phone, created_at, expires_at, attempts, verified_at) VALUES (?, ?, ?, ?, 0, NULL)")
    .bind(sessionId, phone, Date.now(), expiresAt)
    .run();

  return json(200, { ok: true, session: sessionId, phone: maskPhone(phone), expires_in: Math.round(ttl) });
}

export async function whatsappVerify(request, env, body) {
  if (!whatsappReady(env)) return json(503, { error: "whatsapp sign-in is not configured" });
  const db = await database(env);
  if (!db) return json(503, { error: "accounts are not configured" });

  const session = String((body && body.session) || "").slice(0, 100);
  const code = String((body && body.code) || "").replace(/\D/g, "").slice(0, 8);
  if (!session) return json(400, { error: "Ask for a new code." });
  if (code.length < 4) return json(400, { error: "Enter the 6-digit code from WhatsApp." });

  const row = await db.prepare("SELECT * FROM otp_sessions WHERE session = ?").bind(session).first();
  if (!row) return json(400, { error: "That code has expired. Ask for a new one." });
  if (row.verified_at) return json(400, { error: "That code was already used. Ask for a new one." });
  if (Number(row.expires_at) < Date.now()) return json(400, { error: "That code has expired. Ask for a new one." });
  if (Number(row.attempts) >= OTP_MAX_ATTEMPTS) return json(429, { error: "Too many wrong codes. Ask for a new one." });

  await db.prepare("UPDATE otp_sessions SET attempts = attempts + 1 WHERE session = ?").bind(session).run();

  let result;
  try {
    result = await whatsappCall(env, "/auth/verify", { session_id: session, otp_code: code });
  } catch (error) {
    console.error("[whatsapp] verify failed: " + error.message);
    return json(502, { error: "WhatsApp is not reachable right now. Try again." });
  }
  if (!result.ok) {
    return json(401, { error: whatsappError(result) || "That code is not right." });
  }

  // Trust the number this session was opened for, not anything the caller sent.
  const phone = normalizePhone(env, row.phone);
  if (!phone) return json(400, { error: "That number could not be read. Ask for a new code." });

  // A member may type their name alongside the code; it is cleaned in
  // upsertPhoneUser and never overwrites a name the account already has.
  const name = String((body && body.name) || "").slice(0, 120);
  await db.prepare("UPDATE otp_sessions SET verified_at = ? WHERE session = ?").bind(Date.now(), session).run();
  const user = await upsertPhoneUser(env, phone, true, name);
  await assignMemberCode(env, user.id);
  const sessionToken = await startSession(env, user.id);
  return json(
    200,
    { ok: true, user: publicUser(user) },
    { "set-cookie": cookieHeader("zeva_sid", sessionToken, SESSION_DAYS * 86400) }
  );
}

/* ------------------------------------------------------------
   Table reservations
   ------------------------------------------------------------
   A booking is a number of covers in one 30-minute slot, not a table:
   a party of nine takes nine of that slot's seats. The hold is the
   rule the guest agrees to on the page — the table is theirs for
   RESERVE.holdMinutes after the booked time, then it is released and
   the covers are bookable again. Nothing has to run for that to
   happen: the times are stored on the row and every reader compares
   them with the clock, so an abandoned booking expires by itself. */

const IST_OFFSET_MS = 330 * 60000; // India has no daylight saving

// "2026-11-29" + "19:30" -> the epoch of that moment in India.
function istEpoch(day, time) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ""));
  const t = /^(\d{1,2}):(\d{2})$/.exec(String(time || ""));
  if (!d || !t) return 0;
  return Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2])) - IST_OFFSET_MS;
}

// The calendar day and clock a guest in Mangaluru would read right now.
function istDay(epoch) {
  return new Date(Number(epoch) + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function slotTimes() {
  const out = [];
  for (let minutes = RESERVE.firstHour * 60; minutes <= RESERVE.lastHour * 60; minutes += RESERVE.stepMinutes) {
    out.push(String(Math.floor(minutes / 60)).padStart(2, "0") + ":" + String(minutes % 60).padStart(2, "0"));
  }
  return out;
}

// Booking codes are read aloud at the counter, so they avoid 0/O and 1/I.
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

// 1000–9999, so the code is always exactly four digits with no leading zero.
function memberCode() {
  const digits = Math.max(1, Math.min(6, Number(MEMBERS.memberCodeDigits) || 4));
  const floor = Math.pow(10, digits - 1);
  const bytes = crypto.getRandomValues(new Uint32Array(1));
  return String(floor + (bytes[0] % (9 * floor)));
}

function shapeReservation(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name || "",
    phone: row.phone || "",
    day: row.day,
    time: row.time,
    arrive_at: Number(row.arrive_at || 0),
    hold_until: Number(row.hold_until || 0),
    adults: Number(row.adults || 0),
    children: Number(row.children || 0),
    seats: Number(row.seats || 0),
    note: row.note || "",
    status: row.status,
    // The counter has seen this party arrive — that is one visit on the
    // member's card.
    arrived_at: Number(row.arrived_at || 0),
    // The ₹500 advance: due until the guest says they paid, paid once the
    // counter has seen the money in the UPI app or the bank SMS.
    advance: {
      amount: Number(row.advance_amount || 0),
      status: row.advance_status || "due",
      utr: row.advance_utr || "",
      claimed_at: row.advance_claimed_at || null,
      paid_at: row.advance_paid_at || null
    },
    created_at: Number(row.created_at || 0)
  };
}

// GET /api/reservations/slots?day=YYYY-MM-DD — what is still bookable that day.
// `today` comes from the server so the page never has to guess the timezone.
export async function dayAvailability(env, day) {
  const db = await database(env);
  if (!db) return json(503, { error: "reservations are not configured" });
  const clean = String(day || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) return json(400, { error: "Pick a date for your table." });
  const now = Date.now();
  const today = istDay(now);
  if (clean < today) return json(400, { error: "That date has passed. Pick today or later." });
  if (istEpoch(clean, "12:00") > now + RESERVE.maxDays * 86400000) {
    return json(400, { error: "We take bookings up to " + RESERVE.maxDays + " days ahead." });
  }
  const rows = await db
    .prepare("SELECT time, COALESCE(SUM(seats), 0) AS seats FROM reservations WHERE day = ? AND status = 'booked' GROUP BY time")
    .bind(clean)
    .all();
  const taken = {};
  (rows.results || []).forEach(function (row) {
    taken[row.time] = Number(row.seats || 0);
  });
  const slots = slotTimes().map(function (time) {
    const arrive = istEpoch(clean, time);
    const left = Math.max(0, RESERVE.seats - (taken[time] || 0));
    // A slot closes five minutes before it starts: nobody can book a table
    // they are already late for.
    return { time: time, arrive_at: arrive, left: left, open: left > 0 && arrive > now + 5 * 60000 };
  });
  return json(200, {
    day: clean,
    today: today,
    latest: istDay(now + RESERVE.maxDays * 86400000),
    seats: RESERVE.seats,
    hold_minutes: RESERVE.holdMinutes,
    slots: slots
  });
}

// POST /api/reservations — a signed-in guest books a table.
export async function createReservation(request, env, body) {
  const db = await database(env);
  if (!db) return json(503, { error: "reservations are not configured" });
  const user = await currentUser(request, env);
  if (!user) return json(401, { error: "Sign in with WhatsApp to book a table.", sign_in: true });

  const day = String((body && body.day) || "").trim();
  const time = String((body && body.time) || "").trim();
  const adults = Math.round(Number(body && body.adults));
  const children = Math.round(Number((body && body.children) || 0));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json(400, { error: "Pick a date for your table." });
  if (slotTimes().indexOf(time) < 0) return json(400, { error: "Pick a time between 12 PM and 10 PM." });
  if (!Number.isFinite(adults) || adults < 1 || adults > RESERVE.maxAdults) {
    return json(400, { error: "How many adults are coming? 1 to " + RESERVE.maxAdults + "." });
  }
  if (!Number.isFinite(children) || children < 0 || children > RESERVE.maxChildren) {
    return json(400, { error: "Children must be between 0 and " + RESERVE.maxChildren + "." });
  }

  const arriveAt = istEpoch(day, time);
  const now = Date.now();
  if (arriveAt < now + 5 * 60000) return json(400, { error: "That time has passed. Pick a later one." });
  if (arriveAt > now + RESERVE.maxDays * 86400000) return json(400, { error: "We take bookings up to " + RESERVE.maxDays + " days ahead." });

  const seats = adults + children;
  if (seats > RESERVE.seats) return json(400, { error: "That is more than we can seat in one booking. Call 070227 71888." });

  const phone = normalizePhone(env, (body && body.phone) || user.phone);
  if (!phone) return json(400, { error: "Enter the mobile number we should call if anything changes." });

  const upcoming = await db
    .prepare("SELECT COUNT(*) AS n FROM reservations WHERE user_id = ? AND status = 'booked' AND hold_until > ?")
    .bind(user.id, now)
    .first();
  if (Number((upcoming && upcoming.n) || 0) >= RESERVE.maxUpcoming) {
    return json(429, { error: "You already hold " + RESERVE.maxUpcoming + " tables. Cancel one first, or call 070227 71888." });
  }

  const slot = await db
    .prepare("SELECT COALESCE(SUM(seats), 0) AS seats FROM reservations WHERE day = ? AND time = ? AND status = 'booked'")
    .bind(day, time)
    .first();
  if (Number((slot && slot.seats) || 0) + seats > RESERVE.seats) {
    return json(409, { error: "That time is fully booked. Please pick another time." });
  }

  const id = bookingCode();
  const holdUntil = arriveAt + RESERVE.holdMinutes * 60000;
  try {
    await db
      .prepare(
        "INSERT INTO reservations (id, user_id, name, email, phone, day, time, arrive_at, hold_until, adults, children, seats, note, status, advance_status, advance_amount, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'booked', 'due', ?, ?)"
      )
      .bind(
        id,
        user.id,
        String((body && body.name) || user.name || "").slice(0, 80),
        String(user.email || "").slice(0, 120),
        phone,
        day,
        time,
        arriveAt,
        holdUntil,
        adults,
        children,
        seats,
        String((body && body.note) || "").slice(0, 240),
        RESERVE.advance,
        now
      )
      .run();
  } catch (error) {
    console.error("[reserve] insert failed: " + error.message);
    return json(500, { error: "That booking did not save. Please try again." });
  }

  // Keep the number on the profile, and tell the customer's phone once.
  if (!user.phone) await db.prepare("UPDATE users SET phone = ? WHERE id = ?").bind(phone, user.id).run();
  const row = await db.prepare("SELECT * FROM reservations WHERE id = ?").bind(id).first();
  const booking = shapeReservation(row);
  await pushNotice(env, {
    user_id: user.id,
    title: "Table booked \u00b7 " + time + ", " + day,
    body:
      seats + (seats === 1 ? " seat" : " seats") + " held for " + RESERVE.holdMinutes +
      " minutes from " + time + ". Show code " + id + " at the counter \u2014 arrive on time, the table is released after that."
  });
  // The guest's code and the counter's copy go out on WhatsApp straight away.
  const notified = await notifyBooking(env, booking).catch(function (error) {
    console.warn("[reserve] notify failed: " + error.message);
    return false;
  });
  return json(200, { ok: true, now: Date.now(), notified: notified, reservation: booking });
}

// GET /api/reservations — the signed-in guest's own bookings.
export async function myReservations(request, env) {
  const db = await database(env);
  if (!db) return json(503, { error: "reservations are not configured" });
  const user = await currentUser(request, env);
  if (!user) return json(200, { signed_in: false, now: Date.now(), reservations: [] });
  const rows = await db
    .prepare("SELECT * FROM reservations WHERE user_id = ? ORDER BY arrive_at DESC LIMIT 20")
    .bind(user.id)
    .all();
  return json(200, {
    signed_in: true,
    now: Date.now(),
    hold_minutes: RESERVE.holdMinutes,
    reservations: (rows.results || []).map(shapeReservation)
  });
}

// A guest (or the counter) calls a booking off. Only the owner can do it from
// the page; the staff route passes admin = true.
async function cancelReservationRow(env, id, userId, admin) {
  const db = await database(env);
  if (!db) return json(503, { error: "reservations are not configured" });
  const row = await db.prepare("SELECT * FROM reservations WHERE id = ?").bind(String(id || "").trim().toUpperCase()).first();
  if (!row) return json(404, { error: "We could not find that booking." });
  if (!admin && row.user_id !== userId) return json(403, { error: "That booking is not on your account." });
  if (row.status !== "booked") return json(200, { ok: true, reservation: shapeReservation(row) });
  await db.prepare("UPDATE reservations SET status = 'cancelled', cancelled_at = ? WHERE id = ?").bind(Date.now(), row.id).run();
  if (row.user_id && !admin) {
    await pushNotice(env, {
      user_id: row.user_id,
      title: "Table cancelled \u00b7 " + row.time + ", " + row.day,
      body: "Your booking " + row.id + " is cancelled. Nothing was charged. Book again any time."
    });
  }
  const fresh = await db.prepare("SELECT * FROM reservations WHERE id = ?").bind(row.id).first();
  return json(200, { ok: true, reservation: shapeReservation(fresh) });
}

export async function cancelReservation(request, env, body) {
  const user = await currentUser(request, env);
  if (!user) return json(401, { error: "Sign in first.", sign_in: true });
  return cancelReservationRow(env, body && body.id, user.id, false);
}

/* The ₹500 advance. It is the shop's own VPA, exactly like a direct-mode
   order payment: the app opens with the amount already filled in, and only
   the counter can say the money arrived (the bank app is the authority). */
function advanceIntent(env, code, amount) {
  const params = new URLSearchParams();
  params.set("pa", upiId(env));
  params.set("pn", String(env.UPI_PAYEE_NAME || "Zeva Mandi & Grills").slice(0, 50));
  params.set("am", (Math.round(Number(amount) * 100) / 100).toFixed(2));
  params.set("cu", "INR");
  params.set("tn", ("Zeva table " + code).slice(0, 50));
  return "upi://pay?" + params.toString();
}

async function ownBooking(env, request, body) {
  const db = await database(env);
  if (!db) return { error: json(503, { error: "reservations are not configured" }) };
  const user = await currentUser(request, env);
  if (!user) return { error: json(401, { error: "Sign in first.", sign_in: true }) };
  const row = await db
    .prepare("SELECT * FROM reservations WHERE id = ?")
    .bind(String((body && body.id) || "").trim().toUpperCase())
    .first();
  if (!row) return { error: json(404, { error: "We could not find that booking." }) };
  if (row.user_id !== user.id) return { error: json(403, { error: "That booking is not on your account." }) };
  return { db: db, user: user, row: row };
}

// POST /api/reservations/pay {id} — the advance as a UPI link for that table.
export async function reservationAdvance(request, env, body) {
  const found = await ownBooking(env, request, body);
  if (found.error) return found.error;
  const amount = Number(found.row.advance_amount || RESERVE.advance) || RESERVE.advance;
  if (found.row.advance_status === "paid") {
    return json(200, { ok: true, paid: true, amount: amount });
  }
  if (!directReady(env)) {
    return json(200, { ok: true, paid: false, configured: false, amount: amount, error: "Pay the advance at the counter" });
  }
  return json(200, {
    ok: true,
    paid: false,
    configured: true,
    amount: amount,
    intent: advanceIntent(env, found.row.id, amount),
    vpa: upiId(env),
    payee: String(env.UPI_PAYEE_NAME || "Zeva Mandi & Grills")
  });
}

// POST /api/reservations/paid {id} — the guest says they have paid. This is a
// claim, not proof, so it only moves the row to 'claimed' for the counter.
export async function claimReservationAdvance(request, env, body) {
  const found = await ownBooking(env, request, body);
  if (found.error) return found.error;
  if (found.row.advance_status !== "paid") {
    await found.db
      .prepare("UPDATE reservations SET advance_status = 'claimed', advance_claimed_at = ? WHERE id = ?")
      .bind(Date.now(), found.row.id)
      .run();
  }
  const fresh = await found.db.prepare("SELECT * FROM reservations WHERE id = ?").bind(found.row.id).first();
  return json(200, { ok: true, reservation: shapeReservation(fresh) });
}

// The counter's list: today and tomorrow, plus anything a guest cancelled.
export async function adminReservations(env) {
  const db = await database(env);
  if (!db) return json(503, { error: "reservations are not configured" });
  const now = Date.now();
  const today = istDay(now);
  const tomorrow = istDay(now + 86400000);
  const rows = await db
    .prepare("SELECT * FROM reservations WHERE day >= ? AND day <= ? ORDER BY arrive_at ASC LIMIT 200")
    .bind(today, tomorrow)
    .all();
  return json(200, {
    now: now,
    today: today,
    tomorrow: tomorrow,
    hold_minutes: RESERVE.holdMinutes,
    reservations: (rows.results || []).map(shapeReservation)
  });
}

// The counter's own actions on one booking: cancelling it, or confirming the
// ₹500 advance once the money is visible in the UPI app or the bank SMS.
export async function adminSetReservation(env, body) {
  // Marking the party as arrived is what puts a stamp on their member card.
  if (body && body.arrived) {
    const db = await database(env);
    if (!db) return json(503, { error: "reservations are not configured" });
    const id = String(body.id || "").trim().toUpperCase();
    const row = await db.prepare("SELECT * FROM reservations WHERE id = ?").bind(id).first();
    if (!row) return json(404, { error: "unknown booking" });
    // The table is marked arrived either way; the stamp is what today's limit
    // can refuse, and the counter is told which of the two happened.
    let stamp = null;
    if (!row.arrived_at) {
      await db.prepare("UPDATE reservations SET arrived_at = ? WHERE id = ?").bind(Date.now(), id).run();
      if (row.user_id) {
        const result = await recordVisit(env, row.user_id, id, "dine-in");
        stamp = result.added
          ? { added: true }
          : { added: false, reason: result.reason, stamped_at: Number(result.at || 0), error: stampRefusalText(result) };
      }
    }
    const fresh = await db.prepare("SELECT * FROM reservations WHERE id = ?").bind(id).first();
    return json(200, { ok: true, reservation: shapeReservation(fresh), stamp: stamp });
  }
  if (body && body.advance) {
    const db = await database(env);
    if (!db) return json(503, { error: "reservations are not configured" });
    const id = String(body.id || "").trim().toUpperCase();
    const row = await db.prepare("SELECT * FROM reservations WHERE id = ?").bind(id).first();
    if (!row) return json(404, { error: "unknown booking" });
    const paid = body.advance === "paid";
    await db
      .prepare("UPDATE reservations SET advance_status = ?, advance_paid_at = ?, advance_amount = ? WHERE id = ?")
      .bind(paid ? "paid" : "due", paid ? Date.now() : null, Number(row.advance_amount || RESERVE.advance), id)
      .run();
    const fresh = await db.prepare("SELECT * FROM reservations WHERE id = ?").bind(id).first();
    return json(200, { ok: true, reservation: shapeReservation(fresh) });
  }
  return cancelReservationRow(env, body && body.id, null, true);
}

/* ------------------------------------------------------------
   Membership · visits, the wheel, and the counter's member list
   ------------------------------------------------------------
   Nothing here needs a job: a card is just visits counted against spins
   taken, so marking a visit on the tablet immediately opens the wheel. */

function prizeNames() {
  return MEMBERS.prizes.map(function (prize) {
    return prize.name;
  });
}

// Weighted pick over the wheel. Ras Malai and "any juice" are one segment
// each; every named juice is two, so the rarer prize stays rare.
function pickPrize() {
  const total = MEMBERS.prizes.reduce(function (sum, prize) {
    return sum + prize.weight;
  }, 0);
  const bytes = crypto.getRandomValues(new Uint32Array(1));
  let ticket = (bytes[0] / 4294967296) * total;
  for (let i = 0; i < MEMBERS.prizes.length; i++) {
    ticket -= MEMBERS.prizes[i].weight;
    if (ticket <= 0) return { prize: MEMBERS.prizes[i], index: i };
  }
  return { prize: MEMBERS.prizes[0], index: 0 };
}

function shapeSpin(row) {
  return {
    id: Number(row.id),
    prize: row.prize,
    code: row.code,
    created_at: Number(row.created_at || 0),
    used_at: row.used_at ? Number(row.used_at) : null
  };
}

// When this member was stamped today (India time), or 0 if they have not been.
// One stamp a day is the guard that makes the ₹10 safe: it is checked in
// recordVisit, so the + stamp button, the walk-in box, a typed member code and
// Mark visit on a booking all obey the same rule.
async function stampToday(env, userId) {
  const db = await database(env);
  if (!db || !userId) return 0;
  const midnight = istEpoch(istDay(Date.now()), "00:00");
  const row = await db
    .prepare("SELECT created_at FROM visits WHERE user_id = ? AND created_at >= ? ORDER BY created_at ASC LIMIT 1")
    .bind(userId, midnight)
    .first();
  return Number((row && row.created_at) || 0);
}

// What the counter is told when a stamp is refused, so all four paths say the
// same thing instead of each inventing its own wording.
function stampRefusalText(result) {
  if (result && result.reason === "already_today") {
    const at = clockLabel(Number(result.at || 0));
    return (
      "Already stamped today" + (at ? " at " + at : "") + ". One stamp a day per member, \u20b9" +
      MEMBERS.stampCashback + " a stamp \u2014 nothing was added and no rupee was paid."
    );
  }
  return "That visit was already stamped, so nothing was added.";
}

function stampRefusal(result) {
  return json(409, {
    ok: false,
    added: false,
    reason: (result && result.reason) || "not stamped",
    stamped_at: Number((result && result.at) || 0),
    error: stampRefusalText(result)
  });
}

// One visit. The unique booking_id makes a repeated tap a no-op instead of a
// second stamp; stampToday() makes a second visit the same day a no-op on every
// path. The wallet row is written only after the visit row lands, so neither a
// repeated tap nor a refused stamp can pay the ₹10 twice.
async function recordVisit(env, userId, bookingId, source) {
  const db = await database(env);
  if (!db || !userId) return { added: false, reason: "no member" };
  const already = await stampToday(env, userId);
  if (already) return { added: false, reason: "already_today", at: already };
  try {
    await db
      .prepare("INSERT INTO visits (user_id, booking_id, source, created_at) VALUES (?, ?, ?, ?)")
      .bind(userId, bookingId || null, source || "dine-in", Date.now())
      .run();
  } catch (error) {
    return { added: false, reason: "already_stamped" };
  }
  // A stamp now carries money as well as a square: MEMBERS.stampCashback lands
  // in Zeva Money the moment the counter records the visit. The stamp itself is
  // already saved, so a failed wallet write must not lose the visit.
  try {
    await db
      .prepare("INSERT INTO wallet (user_id, amount, kind, order_id, note, created_at) VALUES (?, ?, 'stamp', ?, ?, ?)")
      .bind(userId, MEMBERS.stampCashback, null, "Zeva Money \u00b7 visit stamp", Date.now())
      .run();
  } catch (error) {
    /* the visit stands on its own */
  }
  return { added: true };
}

export async function memberState(env, userId) {
  if (!userId) return null;
  const db = await database(env);
  if (!db) return null;
  const visits = await db.prepare("SELECT COUNT(*) AS n FROM visits WHERE user_id = ?").bind(userId).first();
  const spins = await db.prepare("SELECT COUNT(*) AS n FROM spins WHERE user_id = ?").bind(userId).first();
  const open = await db
    .prepare("SELECT * FROM spins WHERE user_id = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 10")
    .bind(userId)
    .all();
  const count = Number((visits && visits.n) || 0);
  const earned = Math.floor(count / MEMBERS.visitsPerSpin);
  const taken = Number((spins && spins.n) || 0);
  const into = count % MEMBERS.visitsPerSpin;
  return {
    visits: count,
    visits_per_spin: MEMBERS.visitsPerSpin,
    earned: earned,
    spins_taken: taken,
    spins_left: Math.max(0, earned - taken),
    to_next: into === 0 ? MEMBERS.visitsPerSpin : MEMBERS.visitsPerSpin - into,
    stamp_cashback: MEMBERS.stampCashback,
    prizes: prizeNames(),
    open_prizes: (open.results || []).map(shapeSpin)
  };
}

// GET /api/member — the card, the stamps and whatever prizes are still open.
export async function myMembership(request, env) {
  const db = await database(env);
  if (!db) return json(503, { error: "members are not configured" });
  const user = await currentUser(request, env);
  if (!user) {
    return json(200, {
      signed_in: false,
      visits_per_spin: MEMBERS.visitsPerSpin,
      prizes: prizeNames(),
      gold_plan: GOLD
    });
  }
  const state = await memberState(env, user.id);
  const gold = await goldStatus(env, user.id);
  return json(200, {
    signed_in: true,
    user: publicUser(user),
    gold: gold,
    gold_plan: GOLD,
    prizes: prizeNames(),
    membership: state
  });
}

// POST /api/member/spin — one turn, chosen on the server.
export async function spinTheWheel(request, env) {
  const db = await database(env);
  if (!db) return json(503, { error: "members are not configured" });
  const user = await currentUser(request, env);
  if (!user) return json(401, { error: "Sign in with WhatsApp to spin the wheel.", sign_in: true });

  const before = await memberState(env, user.id);
  if (!before || before.spins_left < 1) {
    return json(409, {
      error: "The wheel opens every " + MEMBERS.visitsPerSpin + " visits. You have " + ((before && before.visits) || 0) + "."
    });
  }

  const pick = pickPrize();
  const code = "Z" + bookingCode().slice(0, 4);
  await db
    .prepare("INSERT INTO spins (user_id, prize, code, created_at) VALUES (?, ?, ?, ?)")
    .bind(user.id, pick.prize.name, code, Date.now())
    .run();

  // Two phones spinning at once must not both spend the same tenth visit.
  const after = await memberState(env, user.id);
  if (after.spins_taken > after.earned) {
    await db.prepare("DELETE FROM spins WHERE user_id = ? AND code = ?").bind(user.id, code).run();
    return json(409, { error: "That spin was already used. Ask the counter to check your visits." });
  }

  return json(200, {
    ok: true,
    index: pick.index,
    prize: pick.prize.name,
    code: code,
    membership: after
  });
}

// GET /api/admin/members — every signed-up customer, for the counter.
export async function adminMembers(env) {
  const db = await database(env);
  if (!db) return json(503, { error: "accounts are not configured" });
  // Midnight in India, so the list can say who has already had today's stamp —
  // the counter sees that before tapping, not after being refused.
  const dayStart = istEpoch(istDay(Date.now()), "00:00");
  const rows = await db
    .prepare(
      "SELECT u.id, u.name, u.phone, u.email, u.created_at, u.last_seen_at, " +
        "(SELECT code FROM member_codes mc WHERE mc.user_id = u.id AND mc.used_at IS NULL LIMIT 1) AS member_code, " +
        "(SELECT COUNT(*) FROM visits v WHERE v.user_id = u.id) AS visits, " +
        "(SELECT MAX(v0.created_at) FROM visits v0 WHERE v0.user_id = u.id AND v0.created_at >= " + Number(dayStart) + ") AS stamped_today, " +
        "(SELECT COALESCE(SUM(w0.amount), 0) FROM wallet w0 WHERE w0.user_id = u.id) AS balance, " +
        "(SELECT COUNT(*) FROM spins s WHERE s.user_id = u.id) AS spins, " +
        "(SELECT COUNT(*) FROM spins s2 WHERE s2.user_id = u.id AND s2.used_at IS NULL) AS open_prizes, " +
        "(SELECT GROUP_CONCAT(s3.prize || ':' || s3.code, '|') FROM spins s3 WHERE s3.user_id = u.id AND s3.used_at IS NULL) AS open_list, " +
        "g.status AS gold_status, g.expires_at AS gold_until " +
        "FROM users u LEFT JOIN gold g ON g.user_id = u.id " +
        "ORDER BY u.created_at DESC LIMIT 500"
    )
    .all();
  const members = (rows.results || []).map(function (row) {
    return {
      id: row.id,
      name: row.name || "",
      phone: row.phone || "",
      email: row.email || "",
      code: String(row.member_code || "").toUpperCase(),
      visits: Number(row.visits || 0),
      spins: Number(row.spins || 0),
      open_prizes: Number(row.open_prizes || 0),
      // "Ras Malai:ZAB12|Lime Juice:ZCD34" — what the counter still owes them.
      open_list: String(row.open_list || "")
        .split("|")
        .filter(Boolean)
        .map(function (pair) {
          const cut = pair.lastIndexOf(":");
          return { prize: pair.slice(0, cut), code: pair.slice(cut + 1) };
        }),
      // When today's stamp was given, 0 when there is still one to give.
      stamped_today: Number(row.stamped_today || 0),
      // Zeva Money as it stands, so the list can show it without a second call.
      balance: Math.round(Number(row.balance || 0) * 100) / 100,
      gold: row.gold_status === "active" && (!row.gold_until || Number(row.gold_until) > Date.now()),
      joined: Number(row.created_at || 0),
      seen: row.last_seen_at ? Number(row.last_seen_at) : 0
    };
  });
  const withPhone = members.filter(function (m) {
    return m.phone;
  });
  return json(200, {
    members: members,
    counts: {
      total: members.length,
      reachable: withPhone.length,
      gold: members.filter(function (m) {
        return m.gold;
      }).length,
      spins_open: members.reduce(function (sum, m) {
        return sum + m.open_prizes;
      }, 0),
      visits: members.reduce(function (sum, m) {
        return sum + m.visits;
      }, 0)
    },
    cap: MARKETING_MAX
  });
}

/* ------------------------------------------------------------
   Pictures from the counter
   ------------------------------------------------------------
   The WhatsApp provider sends media by URL, so a picture the counter attaches
   on /admin is stored in D1 and handed back at /api/media/<id>. The id is a
   random UUID: WhatsApp has to fetch the URL with no cookie, so the link is the
   only thing guarding it, and it must not be guessable.

   The browser shrinks a photo to 1280 px before uploading it, both because
   WhatsApp does not need more and because a phone photo would blow past D1's
   1 MB row limit. */
const MEDIA_MAX_BYTES = 700 * 1024;
const MEDIA_KEEP_DAYS = 60;
const MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp"];

export async function adminMediaUpload(env, body) {
  const db = await database(env);
  if (!db) return json(503, { error: "accounts are not configured" });
  const raw = String((body && body.image) || "");
  const match = raw.match(/^data:([a-z/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match || MEDIA_TYPES.indexOf(match[1].toLowerCase()) < 0) {
    return json(400, { error: "Attach a JPEG, PNG or WebP picture." });
  }
  const mime = match[1].toLowerCase();
  const base64 = match[2].replace(/\s+/g, "");
  const bytes = Math.floor((base64.length * 3) / 4);
  if (!bytes) return json(400, { error: "That picture came through empty. Try again." });
  if (bytes > MEDIA_MAX_BYTES) {
    return json(413, { error: "That picture is " + Math.round(bytes / 1024) + " kB \u2014 keep it under 700 kB." });
  }

  // Old sends keep working: WhatsApp has already downloaded their picture. What
  // must not happen is a year of promos filling the database.
  await db
    .prepare("DELETE FROM media WHERE created_at < ?")
    .bind(Date.now() - MEDIA_KEEP_DAYS * 86400000)
    .run()
    .catch(function () {});

  const id = crypto.randomUUID().replace(/-/g, "");
  await db
    .prepare("INSERT INTO media (id, mime, bytes, data, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, mime, bytes, base64, Date.now())
    .run();
  return json(200, { ok: true, id: id, url: SITE + "/api/media/" + id, bytes: bytes, kept_days: MEDIA_KEEP_DAYS });
}

// GET /api/media/<id> — public on purpose: the provider fetches it. Immutable
// because the id never changes its content.
export async function serveMedia(env, id) {
  const db = await database(env);
  if (!db) return json(404, { error: "no such picture" });
  const key = String(id || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 64);
  if (!key) return json(404, { error: "no such picture" });
  const row = await db.prepare("SELECT mime, data FROM media WHERE id = ?").bind(key).first();
  if (!row) return json(404, { error: "no such picture" });
  const binary = atob(String(row.data || ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": String(row.mime || "image/jpeg"),
      "content-length": String(bytes.length),
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff"
    }
  });
}

/* Marketing from the counter. One message to every member, or to the Gold
   members, or to people who have actually come in. It is capped because the
   provider's free plan is 100 messages a month and a booking already spends
   two — the dashboard shows how many are left after this send. */
const MARKETING_MAX = 30;
// Delivery is checked for at most this many ids: each check is one API call and
// the provider allows 120 a minute for the key, which the sends also spend.
const MARKETING_CHECK_MAX = 12;
const MARKETING_SHIELD = "Zeva Mandi & Grills \u00b7 zevamandiandgrills.in \u00b7 reply STOP to stop these messages";

export async function adminMarketing(env, body) {
  const db = await database(env);
  if (!db) return json(503, { error: "accounts are not configured" });
  if (!whatsappReady(env)) return json(503, { error: "WhatsApp is not configured on this site, so nothing can be sent." });
  const message = String((body && body.message) || "").trim().slice(0, 600);
  // A picture on its own is a message: the words are the caption and are
  // optional then. Without one, the text still has to say something.
  const wantedMedia = String((body && body.media) || "").trim();
  let mediaUrl = "";
  if (wantedMedia) {
    const picture = await db
      .prepare("SELECT id FROM media WHERE id = ?")
      .bind(wantedMedia.replace(/[^a-zA-Z0-9]/g, ""))
      .first();
    if (!picture) return json(400, { error: "That picture is no longer stored. Attach it again." });
    mediaUrl = SITE + "/api/media/" + picture.id;
  }
  if (message.length < 3 && !mediaUrl) return json(400, { error: "Write the message first." });
  const wanted = String((body && body.audience) || "all");
  const audience = ["all", "gold", "visited"].indexOf(wanted) >= 0 ? wanted : "all";
  const cap = Math.max(1, Math.min(MARKETING_MAX, Number((body && body.limit) || MARKETING_MAX)));

  const where = ["u.phone IS NOT NULL", "u.phone <> ''"];
  if (audience === "gold") where.push("g.status = 'active'");
  if (audience === "visited") where.push("EXISTS (SELECT 1 FROM visits v WHERE v.user_id = u.id)");
  const rows = await db
    .prepare(
      "SELECT u.id, u.name, u.phone FROM users u LEFT JOIN gold g ON g.user_id = u.id WHERE " +
        where.join(" AND ") +
        " ORDER BY u.created_at DESC"
    )
    .all();
  const all = rows.results || [];
  const batch = all.slice(0, cap);
  const text = (message ? message + "\n\n" : "") + MARKETING_SHIELD;

  // A phone cannot message its own number. The provider still answers 200 and
  // the message waits as "queued" forever, which is exactly how a successful
  // test send to the shop's own phone turns into "sent, but nothing arrived".
  // The shop's own number is the usual test, so skip it by name and say why.
  const senders = await whatsappSenderNumbers(env);
  function isSender(member) {
    return senders.indexOf(String((member && member.phone) || "").replace(/\D/g, "")) >= 0;
  }
  const self = batch.filter(isSender);
  const target = batch.filter(function (member) { return !isSender(member); });

  let sent = 0;
  let failed = 0;
  let reason = "";
  const accepted = [];
  for (let i = 0; i < target.length; i += 5) {
    const slice = target.slice(i, i + 5);
    const results = await Promise.all(
      slice.map(function (member) {
        return whatsappSend(env, member.phone, text, mediaUrl);
      })
    );
    results.forEach(function (result, index) {
      if (result && result.ok) {
        sent++;
        accepted.push({ id: result.id || "", phone: slice[index].phone });
      } else {
        failed++;
        if (!reason) reason = String((result && result.error) || "send failed");
      }
    });
  }

  /* Acceptance is not delivery. The first few ids are asked about until they
     stop being queued, so the counter learns that a message the provider took
     never reached a phone — the difference between "sent" and "received". */
  const checked = accepted.filter(function (item) { return item.id; }).slice(0, MARKETING_CHECK_MAX);
  const states = {};
  let waiting = checked;
  for (let round = 0; round < 3 && waiting.length; round++) {
    if (round) await sleep(6000);
    const answered = await Promise.all(
      waiting.map(function (item) {
        return whatsappDelivery(env, item.id).then(function (status) {
          return { item: item, status: status };
        });
      })
    );
    const still = [];
    answered.forEach(function (row) {
      states[row.item.id] = row.status;
      if (DELIVERY_VERIFIED.indexOf(row.status) < 0) still.push(row.item);
    });
    waiting = still;
  }
  let delivered = 0;
  let queued = 0;
  checked.forEach(function (item) {
    if (DELIVERY_VERIFIED.indexOf(states[item.id] || "") >= 0) delivered++;
    else queued++;
  });
  if (queued && !reason) {
    reason =
      "The provider accepted " + queued + (queued === 1 ? " message" : " messages") +
      " but " + (queued === 1 ? "it was" : "they were") +
      " still queued, so no phone received " + (queued === 1 ? "it" : "them") + ".";
  }

  // The same words land in the app, for members who read it there. A picture
  // travels as its link, because the app notice is text.
  const noticeBody = (message ? message.slice(0, 300) : "") + (mediaUrl ? (message ? "\n" : "") + mediaUrl : "");
  await Promise.all(
    batch.map(function (member) {
      return pushNotice(env, { user_id: member.id, title: "From Zeva", body: noticeBody || message.slice(0, 400) });
    })
  );

  return json(200, {
    ok: true,
    audience: audience,
    total: all.length,
    // sent = the provider took it. delivered/queued = what became of the ones
    // that could be checked, which is what the counter actually cares about.
    sent: sent,
    failed: failed,
    delivered: delivered,
    queued: queued,
    checked: checked.length,
    // The shop's own WhatsApp number, left out because a phone cannot message
    // itself — the send the counter tests with is usually this one.
    self_skipped: self.length,
    self_numbers: self.map(function (member) {
      return maskPhone(String((member && member.phone) || "").replace(/\D/g, ""));
    }),
    // Why the ones that failed failed — the admin shows this instead of a
    // bare count, so a dead sender is not mistaken for a bad message.
    reason: reason,
    skipped: Math.max(0, all.length - batch.length),
    // The dashboard keeps its picture until the send is over, and clears it
    // with the text when this comes back set.
    media: mediaUrl || "",
    cap: cap
  });
}

// POST /api/admin/visit — the counter stamps a walk-in member's card by their
// WhatsApp number, so regulars who never booked online still earn spins.
export async function adminAddVisit(env, body) {
  const db = await database(env);
  if (!db) return json(503, { error: "members are not configured" });
  let user = null;
  const userId = String((body && body.user_id) || "").trim();
  if (userId) {
    user = await db.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
  } else {
    const raw = String((body && body.phone) || "").trim();
    const normalized = normalizePhone(env, raw);
    if (normalized) {
      user = await db.prepare("SELECT * FROM users WHERE phone = ?").bind(normalized).first();
    }
    if (!user) {
      const digits = raw.replace(/\D/g, "");
      if (digits) {
        user = await db.prepare("SELECT * FROM users WHERE phone = ?").bind(digits).first();
      }
    }
  }
  if (!user) {
    return json(404, { error: "No member with that number. They need to sign up with WhatsApp first." });
  }
  const added = await recordVisit(env, user.id, null, "walk-in");
  if (!added.added) return stampRefusal(added);
  const state = await memberState(env, user.id);
  const mc = await db.prepare("SELECT code FROM member_codes WHERE user_id = ? AND used_at IS NULL LIMIT 1").bind(user.id).first();
  return json(200, { ok: true, added: true, user: publicUser(user), membership: state, code: String(mc && mc.code || "").toUpperCase() });
}

// POST /api/admin/wallet — the counter puts money into one member's Zeva Money
// once: a goodwill credit, a refund done by hand, or a correction. A negative
// amount takes money back, because a wrong credit has to be fixable the same
// day. One entry is capped so a stray keystroke cannot hand out thousands.
const WALLET_ENTRY_MAX = 5000;

export async function adminWalletCredit(env, body) {
  const db = await database(env);
  if (!db) return json(503, { error: "accounts are not configured" });
  const amount = Math.round(Number((body && body.amount) || 0) * 100) / 100;
  if (!Number.isFinite(amount) || amount === 0) return json(400, { error: "Enter how many rupees to add." });
  if (Math.abs(amount) > WALLET_ENTRY_MAX) {
    return json(400, {
      error: "One entry is capped at " + rupees(WALLET_ENTRY_MAX) + ". Add it in parts if it really is that much."
    });
  }

  let user = null;
  const userId = String((body && body.user_id) || "").trim();
  if (userId) {
    user = await db.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
  } else {
    const raw = String((body && body.phone) || "").trim();
    const normalized = normalizePhone(env, raw);
    if (normalized) user = await db.prepare("SELECT * FROM users WHERE phone = ?").bind(normalized).first();
    if (!user) {
      const digits = raw.replace(/\D/g, "");
      if (digits) user = await db.prepare("SELECT * FROM users WHERE phone = ?").bind(digits).first();
    }
  }
  if (!user) {
    return json(404, { error: "No member with that number. They need to sign up with WhatsApp first." });
  }

  const reason = String((body && body.note) || "").trim().slice(0, 80);
  const note =
    "Zeva Money \u00b7 " + (reason || (amount > 0 ? "added by the counter" : "taken back by the counter"));
  await db
    .prepare("INSERT INTO wallet (user_id, amount, kind, order_id, note, created_at) VALUES (?, ?, 'credit', ?, ?, ?)")
    .bind(user.id, amount, null, note, Date.now())
    .run();

  const balance = await walletBalance(env, user.id);
  // In the app only — a wallet entry the customer never hears about looks like a
  // mistake. This costs no WhatsApp message.
  await pushNotice(env, {
    user_id: user.id,
    title: (amount > 0 ? rupees(amount) + " in Zeva Money" : rupees(Math.abs(amount)) + " taken from Zeva Money"),
    body:
      (reason
        ? reason.replace(/[.\s]+$/, "") + ". "
        : amount > 0
          ? "The counter added it to your wallet. "
          : "The counter corrected your wallet. ") +
      "New balance: " + rupees(balance) + "."
  });

  return json(200, { ok: true, user: publicUser(user), amount: amount, balance: balance, note: note });
}

// POST /api/admin/consume-code — the member types their code at the counter.
// That one typed entry is one stamped visit, the same as a Mark-visit tap.
export async function adminConsumeCode(env, body) {
  const db = await database(env);
  if (!db) return json(503, { error: "members are not configured" });
  const raw = String((body && body.code) || "").trim().toUpperCase();
  if (!raw) return json(400, { error: "which member code?" });
  const row = await db.prepare("SELECT * FROM member_codes WHERE code = ?").bind(raw).first();
  if (!row) return json(404, { error: "no member with that code" });
  if (row.used_at) return json(409, { error: "that code was already used" });
  // Asked before the code is burned: a member stamped earlier today keeps their
  // code for tomorrow instead of losing it to a visit that earns nothing.
  const already = await stampToday(env, row.user_id);
  if (already) return stampRefusal({ reason: "already_today", at: already });
  await db.prepare("UPDATE member_codes SET used_at = ? WHERE id = ?").bind(Date.now(), row.id).run();
  const user = await db.prepare("SELECT * FROM users WHERE id = ?").bind(row.user_id).first();
  if (!user) return json(500, { error: "member vanished" });
  const added = await recordVisit(env, user.id, null, "code");
  if (!added.added) {
    // A stamp landed between the check and the insert; give the code back.
    await db.prepare("UPDATE member_codes SET used_at = NULL WHERE id = ?").bind(row.id).run();
    return stampRefusal(added);
  }
  const state = await memberState(env, user.id);
  return json(200, { ok: true, added: true, user: publicUser(user), membership: state, code: raw });
}

// POST /api/admin/spin — the counter hands over a prize and closes it out.
export async function adminSpinUsed(env, body) {
  const db = await database(env);
  if (!db) return json(503, { error: "members are not configured" });
  const code = String((body && body.code) || "").trim().toUpperCase();
  if (!code) return json(400, { error: "which prize?" });
  const row = await db.prepare("SELECT * FROM spins WHERE code = ?").bind(code).first();
  if (!row) return json(404, { error: "no prize with that code" });
  if (!row.used_at) await db.prepare("UPDATE spins SET used_at = ? WHERE code = ?").bind(Date.now(), code).run();
  const fresh = await db.prepare("SELECT * FROM spins WHERE code = ?").bind(code).first();
  return json(200, { ok: true, spin: shapeSpin(fresh) });
}

/* ------------------------------------------------------------
   Orders
   ------------------------------------------------------------ */

function money(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

export async function createOrder(request, env, body) {
  const db = await database(env);
  if (!db) return json(503, { error: "accounts are not configured" });
  if (!body || !Array.isArray(body.items) || !body.items.length) return json(400, { error: "empty order" });

  const user = await currentUser(request, env);
  const gold = await goldStatus(env, user && user.id);
  const id = String(body.id || "").trim() || String(Date.now());
  const mode = body.mode === "pickup" ? "pickup" : "delivery";
  const distance = Number(body.distance_m || 0) || 0;

  const itemsTotal = money(body.items_total);
  const cgst = money(body.cgst);
  const sgst = money(body.sgst);
  const requestedDelivery = money(body.delivery);
  const freeDelivery = Boolean(gold.active && mode === "delivery" && distance > 0 && distance <= GOLD.freeMetres);
  const delivery = freeDelivery ? 0 : requestedDelivery;
  const billTotal = money(itemsTotal + cgst + sgst + delivery + money(body.tip));
  const now = Date.now();

  const existing = await db.prepare("SELECT id FROM orders WHERE id = ?").bind(id).first();
  if (existing) return json(409, { error: "duplicate order" });

  // The order and its Zeva Money spend go in one batch. The spend itself is a
  // single INSERT ... SELECT that reads the live balance and writes the debit at
  // the same time, so two orders placed together cannot both spend the same
  // rupees: whichever statement runs second sees the first one's row and stops
  // at zero. The order starts at the full bill and is cut down afterwards from
  // whatever the database actually debited, never from a balance read earlier.
  const statements = [
    db
      .prepare(
        "INSERT INTO orders (id, user_id, name, phone, address, note, mode, payment, items, items_total, cgst, sgst, delivery, total, wallet_redeemed, distance_m, status, gold_delivery, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)"
      )
      .bind(
        id,
        (user && user.id) || null,
        String(body.name || "").slice(0, 80),
        String(body.phone || "").slice(0, 20),
        String(body.address || "").slice(0, 400),
        String(body.note || "").slice(0, 400),
        mode,
        body.payment === "upi" ? "upi" : "cash",
        JSON.stringify(body.items).slice(0, 8000),
        itemsTotal,
        cgst,
        sgst,
        delivery,
        billTotal,
        Math.round(distance),
        "pending",
        freeDelivery ? 1 : 0,
        now
      )
  ];
  if (user) {
    const balanceNow = "COALESCE((SELECT SUM(w0.amount) FROM wallet w0 WHERE w0.user_id = ?), 0)";
    statements.push(
      db
        .prepare(
          "INSERT INTO wallet (user_id, amount, kind, order_id, note, created_at) " +
            "SELECT ?, -MIN(?, MAX(" + balanceNow + ", 0)), 'redeem', ?, ?, ? " +
            "WHERE MIN(?, MAX(" + balanceNow + ", 0)) > 0"
        )
        .bind(user.id, billTotal, user.id, id, "Zeva Money redeemed \u00b7 #" + id, now, billTotal, user.id),
      db
        .prepare(
          "UPDATE orders SET wallet_redeemed = -COALESCE((SELECT SUM(amount) FROM wallet WHERE user_id = ? AND order_id = ? AND kind = 'redeem'), 0), " +
            "total = ? + COALESCE((SELECT SUM(amount) FROM wallet WHERE user_id = ? AND order_id = ? AND kind = 'redeem'), 0) " +
            "WHERE id = ?"
        )
        .bind(user.id, id, billTotal, user.id, id, id)
    );
  }
  await db.batch(statements);

  const written = await db.prepare("SELECT total, wallet_redeemed FROM orders WHERE id = ?").bind(id).first();
  const total = money(written && written.total);
  const walletRedeemed = money(written && written.wallet_redeemed);

  // Keep the delivery address on the profile so the next order is one tap.
  const orderAddress = String(body.address || "").slice(0, 400);
  if (user && orderAddress && !user.address && mode === "delivery") {
    await db.prepare("UPDATE users SET address = ? WHERE id = ?").bind(orderAddress, user.id).run();
  }

  // Zeva Money is credited when the order is marked delivered, not now.
  const cashbackDue = user && gold.active && itemsTotal > 0 ? GOLD.cashback : 0;

  return json(200, {
    ok: true,
    id: id,
    total: total,
    delivery: delivery,
    free_delivery: freeDelivery,
    cashback_due: cashbackDue,
    wallet_redeemed: walletRedeemed,
    wallet_balance: user ? await walletBalance(env, user.id) : 0
  });
}

const ORDER_FIELDS =
  "id, user_id, name, phone, address, note, mode, payment, items, items_total, cgst, sgst, delivery, total, wallet_redeemed, distance_m, status, gold_delivery, created_at, upi_ref, upi_url, upi_intent, upi_status, upi_utr, upi_amount, upi_seq, upi_attempts, upi_checked_at, upi_paid_at";

export function shapeOrder(row) {
  if (!row) return null;
  let items = [];
  try {
    items = JSON.parse(row.items || "[]");
  } catch (error) {
    items = [];
  }
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    address: row.address,
    note: row.note,
    mode: row.mode,
    payment: row.payment,
    items: items,
    items_total: row.items_total,
    cgst: row.cgst,
    sgst: row.sgst,
    delivery: row.delivery,
    total: row.total,
    wallet_redeemed: Number(row.wallet_redeemed || 0),
    distance_m: row.distance_m,
    status: row.status,
    user_id: row.user_id || null,
    gold_delivery: Boolean(row.gold_delivery),
    created_at: row.created_at,
    // Only present once an online UPI payment was opened for this order.
    upi_status: row.upi_status || null,
    upi_amount: Number(row.upi_amount || 0),
    upi_utr: row.upi_utr || null,
    upi_paid_at: row.upi_paid_at || null
  };
}

export async function myOrders(env, userId, limit) {
  const db = await database(env);
  if (!db || !userId) return [];
  const rows = await db
    .prepare("SELECT " + ORDER_FIELDS + " FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
    .bind(userId, limit || 20)
    .all();
  return (rows.results || []).map(shapeOrder);
}

/* ------------------------------------------------------------
   Online UPI payments
   ------------------------------------------------------------
   Zeva's Worker is the merchant here; the money moves through the
   self-hosted gateway in ./upi.js. Two rules keep that honest:
     - the amount comes from the orders row, never from the browser;
     - an order is marked paid only by a verified signed webhook or
       by reading the status straight from the gateway. "I paid" from
       the phone is a prompt to check, never proof.
   With no gateway secrets set, everything here answers 503 and
   /api/config reports upi:false, so the app shows nothing new. */

const UPI_REPOLL_MS = 4000;

const PAY_ORDER_FIELDS =
  "id, user_id, name, phone, mode, payment, total, status, upi_ref, upi_url, upi_intent, upi_status, upi_utr, upi_amount, upi_seq, upi_attempts, upi_checked_at";

// Amounts the gateway understands: rupees with at most two decimals.
function rupees(value) {
  return "\u20b9" + (Math.round(Number(value || 0) * 100) / 100).toLocaleString("en-IN");
}

async function payableOrder(env, id) {
  const db = await database(env);
  if (!db) return { db: null, order: null };
  const order = await db
    .prepare("SELECT " + PAY_ORDER_FIELDS + " FROM orders WHERE id = ?")
    .bind(String(id || "").trim())
    .first();
  return { db: db, order: order || null };
}

// POST /api/upi/pay {id} — open (or re-open) a payment for one order and hand
// the app the gateway's hosted page plus the direct UPI intent.
export async function startUpiPayment(request, env, body) {
  if (!onlineUpi(env)) return json(503, { error: "online UPI is switched off" });
  const found = await payableOrder(env, body && body.id);
  if (!found.db) return json(503, { error: "accounts are not configured" });
  const order = found.order;
  if (!order) return json(404, { error: "unknown order" });
  if (order.payment !== "upi") return json(400, { error: "this order is set to cash" });

  if (order.upi_status === "paid") {
    return json(200, { ok: true, paid: true, status: "paid", url: order.upi_url || "", intent: order.upi_intent || "", amount: Number(order.upi_amount || order.total) });
  }

  // Direct mode: no provider page to open, just the shop's own UPI ID with this
  // order's amount already filled in. Rebuilt on every open — it never expires.
  // It is checked before the gateway on purpose: the customer must pay the VPA
  // in UPI_ID, so a site that has one never routes money anywhere else.
  if (directReady(env)) {
    const direct = directPayment(env, order);
    if (!direct.ok) return json(direct.status || 502, { error: direct.error });
    const pay = direct.payment;
    await found.db
      .prepare("UPDATE orders SET upi_url = '', upi_intent = ?, upi_status = 'pending', upi_amount = ?, upi_checked_at = ? WHERE id = ?")
      .bind(pay.intent, pay.amount, Date.now(), order.id)
      .run();
    return json(200, {
      ok: true,
      paid: false,
      status: "pending",
      mode: "direct",
      url: "",
      intent: pay.intent,
      amount: pay.amount,
      vpa: pay.vpa,
      payee: pay.payee
    });
  }

  // A live payment link is reused: the gateway only accepts one client order
  // id, and a customer who reopens the screen must get the same ₹ amount.
  if (order.upi_status === "pending" && order.upi_url) {
    return json(200, { ok: true, paid: false, status: "pending", url: order.upi_url, intent: order.upi_intent || "", amount: Number(order.upi_amount || order.total) });
  }

  const attempt = Number(order.upi_attempts || 0) + 1;
  const result = await openPayment(env, order, attempt);
  if (!result.ok) {
    console.error("[upi] order=" + order.id + " create failed: " + result.error);
    return json(result.status || 502, { error: result.error });
  }
  const pay = result.payment;
  await found.db
    .prepare(
      "UPDATE orders SET upi_ref = ?, upi_url = ?, upi_intent = ?, upi_status = ?, upi_amount = ?, upi_attempts = ?, upi_checked_at = ? WHERE id = ?"
    )
    .bind(pay.ref, pay.url, pay.intent, pay.status === "paid" ? "paid" : "pending", pay.amount || Number(order.total || 0), attempt, Date.now(), order.id)
    .run();
  if (pay.status === "paid") await markUpiPaid(found.db, env, order, pay);
  return json(200, {
    ok: true,
    paid: pay.status === "paid",
    status: pay.status,
    mode: "gateway",
    url: pay.url,
    intent: pay.intent,
    amount: pay.amount || Number(order.total || 0),
    expires_at: pay.expires_at,
    test: pay.test
  });
}

// GET /api/upi/status?id= — what the phone polls while the customer is in
// their UPI app. The gateway is asked at most once every few seconds, so ten
// open tabs cost the same as one.
export async function upiPaymentStatus(env, id) {
  const found = await payableOrder(env, id);
  if (!found.db) return json(503, { error: "accounts are not configured" });
  const order = found.order;
  if (!order) return json(404, { error: "unknown order" });
  // Direct-mode orders never have a gateway reference: the counter's dashboard
  // is the only thing that can move them to paid, so there is nothing to poll.
  if (!order.upi_ref) {
    return json(200, { ok: true, status: order.upi_status || "none", url: order.upi_url || "", intent: order.upi_intent || "" });
  }
  if (order.upi_status === "paid") {
    return json(200, { ok: true, status: "paid", utr: order.upi_utr || "", amount: Number(order.upi_amount || order.total) });
  }
  const fresh = order.upi_checked_at && Date.now() - Number(order.upi_checked_at) < UPI_REPOLL_MS;
  if (fresh || !upiReady(env)) {
    return json(200, { ok: true, status: order.upi_status || "pending", url: order.upi_url || "", intent: order.upi_intent || "" });
  }

  const result = await pollPayment(env, order.upi_ref);
  const now = Date.now();
  if (!result.ok) {
    await found.db.prepare("UPDATE orders SET upi_checked_at = ? WHERE id = ?").bind(now, order.id).run();
    return json(200, { ok: true, status: order.upi_status || "pending", url: order.upi_url || "", stale: true });
  }
  const pay = result.payment;
  if (pay.status === "paid") {
    const done = await markUpiPaid(found.db, env, order, pay);
    return json(200, { ok: true, status: done.mismatch ? "mismatch" : "paid", utr: pay.utr || "", amount: pay.amount });
  }
  const status = pay.status === "review" ? "review" : pay.status === "expired" ? "expired" : pay.status === "failed" ? "expired" : "pending";
  await found.db.prepare("UPDATE orders SET upi_status = ?, upi_checked_at = ? WHERE id = ?").bind(status, now, order.id).run();
  return json(200, { ok: true, status: status, url: order.upi_url || "", intent: order.upi_intent || "" });
}

// One place applies "money arrived", whether the news came from a webhook or
// from a status poll, so the notice cannot be sent twice.
async function markUpiPaid(db, env, order, payment) {
  const paid = Number(payment && payment.amount ? payment.amount : order.upi_amount || order.total || 0);
  const due = Number(order.total || 0);
  const utr = String((payment && payment.utr) || "");
  const now = Date.now();

  if (Math.abs(paid - due) > 0.01) {
    // A mismatch is not a payment: clear any earlier paid stamp, otherwise the
    // card would show a "paid at" time next to money we have not counted.
    await db
      .prepare("UPDATE orders SET upi_status = 'mismatch', upi_amount = ?, upi_utr = ?, upi_paid_at = NULL, upi_checked_at = ? WHERE id = ?")
      .bind(paid, utr, now, order.id)
      .run();
    if (order.user_id) {
      await pushNotice(env, {
        user_id: order.user_id,
        title: "#" + order.id + " \u00b7 payment needs a check",
        body: rupees(paid) + " arrived against an order of " + rupees(due) + ". The counter is checking it before the kitchen starts.",
        order_id: order.id
      });
    }
    return { paid: false, mismatch: true };
  }

  const current = await db.prepare("SELECT upi_status FROM orders WHERE id = ?").bind(order.id).first();
  if (current && current.upi_status === "paid") return { paid: true, mismatch: false };

  await db
    .prepare("UPDATE orders SET upi_status = 'paid', upi_utr = ?, upi_amount = ?, upi_paid_at = ?, upi_checked_at = ? WHERE id = ?")
    .bind(utr, paid, now, now, order.id)
    .run();
  if (order.user_id) {
    await pushNotice(env, {
      user_id: order.user_id,
      title: "#" + order.id + " \u00b7 payment received",
      body: rupees(paid) + " reached us by UPI. The counter still has to accept the order before the kitchen starts.",
      order_id: order.id
    });
  }
  return { paid: true, mismatch: false };
}

// The counter's side of direct-mode UPI: nobody but the restaurant can say the
// money arrived, so staff confirm it here after checking the UPI app or the
// bank SMS. Opening the payment again never needs this — only the confirmation.
export async function adminSetUpiPaid(env, body) {
  const db = await database(env);
  if (!db) return json(503, { error: "accounts are not configured" });
  const id = String((body && body.id) || "").trim();
  if (!id) return json(400, { error: "bad request" });
  const order = await db.prepare("SELECT " + PAY_ORDER_FIELDS + " FROM orders WHERE id = ?").bind(id).first();
  if (!order) return json(404, { error: "unknown order" });
  if (order.payment !== "upi") return json(400, { error: "this order is set to cash" });

  if (body && body.paid === false) {
    await db
      .prepare("UPDATE orders SET upi_status = 'pending', upi_paid_at = NULL, upi_utr = '', upi_checked_at = ? WHERE id = ?")
      .bind(Date.now(), id)
      .run();
    return json(200, { ok: true, id: id, status: "pending" });
  }

  const amount = Number((body && body.amount) || order.upi_amount || order.total || 0);
  const result = await markUpiPaid(db, env, order, { amount: amount, utr: String((body && body.utr) || "") });
  return json(200, { ok: true, id: id, status: result.mismatch ? "mismatch" : "paid", mismatch: Boolean(result.mismatch) });
}

async function findPaymentOrder(db, clientId, reference) {
  let row = null;
  if (reference) row = await db.prepare("SELECT " + PAY_ORDER_FIELDS + " FROM orders WHERE upi_ref = ?").bind(reference).first();
  if (!row && clientId) row = await db.prepare("SELECT " + PAY_ORDER_FIELDS + " FROM orders WHERE id = ?").bind(clientId).first();
  if (!row && clientId) {
    const base = clientId.replace(/-r\d+$/, "");
    if (base !== clientId) row = await db.prepare("SELECT " + PAY_ORDER_FIELDS + " FROM orders WHERE id = ?").bind(base).first();
  }
  return row || null;
}

// Returns true when this event id is new, false when we have already applied it.
async function recordUpiEvent(db, eventId, kind, orderId, sequence, amount) {
  if (!eventId) return true;
  const result = await db
    .prepare("INSERT OR IGNORE INTO upi_events (event_id, event, order_id, sequence, amount, received_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(eventId, kind, orderId, sequence, amount, Date.now())
    .run();
  return !result || !result.meta || Number(result.meta.changes || 0) > 0;
}

// POST /api/upi/webhook — the gateway's signed notification. Deliberately not
// same-origin: it is a server-to-server call, so the HMAC signature is the
// whole authentication. Every accepted delivery answers 200 so the gateway
// stops retrying; a bad signature answers 401 and changes nothing.
export async function upiWebhook(request, env) {
  const raw = await request.text();
  const check = await verifyWebhook(env, raw, request.headers.get("x-signature"));
  if (!check.ok) {
    console.warn("[upi] rejected webhook: " + check.error);
    return json(check.code || 401, { error: check.error });
  }
  let event;
  try {
    event = JSON.parse(raw);
  } catch (error) {
    return json(400, { error: "bad json" });
  }
  const db = await database(env);
  if (!db) return json(503, { error: "accounts are not configured" });

  const kind = String((event && event.event) || "");
  const data = (event && event.data) || {};
  const eventId = String((event && event.event_id) || "");
  const sequence = Number((event && event.event_sequence) || 0);
  const amount = Number(data.amount || 0);
  const order = await findPaymentOrder(db, String(data.client_order_id || ""), String(data.order_id || ""));

  if (!order) {
    await recordUpiEvent(db, eventId, kind, String(data.client_order_id || data.order_id || ""), sequence, amount);
    console.warn("[upi] webhook for an order we do not have: " + (data.client_order_id || data.order_id || "?"));
    return json(200, { ok: true, ignored: "unknown order" });
  }
  if (!(await recordUpiEvent(db, eventId, kind, order.id, sequence, amount))) {
    return json(200, { ok: true, duplicate: true });
  }

  if (kind === "order.paid") {
    // A paid event is final: it must apply even if an expiry arrived first.
    const result = await markUpiPaid(db, env, order, { amount: amount || order.total, utr: String(data.utr || "") });
    return json(200, { ok: true, paid: result.paid, mismatch: Boolean(result.mismatch) });
  }

  if (kind === "order.expired" || kind === "order.failed" || kind === "order.timeout") {
    if (order.upi_status === "paid") return json(200, { ok: true, ignored: "already paid" });
    // Older events must not overwrite newer state for the same order.
    if (sequence && sequence <= Number(order.upi_seq || 0)) return json(200, { ok: true, ignored: "stale sequence" });
    await db.prepare("UPDATE orders SET upi_status = 'expired', upi_seq = ?, upi_checked_at = ? WHERE id = ?").bind(sequence, Date.now(), order.id).run();
    return json(200, { ok: true, status: "expired" });
  }

  if (kind === "order.under_review") {
    if (order.upi_status === "paid") return json(200, { ok: true, ignored: "already paid" });
    if (sequence && sequence <= Number(order.upi_seq || 0)) return json(200, { ok: true, ignored: "stale sequence" });
    await db.prepare("UPDATE orders SET upi_status = 'review', upi_seq = ?, upi_checked_at = ? WHERE id = ?").bind(sequence, Date.now(), order.id).run();
    if (order.user_id) {
      await pushNotice(env, {
        user_id: order.user_id,
        title: "#" + order.id + " \u00b7 payment under review",
        body: "Your UPI payment is being checked by the bank. The counter will confirm the order once it clears.",
        order_id: order.id
      });
    }
    return json(200, { ok: true, status: "review" });
  }

  return json(200, { ok: true, ignored: kind || "unknown event" });
}

/* ------------------------------------------------------------
   Wallet + Gold for the customer
   ------------------------------------------------------------ */

export async function profilePayload(request, env) {
  const user = await currentUser(request, env);
  const gold = await goldStatus(env, user && user.id);
  const achievements = await achievementState(env, user && user.id, gold);
  const entries = user
    ? (await (await database(env))
        .prepare("SELECT id, amount, kind, order_id, note, created_at FROM wallet WHERE user_id = ? ORDER BY created_at DESC LIMIT 30")
        .bind(user.id)
        .all()).results || []
    : [];
  return {
    user: publicUser(user),
    signed_in: Boolean(user),
    google: googleReady(env),
    whatsapp: whatsappReady(env),
    upi: onlineUpi(env),
    upi_mode: upiMode(env),
    dev: env.ZEVA_DEV_LOGIN === "1",
    gold: gold,
    gold_plan: GOLD,
    wallet: {
      balance: user ? await walletBalance(env, user.id) : 0,
      entries: entries
    },
    orders: await myOrders(env, user && user.id, 20),
    achievements: achievements,
    notices: (await myNotices(env, user && user.id, 0)).last
  };
}

/* ------------------------------------------------------------
   Achievement cards
   ------------------------------------------------------------
   A card is earned by delivered orders, never by spent rupees, so
   a cancelled order leaves no card behind. Only the count matters,
   which means the state can be recomputed on every request instead
   of being stored. */

export async function deliveredCount(env, userId) {
  if (!userId) return 0;
  const db = await database(env);
  if (!db) return 0;
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM orders WHERE user_id = ? AND status = 'done'")
    .bind(userId)
    .first();
  return Number((row && row.n) || 0);
}

function cardState(orders, gold) {
  let tier = null;
  let next = null;
  const cards = CARDS.map(function (card) {
    const unlocked = orders >= card.orders;
    if (unlocked) tier = card.key;
    else if (!next) next = card;
    return {
      key: card.key,
      name: card.name,
      orders: card.orders,
      unlocked: unlocked,
      remaining: Math.max(0, card.orders - orders)
    };
  });
  return {
    orders_done: orders,
    tier: tier,
    member: Boolean(gold && gold.active),
    next: next
      ? { key: next.key, name: next.name, orders: next.orders, remaining: Math.max(0, next.orders - orders) }
      : null,
    cards: cards
  };
}

export async function achievementState(env, userId, gold) {
  return cardState(await deliveredCount(env, userId), gold);
}

export async function joinGold(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json(401, { error: "sign in first" });
  const db = await database(env);
  const current = await goldStatus(env, user.id);
  if (current.status === "active") return json(200, { ok: true, gold: current });
  const now = Date.now();
  const row = await db.prepare("SELECT user_id FROM gold WHERE user_id = ?").bind(user.id).first();
  if (row) {
    await db.prepare("UPDATE gold SET status = 'pending', requested_at = ? WHERE user_id = ?").bind(now, user.id).run();
  } else {
    await db.prepare("INSERT INTO gold (user_id, status, requested_at) VALUES (?, 'pending', ?)").bind(user.id, now).run();
  }
  return json(200, { ok: true, gold: { status: "pending", requested_at: now } });
}

export async function updateProfile(request, env, body) {
  const user = await currentUser(request, env);
  if (!user) return json(401, { error: "sign in first" });
  const db = await database(env);
  // A form that only carries a photo must not wipe the rest of the profile, so
  // every field falls back to what is already stored.
  const rawPhone = body && body.phone !== undefined ? body.phone : user.phone;
  const phone = String(rawPhone || "").replace(/[^\d+]/g, "").slice(0, 16);
  const name = String((body && body.name) || user.name || "").slice(0, 80);
  const address = String((body && body.address !== undefined ? body.address : user.address) || "").slice(0, 400);

  let picture = user.picture || "";
  if (body && body.picture !== undefined) {
    const raw = String(body.picture || "").trim();
    if (!raw) {
      picture = "";
    } else if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(raw)) {
      return json(400, { error: "Send the photo as a JPEG or PNG image." });
    } else if (raw.length > 200000) {
      return json(413, { error: "That photo is too large. Try a smaller one." });
    } else {
      picture = raw;
    }
  }

  await db.prepare("UPDATE users SET phone = ?, name = ?, address = ?, picture = ? WHERE id = ?")
    .bind(phone, name, address, picture, user.id)
    .run();
  return json(200, { ok: true, user: publicUser({ ...user, phone: phone, name: name, address: address, picture: picture }) });
}

/* ------------------------------------------------------------
   Admin
   ------------------------------------------------------------ */

/* The members list has a short pin of its own, so a tablet behind the counter
   can open it without the dashboard's longer passcode. It is not the dashboard:
   a pin session reaches only the five routes /members calls. Override the pin
   with MEMBERS_PASSCODE in Sites → Secrets. */
const MEMBERS_PIN = "988051";
const MEMBER_PAGE_ROUTES = [
  "/api/admin/members",
  "/api/admin/visit",
  "/api/admin/wallet",
  "/api/admin/notify",
  "/api/admin/spin"
];

function membersPin(env) {
  return String(env.MEMBERS_PASSCODE || MEMBERS_PIN);
}

export async function adminGate(request, env) {
  const token = cookies(request).zeva_admin;
  if (!token) return false;
  const payload = await unseal(env, token);
  return Boolean(payload && payload.role === "admin");
}

/* "admin" for the dashboard passcode, "members" for the members pin, "" for
   neither — so one cookie can be worth less than the other. */
export async function staffRole(request, env) {
  const token = cookies(request).zeva_admin;
  if (!token) return "";
  const payload = await unseal(env, token);
  const role = payload && payload.role;
  if (role === "admin" || role === "members") return role;
  return "";
}

async function passMatches(env, pass, expected) {
  if (!pass || !expected) return false;
  const a = b64u(await hmac(secretFor(env), pass));
  const b = b64u(await hmac(secretFor(env), String(expected)));
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < Math.min(a.length, b.length); i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function adminLogin(request, env, body) {
  if (!env.ADMIN_PASSCODE) return json(503, { error: "admin dashboard is not configured" });
  if (!sameOrigin(request, env)) return json(403, { error: "cross-origin request" });
  const pass = String((body && body.passcode) || "").trim();
  let role = "";
  if (await passMatches(env, pass, env.ADMIN_PASSCODE)) role = "admin";
  else if (await passMatches(env, pass, membersPin(env))) role = "members";
  if (!role) return json(401, { error: "wrong passcode" });
  const token = await sign(env, { role: role, exp: Date.now() + 30 * 86400000 });
  return json(200, { ok: true, role: role }, { "set-cookie": cookieHeader("zeva_admin", token, 30 * 86400) });
}

export async function adminOrders(env, after) {
  const db = await database(env);
  if (!db) return json(503, { error: "accounts are not configured" });
  const since = Number(after || 0);
  const rows = since
    ? await db.prepare("SELECT " + ORDER_FIELDS + " FROM orders WHERE created_at > ? ORDER BY created_at ASC LIMIT 60").bind(since).all()
    : await db.prepare("SELECT " + ORDER_FIELDS + " FROM orders ORDER BY created_at DESC LIMIT 60").all();
  const live = await db
    .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS sum FROM orders WHERE status IN ('pending','preparing','out')")
    .first();
  // Today's sales is food + GST only: the delivery fee we collect goes to the
  // rider, so it is not revenue. Cancelled orders never brought money in, so
  // they are left out of the figure (today_orders still counts every order
  // placed today, cancelled ones included).
  const today = await db
    .prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 0 ELSE items_total + cgst + sgst END), 0) AS sum FROM orders WHERE created_at > ?"
    )
    .bind(startOfDay())
    .first();
  const goldPending = await db.prepare("SELECT COUNT(*) AS n FROM gold WHERE status = 'pending'").first();
  return json(200, {
    orders: (rows.results || []).map(shapeOrder),
    stats: {
      live_orders: Number((live && live.n) || 0),
      live_value: money((live && live.sum) || 0),
      today_orders: Number((today && today.n) || 0),
      today_value: money((today && today.sum) || 0),
      gold_pending: Number((goldPending && goldPending.n) || 0),
      newest: ((rows.results || [])[rows.results.length - 1] || {}).created_at || since
    }
  });
}

function startOfDay() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

// pending -> preparing -> out -> done, plus cancelled. The counter's Accept
// button is what turns a customer's "pending confirmation" into a live order.
export const ORDER_STATUSES = ["pending", "preparing", "out", "done", "cancelled"];

const STATUS_NOTICE = {
  pending: ["Order received", "Waiting for the counter to accept it."],
  preparing: ["Order accepted", "The kitchen has your order and is on it."],
  out: ["Out for delivery", "Your order just left Zeva Mandi & Grills."],
  done: ["Order delivered", "Enjoy. Any Zeva Money cashback is in your account."],
  cancelled: ["Order cancelled", "This order was cancelled. Nothing was charged."]
};

/* ------------------------------------------------------------
   The counter's two copies
   ------------------------------------------------------------
   Accepting an order is what sets a delivery going, so that tap is
   also what prints: a ticket to the kitchen (quantities, no money)
   and the customer's bill at the counter. Both leave through the
   local print bridge, because the site runs in a data centre and the
   printers sit in the restaurant (see printer-bridge.js).

     PRINT_BRIDGE_URL       e.g. https://xxxx.trycloudflare.com/print
     PRINT_BRIDGE_TOKEN     optional shared secret, sent as x-print-token
     PRINT_PRINTER          bill queue, default BILL
     PRINT_KITCHEN_PRINTER  kitchen queue, default KITCHEN */

function printBridge(env) {
  const raw = String(env.PRINT_BRIDGE_URL || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (!url.pathname || url.pathname === "/") url.pathname = "/print";
    return url.toString();
  } catch (error) {
    return raw;
  }
}

async function printCopy(env, order, kind) {
  // The queue name is optional here on purpose: the kind already tells the
  // bridge which of its two printers to use, so the name can be set either in
  // Sites (below) or in the bridge's own environment, and the bridge wins.
  const override = kind === "kitchen"
    ? String(env.PRINT_KITCHEN_PRINTER || "").trim()
    : String(env.PRINT_BILL_PRINTER || "").trim();
  const label = override || (kind === "kitchen" ? "kitchen printer" : "bill printer");
  const bridge = printBridge(env);
  if (!bridge) return { ok: false, kind: kind, printer: label, error: "printer bridge not configured" };
  const headers = { "content-type": "application/json" };
  if (env.PRINT_BRIDGE_TOKEN) headers["x-print-token"] = String(env.PRINT_BRIDGE_TOKEN);
  try {
    const response = await fetch(bridge, {
      method: "POST",
      headers: headers,
      body: JSON.stringify({ id: order.id, kind: kind, printer: override, order: order })
    });
    const data = await response.json().catch(function () { return {}; });
    if (!response.ok || !(data && data.ok)) {
      return { ok: false, kind: kind, printer: label, error: (data && data.error) || "printer bridge error " + response.status };
    }
    return { ok: true, kind: kind, printer: data.printer || label };
  } catch (error) {
    return { ok: false, kind: kind, printer: label, error: "printer bridge unreachable: " + error.message };
  }
}

// Two jobs, one after the other: a queued ticket is useless if the bill never
// follows, so the answer says exactly which copy failed and why.
async function printOrderCopies(env, order) {
  if (!order || !Array.isArray(order.items) || !order.items.length) {
    return {
      kitchen: { ok: false, printer: "", error: "this order has no items" },
      bill: { ok: false, printer: "", error: "this order has no items" }
    };
  }
  const copy = Object.assign({}, order, {
    date: order.created_at ? new Date(order.created_at).toISOString() : new Date().toISOString(),
    pay: order.payment === "upi" ? (order.upi_status === "paid" ? "UPI PAID" : "UPI") : "cash"
  });
  return { kitchen: await printCopy(env, copy, "kitchen"), bill: await printCopy(env, copy, "bill") };
}

export async function adminSetStatus(env, body) {
  const db = await database(env);
  const id = String((body && body.id) || "");
  let status = String((body && body.status) || "");
  if (status === "new") status = "pending";
  if (status === "ready") status = "out";
  if (!id || ORDER_STATUSES.indexOf(status) < 0) {
    return json(400, { error: "bad request" });
  }
  const order = await db.prepare("SELECT " + ORDER_FIELDS + " FROM orders WHERE id = ?").bind(id).first();
  if (!order) return json(404, { error: "unknown order" });
  const before = order.status;
  await db.prepare("UPDATE orders SET status = ?, updated_at = ? WHERE id = ?").bind(status, Date.now(), id).run();

  // Only the first acceptance prints. Reopening an order and accepting it
  // again would otherwise leave the counter with a third copy of the bill.
  let print = null;
  if (status === "preparing" && before !== "preparing") {
    print = await printOrderCopies(env, shapeOrder(order));
  }

  let credited = 0;
  let earned = null;
  if (status === "done" && order.user_id) {
    // Cashback lands in Zeva Money only once the food is in the customer's hands.
    const already = await db
      .prepare("SELECT COALESCE(SUM(amount), 0) AS sum FROM wallet WHERE user_id = ? AND order_id = ? AND kind = 'cashback'")
      .bind(order.user_id, id)
      .first();
    const gold = await goldStatus(env, order.user_id);
    if (gold.active && Number((already && already.sum) || 0) === 0 && Number(order.items_total || 0) > 0) {
      credited = GOLD.cashback;
      await db
        .prepare("INSERT INTO wallet (user_id, amount, kind, order_id, note, created_at) VALUES (?, ?, 'cashback', ?, ?, ?)")
        .bind(order.user_id, credited, id, "Zeva Money cashback · #" + id, Date.now())
        .run();
    }
    // A Gold member's achievement card can only be earned on delivery, so the
    // milestone is checked here and folded into the same notification.
    if (gold.active) earned = await newCardFor(env, order.user_id);
  }

  if (order.user_id && STATUS_NOTICE[status]) {
    const text = STATUS_NOTICE[status];
    const title = order.mode === "pickup" && status === "out" ? "Ready for pickup" : text[0];
    const line = order.mode === "pickup" && status === "out" ? "Your order is packed and waiting at the counter." : text[1];
    await pushNotice(env, {
      user_id: order.user_id,
      title: earned ? "#" + id + " \u00b7 " + earned.name + " card unlocked" : "#" + id + " \u00b7 " + title,
      body:
        line +
        (credited ? " +\u20b9" + credited + " in Zeva Money." : "") +
        (earned
          ? " You crossed " + earned.orders + " delivered orders \u2014 your " + earned.name + " card is in the You tab."
          : ""),
      order_id: id
    });
  }

  if (status === "cancelled" && order.user_id) {
    const credit = await db
      .prepare("SELECT COALESCE(SUM(amount), 0) AS sum FROM wallet WHERE user_id = ? AND order_id = ? AND kind = 'cashback'")
      .bind(order.user_id, id)
      .first();
    if (Number((credit && credit.sum) || 0) > 0) {
      await db
        .prepare("INSERT INTO wallet (user_id, amount, kind, order_id, note, created_at) VALUES (?, ?, 'reversal', ?, ?, ?)")
        .bind(order.user_id, -Math.abs(Number(credit.sum)), id, "Cashback reversed (order cancelled)", Date.now())
        .run();
    }
    // Money the customer spent from Zeva Money comes back if the order never
    // happens, exactly once (a second cancel finds the row already refunded).
    const spent = await db
      .prepare("SELECT COALESCE(SUM(amount), 0) AS sum FROM wallet WHERE user_id = ? AND order_id = ? AND kind = 'redeem'")
      .bind(order.user_id, id)
      .first();
    const refunded = await db
      .prepare("SELECT COALESCE(SUM(amount), 0) AS sum FROM wallet WHERE user_id = ? AND order_id = ? AND kind = 'refund'")
      .bind(order.user_id, id)
      .first();
    const back = -1 * (Number((spent && spent.sum) || 0) + Number((refunded && refunded.sum) || 0));
    if (back > 0.004) {
      await db
        .prepare("INSERT INTO wallet (user_id, amount, kind, order_id, note, created_at) VALUES (?, ?, 'refund', ?, ?, ?)")
        .bind(order.user_id, back, id, "Zeva Money returned (order cancelled) \u00b7 #" + id, Date.now())
        .run();
    }
  }
  return json(200, {
    ok: true,
    id: id,
    status: status,
    cashback: credited,
    card: earned && earned.key,
    print: print
  });
}

// Staff asked for the two copies again: a jammed roll, a printer that was off,
// or a paper-out halfway through the bill.
export async function adminReprint(env, body) {
  const db = await database(env);
  const id = String((body && body.id) || "");
  if (!id) return json(400, { error: "bad request" });
  const row = await db.prepare("SELECT " + ORDER_FIELDS + " FROM orders WHERE id = ?").bind(id).first();
  if (!row) return json(404, { error: "unknown order" });
  const print = await printOrderCopies(env, shapeOrder(row));
  return json(200, { ok: true, id: id, print: print });
}

// Returns the achievement card this delivery unlocked, or null when the count
// stayed inside the tier the customer already had.
export async function newCardFor(env, userId) {
  if (!userId) return null;
  const orders = await deliveredCount(env, userId);
  const now = cardState(orders, { active: true }).tier;
  const before = cardState(orders - 1, { active: true }).tier;
  if (!now || now === before) return null;
  for (const card of CARDS) if (card.key === now) return card;
  return null;
}

/* ------------------------------------------------------------
   Notices — the counter's messages, delivered into the app
   ------------------------------------------------------------
   Rows land in D1; the phone polls /api/notices and raises a
   system notification. Nothing here needs push credentials. */

export async function pushNotice(env, notice) {
  const db = await database(env);
  if (!db) return null;
  const title = String((notice && notice.title) || "Zeva").slice(0, 90);
  const body = String((notice && notice.body) || "").slice(0, 400);
  const userId = (notice && notice.user_id) || null;
  const orderId = (notice && notice.order_id) || null;
  const result = await db
    .prepare("INSERT INTO notices (user_id, title, body, order_id, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(userId, title, body, orderId, Date.now())
    .run();
  return { ok: true, id: (result && result.meta && result.meta.last_row_id) || null };
}

/* One message from the counter to one customer's phone. The app notice is
   still written, because the same words are useful there, but WhatsApp is what
   the customer actually reads. A customer with no number on file is not an
   error: they simply only get the notice in the app. */
async function sendPhoneNoticeToUser(env, userId, title, body, orderId) {
  const db = await database(env);
  if (!db) return "not configured";
  const user = await db.prepare("SELECT phone FROM users WHERE id = ?").bind(userId).first();
  const phone = String((user && user.phone) || "").replace(/\D/g, "");
  if (!phone) return "no number";
  if (!whatsappReady(env)) return "not configured";
  const message = phoneNoticeText(title, body, orderId);
  return (await whatsappText(env, phone, message)) ? "sent" : "failed";
}

function phoneNoticeText(title, body, orderId) {
  return (
    String(title || "Zeva").slice(0, 80) +
    (body ? "\n" + String(body).slice(0, 500) : "") +
    (orderId ? "\n#" + orderId : "") +
    "\n\n" +
    MARKETING_SHIELD
  );
}

/* The same notice to every customer who has a number. Capped exactly like
   marketing, because the provider's plan is metered per message. */
async function sendPhoneNoticeToEveryone(env, title, body) {
  if (!whatsappReady(env)) return { total: 0, sent: 0, failed: 0, skipped: 0, reason: "WhatsApp is not set up on this site yet." };
  const db = await database(env);
  if (!db) return { total: 0, sent: 0, failed: 0, skipped: 0, reason: "accounts are not configured" };
  const rows = await db
    .prepare("SELECT id, phone FROM users WHERE phone IS NOT NULL AND phone <> '' ORDER BY created_at DESC")
    .all();
  const all = rows.results || [];
  const batch = all.slice(0, MARKETING_MAX);
  const text = phoneNoticeText(title, body, "");
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < batch.length; i += 5) {
    const results = await Promise.all(
      batch.slice(i, i + 5).map(function (member) {
        return whatsappText(env, member.phone, text);
      })
    );
    results.forEach(function (ok) {
      if (ok) sent++;
      else failed++;
    });
  }
  await Promise.all(
    batch.map(function (member) {
      return pushNotice(env, { user_id: member.id, title: title, body: String(body || "").slice(0, 400) });
    })
  );
  return { total: all.length, sent: sent, failed: failed, skipped: Math.max(0, all.length - batch.length) };
}

export async function adminNotify(env, body) {
  const title = String((body && body.title) || "").trim();
  if (!title) return json(400, { error: "a message is needed" });
  let to = String((body && body.user_id) || "").trim();
  const orderId = String((body && body.order_id) || "").trim();
  if (!to && orderId) {
    const db = await database(env);
    const order = db && (await db.prepare("SELECT user_id FROM orders WHERE id = ?").bind(orderId).first());
    if (!order) return json(404, { error: "unknown order" });
    if (!order.user_id) return json(409, { error: "this order has no signed-in customer, so there is no phone to message" });
    to = order.user_id;
  }
  const text = String((body && body.body) || "").trim();

  // A single customer keeps the notice on their own record; a broadcast is
  // written per member by the sender below.
  if (to) {
    const sent = await pushNotice(env, { user_id: to, title: title, body: text, order_id: orderId || null });
    if (!sent) return json(503, { error: "accounts are not configured" });
    const result = await sendPhoneNoticeToUser(env, to, title, text, orderId);
    return json(200, { ok: true, to: to, whatsapp: result, delivered: result === "sent" ? "whatsapp" : "app" });
  }

  const result = await sendPhoneNoticeToEveryone(env, title, text);
  return json(200, {
    ok: true,
    to: "all",
    whatsapp: result.sent ? "sent" : result.failed ? "failed" : "no number",
    total: result.total,
    sent: result.sent,
    failed: result.failed,
    skipped: result.skipped,
    reason: result.reason || null
  });
}

export async function myNotices(env, userId, after) {
  const db = await database(env);
  if (!db) return { notices: [], last: Number(after || 0) };
  const since = Math.max(0, Number(after || 0) || 0);
  const rows = userId
    ? await db
        .prepare("SELECT id, title, body, order_id, created_at FROM notices WHERE id > ? AND (user_id = ? OR user_id IS NULL) ORDER BY id ASC LIMIT 30")
        .bind(since, userId)
        .all()
    : await db
        .prepare("SELECT id, title, body, order_id, created_at FROM notices WHERE id > ? AND user_id IS NULL ORDER BY id ASC LIMIT 30")
        .bind(since)
        .all();
  const notices = rows.results || [];
  const last = notices.length ? notices[notices.length - 1].id : since;
  return { notices: notices, last: last };
}

export async function adminGoldList(env) {
  const db = await database(env);
  const rows = await db
    .prepare(
      "SELECT g.*, u.name, u.email, u.phone FROM gold g LEFT JOIN users u ON u.id = g.user_id WHERE g.status IN ('pending','active') ORDER BY g.requested_at DESC LIMIT 50"
    )
    .all();
  return json(200, { members: rows.results || [] });
}

export async function adminGoldSet(env, body) {
  const db = await database(env);
  const userId = String((body && body.user_id) || "");
  const action = String((body && body.action) || "");
  if (!userId || ["activate", "reject", "cancel"].indexOf(action) < 0) return json(400, { error: "bad request" });
  const now = Date.now();
  if (action === "activate") {
    const months = Math.max(1, Math.min(24, Number((body && body.months) || GOLD.months)));
    const expires = now + Math.round(months * 30 * 86400000);
    await db
      .prepare("INSERT INTO gold (user_id, status, started_at, expires_at) VALUES (?, 'active', ?, ?) ON CONFLICT(user_id) DO UPDATE SET status = 'active', started_at = ?, expires_at = ?")
      .bind(userId, now, expires, now, expires)
      .run();
    return json(200, { ok: true, status: "active", expires_at: expires });
  }
  await db.prepare("UPDATE gold SET status = ? WHERE user_id = ?").bind(action === "reject" ? "rejected" : "none", userId).run();
  return json(200, { ok: true, status: action });
}

/* ------------------------------------------------------------
   Router
   ------------------------------------------------------------ */

export async function handleAccounts(request, env, url) {
  const path = url.pathname;

  if (path === "/api/config") {
    return json(200, {
      google: googleReady(env),
      whatsapp: whatsappReady(env),
      reservations: true,
      hold_minutes: RESERVE.holdMinutes,
      reserve: {
        advance: RESERVE.advance,
        seats: RESERVE.seats,
        maxAdults: RESERVE.maxAdults,
        maxChildren: RESERVE.maxChildren
      },
      upi: onlineUpi(env),
      upi_mode: upiMode(env),
      gold: GOLD,
      dev: env.ZEVA_DEV_LOGIN === "1"
    });
  }

  if (path === "/api/me") {
    if (!env.DB) return json(200, { user: null, signed_in: false, google: googleReady(env), whatsapp: whatsappReady(env), upi: onlineUpi(env), upi_mode: upiMode(env), gold: { status: "none" }, gold_plan: GOLD, wallet: { balance: 0, entries: [] }, orders: [] });
    return json(200, await profilePayload(request, env));
  }

  if (path === "/api/auth/google/start") {
    if (!googleReady(env)) return json(503, { error: "google sign-in is not configured" });
    return googleStart(request, env);
  }

  if (path === "/api/auth/google/callback") {
    if (!googleReady(env)) return json(503, { error: "google sign-in is not configured" });
    return googleCallback(request, env);
  }

  if (path === "/api/auth/whatsapp/start" && request.method === "POST") {
    if (!sameOrigin(request, env)) return json(403, { error: "cross-origin request" });
    return whatsappStart(env, await readJson(request));
  }

  if (path === "/api/auth/whatsapp/verify" && request.method === "POST") {
    if (!sameOrigin(request, env)) return json(403, { error: "cross-origin request" });
    return whatsappVerify(request, env, await readJson(request));
  }

  if (path === "/api/auth/exchange" && request.method === "POST") {
    let body = {};
    try {
      body = await request.json();
    } catch (error) {
      body = {};
    }
    const db = await database(env);
    if (!db) return json(503, { error: "accounts are not configured" });
    const row = await db.prepare("SELECT * FROM login_codes WHERE code = ?").bind(String(body.code || "")).first();
    if (!row || row.used_at || row.expires_at < Date.now()) return json(401, { error: "code expired" });
    await db.prepare("UPDATE login_codes SET used_at = ? WHERE code = ?").bind(Date.now(), row.code).run();
    const session = await startSession(env, row.user_id);
    return json(200, { ok: true }, { "set-cookie": cookieHeader("zeva_sid", session, SESSION_DAYS * 86400) });
  }

  if (path === "/api/auth/logout" && request.method === "POST") {
    return json(200, { ok: true }, { "set-cookie": clearCookie("zeva_sid") });
  }

  // Local development only — never enabled in production.
  if (path === "/api/auth/dev" && env.ZEVA_DEV_LOGIN === "1") {
    const db = await database(env);
    const user = await upsertUser(env, { sub: "dev-" + (url.searchParams.get("as") || "customer"), email: "dev@example.com", name: "Dev Customer", picture: "" });
    const session = await startSession(env, user.id);
    return json(200, { ok: true, user: publicUser(user) }, { "set-cookie": cookieHeader("zeva_sid", session, SESSION_DAYS * 86400) });
  }

  if (path === "/api/reservations/slots" && request.method === "GET") {
    return dayAvailability(env, url.searchParams.get("day"));
  }

  if (path === "/api/reservations" && request.method === "GET") {
    return myReservations(request, env);
  }

  if (path === "/api/reservations" && request.method === "POST") {
    if (!sameOrigin(request, env)) return json(403, { error: "cross-origin request" });
    return createReservation(request, env, await readJson(request));
  }

  if (path === "/api/reservations/cancel" && request.method === "POST") {
    if (!sameOrigin(request, env)) return json(403, { error: "cross-origin request" });
    return cancelReservation(request, env, await readJson(request));
  }

  if (path === "/api/reservations/pay" && request.method === "POST") {
    if (!sameOrigin(request, env)) return json(403, { error: "cross-origin request" });
    return reservationAdvance(request, env, await readJson(request));
  }

  if (path === "/api/reservations/paid" && request.method === "POST") {
    if (!sameOrigin(request, env)) return json(403, { error: "cross-origin request" });
    return claimReservationAdvance(request, env, await readJson(request));
  }

  if (path === "/api/profile" && request.method === "POST") {
    if (!sameOrigin(request, env)) return json(403, { error: "cross-origin request" });
    return updateProfile(request, env, await readJson(request));
  }

  if (path === "/api/orders" && request.method === "POST") {
    if (!sameOrigin(request, env)) return json(403, { error: "cross-origin request" });
    return createOrder(request, env, await readJson(request));
  }

  if (path === "/api/upi/pay" && request.method === "POST") {
    if (!sameOrigin(request, env)) return json(403, { error: "cross-origin request" });
    return startUpiPayment(request, env, await readJson(request));
  }

  if (path === "/api/upi/status" && request.method === "GET") {
    return upiPaymentStatus(env, url.searchParams.get("id"));
  }

  // The gateway calls this server-to-server, so there is no Origin to check —
  // the signature over the raw body is the authentication.
  if (path === "/api/upi/webhook" && request.method === "POST") {
    return upiWebhook(request, env);
  }

  if (path === "/api/member" && request.method === "GET") {
    return myMembership(request, env);
  }

  if (path === "/api/member/spin" && request.method === "POST") {
    if (!sameOrigin(request, env)) return json(403, { error: "cross-origin request" });
    return spinTheWheel(request, env);
  }

  if (path === "/api/gold/join" && request.method === "POST") {
    if (!sameOrigin(request, env)) return json(403, { error: "cross-origin request" });
    return joinGold(request, env);
  }

  if (path === "/api/notices" && request.method === "GET") {
    const user = await currentUser(request, env);
    return json(200, await myNotices(env, user && user.id, url.searchParams.get("after")));
  }

  // A picture the counter sent: fetched by WhatsApp's servers, which have no
  // cookie to offer, so this one route is deliberately public.
  if (path.startsWith("/api/media/") && request.method === "GET") {
    return serveMedia(env, path.slice("/api/media/".length));
  }

  if (path === "/api/admin/session") {
    const role = await staffRole(request, env);
    // The members pin counts as signed in only where the page says so: the
    // dashboard asks without ?page=members and keeps wanting the real passcode.
    const members = url.searchParams.get("page") === "members";
    return json(200, {
      signed_in: members ? Boolean(role) : role === "admin",
      role: role,
      configured: Boolean(env.ADMIN_PASSCODE)
    });
  }

  if (path === "/api/admin/login" && request.method === "POST") {
    return adminLogin(request, env, await readJson(request));
  }

  if (path === "/api/admin/logout" && request.method === "POST") {
    return json(200, { ok: true }, { "set-cookie": clearCookie("zeva_admin") });
  }

  if (path.startsWith("/api/admin/")) {
    const role = await staffRole(request, env);
    if (!role) return json(401, { error: "sign in to the dashboard" });
    // The members pin is not the dashboard: it may only reach what /members uses.
    if (role === "members" && MEMBER_PAGE_ROUTES.indexOf(path) < 0) {
      return json(403, { error: "that needs the dashboard passcode" });
    }
    if (path === "/api/admin/orders" && request.method === "GET") {
      return adminOrders(env, url.searchParams.get("after"));
    }
    if (path === "/api/admin/order" && request.method === "POST") {
      if (!sameOrigin(request, env)) return json(403, { error: "cross-origin request" });
      return adminSetStatus(env, await readJson(request));
    }
    if (path === "/api/admin/print" && request.method === "POST") {
      if (!sameOrigin(request, env)) return json(403, { error: "cross-origin request" });
      return adminReprint(env, await readJson(request));
    }
    if (path === "/api/admin/upi" && request.method === "POST") {
      if (!sameOrigin(request, env)) return json(403, { error: "cross-origin request" });
      return adminSetUpiPaid(env, await readJson(request));
    }
    if (path === "/api/admin/notify" && request.method === "POST") {
      if (!sameOrigin(request, env)) return json(403, { error: "cross-origin request" });
      return adminNotify(env, await readJson(request));
    }
    if (path === "/api/admin/reservations" && request.method === "GET") return adminReservations(env);
    if (path === "/api/admin/reservation" && request.method === "POST") {
      if (!sameOrigin(request, env)) return json(403, { error: "cross-origin request" });
      return adminSetReservation(env, await readJson(request));
    }
    if (path === "/api/admin/members" && request.method === "GET") return adminMembers(env);
    if (path === "/api/admin/whatsapp" && request.method === "GET") return adminWhatsappStatus(env);
    if (path === "/api/admin/marketing" && request.method === "POST") {
      if (!sameOrigin(request, env)) return json(403, { error: "cross-origin request" });
      return adminMarketing(env, await readJson(request));
    }
    if (path === "/api/admin/media" && request.method === "POST") {
      if (!sameOrigin(request, env)) return json(403, { error: "cross-origin request" });
      return adminMediaUpload(env, await readJson(request));
    }
    if (path === "/api/admin/spin" && request.method === "POST") {
      if (!sameOrigin(request, env)) return json(403, { error: "cross-origin request" });
      return adminSpinUsed(env, await readJson(request));
    }
    if (path === "/api/admin/visit" && request.method === "POST") {
      if (!sameOrigin(request, env)) return json(403, { error: "cross-origin request" });
      return adminAddVisit(env, await readJson(request));
    }
    if (path === "/api/admin/consume-code" && request.method === "POST") {
      if (!sameOrigin(request, env)) return json(403, { error: "cross-origin request" });
      return adminConsumeCode(env, await readJson(request));
    }
    if (path === "/api/admin/wallet" && request.method === "POST") {
      if (!sameOrigin(request, env)) return json(403, { error: "cross-origin request" });
      return adminWalletCredit(env, await readJson(request));
    }
    if (path === "/api/admin/gold" && request.method === "GET") return adminGoldList(env);
    if (path === "/api/admin/gold" && request.method === "POST") {
      if (!sameOrigin(request, env)) return json(403, { error: "cross-origin request" });
      return adminGoldSet(env, await readJson(request));
    }
    return json(404, { error: "unknown admin route" });
  }

  return null;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch (error) {
    return {};
  }
}
