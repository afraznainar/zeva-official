/* ============================================================
   Zeva Mandi & Grills — receipt printing (Windows)

   Renders an order into a proper 80mm bill (logo, restaurant
   header, item table, GST breakdown, total, footer), converts it
   to ESC/POS and hands it to the Windows spooler as RAW data.

   Shared by printer-bridge.js (deployed site) and server.js (local).

   ENV
     PRINT_PRINTER  Windows queue name   default "BILL"
     PRINT_WIDTH    characters per line  default 42
   ============================================================ */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const PRINTER = process.env.PRINT_PRINTER || "BILL";
// The kitchen has its own queue. When there is only one printer on the counter
// machine, set PRINT_KITCHEN_PRINTER=BILL and both copies come out of it.
const KITCHEN_PRINTER = process.env.PRINT_KITCHEN_PRINTER || "KITCHEN";
const WIDTH = Number(process.env.PRINT_WIDTH || 42);
const PS_SCRIPT = path.join(__dirname, "raw-print.ps1");
const LOGO_FILE = path.join(__dirname, "assets", "logo.bin");

const SHOW_LOGO = String(process.env.PRINT_LOGO || "") === "1";

const SHOP = {
  name: "ZEVA MANDI & GRILLS",
  tagline: "Mandi - Grills - Mangaluru",
  address: ["Shop G03, Arfa Mirage Tower,", "Morgans Gate Rd, Bolar,", "Mangaluru, Karnataka 575001"],
  phone: "070227 71888",
  instagram: "@zevarestaurant"
};

/* ---------- text helpers ---------- */

const REPLACEMENTS = [
  [/[\u20B9]/g, "Rs."],
  [/[\u2014\u2013]/g, "-"],
  [/[\u2018\u2019]/g, "'"],
  [/[\u201C\u201D]/g, '"'],
  [/[\u2022]/g, "-"],
  [/[\u2026]/g, "..."],
  [/[\u00A0]/g, " "]
];

// Thermal printers only understand plain ASCII reliably.
function toAscii(text) {
  let out = String(text == null ? "" : text);
  REPLACEMENTS.forEach(function (pair) { out = out.replace(pair[0], pair[1]); });
  return out.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "");
}

