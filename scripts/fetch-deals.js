/**
 * Stub for a future job that fills data/deals.json from the Amazon Creators API.
 *
 * This file never contacts Amazon. `--live` is refused on purpose.
 * Credentials are read only to report whether they are present. The secret
 * is never printed. Do not commit credential values. Use GitHub Actions
 * secrets when a real job is added later. See the README.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ASSOCIATE_TAG } from "../js/affiliate.js";

export const GET_ITEMS_URL = "https://creatorsapi.amazon/catalog/v1/getItems";

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

export function planText({ watchlist, status }) {
  const asins = (watchlist.items || []).map((item) => item.asin);
  const body = buildGetItemsBody(asins, status.partnerTag);
  return [
    "RawDeals Creators API stub",
    "Live calls: disabled",
    `Credential ID: ${status.idSet ? "set" : "missing"}`,
    `Credential secret: ${status.secretSet ? "set (not shown)" : "missing"}`,
    `Credential version: ${status.version}`,
    `Would request a token from ${tokenEndpoint(status.version)} (not called).`,
    `Would POST ${GET_ITEMS_URL} (not called).`,
    `partnerTag: ${body.partnerTag}`,
    `itemIds: ${body.itemIds.join(", ") || "(none)"}`,
    "Promo codes are copied from data/watchlist.json. OffersV2 does not return them.",
    "No request was sent.",
  ].join("\n");
}

function main() {
  if (process.argv.includes("--live")) {
    console.error("Live Creators API calls are disabled in this stub. No request was sent.");
    process.exitCode = 1;
    return;
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const watchlist = JSON.parse(readFileSync(join(root, "data", "watchlist.json"), "utf8"));
  console.log(planText({ watchlist, status: credentialStatus() }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
