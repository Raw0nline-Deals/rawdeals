import { withAffiliateTag } from "./affiliate.js";
import { CATEGORY_ORDER } from "./categories.js";

export { CATEGORY_ORDER };

export const TIME_ZONE = "America/Chicago";

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

export function todayISO(now = new Date(), timeZone = TIME_ZONE) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function addDays(iso, days) {
  const [year, month, day] = iso.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  utc.setUTCDate(utc.getUTCDate() + days);
  return utc.toISOString().slice(0, 10);
}

export function dayHeading(iso, today) {
  if (iso === today) return "Today";
  if (iso === addDays(today, -1)) return "Yesterday";
  const [year, month, day] = iso.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  const weekday = utc.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  const monthName = utc.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  return `${weekday}, ${monthName} ${day}`;
}

export function longDate(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function shortDate(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function formatMoney(amount) {
  return money.format(amount);
}

export function isExpired(deal, today) {
  return Boolean(deal?.expires) && deal.expires < today;
}

/**
 * A deal that has not expired, is not marked out of stock, and still has a discount
 * or a promo code when it came from the API.
 */
export function isActiveDeal(deal, today) {
  if (!deal || typeof deal !== "object") return false;
  if (isExpired(deal, today)) return false;
  if (deal.inStock === false) return false;
  if (deal.source === "api") {
    const discounted = typeof deal.percentOff === "number" && deal.percentOff > 0;
    if (!discounted && !deal.promoCode) return false;
  }
  return true;
}

export function activeDeals(deals, today) {
  return deals.filter((deal) => isActiveDeal(deal, today));
}

/**
 * Cards a visitor sees, and the deals the RSS feed publishes.
 * Example cards are hidden here so the page and the email cannot drift.
 */
export function isVisibleDeal(deal, today) {
  return isActiveDeal(deal, today) && deal.sample !== true;
}

export function visibleDeals(deals, today) {
  return deals.filter((deal) => isVisibleDeal(deal, today));
}

export function dealHref(deal) {
  return withAffiliateTag(deal.url);
}

export function filterDeals(deals, { category = "All", query = "" } = {}) {
  const needle = query.trim().toLowerCase();
  return deals.filter((deal) => {
    if (category !== "All" && deal.category !== category) return false;
    if (!needle) return true;
    const haystack = [deal.title, deal.category, deal.promoCode || ""]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });
}

export function groupDeals(deals) {
  const groups = new Map();
  for (const deal of deals) {
    if (!groups.has(deal.added)) groups.set(deal.added, []);
    groups.get(deal.added).push(deal);
  }
  return [...groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .map(([date, items]) => ({ date, deals: items }));
}

export function categoriesIn(deals) {
  const present = new Set(deals.map((deal) => deal.category));
  const ordered = CATEGORY_ORDER.filter((category) => present.has(category));
  const rest = [...present].filter((category) => !CATEGORY_ORDER.includes(category)).sort();
  return ["All", ...ordered, ...rest];
}

export function dealsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.deals)) return payload.deals;
  throw new Error("deals.json must be an array or an object with a deals array");
}
