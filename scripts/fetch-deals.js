/**
 * Refresh deals in data/deals.json from the Amazon Creators API.
 *
 * Without --live, this prints the request it would make and does not use the network.
 * With --live, it refreshes the ASINs in data/asins.json and also searches for deals
 * described in data/discovery.json. Each morning uses a different subset of the
 * keyword pool. A search can read past the first page of results. Hand-picked
 * ASINs take priority over discovered ones. ASINs already saved in deals.json
 * or listed in asins.json are not added again.
 * Discovered deals from earlier days stay until they fall outside DEAL_RETENTION_DAYS
 * (today plus the six days before it) or Amazon shows they are dead, out of stock,
 * or ended. maxDeals caps how many new discoveries are added, not how many are kept.
 * Hand-written deals inside that window stay in the file. Older ones are pruned.
 *
 * Credentials come from the environment. They are never printed. A failed auth,
 * GetItems, or SearchItems call exits non-zero and does not write deals.json.
 *
 * Before a successful run writes data/deals.json, every stored deal URL is
 * normalized. tag=onamzeddie0c-20, or a missing tag on an amazon.com URL,
 * becomes tag=ASSOCIATE_TAG. Other query parameters stay as they are. The
 * deal id is not changed, so Discord still posts only ids that were absent
 * from the previous file.
 *
 * When AMAZONOFFERCODE_API_KEY is set, the same run then reads promo codes from
 * AmazonOfferCode and merges them in. A missing key or a failed promo call
 * does not undo the Creators API result.
 */
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ASSOCIATE_TAG } from "../js/affiliate.js";
import {
  applyOfferCodes,
  creatorsBlockReason,
  fetchAmazonOfferCodes,
  MAX_OFFER_CALLS,
  readOfferConfigFile,
} from "./amazonoffercode.js";
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
/**
 * SearchItems limits, from the Creators API reference:
 * itemCount is an integer from 1 to 10, and itemPage is an integer from 1 to 10.
 * https://affiliate-program.amazon.com/creatorsapi/docs/en-us/api-reference/operations/search-items
 *
 * A new credential is limited to 1 request per second and 8640 requests per day.
 * https://affiliate-program.amazon.com/creatorsapi/docs/en-us/concepts/api-rates
 */
export const SEARCH_ITEM_COUNT = 10;
export const MAX_SEARCH_PAGE = 10;
export const DEFAULT_PAGES_PER_KEYWORD = 3;
export const DEFAULT_KEYWORDS_PER_RUN = 12;
export const DEFAULT_MAX_REQUESTS = 48;
export const MAX_CONFIG_REQUESTS = 200;
export const MAX_KEYWORD_POOL = 96;
/** Keywords actually sent on one run, counting keywordsPerRun and priority. */
export const MAX_RUN_SEARCHES = 16;
export const MAX_DISCOVERY_SEARCHES = MAX_RUN_SEARCHES;
export const CATALOG_PAUSE_MS = 1100;
export const RATE_LIMIT_RETRIES = 3;
/** Cap a single 429 wait so a huge retryAfterSeconds cannot stall the daily job. */
export const RETRY_AFTER_CAP_MS = 120000;

