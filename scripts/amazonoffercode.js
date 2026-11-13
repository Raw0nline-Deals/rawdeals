/**
 * AmazonOfferCode promo API for the daily deal refresh.
 *
 * The free plan allows 100 requests a month. This module calls at most
 * MAX_OFFER_CALLS categories per run (one page each). A missing key, a 401,
 * a 403, a 429, or a failed retry skips the rest of these calls and leaves
 * the Creators API deals untouched.
 *
 * AmazonOfferCode publishes no terms of service. Their docs say amazon_link
 * carries your own Associates ID only on a paid plan. On the free plan that
 * link carries their tag. AOC_USE_OWN_TAG (default true) rewrites it.
 */
import { readFileSync } from "node:fs";
import { ASSOCIATE_TAG } from "../js/affiliate.js";
import { isBabyOrInfantTitle, isWithinRetention } from "../js/deals.js";

export const OFFER_API_URL = "https://fjqzknavlxawemmqmxvc.supabase.co/functions/v1/promo-api";
export const MAX_OFFER_CALLS = 3;
export const OFFER_PAGE_LIMIT = 100;
export const SERVER_ERROR_RETRIES = 2;

export const DEFAULT_OFFER_CATEGORIES = ["electronics", "home", "kitchen"];

const SLUG_LABELS = {
  electronics: "Tech",
  home: "Home",
  kitchen: "Kitchen",
  sports: "Sports",
  sporting: "Sports",
  "sport-outdoors": "Sports",
  beauty: "Beauty",
  toys: "Toys",
  "toys-games": "Toys",
  grocery: "Food",
  fashion: "Clothing",
  clothing: "Clothing",
  apparel: "Clothing",
  pets: "Pets",
  "pet-supplies": "Pets",
  hpc: "Household",
  "personal-care": "Household",
  garden: "Sports",
  "lawn-garden": "Sports",
};

/**
 * Creators API results with these reasons stay dropped. A low discount can
 * still be listed when AmazonOfferCode has a code or an auto-applied offer.
 */
const BLOCKED_CREATORS_REASONS = new Set([
  "out of stock or unavailable",
  "no buyable offer",
  "deal ended",
  "baby or infant product",
  "verified dead",
  "not returned by the Creators API",
  "no product link",
]);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function defaultOfferConfig() {
  return {
    categories: [...DEFAULT_OFFER_CATEGORIES],
    limit: OFFER_PAGE_LIMIT,
    active: true,
    marketplace: "us",
    sort: "newest",
    maxCallsPerRun: MAX_OFFER_CALLS,
    useOwnTag: true,
  };
}

export function loadOfferConfig(payload) {
  const defaults = defaultOfferConfig();
  if (payload == null) return defaults;
  if (typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("data/amazonoffercode.json must be a JSON object.");
  }
  const allowed = new Set([
    "_comment",
    "categories",
    "limit",
    "active",
    "marketplace",
    "sort",
    "maxCallsPerRun",
    "useOwnTag",
  ]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) {
      throw new Error(`Unknown field "${key}" in data/amazonoffercode.json.`);
    }
  }
  if (payload.categories != null && !Array.isArray(payload.categories)) {
    throw new Error("amazonoffercode.categories must be a list of slugs.");
  }
  const categories = [];
  const seen = new Set();
  for (const [index, entry] of (payload.categories || defaults.categories).entries()) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(`amazonoffercode.categories[${index}] must be a non-empty slug.`);
    }
    const slug = entry.trim().toLowerCase();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      throw new Error(`amazonoffercode.categories[${index}] must be a slug such as electronics, home, or kitchen.`);
    }
    if (seen.has(slug)) continue;
    seen.add(slug);
    categories.push(slug);
  }
  if (categories.length === 0) throw new Error("amazonoffercode.categories needs at least one slug.");
  return {
    categories,
    limit: payload.limit == null ? defaults.limit : readBoundedInteger(payload.limit, "limit", 1, OFFER_PAGE_LIMIT),
    active: payload.active == null ? true : readBoolean(payload.active, "active"),
    marketplace: payload.marketplace == null ? "us" : readMarketplace(payload.marketplace),
    sort: payload.sort == null ? "newest" : readSort(payload.sort),
    maxCallsPerRun: payload.maxCallsPerRun == null
      ? MAX_OFFER_CALLS
      : Math.min(MAX_OFFER_CALLS, readBoundedInteger(payload.maxCallsPerRun, "maxCallsPerRun", 1, MAX_OFFER_CALLS)),
    useOwnTag: payload.useOwnTag == null ? true : readBoolean(payload.useOwnTag, "useOwnTag"),
  };
}

