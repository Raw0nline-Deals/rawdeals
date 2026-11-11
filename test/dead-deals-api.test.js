import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  COOLDOWN_MS,
  IP_DAY_LIMIT,
  REPORT_THRESHOLD,
  VISITOR_DAY_LIMIT,
  VISITOR_HOUR_LIMIT,
  handleDeadDeals,
  memoryKv,
} from "../workers/dead-deals/src/api.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const SALT = "test-salt-value-xx";
const TOKEN = "test-token-value-1";
const IP = "203.0.113.44";
const NOW = new Date("2026-11-11T15:00:00.000Z");

function freshEnv() {
  return { DEAD_DEALS: memoryKv(), IP_HASH_SALT: SALT, DEAD_DEALS_TOKEN: TOKEN };
}

function visitorId(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

async function call(env, path, {
  method = "GET",
  visitor = 1,
  ip = IP,
  body,
  token,
  now = NOW,
  origin,
} = {}) {
  const headers = { "cf-connecting-ip": ip };
  if (visitor != null) headers["x-visitor-id"] = visitorId(visitor);
  if (body) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  if (origin) headers.origin = origin;
  const response = await handleDeadDeals(new Request(`https://api.getrawdeals.com${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  }), env, { now: () => now });
  const text = await response.text();
  let json = null;
  if (text) json = JSON.parse(text);
  return { status: response.status, json, headers: response.headers };
}

async function vote(env, id, visitor, options = {}) {
  return call(env, "/api/dead-deals", { method: "POST", visitor, body: { id }, ...options });
}

test("one vote per visitor, and only the threshold opens verification", async () => {
  const env = freshEnv();
  const first = await vote(env, "B0KEEP000001", 1);
  assert.equal(first.status, 201);
  assert.equal(first.json.count, 1);
  assert.equal(first.json.pending, false);
  assert.equal(first.json.source, "api");
  assert.equal(first.json.verified, false);

  const again = await vote(env, "B0KEEP000001", 1);
  assert.equal(again.status, 200);
  assert.equal(again.json.count, 1);
  assert.equal(again.json.reportedAt, first.json.reportedAt);

  await vote(env, "B0KEEP000001", 2);
  const third = await vote(env, "B0KEEP000001", 3);
  assert.equal(third.json.count, REPORT_THRESHOLD);
  assert.equal(third.json.pending, true);

  const admin = await call(env, "/api/dead-deals/admin", { token: TOKEN, visitor: null });
  assert.equal(admin.status, 200);
  assert.deepEqual(admin.json.pending.map((entry) => entry.id), ["B0KEEP000001"]);
  assert.equal(admin.json.pending[0].count, 3);
});

test("a pending vote is private, and a verified deal is public", async () => {
  const env = freshEnv();
  await vote(env, "B0KEEP000001", 1);
  const other = await call(env, "/api/dead-deals", { visitor: 2 });
  assert.deepEqual(other.json, []);
  const mine = await call(env, "/api/dead-deals", { visitor: 1 });
  assert.equal(mine.json.length, 1);
  assert.equal(mine.json[0].verified, false);

  for (const visitor of [1, 2, 3]) await vote(env, "B0KEEP000001", visitor);
  await call(env, "/api/dead-deals/verdicts", {
    method: "POST",
    token: TOKEN,
    visitor: null,
    body: { verdicts: [{ id: "B0KEEP000001", dead: true, reason: "unavailable" }] },
  });

  const stranger = await call(env, "/api/dead-deals", { visitor: 9 });
  assert.equal(stranger.json[0].verified, true);
  assert.equal(stranger.json[0].source, "api");
  assert.equal(stranger.headers.get("cache-control"), "private, no-store");

  const undo = await call(env, "/api/dead-deals/B0KEEP000001", { method: "DELETE", visitor: 1 });
  assert.equal(undo.json.verified, true);
  const afterUndo = await call(env, "/api/dead-deals", { visitor: 9 });
  assert.equal(afterUndo.json[0].verified, true);
});

test("undo removes only that vote and drops a deal below the threshold", async () => {
  const env = freshEnv();
  await vote(env, "B0KEEP000001", 1);
  await vote(env, "B0KEEP000001", 2);
  await vote(env, "B0KEEP000001", 3);
  const removed = await call(env, "/api/dead-deals/B0KEEP000001", { method: "DELETE", visitor: 3 });
  assert.equal(removed.json.verified, false);
  const admin = await call(env, "/api/dead-deals/admin", { token: TOKEN, visitor: null });
  assert.deepEqual(admin.json.pending, []);
  const mine = await call(env, "/api/dead-deals", { visitor: 3 });
  assert.deepEqual(mine.json, []);
  const still = await call(env, "/api/dead-deals", { visitor: 1 });
  assert.equal(still.json.length, 1);
});

test("a live verdict cools the deal down instead of hiding it", async () => {
  const env = freshEnv();
  for (const visitor of [1, 2, 3]) await vote(env, "B0KEEP000001", visitor);
  const verdict = await call(env, "/api/dead-deals/verdicts", {
    method: "POST",
    token: TOKEN,
    visitor: null,
    now: NOW,
    body: { verdicts: [{ id: "B0KEEP000001", dead: false, reason: "still_live" }] },
  });
  assert.equal(verdict.status, 200);
  const during = await vote(env, "B0KEEP000001", 4, { now: new Date(NOW.getTime() + 60 * 1000) });
  assert.equal(during.json.accepted, false);
  assert.equal(during.json.reason, "cooldown");
  const admin = await call(env, "/api/dead-deals/admin", { token: TOKEN, visitor: null });
  assert.deepEqual(admin.json.pending, []);
  assert.deepEqual(admin.json.verified, []);

  const later = new Date(NOW.getTime() + COOLDOWN_MS + 1000);
  for (const visitor of [4, 5, 6]) await vote(env, "B0KEEP000001", visitor, { now: later });
  const again = await call(env, "/api/dead-deals/admin", { token: TOKEN, visitor: null, now: later });
  assert.deepEqual(again.json.pending.map((entry) => entry.id), ["B0KEEP000001"]);
});

test("reconcile clears a verified deal only when the site is showing it", async () => {
  const env = freshEnv();
  for (const visitor of [1, 2, 3]) await vote(env, "B0KEEP000001", visitor);
  await vote(env, "B0OTHER00001", 1);
  await call(env, "/api/dead-deals/verdicts", {
    method: "POST",
    token: TOKEN,
    visitor: null,
    body: {
      verdicts: [
        { id: "B0KEEP000001", dead: true, reason: "price_up" },
        { id: "B0OTHER00001", dead: true, reason: "not_found" },
      ],
    },
  });
  const cleared = await call(env, "/api/dead-deals/reconcile", {
    method: "POST",
    token: TOKEN,
    visitor: null,
    body: { activeIds: ["B0KEEP000001"] },
  });
  assert.equal(cleared.json.cleared, 1);
  const list = await call(env, "/api/dead-deals", { visitor: 9 });
  assert.deepEqual(list.json.map((entry) => entry.id), ["B0OTHER00001"]);
});

test("rate limits stop one visitor and one IP from flagging every deal", async () => {
  const env = freshEnv();
  for (let index = 0; index < VISITOR_HOUR_LIMIT; index += 1) {
    const response = await vote(env, `deal-hour-${index}`, 1);
    assert.equal(response.status, 201);
  }
  const blockedHour = await vote(env, "deal-hour-blocked", 1);
  assert.equal(blockedHour.status, 429);
  assert.equal(blockedHour.headers.get("retry-after"), "3600");

  const nextHour = new Date(NOW.getTime() + 60 * 60 * 1000);
  const allowedAgain = await vote(env, "deal-hour-blocked", 1, { now: nextHour });
  assert.equal(allowedAgain.status, 201);

  const dayEnv = freshEnv();
  for (let index = 0; index < VISITOR_DAY_LIMIT; index += 1) {
    const at = new Date(NOW.getTime() + index * 60 * 60 * 1000);
    const response = await vote(dayEnv, `deal-day-${index}`, 1, { now: at });
    assert.equal(response.status, 201, `vote ${index}`);
  }
  const blockedDay = await vote(dayEnv, "deal-day-blocked", 1, { now: new Date(NOW.getTime() + 5 * 60 * 60 * 1000) });
  assert.equal(blockedDay.status, 429);
  const duplicate = await vote(dayEnv, "deal-day-0", 1);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.json.count, 1);

  const ipEnv = freshEnv();
  const ipStart = new Date("2026-11-11T00:00:00.000Z");
  for (let index = 0; index < IP_DAY_LIMIT; index += 1) {
    const response = await vote(ipEnv, `deal-ip-${index}`, index + 1, {
      now: new Date(ipStart.getTime() + index * 60 * 60 * 1000),
    });
    assert.equal(response.status, 201, `ip vote ${index}`);
  }
  const blockedIp = await vote(ipEnv, "deal-ip-blocked", IP_DAY_LIMIT + 1, {
    now: new Date(ipStart.getTime() + (IP_DAY_LIMIT - 1) * 60 * 60 * 1000),
  });
  assert.equal(blockedIp.status, 429);
  const otherNetwork = await vote(ipEnv, "deal-ip-blocked", IP_DAY_LIMIT + 1, { ip: "203.0.113.99" });
  assert.equal(otherNetwork.status, 201);
});

test("stored values and responses do not contain the IP, salt, or token", async () => {
  const env = freshEnv();
  await vote(env, "B0KEEP000001", 1);
  await call(env, "/api/dead-deals/admin", { token: TOKEN, visitor: null });
  const dumped = JSON.stringify(env.DEAD_DEALS.dump());
  assert.equal(dumped.includes(IP), false);
  assert.equal(dumped.includes(SALT), false);
  assert.equal(dumped.includes(TOKEN), false);
  assert.equal(dumped.includes(visitorId(1)), false);

  const denied = await call(env, "/api/dead-deals/admin", { token: "not-the-real-token", visitor: null });
  assert.equal(denied.status, 401);
  assert.equal(JSON.stringify(denied.json).includes(TOKEN), false);
  const unconfigured = await call({ DEAD_DEALS: env.DEAD_DEALS }, "/api/dead-deals/admin", { visitor: null });
  assert.equal(unconfigured.status, 503);
});

test("the public routes allow the site and reject a missing visitor on write", async () => {
  const env = freshEnv();
  const preflight = await handleDeadDeals(new Request("https://api.getrawdeals.com/api/dead-deals", {
    method: "OPTIONS",
    headers: { origin: "https://getrawdeals.com" },
  }), env);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://getrawdeals.com");

  const local = await call(env, "/api/dead-deals", { origin: "http://127.0.0.1:4173" });
  assert.equal(local.headers.get("access-control-allow-origin"), "http://127.0.0.1:4173");

  const evil = await call(env, "/api/dead-deals", { origin: "https://evil.example" });
  assert.equal(evil.headers.get("access-control-allow-origin"), null);

  const missing = await call(env, "/api/dead-deals", { method: "POST", visitor: null, body: { id: "B0KEEP000001" } });
  assert.equal(missing.status, 400);
});

test("the worker and the page do not carry Creators API credentials", () => {
  for (const path of [
    "workers/dead-deals/src/api.js",
    "workers/dead-deals/src/index.js",
    "js/dead-deals.js",
    "js/app.js",
  ]) {
    const source = read(path);
    assert.equal(source.includes("CREATORS_API"), false, path);
    assert.equal(source.includes("client_secret"), false, path);
    assert.equal(source.includes("console."), false, path);
  }
  assert.match(read(".github/workflows/verify-dead-deals.yml"), /secrets\.CREATORS_API_CREDENTIAL_SECRET/);
  assert.match(read(".github/workflows/verify-dead-deals.yml"), /secrets\.DEAD_DEALS_TOKEN/);
  assert.match(read(".github/workflows/refresh-deals.yml"), /verify-dead-deals\.js --reconcile/);
  assert.equal(read("workers/dead-deals/wrangler.toml").includes("CREATORS_API"), false);
});