export const GET_ITEMS_RESOURCES = [
  "images.primary.large",
  "itemInfo.title",
  // Same GetItems and SearchItems call. This does not add a catalog request.
  "itemInfo.features",
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

export function buildSearchBody(search, {
  partnerTag = ASSOCIATE_TAG,
  minDiscountPercent,
  minRating,
  itemPage = 1,
} = {}) {
  if (!Number.isInteger(itemPage) || itemPage < 1 || itemPage > MAX_SEARCH_PAGE) {
    throw new Error(`itemPage must be a whole number from 1 to ${MAX_SEARCH_PAGE}.`);
  }
  const body = {
    keywords: search.keywords,
    marketplace: "www.amazon.com",
    partnerTag,
    itemCount: SEARCH_ITEM_COUNT,
    itemPage,
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

export function daysSinceEpoch(iso) {
  if (typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    throw new Error("A discovery date must be YYYY-MM-DD.");
  }
  const [year, month, day] = iso.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

function searchIdentity(search) {
  return `${search.category || ""}\0${search.keywords}\0${search.searchIndex || ""}`;
}

/**
 * True when this keyword should not request another page.
 * A page with no ASIN outside `seenAsins` is exhausted. So is a page that
 * already covers totalResultCount, when Amazon sends that count.
 * itemPage cannot go past MAX_SEARCH_PAGE; the caller enforces that.
 */
export function shouldStopKeyword(items, seenAsins, { page = 1, totalResultCount } = {}) {
  const list = Array.isArray(items) ? items : [];
  const hasNew = list.some((item) => {
    const asin = item?.asin;
    return typeof asin === "string" && asin && !seenAsins.has(asin);
  });
  if (!hasNew) return true;
  const total = Number(totalResultCount);
  if (Number.isFinite(total) && page * SEARCH_ITEM_COUNT >= total) return true;
  return false;
}

/**
 * Priority searches run every day. The pool contributes keywordsPerRun entries,
 * one category at a time, starting at a category chosen from the date.
 * The keyword inside a category also moves forward with the date.
 */
export function selectDailySearches(discovery, today) {
  const priority = discovery?.priority || [];
  const pool = discovery?.searches || [];
  const groups = new Map();
  for (const search of pool) {
    const category = search.category || "General";
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(search);
  }
  const categories = [...groups.keys()];
  if (categories.length === 0) return [...priority];

  const day = daysSinceEpoch(today);
  const start = day % categories.length;
  const ordered = categories.slice(start).concat(categories.slice(0, start));
  const limit = discovery.keywordsPerRun ?? Math.min(DEFAULT_KEYWORDS_PER_RUN, categories.length);
  const reserved = new Set(priority.map(searchIdentity));
  const picked = [];
  const seenKeys = new Set();
  let round = 0;
  while (picked.length < limit) {
    let added = false;
    for (const category of ordered) {
      if (picked.length >= limit) break;
      const options = groups.get(category);
      let choice = null;
      for (let offset = 0; offset < options.length; offset += 1) {
        const candidate = options[(day + round + offset) % options.length];
        const key = searchIdentity(candidate);
        if (seenKeys.has(key) || reserved.has(key)) continue;
        choice = candidate;
        break;
      }
      if (!choice) continue;
      seenKeys.add(searchIdentity(choice));
      picked.push(choice);
      added = true;
    }
    if (!added) break;
    round += 1;
  }
  return [...priority, ...picked];
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

/** How many Amazon feature bullets to keep on a deal. */
export const STORED_FEATURE_LIMIT = 2;
const STORED_FEATURE_CHARS = 300;

/**
 * First feature bullets from a Creators API item.
 * itemInfo.features.displayValues is a list of strings. Empty when Amazon omits it.
 */
export function featureBulletsFromItem(item, limit = STORED_FEATURE_LIMIT) {
  const values = item?.itemInfo?.features?.displayValues;
  if (!Array.isArray(values) || limit < 1) return [];
  const bullets = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const text = value.replace(/\s+/g, " ").trim();
    if (!text) continue;
    bullets.push(text.length > STORED_FEATURE_CHARS ? text.slice(0, STORED_FEATURE_CHARS).trimEnd() : text);
    if (bullets.length >= limit) break;
  }
  return bullets;
}

function assignFeatures(deal, mapped) {
  if (Array.isArray(mapped?.features) && mapped.features.length) deal.features = mapped.features;
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
    // Keep the Creators API detailPageURL here. refreshDealsFile normalizes
    // the Associates tag on every stored deal before it writes the file.
    url: item.detailPageURL,
    added,
    sample: false,
  };
  if (typeof original === "number") deal.originalPrice = original;
  if (extras.promoCode) deal.promoCode = extras.promoCode;
  const features = featureBulletsFromItem(item);
  if (features.length) deal.features = features;
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
    if (typeof secret !== "string" || !secret) continue;
    text = text.split(secret).join("[redacted]");
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) text = text.split(encoded).join("[redacted]");
    const form = encoded.replaceAll("%20", "+");
    if (form !== encoded) text = text.split(form).join("[redacted]");
  }
  return text.replace(/([?&]token=)[^&\s"'<>]*/gi, "$1[redacted]");
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
  return {
    minDiscountPercent: 20,
    minRating: 4,
    maxDeals: 20,
    pagesPerKeyword: DEFAULT_PAGES_PER_KEYWORD,
    keywordsPerRun: 0,
    maxRequests: DEFAULT_MAX_REQUESTS,
    searches: [],
    priority: [],
  };
}

export function loadDiscoveryConfig(payload) {
  if (payload == null) return emptyDiscovery();
  if (typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("data/discovery.json must be a JSON object.");
  }
  const allowed = new Set([
    "_comment",
    "minDiscountPercent",
    "minRating",
    "maxDeals",
    "pagesPerKeyword",
    "keywordsPerRun",
    "maxRequests",
    "searches",
    "priority",
  ]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) {
      throw new Error(`Unknown field "${key}" in data/discovery.json. You can set minDiscountPercent, minRating, maxDeals, pagesPerKeyword, keywordsPerRun, maxRequests, searches, and priority.`);
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
  if (searches.length > MAX_KEYWORD_POOL) {
    throw new Error(`discovery.searches can list at most ${MAX_KEYWORD_POOL} keywords.`);
  }
  assertUniqueSearches([...searches, ...priority]);
  const pagesPerKeyword = payload.pagesPerKeyword == null
    ? DEFAULT_PAGES_PER_KEYWORD
    : readBoundedInteger(payload.pagesPerKeyword, "pagesPerKeyword", 1, MAX_SEARCH_PAGE);
  const maxRequests = payload.maxRequests == null
    ? DEFAULT_MAX_REQUESTS
    : readBoundedInteger(payload.maxRequests, "maxRequests", 1, MAX_CONFIG_REQUESTS);
  let keywordsPerRun = payload.keywordsPerRun == null
    ? Math.min(DEFAULT_KEYWORDS_PER_RUN, searches.length)
    : readBoundedInteger(payload.keywordsPerRun, "keywordsPerRun", 1, MAX_RUN_SEARCHES);
  if (payload.keywordsPerRun == null) {
    keywordsPerRun = Math.min(keywordsPerRun, Math.max(0, MAX_RUN_SEARCHES - priority.length));
  } else if (priority.length + keywordsPerRun > MAX_RUN_SEARCHES) {
    throw new Error(`a run can search at most ${MAX_RUN_SEARCHES} keywords, counting keywordsPerRun and priority together.`);
  }
  return {
    minDiscountPercent: readBoundedInteger(payload.minDiscountPercent, "minDiscountPercent", 1, 99),
    minRating: readRating(payload.minRating),
    maxDeals: readBoundedInteger(payload.maxDeals, "maxDeals", 1, 40),
    pagesPerKeyword,
    keywordsPerRun,
    maxRequests,
    searches,
    priority,
  };
}

function assertUniqueSearches(list) {
  const seen = new Set();
  for (const search of list) {
    const key = searchIdentity(search);
    if (seen.has(key)) {
      const where = search.category ? ` in ${search.category}` : "";
      throw new Error(`discovery lists "${search.keywords}"${where} more than once.`);
    }
    seen.add(key);
  }
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
  assignFeatures(deal, mapped);
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
  assignFeatures(deal, mapped);
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

export function planText({ entries, status, discovery, today = todayISO(), offerCategories }) {
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
  const searches = discovery ? selectDailySearches(discovery, today) : [];
  if (searches.length) {
    const getItems = entries.length === 0 ? 0 : Math.ceil(entries.length / ASIN_BATCH_SIZE);
    const searchCeiling = searches.length * discovery.pagesPerKeyword;
    lines.push(
      `Would POST ${SEARCH_ITEMS_URL} for ${searches.length} searches, up to ${discovery.pagesPerKeyword} page(s) of ${SEARCH_ITEM_COUNT} (itemPage 1 to ${MAX_SEARCH_PAGE}).`,
      `Discovery adds up to ${discovery.maxDeals} new deals, at least ${discovery.minDiscountPercent}% off, rating ${discovery.minRating} or better. Earlier discoveries stay for ${DEAL_RETENTION_DAYS} days.`,
      `Catalog budget: ${discovery.maxRequests} requests (about ${getItems} GetItems and up to ${searchCeiling} SearchItems). Stops at ${discovery.maxDeals} new discoveries or a page with no new ASINs.`,
      `Searches: ${searches.map((search) => (search.category ? `${search.category}: ${search.keywords}` : search.keywords)).join("; ")}`,
    );
  }
  const categories = offerCategories || [];
  if (categories.length) {
    const called = categories.slice(0, MAX_OFFER_CALLS);
    lines.push(
      `Would call AmazonOfferCode for ${called.join(", ")} if AMAZONOFFERCODE_API_KEY is set (not called). At most ${MAX_OFFER_CALLS} calls.`,
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
  seenAsins = new Set(),
  countsAsNewDeal = null,
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

  let requests = 0;
  const callCatalog = (url, body, label) => {
    requests += 1;
    return postCatalog(fetchImpl, token, url, body, fail, label, {
      pauseMs: requests > 1 ? pauseMs : 0,
      sleep,
    });
  };

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

  const seen = new Set(seenAsins);
  let newQualifying = 0;
  let stopAll = false;
  const groups = [];
  const pagesPerKeyword = discovery.pagesPerKeyword;
  const maxRequests = discovery.maxRequests;
  const maxNewDeals = discovery.maxDeals;

  for (const search of searches) {
    if (stopAll || requests >= maxRequests) break;
    const collected = [];
    for (let page = 1; page <= pagesPerKeyword && page <= MAX_SEARCH_PAGE; page += 1) {
      if (requests >= maxRequests) break;
      const response = await callCatalog(
        SEARCH_ITEMS_URL,
        buildSearchBody(search, {
          partnerTag,
          minDiscountPercent: discovery.minDiscountPercent,
          minRating: discovery.minRating,
          itemPage: page,
        }),
        "SearchItems",
      );
      const body = await response.json();
      if (!body?.searchResult) fail("Creators API SearchItems response was missing searchResult.");
      const items = Array.isArray(body.searchResult.items) ? body.searchResult.items : [];
      const stopKeyword = shouldStopKeyword(items, seen, {
        page,
        totalResultCount: body.searchResult.totalResultCount,
      });
      for (const item of items) {
        const asin = item?.asin;
        if (!asin || seen.has(asin)) continue;
        seen.add(asin);
        if (typeof countsAsNewDeal === "function" && countsAsNewDeal(item, search)) newQualifying += 1;
      }
      collected.push(...items);
      if (typeof countsAsNewDeal === "function" && newQualifying >= maxNewDeals) stopAll = true;
      if (stopKeyword || stopAll) break;
    }
    groups.push({ category: search.category, items: collected });
  }
  return { byAsin, groups, requests };
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
      let waitMs = 1000 * 2 ** attempt;
      try {
        const errorBody = await response.json();
        const retryAfter = Number(errorBody?.retryAfterSeconds);
        if (Number.isFinite(retryAfter) && retryAfter > 0) {
          waitMs = Math.max(waitMs, Math.min(Math.round(retryAfter * 1000), RETRY_AFTER_CAP_MS));
        }
      } catch {
        // Keep the exponential wait when the throttle body cannot be read.
      }
      await sleep(waitMs);
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
  const notes = Array.isArray(result.offerNotes) ? result.offerNotes : [];
  if (!result.changed) return [`deals.json was not changed (${result.reason}).`, ...notes];
  const priority = result.priority?.length ? ` Priority watch: ${result.priority.join(", ")}.` : "";
  const freshCount = result.addedDiscoveries || 0;
  const fresh = freshCount
    ? ` ${freshCount} new ${freshCount === 1 ? "discovery" : "discoveries"}.`
    : "";
  const hand = result.handWritten > 0 ? " Hand-written deals were kept." : "";
  const lines = [
    `Updated data/deals.json (${result.count} API deals, ${result.discovered} discovered).${fresh}${hand}${priority}`,
  ];
  if (typeof result.requests === "number") lines.push(`Catalog requests: ${result.requests}.`);
  for (const drop of result.dropped || []) lines.push(`Dropped ${drop.id} (${drop.reason}).`);
  lines.push(...notes);
  return lines;
}

async function mergeOfferCodes({
  deals,
  existingDeals,
  dropped,
  creatorsIds,
  blockedAsins,
  today,
  maxDeals,
  env,
  fetchImpl,
  sleep,
  offerConfigPath,
}) {
  const notes = [];
  try {
    const config = readOfferConfigFile(offerConfigPath);
    const fetched = await fetchAmazonOfferCodes({ config, env, fetchImpl, sleep, today });
    notes.push(...fetched.notes);
    if (fetched.skipped) return { deals, dropped, notes };
    const existingIds = new Set(existingDeals.map((deal) => deal?.id).filter(Boolean));
    const newDiscoveries = deals.filter((deal) => deal?.discovered && !existingIds.has(deal.id)).length;
    const applied = applyOfferCodes(deals, {
      offers: fetched.offers,
      rejectedAsins: fetched.rejectedAsins,
      blockedAsins,
      existingDeals,
      today,
      maxNew: Math.max(0, maxDeals - newDiscoveries),
      creatorsIds,
    });
    notes.push(`AmazonOfferCode attached promo info to ${applied.attached} existing deals and added ${applied.added}.`);
    if (applied.skippedForCap > 0) {
      notes.push(`AmazonOfferCode left ${applied.skippedForCap} new deals out because the daily discovery cap is ${maxDeals}.`);
    }
    return {
      deals: applied.deals,
      dropped: [...dropped, ...applied.dropped],
      notes,
    };
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : "AmazonOfferCode failed.", [
      env?.AMAZONOFFERCODE_API_KEY,
      env?.CREATORS_API_CREDENTIAL_SECRET,
      env?.CREATORS_API_CREDENTIAL_ID,
    ]);
    notes.push(`AmazonOfferCode failed (${message || "unknown error"}). Creators API deals were kept.`);
    return { deals, dropped, notes };
  }
}

/** Older Associates tag still stored on deals the daily refresh did not re-fetch. */
export const LEGACY_ASSOCIATE_TAG = "onamzeddie0c-20";

function amazonComHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  return host === "amazon.com" || host.endsWith(".amazon.com");
}

function decodedTagValue(part) {
  const eq = part.indexOf("=");
  const key = eq === -1 ? part : part.slice(0, eq);
  if (key !== "tag") return undefined;
  const raw = eq === -1 ? "" : part.slice(eq + 1);
  try {
    return decodeURIComponent(raw.replaceAll("+", " "));
  } catch {
    return raw;
  }
}

/**
 * Point a stored deal URL at the current Associates tag.
 * Replaces tag=onamzeddie0c-20 anywhere, and adds the tag when an amazon.com
 * URL has none. Other query parameters, their order, and their encoding stay.
 * A URL that already uses this tag is returned unchanged.
 * @param {string} rawUrl
 * @param {string} [tag]
 * @returns {string}
 */
export function normalizeStoredDealUrl(rawUrl, tag = ASSOCIATE_TAG) {
  if (typeof rawUrl !== "string" || !rawUrl) return rawUrl;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  const hashAt = rawUrl.indexOf("#");
  const beforeHash = hashAt === -1 ? rawUrl : rawUrl.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : rawUrl.slice(hashAt);
  const queryAt = beforeHash.indexOf("?");
  const base = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  const query = queryAt === -1 ? null : beforeHash.slice(queryAt + 1);
  const parts = query == null ? [] : query.split("&").filter((part) => part.length > 0);
  const amazon = amazonComHost(parsed.hostname);
  let sawTag = false;
  let changed = false;
  const nextParts = [];
  for (const part of parts) {
    const value = decodedTagValue(part);
    if (value === undefined) {
      nextParts.push(part);
      continue;
    }
    sawTag = true;
    if (value === LEGACY_ASSOCIATE_TAG || (amazon && value === "")) {
      const replacement = `tag=${tag}`;
      if (replacement !== part) changed = true;
      nextParts.push(replacement);
      continue;
    }
    nextParts.push(part);
  }
  if (!sawTag && amazon) {
    changed = true;
    nextParts.push(`tag=${tag}`);
  }
  if (!changed) return rawUrl;
  return `${base}?${nextParts.join("&")}${hash}`;
}

/**
 * Normalize the url on each stored deal. Deals whose url is already fine are
 * the same objects, so a tag-only rewrite does not invent a new deal id.
 * @param {object[]} deals
 * @param {string} [tag]
 */
export function normalizeStoredDeals(deals, tag = ASSOCIATE_TAG) {
  if (!Array.isArray(deals)) return deals;
  return deals.map((deal) => {
    if (!deal || typeof deal !== "object" || typeof deal.url !== "string") return deal;
    const url = normalizeStoredDealUrl(deal.url, tag);
    if (url === deal.url) return deal;
    return { ...deal, url };
  });
}

export async function refreshDealsFile({
  asinsPath,
  dealsPath,
  discoveryPath,
  offerConfigPath,
  env = process.env,
  fetchImpl = globalThis.fetch,
  today = todayISO(),
  partnerTag = ASSOCIATE_TAG,
  pauseMs = 0,
  sleep,
}) {
  const entries = loadAsinEntries(JSON.parse(readFileSync(asinsPath, "utf8")));
  const discovery = discoveryPath ? readDiscoveryFile(discoveryPath) : emptyDiscovery();
  const selected = selectDailySearches(discovery, today);
  if (entries.length === 0 && selected.length === 0) return { changed: false, reason: "empty" };

  const before = readFileSync(dealsPath, "utf8");
  const payload = JSON.parse(before);
  const existingDeals = Array.isArray(payload) ? payload : payload?.deals;
  if (!Array.isArray(existingDeals)) throw new Error("data/deals.json must be an array or an object with a deals array.");

  const listedAsins = new Set(entries.map((entry) => entry.asin));
  const knownAsins = new Set(
    existingDeals
      .filter((deal) => deal?.source === "api" && deal.discovered && !listedAsins.has(deal.id))
      .map((deal) => deal.id),
  );
  const blockedAsins = new Set(listedAsins);
  for (const deal of existingDeals) {
    if (deal?.id && !knownAsins.has(deal.id)) blockedAsins.add(deal.id);
  }
  const skipAsins = new Set([...blockedAsins, ...knownAsins]);
  const catalog = await fetchCreatorsCatalog({
    entries,
    searches: selected,
    discovery,
    env,
    fetchImpl,
    partnerTag,
    pauseMs,
    sleep,
    seenAsins: skipAsins,
    countsAsNewDeal: (item, search) => {
      if (!item?.asin || skipAsins.has(item.asin)) return false;
      return Boolean(explainDiscoveredItem(item, {
        today,
        category: search.category,
        minDiscountPercent: discovery.minDiscountPercent,
        minRating: discovery.minRating,
      }).deal);
    },
  });
  const { updates, reasons } = buildUpdates(existingDeals, entries, catalog.byAsin, today);
  const tagged = catalog.groups.flatMap((group) => group.items.map((item) => ({
    item,
    category: group.category,
  })));
  const partitioned = partitionDiscoveredDeals(tagged, {
    today,
    existingDeals,
    blockedAsins,
    knownAsins,
    minDiscountPercent: discovery.minDiscountPercent,
    minRating: discovery.minRating,
    maxDeals: discovery.maxDeals,
  });
  const merged = planDealMerge(existingDeals, updates, today, partitioned.fresh, {
    refreshed: partitioned.refreshed,
    rejected: partitioned.rejected,
    updateReasons: reasons,
  });
  const creatorsIds = new Set();
  const offerBlockedAsins = new Set();
  for (const [id, deal] of updates) {
    if (deal) creatorsIds.add(id);
    else if (creatorsBlockReason(reasons.get(id))) offerBlockedAsins.add(id);
  }
  for (const deal of partitioned.fresh) creatorsIds.add(deal.id);
  for (const deal of partitioned.refreshed) creatorsIds.add(deal.id);
  for (const entry of partitioned.rejected) {
    if (creatorsBlockReason(entry.reason)) offerBlockedAsins.add(entry.id);
  }
  const offerResult = await mergeOfferCodes({
    deals: merged.deals,
    existingDeals,
    dropped: merged.dropped,
    creatorsIds,
    blockedAsins: offerBlockedAsins,
    today,
    maxDeals: discovery.maxDeals,
    env,
    fetchImpl,
    sleep,
    offerConfigPath: offerConfigPath || join(dirname(dealsPath), "amazonoffercode.json"),
  });
  const nextDeals = normalizeStoredDeals(offerResult.deals, partnerTag);
  const dropped = offerResult.dropped;
  const nextPayload = Array.isArray(payload) ? nextDeals : { ...payload, deals: nextDeals };
  const existingIds = new Set(existingDeals.map((deal) => deal?.id));
  const report = {
    count: nextDeals.filter((deal) => deal.source === "api").length,
    discovered: nextDeals.filter((deal) => deal.source === "api" && deal.discovered).length,
    addedDiscoveries: nextDeals.filter((deal) => deal.discovered && !existingIds.has(deal.id)).length,
    priority: nextDeals.filter((deal) => deal.source === "api" && deal.priority).map((deal) => deal.id),
    handWritten: nextDeals.filter((deal) => deal.source !== "api").length,
    dropped,
    requests: catalog.requests,
    offerNotes: offerResult.notes,
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
    let offerCategories = [];
    try {
      offerCategories = readOfferConfigFile(join(root, "data", "amazonoffercode.json")).categories;
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Could not read data/amazonoffercode.json.");
      process.exitCode = 1;
      return;
    }
    console.log(planText({ entries, status: credentialStatus(), discovery, offerCategories, today: todayISO() }));
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
        process.env.AMAZONOFFERCODE_API_KEY,
        process.env.DISCORD_WEBHOOK_URL,
      ]);
      console.error(message || "Deal refresh failed.");
      process.exitCode = 1;
    });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
