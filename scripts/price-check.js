/**
 * Recheck prices for deals already in data/deals.json.
 *
 * This does not discover new deals, does not read AmazonOfferCode, and does
 * not post the morning new-deal announcement. It calls Creators API GetItems
 * for posted ASINs, using the same auth, batching, and OffersV2 mapping as
 * the daily refresh.
 *
 * A deal whose price still meets the refresh rules is updated in place
 * (price, originalPrice, percentOff) and stamped with lastChecked.
 * No offer, a MAP violation, an ended deal, or a discount under the refresh
 * minimum removes it. Out of stock removes it with action "unavailable".
 * Hand-written deals, sample cards, and AmazonOfferCode promo prices the
 * Creators API does not cover are left alone. A promo-only deal is still
 * removed when GetItems reports no offer, MAP, or out of stock.
 *
 * A missing credential or a failed GetItems call throws before either file
 * is written. Secrets are not printed.
 *
 *   node scripts/price-check.js
 *   node scripts/price-check.js --live
 *   node scripts/price-check.js --discord
 */
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ASSOCIATE_TAG } from "../js/affiliate.js";
import { isExpired, todayISO } from "../js/deals.js";
import { postPriceCheck } from "./post-discord.js";
import {
  ASIN_BATCH_SIZE,
  CATALOG_PAUSE_MS,
  availabilityStatus,
  credentialStatus,
  emptyDiscovery,
  fetchCreatorsCatalog,
  loadAsinEntries,
  mapCreatorsItemToDeal,
  pickListing,
  readDiscoveryFile,
  redactSecrets,
} from "./fetch-deals.js";

export const PRICE_CHECK_LOG_DAYS = 30;
/** Backstop so a burst of manual runs cannot grow the log without a bound. */
export const PRICE_CHECK_LOG_MAX_RUNS = 240;
const ASIN_ID = /^[A-Z0-9]{10}$/;

/**
 * Posted Creators API deals this sweep can ask GetItems about.
 * Sample cards, hand-written deals, and ids that are not ASINs are not.
 */
export function isPriceCheckCandidate(deal) {
  if (!deal || typeof deal !== "object") return false;
  if (deal.sample === true) return false;
  if (deal.source !== "api") return false;
  return typeof deal.id === "string" && ASIN_ID.test(deal.id);
}

/**
 * AmazonOfferCode rows store the coupon price. GetItems does not return that
 * coupon, so a live list price must not replace it.
 */
export function isPromoOnlyUncovered(deal) {
  return deal?.origin === "amazonoffercode";
}

function cents(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

function wholePercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.round(number);
}

function pricedFromItem(item) {
  const mapped = mapCreatorsItemToDeal(item, {}, "1970-01-01");
  if (!mapped || typeof mapped.price !== "number" || !Number.isFinite(mapped.price) || mapped.price < 0) {
    return null;
  }
  const percent = wholePercent(mapped.percentOff);
  if (percent == null || mapped.percentOff < 0 || mapped.percentOff > 100) return null;
  let originalPrice = typeof mapped.originalPrice === "number" ? mapped.originalPrice : null;
  if (originalPrice != null && !(originalPrice > mapped.price)) originalPrice = null;
  return {
    price: mapped.price,
    originalPrice,
    percentOff: mapped.percentOff,
    expires: mapped.expires || null,
  };
}

/**
 * Live price, list price, savings percent, and availability for one GetItems
 * item. Price fields come from mapCreatorsItemToDeal, the same OffersV2
 * mapping the daily refresh uses.
 */
export function readLiveOffer(item) {
  if (!item) return { status: "removed", reason: "not returned by the Creators API" };
  const listing = pickListing(item);
  const priced = pricedFromItem(item);
  if (availabilityStatus(listing) === "unavailable") {
    return { status: "unavailable", reason: "out of stock or unavailable", ...(priced || {}) };
  }
  if (listing?.violatesMAP) return { status: "removed", reason: "violates MAP" };
  if (!listing || listing.price?.money?.amount == null || !priced) {
    return { status: "removed", reason: "no buyable offer" };
  }
  return { status: "ok", reason: null, ...priced };
}

function hasPromo(deal) {
  return (typeof deal?.promoCode === "string" && deal.promoCode.trim().length > 0)
    || deal?.checkoutDiscount === true;
}

/**
 * The daily refresh keeps a hand-picked ASIN when it is still discounted or
 * it has a promo code. A discovered deal has to stay at minDiscountPercent.
 */