function readBoundedInteger(value, label, min, max) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`amazonoffercode.${label} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

function readBoolean(value, label) {
  if (typeof value !== "boolean") throw new Error(`amazonoffercode.${label} must be true or false.`);
  return value;
}

function readMarketplace(value) {
  if (value !== "us" && value !== "ca") throw new Error("amazonoffercode.marketplace must be us or ca.");
  return value;
}

function readSort(value) {
  if (value !== "newest" && value !== "discount") {
    throw new Error("amazonoffercode.sort must be newest or discount.");
  }
  return value;
}

export function readOfferConfigFile(configPath) {
  try {
    return loadOfferConfig(JSON.parse(readFileSync(configPath, "utf8")));
  } catch (error) {
    if (error && error.code === "ENOENT") return defaultOfferConfig();
    if (error instanceof SyntaxError) throw new Error("data/amazonoffercode.json is not valid JSON.");
    throw error;
  }
}

export function resolveUseOwnTag(env, configured = true) {
  const raw = env?.AOC_USE_OWN_TAG;
  if (raw == null || String(raw).trim() === "") return configured !== false;
  const value = String(raw).trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(value)) return false;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  return configured !== false;
}

export function offerApiKey(env = process.env) {
  const key = env?.AMAZONOFFERCODE_API_KEY;
  if (typeof key !== "string") return "";
  return key.trim();
}

export function offerRequestUrl(category, { token, limit, active, marketplace, sort, page = 1 }) {
  const url = new URL(OFFER_API_URL);
  url.searchParams.set("token", token);
  url.searchParams.set("category", category);
  url.searchParams.set("marketplace", marketplace);
  url.searchParams.set("active", active ? "true" : "false");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("page", String(page));
  url.searchParams.set("sort", sort);
  return url;
}

export function displayCategoryForSlug(slug) {
  const key = String(slug || "").trim().toLowerCase();
  if (SLUG_LABELS[key]) return SLUG_LABELS[key];
  if (!key) return "General";
  return key.replace(/-/g, " ").replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

export function parseOfferMoney(value) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== "string") return null;
  const parsed = Number.parseFloat(value.replace(/[^0-9.]/g, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function offerEndDate(value) {
  if (value == null || value === "") return null;
  const day = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/**
 * Build the shopper link for one offer.
 * Coded deals go to the product page. Auto-applied deals keep the promo page.
 * useOwnTag replaces or adds the RawDeals Associates tag.
 */
export function buildOfferLink(offer, { useOwnTag = true, tag = ASSOCIATE_TAG } = {}) {
  const coupon = couponCode(offer);
  if (coupon) {
    const url = new URL(`https://www.amazon.com/dp/${String(offer.asin).trim()}`);
    if (useOwnTag) url.searchParams.set("tag", tag);
    return {
      url: url.toString(),
      coded: true,
      preserveAffiliateTag: !useOwnTag,
    };
  }
  const url = new URL(offer.amazon_link);
  if (url.protocol !== "https:" || !(url.hostname === "amazon.com" || url.hostname.endsWith(".amazon.com"))) {
    throw new Error("amazon_link must be an https amazon.com URL.");
  }
  if (useOwnTag) url.searchParams.set("tag", tag);
  return {
    url: url.toString(),
    coded: false,
    preserveAffiliateTag: !useOwnTag,
  };
}

