/**
 * Post new RawDeals to a Discord webhook as short plain-text messages.
 *
 * The webhook URL is DISCORD_WEBHOOK_URL. It is never printed. An empty or
 * missing value skips posting and exits successfully.
 *
 * A deal is new when its id was not in the previous deals file. Existing
 * deals are not posted again. At most MAX_DISCORD_DEALS go out in one run.
 *
 *   node scripts/post-discord.js --previous /tmp/deals-before.json --current data/deals.json
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dealHref, isVisibleDeal, shortDate, todayISO } from "../js/deals.js";
import { redactSecrets } from "./fetch-deals.js";

export const MAX_DISCORD_DEALS = 25;
export const DISCORD_CONTENT_LIMIT = 2000;
export const DISCORD_TITLE_LIMIT = 60;
export const DISCORD_FEATURE_LIMIT = 90;
/** Discord message flag SUPPRESS_EMBEDS. Link previews stay off. */
export const DISCORD_SUPPRESS_EMBEDS = 4;
export const DISCORD_USERNAME = "RawDeals";
export const DISCORD_FOOTER = "More at <https://getrawdeals.com>";
export const DISCORD_PAUSE_MS = 500;
export const DISCORD_MAX_RETRIES = 3;
const RETRY_AFTER_CAP_MS = 120000;

/**
 * Creators API and AmazonOfferCode deals keep the URL already stored.
 * Hand-written deals go through the same tag helper the page uses.
 */
export function discordDealUrl(deal) {
  if (deal?.source === "api") return typeof deal.url === "string" ? deal.url : "";
  return dealHref(deal);
}

export function shortenText(text, max) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (max < 1) return "";
  if (clean.length <= max) return clean;
  const room = Math.max(1, max - 1);
  let cut = clean.slice(0, room);
  const space = cut.lastIndexOf(" ");
  if (space >= Math.min(room, Math.ceil(max * 0.6))) cut = cut.slice(0, space);
  cut = cut.trimEnd();
  if (!cut) cut = clean.slice(0, room).trimEnd();
  return `${cut}…`;
}

export function formatDiscordPrice(amount) {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return "";
  const cents = Math.round(amount * 100);
  if (!Number.isFinite(cents) || cents < 0) return "";
  if (cents % 100 === 0) return `$${cents / 100}`;
  return `$${(cents / 100).toFixed(2)}`;
}

function phraseFromBullet(text, max) {
  const clean = String(text).replace(/\s+/g, " ").trim();
  const match = clean.match(/^(.+?[.!?])(?:\s|$)/);
  if (match && match[1].length <= max) return match[1];
  return clean;
}

/**
 * One short phrase from the first stored feature bullet, or from description.
 * Empty when neither was stored. The product title is not reused here.
 */
export function featurePhrase(deal, max = DISCORD_FEATURE_LIMIT) {
  const bullets = Array.isArray(deal?.features) ? deal.features : [];
  const first = bullets.find((entry) => typeof entry === "string" && entry.trim());
  const source = first || (typeof deal?.description === "string" ? deal.description : "");
  if (!String(source).trim()) return "";
  return shortenText(phraseFromBullet(source, max), max);
}

function linkLabel(title) {
  const label = shortenText(title, DISCORD_TITLE_LIMIT).replace(/[\[\]]/g, "").trim();
  return label || "Amazon deal";
}

export function formatDealBlock(deal) {
  const url = discordDealUrl(deal);
  if (!url) return "";
  const bits = [];
  const percent = Number(deal?.percentOff);
  if (Number.isFinite(percent) && percent > 0) bits.push(`${Math.round(percent)}% off`);
  const price = formatDiscordPrice(deal?.price);
  const was = formatDiscordPrice(deal?.originalPrice);
  if (price) {
    const showWas = was
      && typeof deal.originalPrice === "number"
      && typeof deal.price === "number"
      && deal.originalPrice > deal.price;
    bits.push(showWas ? `${price} (was ${was})` : price);
  }
  if (typeof deal?.promoCode === "string" && deal.promoCode.trim()) {
    bits.push(`code ${deal.promoCode.replace(/\s+/g, " ").trim()}`);
  }
  const label = linkLabel(deal?.title);
  const line = bits.length
    ? `**[${label}](<${url}>)** — ${bits.join(" • ")}`
    : `**[${label}](<${url}>)**`;
  const feature = featurePhrase(deal);
  return feature ? `${line}\n${feature}` : line;
}

export function dailyHeader(today = todayISO()) {
  return `🔥 Raw's Daily Deals — ${shortDate(today)}`;
}

/**
 * Ids that are in current and were not in previous. Samples and deals the
 * site would hide are left out. File order is kept. The list stops at limit.
 */
export function selectNewDeals(previousDeals, currentDeals, { today, limit = MAX_DISCORD_DEALS } = {}) {
  const previousIds = new Set();
  for (const deal of previousDeals || []) {
    if (deal && typeof deal.id === "string" && deal.id) previousIds.add(deal.id);
  }
  const cap = Number.isInteger(limit) && limit > 0 ? limit : MAX_DISCORD_DEALS;
  const picked = [];
  for (const deal of currentDeals || []) {
    if (!deal || typeof deal !== "object") continue;
    if (typeof deal.id !== "string" || !deal.id || previousIds.has(deal.id)) continue;
    if (deal.sample === true) continue;
    if (today && !isVisibleDeal(deal, today)) continue;
    if (typeof deal.title !== "string" || !deal.title.trim()) continue;
    if (typeof deal.url !== "string" || !deal.url.startsWith("https://")) continue;
    picked.push(deal);
    if (picked.length >= cap) break;
  }
  return picked;
}

