import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ASSOCIATE_TAG } from "../js/affiliate.js";
import { DISPLAY_CATEGORIES, displayCategoryFromItem, matchCategory } from "../js/categories.js";
import { activeDeals, isActiveDeal } from "../js/deals.js";
import {
  buildSearchBody,
  dealFromCreatorsItem,
  loadDiscoveryConfig,
  mergeApiDeals,
  refreshDealsFile,
  selectDiscoveredDeals,
} from "../scripts/fetch-deals.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const secret = "super-secret-value-do-not-print";
const today = "2026-11-11";

function item({
  asin,
  price = 20,
  original = 40,
  percent = 50,
  title = "API title",
  group,
  binding,
  nodes,
  rating,
  availability,
  end,
  violatesMAP = false,
  image = "https://m.media-amazon.com/images/I/new.jpg",
}) {
  return {
    asin,
    detailPageURL: `https://www.amazon.com/dp/${asin}`,
    images: image ? { primary: { large: { url: image } } } : undefined,
    itemInfo: {
      title: { displayValue: title },
      classifications: {
        ...(group ? { productGroup: { displayValue: group } } : {}),
        ...(binding ? { binding: { displayValue: binding } } : {}),
      },
    },
    ...(nodes ? { browseNodeInfo: { browseNodes: nodes } } : {}),
    ...(rating == null ? {} : { customerReviews: { starRating: rating } }),
    offersV2: {
      listings: [
        violatesMAP
          ? { isBuyBoxWinner: true, violatesMAP: true, price: { money: { amount: price } } }
          : {
              isBuyBoxWinner: true,
              violatesMAP: false,
              ...(availability ? { availability: { type: availability } } : {}),
              ...(end ? { dealDetails: { endTime: `${end}T05:00:00Z` } } : {}),
              price: {
                money: { amount: price },
                ...(original == null ? {} : { savingBasis: { money: { amount: original } } }),
                ...(percent == null ? {} : { savings: { percentage: percent } }),
              },
            },
      ],
    },
  };
}

function chain(names) {
  let ancestor;
  for (let index = names.length - 1; index >= 0; index -= 1) {
    ancestor = { displayName: names[index], ...(ancestor ? { ancestor } : {}) };
  }
  return ancestor;
}

test("the shipped discovery file is the twelve starting categories and about 20 deals", () => {
  const discovery = loadDiscoveryConfig(JSON.parse(readFileSync(join(root, "data", "discovery.json"), "utf8")));
  assert.equal(discovery.minDiscountPercent, 20);
  assert.equal(discovery.minRating, 4);
  assert.equal(discovery.maxDeals, 20);
  assert.deepEqual(discovery.searches.map((search) => search.category), DISPLAY_CATEGORIES);
  assert.equal(new Set(discovery.searches.map((search) => search.keywords)).size, DISPLAY_CATEGORIES.length);
  assert.ok(discovery.searches.every((search) => search.searchIndex));
});

test("discovery config rejects typos and too many searches", () => {
  assert.throws(() => loadDiscoveryConfig({ extra: true }), /Unknown field "extra"/);
  const searches = Array.from({ length: 17 }, (_, index) => ({ keywords: `item ${index}`, category: "Tech" }));
  assert.throws(() => loadDiscoveryConfig({
    minDiscountPercent: 20,
    minRating: 4,
    maxDeals: 20,
    searches,
  }), /at most 16/);
  assert.throws(() => loadDiscoveryConfig([]), /JSON object/);
});

test("search requests stay on one page and use the site associate tag", () => {
  const body = buildSearchBody(
    { keywords: "coffee", searchIndex: "GroceryAndGourmetFood", category: "Drinks" },
    { partnerTag: ASSOCIATE_TAG, minDiscountPercent: 20, minRating: 4 },
  );
  assert.equal(body.partnerTag, ASSOCIATE_TAG);
  assert.equal(body.itemCount, 10);
  assert.equal(body.itemPage, 1);
  assert.equal(body.minSavingPercent, 20);
  assert.equal(body.minReviewsRating, 4);
  assert.equal(body.availability, "Available");
  assert.equal(body.searchIndex, "GroceryAndGourmetFood");
  assert.equal(body.resources.includes("itemInfo.classifications"), true);
  assert.equal(body.resources.includes("offersV2.listings.availability"), true);
});

