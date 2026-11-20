import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ASSOCIATE_TAG } from "../js/affiliate.js";
import {
  ASIN_BATCH_SIZE,
  GET_ITEMS_RESOURCES,
  mapCreatorsItemToDeal,
} from "../scripts/fetch-deals.js";
import {
  DISCORD_FOOTER,
  DISCORD_SUPPRESS_EMBEDS,
  DISCORD_USERNAME,
  formatPriceCheckMessages,
  postPriceCheck,
} from "../scripts/post-discord.js";
import {
  decidePriceCheck,
  isPriceCheckCandidate,
  priceCheckDeals,
  priceCheckFile,
  priceCheckPlan,
  readLiveOffer,
  retainPriceCheckRuns,
} from "../scripts/price-check.js";
import { validatePayload } from "../scripts/validate-deals.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const secret = "super-secret-value-do-not-print";
const checkedAt = "2026-11-18T17:00:00.000Z";
const today = "2026-11-18";
const minDiscountPercent = 20;
const fixture = JSON.parse(readFileSync(join(root, "scripts/fixtures/price-check-get-items.json"), "utf8"));
const fixtureItems = new Map(fixture.itemsResult.items.map((item) => [item.asin, item]));

function posted(overrides = {}) {
  return {
    id: "B00T7PCQBK",
    title: "Mrs. Meyer's Clean Day Lavender Multi-Surface Everyday Cleaner",
    image: "https://m.media-amazon.com/images/I/lavender.jpg",
    price: 1.95,
    originalPrice: 6.49,
    percentOff: 70,
    category: "Household",
    url: "https://www.amazon.com/dp/B00T7PCQBK?tag=eddie060-20&linkCode=osi&th=1&psc=1",
    added: "2026-11-17",
    sample: false,
    source: "api",
    discovered: true,
    features: ["Plant-derived cleaning ingredients."],
    ...overrides,
  };
}

function options(extra = {}) {
  return { checkedAt, today, minDiscountPercent, ...extra };
}

function offerItem({
  asin,
  price = 10,
  original = 20,
  percent = 50,
  availability = "IN_STOCK",
  violatesMAP = false,
  end,
  listings,
}) {
  const listing = {
    isBuyBoxWinner: true,
    violatesMAP,
    availability: { type: availability },
    price: {
      money: { amount: price },
      ...(original == null ? {} : { savingBasis: { money: { amount: original } } }),
      ...(percent == null ? {} : { savings: { percentage: percent } }),
    },
    ...(end ? { dealDetails: { endTime: `${end}T05:00:00Z` } } : {}),
  };
  return {
    asin,
    detailPageURL: `https://www.amazon.com/dp/${asin}?tag=example`,
    itemInfo: { title: { displayValue: "API title that must not replace the posted title" } },
    offersV2: { listings: listings ?? [listing] },
  };
}

test("the fixture buy box is the live price, list price, and savings percent", () => {
  const item = fixtureItems.get("B00T7PCQBK");
  const mapped = mapCreatorsItemToDeal(item, {}, today);
  const live = readLiveOffer(item);
  assert.equal(live.status, "ok");
  assert.equal(live.price, 4.99);
  assert.equal(live.originalPrice, 6.49);
  assert.equal(live.percentOff, 23);
  assert.equal(live.price, mapped.price);
  assert.equal(live.originalPrice, mapped.originalPrice);
  assert.equal(live.percentOff, mapped.percentOff);
  assert.notEqual(live.price, 1.95);
});

test("a still-qualified price change updates price fields, stamps lastChecked, and logs the old and new values", () => {
  const deal = posted();
  const decision = decidePriceCheck(deal, fixtureItems.get(deal.id), options());
  assert.equal(decision.action, "updated");
  assert.equal(decision.deal.price, 4.99);
  assert.equal(decision.deal.originalPrice, 6.49);
  assert.equal(decision.deal.percentOff, 23);
  assert.equal(decision.deal.lastChecked, checkedAt);
  assert.equal(decision.deal.title, deal.title);
  assert.equal(decision.deal.url, deal.url);
  assert.equal(decision.deal.added, deal.added);
  assert.equal(decision.deal.image, deal.image);
  assert.deepEqual(decision.deal.features, deal.features);
  assert.equal(decision.deal.discovered, true);
  assert.deepEqual(decision.change, {
    asin: "B00T7PCQBK",
    title: deal.title,
    url: deal.url,
    oldPrice: 1.95,
    newPrice: 4.99,
    oldPercentOff: 70,
    newPercentOff: 23,
    action: "updated",
    reason: "price changed",
  });
});

