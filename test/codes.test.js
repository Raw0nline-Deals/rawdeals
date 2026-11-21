import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ASSOCIATE_TAG } from "../js/affiliate.js";
import {
  activeCodes,
  codeHref,
  codeLinkLabel,
  codesFromPayload,
  isCodeActive,
  presentCode,
  validateCodes,
} from "../js/codes.js";
import { todayISO } from "../js/deals.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

function code(overrides = {}) {
  return {
    id: "brand-offer",
    brand: "Brand Name",
    title: "Short description of the offer",
    code: "CODEHERE",
    url: "https://www.amazon.com/dp/ASIN",
    discount: "10% off entire order",
    starts: "2026-11-17",
    expires: "2026-11-17",
    notes: "1 per customer",
    ...overrides,
  };
}

test("shipped codes.json is a valid array and nothing in it is live", () => {
  const payload = JSON.parse(read("data/codes.json"));
  assert.deepEqual(validateCodes(payload), []);
  assert.equal(payload.length, 1);
  const example = payload[0];
  assert.equal(example.id, "example-expired");
  assert.equal(example.code, "EXAMPLE");
  assert.match(example.title, /EXAMPLE/);
  assert.match(example.notes, /Not a real code/);
  assert.equal(example.expires, "2020-01-01");
  assert.equal(activeCodes(payload, todayISO()).length, 0);
  assert.equal(activeCodes(payload, "2020-01-01").length, 1);
  assert.equal(activeCodes(payload, "2020-01-02").length, 0);
  assert.equal(activeCodes(payload, "2018-12-31").length, 0);
});

test("active codes follow Chicago dates, including the expiry day and a future start", () => {
  const offer = code();
  const nightBefore = todayISO(new Date("2026-11-17T05:30:00Z"));
  const firstMinute = todayISO(new Date("2026-11-17T06:30:00Z"));
  const nextDay = todayISO(new Date("2026-11-18T06:30:00Z"));
  assert.equal(nightBefore, "2026-11-16");
  assert.equal(firstMinute, "2026-11-17");
  assert.equal(nextDay, "2026-11-18");
  assert.equal(isCodeActive(offer, nightBefore), false);
  assert.equal(isCodeActive(offer, firstMinute), true);
  assert.equal(isCodeActive(offer, nextDay), false);

  const openEndedStart = code({ starts: undefined, expires: "2026-11-17" });
  delete openEndedStart.starts;
  assert.equal(isCodeActive(openEndedStart, "2026-11-16"), true);
  assert.equal(isCodeActive(code({ starts: "2026-11-18", expires: "2026-12-01" }), "2026-11-17"), false);
  assert.equal(isCodeActive(code({ starts: "2026-11-18", expires: "2026-12-01" }), "2026-11-18"), true);
});

test("zero, one active, and one expired code resolve to the codes a visitor can see", () => {
  assert.deepEqual(activeCodes([], "2026-11-17"), []);
  assert.deepEqual(codesFromPayload({ codes: [] }), []);

  const expired = code({ id: "old", code: "OLDCODE", starts: "2020-01-01", expires: "2020-01-01" });
  assert.deepEqual(activeCodes([expired], "2026-11-17"), []);

  const active = code({ id: "live", code: "TESTCODE", expires: "2026-12-31" });
  assert.deepEqual(activeCodes([active], "2026-11-17").map((entry) => entry.id), ["live"]);

  const future = code({ id: "later", code: "LATER", starts: "2026-12-01", expires: "2026-12-31" });
  const visible = activeCodes([future, expired, active], "2026-11-17");
  assert.deepEqual(visible.map((entry) => entry.code), ["TESTCODE"]);

  const view = presentCode(active);
  assert.equal(view.discount, "10% off entire order");
  assert.equal(view.notes, "1 per customer");
  assert.equal(view.expiresLabel, "Ends Dec 31");
  assert.equal(view.linkLabel, "View on Amazon");
  assert.equal(new URL(view.href).searchParams.get("tag"), ASSOCIATE_TAG);
  assert.equal(presentCode(code({ url: undefined })).href, "");
  assert.equal(codeHref({ url: "https://brand.example/offer" }), "https://brand.example/offer");
  assert.equal(codeLinkLabel("https://brand.example/offer"), "Open offer");
  assert.equal(codeHref({ url: "http://brand.example/offer" }), "");

  const described = code({ title: undefined, description: "Free shipping on one order" });
  delete described.title;
  assert.equal(presentCode(described).title, "Free shipping on one order");
  assert.equal(presentCode(code({ description: "Stackable once" })).description, "Stackable once");
  assert.equal(isCodeActive(code({ starts: "2026-12-02", expires: "2026-12-01" }), "2026-12-01"), false);
  assert.equal(isCodeActive(code({ code: "   " }), "2026-11-17"), false);
});

test("daily refresh and discord posting do not touch promo codes", () => {
  const handsOff = [
    "scripts/fetch-deals.js",
    "scripts/build-feed.js",
    "scripts/post-discord.js",
    "scripts/validate-deals.js",
    "scripts/amazonoffercode.js",
    ".github/workflows/refresh-deals.yml",
  ];
  for (const path of handsOff) {
    assert.equal(read(path).includes("codes.json"), false, path);
  }
  assert.match(read(".github/workflows/refresh-deals.yml"), /git add -- data\/deals\.json feed\.xml/);
  assert.match(read("docs/CODES.md"), /Impact\.com/);
  assert.match(read("docs/CODES.md"), /"code": "CODEHERE"/);
});

