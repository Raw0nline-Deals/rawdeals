/**
 * Confirm the links this repo builds for AmazonOfferCode carry ASSOCIATE_TAG.
 *
 * Without --live, it only checks the link builder and does not use the network.
 * With --live, it also requests a public sample promo page with that tag and
 * prints each redirect. It does not use an API key.
 *
 *   node scripts/check-promo-tag.js
 *   node scripts/check-promo-tag.js --live
 */
import { fileURLToPath } from "node:url";
import { ASSOCIATE_TAG } from "../js/affiliate.js";
import { buildOfferLink, linkCarriesAssociateTag } from "./amazonoffercode.js";

export const SAMPLE_PROMO_PATH = "A25MGS6T831FVU";
export const SAMPLE_PROMO_URL = `https://www.amazon.com/promocode/${SAMPLE_PROMO_PATH}?tag=${ASSOCIATE_TAG}`;

const SAMPLES = [
  {
    label: "coded",
    offer: { asin: "B0GN91F43B", coupon_code: "AXQS5VIJ" },
  },
  {
    label: "auto-applied",
    offer: {
      asin: "B0CODE0001",
      coupon_code: null,
      amazon_link: "https://www.amazon.com/promocode/A25MGS6T831FVU?tag=amazonoffercode-20",
    },
  },
];

export function builtOfferLinks({ useOwnTag = true, tag = ASSOCIATE_TAG } = {}) {
  return SAMPLES.map((sample) => {
    const built = buildOfferLink(sample.offer, { useOwnTag, tag });
    return { label: sample.label, ...built };
  });
}

export function tagOf(rawUrl) {
  try {
    return new URL(rawUrl).searchParams.get("tag");
  } catch {
    return null;
  }
}

/**
 * Follow redirects without a browser and report whether the Associates tag
 * is still on the URL Amazon asks the browser to open.
 */
export async function tracePromoTag(rawUrl, fetchImpl, { maxHops = 8 } = {}) {
  const hops = [];
  const seen = new Set();
  let current = rawUrl;
  for (let hop = 0; hop < maxHops; hop += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    const response = await fetchImpl(current, { method: "GET", redirect: "manual" });
    const location = headerValue(response, "location");
    hops.push({
      url: current,
      status: response?.status ?? null,
      location: location || null,
      tag: tagOf(current),
    });
    if (!location || !isRedirect(response?.status)) break;
    current = new URL(location, current).toString();
  }
  const last = hops[hops.length - 1] || null;
  const finalUrl = last?.location && isRedirect(last.status) ? last.location : last?.url || rawUrl;
  return {
    hops,
    finalUrl,
    startedWithTag: tagOf(rawUrl) === ASSOCIATE_TAG,
    finalTag: tagOf(finalUrl),
    keptTag: tagOf(finalUrl) === ASSOCIATE_TAG,
  };
}

function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function headerValue(response, name) {
  const headers = response?.headers;
  if (!headers) return "";
  if (typeof headers.get === "function") return headers.get(name) || headers.get(name.toLowerCase()) || "";
  return headers[name] || headers[name.toLowerCase()] || "";
}

function printBuilderResult() {
  const links = builtOfferLinks();
  let failed = false;
  for (const link of links) {
    const ok = linkCarriesAssociateTag(link.url);
    console.log(`${link.label}: ${link.url}`);
    if (!ok) {
      console.error(`${link.label} link is missing tag=${ASSOCIATE_TAG}`);
      failed = true;
    }
  }
  return failed;
}

async function main() {
  const failed = printBuilderResult();
  if (!process.argv.includes("--live")) {
    console.log("No promo page was requested. Pass --live to follow a sample amazon.com/promocode URL.");
    if (failed) process.exitCode = 1;
    return;
  }
  console.log(`Requesting ${SAMPLE_PROMO_URL}`);
  try {
    const trace = await tracePromoTag(SAMPLE_PROMO_URL, (url, options) => globalThis.fetch(url, {
      ...options,
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
    }));
    for (const hop of trace.hops) {
      console.log(`${hop.status} ${hop.url}`);
      if (hop.location) console.log(`  location: ${hop.location}`);
    }
    if (trace.keptTag) console.log(`Final URL kept tag=${ASSOCIATE_TAG}.`);
    else console.log(`Final URL did not keep tag=${ASSOCIATE_TAG}. finalTag=${trace.finalTag ?? "(none)"}`);
    console.log(`final: ${trace.finalUrl}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Promo link check failed.");
    process.exitCode = 1;
  }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
