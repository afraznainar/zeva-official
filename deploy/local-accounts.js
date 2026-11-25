/* ============================================================
   Local-only adapter: runs the real Worker accounts API
   (worker/accounts.js) on Node, backed by a SQLite file.

   This exists because the deployed API lives in a Cloudflare
   Worker with a D1 database, and wrangler/workerd cannot run on
   this machine. The module below is the same code the Worker
   runs, so what you test here is what ships.

   Used by server.js; nothing here is deployed.
   ============================================================ */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { handleAccounts } from "./worker/accounts.js";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const DB_FILE = path.resolve(HERE, ".local-zeva.sqlite");
const PASSCODE_FILE = path.resolve(HERE, "admin-passcode.secret");

// Same passcode as production, so what staff learn locally works live.
function localPasscode() {
  if (process.env.ADMIN_PASSCODE) return process.env.ADMIN_PASSCODE;
  try {
    const value = fs.readFileSync(PASSCODE_FILE, "utf8").trim();
    if (value) return value;
  } catch (error) {
    /* no passcode file yet */
  }
  return "zeva-dev-pass";
}

let db = null;

function openDatabase() {
  if (db) return db;
  if (fs.existsSync(DB_FILE) === false) fs.writeFileSync(DB_FILE, "");
  db = new DatabaseSync(DB_FILE);
  return db;
}

function bindable(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

// Minimal D1 shim over node:sqlite.
function d1() {
  const sqlite = openDatabase();
  function statement(sql) {
    const params = [];
    const api = {
      bind: function () {
        params.length = 0;
        for (let i = 0; i < arguments.length; i++) params.push(bindable(arguments[i]));
        return api;
      },
      first: async function () {
        const row = sqlite.prepare(sql).get(...params);
        return row === undefined ? null : row;
      },
      all: async function () {
        return { results: sqlite.prepare(sql).all(...params), success: true };
      },
      run: async function () {
        const info = sqlite.prepare(sql).run(...params);
        return { success: true, meta: { changes: Number(info.changes || 0) } };
      }
    };
    return api;
  }
  return {
    prepare: statement,
    batch: async function (statements) {
      const out = [];
      for (const stmt of statements) out.push(await stmt.run());
      return out;
    }
  };
}

function localEnv() {
  return {
    DB: d1(),
    SESSION_SECRET: process.env.SESSION_SECRET || "zeva-local-development-secret",
    ADMIN_PASSCODE: localPasscode(),
    ZEVA_DEV_LOGIN: "1",
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || "",
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || "",
    WHATSAPP_OTP_KEY: process.env.WHATSAPP_OTP_KEY || "",
    WHATSAPP_OTP_API: process.env.WHATSAPP_OTP_API || "",
    WHATSAPP_OTP_TEXT: process.env.WHATSAPP_OTP_TEXT || "",
    WHATSAPP_COUNTRY_CODE: process.env.WHATSAPP_COUNTRY_CODE || "",
    UPI_ID: process.env.UPI_ID || "",
    UPI_PAYEE_NAME: process.env.UPI_PAYEE_NAME || "",
    UPI_GATEWAY_URL: process.env.UPI_GATEWAY_URL || "",
    UPI_GATEWAY_KEY: process.env.UPI_GATEWAY_KEY || "",
    UPI_GATEWAY_SECRET: process.env.UPI_GATEWAY_SECRET || "",
    UPI_WEBHOOK_SECRET: process.env.UPI_WEBHOOK_SECRET || "",
    SITE_ORIGINS: process.env.SITE_ORIGINS || ""
  };
}

const ACCOUNT_ROUTES = [
  "/api/config",
  "/api/me",
  "/api/profile",
  "/api/orders",
  "/api/reservations",
  "/api/auth/",
  "/api/gold/",
  "/api/upi/",
  "/api/notices",
  "/api/member",
  "/api/admin/"
];

export function ownsPath(pathname) {
  return ACCOUNT_ROUTES.some(function (prefix) {
    return pathname === prefix || pathname.startsWith(prefix);
  });
}

function readBody(req) {
  return new Promise(function (resolve) {
    let body = "";
    req.on("data", function (chunk) { body += chunk; });
    req.on("end", function () { resolve(body); });
    req.on("error", function () { resolve(""); });
  });
}

// Returns true when it handled the request.
export async function handle(req, res, url) {
  if (!ownsPath(url.pathname)) return false;
  const body = req.method === "POST" || req.method === "PUT" ? await readBody(req) : undefined;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
  }
  const request = new Request("http://" + (req.headers.host || "127.0.0.1:4173") + url.pathname + url.search, {
    method: req.method,
    headers: headers,
    body: body && body.length ? body : undefined,
    redirect: "manual"
  });
  let response;
  try {
    response = await handleAccounts(request, localEnv(), url);
  } catch (error) {
    console.error("[local-api]", error);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "local api failed" }));
    return true;
  }
  if (!response) return false;

  const outHeaders = {};
  response.headers.forEach(function (value, key) {
    if (key.toLowerCase() === "set-cookie") return;
    outHeaders[key] = value;
  });
  const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  if (cookies.length) outHeaders["set-cookie"] = cookies;
  const location = response.headers.get("location");
  if (location) outHeaders.location = location;
  const text = await response.text();
  res.writeHead(response.status, outHeaders);
  res.end(text);
  return true;
}
