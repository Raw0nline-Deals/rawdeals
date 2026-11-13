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
  daysSinceEpoch,
  dealFromCreatorsItem,
  loadDiscoveryConfig,
  MAX_SEARCH_PAGE,
  mergeApiDeals,
  refreshDealsFile,
  SEARCH_ITEM_COUNT,
  selectDailySearches,
  selectDiscoveredDeals,
  shouldStopKeyword,
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

test("the shipped discovery file rotates a keyword pool across the twelve categories", () => {
  const discovery = loadDiscoveryConfig(JSON.parse(readFileSync(join(root, "data", "discovery.json"), "utf8")));
  const asins = JSON.parse(readFileSync(join(root, "data", "asins.json"), "utf8"));
  assert.equal(discovery.minDiscountPercent, 20);
  assert.equal(discovery.minRating, 4);
  assert.equal(discovery.maxDeals, 20);
  assert.equal(discovery.pagesPerKeyword, 3);
  assert.equal(discovery.keywordsPerRun, 12);
  assert.equal(discovery.maxRequests, 48);
  assert.ok(discovery.pagesPerKeyword <= MAX_SEARCH_PAGE);
  assert.equal(SEARCH_ITEM_COUNT, 10);
  assert.equal(MAX_SEARCH_PAGE, 10);
  const firstSeen = [];
  for (const search of discovery.searches) {
    if (!firstSeen.includes(search.category)) firstSeen.push(search.category);
  }
  assert.deepEqual(firstSeen, [...DISPLAY_CATEGORIES]);
  const lengths = [];
  for (const category of DISPLAY_CATEGORIES) {
    const keywords = discovery.searches.filter((search) => search.category === category).map((search) => search.keywords);
    assert.ok(keywords.length >= 5, category);
    assert.equal(new Set(keywords).size, keywords.length, category);
    lengths.push(keywords.length);
  }
  assert.ok(new Set(lengths).size > 1);
  assert.ok(discovery.searches.every((search) => search.searchIndex));
  assert.deepEqual(discovery.priority.map((search) => search.category), ["Home", "Gaming", "Gaming"]);
  assert.ok(discovery.priority.every((search) => search.priority === true));

  const selected = selectDailySearches(discovery, "2026-11-12");
  assert.equal(selected.length, 15);
  assert.deepEqual(selected.slice(0, 3).map((search) => search.keywords), [
    "permanent outdoor lights",
    "gaming microphone",
    "gaming headset",
  ]);
  const daily = selected.slice(3);
  assert.equal(new Set(daily.map((search) => search.category)).size, DISPLAY_CATEGORIES.length);
  const day = daysSinceEpoch("2026-11-12");
  const start = day % DISPLAY_CATEGORIES.length;
  const ordered = [...DISPLAY_CATEGORIES.slice(start), ...DISPLAY_CATEGORIES.slice(0, start)];
  assert.deepEqual(daily.map((search) => search.category), ordered);
  for (const search of daily) {
    const options = discovery.searches.filter((entry) => entry.category === search.category);
    assert.equal(search.keywords, options[day % options.length].keywords);
  }
  const nextDay = selectDailySearches(discovery, "2026-11-13").slice(3).map((search) => search.keywords);
  assert.notDeepEqual(daily.map((search) => search.keywords), nextDay);
  assert.deepEqual(selectDailySearches(discovery, "2026-11-12"), selected);

  const getItems = Math.ceil(asins.length / 10);
  assert.equal(getItems, 2);
  const worstCase = getItems + selected.length * discovery.pagesPerKeyword;
  assert.equal(worstCase, 47);
  assert.ok(worstCase <= discovery.maxRequests);
});

