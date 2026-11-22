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
     UPI_GATEWAY_URL / _KEY / _SECRET         -> online UPI payments (./upi.js)
     UPI_WEBHOOK_SECRET                       -> gateway webhook signatures
   ZEVA_DEV_LOGIN=1 exists only for local development.
   ============================================================ */

import { upiReady, directReady, directPayment, openPayment, pollPayment, verifyWebhook } from "./upi.js";

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
  price: 499,
  months: 6,
  cashback: 5,
  freeMetres: 5000
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

export const SITE = "https://site-67005eaaea074aab9c2d40a25debe4c7.freebuff.page";

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
  "ALTER TABLE orders ADD COLUMN upi_paid_at INTEGER"
];

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

export function canonicalOrigin(request, env) {
  const url = new URL(request.url);
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname)) return url.origin;
  // Stay on the host the visitor came in on, so an OAuth return or an error
  // bounce never throws them onto a different address mid-flow.
  return ourOrigins(env).indexOf(url.origin) !== -1 ? url.origin : SITE;
}

// Guard cookie-authenticated writes against cross-site form posts.
export function sameOrigin(request, env) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const o = new URL(origin).origin;
    return o === new URL(canonicalOrigin(request, env)).origin || ourOrigins(env).indexOf(o) !== -1;
  } catch (error) {
    return false;
  }
}

/* ------------------------------------------------------------
   Database
   ------------------------------------------------------------ */

let schemaPromise = null;

export async function database(env) {
  if (!env || !env.DB) return null;
  if (!schemaPromise) {
    schemaPromise = env.DB.batch(DB_SCHEMA.map(function (sql) { return env.DB.prepare(sql); }))
      .catch(function (error) {
        schemaPromise = null;
        throw error;
      });
  }
  await schemaPromise;
  await ensureUserColumns(env);
  await ensureOrderColumns(env);
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

async function whatsappCall(env, route, payload) {
  const response = await fetch(whatsappApi(env) + route, {
    method: "POST",
    headers: {
      authorization: "Bearer " + env.WHATSAPP_OTP_KEY,
      "content-type": "application/json"
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(12000)
  });
  const data = await response.json().catch(function () { return {}; });
  return { ok: response.ok, status: response.status, data: data || {} };
}

function whatsappError(result) {
  const data = result.data || {};
  return String(data.error || data.message || data.detail || "").slice(0, 160);
}

// One account per verified number. If that number is already saved on a Google
// account, sign into that same account instead of creating a second one.
async function upsertPhoneUser(env, phone) {
  const db = await database(env);
  const now = Date.now();
  const sub = "wa:" + phone;
  const existing = await db
    .prepare("SELECT * FROM users WHERE sub = ? OR (phone IS NOT NULL AND phone = ? AND phone <> '')")
    .bind(sub, phone)
    .first();
  if (existing) {
    // Keep a Google subject intact so that sign-in still lands here.
    const keepSub = existing.sub && !String(existing.sub).startsWith("wa:") ? existing.sub : sub;
    await db.prepare("UPDATE users SET phone = ?, sub = ?, last_seen_at = ? WHERE id = ?")
      .bind(phone, keepSub, now, existing.id)
      .run();
    return { ...existing, phone: phone, sub: keepSub };
  }
  const id = crypto.randomUUID();
  await db.prepare("INSERT INTO users (id, sub, email, name, picture, phone, created_at, last_seen_at) VALUES (?, ?, '', '', '', ?, ?, ?)")
    .bind(id, sub, phone, now, now)
    .run();
  return { id: id, sub: sub, email: "", name: "", picture: "", phone: phone, created_at: now };
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

  await db.prepare("UPDATE otp_sessions SET verified_at = ? WHERE session = ?").bind(Date.now(), session).run();
  const user = await upsertPhoneUser(env, phone);
  const sessionToken = await startSession(env, user.id);
  return json(
    200,
    { ok: true, user: publicUser(user) },
    { "set-cookie": cookieHeader("zeva_sid", sessionToken, SESSION_DAYS * 86400) }
  );
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
  const total = money(itemsTotal + cgst + sgst + delivery + money(body.tip));
  const now = Date.now();

  const existing = await db.prepare("SELECT id FROM orders WHERE id = ?").bind(id).first();
  if (existing) return json(409, { error: "duplicate order" });

  await db
    .prepare(
      "INSERT INTO orders (id, user_id, name, phone, address, note, mode, payment, items, items_total, cgst, sgst, delivery, total, distance_m, status, gold_delivery, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
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
      total,
      Math.round(distance),
      "pending",
      freeDelivery ? 1 : 0,
      now
    )
    .run();

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
    wallet_balance: user ? await walletBalance(env, user.id) : 0
  });
}