export function meetsRefreshDiscount(deal, offer, { listed, minDiscountPercent }) {
  const percent = offer?.percentOff;
  if (listed) {
    if (hasPromo(deal)) return true;
    return typeof percent === "number" && percent > 0;
  }
  return typeof percent === "number" && percent >= minDiscountPercent;
}

function applyLivePrice(deal, offer, checkedAt) {
  const next = {
    ...deal,
    price: offer.price,
    percentOff: offer.percentOff,
    lastChecked: checkedAt,
  };
  if (typeof offer.originalPrice === "number" && offer.originalPrice > offer.price) {
    next.originalPrice = offer.originalPrice;
  } else {
    delete next.originalPrice;
  }
  return next;
}

function stampChecked(deal, checkedAt) {
  if (deal.lastChecked === checkedAt) return deal;
  return { ...deal, lastChecked: checkedAt };
}

function pricesDiffer(deal, offer) {
  const nextOriginal = typeof offer.originalPrice === "number" && offer.originalPrice > offer.price
    ? offer.originalPrice
    : null;
  const prevOriginal = typeof deal.originalPrice === "number" ? deal.originalPrice : null;
  return cents(deal.price) !== cents(offer.price)
    || cents(prevOriginal) !== cents(nextOriginal)
    || wholePercent(deal.percentOff) !== wholePercent(offer.percentOff);
}

function changeRecord(deal, offer, action, reason) {
  const knownPrice = typeof offer?.price === "number";
  return {
    asin: deal.id,
    title: typeof deal.title === "string" && deal.title.trim() ? deal.title : deal.id,
    url: typeof deal.url === "string" ? deal.url : "",
    oldPrice: typeof deal.price === "number" ? deal.price : null,
    newPrice: knownPrice ? offer.price : null,
    oldPercentOff: typeof deal.percentOff === "number" ? deal.percentOff : null,
    newPercentOff: knownPrice && typeof offer.percentOff === "number" ? offer.percentOff : null,
    action,
    reason,
  };
}

/**
 * Compare one posted deal with the GetItems item for its ASIN.
 * `listed` is true when the ASIN is in data/asins.json.
 * Returns the deal to keep, or omits it when the action removes it.
 */
export function decidePriceCheck(deal, item, {
  checkedAt,
  today,
  minDiscountPercent,
  listed = false,
}) {
  if (!isPriceCheckCandidate(deal)) return { action: "skip", deal };
  const offer = readLiveOffer(item);
  const promoOnly = isPromoOnlyUncovered(deal);

  if (promoOnly && offer.reason === "not returned by the Creators API") {
    return { action: "skip", deal };
  }
  if (offer.status === "unavailable") {
    return {
      action: "unavailable",
      change: changeRecord(deal, offer, "unavailable", offer.reason),
    };
  }
  if (offer.status === "removed") {
    return {
      action: "removed",
      change: changeRecord(deal, offer, "removed", offer.reason || "no buyable offer"),
    };
  }
  if (offer.expires && isExpired({ expires: offer.expires }, today)) {
    return {
      action: "removed",
      change: changeRecord(deal, offer, "removed", "deal ended"),
    };
  }
  if (promoOnly) return { action: "unchanged", deal: stampChecked(deal, checkedAt) };
  if (!meetsRefreshDiscount(deal, offer, { listed, minDiscountPercent })) {
    return {
      action: "removed",
      change: changeRecord(deal, offer, "removed", "discount below the minimum"),
    };
  }
  if (!pricesDiffer(deal, offer)) return { action: "unchanged", deal: stampChecked(deal, checkedAt) };
  return {
    action: "updated",
    deal: applyLivePrice(deal, offer, checkedAt),
    change: changeRecord(deal, offer, "updated", "price changed"),
  };
}

/**
 * Apply a sweep to the posted deals. Items the response did not include are
 * a miss (`get` returns undefined). Nothing is added.
 */
export function priceCheckDeals(deals, itemsByAsin, {
  checkedAt,
  today,
  minDiscountPercent,
  listedAsins = new Set(),
}) {
  const counts = {
    checked: 0,
    unchanged: 0,
    updated: 0,
    removed: 0,
    unavailable: 0,
    skipped: 0,
  };
  const changes = [];
  const next = [];
  for (const deal of deals) {
    const decision = decidePriceCheck(deal, itemsByAsin.get(deal?.id), {
      checkedAt,
      today,
      minDiscountPercent,
      listed: listedAsins.has(deal?.id),
    });
    const actionKey = decision.action === "skip" ? "skipped" : decision.action;
    counts[actionKey] += 1;
    if (decision.action === "skip" || decision.action === "unchanged" || decision.action === "updated") {
      next.push(decision.deal);
    }
    if (decision.change) changes.push(decision.change);
  }
  counts.checked = counts.unchanged + counts.updated + counts.removed + counts.unavailable;
  if (counts.updated + counts.removed + counts.unavailable !== changes.length) {
    throw new Error("Price check change list does not match the action counts.");
  }
  return {
    deals: next,
    run: { checkedAt, ...counts, changes },
  };
}