test("discovery config rejects typos, duplicate keywords, and budgets the API will not allow", () => {
  assert.throws(() => loadDiscoveryConfig({ extra: true }), /Unknown field "extra"/);
  const tooMany = Array.from({ length: 97 }, (_, index) => ({ keywords: `item ${index}`, category: "Tech" }));
  assert.throws(() => loadDiscoveryConfig({
    minDiscountPercent: 20,
    minRating: 4,
    maxDeals: 20,
    searches: tooMany,
  }), /at most 96/);
  assert.throws(() => loadDiscoveryConfig({
    minDiscountPercent: 20,
    minRating: 4,
    maxDeals: 20,
    keywordsPerRun: 14,
    searches: [{ keywords: "electronics", category: "Tech" }],
    priority: [
      { keywords: "one", category: "Home" },
      { keywords: "two", category: "Home" },
      { keywords: "three", category: "Home" },
    ],
  }), /at most 16/);
  assert.throws(() => loadDiscoveryConfig({
    minDiscountPercent: 20,
    minRating: 4,
    maxDeals: 20,
    pagesPerKeyword: 11,
    searches: [{ keywords: "electronics", category: "Tech" }],
  }), /pagesPerKeyword must be a whole number from 1 to 10/);
  assert.throws(() => loadDiscoveryConfig({
    minDiscountPercent: 20,
    minRating: 4,
    maxDeals: 20,
    searches: [
      { keywords: "electronics", category: "Tech" },
      { keywords: "electronics", category: "Tech" },
    ],
  }), /more than once/);
  assert.throws(() => loadDiscoveryConfig([]), /JSON object/);
});

