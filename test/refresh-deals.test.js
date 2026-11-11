import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ASSOCIATE_TAG } from "../js/affiliate.js";
import {
  chunkList,
  fetchCreatorsItems,
  loadAsinEntries,
  mergeApiDeals,
  redactSecrets,
  refreshDealsFile,
} from "../scripts/fetch-deals.js";

const secret = "super-secret-value-do-not-print";

function sampleDeal(overrides = {}) {
  return {
    id: "ex-studio-earbuds",
    title: "EXAMPLE Studio Earbuds",
    image: "images/samples/electronics.svg",
    price: 24.99,
    originalPrice: 49.99,
    percentOff: 50,
    promoCode: "RAWSAMPLE",
    category: "Electronics",
    url: "https://www.amazon.com/s?k=EXAMPLE%20Studio%20Earbuds",
    added: "2026-11-01",
    expires: "2026-11-01",
    sample: true,
    ...overrides,
  };
}

function apiDeal(overrides = {}) {
  return {
    id: "B0KEEP000001",
    title: "Kept widget",
    image: "https://m.media-amazon.com/images/I/old.jpg",
    price: 12,
    originalPrice: 20,
    percentOff: 40,
    category: "Home",
    url: "https://www.amazon.com/dp/B0KEEP000001",
    added: "2026-11-01",
    sample: false,
    source: "api",
    ...overrides,
  };
}

function creatorsItem({
  asin,
  price = 9,
  original = 18,
  percent = 50,
  image = "https://m.media-amazon.com/images/I/new.jpg",
  title = "API title",
  violatesMAP = false,
  listings = null,
  end,
}) {
  const listing = violatesMAP
    ? { isBuyBoxWinner: true, violatesMAP: true, price: { money: { amount: price } } }
    : {
        isBuyBoxWinner: true,
        violatesMAP: false,
        price: {
          money: { amount: price },
          ...(original == null ? {} : { savingBasis: { money: { amount: original } } }),
          savings: { percentage: percent },
        },
        ...(end ? { dealDetails: { endTime: `${end}T05:00:00Z` } } : {}),
      };
  return {
    asin,
    detailPageURL: `https://www.amazon.com/dp/${asin}?tag=example`,
    images: { primary: { large: { url: image } } },
    itemInfo: { title: { displayValue: title } },
    offersV2: { listings: listings ?? [listing] },
  };
}

function mockFetch(itemsByAsin, { failToken = false, failItems = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (String(url).includes("/auth/o2/token")) {
      if (failToken) return { ok: false, status: 401, json: async () => ({ message: secret }) };
      return { ok: true, json: async () => ({ access_token: "token-value-do-not-print" }) };
    }
    if (failItems) throw new Error(`GetItems blew up ${secret}`);
    const body = JSON.parse(options.body);
    assert.ok(body.itemIds.length <= 10);
    assert.equal(body.partnerTag, ASSOCIATE_TAG);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        itemsResult: {
          items: body.itemIds.map((asin) => itemsByAsin[asin]).filter(Boolean),
        },
      }),
    };
  };
  return { calls, fetchImpl };
}

test("merge keeps hand-written deals and refreshes API price, image, and added date", () => {
  const handwritten = sampleDeal({ added: "2026-11-08" });
  const existingApi = apiDeal({ added: "2026-11-05" });
  const updates = new Map([
    ["B0KEEP000001", apiDeal({
      price: 8,
      originalPrice: 16,
      percentOff: 50,
      image: "https://m.media-amazon.com/images/I/new.jpg",
      added: "2026-11-05",
    })],
    ["B0NEW0000001", apiDeal({
      id: "B0NEW0000001",
      title: "New widget",
      price: 5,
      added: "2026-11-09",
      image: "https://m.media-amazon.com/images/I/brand-new.jpg",
    })],
  ]);
  const merged = mergeApiDeals([existingApi, handwritten], updates, "2026-11-09");
  assert.equal(merged[0].id, "B0NEW0000001");
  assert.equal(merged[1].id, "B0KEEP000001");
  assert.equal(merged[1].price, 8);
  assert.equal(merged[1].originalPrice, 16);
  assert.equal(merged[1].image, "https://m.media-amazon.com/images/I/new.jpg");
  assert.equal(merged[1].added, "2026-11-05");
  assert.deepEqual(merged[2], handwritten);
});