function chromeBin() {
  for (const bin of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const found = spawnSync(bin, ["--version"], { encoding: "utf8" });
    if (found.status === 0) return bin;
  }
  return "";
}

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".xml": "application/xml",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
};

function startFixtureServer(codesPayload) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/data/codes.json") {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(codesPayload));
      return;
    }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const full = normalize(join(root, relative || "index.html"));
    if (full !== root && !full.startsWith(root + sep)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    if (!existsSync(full) || !statSync(full).isFile()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "content-type": types[extname(full)] || "application/octet-stream" });
    res.end(readFileSync(full));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function launchChrome(bin) {
  const profile = mkdtempSync(join(tmpdir(), "rawdeals-chrome-"));
  const child = spawn(bin, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "--host-resolver-rules=MAP fonts.googleapis.com 127.0.0.1, MAP fonts.gstatic.com 127.0.0.1",
    "about:blank",
  ], { detached: true, stdio: ["ignore", "ignore", "pipe"] });
  const ready = new Promise((resolve, reject) => {
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`chrome did not open a debugging port\n${err.slice(-500)}`));
    }, 8000);
    child.stderr.on("data", (chunk) => {
      err += chunk;
      const match = err.match(/DevTools listening on (ws:\/\/\S+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve(new URL(match[1]).port);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return { child, profile, ready };
}

async function stopChrome(child, profile) {
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    await new Promise((resolve) => child.once("exit", resolve));
  }
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 40 });
  } catch {
    // A leftover profile directory should not hide a render result.
  }
}

async function readCodes(bin, url) {
  const launched = launchChrome(bin);
  try {
    const port = await launched.ready;
    const created = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
    if (!created.ok) throw new Error(`could not open tab (${created.status})`);
    const target = await created.json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve);
      ws.addEventListener("error", () => reject(new Error("devtools socket failed")));
    });
    let id = 0;
    const pending = new Map();
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    });
    const send = (method, params = {}) => new Promise((resolve) => {
      const msgId = ++id;
      pending.set(msgId, resolve);
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
    await send("Runtime.enable");
    const expression = `(() => {
      const deals = document.querySelector("#deals");
      const codes = document.querySelector("#codes");
      const nav = document.querySelector("#codes-nav");
      if (!deals || !codes || !nav || deals.querySelector(".loading")) return "";
      return JSON.stringify({
        codesHidden: codes.hidden,
        navHidden: nav.hidden,
        html: codes.outerHTML,
      });
    })()`;
    const started = Date.now();
    let last = "";
    let stable = 0;
    let snapshot = null;
    while (Date.now() - started < 8000) {
      const reply = await send("Runtime.evaluate", { expression, returnByValue: true });
      const value = reply.result?.result?.value || "";
      if (value && value === last) stable += 1;
      else stable = 0;
      last = value;
      if (stable >= 2) {
        snapshot = JSON.parse(value);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    ws.close();
    if (!snapshot) throw new Error("promo codes section did not finish rendering");
    return snapshot;
  } finally {
    await stopChrome(launched.child, launched.profile);
  }
}

test("the page hides promo codes until one is active", { timeout: 90000 }, async (t) => {
  const bin = chromeBin();
  if (!bin) {
    t.skip("chrome is not installed");
    return;
  }
  const active = code({
    id: "test-active",
    brand: "Test Brand",
    title: "Test offer",
    code: "TESTCODE",
    url: "https://www.amazon.com/dp/B00TEST",
    discount: "10% off entire order",
    starts: "2020-01-01",
    expires: "2099-12-31",
    notes: "1 per customer",
  });
  const expired = code({
    id: "test-expired",
    brand: "Old Brand",
    title: "Expired offer",
    code: "OLDCODE",
    starts: "2000-01-01",
    expires: "2000-01-02",
    notes: "already ended",
  });

  const cases = [
    { name: "zero", payload: [], visible: false, present: [], absent: ["TESTCODE", "OLDCODE"] },
    { name: "active", payload: [active], visible: true, present: ["TESTCODE", "Test Brand", "10% off entire order", "1 per customer", "Ends Dec 31", "View on Amazon", `tag=${ASSOCIATE_TAG}`], absent: ["OLDCODE"] },
    { name: "expired", payload: [expired], visible: false, present: [], absent: ["OLDCODE", "Expired offer"] },
  ];

  for (const item of cases) {
    const server = await startFixtureServer(item.payload);
    try {
      const { port } = server.address();
      const page = await readCodes(bin, `http://127.0.0.1:${port}/?case=${item.name}`);
      assert.equal(page.codesHidden, !item.visible, item.name);
      assert.equal(page.navHidden, !item.visible, `${item.name} nav`);
      for (const text of item.present) {
        assert.equal(page.html.includes(text), true, `${item.name} missing ${text}`);
      }
      for (const text of item.absent) {
        assert.equal(page.html.includes(text), false, `${item.name} leaked ${text}`);
      }
      if (item.visible) {
        assert.match(page.html, /class="copy-btn"/);
        assert.match(page.html, /aria-label="Copy promo code TESTCODE"/);
        assert.match(page.html, /class="code-card"/);
        assert.match(page.html, /<h2 id="codes-title">Promo Codes<\/h2>/);
      } else {
        assert.equal(page.html.includes("code-card"), false, item.name);
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }
});
