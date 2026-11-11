import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isActiveDeal, visibleDeals } from "../js/deals.js";
import { buildFeedXml } from "../scripts/build-feed.js";
import { mergeApiDeals } from "../scripts/fetch-deals.js";
import {
  applyVerifiedDead,
  asinFromDeal,
  verifyFromDisk,
  verifyPendingDeals,
  verdictForDeal,
} from "../scripts/verify-dead-deals.js";
import { handleDeadDeals, memoryKv } from "../workers/dead-deals/src/api.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const secret = "super-secret-value-do-not-print";
const deadToken = "dead-deals-token-value";
const salt = "test-salt-value-xx";
const today = "2026-11-11";
const now = new Date("2026-11-11T15:00:00.000Z");

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

function deal(overrides = {}) {
  return {
    id: "B0KEEP0001",
    title: "Kept widget",
    image: "https://m.media-amazon.com/images/I/widget.jpg",
    price: 10,
    originalPrice: 20,
    percentOff: 50,
    category: "Home",
    url: "https://www.amazon.com/dp/B0KEEP0001",
    added: "2026-11-11",
    sample: false,
    source: "api",
    ...overrides,
  };
}

function listing({ price = 10, percent = 50, availability = "IN_STOCK", violatesMAP = false, end } = {}) {
  return {
    isBuyBoxWinner: true,
    violatesMAP,
    availability: { type: availability },
    price: {
      money: { amount: price },
      savingBasis: { money: { amount: 20 } },
      savings: { percentage: percent },
    },
    ...(end ? { dealDetails: { endTime: `${end}T05:00:00Z` } } : {}),
  };
}

function item(asin, options) {
  return {
    asin,
    detailPageURL: `https://www.amazon.com/dp/${asin}`,
    offersV2: { listings: [listing(options)] },
  };
}

function visitorId(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function workerEnv() {
  return { DEAD_DEALS: memoryKv(), IP_HASH_SALT: salt, DEAD_DEALS_TOKEN: deadToken };
}

async function seedVotes(env, id, voters = [1, 2, 3]) {
  for (const visitor of voters) {
    const response = await handleDeadDeals(new Request("https://api.getrawdeals.com/api/dead-deals", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-visitor-id": visitorId(visitor),
        "cf-connecting-ip": `203.0.113.${visitor}`,
      },
      body: JSON.stringify({ id }),
    }), env, { now: () => now });
    assert.equal(response.status, 201);
  }
}

function routeFetch(env, amazon) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const href = String(url);
    calls.push(href);
    if (href.includes("api.getrawdeals.com")) {
      return handleDeadDeals(new Request(href, options), env, { now: () => now });
    }
    return amazon(href, options);
  };
  return { calls, fetchImpl };
}

test("verification marks a dead offer and leaves a live offer alone", () => {
  const card = deal();
  assert.deepEqual(verdictForDeal(card, null, today), { dead: true, reason: "not_found" });
  assert.equal(verdictForDeal(card, item("B0KEEP0001", { availability: "OUT_OF_STOCK", price: 8 }), today).reason, "unavailable");
  assert.equal(verdictForDeal(card, item("B0KEEP0001", { violatesMAP: true }), today).reason, "no_offer");
  assert.equal(verdictForDeal(card, { asin: "B0KEEP0001", offersV2: { listings: [] } }, today).reason, "no_offer");
  assert.equal(verdictForDeal(card, item("B0KEEP0001", { price: 10.03 }), today).reason, "price_up");
  assert.equal(verdictForDeal(card, item("B0KEEP0001", { price: 10.02 }), today).reason, "still_live");
  assert.equal(verdictForDeal(card, item("B0KEEP0001", { price: 9, end: "2026-11-10" }), today).reason, "expired");
  assert.equal(verdictForDeal(card, item("B0KEEP0001", { price: 9, percent: 40 }), today).reason, "still_live");
  assert.equal(verdictForDeal(
    deal({ id: "pan", url: "https://www.amazon.com/Some-Pan/dp/B0PAN00001/ref=sr" }),
    null,
    today,
  ).reason, "not_found");
  assert.equal(asinFromDeal(deal()), "B0KEEP0001");
  assert.equal(asinFromDeal(deal({
    id: "skillet",
    url: "https://www.amazon.com/gp/product/B0PAN00001",
  })), "B0PAN00001");
  assert.equal(asinFromDeal(deal({ id: "note", url: "https://www.amazon.com/s?k=pans" })), null);
});