test("expired API deals are dropped and expired hand-written deals stay", () => {
  const handwritten = sampleDeal({ added: "2026-11-07" });
  const expiredApi = apiDeal({ id: "B0OLD0000001", expires: "2026-11-08" });
  const updates = new Map([
    ["B0KEEP000001", null],
    ["B0GONE000001", apiDeal({ id: "B0GONE000001", expires: "2026-11-08", added: "2026-11-09" })],
  ]);
  const merged = mergeApiDeals(
    [apiDeal(), expiredApi, handwritten],
    updates,
    "2026-11-09",
  );
  assert.deepEqual(merged.map((deal) => deal.id), [handwritten.id]);
  assert.deepEqual(merged[0], handwritten);
});

test("empty ASIN list does not call the network or change deals.json", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rawdeals-empty-"));
  const dealsPath = join(dir, "deals.json");
  const body = `${JSON.stringify({ about: "keep", deals: [sampleDeal()] }, null, 2)}\n`;
  writeFileSync(dealsPath, body);
  writeFileSync(join(dir, "asins.json"), "[]\n");
  let called = false;
  const result = await refreshDealsFile({
    asinsPath: join(dir, "asins.json"),
    dealsPath,
    env: {},
    fetchImpl: () => { called = true; throw new Error("should not be called"); },
    today: "2026-11-09",
  });
  assert.equal(result.reason, "empty");
  assert.equal(called, false);
  assert.equal(readFileSync(dealsPath, "utf8"), body);
  rmSync(dir, { recursive: true, force: true });
});

test("a failed Creators API call leaves deals.json bytes unchanged and hides the secret", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rawdeals-fail-"));
  const dealsPath = join(dir, "deals.json");
  const body = `${JSON.stringify({ about: "keep", deals: [sampleDeal(), apiDeal()] }, null, 2)}\n`;
  writeFileSync(dealsPath, body);
  writeFileSync(join(dir, "asins.json"), JSON.stringify([{ asin: "B0KEEP000001", category: "Home" }]));
  const { fetchImpl } = mockFetch({}, { failToken: true });
  await assert.rejects(
    () => refreshDealsFile({
      asinsPath: join(dir, "asins.json"),
      dealsPath,
      env: {
        CREATORS_API_CREDENTIAL_ID: "credential-id",
        CREATORS_API_CREDENTIAL_SECRET: secret,
        CREATORS_API_CREDENTIAL_VERSION: "3.1",
      },
      fetchImpl,
      today: "2026-11-09",
    }),
    (error) => {
      assert.equal(error.message.includes(secret), false);
      assert.match(error.message, /token request failed \(401\)/);
      return true;
    },
  );
  assert.equal(readFileSync(dealsPath, "utf8"), body);
  rmSync(dir, { recursive: true, force: true });
});

