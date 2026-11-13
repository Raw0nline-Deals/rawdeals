import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ASSOCIATE_TAG } from "../js/affiliate.js";
import {
  CHECKOUT_DISCOUNT_LABEL,
  dayGroups,
  dealHref,
  dealLinkLabel,
  isActiveDeal,
} from "../js/deals.js";
import { dealDescription, orderedFeedDeals } from "../scripts/build-feed.js";
import { refreshDealsFile } from "../scripts/fetch-deals.js";
import {
  applyOfferCodes,
  buildOfferLink,
  displayCategoryForSlug,
  fetchAmazonOfferCodes,
  linkCarriesAssociateTag,
  loadOfferConfig,
  normalizeOffer,
  offerRequestUrl,
  readOfferConfigFile,
  resolveUseOwnTag,
} from "../scripts/amazonoffercode.js";
import { builtOfferLinks, tracePromoTag } from "../scripts/check-promo-tag.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const today = "2026-11-11";
const promoKey = "promo-key-do-not-print";

function offerRow(overrides = {}) {
  return {
    coupon_code: "SAVE20",
    title: "Noise cancelling headphones",
    description: "Headphones",
    features: [],
    brand: "Acme",
    category: "electronics",
    asin: "B0NEWCODE1",
    amazon_link: "https://www.amazon.com/promocode/A25MGS6T831FVU?tag=their-20",
    image_url: "https://m.media-amazon.com/images/I/widget.jpg",
    images: [],
    price: "$20.00",
    original_price: "$40.00",
    discount_text: "Save 50.0%",
    marketplace: "us",
    start_date: null,
    end_date: "2026-11-20T23:59:59.999+00:00",
    is_active: true,
    ...overrides,
  };
}