export function retainPriceCheckRuns(runs, nowIso, {
  days = PRICE_CHECK_LOG_DAYS,
  maxRuns = PRICE_CHECK_LOG_MAX_RUNS,
} = {}) {
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) return [];
  const cutoff = nowMs - days * 24 * 60 * 60 * 1000;
  const fresh = (Array.isArray(runs) ? runs : []).filter((run) => {
    const ms = Date.parse(run?.checkedAt);
    return Number.isFinite(ms) && ms >= cutoff;
  });
  return fresh.slice(-maxRuns);
}

export function priceCheckPlan({ deals, status, minDiscountPercent }) {
  const list = Array.isArray(deals) ? deals : [];
  const candidates = list.filter(isPriceCheckCandidate);
  const batches = candidates.length === 0 ? 0 : Math.ceil(candidates.length / ASIN_BATCH_SIZE);
  const lines = [
    "RawDeals price check dry run",
    "Live calls: not requested",
    `Credential ID: ${status.idSet ? "set" : "missing"}`,
    `Credential secret: ${status.secretSet ? "set (not shown)" : "missing"}`,
    `Credential version: ${status.version}`,
    `Deals in the file: ${list.length}`,
    `Would POST GetItems for ${candidates.length} posted ASINs in ${batches} batch(es) of ${ASIN_BATCH_SIZE}.`,
    `Discovered deals must stay at least ${minDiscountPercent}% off. Hand-picked ASINs stay while they still have a discount or a promo code.`,
    "AmazonOfferCode promo prices are not replaced. Those deals are removed only when GetItems reports no offer, MAP, or out of stock.",
    "Hand-written and sample deals are not requested. No new deals are added.",
    "No request was sent.",
  ];
  return lines.join("\n");
}

export function priceCheckSummary(run) {
  const lines = [
    `Price check at ${run.checkedAt}: checked ${run.checked}, unchanged ${run.unchanged}, updated ${run.updated}, removed ${run.removed}, unavailable ${run.unavailable}, skipped ${run.skipped}.`,
  ];
  if (typeof run.requests === "number") lines.push(`Catalog requests: ${run.requests}.`);
  for (const change of run.changes || []) {
    const next = change.newPrice == null ? "none" : change.newPrice;
    const nextPercent = change.newPercentOff == null ? "none" : change.newPercentOff;
    lines.push(
      `${change.action} ${change.asin} (${change.oldPrice} -> ${next}, ${change.oldPercentOff}% -> ${nextPercent}%, ${change.reason}).`,
    );
  }
  return lines;
}

