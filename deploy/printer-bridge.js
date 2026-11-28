/* ============================================================
   Zeva Mandi & Grills — counter printer bridge

   Prints bills straight into the Windows queue for the BILL
   printer (POS-80C on USB001) as RAW ESC/POS data. No helper
   agent or websocket sits in between.

   The deployed site runs on Cloudflare and cannot reach this
   machine, so this bridge exposes the printer over HTTPS that
   the Worker POSTs to.

   RUN
     node printer-bridge.js                 # listens on :8080
     BRIDGE_PORT=9090 node printer-bridge.js

   EXPOSE (one of)
     cloudflared tunnel --url http://localhost:8080
     # -> copy the https://xxxx.trycloudflare.com URL

   THEN, in the site settings (Sites -> Variables/Secrets):
     PRINT_BRIDGE_URL   = https://xxxx.trycloudflare.com/print
     PRINT_BRIDGE_TOKEN = <any long random string>   (optional but recommended)

   CHECK
     curl http://localhost:8080/health    # real Windows printer status
     curl -X POST http://localhost:8080/print -H 'content-type: application/json' \
          -d '{"text":"test line"}'

   ROUTES
     GET  /health  -> { ok, printer, status }
     POST /print   -> { text }  or raw text body  -> prints it
   ============================================================ */

"use strict";

const http = require("http");
const { printBill, printerStatus, toJobText, KITCHEN_PRINTER } = require("./print-core");

const PORT = Number(process.env.BRIDGE_PORT || 8080);
const TOKEN = String(process.env.PRINT_BRIDGE_TOKEN || "");
const PRINT_TIMEOUT_MS = 25000;

function authorised(req, url) {
  if (!TOKEN) return true;
  const header = String(req.headers["x-print-token"] || "");
  const query = String(url.searchParams.get("token") || "");
  return header === TOKEN || query === TOKEN;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise(function (resolve) {
      setTimeout(function () { resolve({ ok: false, error: "print timed out after " + ms + " ms" }); }, ms);
    })
  ]);
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    let data = "";
    req.on("data", function (chunk) {
      data += chunk;
      if (data.length > 100000) { reject(new Error("body too large")); req.destroy(); }
    });
    req.on("end", function () { resolve(data); });
    req.on("error", reject);
  });
}

function reply(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  res.end(body);
}

const server = http.createServer(async function (req, res) {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;

  if (path === "/health" && req.method === "GET") {
    if (!authorised(req, url)) { reply(res, 401, { ok: false, error: "unauthorised" }); return; }
    // Both queues, because an order cannot be accepted without either one.
    const status = await printerStatus();
    status.kitchen = await printerStatus(KITCHEN_PRINTER);
    reply(res, status.ok ? 200 : 502, status);
    return;
  }

  if (path === "/print" && req.method === "POST") {
    if (!authorised(req, url)) { reply(res, 401, { ok: false, error: "unauthorised" }); return; }
    let raw;
    try {
      raw = await readBody(req);
    } catch (error) {
      reply(res, 413, { ok: false, error: error.message });
      return;
    }
    // Accepts { order: {...}, kind, printer } — kind "kitchen" renders the
    // ticket, anything else the customer bill, and `printer` names the Windows
    // queue — plus { text: "..." } or a raw text body.
    let payload = raw;
    if (String(req.headers["content-type"] || "").includes("application/json")) {
      try {
        const body = JSON.parse(raw);
        if (body && body.order && typeof body.order === "object") {
          payload = {
            order: body.order,
            kind: body.kind === "kitchen" ? "kitchen" : "bill",
            printer: body.printer ? String(body.printer) : ""
          };
        } else if (body && body.text) {
          payload = { text: String(body.text), printer: body.printer ? String(body.printer) : "" };
        } else {
          payload = "";
        }
      } catch (error) {
        reply(res, 400, { ok: false, error: "bad json" });
        return;
      }
    }
    if (!String(toJobText(payload)).trim()) { reply(res, 400, { ok: false, error: "empty bill" }); return; }

    const result = await withTimeout(printBill(payload), PRINT_TIMEOUT_MS);
    if (!result.ok) {
      console.error("[bridge] print failed:", result.error);
      reply(res, 502, { ok: false, error: result.error });
      return;
    }
    console.log("[bridge] " + (payload.kind === "kitchen" ? "kitchen ticket" : "bill") + " printed to " + result.printer);
    reply(res, 200, { ok: true, printed: true, printer: result.printer });
    return;
  }

  reply(res, 404, { ok: false, error: "not found" });
});

server.listen(PORT, function () {
  console.log("Zeva printer bridge on http://localhost:" + PORT);
  console.log("  bill queue:    " + (process.env.PRINT_PRINTER || "BILL") + " (direct RAW, Windows spooler)");
  console.log("  kitchen queue: " + KITCHEN_PRINTER);
  console.log("  token: " + (TOKEN ? "required" : "not set (anyone who can reach this port can print)"));
  console.log("  next: cloudflared tunnel --url http://localhost:" + PORT);
});
