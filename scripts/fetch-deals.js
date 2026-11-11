/**
 * Refresh deals in data/deals.json from the Amazon Creators API.
 *
 * Without --live, this prints the request it would make and does not use the network.
 * With --live, it refreshes the ASINs in data/asins.json and also searches for deals
 * described in data/discovery.json. Hand-picked ASINs take priority over discovered ones.
 * Discovered deals from earlier days stay until they fall outside DEAL_RETENTION_DAYS
 * (today plus the six days before it) or Amazon shows they are dead, out of stock,
 * or ended. maxDeals caps how many new discoveries are added, not how many are kept.
 * Hand-written deals inside that window stay in the file. Older ones are pruned.
 *
 * Credentials come from the environment. They are never printed. A failed auth,
 * GetItems, or SearchItems call exits non-zero and does not write deals.json.
 */
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ASSOCIATE_TAG } from "../js/affiliate.js";
import { displayCategoryFromItem } from "../js/categories.js";
import {
  apparelRank,
  DEAL_RETENTION_DAYS,
  inactiveReason,
  isActiveDeal,
  isBabyOrInfantTitle,
  isExpired,
  isWithinRetention,
  priorityWatch,
  todayISO,
} from "../js/deals.js";

export const GET_ITEMS_URL = "https://creatorsapi.amazon/catalog/v1/getItems";
export const SEARCH_ITEMS_URL = "https://creatorsapi.amazon/catalog/v1/searchItems";
export const ASIN_BATCH_SIZE = 10;
export const SEARCH_ITEM_COUNT = 10;
export const MAX_DISCOVERY_SEARCHES = 16;
export const CATALOG_PAUSE_MS = 1100;
export const RATE_LIMIT_RETRIES = 3;

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
  const allowed = new Set(["_comment", "minDiscountPercent", "minRating", "maxDeals", "searches", "priority"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) {
      throw new Error(`Unknown field "${key}" in data/discovery.json. You can set minDiscountPercent, minRating, maxDeals, searches, and priority.`);
    }
  }
  if (payload.minDiscountPercent == null || payload.minRating == null || payload.maxDeals == null || payload.searches == null) {
    throw new Error("data/discovery.json needs minDiscountPercent, minRating, maxDeals, and searches.");
  }
  const searches = readSearches(payload.searches, "searches");
  const priority = payload.priority == null ? [] : readSearches(payload.priority, "priority").map((search) => ({
    ...search,
    priority: true,
  }));
  if (searches.length + priority.length > MAX_DISCOVERY_SEARCHES) {
    throw new Error(`discovery can have at most ${MAX_DISCOVERY_SEARCHES} searches so the daily job does not call Amazon too many times.`);
  }
  return {
    minDiscountPercent: readBoundedInteger(payload.minDiscountPercent, "minDiscountPercent", 1, 99),
    minRating: readRating(payload.minRating),
    maxDeals: readBoundedInteger(payload.maxDeals, "maxDeals", 1, 40),
    searches,
    priority,
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

function readSearches(value, label) {
  if (!Array.isArray(value)) throw new Error(`discovery.${label} must be a list.`);
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${label}[${index}] must be an object.`);
    }
    const allowed = new Set(["keywords", "searchIndex", "category"]);
    for (const key of Object.keys(entry)) {
      if (!allowed.has(key)) {
        throw new Error(`${label}[${index}].${key} is not a field you can set. Use keywords, searchIndex, and category.`);
      }
    }
    if (typeof entry.keywords !== "string" || !entry.keywords.trim()) {
      throw new Error(`${label}[${index}].keywords is required.`);
    }
    const search = { keywords: entry.keywords.trim() };
    if (entry.searchIndex != null) {
      if (typeof entry.searchIndex !== "string" || !entry.searchIndex.trim()) {
        throw new Error(`${label}[${index}].searchIndex must be a non-empty string when present.`);
      }
      search.searchIndex = entry.searchIndex.trim();
    }
    if (entry.category != null) {
      if (typeof entry.category !== "string" || !entry.category.trim()) {
        throw new Error(`${label}[${index}].category must be a non-empty string when present.`);
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

export function explainDiscoveredItem(item, { today, existing, category, minDiscountPercent, minRating }) {
  const title = item?.itemInfo?.title?.displayValue || "";
  if (isBabyOrInfantTitle(title)) return { reason: "baby or infant product" };
  if (availabilityStatus(pickListing(item)) === "unavailable") return { reason: "out of stock or unavailable" };
  const mapped = mapCreatorsItemToDeal(item, { id: item?.asin }, existing?.added || today);
  if (!mapped || !item?.asin) return { reason: "no buyable offer" };
  if (isExpired(mapped, today)) return { reason: "deal ended" };
  if (!(mapped.percentOff >= minDiscountPercent)) return { reason: "discount below the discovery minimum" };
  if (!mapped.image && !existing?.image) return { reason: "no product image" };
  if (typeof mapped.url !== "string" || !mapped.url.startsWith("https://")) return { reason: "no product link" };
  const rating = readStarRating(item);
  if (rating != null && rating < minRating) return { reason: "rating below the discovery minimum" };

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

export function dealFromDiscoveredItem(item, options) {
  const assessed = explainDiscoveredItem(item, options);
  return assessed.deal ? { deal: assessed.deal, rating: assessed.rating } : null;
}

/**
 * Split search hits into new discoveries, refreshes of deals we already have,
 * and rejections of deals we already have that no longer qualify.
 * maxDeals limits only the new discoveries. A deal we already saved does not
 * take one of those slots.
 * @param {{ item: object, category?: string }[]} taggedItems
 */
export function partitionDiscoveredDeals(taggedItems, {
  today,
  existingDeals = [],
  blockedAsins = new Set(),
  knownAsins = new Set(),
  minDiscountPercent,
  minRating,
  maxDeals,
}) {
  const existingById = new Map(
    existingDeals.filter((deal) => deal && deal.source === "api").map((deal) => [deal.id, deal]),
  );
  const buckets = new Map();
  const seen = new Set();
  const refreshed = [];
  const rejected = [];
  for (const tagged of taggedItems) {
    const item = tagged?.item;
    const asin = item?.asin;
    const title = item?.itemInfo?.title?.displayValue || "";
    if (!asin || blockedAsins.has(asin) || seen.has(asin)) continue;
    const assessed = explainDiscoveredItem(item, {
      today,
      existing: existingById.get(asin),
      category: tagged.category,
      minDiscountPercent,
      minRating,
    });
    if (knownAsins.has(asin)) {
      seen.add(asin);
      if (!assessed.deal) {
        rejected.push({ id: asin, reason: assessed.reason || "no longer qualifies" });
        continue;
      }
      applyWatch(assessed.deal, title);
      refreshed.push(assessed.deal);
      continue;
    }
    if (!assessed.deal) continue;
    seen.add(asin);
    applyWatch(assessed.deal, title);
    if (!buckets.has(assessed.deal.category)) buckets.set(assessed.deal.category, []);
    buckets.get(assessed.deal.category).push(assessed);
  }
  for (const list of buckets.values()) {
    list.sort((a, b) => {
      const priorityDelta = Number(b.deal.priority === true) - Number(a.deal.priority === true);
      if (priorityDelta !== 0) return priorityDelta;
      const apparelDelta = apparelRank(b.deal) - apparelRank(a.deal);
      if (apparelDelta !== 0) return apparelDelta;
      if (b.deal.percentOff !== a.deal.percentOff) return b.deal.percentOff - a.deal.percentOff;
      const ratingDelta = (b.rating ?? -1) - (a.rating ?? -1);
      if (ratingDelta !== 0) return ratingDelta;
      return a.deal.id < b.deal.id ? -1 : a.deal.id > b.deal.id ? 1 : 0;
    });
  }
  const fresh = [];
  let round = 0;
  while (fresh.length < maxDeals) {
    let added = false;
    for (const list of buckets.values()) {
      if (fresh.length >= maxDeals) break;
      const next = list[round];
      if (!next) continue;
      fresh.push(next.deal);
      added = true;
    }
    if (!added) break;
    round += 1;
  }
  return { fresh, refreshed, rejected };
}

function applyWatch(deal, title) {
  const watch = priorityWatch(title);
  if (!watch) return;
  deal.category = watch.category;
  deal.priority = true;
}

/**
 * Keep at most maxDeals new discoveries, taking the best item from each
 * category before taking a second.
 * @param {{ item: object, category?: string }[]} taggedItems
 */
export function selectDiscoveredDeals(taggedItems, options) {
  return partitionDiscoveredDeals(taggedItems, options).fresh;
}

function retainedAdded(added, today) {
  return isWithinRetention({ added }, today) ? added : today;
}

function ageReason() {
  return `older than ${DEAL_RETENTION_DAYS} days`;
}

/**
 * Merge today's API results with deals already in the file.
 * A previously discovered deal that misses today's maxDeals cut is kept when
 * it is still active and its added date is inside the retention window.
 * maxDeals applies only to discoveries that are new.
 * A deal confirmed again today whose added date is already outside the window
 * is saved with added set to today. Anything else outside the window is removed.
 *
 * @param {object[]} existingDeals
 * @param {Map<string, object|null>} updates asin -> refreshed deal, or null to drop it
 * @param {string} today YYYY-MM-DD in America/Chicago
 * @param {object[]} discovered new discoveries, already capped by maxDeals
 * @returns {{ deals: object[], dropped: { id: string, reason: string }[] }}
 */
export function planDealMerge(existingDeals, updates, today, discovered = [], {
  refreshed = [],
  rejected = [],
  updateReasons = new Map(),
} = {}) {
  const dropped = [];
  const seenDrops = new Set();
  const noteDrop = (id, reason) => {
    if (!id || seenDrops.has(id)) return;
    seenDrops.add(id);
    dropped.push({ id, reason });
  };

  const discoveredById = new Map();
  for (const deal of discovered) {
    if (deal && !updates.has(deal.id)) discoveredById.set(deal.id, deal);
  }
  const refreshedById = new Map();
  for (const deal of refreshed) {
    if (deal && !updates.has(deal.id) && !discoveredById.has(deal.id)) refreshedById.set(deal.id, deal);
  }
  const rejectedById = new Map(
    rejected.filter((entry) => entry?.id).map((entry) => [entry.id, entry.reason || "no longer qualifies"]),
  );

  const kept = [];
  const seen = new Set();

  for (const deal of existingDeals) {
    if (!deal || typeof deal !== "object") continue;

    if (deal.source !== "api") {
      if (!isWithinRetention(deal, today)) {
        noteDrop(deal.id, ageReason());
        continue;
      }
      kept.push(deal);
      continue;
    }

    if (updates.has(deal.id)) {
      seen.add(deal.id);
      const next = updates.get(deal.id);
      if (!next || !isActiveDeal(next, today)) {
        noteDrop(deal.id, updateReasons.get(deal.id) || inactiveReason(next, today) || "no longer an active deal");
        continue;
      }
      kept.push({ ...next, added: retainedAdded(next.added, today) });
      continue;
    }

    if (deal.discovered) {
      seen.add(deal.id);
      const next = discoveredById.get(deal.id) || refreshedById.get(deal.id);
      if (next && isActiveDeal(next, today)) {
        kept.push({ ...next, added: retainedAdded(deal.added || next.added, today) });
        discoveredById.delete(deal.id);
        refreshedById.delete(deal.id);
        continue;
      }
      discoveredById.delete(deal.id);
      refreshedById.delete(deal.id);
      if (rejectedById.has(deal.id)) {
        noteDrop(deal.id, rejectedById.get(deal.id));
        continue;
      }
      if (!isWithinRetention(deal, today)) {
        noteDrop(deal.id, ageReason());
        continue;
      }
      if (isBabyOrInfantTitle(deal.title)) {
        noteDrop(deal.id, "baby or infant product");
        continue;
      }
      if (!isActiveDeal(deal, today)) {
        noteDrop(deal.id, inactiveReason(deal, today) || "no longer an active deal");
        continue;
      }
      kept.push(deal);
      continue;
    }

    if (!isWithinRetention(deal, today)) {
      noteDrop(deal.id, ageReason());
      continue;
    }
    if (!isActiveDeal(deal, today)) {
      noteDrop(deal.id, inactiveReason(deal, today) || "no longer an active deal");
      continue;
    }
    kept.push(deal);
  }

  const novel = [];
  for (const [id, deal] of updates) {
    if (seen.has(id)) continue;
    if (!deal || !isActiveDeal(deal, today)) {
      if (deal) noteDrop(id, updateReasons.get(id) || inactiveReason(deal, today) || "no longer an active deal");
      continue;
    }
    novel.push({ ...deal, added: retainedAdded(deal.added, today) });
  }
  for (const deal of [...discoveredById.values(), ...refreshedById.values()]) {
    if (!isActiveDeal(deal, today)) {
      noteDrop(deal.id, inactiveReason(deal, today) || "no longer an active deal");
      continue;
    }
    novel.push({ ...deal, added: retainedAdded(deal.added, today) });
  }

  return { deals: [...novel, ...kept], dropped };
}

export function mergeApiDeals(existingDeals, updates, today, discovered = [], extra) {
  return planDealMerge(existingDeals, updates, today, discovered, extra).deals;
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
  const searches = [...(discovery?.searches || []), ...(discovery?.priority || [])];
  if (searches.length) {
    lines.push(
      `Would POST ${SEARCH_ITEMS_URL} for ${searches.length} searches (not called).`,
      `Discovery adds up to ${discovery.maxDeals} new deals, at least ${discovery.minDiscountPercent}% off, rating ${discovery.minRating} or better. Earlier discoveries stay for ${DEAL_RETENTION_DAYS} days.`,
      `Searches: ${searches.map((search) => search.category || search.keywords).join(", ")}`,
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

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchCreatorsCatalog({
  entries,
  searches = [],
  discovery,
  env,
  fetchImpl,
  partnerTag,
  pauseMs = 0,
  sleep = defaultSleep,
}) {
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

  let catalogCalls = 0;
  const callCatalog = (url, body, label) => postCatalog(fetchImpl, token, url, body, fail, label, {
    pauseMs: catalogCalls++ > 0 ? pauseMs : 0,
    sleep,
  });

  const byAsin = new Map();
  if (entries.length > 0) {
    for (const batch of chunkList(entries.map((entry) => entry.asin), ASIN_BATCH_SIZE)) {
      const response = await callCatalog(GET_ITEMS_URL, buildGetItemsBody(batch, partnerTag), "GetItems");
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
    const response = await callCatalog(
      SEARCH_ITEMS_URL,
      buildSearchBody(search, {
        partnerTag,
        minDiscountPercent: discovery.minDiscountPercent,
        minRating: discovery.minRating,
      }),
      "SearchItems",
    );
    const body = await response.json();
    if (!body?.searchResult) fail("Creators API SearchItems response was missing searchResult.");
    groups.push({ category: search.category, items: body.searchResult.items || [] });
  }
  return { byAsin, groups };
}

async function postCatalog(fetchImpl, token, url, body, fail, label, { pauseMs = 0, sleep = defaultSleep } = {}) {
  if (pauseMs > 0) await sleep(pauseMs);
  let attempt = 0;
  while (true) {
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
    if (response?.status === 429 && attempt < RATE_LIMIT_RETRIES) {
      attempt += 1;
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (!response?.ok) fail(`Creators API ${label} request failed (${response?.status ?? "no status"}).`);
    return response;
  }
}

export function assessAsinItem(item, entry, { today, existing }) {
  if (!item) return { deal: null, reason: "not returned by the Creators API" };
  const listing = pickListing(item);
  if (availabilityStatus(listing) === "unavailable") return { deal: null, reason: "out of stock or unavailable" };
  if (!listing || listing.violatesMAP || listing.price?.money?.amount == null) {
    return { deal: null, reason: "no buyable offer" };
  }
  const deal = dealFromCreatorsItem(item, entry, { today, existing });
  if (!deal) return { deal: null, reason: "no longer discounted" };
  if (isExpired(deal, today) || !isActiveDeal(deal, today)) {
    return { deal: null, reason: inactiveReason(deal, today) || "no longer an active deal" };
  }
  return { deal, reason: null };
}

export function buildUpdates(existingDeals, entries, itemsByAsin, today) {
  const updates = new Map();
  const reasons = new Map();
  for (const entry of entries) {
    const existing = existingDeals.find((deal) => deal.id === entry.asin && deal.source === "api");
    const assessed = assessAsinItem(itemsByAsin.get(entry.asin), entry, { today, existing });
    updates.set(entry.asin, assessed.deal);
    if (!assessed.deal) reasons.set(entry.asin, assessed.reason || "no longer an active deal");
  }
  return { updates, reasons };
}

export function refreshSummary(result) {
  if (!result.changed) return [`deals.json was not changed (${result.reason}).`];
  const priority = result.priority?.length ? ` Priority watch: ${result.priority.join(", ")}.` : "";
  const freshCount = result.addedDiscoveries || 0;
  const fresh = freshCount
    ? ` ${freshCount} new ${freshCount === 1 ? "discovery" : "discoveries"}.`
    : "";
  const hand = result.handWritten > 0 ? " Hand-written deals were kept." : "";
  const lines = [
    `Updated data/deals.json (${result.count} API deals, ${result.discovered} discovered).${fresh}${hand}${priority}`,
  ];
  for (const drop of result.dropped || []) lines.push(`Dropped ${drop.id} (${drop.reason}).`);
  return lines;
}

export async function refreshDealsFile({
  asinsPath,
  dealsPath,
  discoveryPath,
  env = process.env,
  fetchImpl = globalThis.fetch,
  today = todayISO(),
  partnerTag = ASSOCIATE_TAG,
  pauseMs = 0,
  sleep,
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
    searches: [...discovery.searches, ...(discovery.priority || [])],
    discovery,
    env,
    fetchImpl,
    partnerTag,
    pauseMs,
    sleep,
  });
  const { updates, reasons } = buildUpdates(existingDeals, entries, catalog.byAsin, today);
  const tagged = catalog.groups.flatMap((group) => group.items.map((item) => ({
    item,
    category: group.category,
  })));
  const blockedAsins = new Set(entries.map((entry) => entry.asin));
  const knownAsins = new Set(
    existingDeals
      .filter((deal) => deal?.source === "api" && deal.discovered && !blockedAsins.has(deal.id))
      .map((deal) => deal.id),
  );
  const partitioned = partitionDiscoveredDeals(tagged, {
    today,
    existingDeals,
    blockedAsins,
    knownAsins,
    minDiscountPercent: discovery.minDiscountPercent,
    minRating: discovery.minRating,
    maxDeals: discovery.maxDeals,
  });
  const { deals: nextDeals, dropped } = planDealMerge(existingDeals, updates, today, partitioned.fresh, {
    refreshed: partitioned.refreshed,
    rejected: partitioned.rejected,
    updateReasons: reasons,
  });
  const nextPayload = Array.isArray(payload) ? nextDeals : { ...payload, deals: nextDeals };
  const existingIds = new Set(existingDeals.map((deal) => deal?.id));
  const report = {
    count: nextDeals.filter((deal) => deal.source === "api").length,
    discovered: nextDeals.filter((deal) => deal.source === "api" && deal.discovered).length,
    addedDiscoveries: nextDeals.filter((deal) => deal.discovered && !existingIds.has(deal.id)).length,
    priority: nextDeals.filter((deal) => deal.source === "api" && deal.priority).map((deal) => deal.id),
    handWritten: nextDeals.filter((deal) => deal.source !== "api").length,
    dropped,
  };
  if (canonicalJson(payload) === canonicalJson(nextPayload)) return { changed: false, reason: "unchanged", ...report };

  const nextText = `${JSON.stringify(nextPayload, null, 2)}\n`;
  const temporary = `${dealsPath}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, nextText);
    renameSync(temporary, dealsPath);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* the original deals.json is still in place */ }
    throw error;
  }
  return { changed: true, reason: "updated", ...report };
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
  refreshDealsFile({ asinsPath, dealsPath, discoveryPath, pauseMs: CATALOG_PAUSE_MS })
    .then((result) => {
      for (const line of refreshSummary(result)) console.log(line);
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