function money(value) {
  const num = Number(value);
  if (!isFinite(num)) return "0.00";
  return num.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function padRight(text, width) {
  const str = String(text);
  return str.length >= width ? str.slice(0, width) : str + " ".repeat(width - str.length);
}

function padLeft(text, width) {
  const str = String(text);
  return str.length >= width ? str.slice(-width) : " ".repeat(width - str.length) + str;
}

function rule(char) {
  return (char || "-").repeat(WIDTH);
}

function stamp(value) {
  const date = value ? new Date(value) : new Date();
  if (isNaN(date.getTime())) return String(value);
  const day = String(date.getDate()).padStart(2, "0");
  const month = date.toLocaleString("en-GB", { month: "short" });
  const hours = date.getHours();
  const mins = String(date.getMinutes()).padStart(2, "0");
  const suffix = hours >= 12 ? "PM" : "AM";
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return day + "-" + month + "-" + date.getFullYear() + " " + hour12 + ":" + mins + " " + suffix;
}

/* ---------- bill layout ---------- */

// Column widths for the item table (total = WIDTH).
const COL = { name: 18, qty: 3, rate: 8, amount: 10, gap: 1 };

function itemRow(name, qty, rate, amount) {
  return padRight(name, COL.name) + " " + padLeft(qty, COL.qty) + " " +
    padLeft(rate, COL.rate) + " " + padLeft(amount, COL.amount);
}

function wrapWords(text, width) {
  const lines = [];
  let current = "";
  String(text).split(/\s+/).filter(Boolean).forEach(function (word) {
    while (word.length > width) {
      if (current) { lines.push(current); current = ""; }
      lines.push(word.slice(0, width));
      word = word.slice(width);
    }
    if (!current) current = word;
    else if (current.length + 1 + word.length <= width) current += " " + word;
    else { lines.push(current); current = word; }
  });
  if (current) lines.push(current);
  return lines.length ? lines : ["Item"];
}

function itemBlock(item) {
  const name = String(item.name || "Item") + (item.variant ? " (" + item.variant + ")" : "");
  const qty = Number(item.qty || 1);
  const rate = Number(item.price || 0);
  const parts = wrapWords(name, COL.name);
  const lines = [itemRow(parts[0], qty, money(rate), money(rate * qty))];
  // Continuation lines keep the columns clean and stay indented under the name.
  parts.slice(1).forEach(function (part) {
    lines.push("  " + part);
  });
  return lines;
}

function totalRow(label, value, style) {
  const prefix = style || "";
  const left = label;
  const right = money(value);
  return prefix + padRight(left, WIDTH - right.length) + right;
}

// Renders the order into plain text with tiny style markers that buildJob reads.
function renderBill(order) {
  const o = order || {};
  const items = Array.isArray(o.items) ? o.items : [];
  const out = [];

  // Typographic masthead: the calligraphy mark is thinner than one printed dot
  // at receipt size, so the wordmark reads far better. Set PRINT_LOGO=1 to
  // prepend the raster logo as well (see make-logo.ps1).
  out.push("<<C>><<D>>ZEVA");
  out.push("<<C>><<D>>MANDI & GRILLS");
  out.push("<<C>>" + SHOP.tagline);
  SHOP.address.forEach(function (line) { out.push("<<C>>" + line); });
  out.push("<<C>>Ph: " + SHOP.phone);
  out.push("<<C>>" + SHOP.instagram);
  out.push(rule("="));

  out.push("<<B>>BILL" + (o.id ? " NO: " + o.id : ""));
  out.push("Date   : " + stamp(o.date));
  out.push("Type   : " + (o.mode || "-") + "   Payment: " + (o.pay || "-"));
  out.push("Name   : " + (o.name || "Walk-in guest"));
  if (o.phone) out.push("Phone  : " + o.phone);
  if (o.address) {
    const address = String(o.address);
    let rest = address;
    out.push("Address: " + rest.slice(0, WIDTH - 9));
    rest = rest.slice(WIDTH - 9).trim();
    while (rest.length) {
      out.push("         " + rest.slice(0, WIDTH - 9));
      rest = rest.slice(WIDTH - 9).trim();
    }
  }
  if (o.distance_m != null) out.push("Dist   : " + o.distance_m + " m");
  if (o.note) out.push("Note   : " + o.note);

  out.push(rule("-"));
  out.push("<<B>>" + itemRow("ITEM", "QTY", "RATE", "AMOUNT"));
  out.push(rule("-"));
  items.forEach(function (item) {
    itemBlock(item).forEach(function (line) { out.push(line); });
  });
  out.push(rule("-"));

  const itemsTotal = Number(o.items_total != null ? o.items_total : items.reduce(function (sum, it) {
    return sum + Number(it.price || 0) * Number(it.qty || 1);
  }, 0));
  const cgst = o.cgst != null ? Number(o.cgst) : 0;
  const sgst = o.sgst != null ? Number(o.sgst) : 0;
  const tip = o.tip != null ? Number(o.tip) : 0;
  const total = Number(o.total != null ? o.total : itemsTotal + cgst + sgst + tip);
  // Zeva Money the customer spent on this bill: `total` is already net of it.
  const redeemed = Math.max(Number(o.wallet_redeemed || 0), 0);
  const delivery = Math.round((total + redeemed - itemsTotal - cgst - sgst - tip) * 100) / 100;

  out.push(totalRow("Items total", itemsTotal));
  if (delivery > 0.004) out.push(totalRow("Delivery charge", delivery));
  if (o.outside_radius) out.push("<<B>>DELIVERY: OUTSIDE 3.5 KM - CONFIRM");
  if (tip > 0.004) out.push(totalRow("Tip (optional)", tip));
  if (cgst) out.push(totalRow("CGST 2.5%", cgst));
  if (sgst) out.push(totalRow("SGST 2.5%", sgst));
  if (redeemed > 0.004) out.push(totalRow("Zeva Money used", -redeemed));
  out.push(rule("="));
  out.push("<<H>><<B>>" + totalRow("TOTAL", total));
  out.push(rule("="));

  out.push("<<C>>GST on food items only");
  out.push("<<C>>Thank you - please visit again!");
  out.push("<<C>>" + SHOP.phone + " | " + SHOP.instagram);
  out.push("");

  return out.join("\n");
}

// The kitchen's copy: what to cook and how much of it, and nothing about money.
// It is read on a hot line, so the portion is in the item name and the note has
// its own block at the bottom.
function renderTicket(order) {
  const o = order || {};
  const items = Array.isArray(o.items) ? o.items : [];
  const when = stamp(o.date || o.created_at);
  const out = [];

  out.push("<<C>><<D>>KITCHEN");
  out.push("<<C>>ZEVA MANDI & GRILLS");
  out.push(rule("="));
  out.push("<<B>><<H>>#" + (o.id || "-"));
  out.push("Time   : " + when);
  out.push("Type   : " + (o.mode === "pickup" ? "PICKUP" : "DELIVERY"));
  if (o.name) out.push("Name   : " + o.name);
  if (o.phone) out.push("Phone  : " + o.phone);

  out.push(rule("-"));
  items.forEach(function (item) {
    const qty = Number(item.qty || 1);
    const name = String(item.name || "Item") + (item.variant ? " (" + item.variant + ")" : "");
    out.push("<<B>>" + qty + " x " + name);
  });
  out.push(rule("-"));

  const count = items.reduce(function (sum, it) { return sum + Number(it.qty || 1); }, 0);
  out.push("<<B>>" + (items.length === 1 ? "1 dish" : items.length + " dishes") +
    "  /  " + (count === 1 ? "1 item" : count + " items") + " total");
  if (o.note) {
    out.push(rule("-"));
    out.push("<<B>>NOTE FROM CUSTOMER");
    out.push(String(o.note));
  }
  out.push(rule("="));
  out.push("<<C>>" + when);
  out.push("");

  return out.join("\n");
}

/* ---------- ESC/POS job ---------- */

const ESC = {
  init: Buffer.from([0x1b, 0x40]),
  alignLeft: Buffer.from([0x1b, 0x61, 0x00]),
  alignCenter: Buffer.from([0x1b, 0x61, 0x01]),
  boldOn: Buffer.from([0x1b, 0x45, 0x01]),
  boldOff: Buffer.from([0x1b, 0x45, 0x00]),
  sizeNormal: Buffer.from([0x1d, 0x21, 0x00]),
  sizeWide: Buffer.from([0x1d, 0x21, 0x11]),
  sizeTall: Buffer.from([0x1d, 0x21, 0x01]),
  feed2: Buffer.from([0x0a, 0x0a]),
  cut: Buffer.from([0x1d, 0x56, 0x42, 0x00])
};

function parseStyle(line) {
  let rest = line;
  const style = { center: false, bold: false, tall: false, wide: false };
  for (;;) {
    if (rest.startsWith("<<C>>")) { style.center = true; rest = rest.slice(5); continue; }
    if (rest.startsWith("<<B>>")) { style.bold = true; rest = rest.slice(5); continue; }
    if (rest.startsWith("<<H>>")) { style.tall = true; rest = rest.slice(5); continue; }
    if (rest.startsWith("<<D>>")) { style.tall = true; style.wide = true; rest = rest.slice(5); continue; }
    break;
  }
  return { style: style, text: toAscii(rest) };
}

function wrapLine(line) {
  const cleaned = line.replace(/\s+$/, "");
  if (cleaned.length <= WIDTH) return [cleaned];
  const indent = /^\s*/.exec(cleaned)[0];
  const limit = Math.max(10, WIDTH - indent.length);
  const words = cleaned.slice(indent.length).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  words.forEach(function (word) {
    while (word.length > limit) {
      if (current) { lines.push(indent + current); current = ""; }
      lines.push(indent + word.slice(0, limit));
      word = word.slice(limit);
    }
    if (!current) {
      current = word;
    } else if (current.length + 1 + word.length <= limit) {
      current += " " + word;
    } else {
      lines.push(indent + current);
      current = word;
    }
  });
  if (current) lines.push(indent + current);
  return lines;
}

function logoBytes() {
  try {
    if (fs.existsSync(LOGO_FILE)) return fs.readFileSync(LOGO_FILE);
  } catch (error) { /* logo is optional */ }
  return null;
}

// Builds the complete ESC/POS byte stream for a bill.
function buildJob(text) {
  const chunks = [ESC.init];
  const logo = SHOW_LOGO ? logoBytes() : null;
  if (logo && logo.length) {
    chunks.push(ESC.alignCenter, logo, ESC.feed2, ESC.alignLeft);
  }

  let current = { center: false, bold: false, tall: false, wide: false };
  const setStyle = function (style) {
    if (style.center !== current.center) {
      chunks.push(style.center ? ESC.alignCenter : ESC.alignLeft);
    }
    if (style.bold !== current.bold) {
      chunks.push(style.bold ? ESC.boldOn : ESC.boldOff);
    }
    if (style.tall !== current.tall || style.wide !== current.wide) {
      if (style.tall && style.wide) chunks.push(ESC.sizeWide);
      else if (style.tall) chunks.push(ESC.sizeTall);
      else chunks.push(ESC.sizeNormal);
    }
    current = style;
  };

  String(text).split(/\r?\n/).forEach(function (line) {
    const parsed = parseStyle(line);
    if (!parsed.text.trim()) {
      setStyle({ center: false, bold: false, tall: false, wide: false });
      chunks.push(Buffer.from("\r\n", "ascii"));
      return;
    }
    setStyle(parsed.style);
    wrapLine(parsed.text).forEach(function (wrapped) {
      chunks.push(Buffer.from(wrapped + "\r\n", "ascii"));
    });
  });

  chunks.push(ESC.sizeNormal, ESC.boldOff, ESC.alignLeft, ESC.feed2, ESC.cut);
  return Buffer.concat(chunks);
}

/* ---------- Windows spooler ---------- */

function runPowershell(args, timeoutMs) {
  return new Promise(function (resolve) {
    let output = "";
    let settled = false;
    const child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass"].concat(args), {
      windowsHide: true
    });
    const timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch (error) { /* gone */ }
      resolve({ ok: false, error: "powershell timed out after " + timeoutMs + " ms" });
    }, timeoutMs || 20000);

    child.stdout.on("data", function (chunk) { output += chunk; });
    child.stderr.on("data", function (chunk) { output += chunk; });
    child.on("error", function (error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: "cannot run powershell: " + error.message });
    });
    child.on("close", function () {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: true, output: output.trim() });
    });
  });
}