test("a verified deal is hidden on the site and in the feed, including after refresh", () => {
  const handwritten = deal({ id: "skillet", source: undefined, verifiedDead: true, inStock: false });
  const api = deal({ verifiedDead: true, inStock: false });
  const merged = mergeApiDeals([api, handwritten], new Map(), today);
  assert.deepEqual(merged.map((entry) => entry.id), ["skillet"]);
  assert.equal(isActiveDeal(handwritten, today), false);
  assert.deepEqual(visibleDeals(merged, today), []);
  const feed = buildFeedXml([api, deal({ id: "B0LIVE0001", url: "https://www.amazon.com/dp/B0LIVE0001" })], { today });
  assert.equal(feed.includes("B0KEEP0001"), false);
  assert.equal(feed.includes("B0LIVE0001"), true);

  const applied = applyVerifiedDead({ about: "keep", deals: [deal(), handwritten] }, ["B0KEEP0001"]);
  assert.equal(applied.changed, true);
  assert.equal(applied.payload.about, "keep");
  assert.equal(applied.payload.deals[0].verifiedDead, true);
  assert.equal(applied.payload.deals[0].inStock, false);
  assert.equal(applyVerifiedDead(applied.payload, ["B0KEEP0001"]).changed, false);
});

test("threshold reports are checked with Amazon and a 429 does not mark the deal dead", async () => {
  const env = workerEnv();
  await seedVotes(env, "B0KEEP0001");
  await seedVotes(env, "B0LIVE0001");
  const { calls, fetchImpl } = routeFetch(env, async (url, options) => {
    if (String(url).includes("/auth/o2/token")) {
      return { ok: true, status: 200, json: async () => ({ access_token: "token-value-do-not-print" }) };
    }
    const body = JSON.parse(options.body);
    const items = body.itemIds.map((asin) => {
      if (asin === "B0KEEP0001") return item(asin, { availability: "OUT_OF_STOCK" });
      return item(asin, { price: 9, percent: 40 });
    });
    return { ok: true, status: 200, json: async () => ({ itemsResult: { items } }) };
  });

  const dir = mkdtempSync(join(tmpdir(), "rawdeals-verify-"));
  const dealsPath = join(dir, "deals.json");
  const liveDeal = deal({ id: "B0LIVE0001", url: "https://www.amazon.com/dp/B0LIVE0001" });
  const before = `${JSON.stringify({ about: "keep", deals: [deal(), liveDeal] }, null, 2)}\n`;
  writeFileSync(dealsPath, before);
  const result = await verifyFromDisk({
    dealsPath,
    env: {
      ...process.env,
      CREATORS_API_CREDENTIAL_ID: "credential-id",
      CREATORS_API_CREDENTIAL_SECRET: secret,
      CREATORS_API_CREDENTIAL_VERSION: "3.1",
      DEAD_DEALS_TOKEN: deadToken,
      DEAD_DEALS_API_URL: "https://api.getrawdeals.com",
    },
    fetchImpl,
    today,
    pauseMs: 0,
    sleep: async () => {},
  });
  assert.equal(result.amazonError, null);
  assert.equal(result.changed, true);
  const written = JSON.parse(readFileSync(dealsPath, "utf8"));
  const dead = written.deals.find((entry) => entry.id === "B0KEEP0001");
  const live = written.deals.find((entry) => entry.id === "B0LIVE0001");
  assert.equal(dead.verifiedDead, true);
  assert.equal(dead.inStock, false);
  assert.equal(live.verifiedDead, undefined);
  assert.equal(visibleDeals(written.deals, today).map((entry) => entry.id).includes("B0KEEP0001"), false);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(calls.some((href) => href.includes("/api/dead-deals/verdicts")), true);

  const limited = workerEnv();
  await seedVotes(limited, "B0KEEP0001");
  const limitedFetch = routeFetch(limited, async (url) => {
    if (String(url).includes("/auth/o2/token")) {
      return { ok: true, status: 200, json: async () => ({ access_token: "token-value-do-not-print" }) };
    }
    return { ok: false, status: 429, json: async () => ({ message: `${secret} ${deadToken}` }) };
  });
  const unchanged = `${JSON.stringify({ about: "keep", deals: [deal()] }, null, 2)}\n`;
  const limitedPath = join(dir, "limited.json");
  writeFileSync(limitedPath, unchanged);
  const failed = await verifyFromDisk({
    dealsPath: limitedPath,
    env: {
      CREATORS_API_CREDENTIAL_ID: "credential-id",
      CREATORS_API_CREDENTIAL_SECRET: secret,
      DEAD_DEALS_TOKEN: deadToken,
      DEAD_DEALS_API_URL: "https://api.getrawdeals.com",
    },
    fetchImpl: limitedFetch.fetchImpl,
    today,
    pauseMs: 0,
    sleep: async () => {},
  });
  assert.match(failed.amazonError, /GetItems request failed \(429\)/);
  assert.equal(failed.amazonError.includes(secret), false);
  assert.equal(failed.amazonError.includes(deadToken), false);
  assert.equal(failed.changed, false);
  assert.equal(readFileSync(limitedPath, "utf8"), unchanged);
  assert.equal(limitedFetch.calls.some((href) => href.includes("/verdicts")), false);
  rmSync(dir, { recursive: true, force: true });
});

