/**
 * Verify dead-deal reports with the Amazon Creators API.
 *
 * GitHub Actions runs this on a schedule. It reads deals that reached the
 * report threshold, looks up each ASIN with the same credentials as the daily
 * refresh, and posts a verdict. Credentials stay in the environment. They are
 * never printed. A failed Amazon call does not post verdicts for that run's
 * new reports and does not mark those deals dead in deals.json.
 *
 * Without DEAD_DEALS_TOKEN the script exits successfully and sends nothing.
 * Pass --reconcile to clear verified flags for deals the site is showing again.
 */
import { appendFileSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ASSOCIATE_TAG } from "../js/affiliate.js";
import { dealsFromPayload, todayISO, visibleDeals } from "../js/deals.js";
import {
  CATALOG_PAUSE_MS,
  emptyDiscovery,
  fetchCreatorsCatalog,
  pickListing,
  availabilityStatus,
  redactSecrets,
} from "./fetch-deals.js";

export const PRICE_TOLERANCE = 0.02;
const ASIN = /^[A-Z0-9]{10}$/;

export function deadDealsApiBase(env = process.env) {
  const value = env.DEAD_DEALS_API_URL;
  if (typeof value === "string" && value.trim()) return value.trim().replace(/\/+$/, "");
  return "https://api.getrawdeals.com";
}

export function deadDealsToken(env = process.env) {
  const token = env.DEAD_DEALS_TOKEN;
  return typeof token === "string" && token.trim().length >= 16 ? token.trim() : "";
}