test("live refresh merges API deals, drops MAP and expiry, and keeps samples", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rawdeals-live-"));
  const handwritten = sampleDeal({ added: "2026-11-08", expires: "2026-11-20" });
  const ancient = sampleDeal({ id: "ex-ancient", added: "2026-11-01", expires: "2026-11-02" });
  const existing = apiDeal({ added: "2026-11-05" });
  const dealsPath = join(dir, "deals.json");
  writeFileSync(dealsPath, `${JSON.stringify({ about: "keep", deals: [existing, handwritten, ancient] }, null, 2)}\n`);
  const asins = [
    { asin: "B0KEEP000001", category: "Home", promoCode: "KEEP10" },
    { asin: "B0NEW0000001", category: "Outdoors", title: "Override title" },
    { asin: "B0MAP0000001", category: "Kitchen" },
    { asin: "B0END0000001", category: "Toys", expires: "2026-11-08" },
    ...Array.from({ length: 8 }, (_, index) => ({ asin: `B0EXTRA00000${index}`, category: "Home" })),
  ];
  writeFileSync(join(dir, "asins.json"), JSON.stringify(asins));
  const items = {
    B0KEEP000001: creatorsItem({ asin: "B0KEEP000001", price: 7, original: 14, percent: 50, image: "https://m.media-amazon.com/images/I/kept.jpg", title: "Fresh title" }),
    B0NEW0000001: creatorsItem({ asin: "B0NEW0000001", price: 4, original: 8, percent: 50, title: "API title" }),
    B0MAP0000001: creatorsItem({ asin: "B0MAP0000001", violatesMAP: true }),
    B0END0000001: creatorsItem({ asin: "B0END0000001", end: "2026-12-01" }),
  };
  for (const entry of asins) {
    if (!items[entry.asin]) items[entry.asin] = creatorsItem({ asin: entry.asin, price: 3, original: 6, percent: 50 });
  }
  const { calls, fetchImpl } = mockFetch(items);
  const result = await refreshDealsFile({
    asinsPath: join(dir, "asins.json"),
    dealsPath,
    env: {
      CREATORS_API_CREDENTIAL_ID: "credential-id",
      CREATORS_API_CREDENTIAL_SECRET: secret,
    },
    fetchImpl,
    today: "2026-11-09",
    partnerTag: ASSOCIATE_TAG,
  });
  assert.equal(result.changed, true);
  const itemCalls = calls.filter((call) => call.url.includes("getItems"));
  assert.equal(calls.filter((call) => String(call.url).includes("/auth/o2/token")).length, 1);
  assert.equal(itemCalls.length, 2);
  assert.deepEqual(itemCalls.map((call) => JSON.parse(call.options.body).itemIds.length), [10, 2]);
  const written = JSON.parse(readFileSync(dealsPath, "utf8"));
  const kept = written.deals.find((deal) => deal.id === "B0KEEP000001");
  const created = written.deals.find((deal) => deal.id === "B0NEW0000001");
  const sample = written.deals.find((deal) => deal.id === handwritten.id);
  assert.equal(kept.price, 7);
  assert.equal(kept.originalPrice, 14);
  assert.equal(kept.percentOff, 50);
  assert.equal(kept.image, "https://m.media-amazon.com/images/I/kept.jpg");
  assert.equal(kept.added, "2026-11-05");
  assert.equal(kept.title, "Kept widget");
  assert.equal(kept.promoCode, "KEEP10");
  assert.equal(kept.source, "api");
  assert.equal(created.added, "2026-11-09");
  assert.equal(created.title, "Override title");
  assert.equal(created.source, "api");
  assert.equal(written.deals.some((deal) => deal.id === "B0MAP0000001"), false);
  assert.equal(written.deals.some((deal) => deal.id === "B0END0000001"), false);
  assert.equal(written.deals.some((deal) => deal.id === "ex-ancient"), false);
  assert.deepEqual(sample, handwritten);
  assert.equal(JSON.stringify(written).includes(secret), false);
  rmSync(dir, { recursive: true, force: true });
});

test("missing credentials and GetItems failures do not reveal secrets", async () => {
  let called = false;
  await assert.rejects(
    () => fetchCreatorsItems({
      entries: [{ asin: "B0TEST000001" }],
      env: {},
      fetchImpl: () => { called = true; },
      partnerTag: ASSOCIATE_TAG,
    }),
    /No request was sent/,
  );
  assert.equal(called, false);

  const { fetchImpl } = mockFetch({}, { failItems: true });
  await assert.rejects(
    () => fetchCreatorsItems({
      entries: [{ asin: "B0TEST000001" }],
      env: {
        CREATORS_API_CREDENTIAL_ID: "credential-id",
        CREATORS_API_CREDENTIAL_SECRET: secret,
      },
      fetchImpl,
      partnerTag: ASSOCIATE_TAG,
    }),
    (error) => {
      assert.equal(error.message.includes(secret), false);
      assert.match(error.message, /\[redacted\]/);
      return true;
    },
  );
  assert.equal(redactSecrets(`token ${secret}`, [secret]).includes(secret), false);
  assert.deepEqual(chunkList([1, 2, 3], 2), [[1, 2], [3]]);
  assert.deepEqual(loadAsinEntries([]), []);
});