test("Amazon departments map to the display categories, and a narrower name wins", () => {
  assert.equal(displayCategoryFromItem(item({ asin: "B0TECH", group: "Electronics" })), "Tech");
  assert.equal(displayCategoryFromItem(item({ asin: "B0HOME", group: "Home" })), "Home");
  assert.equal(displayCategoryFromItem(item({ asin: "B0PET", group: "Pet Products" })), "Pets");
  assert.equal(displayCategoryFromItem(item({ asin: "B0CLOTH", group: "Apparel" })), "Clothing");
  assert.equal(displayCategoryFromItem(item({ asin: "B0GAME", group: "Video Games" })), "Gaming");
  assert.equal(displayCategoryFromItem(item({ asin: "B0TOY", group: "Toy" })), "Toys");
  assert.equal(displayCategoryFromItem(item({ asin: "B0KIT", group: "Kitchen" })), "Kitchen");
  assert.equal(matchCategory("Sports & Outdoors"), "Sports");
  assert.equal(matchCategory("Health & Household"), "Household");

  assert.equal(displayCategoryFromItem(item({
    asin: "B0COFFEE",
    group: "Grocery",
    nodes: [chain(["Ground Coffee", "Coffee, Tea & Beverages", "Grocery & Gourmet Food"])],
  })), "Drinks");
  assert.equal(displayCategoryFromItem(item({
    asin: "B0SNACK",
    group: "Grocery",
    nodes: [chain(["Snack Foods", "Grocery & Gourmet Food"])],
  })), "Food");
  assert.equal(displayCategoryFromItem(item({
    asin: "B0LAMP",
    nodes: [chain(["Table Lamps", "Lighting", "Home & Kitchen"])],
  })), "Home");
  assert.equal(displayCategoryFromItem(item({
    asin: "B0SCENT",
    group: "Beauty",
    nodes: [chain(["Cologne", "Fragrances"])],
  })), "Fragrances");
  assert.equal(displayCategoryFromItem(item({
    asin: "B0CLEAN",
    nodes: [chain(["Paper Towels", "Household Cleaning"])],
  })), "Household");
  assert.equal(displayCategoryFromItem(item({ asin: "B0NONE", group: "BISS" })), null);
});

test("a category typed on the ASIN wins over Amazon", () => {
  const deal = dealFromCreatorsItem(
    item({ asin: "B0MANUAL", group: "Electronics", percent: 25 }),
    { asin: "B0MANUAL", category: "Pets" },
    { today, existing: { category: "Home", added: "2026-11-01", title: "Kept name" } },
  );
  assert.equal(deal.category, "Pets");
  assert.equal(deal.title, "Kept name");
  assert.equal(deal.added, "2026-11-01");

  const mapped = dealFromCreatorsItem(
    item({ asin: "B0AUTO", group: "Kitchen", percent: 25 }),
    { asin: "B0AUTO" },
    { today, existing: { category: "General" } },
  );
  assert.equal(mapped.category, "Kitchen");
});

test("hand-picked deals with no discount or no stock are not kept, promo codes are", () => {
  assert.equal(dealFromCreatorsItem(
    item({ asin: "B0ZERO", percent: 0, original: null }),
    { asin: "B0ZERO" },
    { today },
  ), null);
  assert.equal(dealFromCreatorsItem(
    item({ asin: "B0OUT", percent: 40, availability: "OUT_OF_STOCK" }),
    { asin: "B0OUT" },
    { today },
  ), null);
  const coded = dealFromCreatorsItem(
    item({ asin: "B0CODE", percent: 0, original: null }),
    { asin: "B0CODE", promoCode: "SAVE10" },
    { today },
  );
  assert.equal(coded.promoCode, "SAVE10");
  assert.equal(coded.percentOff, 0);
});

