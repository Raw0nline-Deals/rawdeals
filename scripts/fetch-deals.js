/**
 * Refresh deals in data/deals.json from the Amazon Creators API.
 *
 * Without --live, this prints the request it would make and does not use the network.
 * With --live, it refreshes the ASINs in data/asins.json and also searches for deals
 * described in data/discovery.json. Hand-written deals are left in the file.
 * Hand-picked ASINs take priority over discovered ones.
 *
 * Credentials come from the environment. They are never printed. A failed auth,
 * GetItems, or SearchItems call exits non-zero and does not write deals.json.
 */
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ASSOCIATE_TAG } from "../js/affiliate.js";
import { displayCategoryFromItem } from "../js/categories.js";
import { isActiveDeal, isExpired, todayISO } from "../js/deals.js";

export const GET_ITEMS_URL = "https://creatorsapi.amazon/catalog/v1/getItems";
export const SEARCH_ITEMS_URL = "https://creatorsapi.amazon/catalog/v1/searchItems";
export const ASIN_BATCH_SIZE = 10;
export const SEARCH_ITEM_COUNT = 10;
export const MAX_DISCOVERY_SEARCHES = 16;

export const GET_ITEMS_RESOURCES = [
  "images.primary.large",
  "itemInfo.title",
  "itemInfo.classifications",
  "browseNodeInfo.browseNodes",
  "offersV2.listings.price",
  "offersV2.listings.dealDetails",
  "offersV2.listings.isBuyBoxWinner",
  "offersV2.listings.availability",
];

const UNAVAILABLE = new Set([
  "OUT_OF_STOCK",
  "UNAVAILABLE",
  "AVAILABLE_DATE",
  "PREORDER",
]);

export function tokenEndpoint(version = "3.1") {
  const value = String(version);
  if (value.startsWith("3.3")) return "https://api.amazon.co.jp/auth/o2/token";
  if (value.startsWith("3.2")) return "https://api.amazon.co.uk/auth/o2/token";
  return "https://api.amazon.com/auth/o2/token";
}

export function credentialStatus(env = process.env) {
  return {
    idSet: Boolean(env.CREATORS_API_CREDENTIAL_ID),
    secretSet: Boolean(env.CREATORS_API_CREDENTIAL_SECRET),
    version: env.CREATORS_API_CREDENTIAL_VERSION || "3.1",
    partnerTag: env.CREATORS_API_PARTNER_TAG || ASSOCIATE_TAG,
  };
}

export function buildGetItemsBody(asins, partnerTag = ASSOCIATE_TAG) {
  return {
    itemIds: asins,
    itemIdType: "ASIN",
    marketplace: "www.amazon.com",
    partnerTag,
    resources: GET_ITEMS_RESOURCES,
  };
}

export function amazonMinReviewsRating(minRating) {
  const rounded = Math.round(Number(minRating));
  if (!Number.isFinite(rounded)) return 4;
  return Math.min(4, Math.max(1, rounded));
}

export function buildSearchBody(search, { partnerTag = ASSOCIATE_TAG, minDiscountPercent, minRating } = {}) {
  const body = {
    keywords: search.keywords,
    marketplace: "www.amazon.com",
    partnerTag,
    itemCount: SEARCH_ITEM_COUNT,
    itemPage: 1,
    availability: "Available",
    condition: "New",
    minSavingPercent: minDiscountPercent,
    minReviewsRating: amazonMinReviewsRating(minRating),
    sortBy: "AvgCustomerReviews",
    resources: GET_ITEMS_RESOURCES,
  };
  if (search.searchIndex) body.searchIndex = search.searchIndex;
  return body;
}

export function pickListing(item) {
  const listings = item?.offersV2?.listings || [];
  return listings.find((entry) => entry.isBuyBoxWinner) || listings[0] || null;
}

export function availabilityStatus(listing) {
  const raw = listing?.availability?.type ?? listing?.availability?.Type;
  if (raw == null || String(raw).trim() === "") return "unknown";
  const type = String(raw).trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (type === "IN_STOCK" || type === "IN_STOCK_SCARCE") return "in_stock";
  if (UNAVAILABLE.has(type)) return "unavailable";
  return "unknown";
}