export function batchDealMessages(deals, { today = todayISO(), limit = DISCORD_CONTENT_LIMIT } = {}) {
  const blocks = (deals || []).map((deal) => formatDealBlock(deal)).filter(Boolean);
  if (!blocks.length) return [];
  const header = dailyHeader(today);
  const messages = [];
  let current = header;

  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current) messages.push(current);
    current = block.length <= limit ? block : `${block.slice(0, Math.max(0, limit - 1))}…`;
  }
  if (current) messages.push(current);

  const last = messages[messages.length - 1];
  const withFooter = `${last}\n\n${DISCORD_FOOTER}`;
  if (withFooter.length <= limit) messages[messages.length - 1] = withFooter;
  else if (DISCORD_FOOTER.length <= limit) messages.push(DISCORD_FOOTER);
  return messages;
}

function retryAfterMs(retryAfter) {
  const parsed = typeof retryAfter === "number" ? retryAfter : Number(retryAfter);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.min(RETRY_AFTER_CAP_MS, Math.ceil(parsed * 1000));
}

async function discordRetryMs(response) {
  let fromBody = null;
  try {
    const body = await response.json();
    fromBody = retryAfterMs(body?.retry_after);
  } catch {
    fromBody = null;
  }
  if (fromBody != null) return fromBody;
  const header = response.headers?.get?.("retry-after") ?? response.headers?.get?.("x-ratelimit-reset-after");
  return retryAfterMs(header) ?? 1000;
}

function webhookPayload(content) {
  return {
    username: DISCORD_USERNAME,
    flags: DISCORD_SUPPRESS_EMBEDS,
    allowed_mentions: { parse: [] },
    content,
  };
}

async function postOne(content, { webhookUrl, fetchImpl, sleep, maxRetries }) {
  if (content.length > DISCORD_CONTENT_LIMIT) {
    throw new Error(`Discord message is ${content.length} characters, over the ${DISCORD_CONTENT_LIMIT} limit.`);
  }
  let lastStatus = 0;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(webhookPayload(content)),
      });
    } catch (error) {
      const message = redactSecrets(error instanceof Error ? error.message : "Discord post failed.", [webhookUrl]);
      throw new Error(message || "Discord post failed.");
    }
    if (response.status === 429 && attempt < maxRetries) {
      await sleep(await discordRetryMs(response));
      continue;
    }
    if (response.ok) return;
    lastStatus = response.status || 0;
    break;
  }
  throw new Error(`Discord webhook failed (${lastStatus || 429}).`);
}

/**
 * Send messages to the webhook. A missing URL does not throw and does not fetch.
 * 429 responses wait for retry_after, then try again. Messages are spaced apart.
 */
export async function postDiscordMessages(messages, {
  webhookUrl,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pauseMs = DISCORD_PAUSE_MS,
  maxRetries = DISCORD_MAX_RETRIES,
} = {}) {
  const url = typeof webhookUrl === "string" ? webhookUrl.trim() : "";
  if (!url) return { skipped: true, reason: "missing webhook", posted: 0 };
  const queue = Array.isArray(messages) ? messages.filter((message) => typeof message === "string" && message.trim()) : [];
  if (!queue.length) return { skipped: true, reason: "no new deals", posted: 0 };

  for (let index = 0; index < queue.length; index += 1) {
    if (index > 0 && pauseMs > 0) await sleep(pauseMs);
    await postOne(queue[index], { webhookUrl: url, fetchImpl, sleep, maxRetries });
  }
  return { skipped: false, reason: "posted", posted: queue.length };
}

function option(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) return "";
  return value;
}

function readDeals(file) {
  let payload;
  try {
    payload = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") throw new Error(`Could not read ${file}.`);
    throw new Error(`${file} is not valid JSON.`);
  }
  const deals = Array.isArray(payload) ? payload : payload?.deals;
  if (!Array.isArray(deals)) throw new Error(`${file} must be an array or an object with a deals array.`);
  return deals;
}

async function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const previousPath = option("--previous");
  const currentPath = option("--current") || join(root, "data", "deals.json");
  const today = option("--today") || todayISO();
  if (!previousPath) {
    console.error("Discord: pass --previous with the deals file from before this run.");
    process.exitCode = 1;
    return;
  }
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  try {
    const fresh = selectNewDeals(readDeals(previousPath), readDeals(currentPath), { today });
    const messages = batchDealMessages(fresh, { today });
    const result = await postDiscordMessages(messages, { webhookUrl });
    if (result.skipped) {
      console.log(`Discord: skipped (${result.reason}).`);
      return;
    }
    console.log(`Discord: posted ${result.posted} ${result.posted === 1 ? "message" : "messages"} for ${fresh.length} new ${fresh.length === 1 ? "deal" : "deals"}.`);
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : "Discord post failed.", [webhookUrl]);
    console.error(message || "Discord post failed.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