test("discovery keeps discounted in-stock items, spreads them, and lets hand-picked ASINs win", () => {
  const categories = DISPLAY_CATEGORIES;
  const tagged = [];
  for (const category of categories) {
    tagged.push({ category, item: item({ asin: `${category}-a`, percent: 40, rating: 4.6, group: "Grocery" }) });
    tagged.push({ category, item: item({ asin: `${category}-b`, percent: 30, rating: 4.2, group: "Grocery" }) });
    tagged.push({ category, item: item({ asin: `${category}-c`, percent: 25, rating: 4.1, group: "Grocery" }) });
  }
  tagged.push({ category: "Tech", item: item({ asin: "B0PICKED", percent: 80, rating: 5 }) });
  tagged.push({ category: "Food", item: item({ asin: "B0THIN", percent: 10, rating: 5 }) });
  tagged.push({ category: "Drinks", item: item({ asin: "B0STARS", percent: 60, rating: 3.2 }) });
  tagged.push({ category: "Pets", item: item({ asin: "B0OOS", percent: 70, rating: 4.8, availability: "OUT_OF_STOCK" }) });
  tagged.push({ category: "Home", item: item({ asin: "B0ENDED", percent: 55, rating: 4.4, end: "2026-11-01" }) });
  tagged.push({ category: "Kitchen", item: item({ asin: "B0NORATE", percent: 33 }) });

  const picked = selectDiscoveredDeals(tagged, {
    today,
    blockedAsins: new Set(["B0PICKED"]),
    minDiscountPercent: 20,
    minRating: 4,
    maxDeals: 20,
  });
  assert.equal(picked.length, 20);
  assert.equal(picked.some((deal) => deal.id === "B0PICKED"), false);
  assert.equal(picked.some((deal) => deal.id === "B0THIN"), false);
  assert.equal(picked.some((deal) => deal.id === "B0STARS"), false);
  assert.equal(picked.some((deal) => deal.id === "B0OOS"), false);
  assert.equal(picked.some((deal) => deal.id === "B0ENDED"), false);
  assert.equal(picked.some((deal) => deal.id === "B0NORATE"), true);
  assert.deepEqual(picked.slice(0, 12).map((deal) => deal.category), categories);
  assert.deepEqual(picked.slice(0, 12).map((deal) => deal.id), categories.map((category) => `${category}-a`));
  assert.equal(picked.filter((deal) => deal.category === "Tech").length, 2);
  assert.equal(picked.filter((deal) => deal.category === "Toys").length, 1);
  assert.ok(picked.every((deal) => deal.discovered === true && deal.source === "api"));
  assert.equal(picked.find((deal) => deal.id === "Food-a").category, "Food");
});

test("a search category wins over the Amazon department", () => {
  const [deal] = selectDiscoveredDeals([
    { category: "Drinks", item: item({ asin: "B0COFFEE", group: "Grocery", percent: 25, rating: 4.5 }) },
  ], {
    today,
    minDiscountPercent: 20,
    minRating: 4,
    maxDeals: 20,
  });
  assert.equal(deal.category, "Drinks");
});

test("merge drops dead API deals and stale discoveries, and keeps expired hand-written deals in the file", () => {
  const handwritten = {
    id: "hand-old",
    title: "Old note",
    price: 5,
    percentOff: 0,
    category: "Home",
    url: "https://www.amazon.com/dp/B0HAND",
    added: "2026-11-01",
    expires: "2026-11-02",
    sample: false,
    image: "https://example.com/a.jpg",
  };
  const flat = {
    id: "B0FLAT",
    title: "No longer on sale",
    price: 10,
    percentOff: 0,
    category: "Tech",
    url: "https://www.amazon.com/dp/B0FLAT",
    added: "2026-11-01",
    sample: false,
    source: "api",
    image: "https://example.com/b.jpg",
  };
  const stale = {
    id: "B0STALE",
    title: "Yesterday",
    price: 8,
    percentOff: 40,
    category: "Pets",
    url: "https://www.amazon.com/dp/B0STALE",
    added: "2026-11-01",
    sample: false,
    source: "api",
    discovered: true,
    image: "https://example.com/c.jpg",
  };
  const keptDiscovery = {
    id: "B0KEEPDISC",
    title: "Still good",
    price: 12,
    percentOff: 30,
    category: "Home",
    url: "https://www.amazon.com/dp/B0KEEPDISC",
    added: "2026-11-01",
    sample: false,
    source: "api",
    discovered: true,
    image: "https://example.com/d.jpg",
  };
  const refreshed = {
    ...keptDiscovery,
    price: 9,
    percentOff: 45,
    added: today,
    title: "Fresh title",
  };
  const merged = mergeApiDeals(
    [flat, stale, keptDiscovery, handwritten],
    new Map(),
    today,
    [refreshed],
  );
  assert.deepEqual(merged.map((deal) => deal.id), ["B0KEEPDISC", "hand-old"]);
  assert.equal(merged[0].added, "2026-11-01");
  assert.equal(merged[0].price, 9);
  assert.equal(isActiveDeal(handwritten, today), false);
  assert.equal(isActiveDeal(merged[0], today), true);
  assert.equal(isActiveDeal({ ...flat, promoCode: "CODE" }, today), true);
  assert.deepEqual(activeDeals([flat, handwritten, merged[0]], today).map((deal) => deal.id), ["B0KEEPDISC"]);
});

