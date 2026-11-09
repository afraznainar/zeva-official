/* ============================================================
   Zeva <-> UPI Gateway (merchant client)
   ------------------------------------------------------------
   Zeva's Worker cannot host the gateway itself — that project is
   Laravel + MySQL and lives on ordinary PHP hosting. This module
   is only the merchant half of its API
   (https://github.com/mynkdev-21/upi-gateway):

     POST /api/v1/orders          create a payment for one Zeva order
     GET  /api/v1/orders/{ref}    latest state of that payment
     POST <zeva>/api/upi/webhook  order.paid / expired / under_review,
                                  HMAC-SHA256 signed, five-minute window

   Money never passes through the browser: the amount comes from
   the order row the Worker wrote, and a payment is only marked
   paid by a verified webhook or a status read from the gateway.

   Secrets (Sites -> Secrets), never in the repo:
     UPI_GATEWAY_URL     e.g. https://pay.zeva.example
     UPI_GATEWAY_KEY     merchant key    (key_... / test_key_...)
     UPI_GATEWAY_SECRET  merchant secret
     UPI_WEBHOOK_SECRET  webhook signing secret for that key's environment

   Until those are set, /api/config reports upi:false and the app
   keeps its "cash or UPI" wording exactly as before.
   ============================================================ */

const HMAC_WINDOW_SECONDS = 300;

function gatewayBase(env) {
  return String((env && env.UPI_GATEWAY_URL) || "").trim().replace(/\/+$/, "");
}

export function upiReady(env) {
  return Boolean(
    gatewayBase(env) &&
      String((env && env.UPI_GATEWAY_KEY) || "").trim() &&
      String((env && env.UPI_GATEWAY_SECRET) || "").trim()
  );
}

function gatewayHeaders(env) {
  return {
    "content-type": "application/json",
    accept: "application/json",
    "x-api-key": String(env.UPI_GATEWAY_KEY),
    "x-api-secret": String(env.UPI_GATEWAY_SECRET)
  };
}

// The gateway's client_order_id is [A-Za-z0-9_-], max 64 characters. Zeva's
// order ids are already safe ("20261109-121500"); anything else (or a retry
// after an expired payment) is normalised here.
export function clientIdFor(orderId, attempt) {
  const base = String(orderId || "zeva").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 56);
  const n = Number(attempt || 1);
  return n > 1 ? base + "-r" + n : base;
}

async function callGateway(env, path, init) {
  const options = Object.assign({}, init, { headers: gatewayHeaders(env) });
  if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) options.signal = AbortSignal.timeout(15000);
  let response;
  try {
    response = await fetch(gatewayBase(env) + path, options);
  } catch (error) {
    return { ok: false, status: 502, error: "payment gateway unreachable (" + (error && error.message) + ")" };
  }
  const data = await response.json().catch(function () {
    return {};
  });
  if (!response.ok) {
    // Laravel validation replies: { message, errors: { field: ["text"] } }
    let detail = String((data && data.message) || "");
    if ((!detail || detail === "The given data was invalid.") && data && data.errors) {
      const first = Object.keys(data.errors).map(function (k) { return data.errors[k]; })[0];
      const text = Array.isArray(first) ? first[0] : first;
      if (text) detail = String(text);
    }
    if (response.status === 422 && /client_order_id/i.test(detail)) detail = "this order already has a payment";
    return { ok: false, status: response.status === 401 || response.status === 403 ? 502 : response.status, error: detail || "gateway answered " + response.status };
  }
  if (!data || data.success !== true || !data.data) {
    return { ok: false, status: 502, error: "gateway sent an unexpected reply" };
  }
  return { ok: true, payment: shapePayment(data.data) };
}

export function shapePayment(data) {
  return {
    ref: String((data && data.order_id) || ""),
    client_id: String((data && data.client_order_id) || ""),
    amount: Number((data && data.amount) || 0),
    status: String((data && data.status) || "pending"),
    url: String((data && data.payment_url) || ""),
    intent: String((data && data.upi_intent) || ""),
    utr: String((data && data.utr) || ""),
    expires_at: (data && data.expires_at) || null,
    paid_at: (data && data.paid_at) || null,
    environment: String((data && data.environment) || ""),
    test: Boolean(data && data.test)
  };
}

// Ask the gateway for one payment. The amount is the order total stored in D1
// — never a number the browser sent — so a customer cannot pay ₹1 for ₹980.
export async function openPayment(env, order, attempt) {
  const amount = Math.round(Number(order.total || 0) * 100) / 100;
  if (!(amount >= 1)) return { ok: false, status: 400, error: "this order is below the ₹1 UPI minimum" };
  const body = {
    amount: amount.toFixed(2),
    client_order_id: clientIdFor(order.id, attempt),
    customer_name: String(order.name || "").slice(0, 100) || undefined,
    customer_mobile: String(order.phone || "").slice(0, 20) || undefined,
    note: ("Zeva order #" + order.id).slice(0, 50)
  };
  Object.keys(body).forEach(function (key) {
    if (body[key] === undefined) delete body[key];
  });
  return callGateway(env, "/api/v1/orders", { method: "POST", body: JSON.stringify(body) });
}

export async function pollPayment(env, reference) {
  const ref = String(reference || "").trim();
  if (!ref) return { ok: false, status: 400, error: "no payment reference" };
  return callGateway(env, "/api/v1/orders/" + encodeURIComponent(ref), { method: "GET" });
}

async function hmacHex(secret, text) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(text)));
  let out = "";
  for (let i = 0; i < mac.length; i++) out += mac[i].toString(16).padStart(2, "0");
  return out;
}

function sameHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// X-Signature: t=<unix-seconds>,v1=<hex hmac of "t.body">. The five-minute
// window is what stops a captured delivery being replayed tomorrow.
export async function verifyWebhook(env, rawBody, signatureHeader) {
  const secret = String((env && env.UPI_WEBHOOK_SECRET) || "");
  if (!secret) return { ok: false, code: 503, error: "webhook secret is not set" };
  const match = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(String(signatureHeader || "").trim());
  if (!match) return { ok: false, code: 401, error: "missing signature" };
  const stamp = Number(match[1]);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(stamp) || Math.abs(now - stamp) > HMAC_WINDOW_SECONDS) {
    return { ok: false, code: 401, error: "signature is outside the five-minute window" };
  }
  const expected = await hmacHex(secret, match[1] + "." + rawBody);
  if (!sameHex(expected, match[2])) return { ok: false, code: 401, error: "bad signature" };
  return { ok: true, timestamp: stamp };
}