function readJsonFile(file, label) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") throw new Error(`${label} is missing.`);
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON.`);
    throw error;
  }
}

function readListedAsins(asinsPath) {
  const payload = readJsonFile(asinsPath, "data/asins.json");
  return new Set(loadAsinEntries(payload).map((entry) => entry.asin));
}

function readLog(logPath) {
  let text;
  try {
    text = readFileSync(logPath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return { runs: [] };
    throw error;
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("data/price-checks.json is not valid JSON.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray(payload.runs)) {
    throw new Error("data/price-checks.json must be an object with a runs array.");
  }
  return payload;
}

function writeJsonAtomic(file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, text);
    renameSync(temporary, file);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* the previous file is still in place */ }
    throw error;
  }
}

function dealsPayload(payload, deals) {
  return Array.isArray(payload) ? deals : { ...payload, deals };
}

/**
 * Recheck dealsPath and append one run to logPath.
 * Throws before writing when credentials are missing or GetItems fails.
 */
export async function priceCheckFile({
  dealsPath,
  logPath,
  asinsPath,
  discoveryPath,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = new Date(),
  pauseMs = 0,
  sleep,
  partnerTag = ASSOCIATE_TAG,
}) {
  const before = readFileSync(dealsPath, "utf8");
  const payload = JSON.parse(before);
  const existing = Array.isArray(payload) ? payload : payload?.deals;
  if (!Array.isArray(existing)) throw new Error("data/deals.json must be an array or an object with a deals array.");

  const listedAsins = readListedAsins(asinsPath);
  const discovery = discoveryPath ? readDiscoveryFile(discoveryPath) : emptyDiscovery();
  const checkedAt = now.toISOString();
  const today = todayISO(now);
  const candidates = existing.filter(isPriceCheckCandidate);

  const finish = (run, nextDeals) => {
    const log = readLog(logPath);
    const runs = retainPriceCheckRuns([...log.runs, run], checkedAt);
    const nextPayload = dealsPayload(payload, nextDeals);
    const nextText = `${JSON.stringify(nextPayload, null, 2)}\n`;
    const dealsChanged = run.checked > 0 && nextText !== before;
    if (dealsChanged) writeJsonAtomic(dealsPath, nextPayload);
    writeJsonAtomic(logPath, { ...log, runs });
    return {
      dealsChanged,
      material: run.changes.length > 0,
      run,
    };
  };

  if (candidates.length === 0) {
    const run = {
      checkedAt,
      checked: 0,
      unchanged: 0,
      updated: 0,
      removed: 0,
      unavailable: 0,
      skipped: existing.length,
      requests: 0,
      changes: [],
    };
    return finish(run, existing);
  }

  const catalog = await fetchCreatorsCatalog({
    entries: [...new Set(candidates.map((deal) => deal.id))].map((asin) => ({ asin })),
    searches: [],
    discovery: emptyDiscovery(),
    env,
    fetchImpl,
    partnerTag,
    pauseMs,
    sleep,
  });
  const checked = priceCheckDeals(existing, catalog.byAsin, {
    checkedAt,
    today,
    minDiscountPercent: discovery.minDiscountPercent,
    listedAsins,
  });
  const run = { ...checked.run, requests: catalog.requests };
  return finish(run, checked.deals);
}

function repoPaths() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  return {
    root,
    dealsPath: join(root, "data", "deals.json"),
    logPath: join(root, "data", "price-checks.json"),
    asinsPath: join(root, "data", "asins.json"),
    discoveryPath: join(root, "data", "discovery.json"),
  };
}

function secretList() {
  return [
    process.env.CREATORS_API_CREDENTIAL_ID,
    process.env.CREATORS_API_CREDENTIAL_SECRET,
    process.env.DISCORD_WEBHOOK_URL,
    process.env.AMAZONOFFERCODE_API_KEY,
  ];
}

async function discordMain() {
  const { logPath } = repoPaths();
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  try {
    let log;
    try {
      log = readLog(logPath);
    } catch (error) {
      if (error instanceof Error && error.message === "data/price-checks.json is missing.") {
        console.log("Discord: skipped (no price check log).");
        return;
      }
      throw error;
    }
    const run = log.runs.at(-1);
    if (!run) {
      console.log("Discord: skipped (no price check log).");
      return;
    }
    const result = await postPriceCheck(run, { webhookUrl, today: todayISO() });
    if (result.skipped) {
      console.log(`Discord: skipped (${result.reason}).`);
      return;
    }
    const count = run.changes.length;
    console.log(`Discord: posted ${result.posted} ${result.posted === 1 ? "message" : "messages"} for ${count} price ${count === 1 ? "change" : "changes"}.`);
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : "Discord post failed.", secretList());
    console.error(message || "Discord post failed.");
    process.exitCode = 1;
  }
}

async function main() {
  if (process.argv.includes("--discord")) {
    await discordMain();
    return;
  }
  const paths = repoPaths();
  const live = process.argv.includes("--live");
  let deals;
  let discovery;
  try {
    const payload = readJsonFile(paths.dealsPath, "data/deals.json");
    deals = Array.isArray(payload) ? payload : payload?.deals;
    if (!Array.isArray(deals)) throw new Error("data/deals.json must be an array or an object with a deals array.");
    discovery = readDiscoveryFile(paths.discoveryPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Could not read the deal file.");
    process.exitCode = 1;
    return;
  }
  if (!live) {
    console.log(priceCheckPlan({
      deals,
      status: credentialStatus(),
      minDiscountPercent: discovery.minDiscountPercent,
    }));
    return;
  }
  try {
    const result = await priceCheckFile({ ...paths, pauseMs: CATALOG_PAUSE_MS });
    for (const line of priceCheckSummary(result.run)) console.log(line);
    if (!result.dealsChanged) console.log("data/deals.json was not changed.");
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : "Price check failed.", secretList());
    console.error(message || "Price check failed.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