test("an unchanged price is stamped and left out of the change log", () => {
  const deal = posted({ price: 4.99, originalPrice: 6.49, percentOff: 23 });
  const decision = decidePriceCheck(deal, fixtureItems.get(deal.id), options());
  assert.equal(decision.action, "unchanged");
  assert.equal(decision.change, undefined);
  assert.equal(decision.deal.lastChecked, checkedAt);
  assert.equal(decision.deal.price, 4.99);
  assert.equal(decision.deal.title, deal.title);
});

test("a discovered deal under the refresh minimum is removed and the log keeps both prices", () => {
  const deal = posted({ id: "B0LOW00001", price: 1.95, percentOff: 70 });
  const item = offerItem({ asin: deal.id, price: 5.99, original: 6.49, percent: 8 });
  const decision = decidePriceCheck(deal, item, options());
  assert.equal(decision.action, "removed");
  assert.equal(decision.deal, undefined);
  assert.equal(decision.change.action, "removed");
  assert.equal(decision.change.reason, "discount below the minimum");
  assert.equal(decision.change.oldPrice, 1.95);
  assert.equal(decision.change.newPrice, 5.99);
  assert.equal(decision.change.oldPercentOff, 70);
  assert.equal(decision.change.newPercentOff, 8);
});

test("a hand-picked ASIN stays while any discount remains, and a promo code keeps a 0% price", () => {
  const listed = posted({ id: "B0LISTED01", price: 40, originalPrice: 50, percentOff: 20, discovered: undefined });
  const stillOnSale = decidePriceCheck(
    listed,
    offerItem({ asin: listed.id, price: 45, original: 50, percent: 10 }),
    options({ listed: true }),
  );
  assert.equal(stillOnSale.action, "updated");
  assert.equal(stillOnSale.deal.price, 45);
  assert.equal(stillOnSale.deal.percentOff, 10);

  const flat = decidePriceCheck(
    posted({ id: "B0FLAT0001", price: 10, originalPrice: 10, percentOff: 20 }),
    offerItem({ asin: "B0FLAT0001", price: 10, original: null, percent: 0 }),
    options({ listed: true }),
  );
  assert.equal(flat.action, "removed");
  assert.equal(flat.change.reason, "discount below the minimum");

  const coded = posted({
    id: "B0CODE0001",
    price: 12,
    originalPrice: 12,
    percentOff: 40,
    promoCode: "SAVE10",
  });
  const kept = decidePriceCheck(
    coded,
    offerItem({ asin: coded.id, price: 11, original: null, percent: 0 }),
    options({ listed: true }),
  );
  assert.equal(kept.action, "updated");
  assert.equal(kept.deal.price, 11);
  assert.equal(kept.deal.percentOff, 0);
  assert.equal(kept.deal.originalPrice, undefined);
  assert.equal(kept.deal.promoCode, "SAVE10");
});

