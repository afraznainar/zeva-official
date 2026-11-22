#!/usr/bin/env node
// Add or inspect a DNS record at Hostinger without opening the panel.
//
// The domain lives at Hostinger, so the www record that points at the Sites
// deployment has to be written into Hostinger's zone — hPanel does it by hand,
// and Hostinger's public API does the same thing from a script:
//   GET  /api/dns/v1/zones/{domain}
//   PUT  /api/dns/v1/zones/{domain}   { overwrite, zone: [...] }
//
// The token is an account API token (hPanel -> Account -> API tokens) and it
// carries the account's own permissions, so it is read from a gitignored file
// and never printed. Usage:
//   node scripts/hostinger-dns.mjs list
//   node scripts/hostinger-dns.mjs cname www site-xxxx.freebuff.page
//
// Nothing here is Zeva-specific: the zone name is an argument.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://developers.hostinger.com";
const TOKEN_FILES = [
  path.join(ROOT, "deploy", "hostinger.secret"),
  path.join(ROOT, ".tools", "hostinger.secret")
];

function token() {
  if (process.env.HOSTINGER_API_TOKEN) return process.env.HOSTINGER_API_TOKEN.trim();
  for (const file of TOKEN_FILES) {
    if (fs.existsSync(file)) {
      const value = fs.readFileSync(file, "utf8").trim();
      if (value) return value;
    }
  }
  console.error(
    "No API token. Create one at hPanel -> Account -> API tokens and save it in\n" +
      "  deploy/hostinger.secret\n" +
      "that file is gitignored, and this script never echoes the value."
  );
  process.exit(1);
}

const ZONE = "zevamandiandgrills.in";

async function call(method, suffix, body) {
  const response = await fetch(API + "/api/dns/v1/zones/" + encodeURIComponent(ZONE) + suffix, {
    method,
    headers: {
      authorization: "Bearer " + token(),
      ...(body ? { "content-type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  if (!response.ok) {
    console.error(method + " " + suffix + " -> " + response.status + " " + text.slice(0, 400));
    process.exit(1);
  }
  return text ? JSON.parse(text) : null;
}

const [action, name, target] = process.argv.slice(2);

if (action === "list") {
  const records = await call("GET", "");
  const rows = Array.isArray(records) ? records : records?.records || [];
  for (const record of rows) {
    const contents = (record.records || []).map((r) => r.content).join(", ") || record.content || "";
    console.log([record.type, record.name, record.ttl, contents].join("\t"));
  }
} else if (action === "cname") {
  if (!name || !target) {
    console.error("usage: node scripts/hostinger-dns.mjs cname www <target-host>");
    process.exit(1);
  }
  // overwrite:false appends and updates TTLs of matching records instead of
  // wiping the zone, which is what we want on a zone that already carries the
  // domain's own mail and verification records.
  const result = await call("PUT", "", {
    overwrite: false,
    zone: [{ name, type: "CNAME", ttl: 14400, records: [{ content: target }] }]
  });
  console.log("put ok:", JSON.stringify(result));
  const records = await call("GET", "");
  const rows = Array.isArray(records) ? records : records?.records || [];
  const match = rows.filter((r) => r.type === "CNAME" && String(r.name).startsWith(name));
  console.log(
    match.length
      ? "zone now has: " +
          match
            .map((r) => r.name + " CNAME " + (r.records || []).map((x) => x.content).join(","))
            .join(" | ")
      : "no CNAME named " + name + " came back — check the zone by hand"
  );
} else {
  console.error("usage: node scripts/hostinger-dns.mjs list|cname <name> <target>");
  process.exit(1);
}