export function readStarRating(item) {
  const raw = item?.customerReviews?.starRating;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") return parseRating(raw);
  if (raw && typeof raw === "object") {
    const candidate = raw.value ?? raw.displayValue ?? raw.rating;
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
    if (typeof candidate === "string") return parseRating(candidate);
  }
  return null;
}

function parseRating(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function mapCreatorsItemToDeal(item, extras = {}, added) {
  const listing = pickListing(item);
  if (!listing || listing.violatesMAP || listing.price?.money?.amount == null) return null;

  const price = listing.price.money.amount;
  const original = listing.price.savingBasis?.money?.amount;
  let percentOff = listing.price.savings?.percentage;
  if (typeof percentOff !== "number" && typeof original === "number" && original > price) {
    percentOff = Math.round((1 - price / original) * 100);
  }
  if (typeof percentOff !== "number" || !Number.isFinite(percentOff)) percentOff = 0;

  const deal = {
    id: extras.id || item.asin,
    title: item.itemInfo?.title?.displayValue || extras.title || item.asin,
    image: item.images?.primary?.large?.url || extras.image || "",
    price,
    percentOff,
    category: extras.category || "General",
    url: item.detailPageURL,
    added,
    sample: false,
  };
  if (typeof original === "number") deal.originalPrice = original;
  if (extras.promoCode) deal.promoCode = extras.promoCode;
  const end = listing.dealDetails?.endTime;
  if (end) deal.expires = String(end).slice(0, 10);
  return deal;
}

export function mergeDeals(existing, incoming) {
  const seen = new Set(existing.map((deal) => deal.id));
  const novel = incoming.filter((deal) => deal && !seen.has(deal.id));
  return [...novel, ...existing];
}

export function chunkList(items, size = ASIN_BATCH_SIZE) {
  if (!Number.isInteger(size) || size < 1) throw new Error("Batch size must be a positive integer.");
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

export function redactSecrets(message, secrets) {
  let text = String(message ?? "");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret) text = text.split(secret).join("[redacted]");
  }
  return text;
}

export function loadAsinEntries(payload) {
  if (!Array.isArray(payload)) throw new Error("data/asins.json must be a JSON array.");
  const seen = new Set();
  return payload.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`asins[${index}] must be an object.`);
    }
    if (typeof entry.asin !== "string" || !entry.asin.trim()) {
      throw new Error(`asins[${index}].asin is required.`);
    }
    const asin = entry.asin.trim();
    if (seen.has(asin)) throw new Error(`Duplicate ASIN ${asin}.`);
    seen.add(asin);
    const clean = { asin };
    copyOptionalString(entry, clean, "promoCode", index);
    copyOptionalString(entry, clean, "category", index);
    copyOptionalString(entry, clean, "title", index);
    copyOptionalString(entry, clean, "image", index);
    if (entry.expires != null) {
      if (typeof entry.expires !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry.expires)) {
        throw new Error(`asins[${index}].expires must be YYYY-MM-DD.`);
      }
      clean.expires = entry.expires;
    }
    return clean;
  });
}

function copyOptionalString(entry, clean, key, index) {
  if (entry[key] == null) return;
  if (typeof entry[key] !== "string" || !entry[key].trim()) {
    throw new Error(`asins[${index}].${key} must be a non-empty string when present.`);
  }
  clean[key] = entry[key].trim();
}

export function emptyDiscovery() {
  return { minDiscountPercent: 20, minRating: 4, maxDeals: 20, searches: [] };
}

export function loadDiscoveryConfig(payload) {
  if (payload == null) return emptyDiscovery();
  if (typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("data/discovery.json must be a JSON object.");
  }
  const allowed = new Set(["_comment", "minDiscountPercent", "minRating", "maxDeals", "searches"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) {
      throw new Error(`Unknown field "${key}" in data/discovery.json. You can set minDiscountPercent, minRating, maxDeals, and searches.`);
    }
  }
  if (payload.minDiscountPercent == null || payload.minRating == null || payload.maxDeals == null || payload.searches == null) {
    throw new Error("data/discovery.json needs minDiscountPercent, minRating, maxDeals, and searches.");
  }
  return {
    minDiscountPercent: readBoundedInteger(payload.minDiscountPercent, "minDiscountPercent", 1, 99),
    minRating: readRating(payload.minRating),
    maxDeals: readBoundedInteger(payload.maxDeals, "maxDeals", 1, 40),
    searches: readSearches(payload.searches),
  };
}

