/**
 * Write feed.xml from data/deals.json.
 *
 * Items are visible deals whose added date is today in America/Chicago.
 * Earlier days stay on the site for DEAL_RETENTION_DAYS and are not published
 * again as new feed items. A failed read does not replace an existing feed.
 */
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  dealHref,
  dealsFromPayload,
  formatMoney,
  groupDeals,
  todayISO,
  visibleDeals,
} from "../js/deals.js";

export const SITE_URL = "https://getrawdeals.com/";
export const FEED_URL = "https://getrawdeals.com/feed.xml";
export const FEED_TITLE = "RawDeals";
export const DISCLOSURE = "As an Amazon Associate I earn from qualifying purchases.";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function rfc822FromIsoDate(iso) {
  if (typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    throw new Error("A feed date must be YYYY-MM-DD.");
  }
  const [year, month, day] = iso.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  return `${WEEKDAYS[utc.getUTCDay()]}, ${String(day).padStart(2, "0")} ${MONTHS[month - 1]} ${year} 12:00:00 GMT`;
}

export function imageMime(url) {
  const path = String(url).split("?")[0].toLowerCase();
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".gif")) return "image/gif";
  if (path.endsWith(".svg")) return "image/svg+xml";
  return "image/jpeg";
}

export function absoluteAsset(url, siteUrl = SITE_URL) {
  if (typeof url !== "string" || !url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  return new URL(url.replace(/^\//, ""), siteUrl.endsWith("/") ? siteUrl : `${siteUrl}/`).toString();
}

export function dealDescription(deal) {
  const parts = [`Sale price: ${formatMoney(deal.price)}`];
  if (typeof deal.originalPrice === "number") parts.push(`Original price: ${formatMoney(deal.originalPrice)}`);
  parts.push(`${deal.percentOff}% off`);
  if (deal.promoCode) parts.push(`Promo code: ${deal.promoCode}`);
  else if (deal.checkoutDiscount) parts.push("Discount applied at checkout");
  if (deal.expires) parts.push(`Ends ${deal.expires}`);
  return `${parts.join(". ")}.`;
}

export function orderedVisibleDeals(deals, today) {
  return groupDeals(visibleDeals(deals, today)).flatMap((group) => group.deals);
}

/** Deals that belong in the RSS feed: visible, and first seen today. */
export function orderedFeedDeals(deals, today) {
  return orderedVisibleDeals(deals, today).filter((deal) => deal.added === today);
}

export function buildFeedXml(deals, { today = todayISO(), siteUrl = SITE_URL, feedUrl = FEED_URL } = {}) {
  const items = orderedFeedDeals(deals, today);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">',
    "  <channel>",
    `    <title>${escapeXml(FEED_TITLE)}</title>`,
    `    <link>${escapeXml(siteUrl)}</link>`,
    `    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml"/>`,
    `    <description>${escapeXml(`Daily Amazon deals from Raw0nline. ${DISCLOSURE}`)}</description>`,
    "    <language>en-us</language>",
    `    <lastBuildDate>${rfc822FromIsoDate(today)}</lastBuildDate>`,
  ];
  for (const deal of items) {
    const link = dealHref(deal);
    const image = absoluteAsset(deal.image, siteUrl);
    const mime = image ? imageMime(image) : "";
    lines.push("    <item>");
    lines.push(`      <title>${escapeXml(deal.title)}</title>`);
    lines.push(`      <link>${escapeXml(link)}</link>`);
    lines.push(`      <guid isPermaLink="false">${escapeXml(deal.id)}</guid>`);
    lines.push(`      <pubDate>${rfc822FromIsoDate(deal.added)}</pubDate>`);
    lines.push(`      <category>${escapeXml(deal.category)}</category>`);
    if (image) {
      lines.push(`      <enclosure url="${escapeXml(image)}" type="${mime}" length="0"/>`);
      lines.push(`      <media:content url="${escapeXml(image)}" medium="image" type="${mime}"/>`);
    }
    lines.push(`      <description>${escapeXml(dealDescription(deal))}</description>`);
    lines.push("    </item>");
  }
  lines.push("  </channel>", "</rss>", "");
  return lines.join("\n");
}

export function writeFeedFile(feedPath, xml) {
  const next = xml.endsWith("\n") ? xml : `${xml}\n`;
  let current = null;
  try {
    current = readFileSync(feedPath, "utf8");
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  if (current === next) return { changed: false };
  const temporary = `${feedPath}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, next);
    renameSync(temporary, feedPath);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* the previous feed.xml is still in place */ }
    throw error;
  }
  return { changed: true };
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const dealsPath = join(root, "data", "deals.json");
  const feedPath = join(root, "feed.xml");
  let deals;
  try {
    deals = dealsFromPayload(JSON.parse(readFileSync(dealsPath, "utf8")));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Could not read data/deals.json.");
    process.exitCode = 1;
    return;
  }
  try {
    const result = writeFeedFile(feedPath, buildFeedXml(deals));
    const count = orderedFeedDeals(deals, todayISO()).length;
    if (result.changed) console.log(`Updated feed.xml (${count} deals).`);
    else console.log(`feed.xml was already current (${count} deals).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Could not write feed.xml.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