export function asinFromDeal(deal) {
  const fromId = normalizeAsin(deal?.id);
  if (fromId) return fromId;
  if (typeof deal?.url !== "string") return null;
  try {
    const parts = new URL(deal.url).pathname.split("/").filter(Boolean);
    for (let index = 0; index < parts.length - 1; index += 1) {
      const key = parts[index].toLowerCase();
      if (key === "dp" || key === "product" || key === "asin") {
        const asin = normalizeAsin(parts[index + 1]);
        if (asin) return asin;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeAsin(value) {
  if (typeof value !== "string") return null;
  const asin = value.trim().toUpperCase();
  return ASIN.test(asin) ? asin : null;
}

/**
 * A report is dead when Amazon no longer sells the offer the card describes.
 * A price that is still at or below the card, with a buyable listing, stays up.
 */
export function verdictForDeal(deal, item, today) {
  if (!item) return { dead: true, reason: "not_found" };
  const listing = pickListing(item);
  if (availabilityStatus(listing) === "unavailable") return { dead: true, reason: "unavailable" };
  const amount = listing?.price?.money?.amount;
  if (!listing || listing.violatesMAP || typeof amount !== "number" || !Number.isFinite(amount)) {
    return { dead: true, reason: "no_offer" };
  }
  if (typeof deal?.price === "number" && amount > deal.price + PRICE_TOLERANCE) {
    return { dead: true, reason: "price_up" };
  }
  const end = listing.dealDetails?.endTime;
  if (typeof today === "string" && end && String(end).slice(0, 10) < today) {
    return { dead: true, reason: "expired" };
  }
  return { dead: false, reason: "still_live" };
}

export function applyVerifiedDead(payload, deadIds) {
  const ids = new Set(deadIds);
  const deals = Array.isArray(payload) ? payload : payload?.deals;
  if (!Array.isArray(deals)) throw new Error("data/deals.json must be an array or an object with a deals array.");
  let changed = false;
  const nextDeals = deals.map((deal) => {
    if (!deal || !ids.has(deal.id)) return deal;
    if (deal.verifiedDead === true && deal.inStock === false) return deal;
    changed = true;
    return { ...deal, inStock: false, verifiedDead: true };
  });
  const nextPayload = Array.isArray(payload) ? nextDeals : { ...payload, deals: nextDeals };
  return { payload: nextPayload, changed };
}

export function activeDealIds(deals, today) {
  return visibleDeals(deals, today).map((deal) => deal.id);
}

async function apiRequest(fetchImpl, url, token, { method = "GET", body } = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    throw new Error(`Dead-deal API ${method} failed. ${message}`.trim());
  }
  if (!response?.ok) throw new Error(`Dead-deal API ${method} failed (${response?.status ?? "no status"}).`);
  if (response.status === 204) return null;
  return response.json();
}

function secretList(env, token) {
  return [env.CREATORS_API_CREDENTIAL_ID, env.CREATORS_API_CREDENTIAL_SECRET, env.DEAD_DEALS_TOKEN, token];
}

export async function verifyPendingDeals({
  apiBase,
  token,
  deals,
  env,
  fetchImpl,
  today,
  pauseMs = 0,
  sleep,
  partnerTag = ASSOCIATE_TAG,
}) {
  if (!token) return { skipped: true, deadIds: [], verdicts: [], amazonError: null };
  const base = apiBase.replace(/\/+$/, "");
  let admin;
  try {
    admin = await apiRequest(fetchImpl, `${base}/api/dead-deals/admin`, token);
  } catch (error) {
    throw new Error(redactSecrets(error instanceof Error ? error.message : "Dead-deal API request failed.", secretList(env, token)));
  }
  const pending = Array.isArray(admin?.pending) ? admin.pending : [];
  const alreadyVerified = Array.isArray(admin?.verified) ? admin.verified : [];
  let verdicts = [];
  let amazonError = null;
  try {
    verdicts = await judgePending({ pending, deals, env, fetchImpl, today, pauseMs, sleep, partnerTag });
    if (verdicts.length > 0) {
      await apiRequest(fetchImpl, `${base}/api/dead-deals/verdicts`, token, {
        method: "POST",
        body: { verdicts },
      });
    }
  } catch (error) {
    amazonError = redactSecrets(
      error instanceof Error ? error.message : "Dead-deal verification failed.",
      secretList(env, token),
    );
    verdicts = [];
  }
  const live = new Set(verdicts.filter((verdict) => !verdict.dead).map((verdict) => verdict.id));
  const deadIds = [];
  for (const entry of alreadyVerified) {
    if (entry?.id && !live.has(entry.id)) deadIds.push(entry.id);
  }
  for (const verdict of verdicts) {
    if (verdict.dead && !deadIds.includes(verdict.id)) deadIds.push(verdict.id);
  }
  return { skipped: false, deadIds, verdicts, amazonError };
}

async function judgePending({ pending, deals, env, fetchImpl, today, pauseMs, sleep, partnerTag }) {
  const byId = new Map((deals || []).filter((deal) => deal && deal.id).map((deal) => [deal.id, deal]));
  const verdicts = [];
  const toCheck = [];
  for (const entry of pending) {
    const id = entry?.id;
    if (typeof id !== "string" || !id) continue;
    const deal = byId.get(id);
    if (!deal) {
      verdicts.push({ id, dead: false, reason: "unknown" });
      continue;
    }
    const asin = asinFromDeal(deal);
    if (!asin) {
      verdicts.push({ id, dead: false, reason: "unverifiable" });
      continue;
    }
    toCheck.push({ id, asin, deal });
  }
  if (toCheck.length === 0) return verdicts;

  const catalog = await fetchCreatorsCatalog({
    entries: [...new Set(toCheck.map((entry) => entry.asin))].map((asin) => ({ asin })),
    searches: [],
    discovery: emptyDiscovery(),
    env,
    fetchImpl,
    partnerTag,
    pauseMs,
    sleep,
  });
  for (const entry of toCheck) {
    const verdict = verdictForDeal(entry.deal, catalog.byAsin.get(entry.asin) || null, today);
    verdicts.push({ id: entry.id, dead: verdict.dead, reason: verdict.reason });
  }
  return verdicts;
}

export async function reconcileLiveDeals({ apiBase, token, activeIds, fetchImpl, env = process.env }) {
  if (!token) return { skipped: true, cleared: 0 };
  try {
    const body = await apiRequest(fetchImpl, `${apiBase.replace(/\/+$/, "")}/api/dead-deals/reconcile`, token, {
      method: "POST",
      body: { activeIds },
    });
    return { skipped: false, cleared: body?.cleared ?? 0 };
  } catch (error) {
    throw new Error(redactSecrets(error instanceof Error ? error.message : "Reconcile failed.", secretList(env, token)));
  }
}

function readDeals(dealsPath) {
  const payload = JSON.parse(readFileSync(dealsPath, "utf8"));
  return { payload, deals: dealsFromPayload(payload) };
}

function writeDeals(dealsPath, payload) {
  const temporary = `${dealsPath}.${process.pid}.tmp`;
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  try {
    writeFileSync(temporary, text);
    renameSync(temporary, dealsPath);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* the original deals.json is still in place */ }
    throw error;
  }
}

function noteChanged() {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, "changed=true\n");
}

export async function verifyFromDisk({
  dealsPath,
  env = process.env,
  fetchImpl = globalThis.fetch,
  today = todayISO(),
  pauseMs = CATALOG_PAUSE_MS,
  sleep,
} = {}) {
  const token = deadDealsToken(env);
  if (!token) return { skipped: true, changed: false, amazonError: null };
  const { payload, deals } = readDeals(dealsPath);
  const result = await verifyPendingDeals({
    apiBase: deadDealsApiBase(env),
    token,
    deals,
    env,
    fetchImpl,
    today,
    pauseMs,
    sleep,
  });
  const applied = applyVerifiedDead(payload, result.deadIds);
  if (applied.changed) {
    writeDeals(dealsPath, applied.payload);
    noteChanged();
  }
  return { skipped: false, changed: applied.changed, amazonError: result.amazonError, verdicts: result.verdicts };
}

export async function reconcileFromDisk({
  dealsPath,
  env = process.env,
  fetchImpl = globalThis.fetch,
  today = todayISO(),
} = {}) {
  const token = deadDealsToken(env);
  if (!token) return { skipped: true, cleared: 0 };
  const { deals } = readDeals(dealsPath);
  return reconcileLiveDeals({
    apiBase: deadDealsApiBase(env),
    token,
    activeIds: activeDealIds(deals, today),
    fetchImpl,
    env,
  });
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const dealsPath = join(root, "data", "deals.json");
  const reconcile = process.argv.includes("--reconcile");
  const run = reconcile
    ? reconcileFromDisk({ dealsPath })
    : verifyFromDisk({ dealsPath });
  run.then((result) => {
    if (result.skipped) {
      console.log("DEAD_DEALS_TOKEN is not set. Skipping dead-deal verification. No request was sent.");
      return;
    }
    if (reconcile) {
      console.log(`Cleared verified flags for ${result.cleared} deal${result.cleared === 1 ? "" : "s"} the site is showing.`);
      return;
    }
    if (result.amazonError) {
      console.warn(`::warning::${result.amazonError}`);
      if (!result.changed) {
        console.error(result.amazonError);
        process.exitCode = 1;
        return;
      }
    }
    const checked = result.verdicts?.length || 0;
    console.log(result.changed
      ? `Updated data/deals.json after checking ${checked} report${checked === 1 ? "" : "s"}.`
      : `No dead deals to write after checking ${checked} report${checked === 1 ? "" : "s"}.`);
  }).catch((error) => {
    const message = redactSecrets(error instanceof Error ? error.message : "Dead-deal verification failed.", [
      process.env.CREATORS_API_CREDENTIAL_ID,
      process.env.CREATORS_API_CREDENTIAL_SECRET,
      process.env.DEAD_DEALS_TOKEN,
    ]);
    if (reconcile) {
      // A down API must not stop the daily deal refresh or the feed rebuild.
      console.warn(`::warning::${message || "Could not clear shared dead flags."}`);
      return;
    }
    console.error(message || "Dead-deal verification failed.");
    process.exitCode = 1;
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