test("a failed search leaves deals.json unchanged and hides the secret", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rawdeals-search-"));
  const dealsPath = join(dir, "deals.json");
  const body = `${JSON.stringify({ about: "keep", deals: [{ id: "hand", title: "Hand", price: 1, percentOff: 0, category: "Home", url: "https://www.amazon.com/dp/B0HAND", added: "2026-11-01", sample: false, image: "https://example.com/a.jpg" }] }, null, 2)}\n`;
  writeFileSync(dealsPath, body);
  writeFileSync(join(dir, "asins.json"), JSON.stringify([{ asin: "B0KEEP000001" }]));
  writeFileSync(join(dir, "discovery.json"), JSON.stringify({
    minDiscountPercent: 20,
    minRating: 4,
    maxDeals: 20,
    searches: [{ keywords: "electronics", searchIndex: "Electronics", category: "Tech" }],
  }));
  const fetchImpl = async (url) => {
    if (String(url).includes("/auth/o2/token")) {
      return { ok: true, json: async () => ({ access_token: "token-value" }) };
    }
    if (String(url).includes("searchItems")) {
      return { ok: false, status: 503, json: async () => ({ message: secret }) };
    }
    return {
      ok: true,
      json: async () => ({ itemsResult: { items: [item({ asin: "B0KEEP000001", percent: 30, group: "Home" })] } }),
    };
  };
  await assert.rejects(
    () => refreshDealsFile({
      asinsPath: join(dir, "asins.json"),
      dealsPath,
      discoveryPath: join(dir, "discovery.json"),
      env: {
        CREATORS_API_CREDENTIAL_ID: "credential-id",
        CREATORS_API_CREDENTIAL_SECRET: secret,
      },
      fetchImpl,
      today,
    }),
    (error) => {
      assert.equal(error.message.includes(secret), false);
      assert.match(error.message, /SearchItems request failed \(503\)/);
      return true;
    },
  );
  assert.equal(readFileSync(dealsPath, "utf8"), body);
  rmSync(dir, { recursive: true, force: true });
});

