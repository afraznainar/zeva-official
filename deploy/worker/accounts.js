/* ============================================================
   Zeva accounts — customers, orders, wallet, Zeva Gold, admin
   ------------------------------------------------------------
   Everything here runs inside the Worker against the D1 binding
   (env.DB). Cookies are HMAC-signed, so no session table is
   needed. Secrets, never in the repo:
     GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET  -> Google sign-in
     SESSION_SECRET                           -> cookie signing
     ADMIN_PASSCODE                           -> staff dashboard
   ZEVA_DEV_LOGIN=1 exists only for local development.
   ============================================================ */

export const GOLD = {
  price: 499,
  months: 6,
  cashback: 5,
  freeMetres: 5000
};

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

export function canonicalOrigin(request) {
  const url = new URL(request.url);
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname)) return url.origin;
  return SITE;
}

// Guard cookie-authenticated writes against cross-site form posts.
export function sameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(canonicalOrigin(request)).origin;
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
  return canonicalOrigin(request) + "/api/auth/google/callback";
}

export async function googleStart(request, env) {
  const url = new URL(request.url);
  const next = String(url.searchParams.get("next") || "/app").slice(0, 200);
  const state = await sign(env, { n: next, exp: Date.now() + 10 * 60000 });
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
  if (!tokenResponse.ok) return new Response("Google rejected the sign-in. Please try again.", { status: 400 });
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
  if (url.searchParams.get("app") === "1") {
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
  "id, user_id, name, phone, address, note, mode, payment, items, items_total, cgst, sgst, delivery, total, distance_m, status, gold_delivery, created_at";

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
    created_at: row.created_at
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
   Wallet + Gold for the customer
   ------------------------------------------------------------ */

export async function profilePayload(request, env) {
  const user = await currentUser(request, env);
  const gold = await goldStatus(env, user && user.id);
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
    dev: env.ZEVA_DEV_LOGIN === "1",
    gold: gold,
    gold_plan: GOLD,
    wallet: {
      balance: user ? await walletBalance(env, user.id) : 0,
      entries: entries
    },
    orders: await myOrders(env, user && user.id, 20),
    notices: (await myNotices(env, user && user.id, 0)).last
  };
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
  const phone = String((body && body.phone) || "").replace(/[^\d+]/g, "").slice(0, 16);
  const name = String((body && body.name) || user.name || "").slice(0, 80);
  const address = String((body && body.address !== undefined ? body.address : user.address) || "").slice(0, 400);
  await db.prepare("UPDATE users SET phone = ?, name = ?, address = ? WHERE id = ?").bind(phone, name, address, user.id).run();
  return json(200, { ok: true, user: publicUser({ ...user, phone: phone, name: name, address: address }) });
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
  if (!sameOrigin(request)) return json(403, { error: "cross-origin request" });
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
  }

  if (order.user_id && STATUS_NOTICE[status]) {
    const text = STATUS_NOTICE[status];
    const title = order.mode === "pickup" && status === "out" ? "Ready for pickup" : text[0];
    const line = order.mode === "pickup" && status === "out" ? "Your order is packed and waiting at the counter." : text[1];
    await pushNotice(env, {
      user_id: order.user_id,
      title: "#" + id + " \u00b7 " + title,
      body: line + (credited ? " +\u20b9" + credited + " in Zeva Money." : ""),
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
  return json(200, { ok: true, id: id, status: status, cashback: credited });
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
    return json(200, { google: googleReady(env), gold: GOLD, dev: env.ZEVA_DEV_LOGIN === "1" });
  }

  if (path === "/api/me") {
    if (!env.DB) return json(200, { user: null, signed_in: false, google: googleReady(env), gold: { status: "none" }, gold_plan: GOLD, wallet: { balance: 0, entries: [] }, orders: [] });
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
    if (!sameOrigin(request)) return json(403, { error: "cross-origin request" });
    return updateProfile(request, env, await readJson(request));
  }

  if (path === "/api/orders" && request.method === "POST") {
    if (!sameOrigin(request)) return json(403, { error: "cross-origin request" });
    return createOrder(request, env, await readJson(request));
  }

  if (path === "/api/gold/join" && request.method === "POST") {
    if (!sameOrigin(request)) return json(403, { error: "cross-origin request" });
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
      if (!sameOrigin(request)) return json(403, { error: "cross-origin request" });
      return adminSetStatus(env, await readJson(request));
    }
    if (path === "/api/admin/notify" && request.method === "POST") {
      if (!sameOrigin(request)) return json(403, { error: "cross-origin request" });
      return adminNotify(env, await readJson(request));
    }
    if (path === "/api/admin/gold" && request.method === "GET") return adminGoldList(env);
    if (path === "/api/admin/gold" && request.method === "POST") {
      if (!sameOrigin(request)) return json(403, { error: "cross-origin request" });
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