const ORDER_FIELDS =
  "id, user_id, name, phone, address, note, mode, payment, items, items_total, cgst, sgst, delivery, total, distance_m, status, gold_delivery, created_at, upi_ref, upi_url, upi_intent, upi_status, upi_utr, upi_amount, upi_seq, upi_attempts, upi_checked_at, upi_paid_at";

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

export async function adminGate(request, env) {
  const token = cookies(request).zeva_admin;
  if (!token) return false;
  const payload = await unseal(env, token);
  return Boolean(payload && payload.role === "admin");
}

export async function adminLogin(request, env, body) {
  if (!env.ADMIN_PASSCODE) return json(503, { error: "admin dashboard is not configured" });
  if (!sameOrigin(request, env)) return json(403, { error: "cross-origin request" });
  const pass = String((body && body.passcode) || "");
  const expected = String(env.ADMIN_PASSCODE);
  const a = b64u(await hmac(secretFor(env), pass));
  const b = b64u(await hmac(secretFor(env), expected));
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < Math.min(a.length, b.length); i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  if (diff !== 0) return json(401, { error: "wrong passcode" });
  const token = await sign(env, { role: "admin", exp: Date.now() + 30 * 86400000 });
  return json(200, { ok: true }, { "set-cookie": cookieHeader("zeva_admin", token, 30 * 86400) });
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
  const today = await db
    .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS sum FROM orders WHERE created_at > ?")
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

export async function adminSetStatus(env, body) {
  const db = await database(env);
  const id = String((body && body.id) || "");
  let status = String((body && body.status) || "");
  if (status === "new") status = "pending";
  if (status === "ready") status = "out";
  if (!id || ORDER_STATUSES.indexOf(status) < 0) {
    return json(400, { error: "bad request" });
  }
  const order = await db.prepare("SELECT id, user_id, status, mode, items_total FROM orders WHERE id = ?").bind(id).first();
  if (!order) return json(404, { error: "unknown order" });
  await db.prepare("UPDATE orders SET status = ?, updated_at = ? WHERE id = ?").bind(status, Date.now(), id).run();

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
  }
  return json(200, { ok: true, id: id, status: status, cashback: credited, card: earned && earned.key });
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
  const sent = await pushNotice(env, {
    user_id: to || null,
    title: title,
    body: String((body && body.body) || "").trim(),
    order_id: (body && body.order_id) || null
  });
  if (!sent) return json(503, { error: "accounts are not configured" });
  return json(200, { ok: true, to: to || "all" });
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

  if (path === "/api/gold/join" && request.method === "POST") {
    if (!sameOrigin(request, env)) return json(403, { error: "cross-origin request" });
    return joinGold(request, env);
  }

  if (path === "/api/notices" && request.method === "GET") {
    const user = await currentUser(request, env);
    return json(200, await myNotices(env, user && user.id, url.searchParams.get("after")));
  }

  if (path === "/api/admin/session") {
    return json(200, { signed_in: await adminGate(request, env), configured: Boolean(env.ADMIN_PASSCODE) });
  }

  if (path === "/api/admin/login" && request.method === "POST") {
    return adminLogin(request, env, await readJson(request));
  }

  if (path === "/api/admin/logout" && request.method === "POST") {
    return json(200, { ok: true }, { "set-cookie": clearCookie("zeva_admin") });
  }

  if (path.startsWith("/api/admin/")) {
    if (!(await adminGate(request, env))) return json(401, { error: "sign in to the dashboard" });
    if (path === "/api/admin/orders" && request.method === "GET") {
      return adminOrders(env, url.searchParams.get("after"));
    }
    if (path === "/api/admin/order" && request.method === "POST") {
      if (!sameOrigin(request, env)) return json(403, { error: "cross-origin request" });
      return adminSetStatus(env, await readJson(request));
    }
    if (path === "/api/admin/upi" && request.method === "POST") {
      if (!sameOrigin(request, env)) return json(403, { error: "cross-origin request" });
      return adminSetUpiPaid(env, await readJson(request));
    }
    if (path === "/api/admin/notify" && request.method === "POST") {
      if (!sameOrigin(request, env)) return json(403, { error: "cross-origin request" });
      return adminNotify(env, await readJson(request));
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