function readBoundedInteger(value, label, min, max) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`discovery.${label} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

function readRating(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > 5) {
    throw new Error("discovery.minRating must be a number from 1 to 5.");
  }
  return value;
}

function readSearches(value) {
  if (!Array.isArray(value)) throw new Error("discovery.searches must be a list.");
  if (value.length > MAX_DISCOVERY_SEARCHES) {
    throw new Error(`discovery.searches can have at most ${MAX_DISCOVERY_SEARCHES} searches so the daily job does not call Amazon too many times.`);
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`searches[${index}] must be an object.`);
    }
    const allowed = new Set(["keywords", "searchIndex", "category"]);
    for (const key of Object.keys(entry)) {
      if (!allowed.has(key)) {
        throw new Error(`searches[${index}].${key} is not a field you can set. Use keywords, searchIndex, and category.`);
      }
    }
    if (typeof entry.keywords !== "string" || !entry.keywords.trim()) {
      throw new Error(`searches[${index}].keywords is required.`);
    }
    const search = { keywords: entry.keywords.trim() };
    if (entry.searchIndex != null) {
      if (typeof entry.searchIndex !== "string" || !entry.searchIndex.trim()) {
        throw new Error(`searches[${index}].searchIndex must be a non-empty string when present.`);
      }
      search.searchIndex = entry.searchIndex.trim();
    }
    if (entry.category != null) {
      if (typeof entry.category !== "string" || !entry.category.trim()) {
        throw new Error(`searches[${index}].category must be a non-empty string when present.`);
      }
      search.category = entry.category.trim();
    }
    return search;
  });
}

export function readDiscoveryFile(discoveryPath) {
  try {
    return loadDiscoveryConfig(JSON.parse(readFileSync(discoveryPath, "utf8")));
  } catch (error) {
    if (error && error.code === "ENOENT") return emptyDiscovery();
    if (error instanceof SyntaxError) throw new Error("data/discovery.json is not valid JSON.");
    throw error;
  }
}

/**
 * Build one API deal. Returns null when the item has no usable offer, violates MAP,
 * is unavailable, or no longer has a discount (unless the ASIN list has a promo code).
 * A category typed in the ASIN list wins. Otherwise Amazon's department is used.
 * Keeps the first-seen added date and an existing title unless the ASIN list overrides it.
 */
export function dealFromCreatorsItem(item, entry, { today, existing }) {
  if (availabilityStatus(pickListing(item)) === "unavailable") return null;
  const mapped = mapCreatorsItemToDeal(item, {
    id: entry.asin,
    promoCode: entry.promoCode,
  }, existing?.added || today);
  if (!mapped) return null;
  if (!(mapped.percentOff > 0 || entry.promoCode)) return null;

  const deal = {
    id: entry.asin,
    title: entry.title || existing?.title || mapped.title,
    image: entry.image || mapped.image || existing?.image || "",
    price: mapped.price,
  };
  if (typeof mapped.originalPrice === "number") deal.originalPrice = mapped.originalPrice;
  deal.percentOff = mapped.percentOff;
  if (entry.promoCode) deal.promoCode = entry.promoCode;
  deal.category = entry.category || displayCategoryFromItem(item) || existing?.category || "General";
  deal.url = mapped.url;
  deal.added = existing?.added || today;
  const expires = entry.expires || mapped.expires;
  if (expires) deal.expires = expires;
  deal.sample = false;
  deal.source = "api";
  return deal;
}

export function dealFromDiscoveredItem(item, { today, existing, category, minDiscountPercent, minRating }) {
  if (availabilityStatus(pickListing(item)) === "unavailable") return null;
  const mapped = mapCreatorsItemToDeal(item, { id: item?.asin }, existing?.added || today);
  if (!mapped || !item?.asin) return null;
  if (isExpired(mapped, today)) return null;
  if (!(mapped.percentOff >= minDiscountPercent)) return null;
  if (!mapped.image && !existing?.image) return null;
  if (typeof mapped.url !== "string" || !mapped.url.startsWith("https://")) return null;
  const rating = readStarRating(item);
  if (rating != null && rating < minRating) return null;

  const deal = {
    id: item.asin,
    title: mapped.title,
    image: mapped.image || existing?.image || "",
    price: mapped.price,
    percentOff: mapped.percentOff,
    category: category || displayCategoryFromItem(item) || existing?.category || "General",
    url: mapped.url,
    added: existing?.added || today,
    sample: false,
    source: "api",
    discovered: true,
  };
  if (typeof mapped.originalPrice === "number") deal.originalPrice = mapped.originalPrice;
  if (mapped.expires) deal.expires = mapped.expires;
  return { deal, rating };
}

/**
 * Keep at most maxDeals, taking the best item from each category before taking a second.
 * @param {{ item: object, category?: string }[]} taggedItems
 */
export function selectDiscoveredDeals(taggedItems, {
  today,
  existingDeals = [],
  blockedAsins = new Set(),
  minDiscountPercent,
  minRating,
  maxDeals,
}) {
  const existingById = new Map(
    existingDeals.filter((deal) => deal && deal.source === "api").map((deal) => [deal.id, deal]),
  );
  const buckets = new Map();
  const seen = new Set();
  for (const tagged of taggedItems) {
    const item = tagged?.item;
    const asin = item?.asin;
    if (!asin || blockedAsins.has(asin) || seen.has(asin)) continue;
    const qualified = dealFromDiscoveredItem(item, {
      today,
      existing: existingById.get(asin),
      category: tagged.category,
      minDiscountPercent,
      minRating,
    });
    if (!qualified) continue;
    seen.add(asin);
    if (!buckets.has(qualified.deal.category)) buckets.set(qualified.deal.category, []);
    buckets.get(qualified.deal.category).push(qualified);
  }
  for (const list of buckets.values()) {
    list.sort((a, b) => {
      if (b.deal.percentOff !== a.deal.percentOff) return b.deal.percentOff - a.deal.percentOff;
      const ratingDelta = (b.rating ?? -1) - (a.rating ?? -1);
      if (ratingDelta !== 0) return ratingDelta;
      return a.deal.id < b.deal.id ? -1 : a.deal.id > b.deal.id ? 1 : 0;
    });
  }
  const picked = [];
  let round = 0;
  while (picked.length < maxDeals) {
    let added = false;
    for (const list of buckets.values()) {
      if (picked.length >= maxDeals) break;
      const next = list[round];
      if (!next) continue;
      picked.push(next.deal);
      added = true;
    }
    if (!added) break;
    round += 1;
  }
  return picked;
}

/**
 * @param {object[]} existingDeals
 * @param {Map<string, object|null>} updates asin -> refreshed deal, or null to drop it
 * @param {string} today YYYY-MM-DD in America/Chicago
 * @param {object[]} discovered deals selected from search, already capped
 */
export function mergeApiDeals(existingDeals, updates, today, discovered = []) {
  const discoveredById = new Map();
  for (const deal of discovered) {
    if (deal && !updates.has(deal.id)) discoveredById.set(deal.id, deal);
  }
  const kept = [];
  const seen = new Set();

  for (const deal of existingDeals) {
    if (deal.source === "api" && updates.has(deal.id)) {
      seen.add(deal.id);
      const next = updates.get(deal.id);
      if (isActiveDeal(next, today)) kept.push(next);
      continue;
    }
    if (deal.source === "api" && deal.discovered) {
      seen.add(deal.id);
      const next = discoveredById.get(deal.id);
      if (next && isActiveDeal(next, today)) kept.push({ ...next, added: deal.added || next.added });
      discoveredById.delete(deal.id);
      continue;
    }
    if (deal.source === "api" && !isActiveDeal(deal, today)) continue;
    kept.push(deal);
  }

  const novel = [];
  for (const [id, deal] of updates) {
    if (!seen.has(id) && isActiveDeal(deal, today)) novel.push(deal);
  }
  for (const deal of discoveredById.values()) {
    if (isActiveDeal(deal, today)) novel.push(deal);
  }
  return [...novel, ...kept];
}

export function planText({ entries, status, discovery }) {
  const asins = entries.map((entry) => entry.asin);
  const body = buildGetItemsBody(asins, status.partnerTag);
  const lines = [
    "RawDeals Creators API dry run",
    "Live calls: not requested",
    `Credential ID: ${status.idSet ? "set" : "missing"}`,
    `Credential secret: ${status.secretSet ? "set (not shown)" : "missing"}`,
    `Credential version: ${status.version}`,
    `Would request a token from ${tokenEndpoint(status.version)} (not called).`,
    `Would POST ${GET_ITEMS_URL} in batches of ${ASIN_BATCH_SIZE} (not called).`,
    `partnerTag: ${body.partnerTag}`,
    `itemIds: ${body.itemIds.join(", ") || "(none)"}`,
  ];
  if (discovery?.searches?.length) {
    lines.push(
      `Would POST ${SEARCH_ITEMS_URL} for ${discovery.searches.length} searches (not called).`,
      `Discovery keeps up to ${discovery.maxDeals} deals, at least ${discovery.minDiscountPercent}% off, rating ${discovery.minRating} or better.`,
      `Searches: ${discovery.searches.map((search) => search.category || search.keywords).join(", ")}`,
    );
  }
  lines.push("No request was sent.");
  return lines.join("\n");
}

export async function fetchCreatorsItems({ entries, env, fetchImpl, partnerTag }) {
  const catalog = await fetchCreatorsCatalog({
    entries,
    searches: [],
    discovery: emptyDiscovery(),
    env,
    fetchImpl,
    partnerTag,
  });
  return catalog.byAsin;
}

export async function fetchCreatorsCatalog({ entries, searches = [], discovery, env, fetchImpl, partnerTag }) {
  const id = env.CREATORS_API_CREDENTIAL_ID;
  const secret = env.CREATORS_API_CREDENTIAL_SECRET;
  const version = env.CREATORS_API_CREDENTIAL_VERSION || "3.1";
  if (!id || !secret) throw new Error("Missing Creators API credentials. No request was sent.");

  let token = "";
  const secrets = () => [id, secret, token];
  const fail = (message) => {
    throw new Error(redactSecrets(message, secrets()));
  };

  let tokenResponse;
  try {
    tokenResponse = await fetchImpl(tokenEndpoint(version), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: id,
        client_secret: secret,
        scope: "creatorsapi::default",
      }),
    });
  } catch (error) {
    fail(`Creators API token request failed. ${error instanceof Error ? error.message : ""}`.trim());
  }
  if (!tokenResponse?.ok) fail(`Creators API token request failed (${tokenResponse?.status ?? "no status"}).`);
  const tokenBody = await tokenResponse.json();
  if (!tokenBody || typeof tokenBody.access_token !== "string" || !tokenBody.access_token) {
    fail("Creators API token response was missing an access token.");
  }
  token = tokenBody.access_token;

  const byAsin = new Map();
  if (entries.length > 0) {
    for (const batch of chunkList(entries.map((entry) => entry.asin), ASIN_BATCH_SIZE)) {
      const response = await postCatalog(fetchImpl, token, GET_ITEMS_URL, buildGetItemsBody(batch, partnerTag), fail, "GetItems");
      const body = await response.json();
      if (!body?.itemsResult) fail("Creators API GetItems response was missing itemsResult.");
      const items = body.itemsResult.items || [];
      if (items.length === 0 && Array.isArray(body.errors) && body.errors.length > 0) {
        fail("Creators API GetItems returned errors and no items.");
      }
      for (const item of items) {
        if (item?.asin) byAsin.set(item.asin, item);
      }
    }
  }

  const groups = [];
  for (const search of searches) {
    const response = await postCatalog(
      fetchImpl,
      token,
      SEARCH_ITEMS_URL,
      buildSearchBody(search, {
        partnerTag,
        minDiscountPercent: discovery.minDiscountPercent,
        minRating: discovery.minRating,
      }),
      fail,
      "SearchItems",
    );
    const body = await response.json();
    if (!body?.searchResult) fail("Creators API SearchItems response was missing searchResult.");
    groups.push({ category: search.category, items: body.searchResult.items || [] });
  }
  return { byAsin, groups };
}

async function postCatalog(fetchImpl, token, url, body, fail, label) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "x-marketplace": "www.amazon.com",
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    fail(`Creators API ${label} request failed. ${error instanceof Error ? error.message : ""}`.trim());
  }
  if (!response?.ok) fail(`Creators API ${label} request failed (${response?.status ?? "no status"}).`);
  return response;
}

export function buildUpdates(existingDeals, entries, itemsByAsin, today) {
  const updates = new Map();
  for (const entry of entries) {
    const existing = existingDeals.find((deal) => deal.id === entry.asin && deal.source === "api");
    const item = itemsByAsin.get(entry.asin);
    if (!item) {
      updates.set(entry.asin, null);
      continue;
    }
    const deal = dealFromCreatorsItem(item, entry, { today, existing });
    updates.set(entry.asin, deal && !isExpired(deal, today) ? deal : null);
  }
  return updates;
}

export async function refreshDealsFile({
  asinsPath,
  dealsPath,
  discoveryPath,
  env = process.env,
  fetchImpl = globalThis.fetch,
  today = todayISO(),
  partnerTag = ASSOCIATE_TAG,
}) {
  const entries = loadAsinEntries(JSON.parse(readFileSync(asinsPath, "utf8")));
  const discovery = discoveryPath ? readDiscoveryFile(discoveryPath) : emptyDiscovery();
  if (entries.length === 0 && discovery.searches.length === 0) return { changed: false, reason: "empty" };

  const before = readFileSync(dealsPath, "utf8");
  const payload = JSON.parse(before);
  const existingDeals = Array.isArray(payload) ? payload : payload?.deals;
  if (!Array.isArray(existingDeals)) throw new Error("data/deals.json must be an array or an object with a deals array.");

  const catalog = await fetchCreatorsCatalog({
    entries,
    searches: discovery.searches,
    discovery,
    env,
    fetchImpl,
    partnerTag,
  });
  const updates = buildUpdates(existingDeals, entries, catalog.byAsin, today);
  const tagged = catalog.groups.flatMap((group) => group.items.map((item) => ({
    item,
    category: group.category,
  })));
  const discovered = selectDiscoveredDeals(tagged, {
    today,
    existingDeals,
    blockedAsins: new Set(entries.map((entry) => entry.asin)),
    minDiscountPercent: discovery.minDiscountPercent,
    minRating: discovery.minRating,
    maxDeals: discovery.maxDeals,
  });
  const nextDeals = mergeApiDeals(existingDeals, updates, today, discovered);
  const nextPayload = Array.isArray(payload) ? nextDeals : { ...payload, deals: nextDeals };
  if (canonicalJson(payload) === canonicalJson(nextPayload)) return { changed: false, reason: "unchanged" };

  const nextText = `${JSON.stringify(nextPayload, null, 2)}\n`;
  const temporary = `${dealsPath}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, nextText);
    renameSync(temporary, dealsPath);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* the original deals.json is still in place */ }
    throw error;
  }
  const apiDeals = nextDeals.filter((deal) => deal.source === "api");
  return {
    changed: true,
    reason: "updated",
    count: apiDeals.length,
    discovered: apiDeals.filter((deal) => deal.discovered).length,
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const asinsPath = join(root, "data", "asins.json");
  const dealsPath = join(root, "data", "deals.json");
  const discoveryPath = join(root, "data", "discovery.json");
  const live = process.argv.includes("--live");
  let entries;
  let discovery;
  try {
    entries = loadAsinEntries(JSON.parse(readFileSync(asinsPath, "utf8")));
    discovery = readDiscoveryFile(discoveryPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Could not read the deal lists.");
    process.exitCode = 1;
    return;
  }
  if (!live) {
    console.log(planText({ entries, status: credentialStatus(), discovery }));
    return;
  }
  refreshDealsFile({ asinsPath, dealsPath, discoveryPath })
    .then((result) => {
      if (!result.changed) console.log(`deals.json was not changed (${result.reason}).`);
      else console.log(`Updated data/deals.json (${result.count} API deals, ${result.discovered} discovered). Hand-written deals were kept.`);
    })
    .catch((error) => {
      const message = redactSecrets(error instanceof Error ? error.message : "Deal refresh failed.", [
        process.env.CREATORS_API_CREDENTIAL_ID,
        process.env.CREATORS_API_CREDENTIAL_SECRET,
      ]);
      console.error(message || "Deal refresh failed.");
      process.exitCode = 1;
    });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