test("no offer, MAP, out of stock, and a passed end date remove the deal", () => {
  const oos = decidePriceCheck(posted({ id: "B0OOS00001", price: 4, percentOff: 50 }), fixtureItems.get("B0OOS00001"), options());
  assert.equal(oos.action, "unavailable");
  assert.equal(oos.change.reason, "out of stock or unavailable");
  assert.equal(oos.change.oldPrice, 4);
  assert.equal(oos.change.newPrice, 3.5);
  assert.equal(oos.change.newPercentOff, 50);

  const map = decidePriceCheck(posted({ id: "B0MAP00001" }), fixtureItems.get("B0MAP00001"), options());
  assert.equal(map.action, "removed");
  assert.equal(map.change.reason, "violates MAP");
  assert.equal(map.change.newPrice, null);
  assert.equal(map.change.newPercentOff, null);

  const none = decidePriceCheck(posted({ id: "B0NONE0001" }), fixtureItems.get("B0NONE0001"), options());
  assert.equal(none.action, "removed");
  assert.equal(none.change.reason, "no buyable offer");
  assert.equal(none.change.newPrice, null);

  const missing = decidePriceCheck(posted({ id: "B0MISSING1" }), undefined, options());
  assert.equal(missing.action, "removed");
  assert.equal(missing.change.reason, "not returned by the Creators API");

  const ended = decidePriceCheck(
    posted({ id: "B0ENDED001" }),
    offerItem({ asin: "B0ENDED001", price: 4, original: 8, percent: 50, end: "2026-11-17" }),
    options(),
  );
  assert.equal(ended.action, "removed");
  assert.equal(ended.change.reason, "deal ended");
  assert.equal(ended.change.newPrice, 4);

  const endsToday = decidePriceCheck(
    posted({ id: "B0TODAY001" }),
    offerItem({ asin: "B0TODAY001", price: 1.95, original: 6.49, percent: 70, end: today }),
    options(),
  );
  assert.equal(endsToday.action, "unchanged");
});

test("hand-written, sample, and uncovered promo-code deals are left alone", () => {
  const sample = posted({
    id: "ex-studio-earbuds",
    title: "EXAMPLE Studio Earbuds",
    sample: true,
    source: undefined,
    price: 24.99,
  });
  const handwritten = posted({
    id: "hand-skillet",
    title: "10-inch skillet",
    source: undefined,
    sample: false,
    price: 29.99,
    originalPrice: 44.99,
    percentOff: 33,
  });
  assert.equal(isPriceCheckCandidate(sample), false);
  assert.equal(isPriceCheckCandidate(handwritten), false);
  assert.equal(decidePriceCheck(sample, fixtureItems.get("B00T7PCQBK"), options()).deal, sample);
  assert.equal(decidePriceCheck(handwritten, undefined, options()).deal, handwritten);

  const promo = posted({
    id: "B0CODEONLY",
    origin: "amazonoffercode",
    promoCode: "LAV20",
    price: 8,
    originalPrice: 16,
    percentOff: 50,
  });
  const priced = decidePriceCheck(
    promo,
    offerItem({ asin: promo.id, price: 14, original: 16, percent: 12 }),
    options(),
  );
  assert.equal(priced.action, "unchanged");
  assert.equal(priced.deal.price, 8);
  assert.equal(priced.deal.originalPrice, 16);
  assert.equal(priced.deal.percentOff, 50);
  assert.equal(priced.deal.promoCode, "LAV20");
  assert.equal(priced.deal.lastChecked, checkedAt);
  assert.equal(priced.change, undefined);

  const missed = decidePriceCheck(promo, undefined, options());
  assert.equal(missed.action, "skip");
  assert.equal(missed.deal, promo);
  assert.equal(missed.deal.lastChecked, undefined);

  const stock = decidePriceCheck(promo, fixtureItems.get("B0OOS00001"), options());
  assert.equal(stock.action, "unavailable");
});

test("the sweep does not add ASINs and drops originalPrice when the list price is gone", () => {
  const extra = offerItem({ asin: "B0EXTRANEW", price: 5, original: 15, percent: 67 });
  const bare = offerItem({ asin: "B00T7PCQBK", price: 5, original: null, percent: 40 });
  const result = priceCheckDeals(
    [posted(), posted({ id: "hand-skillet", title: "10-inch skillet", source: undefined })],
    new Map([[extra.asin, extra], ["B00T7PCQBK", bare]]),
    options(),
  );
  assert.deepEqual(result.deals.map((deal) => deal.id), ["B00T7PCQBK", "hand-skillet"]);
  assert.equal(result.deals[0].price, 5);
  assert.equal(result.deals[0].percentOff, 40);
  assert.equal(result.deals[0].originalPrice, undefined);
  assert.equal(result.deals[1].lastChecked, undefined);
  assert.equal(result.run.updated, 1);
  assert.equal(result.run.skipped, 1);
  assert.equal(result.run.checked, 1);
  assert.equal(result.run.changes.length, 1);
});