test("search requests use the site associate tag and a page from 1 to 10", () => {
  const body = buildSearchBody(
    { keywords: "coffee", searchIndex: "GroceryAndGourmetFood", category: "Drinks" },
    { partnerTag: ASSOCIATE_TAG, minDiscountPercent: 20, minRating: 4 },
  );
  assert.equal(body.partnerTag, ASSOCIATE_TAG);
  assert.equal(body.itemCount, 10);
  assert.equal(body.itemPage, 1);
  const pageTwo = buildSearchBody(
    { keywords: "coffee", category: "Drinks" },
    { partnerTag: ASSOCIATE_TAG, minDiscountPercent: 20, minRating: 4, itemPage: 2 },
  );
  assert.equal(pageTwo.itemPage, 2);
  assert.equal(pageTwo.itemCount, SEARCH_ITEM_COUNT);
  assert.throws(() => buildSearchBody(
    { keywords: "coffee", category: "Drinks" },
    { itemPage: 11 },
  ), /itemPage must be a whole number from 1 to 10/);
  const seen = new Set(["B0SAVED"]);
  assert.equal(shouldStopKeyword([], seen), true);
  assert.equal(shouldStopKeyword([{ asin: "B0SAVED" }, { asin: "B0SAVED" }], seen), true);
  assert.equal(shouldStopKeyword(
    Array.from({ length: 10 }, (_, index) => ({ asin: `B0NEW${index}` })),
    seen,
  ), false);
  assert.equal(shouldStopKeyword(
    Array.from({ length: 10 }, (_, index) => ({ asin: `B0NEW${index}` })),
    seen,
    { page: 1, totalResultCount: 10 },
  ), true);
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

test("merge keeps a discovery that missed today's cut, and drops dead or aged deals", () => {
  const handwritten = {
    id: "hand-old",
    title: "Old note",
    price: 5,
    percentOff: 0,
    category: "Home",
    url: "https://www.amazon.com/dp/B0HAND",
    added: "2026-11-08",
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
    added: "2026-11-10",
    sample: false,
    source: "api",
    image: "https://example.com/b.jpg",
  };
  const missed = {
    id: "B0STALE",
    title: "Missed the cut",
    price: 8,
    percentOff: 40,
    category: "Pets",
    url: "https://www.amazon.com/dp/B0STALE",
    added: "2026-11-10",
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
    added: "2026-11-08",
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
    [flat, missed, keptDiscovery, handwritten],
    new Map(),
    today,
    [refreshed],
  );
  assert.deepEqual(merged.map((deal) => deal.id), ["B0STALE", "B0KEEPDISC", "hand-old"]);
  assert.equal(merged.find((deal) => deal.id === "B0KEEPDISC").added, "2026-11-08");
  assert.equal(merged.find((deal) => deal.id === "B0KEEPDISC").price, 9);
  assert.equal(merged.find((deal) => deal.id === "B0STALE").added, "2026-11-10");
  assert.equal(isActiveDeal(handwritten, today), false);
  assert.equal(isActiveDeal(merged.find((deal) => deal.id === "B0KEEPDISC"), today), true);
  assert.equal(isActiveDeal({ ...flat, promoCode: "CODE" }, today), true);
  assert.deepEqual(activeDeals([flat, handwritten, merged[1]], today).map((deal) => deal.id), ["B0KEEPDISC"]);
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
    added: "2026-11-08",
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
    added: "2026-11-08",
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
    added: "2026-11-08",
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
    pagesPerKeyword: 1,
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
  assert.equal(still.added, "2026-11-08");
  assert.equal(still.percentOff, 35);
  assert.equal(written.deals.some((deal) => deal.id === "B0THIN000001"), false);
  assert.equal(written.deals.some((deal) => deal.id === "B0OOS0000001"), false);
  assert.equal(JSON.stringify(written).includes(secret), false);
  rmSync(dir, { recursive: true, force: true });
});

test("a rate limit is retried and a lasting limit leaves deals.json unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rawdeals-429-"));
  const dealsPath = join(dir, "deals.json");
  const body = `${JSON.stringify({ deals: [] }, null, 2)}\n`;
  writeFileSync(dealsPath, body);
  writeFileSync(join(dir, "asins.json"), "[]\n");
  writeFileSync(join(dir, "discovery.json"), JSON.stringify({
    minDiscountPercent: 20,
    minRating: 4,
    maxDeals: 20,
    pagesPerKeyword: 1,
    searches: [{ keywords: "electronics", searchIndex: "Electronics", category: "Tech" }],
  }));
  const waits = [];
  let searchCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes("/auth/o2/token")) {
      return { ok: true, json: async () => ({ access_token: "token-value" }) };
    }
    searchCalls += 1;
    if (searchCalls < 3) return { ok: false, status: 429, json: async () => ({ message: secret }) };
    return {
      ok: true,
      json: async () => ({
        searchResult: { items: [item({ asin: "B0TECH000009", percent: 40, rating: 4.5, group: "Electronics" })] },
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
    sleep: async (ms) => { waits.push(ms); },
    today,
  });
  assert.equal(result.changed, true);
  assert.equal(searchCalls, 3);
  assert.deepEqual(waits, [2000, 4000]);
  const written = JSON.parse(readFileSync(dealsPath, "utf8"));
  assert.equal(written.deals[0].id, "B0TECH000009");
  assert.equal(JSON.stringify(written).includes(secret), false);

  writeFileSync(dealsPath, body);
  searchCalls = 0;
  const blocked = async (url) => {
    if (String(url).includes("/auth/o2/token")) {
      return { ok: true, json: async () => ({ access_token: "token-value" }) };
    }
    searchCalls += 1;
    return { ok: false, status: 429, json: async () => ({ message: secret }) };
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
      fetchImpl: blocked,
      sleep: async () => {},
      today,
    }),
    /SearchItems request failed \(429\)/,
  );
  assert.equal(searchCalls, 4);
  assert.equal(readFileSync(dealsPath, "utf8"), body);
  rmSync(dir, { recursive: true, force: true });
});

function writeDiscoveryRun(dir, { discovery, deals = [], asins = [] }) {
  const dealsPath = join(dir, "deals.json");
  writeFileSync(dealsPath, `${JSON.stringify({ deals }, null, 2)}\n`);
  writeFileSync(join(dir, "asins.json"), JSON.stringify(asins));
  writeFileSync(join(dir, "discovery.json"), JSON.stringify(discovery));
  return dealsPath;
}

function runDiscovery(dir, dealsPath, fetchImpl, date) {
  return refreshDealsFile({
    asinsPath: join(dir, "asins.json"),
    dealsPath,
    discoveryPath: join(dir, "discovery.json"),
    env: {
      CREATORS_API_CREDENTIAL_ID: "credential-id",
      CREATORS_API_CREDENTIAL_SECRET: secret,
    },
    fetchImpl,
    sleep: async () => {},
    today: date,
    partnerTag: ASSOCIATE_TAG,
  });
}