// Accepts an order object (rendered here), a { order, kind } pair, a { text }
// object, or plain text. kind "kitchen" renders the ticket instead of the bill.
function toJobText(input) {
  if (input == null) return "";
  if (typeof input === "string") return input;
  const order = input.order && typeof input.order === "object" ? input.order : input;
  if (input.text && !Array.isArray(order.items)) return String(input.text);
  return input.kind === "kitchen" ? renderTicket(order) : renderBill(order);
}

// Which Windows queue a job belongs in: an explicit printer name wins, then a
// kitchen ticket goes to the kitchen queue and everything else to the bill one.
function printerFor(input) {
  if (input && typeof input === "object" && typeof input.printer === "string" && input.printer.trim()) {
    return input.printer.trim();
  }
  return input && typeof input === "object" && input.kind === "kitchen" ? KITCHEN_PRINTER : PRINTER;
}

async function printBill(input) {
  const text = toJobText(input);
  const printer = printerFor(input);
  if (!String(text).trim()) return { ok: false, printer: printer, error: "empty bill" };
  if (process.platform !== "win32") {
    return { ok: false, error: "direct printing is Windows-only (platform " + process.platform + ")" };
  }
  if (!fs.existsSync(PS_SCRIPT)) {
    return { ok: false, error: "missing raw-print.ps1 next to print-core.js" };
  }

  const file = path.join(
    os.tmpdir(),
    "zeva-bill-" + Date.now() + "-" + Math.floor(Math.random() * 1e6) + ".bin"
  );
  try {
    fs.writeFileSync(file, buildJob(text));
    const result = await runPowershell(["-File", PS_SCRIPT, "-Path", file, "-Printer", printer], 20000);
    if (!result.ok) return { ok: false, printer: printer, error: result.error };
    const out = result.output || "";
    if (out.startsWith("OK")) return { ok: true, printer: printer };
    return { ok: false, printer: printer, error: out.replace(/^ERROR:\s*/, "") || "spooler returned no result" };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    try { fs.unlinkSync(file); } catch (error) { /* temp already gone */ }
  }
}

// Real status: does the Windows queue exist and is it ready?
async function printerStatus(name) {
  const printer = String(name || PRINTER);
  if (process.platform !== "win32") {
    return { ok: false, printer: printer, error: "Windows-only direct printing" };
  }
  const result = await runPowershell(
    ["-Command", "Get-Printer -Name '" + printer.replace(/'/g, "''") + "' | Select-Object -ExpandProperty PrinterStatus"],
    15000
  );
  if (!result.ok) return { ok: false, printer: printer, error: result.error };
  const status = (result.output || "").trim();
  if (!status) return { ok: false, printer: printer, error: "printer queue '" + printer + "' not found" };
  const ready = /^(normal|idle|printing)$/i.test(status);
  return {
    ok: ready,
    printer: printer,
    status: status,
    error: ready ? undefined : "printer '" + printer + "' reports " + status
  };
}

module.exports = {
  printBill,
  printerStatus,
  renderBill,
  renderTicket,
  buildJob,
  toJobText,
  money,
  PRINTER,
  KITCHEN_PRINTER,
  WIDTH,
  SHOP
};