test("live refresh keeps hand-picked priority, fills categories, and preserves discovered added dates", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rawdeals-discover-"));
  const handwritten = {
    id: "hand-old",
    title: "EXAMPLE leftover",
    price: 5,
    percentOff: 0,
    category: "Home",
    url: "https://www.amazon.com/s?k=EXAMPLE",
    added: "2026-11-01",
    expires: "2026-11-02",
    sample: true,
    image: "images/samples/home.svg",
  };
  const existingPick = {
    id: "B0KEEP000001",
    title: "Kept pet brush",
    price: 12,
    percentOff: 40,
    category: "Home",
    url: "https://www.amazon.com/dp/B0KEEP000001",
    added: "2026-11-01",
    sample: false,
    source: "api",
    image: "https://m.media-amazon.com/images/I/old.jpg",
  };
  const existingFound = {
    id: "B0DISC000001",
    title: "Old discovery",
    price: 15,
    percentOff: 30,
    category: "Tech",
    url: "https://www.amazon.com/dp/B0DISC000001",
    added: "2026-11-01",
    sample: false,
    source: "api",
    discovered: true,
    image: "https://m.media-amazon.com/images/I/old-disc.jpg",
  };
  const dealsPath = join(dir, "deals.json");
  writeFileSync(dealsPath, `${JSON.stringify({ about: "keep", deals: [existingPick, existingFound, handwritten] }, null, 2)}\n`);
  writeFileSync(join(dir, "asins.json"), JSON.stringify([
    { asin: "B0KEEP000001", category: "Pets" },
    { asin: "B0NEW0000001" },
  ]));
  writeFileSync(join(dir, "discovery.json"), JSON.stringify({
    minDiscountPercent: 20,
    minRating: 4,
    maxDeals: 20,
    searches: [
      { keywords: "electronics", searchIndex: "Electronics", category: "Tech" },
      { keywords: "home organization", searchIndex: "HomeAndKitchen", category: "Home" },
    ],
  }));
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(url);
    if (String(url).includes("/auth/o2/token")) {
      return { ok: true, json: async () => ({ access_token: "token-value" }) };
    }
    const body = JSON.parse(options.body);
    assert.equal(body.partnerTag, ASSOCIATE_TAG);
    if (String(url).includes("searchItems")) {
      assert.equal(body.itemPage, 1);
      assert.equal(body.itemCount, 10);
      const items = body.keywords === "electronics"
        ? [
            item({ asin: "B0KEEP000001", percent: 90, rating: 5, group: "Electronics" }),
            item({ asin: "B0TECH000001", percent: 40, rating: 4.5, group: "Grocery" }),
            item({ asin: "B0DISC000001", percent: 35, rating: 4.4, group: "Electronics" }),
            item({ asin: "B0THIN000001", percent: 10, rating: 5 }),
          ]
        : [
            item({ asin: "B0HOME000001", percent: 30, rating: 4.2, group: "Kitchen" }),
            item({ asin: "B0OOS0000001", percent: 50, rating: 4.8, availability: "UNAVAILABLE" }),
          ];
      return { ok: true, json: async () => ({ searchResult: { items } }) };
    }
    return {
      ok: true,
      json: async () => ({
        itemsResult: {
          items: [
            item({ asin: "B0KEEP000001", percent: 22, group: "Electronics", title: "API pet brush" }),
            item({ asin: "B0NEW0000001", percent: 28, group: "Kitchen", title: "Skillet" }),
          ],
        },
      }),
    };
  };
  const result = await refreshDealsFile({
    asinsPath: join(dir, "asins.json"),
    dealsPath,
    discoveryPath: join(dir, "discovery.json"),
    env: {
      CREATORS_API_CREDENTIAL_ID: "credential-id",
      CREATORS_API_CREDENTIAL_SECRET: secret,
    },
    fetchImpl,
    today,
    partnerTag: ASSOCIATE_TAG,
  });
  assert.equal(result.changed, true);
  assert.equal(calls.filter((url) => String(url).includes("/auth/o2/token")).length, 1);
  assert.equal(calls.filter((url) => String(url).includes("getItems")).length, 1);
  assert.equal(calls.filter((url) => String(url).includes("searchItems")).length, 2);
  const written = JSON.parse(readFileSync(dealsPath, "utf8"));
  const ids = written.deals.map((deal) => deal.id);
  assert.deepEqual(ids, ["B0NEW0000001", "B0TECH000001", "B0HOME000001", "B0KEEP000001", "B0DISC000001", handwritten.id]);
  const kept = written.deals.find((deal) => deal.id === "B0KEEP000001");
  assert.equal(kept.category, "Pets");
  assert.equal(kept.title, "Kept pet brush");
  assert.equal(kept.discovered, undefined);
  assert.equal(kept.price, 20);
  const created = written.deals.find((deal) => deal.id === "B0NEW0000001");
  assert.equal(created.category, "Kitchen");
  assert.equal(created.discovered, undefined);
  const tech = written.deals.find((deal) => deal.id === "B0TECH000001");
  assert.equal(tech.category, "Tech");
  assert.equal(tech.discovered, true);
  const home = written.deals.find((deal) => deal.id === "B0HOME000001");
  assert.equal(home.category, "Home");
  const still = written.deals.find((deal) => deal.id === "B0DISC000001");
  assert.equal(still.added, "2026-11-01");
  assert.equal(still.percentOff, 35);
  assert.equal(written.deals.some((deal) => deal.id === "B0THIN000001"), false);
  assert.equal(written.deals.some((deal) => deal.id === "B0OOS0000001"), false);
  assert.equal(JSON.stringify(written).includes(secret), false);
  rmSync(dir, { recursive: true, force: true });
});