test("price-check log keeps the last 30 days", () => {
  const recent = { checkedAt: "2026-10-20T17:00:00.000Z", changes: [{ asin: "B0KEEPOLD01" }] };
  const runs = retainPriceCheckRuns([
    { checkedAt: "2026-10-17T17:00:00.000Z", changes: [] },
    { checkedAt: "not-a-date", changes: [] },
    recent,
    { checkedAt, changes: [] },
  ], checkedAt);
  assert.deepEqual(runs.map((run) => run.checkedAt), [recent.checkedAt, checkedAt]);
  assert.equal(retainPriceCheckRuns([
    { checkedAt: "2026-11-16T00:00:00.000Z" },
    { checkedAt: "2026-11-17T00:00:00.000Z" },
    { checkedAt: "2026-11-18T00:00:00.000Z" },
  ], checkedAt, { maxRuns: 2 }).length, 2);
});

test("lastChecked is allowed only as an ISO timestamp", () => {
  const deal = posted({ lastChecked: checkedAt });
  const fileExists = () => true;
  assert.deepEqual(validatePayload({ deals: [deal] }, { fileExists }), []);
  const bad = validatePayload({ deals: [posted({ lastChecked: "2026-11-18" })] }, { fileExists });
  assert.equal(bad.some((error) => error.includes("lastChecked")), true);
  const worse = validatePayload({ deals: [posted({ lastChecked: "yesterday" })] }, { fileExists });
  assert.equal(worse.some((error) => error.includes("lastChecked")), true);
});

test("the Discord note lists price changes and expirations and does not announce new deals", async () => {
  const run = {
    checkedAt,
    changes: [
      {
        asin: "B00T7PCQBK",
        title: "Mrs. Meyer's Lavender spray",
        url: "https://www.amazon.com/dp/B00T7PCQBK?tag=eddie060-20",
        oldPrice: 1.95,
        newPrice: 4.99,
        oldPercentOff: 70,
        newPercentOff: 23,
        action: "updated",
      },
      {
        asin: "B0LAMP0001",
        title: "Desk lamp",
        url: "https://www.amazon.com/dp/B0LAMP0001",
        oldPrice: 12,
        newPrice: null,
        oldPercentOff: 40,
        newPercentOff: null,
        action: "removed",
      },
      {
        asin: "B0SOUP0001",
        title: "Soup",
        url: "https://www.amazon.com/dp/B0SOUP0001",
        oldPrice: 9,
        newPrice: 3.5,
        oldPercentOff: 30,
        newPercentOff: 50,
        action: "unavailable",
      },
    ],
  };
  const messages = formatPriceCheckMessages(run, { today });
  assert.deepEqual(messages, [
    [
      "Price check — Nov 18",
      "",
      "**[Mrs. Meyer's Lavender spray](<https://www.amazon.com/dp/B00T7PCQBK?tag=eddie060-20>)** — $1.95 (70% off) → $4.99 (23% off)",
      "",
      "**[Desk lamp](<https://www.amazon.com/dp/B0LAMP0001>)** — was $12 (40% off), expired",
      "",
      "**[Soup](<https://www.amazon.com/dp/B0SOUP0001>)** — $9 (30% off) → $3.50 (50% off), out of stock",
      "",
      DISCORD_FOOTER,
    ].join("\n"),
  ]);
  assert.equal(messages[0].includes("Raw's Daily Deals"), false);
  assert.equal(messages[0].includes("🔥"), false);

  let called = false;
  const skipped = await postPriceCheck({ changes: [] }, {
    webhookUrl: secret,
    fetchImpl: async () => {
      called = true;
      throw new Error(`should not post ${secret}`);
    },
  });
  assert.deepEqual(skipped, { skipped: true, reason: "no price changes", posted: 0 });
  assert.equal(called, false);

  const bodies = [];
  const postedNote = await postPriceCheck(run, {
    today,
    webhookUrl: secret,
    fetchImpl: async (url, request) => {
      assert.equal(url, secret);
      const body = JSON.parse(request.body);
      bodies.push(body);
      assert.equal(body.flags, DISCORD_SUPPRESS_EMBEDS);
      assert.equal(body.username, DISCORD_USERNAME);
      assert.equal(JSON.stringify(body).includes(secret), false);
      return { ok: true, status: 204, json: async () => ({}) };
    },
  });
  assert.equal(postedNote.posted, 1);
  assert.equal(bodies[0].content, messages[0]);
});