function creatorsItem({ asin, title = "API title", unavailable = false }) {
  return {
    asin,
    detailPageURL: `https://www.amazon.com/dp/${asin}?tag=onamzeddie0c-20&linkCode=osi`,
    images: { primary: { large: { url: "https://m.media-amazon.com/images/I/keep.jpg" } } },
    itemInfo: {
      title: { displayValue: title },
      classifications: { productGroup: { displayValue: "Electronics" } },
    },
    offersV2: {
      listings: [{
        isBuyBoxWinner: true,
        availability: { type: unavailable ? "UNAVAILABLE" : "IN_STOCK" },
        price: {
          money: { amount: 19.99 },
          savingBasis: { money: { amount: 39.99 } },
          savings: { percentage: 50 },
        },
      }],
    },
  };
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test("the category config is the electronics, home, and kitchen list and has no API key", () => {
  const raw = JSON.parse(read("data/amazonoffercode.json"));
  assert.equal(raw.AMAZONOFFERCODE_API_KEY, undefined);
  assert.equal(JSON.stringify(raw).includes(promoKey), false);
  const config = readOfferConfigFile(join(root, "data", "amazonoffercode.json"));
  assert.deepEqual(config.categories, ["electronics", "home", "kitchen"]);
  assert.equal(config.limit, 100);
  assert.equal(config.active, true);
  assert.equal(config.marketplace, "us");
  assert.equal(config.sort, "newest");
  assert.equal(config.maxCallsPerRun, 3);
  assert.equal(config.useOwnTag, true);
  assert.equal(displayCategoryForSlug("electronics"), "Tech");
  assert.equal(displayCategoryForSlug("home"), "Home");
  assert.equal(displayCategoryForSlug("kitchen"), "Kitchen");
  assert.throws(() => loadOfferConfig({ categories: ["Not A Slug"] }), /slug/);
  assert.throws(() => loadOfferConfig({ maxCallsPerRun: 9 }), /maxCallsPerRun/);
  assert.equal(loadOfferConfig({ categories: ["Beauty", "beauty", "sports"] }).categories.join(), "beauty,sports");
  assert.equal(resolveUseOwnTag({ AOC_USE_OWN_TAG: "false" }, true), false);
  assert.equal(resolveUseOwnTag({ AOC_USE_OWN_TAG: "" }, true), true);
});

test("built coded and auto-applied links carry the RawDeals tag", () => {
  const [coded, auto] = builtOfferLinks();
  assert.equal(coded.coded, true);
  assert.equal(new URL(coded.url).pathname, "/dp/B0GN91F43B");
  assert.equal(linkCarriesAssociateTag(coded.url), true);
  assert.equal(auto.coded, false);
  assert.equal(new URL(auto.url).pathname, "/promocode/A25MGS6T831FVU");
  assert.equal(new URL(auto.url).searchParams.get("tag"), ASSOCIATE_TAG);
  assert.equal(auto.url.includes("their-20") || auto.url.includes("amazonoffercode-20"), false);

  const kept = buildOfferLink({
    asin: "B0CODE0001",
    coupon_code: null,
    amazon_link: "https://www.amazon.com/promocode/A25MGS6T831FVU?tag=their-20&psc=1",
  }, { useOwnTag: false });
  assert.equal(kept.preserveAffiliateTag, true);
  assert.equal(new URL(kept.url).searchParams.get("tag"), "their-20");
  assert.equal(new URL(kept.url).searchParams.get("psc"), "1");
  assert.equal(dealHref({ url: kept.url, preserveAffiliateTag: true }), kept.url);
  const added = buildOfferLink({
    asin: "B0CODE0001",
    coupon_code: null,
    amazon_link: "https://www.amazon.com/promocode/A25MGS6T831FVU",
  });
  assert.equal(new URL(added.url).searchParams.get("tag"), ASSOCIATE_TAG);
});

test("a missing key skips the promo API and a mocked payload maps both deal kinds", async () => {
  let called = false;
  const skipped = await fetchAmazonOfferCodes({
    config: loadOfferConfig(null),
    env: {},
    fetchImpl: () => { called = true; },
    today,
  });
  assert.equal(called, false);
  assert.equal(skipped.skipped, true);
  assert.match(skipped.notes.join("\n"), /AMAZONOFFERCODE_API_KEY is not set/);
  assert.equal(skipped.notes.join("\n").includes(promoKey), false);

  const coded = normalizeOffer(offerRow(), { today, queriedCategory: "electronics", useOwnTag: true });
  assert.equal(coded.ok, true);
  assert.equal(coded.offer.promoCode, "SAVE20");
  assert.equal(coded.offer.checkoutDiscount, undefined);
  assert.equal(coded.offer.expires, "2026-11-20");
  assert.equal(coded.offer.category, "Tech");
  assert.equal(new URL(coded.offer.url).searchParams.get("tag"), ASSOCIATE_TAG);
  assert.equal(dealLinkLabel(coded.offer), "View on Amazon");

  const auto = normalizeOffer(offerRow({
    asin: "B0AUTO0001",
    coupon_code: null,
    category: "kitchen",
    title: "Cast iron skillet",
  }), { today, queriedCategory: "kitchen", useOwnTag: true });
  assert.equal(auto.offer.promoCode, undefined);
  assert.equal(auto.offer.checkoutDiscount, true);
  assert.equal(dealLinkLabel(auto.offer), CHECKOUT_DISCOUNT_LABEL);
  assert.match(dealDescription(auto.offer), /Discount applied at checkout/);
  assert.match(dealDescription(auto.offer), /Ends 2026-11-20/);
  assert.equal(dealDescription(auto.offer).includes("Promo code"), false);

  const expired = normalizeOffer(offerRow({ asin: "B0EXPIRE01", end_date: "2026-11-01" }), { today, useOwnTag: true });
  assert.equal(expired.ok, false);
  assert.equal(expired.rejected, true);
  const inactive = normalizeOffer(offerRow({ asin: "B0INACTIVE", is_active: false }), { today, useOwnTag: true });
  assert.equal(inactive.rejected, true);
  const baby = normalizeOffer(offerRow({ asin: "B0ONESIE01", title: "Cotton infant onesie" }), { today, useOwnTag: true });
  assert.equal(baby.ok, false);
  assert.equal(baby.rejected, undefined);
  assert.equal(isActiveDeal({ ...auto.offer, percentOff: 0, price: 10, originalPrice: undefined }, today), true);
  assert.equal(isActiveDeal({ ...auto.offer, expires: "2026-11-10" }, today), false);
});

test("merge keeps Creators data, shares the discovery cap, and drops a dead promo deal", () => {
  const creators = {
    id: "B0PLAIN001",
    title: "Creators headphones",
    image: "https://m.media-amazon.com/images/I/keep.jpg",
    price: 19.99,
    originalPrice: 39.99,
    percentOff: 50,
    category: "Tech",
    url: "https://www.amazon.com/dp/B0PLAIN001?tag=onamzeddie0c-20",
    added: "2026-11-10",
    sample: false,
    source: "api",
  };
  const codedKeep = {
    ...creators,
    id: "B0KEEP0001",
    promoCode: "KEEP10",
  };
  const stale = {
    id: "B0GONE0001",
    title: "Ended promo",
    image: "https://m.media-amazon.com/images/I/old.jpg",
    price: 8,
    percentOff: 20,
    category: "Home",
    url: "https://www.amazon.com/dp/B0GONE0001",
    added: "2026-11-10",
    sample: false,
    source: "api",
    discovered: true,
    origin: "amazonoffercode",
    promoCode: "OLD",
  };
  const coded = normalizeOffer(offerRow({ asin: "B0PLAIN001", coupon_code: "SAVE20" }), { today, useOwnTag: true }).offer;
  const ignoredCode = normalizeOffer(offerRow({ asin: "B0KEEP0001", coupon_code: "OTHER" }), { today, useOwnTag: true }).offer;
  const auto = normalizeOffer(offerRow({
    asin: "B0AUTO0001",
    coupon_code: null,
    category: "home",
    title: "Storage bins",
    price: "$15.00",
    original_price: "$30.00",
  }), { today, queriedCategory: "home", useOwnTag: true }).offer;
  const second = normalizeOffer(offerRow({
    asin: "B0SECOND01",
    coupon_code: "NEXT10",
    category: "electronics",
    title: "USB hub",
  }), { today, useOwnTag: true }).offer;
  const blocked = normalizeOffer(offerRow({ asin: "B0STOCK001", coupon_code: "NOPE" }), { today, useOwnTag: true }).offer;
  const applied = applyOfferCodes([codedKeep, creators, stale], {
    offers: [coded, ignoredCode, auto, second, blocked],
    rejectedAsins: new Set(["B0GONE0001"]),
    blockedAsins: new Set(["B0STOCK001"]),
    existingDeals: [codedKeep, creators, stale],
    today,
    maxNew: 1,
    creatorsIds: new Set(["B0PLAIN001", "B0KEEP0001"]),
  });
  const plain = applied.deals.find((deal) => deal.id === "B0PLAIN001");
  const kept = applied.deals.find((deal) => deal.id === "B0KEEP0001");
  assert.equal(plain.title, "Creators headphones");
  assert.equal(plain.price, 19.99);
  assert.equal(plain.promoCode, "SAVE20");
  assert.equal(plain.url, creators.url);
  assert.equal(plain.expires, "2026-11-20");
  assert.equal(plain.checkoutDiscount, undefined);
  assert.equal(kept.promoCode, "KEEP10");
  assert.equal(kept.url, codedKeep.url);
  assert.equal(applied.deals.some((deal) => deal.id === "B0GONE0001"), false);
  assert.equal(applied.deals.some((deal) => deal.id === "B0STOCK001"), false);
  assert.equal(applied.added, 1);
  assert.equal(applied.skippedForCap, 1);
  const added = applied.deals.find((deal) => deal.origin === "amazonoffercode" && deal.id !== "B0GONE0001");
  assert.equal(added.added, today);
  assert.ok(added.promoCode || added.checkoutDiscount);
  assert.equal(new URL(dealHref(added)).searchParams.get("tag"), ASSOCIATE_TAG);

  const groups = dayGroups([
    { ...added, added: today, category: "Home", title: "Storage bins" },
    { ...stale, added: "2026-11-10", expires: "2026-11-20" },
  ], today);
  assert.equal(groups[0].expanded, true);
  assert.equal(groups[1].date, "2026-11-10");
  assert.equal(groups[1].expanded, false);
  assert.equal(groups[1].collapsible, true);
  assert.deepEqual(orderedFeedDeals(groups.flatMap((group) => group.deals), today).map((deal) => deal.added), [today]);
});

test("a 429 stops later categories and a promo failure still keeps Creators deals", async () => {
  const config = loadOfferConfig({
    categories: ["electronics", "home", "kitchen", "sports"],
    limit: 100,
    active: true,
    marketplace: "us",
    sort: "newest",
    maxCallsPerRun: 3,
    useOwnTag: true,
  });
  const calls = [];
  const waits = [];
  const fetched = await fetchAmazonOfferCodes({
    config,
    env: { AMAZONOFFERCODE_API_KEY: promoKey },
    today,
    sleep: (ms) => { waits.push(ms); },
    fetchImpl: async (url) => {
      const href = String(url);
      calls.push(href);
      assert.equal(href.includes(promoKey), true);
      const category = new URL(href).searchParams.get("category");
      const params = new URL(href).searchParams;
      assert.equal(params.get("limit"), "100");
      assert.equal(params.get("active"), "true");
      assert.equal(params.get("marketplace"), "us");
      assert.equal(params.get("page"), "1");
      if (category === "electronics") {
        return jsonResponse({
          data: [offerRow(), offerRow({ asin: "B0AUTO0001", coupon_code: null, category: "electronics", title: "Mouse" })],
          meta: { total: 2, page: 1, limit: 100, has_more: true, usage: { used: 4, limit: 100, remaining: 96 } },
        });
      }
      if (category === "home") return jsonResponse({ message: promoKey }, 429);
      throw new Error(`should not call ${category}`);
    },
  });
  assert.deepEqual(calls.map((href) => new URL(href).searchParams.get("category")), ["electronics", "home"]);
  assert.equal(fetched.offers.length, 2);
  assert.match(fetched.notes.join("\n"), /usage 4\/100 \(96 remaining\)/);
  assert.match(fetched.notes.join("\n"), /429/);
  assert.match(fetched.notes.join("\n"), /more deals exist/);
  assert.match(fetched.notes.join("\n"), /3 of 4 categories/);
  assert.equal(fetched.notes.join("\n").includes(promoKey), false);
  assert.equal(waits.length, 0);

  const dir = mkdtempSync(join(tmpdir(), "rawdeals-offer-"));
  const dealsPath = join(dir, "deals.json");
  const handwritten = {
    id: "hand-pan",
    title: "Kept skillet",
    image: "https://m.media-amazon.com/images/I/pan.jpg",
    price: 12,
    percentOff: 0,
    category: "Kitchen",
    url: "https://www.amazon.com/dp/B0HAND0001",
    added: "2026-11-09",
    sample: false,
  };
  const existing = {
    id: "B0PLAIN001",
    title: "Creators headphones",
    image: "https://m.media-amazon.com/images/I/keep.jpg",
    price: 30,
    originalPrice: 40,
    percentOff: 25,
    category: "Tech",
    url: "https://www.amazon.com/dp/B0PLAIN001?tag=onamzeddie0c-20",
    added: "2026-11-10",
    sample: false,
    source: "api",
  };
  const staying = {
    id: "B0STAY0001",
    title: "Yesterday's code",
    image: "https://m.media-amazon.com/images/I/stay.jpg",
    price: 9,
    percentOff: 10,
    promoCode: "STAY",
    category: "Home",
    url: "https://www.amazon.com/dp/B0STAY0001?tag=onamzeddie0c-20",
    added: "2026-11-10",
    expires: "2026-11-20",
    sample: false,
    source: "api",
    discovered: true,
    origin: "amazonoffercode",
  };
  writeFileSync(dealsPath, `${JSON.stringify({ about: "keep", deals: [existing, staying, handwritten] }, null, 2)}\n`);
  writeFileSync(join(dir, "asins.json"), JSON.stringify([
    { asin: "B0KEEP0001", category: "Tech", promoCode: "KEEP10", title: "Listed headphones" },
    { asin: "B0PLAIN001", category: "Tech", title: "Creators headphones" },
    { asin: "B0STOCK001", category: "Home" },
  ]));
  writeFileSync(join(dir, "amazonoffercode.json"), JSON.stringify({
    categories: ["electronics", "home", "kitchen"],
    limit: 100,
    active: true,
    marketplace: "us",
    sort: "newest",
    maxCallsPerRun: 3,
    useOwnTag: true,
  }));
  const itemCalls = [];
  const result = await refreshDealsFile({
    asinsPath: join(dir, "asins.json"),
    dealsPath,
    offerConfigPath: join(dir, "amazonoffercode.json"),
    env: {
      CREATORS_API_CREDENTIAL_ID: "credential-id",
      CREATORS_API_CREDENTIAL_SECRET: "super-secret-value-do-not-print",
      AMAZONOFFERCODE_API_KEY: promoKey,
    },
    today,
    fetchImpl: async (url) => {
      const href = String(url);
      if (href.includes("/auth/o2/token")) return jsonResponse({ access_token: "token-value" });
      if (href.includes("getItems")) {
        itemCalls.push(href);
        return jsonResponse({
          itemsResult: {
            items: [
              creatorsItem({ asin: "B0KEEP0001", title: "Fresh listed" }),
              creatorsItem({ asin: "B0PLAIN001", title: "Fresh plain" }),
              creatorsItem({ asin: "B0STOCK001", title: "Gone", unavailable: true }),
            ],
          },
        });
      }
      const category = new URL(href).searchParams.get("category");
      if (category === "kitchen") throw new Error("kitchen should not be called after a 429");
      if (category === "home") return jsonResponse({ error: promoKey }, 429);
      return jsonResponse({
        data: [
          offerRow({ asin: "B0PLAIN001", coupon_code: "SAVE20", title: "Promo title should not win", price: "$1.00" }),
          offerRow({ asin: "B0KEEP0001", coupon_code: "OTHER", title: "Should not replace the list code" }),
          offerRow({ asin: "B0AUTO0001", coupon_code: null, category: "home", title: "Lamp", price: "$18.00", original_price: "$36.00" }),
          offerRow({ asin: "B0EXPIRE01", end_date: "2026-11-01T00:00:00Z", title: "Already over" }),
          offerRow({ asin: "B0INACTIVE", is_active: false, title: "Paused" }),
          offerRow({ asin: "B0ONESIE01", title: "Infant onesie 2 pack" }),
          offerRow({ asin: "B0STOCK001", coupon_code: "BACK", title: "Out of stock still" }),
        ],
        meta: { total: 7, page: 1, limit: 100, has_more: false, usage: { used: 5, limit: 100, remaining: 95 } },
      });
    },
  });
  assert.equal(result.changed, true);
  assert.equal(itemCalls.length, 1);
  const written = JSON.parse(readFileSync(dealsPath, "utf8"));
  const plain = written.deals.find((deal) => deal.id === "B0PLAIN001");
  const listed = written.deals.find((deal) => deal.id === "B0KEEP0001");
  const lamp = written.deals.find((deal) => deal.id === "B0AUTO0001");
  assert.equal(plain.title, "Creators headphones");
  assert.equal(plain.price, 19.99);
  assert.equal(plain.promoCode, "SAVE20");
  assert.equal(plain.checkoutDiscount, undefined);
  assert.equal(plain.expires, "2026-11-20");
  assert.equal(new URL(plain.url).pathname, "/dp/B0PLAIN001");
  assert.equal(listed.promoCode, "KEEP10");
  assert.equal(listed.title, "Listed headphones");
  assert.equal(lamp.promoCode, undefined);
  assert.equal(lamp.checkoutDiscount, true);
  assert.equal(lamp.category, "Home");
  assert.equal(lamp.added, today);
  assert.equal(lamp.origin, "amazonoffercode");
  assert.equal(new URL(lamp.url).searchParams.get("tag"), ASSOCIATE_TAG);
  assert.match(lamp.url, /\/promocode\//);
  assert.equal(dealLinkLabel(lamp), CHECKOUT_DISCOUNT_LABEL);
  assert.equal(written.deals.some((deal) => deal.id === "B0EXPIRE01"), false);
  assert.equal(written.deals.some((deal) => deal.id === "B0INACTIVE"), false);
  assert.equal(written.deals.some((deal) => deal.id === "B0ONESIE01"), false);
  assert.equal(written.deals.some((deal) => deal.id === "B0STOCK001"), false);
  assert.equal(written.deals.some((deal) => deal.id === "B0STAY0001"), true);
  assert.equal(written.deals.some((deal) => deal.id === "hand-pan"), true);
  assert.equal(JSON.stringify(written).includes(promoKey), false);
  assert.match(result.offerNotes.join("\n"), /usage 5\/100 \(95 remaining\)/);
  assert.match(result.offerNotes.join("\n"), /429/);
  assert.equal(result.offerNotes.join("\n").includes(promoKey), false);

  writeFileSync(dealsPath, `${JSON.stringify({ about: "keep", deals: [existing, handwritten] }, null, 2)}\n`);
  const failed = await refreshDealsFile({
    asinsPath: join(dir, "asins.json"),
    dealsPath,
    offerConfigPath: join(dir, "amazonoffercode.json"),
    env: {
      CREATORS_API_CREDENTIAL_ID: "credential-id",
      CREATORS_API_CREDENTIAL_SECRET: "super-secret-value-do-not-print",
      AMAZONOFFERCODE_API_KEY: promoKey,
    },
    today,
    fetchImpl: async (url) => {
      const href = String(url);
      if (href.includes("/auth/o2/token")) return jsonResponse({ access_token: "token-value" });
      if (href.includes("getItems")) {
        return jsonResponse({
          itemsResult: { items: [creatorsItem({ asin: "B0KEEP0001" }), creatorsItem({ asin: "B0PLAIN001" })] },
        });
      }
      throw new Error(`promo down ${promoKey}`);
    },
  });
  assert.equal(failed.changed, true);
  const afterFailure = JSON.parse(readFileSync(dealsPath, "utf8"));
  assert.equal(afterFailure.deals.some((deal) => deal.id === "B0KEEP0001"), true);
  assert.equal(afterFailure.deals.some((deal) => deal.id === "B0PLAIN001"), true);
  assert.match(failed.offerNotes.join("\n"), /Creators API deals were kept/);
  assert.equal(failed.offerNotes.join("\n").includes(promoKey), false);
  rmSync(dir, { recursive: true, force: true });
});

test("a 500 is retried and the workflow reads the key from the repo secret", async () => {
  let attempts = 0;
  const fetched = await fetchAmazonOfferCodes({
    config: loadOfferConfig({ categories: ["electronics"] }),
    env: { AMAZONOFFERCODE_API_KEY: promoKey, AOC_USE_OWN_TAG: "false" },
    today,
    sleep: () => {},
    fetchImpl: async () => {
      attempts += 1;
      if (attempts < 3) return jsonResponse({ message: promoKey }, 500);
      return jsonResponse({
        data: [offerRow({ coupon_code: null, amazon_link: "https://www.amazon.com/promocode/A25MGS6T831FVU?tag=their-20" })],
        meta: { usage: { used: 1, limit: 100, remaining: 99 } },
      });
    },
  });
  assert.equal(attempts, 3);
  assert.equal(fetched.offers[0].preserveAffiliateTag, true);
  assert.equal(new URL(fetched.offers[0].url).searchParams.get("tag"), "their-20");
  assert.equal(fetched.notes.join("\n").includes(promoKey), false);

  const unauthorized = await fetchAmazonOfferCodes({
    config: loadOfferConfig({ categories: ["electronics", "home"] }),
    env: { AMAZONOFFERCODE_API_KEY: promoKey },
    today,
    fetchImpl: async () => jsonResponse({}, 401),
  });
  assert.match(unauthorized.notes.join("\n"), /401/);
  assert.equal(unauthorized.offers.length, 0);

  const codedKey = "promo/key+value secret";
  const leaked = await fetchAmazonOfferCodes({
    config: loadOfferConfig({ categories: ["electronics"] }),
    env: { AMAZONOFFERCODE_API_KEY: codedKey },
    today,
    fetchImpl: async (url) => {
      const error = new Error("fetch failed");
      error.cause = new Error(`connect ${String(url)}`);
      throw error;
    },
  });
  const leakedLog = leaked.notes.join("\n");
  assert.equal(leakedLog.includes(codedKey), false);
  assert.equal(leakedLog.includes(encodeURIComponent(codedKey)), false);
  assert.match(leakedLog, /token=\[redacted\]/);
  assert.match(leakedLog, /Creators API deals were kept/);

  const workflow = read(".github/workflows/refresh-deals.yml");
  assert.match(workflow, /AMAZONOFFERCODE_API_KEY: \$\{\{ secrets\.AMAZONOFFERCODE_API_KEY \}\}/);
  assert.match(workflow, /AOC_USE_OWN_TAG: \$\{\{ vars\.AOC_USE_OWN_TAG \}\}/);
  assert.doesNotMatch(workflow, /AMAZONOFFERCODE_API_KEY:\s*["'][A-Za-z0-9]/);
  assert.match(read("js/app.js"), /copy-btn/);
  assert.match(read("js/app.js"), /dealLinkLabel\(deal\)/);
  const request = offerRequestUrl("electronics", {
    token: "example",
    limit: 100,
    active: true,
    marketplace: "us",
    sort: "newest",
  });
  assert.equal(request.searchParams.get("category"), "electronics");
  assert.equal(request.searchParams.get("limit"), "100");
});

test("the promo-page tag check reports a redirect that drops the tag and one that keeps it", async () => {
  const dropped = await tracePromoTag(
    "https://www.amazon.com/promocode/A25MGS6T831FVU?tag=onamzeddie0c-20",
    async (url) => {
      if (String(url).includes("/promocode/")) {
        return {
          status: 302,
          headers: { get: (name) => (name.toLowerCase() === "location" ? "https://www.amazon.com/dp/B0GN91F43B" : "") },
        };
      }
      return { status: 200, headers: { get: () => "" } };
    },
  );
  assert.equal(dropped.startedWithTag, true);
  assert.equal(dropped.keptTag, false);
  assert.equal(dropped.finalTag, null);
  assert.equal(dropped.hops.length, 2);
  assert.match(dropped.hops[0].location, /\/dp\/B0GN91F43B$/);

  const kept = await tracePromoTag(
    "https://www.amazon.com/promocode/A25MGS6T831FVU?tag=onamzeddie0c-20",
    async (url) => {
      if (String(url).includes("/promocode/")) {
        return {
          status: 302,
          headers: { get: () => "https://www.amazon.com/dp/B0GN91F43B?tag=onamzeddie0c-20" },
        };
      }
      return { status: 200, headers: { get: () => "" } };
    },
  );
  assert.equal(kept.keptTag, true);
  assert.equal(kept.finalTag, ASSOCIATE_TAG);
  assert.equal(kept.hops.length, 2);
});

test("promo deals fill only the maxDeals room left after paged discovery", async () => {
  async function run({ maxDeals, pages }) {
    const dir = mkdtempSync(join(tmpdir(), "rawdeals-paged-offer-"));
    const dealsPath = join(dir, "deals.json");
    const existing = {
      id: "B0PLAIN001",
      title: "Creators headphones",
      image: "https://m.media-amazon.com/images/I/keep.jpg",
      price: 30,
      originalPrice: 40,
      percentOff: 25,
      category: "Tech",
      url: "https://www.amazon.com/dp/B0PLAIN001?tag=onamzeddie0c-20",
      added: "2026-11-10",
      sample: false,
      source: "api",
    };
    writeFileSync(dealsPath, `${JSON.stringify({ deals: [existing] }, null, 2)}\n`);
    writeFileSync(join(dir, "asins.json"), JSON.stringify([{ asin: "B0PLAIN001", category: "Tech", title: "Creators headphones" }]));
    writeFileSync(join(dir, "discovery.json"), JSON.stringify({
      minDiscountPercent: 20,
      minRating: 4,
      maxDeals,
      pagesPerKeyword: 2,
      keywordsPerRun: 1,
      maxRequests: 8,
      searches: [{ keywords: "headphones", searchIndex: "Electronics", category: "Tech" }],
    }));
    writeFileSync(join(dir, "amazonoffercode.json"), JSON.stringify({
      categories: ["electronics"],
      limit: 100,
      active: true,
      marketplace: "us",
      sort: "newest",
      maxCallsPerRun: 3,
      useOwnTag: true,
    }));
    const searchPages = [];
    const result = await refreshDealsFile({
      asinsPath: join(dir, "asins.json"),
      dealsPath,
      discoveryPath: join(dir, "discovery.json"),
      offerConfigPath: join(dir, "amazonoffercode.json"),
      env: {
        CREATORS_API_CREDENTIAL_ID: "credential-id",
        CREATORS_API_CREDENTIAL_SECRET: "super-secret-value-do-not-print",
        AMAZONOFFERCODE_API_KEY: promoKey,
      },
      today,
      sleep: () => {},
      fetchImpl: async (url, options) => {
        const href = String(url);
        if (href.includes("/auth/o2/token")) return jsonResponse({ access_token: "token-value" });
        if (href.includes("getItems")) return jsonResponse({ itemsResult: { items: [creatorsItem({ asin: "B0PLAIN001", title: "Fresh plain" })] } });
        if (href.includes("searchItems")) {
          const body = JSON.parse(options.body);
          searchPages.push(body.itemPage);
          const pageItems = pages[body.itemPage] || [];
          return jsonResponse({ searchResult: { items: pageItems, totalResultCount: 20 } });
        }
        if (href.includes("promo-api")) {
          return jsonResponse({
            data: [
              offerRow({ asin: "B0PLAIN001", coupon_code: "SAVE20", title: "Promo title should not win", price: "$1.00" }),
              offerRow({ asin: "B0AOC00001", coupon_code: "CODE1", title: "Promo one", category: "electronics" }),
              offerRow({ asin: "B0AOC00002", coupon_code: "CODE2", title: "Promo two", category: "home" }),
            ],
            meta: { total: 3, page: 1, limit: 100, has_more: false, usage: { used: 6, limit: 100, remaining: 94 } },
          });
        }
        throw new Error(`unexpected ${href}`);
      },
    });
    const written = JSON.parse(readFileSync(dealsPath, "utf8"));
    rmSync(dir, { recursive: true, force: true });
    return { result, searchPages, deals: written.deals };
  }

  function searchItem(asin) {
    return creatorsItem({ asin, title: `Found ${asin}` });
  }

  const room = await run({
    maxDeals: 2,
    pages: { 1: [searchItem("B0PAGE0001")], 2: [] },
  });
  assert.deepEqual(room.searchPages, [1, 2]);
  const roomIds = room.deals.map((deal) => deal.id);
  assert.equal(roomIds.includes("B0PAGE0001"), true);
  assert.equal(roomIds.includes("B0AOC00001") || roomIds.includes("B0AOC00002"), true);
  assert.equal(roomIds.includes("B0AOC00001") && roomIds.includes("B0AOC00002"), false);
  assert.equal(room.deals.find((deal) => deal.id === "B0PLAIN001").promoCode, "SAVE20");
  assert.equal(room.deals.find((deal) => deal.id === "B0PLAIN001").price, 19.99);
  assert.equal(room.result.offerNotes.join("\n").includes(promoKey), false);

  const full = await run({
    maxDeals: 1,
    pages: { 1: [searchItem("B0PAGE0001")], 2: [searchItem("B0PAGE0002")] },
  });
  assert.deepEqual(full.searchPages, [1]);
  assert.equal(full.deals.some((deal) => deal.id === "B0PAGE0001"), true);
  assert.equal(full.deals.some((deal) => deal.id === "B0AOC00001"), false);
  assert.equal(full.deals.some((deal) => deal.id === "B0AOC00002"), false);
  assert.equal(full.deals.find((deal) => deal.id === "B0PLAIN001").promoCode, "SAVE20");
});
