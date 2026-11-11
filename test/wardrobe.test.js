import assert from "node:assert/strict";
import test from "node:test";
import { CATEGORY_ORDER, DISPLAY_CATEGORIES } from "../js/categories.js";
import {
  categoriesIn,
  groupDeals,
  isBabyOrInfantTitle,
  isVisibleDeal,
  visibleDeals,
} from "../js/deals.js";
import { selectDiscoveredDeals } from "../scripts/fetch-deals.js";

const today = "2026-11-11";

function item({ asin, title, percent = 40, rating = 4.5 }) {
  return {
    asin,
    detailPageURL: `https://www.amazon.com/dp/${asin}`,
    images: { primary: { large: { url: "https://m.media-amazon.com/images/I/new.jpg" } } },
    itemInfo: { title: { displayValue: title } },
    customerReviews: { starRating: rating },
    offersV2: {
      listings: [{
        isBuyBoxWinner: true,
        price: {
          money: { amount: 20 },
          savingBasis: { money: { amount: 40 } },
          savings: { percentage: percent },
        },
      }],
    },
  };
}

function deal(overrides) {
  return {
    id: "x",
    title: "Plain deal",
    price: 10,
    percentOff: 20,
    category: "Home",
    url: "https://www.amazon.com/dp/B0TEST",
    added: today,
    sample: false,
    image: "https://example.com/a.jpg",
    ...overrides,
  };
}

test("baby and infant products are hidden, and Baby Blue is not", () => {
  assert.equal(isBabyOrInfantTitle("Baby Blue Men's Hoodie"), false);
  assert.equal(isBabyOrInfantTitle("Baby-Pink Women's Jacket"), false);
  assert.equal(isBabyOrInfantTitle("Babydoll dress"), false);
  assert.equal(isBabyOrInfantTitle("Cotton baby onesie 3 pack"), true);
  assert.equal(isBabyOrInfantTitle("Baby Blue infant romper"), true);
  assert.equal(isBabyOrInfantTitle("Newborn swaddle"), true);
  assert.equal(isBabyOrInfantTitle("Toddler bib and burp cloth set"), true);
  const kept = deal({ id: "blue", title: "Baby Blue Men's Hoodie", category: "Clothing" });
  const dropped = deal({ id: "onesie", title: "Organic baby onesie", category: "Clothing" });
  assert.deepEqual(visibleDeals([kept, dropped], today).map((entry) => entry.id), ["blue"]);
  assert.equal(isVisibleDeal(dropped, today), false);
});

test("mens and womens clothing is shown ahead of other clothing", () => {
  const groups = groupDeals([
    deal({ id: "belt", title: "Leather belt", category: "Clothing" }),
    deal({ id: "lamp", title: "Desk lamp", category: "Home" }),
    deal({ id: "hoodie", title: "Men's Hoodie", category: "Clothing" }),
    deal({ id: "dress", title: "Women's summer dress", category: "Clothing", added: "2026-11-10" }),
  ]);
  assert.deepEqual(groups[0].deals.map((entry) => entry.id), ["hoodie", "lamp", "belt"]);
  assert.deepEqual(groups[1].deals.map((entry) => entry.id), ["dress"]);
});

test("filter chips put Tech and Gaming first and General last", () => {
  assert.deepEqual(DISPLAY_CATEGORIES, [
    "Tech",
    "Gaming",
    "Kitchen",
    "Home",
    "Pets",
    "Fragrances",
    "Drinks",
    "Household",
    "Toys",
    "Sports",
    "Food",
    "Clothing",
  ]);
  assert.deepEqual(categoriesIn([
    { category: "General" },
    { category: "Clothing" },
    { category: "Tech" },
    { category: "Gaming" },
    { category: "Kitchen" },
    { category: "ZZZ" },
  ]), ["All", "Tech", "Gaming", "Kitchen", "Clothing", "ZZZ", "General"]);
  assert.ok(CATEGORY_ORDER.indexOf("Tech") < CATEGORY_ORDER.indexOf("Gaming"));
  assert.ok(CATEGORY_ORDER.indexOf("Gaming") < CATEGORY_ORDER.indexOf("Kitchen"));
  assert.ok(CATEGORY_ORDER.indexOf("Toys") < CATEGORY_ORDER.indexOf("Sports"));
  assert.ok(CATEGORY_ORDER.indexOf("Food") < CATEGORY_ORDER.indexOf("Clothing"));
});

test("discovery drops baby items and boosts watched products", () => {
  const picked = selectDiscoveredDeals([
    { category: "Clothing", item: item({ asin: "ONESIE", title: "Baby onesie 5 pack", percent: 80 }) },
    { category: "Clothing", item: item({ asin: "SHOES", title: "Running shoes", percent: 55 }) },
    { category: "Clothing", item: item({ asin: "HOOD", title: "Men's Hoodie", percent: 25 }) },
    { category: "Gaming", item: item({ asin: "GAME", title: "Video game console", percent: 60 }) },
    { category: "Tech", item: item({ asin: "HEAD", title: "Wireless Gaming Headset", percent: 22 }) },
    { category: "Tech", item: item({ asin: "LIGHTS", title: "Govee Permanent Outdoor Lights", percent: 21 }) },
    { category: "Tech", item: item({ asin: "MIC", title: "USB Gaming Microphone", percent: 30 }) },
  ], {
    today,
    minDiscountPercent: 20,
    minRating: 4,
    maxDeals: 6,
  });
  assert.equal(picked.some((entry) => entry.id === "ONESIE"), false);
  assert.equal(picked[0].id, "HOOD");
  const headset = picked.find((entry) => entry.id === "HEAD");
  const mic = picked.find((entry) => entry.id === "MIC");
  const lights = picked.find((entry) => entry.id === "LIGHTS");
  assert.equal(headset.category, "Gaming");
  assert.equal(headset.priority, true);
  assert.equal(mic.category, "Gaming");
  assert.equal(mic.priority, true);
  assert.equal(lights.category, "Home");
  assert.equal(lights.priority, true);
  assert.ok(picked.findIndex((entry) => entry.id === "HEAD") < picked.findIndex((entry) => entry.id === "GAME"));
});