test("a failed or unauthenticated sweep does not write deals or the log and hides the secret", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rawdeals-price-fail-"));
  try {
    const dealsPath = join(dir, "deals.json");
    const logPath = join(dir, "price-checks.json");
    const body = `${JSON.stringify({ about: "keep", deals: [posted()] }, null, 2)}\n`;
    writeFileSync(dealsPath, body);
    writeFileSync(join(dir, "asins.json"), "[]\n");
    writeFileSync(join(dir, "discovery.json"), JSON.stringify({
      minDiscountPercent: 20,
      minRating: 4,
      maxDeals: 20,
      searches: [{ keywords: "should not run", category: "Household" }],
    }));
    const env = {
      CREATORS_API_CREDENTIAL_ID: "credential-id",
      CREATORS_API_CREDENTIAL_SECRET: secret,
      CREATORS_API_CREDENTIAL_VERSION: "3.1",
    };
    await assert.rejects(
      () => priceCheckFile({
        dealsPath,
        logPath,
        asinsPath: join(dir, "asins.json"),
        discoveryPath: join(dir, "discovery.json"),
        env,
        fetchImpl: async (url) => {
          if (String(url).includes("/auth/o2/token")) {
            return { ok: false, status: 401, json: async () => ({ message: secret }) };
          }
          throw new Error(`GetItems blew up ${secret}`);
        },
        now: new Date(checkedAt),
      }),
      (error) => {
        assert.equal(error.message.includes(secret), false);
        assert.match(error.message, /token request failed \(401\)/);
        return true;
      },
    );
    assert.equal(readFileSync(dealsPath, "utf8"), body);
    assert.equal(existsSync(logPath), false);

    let called = false;
    await assert.rejects(
      () => priceCheckFile({
        dealsPath,
        logPath,
        asinsPath: join(dir, "asins.json"),
        discoveryPath: join(dir, "discovery.json"),
        env: {},
        fetchImpl: () => {
          called = true;
          throw new Error(`network ${secret}`);
        },
        now: new Date(checkedAt),
      }),
      (error) => {
        assert.match(error.message, /No request was sent/);
        assert.equal(error.message.includes(secret), false);
        return true;
      },
    );
    assert.equal(called, false);
    assert.equal(readFileSync(dealsPath, "utf8"), body);
    assert.equal(existsSync(logPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a live sweep rechecks posted ASINs only, updates the log, and preserves hand-written deals", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rawdeals-price-ok-"));
  try {
    const sample = posted({
      id: "ex-studio-earbuds",
      title: "EXAMPLE Studio Earbuds",
      sample: true,
      source: undefined,
      price: 24.99,
      originalPrice: 49.99,
      percentOff: 50,
    });
    const handwritten = posted({
      id: "hand-skillet",
      title: "10-inch skillet",
      source: undefined,
      sample: false,
      price: 29.99,
      originalPrice: 44.99,
      percentOff: 33,
      discovered: undefined,
      features: undefined,
    });
    const low = posted({ id: "B0LOW00001" });
    const oos = posted({ id: "B0OOS00001", price: 4, originalPrice: 8, percentOff: 50 });
    const mapDeal = posted({ id: "B0MAP00001" });
    const none = posted({ id: "B0NONE0001" });
    const missing = posted({ id: "B0MISSING1" });
    const promo = posted({
      id: "B0CODEONLY",
      origin: "amazonoffercode",
      promoCode: "LAV20",
      price: 8,
      originalPrice: 16,
      percentOff: 50,
    });
    const listed = posted({
      id: "B0LISTED01",
      title: "Listed headphones",
      price: 40,
      originalPrice: 50,
      percentOff: 20,
      discovered: undefined,
      category: "Tech",
    });
    const fillers = Array.from({ length: 5 }, (_, index) => posted({
      id: `B0FILL000${index + 1}`,
      title: `Filler ${index + 1}`,
      price: 10,
      originalPrice: 20,
      percentOff: 50,
    }));
    const deals = [posted(), low, oos, mapDeal, none, missing, promo, listed, ...fillers, sample, handwritten];
    const dealsPath = join(dir, "deals.json");
    const logPath = join(dir, "price-checks.json");
    writeFileSync(dealsPath, `${JSON.stringify({ about: "keep", deals }, null, 2)}\n`);
    writeFileSync(join(dir, "asins.json"), JSON.stringify([
      { asin: "B0LISTED01", category: "Tech" },
      { asin: "B0NOTINFIL" },
    ]));
    writeFileSync(join(dir, "discovery.json"), JSON.stringify({
      minDiscountPercent: 20,
      minRating: 4,
      maxDeals: 20,
      searches: [{ keywords: "should not run", category: "Household" }],
    }));
    writeFileSync(logPath, `${JSON.stringify({
      runs: [
        { checkedAt: "2026-10-17T17:00:00.000Z", checked: 1, unchanged: 1, updated: 0, removed: 0, unavailable: 0, skipped: 0, changes: [] },
        { checkedAt: "2026-10-20T17:00:00.000Z", checked: 1, unchanged: 1, updated: 0, removed: 0, unavailable: 0, skipped: 0, changes: [{ asin: "B0KEEPOLD01" }] },
      ],
    }, null, 2)}\n`);

    const calls = [];
    const fetchImpl = async (url, request) => {
      calls.push({ url, request });
      if (String(url).includes("/auth/o2/token")) {
        return { ok: true, json: async () => ({ access_token: "token-value-do-not-print" }) };
      }
      if (String(url).includes("searchItems")) throw new Error("discovery must not run");
      const body = JSON.parse(request.body);
      assert.ok(body.itemIds.length <= ASIN_BATCH_SIZE);
      assert.equal(body.partnerTag, ASSOCIATE_TAG);
      assert.deepEqual(body.resources, GET_ITEMS_RESOURCES);
      const items = body.itemIds.map((asin) => {
        if (fixtureItems.has(asin)) return fixtureItems.get(asin);
        if (asin === "B0LOW00001") return offerItem({ asin, price: 5.99, original: 6.49, percent: 8 });
        if (asin === "B0CODEONLY") return offerItem({ asin, price: 14, original: 16, percent: 12 });
        if (asin === "B0LISTED01") return offerItem({ asin, price: 45, original: 50, percent: 10 });
        if (asin.startsWith("B0FILL")) return offerItem({ asin, price: 10, original: 20, percent: 50 });
        return null;
      }).filter(Boolean);
      items.push(offerItem({ asin: "B0EXTRANEW", price: 5, original: 15, percent: 67 }));
      return { ok: true, status: 200, json: async () => ({ itemsResult: { items } }) };
    };

    const result = await priceCheckFile({
      dealsPath,
      logPath,
      asinsPath: join(dir, "asins.json"),
      discoveryPath: join(dir, "discovery.json"),
      env: {
        CREATORS_API_CREDENTIAL_ID: "credential-id",
        CREATORS_API_CREDENTIAL_SECRET: secret,
        CREATORS_API_CREDENTIAL_VERSION: "3.1",
      },
      fetchImpl,
      now: new Date(checkedAt),
      partnerTag: ASSOCIATE_TAG,
    });

    const itemCalls = calls.filter((call) => String(call.url).includes("getItems"));
    assert.equal(calls.filter((call) => String(call.url).includes("/auth/o2/token")).length, 1);
    assert.equal(itemCalls.length, 2);
    const requested = itemCalls.flatMap((call) => JSON.parse(call.request.body).itemIds);
    assert.equal(requested.includes("hand-skillet"), false);
    assert.equal(requested.includes("ex-studio-earbuds"), false);
    assert.equal(requested.includes("B0NOTINFIL"), false);
    assert.equal(requested.includes("B0EXTRANEW"), false);
    assert.equal(new Set(requested).size, 13);

    assert.equal(result.material, true);
    assert.equal(result.dealsChanged, true);
    assert.equal(result.run.requests, 2);
    assert.equal(result.run.updated, 2);
    assert.equal(result.run.removed, 4);
    assert.equal(result.run.unavailable, 1);
    assert.equal(result.run.unchanged, 6);
    assert.equal(result.run.skipped, 2);
    assert.deepEqual(result.run.changes.map((change) => [change.asin, change.action]), [
      ["B00T7PCQBK", "updated"],
      ["B0LOW00001", "removed"],
      ["B0OOS00001", "unavailable"],
      ["B0MAP00001", "removed"],
      ["B0NONE0001", "removed"],
      ["B0MISSING1", "removed"],
      ["B0LISTED01", "updated"],
    ]);
    const mrs = result.run.changes[0];
    assert.equal(mrs.oldPrice, 1.95);
    assert.equal(mrs.newPrice, 4.99);
    assert.equal(mrs.oldPercentOff, 70);
    assert.equal(mrs.newPercentOff, 23);

    const written = JSON.parse(readFileSync(dealsPath, "utf8"));
    assert.equal(written.about, "keep");
    assert.equal(written.deals.some((deal) => deal.id === "B0EXTRANEW"), false);
    assert.equal(written.deals.some((deal) => deal.id === "B0NOTINFIL"), false);
    assert.equal(written.deals.some((deal) => deal.id === "B0LOW00001"), false);
    assert.equal(written.deals.some((deal) => deal.id === "B0OOS00001"), false);
    assert.equal(written.deals.some((deal) => deal.id === "B0MISSING1"), false);
    const savedMrs = written.deals.find((deal) => deal.id === "B00T7PCQBK");
    assert.equal(savedMrs.price, 4.99);
    assert.equal(savedMrs.originalPrice, 6.49);
    assert.equal(savedMrs.percentOff, 23);
    assert.equal(savedMrs.lastChecked, checkedAt);
    assert.equal(savedMrs.title, posted().title);
    const savedPromo = written.deals.find((deal) => deal.id === "B0CODEONLY");
    assert.equal(savedPromo.price, 8);
    assert.equal(savedPromo.lastChecked, checkedAt);
    const savedListed = written.deals.find((deal) => deal.id === "B0LISTED01");
    assert.equal(savedListed.price, 45);
    assert.equal(savedListed.percentOff, 10);
    assert.deepEqual(written.deals.find((deal) => deal.id === "hand-skillet"), JSON.parse(JSON.stringify(handwritten)));
    assert.deepEqual(written.deals.find((deal) => deal.id === "ex-studio-earbuds"), JSON.parse(JSON.stringify(sample)));
    assert.deepEqual(validatePayload(written, { fileExists: () => true }), []);

    const log = JSON.parse(readFileSync(logPath, "utf8"));
    assert.deepEqual(log.runs.map((run) => run.checkedAt), ["2026-10-20T17:00:00.000Z", checkedAt]);
    assert.equal(log.runs[0].changes[0].asin, "B0KEEPOLD01");
    assert.equal(JSON.stringify(written).includes(secret), false);
    assert.equal(JSON.stringify(log).includes(secret), false);
    assert.equal(JSON.stringify(written).includes("token-value-do-not-print"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the price-check workflow schedules Chicago hours without changing the morning refresh", () => {
  const workflow = readFileSync(join(root, ".github/workflows/price-check.yml"), "utf8");
  const morning = readFileSync(join(root, ".github/workflows/refresh-deals.yml"), "utf8");
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const crons = [
    "0 16 8-31 3 *",
    "0 16 * 4-10 *",
    "0 16 1-7 11 *",
    "0 17 * 1,2,12 *",
    "0 17 1-7 3 *",
    "0 17 8-30 11 *",
    "0 19 8-31 3 *",
    "0 19 * 4-10 *",
    "0 19 1-7 11 *",
    "0 20 * 1,2,12 *",
    "0 20 1-7 3 *",
    "0 20 8-30 11 *",
    "0 22 8-31 3 *",
    "0 22 * 4-10 *",
    "0 22 1-7 11 *",
    "0 23 * 1,2,12 *",
    "0 23 1-7 3 *",
    "0 23 8-30 11 *",
    "0 1 9-31 3 *",
    "0 1 * 4-10 *",
    "0 1 1-8 11 *",
    "0 2 * 1,2,12 *",
    "0 2 1-8 3 *",
    "0 2 9-30 11 *",
  ];
  for (const cron of crons) {
    assert.equal(workflow.includes(`- cron: "${cron}"`), true, cron);
    assert.equal(readme.includes(`\`${cron}\``), true, cron);
  }
  assert.equal(workflow.includes("workflow_dispatch"), true);
  assert.match(workflow, /group: refresh-deals/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.equal(workflow.includes("fetch-deals.js"), false);
  assert.equal(workflow.includes("post-discord.js"), false);
  assert.equal(workflow.includes("AMAZONOFFERCODE"), false);
  assert.equal(workflow.includes("node scripts/price-check.js --live"), true);
  assert.equal(workflow.includes("node scripts/price-check.js --discord"), true);
  const postAt = workflow.indexOf("Post price changes to Discord");
  assert.ok(postAt > workflow.indexOf("git push origin HEAD:main"));
  assert.equal(workflow.slice(0, postAt).includes("DISCORD_WEBHOOK_URL"), false);
  assert.match(morning, /cron: "0 13 \* \* \*"/);
  assert.equal(morning.includes("price-check.js"), false);
  assert.match(morning, /group: refresh-deals/);

  const plan = priceCheckPlan({
    deals: [posted(), posted({ id: "hand-skillet", source: undefined })],
    status: {
      idSet: true,
      secretSet: true,
      version: "3.1",
    },
    minDiscountPercent: 20,
  });
  assert.match(plan, /No request was sent/);
  assert.equal(plan.includes(secret), false);
});

test("dry run prints the plan and a live run without credentials does not touch the repo", () => {
  const dealsBefore = readFileSync(join(root, "data/deals.json"), "utf8");
  const logPath = join(root, "data/price-checks.json");
  const logBefore = existsSync(logPath);
  const dry = spawnSync(process.execPath, ["scripts/price-check.js"], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      CREATORS_API_CREDENTIAL_ID: "credential-id",
      CREATORS_API_CREDENTIAL_SECRET: secret,
    },
  });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /No request was sent/);
  assert.equal(`${dry.stdout}${dry.stderr}`.includes(secret), false);
  assert.equal(readFileSync(join(root, "data/deals.json"), "utf8"), dealsBefore);

  const live = spawnSync(process.execPath, ["scripts/price-check.js", "--live"], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  assert.equal(live.status, 1);
  assert.match(`${live.stdout}\n${live.stderr}`, /No request was sent/);
  assert.equal(`${live.stdout}${live.stderr}`.includes(secret), false);
  assert.equal(readFileSync(join(root, "data/deals.json"), "utf8"), dealsBefore);
  assert.equal(existsSync(logPath), logBefore);

  const logBytes = logBefore ? readFileSync(logPath, "utf8") : null;
  const discord = spawnSync(process.execPath, ["scripts/price-check.js", "--discord"], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH, DISCORD_WEBHOOK_URL: secret },
  });
  const discordOutput = `${discord.stdout}${discord.stderr}`;
  assert.equal(discordOutput.includes(secret), false);
  assert.equal(readFileSync(join(root, "data/deals.json"), "utf8"), dealsBefore);
  assert.equal(existsSync(logPath) ? readFileSync(logPath, "utf8") : null, logBytes);
  if (discord.status === 0) {
    assert.match(discord.stdout, /skipped/);
  } else {
    assert.equal(discord.status, 1);
    assert.match(discordOutput, /Discord post failed|Failed to parse URL/);
  }
});