test("an unknown report cools down without an Amazon call, and missing credentials send nothing", async () => {
  const env = workerEnv();
  await seedVotes(env, "not-a-real-deal");
  let amazonCalled = false;
  const { fetchImpl } = routeFetch(env, async () => {
    amazonCalled = true;
    throw new Error("Amazon should not be called");
  });
  const result = await verifyPendingDeals({
    apiBase: "https://api.getrawdeals.com",
    token: deadToken,
    deals: [deal()],
    env: {
      CREATORS_API_CREDENTIAL_ID: "credential-id",
      CREATORS_API_CREDENTIAL_SECRET: secret,
      DEAD_DEALS_TOKEN: deadToken,
    },
    fetchImpl,
    today,
    pauseMs: 0,
    sleep: async () => {},
  });
  assert.equal(amazonCalled, false);
  assert.deepEqual(result.verdicts, [{ id: "not-a-real-deal", dead: false, reason: "unknown" }]);
  const cooled = await handleDeadDeals(new Request("https://api.getrawdeals.com/api/dead-deals", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-visitor-id": visitorId(4),
      "cf-connecting-ip": "203.0.113.40",
    },
    body: JSON.stringify({ id: "not-a-real-deal" }),
  }), env, { now: () => new Date(now.getTime() + 1000) });
  assert.equal((await cooled.json()).reason, "cooldown");

  let called = false;
  const skipped = await verifyPendingDeals({
    apiBase: "https://api.getrawdeals.com",
    token: "",
    deals: [],
    env: {},
    fetchImpl: () => { called = true; throw new Error("should not be called"); },
    today,
  });
  assert.equal(skipped.skipped, true);
  assert.equal(called, false);
});

test("the command skips cleanly when the token is unset and does not print secrets", () => {
  const dealsBefore = read("data/deals.json");
  const run = spawnSync(process.execPath, ["scripts/verify-dead-deals.js"], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH, DEAD_DEALS_TOKEN: "", CREATORS_API_CREDENTIAL_SECRET: secret },
  });
  assert.equal(run.status, 0);
  assert.match(`${run.stdout}\n${run.stderr}`, /No request was sent/);
  assert.equal(`${run.stdout}${run.stderr}`.includes(secret), false);
  assert.equal(read("data/deals.json"), dealsBefore);
  const source = read("scripts/verify-dead-deals.js");
  assert.equal(source.includes("console.log(process.env"), false);
  assert.equal(source.includes("node:http"), false);
  assert.equal(source.includes("node:https"), false);
});