export function linkCarriesAssociateTag(rawUrl, tag = ASSOCIATE_TAG) {
  try {
    return new URL(rawUrl).searchParams.get("tag") === tag;
  } catch {
    return false;
  }
}

function couponCode(offer) {
  if (offer?.coupon_code == null) return "";
  const code = String(offer.coupon_code).trim();
  return code;
}

function percentOffFor(row, price, original) {
  if (typeof row?.discount_text === "string") {
    const match = row.discount_text.match(/(\d+(?:\.\d+)?)\s*%/);
    if (match) return clampPercent(Math.round(Number(match[1])));
  }
  if (typeof original === "number" && original > price) return clampPercent(Math.round((1 - price / original) * 100));
  return 0;
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/**
 * Turn one API row into a deal, or say why it was skipped.
 * rejected means an AOC-only deal already in the file should be removed.
 */
export function normalizeOffer(row, { today, queriedCategory, useOwnTag }) {
  const asin = typeof row?.asin === "string" ? row.asin.trim() : "";
  if (!/^[A-Z0-9]{10}$/.test(asin)) return { ok: false, reason: "missing asin" };
  if (row?.marketplace != null && String(row.marketplace).toLowerCase() !== "us") {
    return { ok: false, asin, reason: "not a US offer" };
  }
  const end = offerEndDate(row?.end_date);
  if (row?.is_active !== true || (end && end < today)) {
    return { ok: false, asin, rejected: true, reason: row?.is_active !== true ? "not active" : "deal ended" };
  }
  const title = typeof row?.title === "string" ? row.title.trim() : "";
  if (!title) return { ok: false, asin, reason: "missing title" };
  if (isBabyOrInfantTitle(title)) return { ok: false, asin, reason: "baby or infant product" };
  const price = parseOfferMoney(row?.price);
  if (price == null) return { ok: false, asin, reason: "missing price" };
  const image = typeof row?.image_url === "string" ? row.image_url.trim() : "";
  if (!/^https:\/\//i.test(image)) return { ok: false, asin, reason: "missing image" };
  let link;
  try {
    link = buildOfferLink(row, { useOwnTag });
  } catch {
    return { ok: false, asin, reason: "missing promo link" };
  }
  const original = parseOfferMoney(row?.original_price);
  const slug = typeof row?.category === "string" && row.category.trim() ? row.category.trim().toLowerCase() : queriedCategory;
  const deal = {
    id: asin,
    title,
    image,
    price,
    percentOff: percentOffFor(row, price, original),
    category: displayCategoryForSlug(slug),
    url: link.url,
    added: today,
    sample: false,
    source: "api",
    discovered: true,
    origin: "amazonoffercode",
  };
  if (typeof original === "number" && original > price) deal.originalPrice = original;
  if (link.coded) deal.promoCode = couponCode(row);
  else deal.checkoutDiscount = true;
  if (end) deal.expires = end;
  if (link.preserveAffiliateTag) deal.preserveAffiliateTag = true;
  return { ok: true, offer: deal };
}

export function creatorsBlockReason(reason) {
  return BLOCKED_CREATORS_REASONS.has(reason);
}

function offerWins(next, prev) {
  const nextCode = Boolean(next.promoCode);
  const prevCode = Boolean(prev.promoCode);
  if (nextCode !== prevCode) return nextCode;
  if (next.percentOff !== prev.percentOff) return next.percentOff > prev.percentOff;
  return next.id < prev.id;
}

function selectNewOffers(offers, maxNew) {
  const buckets = new Map();
  for (const offer of offers) {
    const key = offer.category || "General";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(offer);
  }
  for (const list of buckets.values()) {
    list.sort((a, b) => {
      if (b.percentOff !== a.percentOff) return b.percentOff - a.percentOff;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }
  const picked = [];
  let round = 0;
  while (picked.length < maxNew) {
    let added = false;
    for (const list of buckets.values()) {
      if (picked.length >= maxNew) break;
      const next = list[round];
      if (!next) continue;
      picked.push(next);
      added = true;
    }
    if (!added) break;
    round += 1;
  }
  return picked;
}

function keptAdded(existing, today) {
  if (existing && isWithinRetention(existing, today)) return existing.added;
  return today;
}

function attachToCreatorsDeal(deal, offer) {
  const next = { ...deal };
  let changed = false;
  if (offer.promoCode && !deal.promoCode) {
    next.promoCode = offer.promoCode;
    if ("checkoutDiscount" in next) delete next.checkoutDiscount;
    changed = true;
  } else if (!offer.promoCode && !deal.promoCode) {
    next.checkoutDiscount = true;
    next.url = offer.url;
    if (offer.preserveAffiliateTag) next.preserveAffiliateTag = true;
    else if ("preserveAffiliateTag" in next) delete next.preserveAffiliateTag;
    changed = true;
  }
  if (!deal.expires && offer.expires) {
    next.expires = offer.expires;
    changed = true;
  }
  return changed ? next : deal;
}

function refreshOfferDeal(deal, offer, today) {
  const next = {
    ...offer,
    added: keptAdded(deal, today),
    origin: "amazonoffercode",
  };
  if (deal.priority === true) next.priority = true;
  return sameDeal(deal, next) ? deal : next;
}

function sameDeal(left, right) {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

/**
 * Merge promo offers into the deals Creators API already planned.
 * Matching ASINs keep Creators price, title, and image, and gain a code
 * or the auto-applied promo link. New deals stop at the remaining maxDeals room.
 */
export function applyOfferCodes(deals, {
  offers = [],
  rejectedAsins = new Set(),
  blockedAsins = new Set(),
  existingDeals = [],
  today,
  maxNew = 0,
  creatorsIds = new Set(),
} = {}) {
  const incoming = new Map();
  for (const offer of offers) {
    if (!offer?.id || blockedAsins.has(offer.id)) continue;
    const prev = incoming.get(offer.id);
    if (!prev || offerWins(offer, prev)) incoming.set(offer.id, offer);
  }
  const existingById = new Map(existingDeals.filter((deal) => deal?.id).map((deal) => [deal.id, deal]));
  const dropped = [];
  const kept = [];
  let attached = 0;
  for (const deal of deals) {
    if (!deal || typeof deal !== "object") {
      kept.push(deal);
      continue;
    }
    const offer = incoming.get(deal.id);
    if (offer) incoming.delete(deal.id);
    if (
      rejectedAsins.has(deal.id)
      && deal.origin === "amazonoffercode"
      && !creatorsIds.has(deal.id)
    ) {
      dropped.push({ id: deal.id, reason: "AmazonOfferCode deal is no longer active" });
      continue;
    }
    if (!offer || deal.source !== "api") {
      kept.push(deal);
      continue;
    }
    const next = creatorsIds.has(deal.id) || deal.origin !== "amazonoffercode"
      ? attachToCreatorsDeal(deal, offer)
      : refreshOfferDeal(deal, offer, today);
    if (next !== deal) attached += 1;
    kept.push(next);
  }
  const candidates = [];
  for (const offer of incoming.values()) {
    const existing = existingById.get(offer.id);
    candidates.push({
      ...offer,
      added: keptAdded(existing, today),
    });
  }
  const fresh = selectNewOffers(candidates, Math.max(0, maxNew));
  return {
    deals: [...fresh, ...kept],
    attached,
    added: fresh.length,
    dropped,
    skippedForCap: Math.max(0, candidates.length - fresh.length),
  };
}

function usageNote(category, meta) {
  const usage = meta?.usage;
  if (!usage || typeof usage !== "object") {
    return `AmazonOfferCode ${category}: usage was not in the response.`;
  }
  return `AmazonOfferCode ${category}: usage ${usage.used}/${usage.limit} (${usage.remaining} remaining).`;
}

export async function fetchAmazonOfferCodes({
  config,
  env,
  fetchImpl,
  sleep = defaultSleep,
  today,
}) {
  const token = offerApiKey(env);
  const notes = [];
  const empty = {
    skipped: true,
    stopped: null,
    offers: [],
    rejectedAsins: new Set(),
    notes,
    usage: [],
  };
  if (!token) {
    notes.push("AmazonOfferCode skipped: AMAZONOFFERCODE_API_KEY is not set.");
    return empty;
  }
  const useOwnTag = resolveUseOwnTag(env, config.useOwnTag);
  const callLimit = Math.min(config.maxCallsPerRun, MAX_OFFER_CALLS, config.categories.length);
  const categories = config.categories.slice(0, callLimit);
  if (config.categories.length > categories.length) {
    notes.push(`AmazonOfferCode is calling ${categories.length} of ${config.categories.length} categories (at most ${MAX_OFFER_CALLS} calls per run).`);
  }
  const offers = [];
  const rejectedAsins = new Set();
  const usage = [];
  let stopped = null;
  const secrets = [token];

  for (const category of categories) {
    const url = offerRequestUrl(category, { ...config, token, page: 1 });
    let response;
    let attempt = 0;
    while (true) {
      try {
        response = await fetchImpl(url);
      } catch (error) {
        const message = redact(errorDetail(error), secrets);
        notes.push(`AmazonOfferCode ${category} request failed (${message}). Creators API deals were kept.`);
        stopped = "network";
        break;
      }
      if (response?.status === 500 && attempt < SERVER_ERROR_RETRIES) {
        attempt += 1;
        await sleep(200 * attempt);
        continue;
      }
      break;
    }
    if (stopped) break;
    if (response?.status === 429) {
      notes.push("AmazonOfferCode monthly limit reached (429). Stopping further AmazonOfferCode calls. Creators API deals were kept.");
      stopped = "429";
      break;
    }
    if (response?.status === 401 || response?.status === 403) {
      const why = response.status === 401 ? "API key was rejected" : "API key is disabled";
      notes.push(`AmazonOfferCode stopped (${response.status}: ${why}). Creators API deals were kept.`);
      stopped = String(response.status);
      break;
    }
    if (!response?.ok) {
      notes.push(`AmazonOfferCode ${category} failed (${response?.status ?? "no status"}). Stopping further AmazonOfferCode calls. Creators API deals were kept.`);
      stopped = "http";
      break;
    }
    let body;
    try {
      body = await response.json();
    } catch {
      notes.push(`AmazonOfferCode ${category} returned invalid JSON. Stopping further AmazonOfferCode calls. Creators API deals were kept.`);
      stopped = "json";
      break;
    }
    notes.push(redact(usageNote(category, body?.meta), secrets));
    if (body?.meta?.usage) usage.push({ category, ...body.meta.usage });
    if (body?.meta?.has_more === true) {
      notes.push(`AmazonOfferCode ${category}: more deals exist, but this run does not request another page.`);
    }
    const rows = Array.isArray(body?.data) ? body.data : [];
    for (const row of rows) {
      const parsed = normalizeOffer(row, { today, queriedCategory: category, useOwnTag });
      if (parsed.ok) offers.push(parsed.offer);
      else if (parsed.rejected && parsed.asin) rejectedAsins.add(parsed.asin);
    }
  }

  return {
    skipped: false,
    stopped,
    offers,
    rejectedAsins,
    notes,
    usage,
  };
}

function errorDetail(error) {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? error.cause.message : "";
    return cause ? `${error.message} ${cause}` : error.message;
  }
  return error == null ? "request failed" : String(error);
}

function redact(message, secrets) {
  let text = String(message ?? "");
  for (const secret of secrets) {
    if (!secret) continue;
    text = text.split(secret).join("[redacted]");
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) text = text.split(encoded).join("[redacted]");
    const form = encoded.replaceAll("%20", "+");
    if (form !== encoded) text = text.split(form).join("[redacted]");
  }
  return text.replace(/([?&]token=)[^&\s"'<>]*/gi, "$1[redacted]");
}