test("later pages are fetched until the new-deal cap, and saved ASINs do not count", async () => {
  assert.equal(ASSOCIATE_TAG, "eddie060-20");
  const dir = mkdtempSync(join(tmpdir(), "rawdeals-pages-"));
  const date = "2026-11-12";
  const discovery = {
    minDiscountPercent: 20,
    minRating: 4,
    maxDeals: 2,
    pagesPerKeyword: 3,
    keywordsPerRun: 2,
    maxRequests: 20,
    searches: [
      { keywords: "wireless earbuds", searchIndex: "Electronics", category: "Tech" },
      { keywords: "yoga mat", searchIndex: "SportsAndOutdoors", category: "Sports" },
    ],
  };
  const saved = {
    id: "B0OLD0000001",
    title: "Already saved",
    price: 10,
    percentOff: 25,
    category: "Tech",
    url: "https://www.amazon.com/dp/B0OLD0000001",
    added: "2026-11-10",
    sample: false,
    source: "api",
    discovered: true,
    image: "https://m.media-amazon.com/images/I/old.jpg",
  };
  const handwritten = {
    id: "B0HAND000001",
    title: "Hand written",
    price: 8,
    percentOff: 0,
    category: "Home",
    url: "https://www.amazon.com/dp/B0HAND000001",
    added: "2026-11-10",
    sample: false,
    image: "https://example.com/hand.jpg",
  };
  const dealsPath = writeDiscoveryRun(dir, { discovery, deals: [saved, handwritten] });
  const selected = selectDailySearches(loadDiscoveryConfig(discovery), date);
  const first = selected[0].keywords;
  const second = selected[1].keywords;
  const calls = [];
  const fetchImpl = async (url, options) => {
    if (String(url).includes("/auth/o2/token")) {
      return { ok: true, json: async () => ({ access_token: "token-value" }) };
    }
    const body = JSON.parse(options.body);
    assert.equal(body.partnerTag, ASSOCIATE_TAG);
    assert.equal(body.itemCount, 10);
    calls.push(`${body.keywords}#${body.itemPage}`);
    if (body.keywords === first && body.itemPage === 1) {
      return {
        ok: true,
        json: async () => ({
          searchResult: {
            items: [
              item({ asin: "B0PAGE000001", percent: 40, rating: 4.6, title: "New earbuds" }),
              item({ asin: "B0OLD0000001", percent: 50, rating: 4.8, title: "Already saved" }),
              item({ asin: "B0HAND000001", percent: 60, rating: 4.9, title: "Hand written" }),
            ],
          },
        }),
      };
    }
    if (body.keywords === first && body.itemPage === 2) {
      return {
        ok: true,
        json: async () => ({
          searchResult: {
            items: [item({ asin: "B0PAGE000002", percent: 33, rating: 4.2, title: "Second page earbuds" })],
          },
        }),
      };
    }
    throw new Error(`unexpected search ${body.keywords} page ${body.itemPage}`);
  };
  const result = await runDiscovery(dir, dealsPath, fetchImpl, date);
  assert.deepEqual(calls, [`${first}#1`, `${first}#2`]);
  assert.equal(calls.includes(`${second}#1`), false);
  assert.equal(result.addedDiscoveries, 2);
  assert.equal(result.requests, 2);
  const written = JSON.parse(readFileSync(dealsPath, "utf8"));
  const ids = written.deals.map((deal) => deal.id);
  assert.equal(ids.filter((id) => id === "B0HAND000001").length, 1);
  assert.equal(ids.includes("B0PAGE000001"), true);
  assert.equal(ids.includes("B0PAGE000002"), true);
  assert.equal(written.deals.find((deal) => deal.id === "B0OLD0000001").percentOff, 50);
  assert.equal(written.deals.find((deal) => deal.id === "B0OLD0000001").added, "2026-11-10");
  assert.equal(written.deals.filter((deal) => deal.discovered && deal.added === date).length, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("a page with no new ASINs stops that keyword and the next keyword still runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rawdeals-dry-page-"));
  const date = "2026-11-12";
  const discovery = {
    minDiscountPercent: 20,
    minRating: 4,
    maxDeals: 20,
    pagesPerKeyword: 3,
    keywordsPerRun: 2,
    maxRequests: 20,
    searches: [
      { keywords: "wireless earbuds", searchIndex: "Electronics", category: "Tech" },
      { keywords: "yoga mat", searchIndex: "SportsAndOutdoors", category: "Sports" },
    ],
  };
  const known = ["B0KNOWN00001", "B0KNOWN00002"].map((id) => ({
    id,
    title: id,
    price: 10,
    percentOff: 30,
    category: "Tech",
    url: `https://www.amazon.com/dp/${id}`,
    added: "2026-11-10",
    sample: false,
    source: "api",
    discovered: true,
    image: "https://m.media-amazon.com/images/I/old.jpg",
  }));
  const dealsPath = writeDiscoveryRun(dir, { discovery, deals: known });
  const selected = selectDailySearches(loadDiscoveryConfig(discovery), date);
  const first = selected[0].keywords;
  const second = selected[1].keywords;
  const calls = [];
  const fetchImpl = async (url, options) => {
    if (String(url).includes("/auth/o2/token")) {
      return { ok: true, json: async () => ({ access_token: "token-value" }) };
    }
    const body = JSON.parse(options.body);
    calls.push(`${body.keywords}#${body.itemPage}`);
    if (body.keywords === first) {
      return {
        ok: true,
        json: async () => ({
          searchResult: { items: known.map((deal) => item({ asin: deal.id, percent: 30, rating: 4.4 })) },
        }),
      };
    }
    if (body.keywords === second && body.itemPage === 1) {
      return {
        ok: true,
        json: async () => ({
          searchResult: { items: [item({ asin: "B0FRESH00001", percent: 40, rating: 4.5, title: "Yoga block" })] },
        }),
      };
    }
    if (body.keywords === second && body.itemPage === 2) {
      return {
        ok: true,
        json: async () => ({
          searchResult: { items: [item({ asin: "B0FRESH00001", percent: 40, rating: 4.5, title: "Yoga block" })] },
        }),
      };
    }
    throw new Error(`unexpected search ${body.keywords} page ${body.itemPage}`);
  };
  const result = await runDiscovery(dir, dealsPath, fetchImpl, date);
  assert.deepEqual(calls, [`${first}#1`, `${second}#1`, `${second}#2`]);
  assert.equal(result.addedDiscoveries, 1);
  const written = JSON.parse(readFileSync(dealsPath, "utf8"));
  assert.equal(written.deals.filter((deal) => deal.id === "B0FRESH00001").length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("the request budget stops further SearchItems calls and still saves deals already fetched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rawdeals-budget-"));
  const discovery = {
    minDiscountPercent: 20,
    minRating: 4,
    maxDeals: 20,
    pagesPerKeyword: 3,
    maxRequests: 1,
    searches: [
      { keywords: "wireless earbuds", searchIndex: "Electronics", category: "Tech" },
      { keywords: "yoga mat", searchIndex: "SportsAndOutdoors", category: "Sports" },
    ],
  };
  const dealsPath = writeDiscoveryRun(dir, { discovery });
  const calls = [];
  const fetchImpl = async (url, options) => {
    if (String(url).includes("/auth/o2/token")) {
      return { ok: true, json: async () => ({ access_token: "token-value" }) };
    }
    const body = JSON.parse(options.body);
    calls.push(`${body.keywords}#${body.itemPage}`);
    return {
      ok: true,
      json: async () => ({
        searchResult: { items: [item({ asin: "B0BUDGET0001", percent: 44, rating: 4.4, title: "Budget earbuds" })] },
      }),
    };
  };
  const result = await runDiscovery(dir, dealsPath, fetchImpl, "2026-11-11");
  assert.deepEqual(calls, ["wireless earbuds#1"]);
  assert.equal(result.requests, 1);
  assert.equal(result.addedDiscoveries, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("GetItems batches still run when they meet the request budget, and search does not start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rawdeals-getitems-budget-"));
  const asins = Array.from({ length: 12 }, (_, index) => ({ asin: `B0BATCH0000${index}` }));
  const discovery = {
    minDiscountPercent: 20,
    minRating: 4,
    maxDeals: 20,
    pagesPerKeyword: 3,
    maxRequests: 1,
    searches: [{ keywords: "electronics", searchIndex: "Electronics", category: "Tech" }],
  };
  const dealsPath = writeDiscoveryRun(dir, { discovery, asins });
  const calls = [];
  const fetchImpl = async (url, options) => {
    if (String(url).includes("/auth/o2/token")) {
      return { ok: true, json: async () => ({ access_token: "token-value" }) };
    }
    const body = JSON.parse(options.body);
    if (String(url).includes("searchItems")) throw new Error("search should not run");
    calls.push(body.itemIds.length);
    return {
      ok: true,
      json: async () => ({
        itemsResult: {
          items: body.itemIds.map((asin) => item({ asin, percent: 30, group: "Electronics", title: asin })),
        },
      }),
    };
  };
  const result = await runDiscovery(dir, dealsPath, fetchImpl, "2026-11-12");
  assert.deepEqual(calls, [10, 2]);
  assert.equal(result.requests, 2);
  const written = JSON.parse(readFileSync(dealsPath, "utf8"));
  assert.equal(written.deals.length, 12);
  rmSync(dir, { recursive: true, force: true });
});

