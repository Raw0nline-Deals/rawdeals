/**
 * Refresh API-backed deals in data/deals.json from the Amazon Creators API.
 *
 * Without --live, this prints the request it would make and does not use the network.
 * With --live, it reads data/asins.json, fetches those ASINs, and merges the results
 * into data/deals.json. Hand-written deals are left as they are.
 *
 * Credentials come from the environment. They are never printed. A failed auth or
 * GetItems call exits non-zero and does not write deals.json.
 */
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ASSOCIATE_TAG } from "../js/affiliate.js";
import { isExpired, todayISO } from "../js/deals.js";

export const GET_ITEMS_URL = "https://creatorsapi.amazon/catalog/v1/getItems";
export const ASIN_BATCH_SIZE = 10;

export const GET_ITEMS_RESOURCES = [
  "images.primary.large",
  "itemInfo.title",
  "offersV2.listings.price",
  "offersV2.listings.dealDetails",
  "offersV2.listings.isBuyBoxWinner",
  "offersV2.listings.violatesMAP",
];

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

export function mapCreatorsItemToDeal(item, extras = {}, added) {
  const listings = item?.offersV2?.listings || [];
  const listing = listings.find((entry) => entry.isBuyBoxWinner) || listings[0];
  if (!listing || listing.violatesMAP || listing.price?.money?.amount == null) return null;

  const original = listing.price.savingBasis?.money?.amount;
  const deal = {
    id: extras.id || item.asin,
    title: item.itemInfo?.title?.displayValue || extras.title || item.asin,
    image: item.images?.primary?.large?.url || extras.image || "",
    price: listing.price.money.amount,
    percentOff: listing.price.savings?.percentage ?? 0,
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

/**
 * Build one API deal. Returns null when the item has no usable offer or violates MAP.
 * Keeps the first-seen added date and an existing title unless the ASIN list overrides it.
 */
export function dealFromCreatorsItem(item, entry, { today, existing }) {
  const mapped = mapCreatorsItemToDeal(item, {
    id: entry.asin,
    category: entry.category || existing?.category,
    promoCode: entry.promoCode,
  }, existing?.added || today);
  if (!mapped) return null;

  const deal = {
    id: entry.asin,
    title: entry.title || existing?.title || mapped.title,
    image: entry.image || mapped.image || existing?.image || "",
    price: mapped.price,
  };
  if (typeof mapped.originalPrice === "number") deal.originalPrice = mapped.originalPrice;
  deal.percentOff = mapped.percentOff;
  if (entry.promoCode) deal.promoCode = entry.promoCode;
  deal.category = entry.category || existing?.category || mapped.category;
  deal.url = mapped.url;
  deal.added = existing?.added || today;
  const expires = entry.expires || mapped.expires;
  if (expires) deal.expires = expires;
  deal.sample = false;
  deal.source = "api";
  return deal;
}

/**
 * @param {object[]} existingDeals
 * @param {Map<string, object|null>} updates asin -> refreshed deal, or null to drop it
 * @param {string} today YYYY-MM-DD in America/Chicago
 */
export function mergeApiDeals(existingDeals, updates, today) {
  const kept = [];
  const seen = new Set();
  for (const deal of existingDeals) {
    if (updates.has(deal.id) && deal.source === "api") {
      const next = updates.get(deal.id);
      seen.add(deal.id);
      if (next && !isExpired(next, today)) kept.push(next);
      continue;
    }
    if (deal.source === "api" && isExpired(deal, today)) continue;
    kept.push(deal);
    if (updates.has(deal.id)) seen.add(deal.id);
  }
  const novel = [];
  for (const [id, deal] of updates) {
    if (deal && !seen.has(id) && !isExpired(deal, today)) novel.push(deal);
  }
  return [...novel, ...kept];
}

export function planText({ entries, status }) {
  const asins = entries.map((entry) => entry.asin);
  const body = buildGetItemsBody(asins, status.partnerTag);
  return [
    "RawDeals Creators API dry run",
    "Live calls: not requested",
    `Credential ID: ${status.idSet ? "set" : "missing"}`,
    `Credential secret: ${status.secretSet ? "set (not shown)" : "missing"}`,
    `Credential version: ${status.version}`,
    `Would request a token from ${tokenEndpoint(status.version)} (not called).`,
    `Would POST ${GET_ITEMS_URL} in batches of ${ASIN_BATCH_SIZE} (not called).`,
    `partnerTag: ${body.partnerTag}`,
    `itemIds: ${body.itemIds.join(", ") || "(none)"}`,
    "No request was sent.",
  ].join("\n");
}

export async function fetchCreatorsItems({ entries, env, fetchImpl, partnerTag }) {
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
  for (const batch of chunkList(entries.map((entry) => entry.asin), ASIN_BATCH_SIZE)) {
    let response;
    try {
      response = await fetchImpl(GET_ITEMS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "x-marketplace": "www.amazon.com",
        },
        body: JSON.stringify(buildGetItemsBody(batch, partnerTag)),
      });
    } catch (error) {
      fail(`Creators API GetItems request failed. ${error instanceof Error ? error.message : ""}`.trim());
    }
    if (!response?.ok) fail(`Creators API GetItems request failed (${response?.status ?? "no status"}).`);
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
  return byAsin;
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
  env = process.env,
  fetchImpl = globalThis.fetch,
  today = todayISO(),
  partnerTag = ASSOCIATE_TAG,
}) {
  const entries = loadAsinEntries(JSON.parse(readFileSync(asinsPath, "utf8")));
  if (entries.length === 0) return { changed: false, reason: "empty" };

  const before = readFileSync(dealsPath, "utf8");
  const payload = JSON.parse(before);
  const existingDeals = Array.isArray(payload) ? payload : payload?.deals;
  if (!Array.isArray(existingDeals)) throw new Error("data/deals.json must be an array or an object with a deals array.");

  const itemsByAsin = await fetchCreatorsItems({ entries, env, fetchImpl, partnerTag });
  const updates = buildUpdates(existingDeals, entries, itemsByAsin, today);
  const nextDeals = mergeApiDeals(existingDeals, updates, today);
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
  return { changed: true, reason: "updated", count: nextDeals.filter((deal) => deal.source === "api").length };
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
  const live = process.argv.includes("--live");
  let entries;
  try {
    entries = loadAsinEntries(JSON.parse(readFileSync(asinsPath, "utf8")));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Could not read data/asins.json.");
    process.exitCode = 1;
    return;
  }
  if (!live) {
    console.log(planText({ entries, status: credentialStatus() }));
    return;
  }
  if (entries.length === 0) {
    console.log("ASIN list is empty. deals.json was not changed.");
    return;
  }
  refreshDealsFile({ asinsPath, dealsPath })
    .then((result) => {
      if (!result.changed) console.log(`deals.json was not changed (${result.reason}).`);
      else console.log(`Updated data/deals.json (${result.count} API deals). Hand-written deals were kept.`);
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