test("a throttle response waits for retryAfterSeconds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rawdeals-retry-after-"));
  const discovery = {
    minDiscountPercent: 20,
    minRating: 4,
    maxDeals: 20,
    pagesPerKeyword: 1,
    searches: [{ keywords: "electronics", searchIndex: "Electronics", category: "Tech" }],
  };
  const dealsPath = writeDiscoveryRun(dir, { discovery });
  const waits = [];
  let searchCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes("/auth/o2/token")) {
      return { ok: true, json: async () => ({ access_token: "token-value" }) };
    }
    searchCalls += 1;
    if (searchCalls === 1) {
      return { ok: false, status: 429, json: async () => ({ retryAfterSeconds: 9, message: secret }) };
    }
    return {
      ok: true,
      json: async () => ({
        searchResult: { items: [item({ asin: "B0RETRY00001", percent: 40, rating: 4.5 })] },
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
    sleep: async (ms) => { waits.push(ms); },
    today: "2026-11-12",
  });
  assert.deepEqual(waits, [9000]);
  assert.equal(result.addedDiscoveries, 1);
  assert.equal(JSON.parse(readFileSync(dealsPath, "utf8")).deals[0].id, "B0RETRY00001");
  rmSync(dir, { recursive: true, force: true });
});

test("a failed later page leaves deals.json unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rawdeals-page-fail-"));
  const dealsPath = writeDiscoveryRun(dir, {
    discovery: {
      minDiscountPercent: 20,
      minRating: 4,
      maxDeals: 20,
      pagesPerKeyword: 3,
      searches: [{ keywords: "electronics", searchIndex: "Electronics", category: "Tech" }],
    },
  });
  const before = readFileSync(dealsPath, "utf8");
  let searchCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes("/auth/o2/token")) {
      return { ok: true, json: async () => ({ access_token: "token-value" }) };
    }
    searchCalls += 1;
    if (searchCalls === 1) {
      return {
        ok: true,
        json: async () => ({
          searchResult: { items: [item({ asin: "B0PAGE000009", percent: 40, rating: 4.5 })] },
        }),
      };
    }
    return { ok: false, status: 503, json: async () => ({ message: secret }) };
  };
  await assert.rejects(
    () => runDiscovery(dir, dealsPath, fetchImpl, "2026-11-12"),
    (error) => {
      assert.equal(error.message.includes(secret), false);
      assert.match(error.message, /SearchItems request failed \(503\)/);
      return true;
    },
  );
  assert.equal(searchCalls, 2);
  assert.equal(readFileSync(dealsPath, "utf8"), before);
  rmSync(dir, { recursive: true, force: true });
});
