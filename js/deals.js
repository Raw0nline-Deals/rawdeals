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

/**
 * How many calendar days of deals to keep, including today.
 * Today plus the 6 days before it. The page, the refresh, and the feed
 * all read this one constant.
 */
export const DEAL_RETENTION_DAYS = 7;

export function retentionStart(today, days = DEAL_RETENTION_DAYS) {
  return addDays(today, 1 - days);
}

export function isWithinRetention(deal, today, days = DEAL_RETENTION_DAYS) {
  const added = deal?.added;
  if (typeof added !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(added)) return false;
  if (typeof today !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return false;
  return added >= retentionStart(today, days) && added <= today;
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
 * Why a deal is not active, or null when it still is.
 * Verified-dead matches the flag the dead-deal check writes onto a card.
 * A promo code or an auto-applied checkout discount keeps an API deal active
 * when the list price is not marked down.
 */
export function inactiveReason(deal, today) {
  if (!deal || typeof deal !== "object") return "not a deal";
  if (isExpired(deal, today)) return "deal ended";
  if (deal.verifiedDead === true) return "verified dead";
  if (deal.inStock === false) return "out of stock";
  if (deal.source === "api") {
    const discounted = typeof deal.percentOff === "number" && deal.percentOff > 0;
    if (!discounted && !deal.promoCode && deal.checkoutDiscount !== true) return "no longer discounted";
  }
  return null;
}

/**
 * A deal that has not expired, was not verified dead, is not marked out of stock,
 * and still has a discount, a promo code, or an auto-applied checkout discount
 * when it came from the API.
 */
export function isActiveDeal(deal, today) {
  return inactiveReason(deal, today) == null;
}

export function activeDeals(deals, today) {
  return deals.filter((deal) => isActiveDeal(deal, today));
}

/**
 * Cards a visitor sees. Example cards, baby products, and deals older than
 * DEAL_RETENTION_DAYS are hidden. The RSS feed is narrower still: it publishes
 * only the deals in this set whose added date is today.
 */
export function isVisibleDeal(deal, today) {
  return isActiveDeal(deal, today)
    && isWithinRetention(deal, today)
    && deal.sample !== true
    && !isBabyOrInfantTitle(deal?.title);
}

export function visibleDeals(deals, today) {
  return deals.filter((deal) => isVisibleDeal(deal, today));
}

/** Button text for an auto-applied AmazonOfferCode deal. There is no code to copy. */
export const CHECKOUT_DISCOUNT_LABEL = "discount applied at checkout";

export function dealLinkLabel(deal) {
  if (!deal?.promoCode && deal?.checkoutDiscount === true) return CHECKOUT_DISCOUNT_LABEL;
  return "View on Amazon";
}

export function dealHref(deal) {
  if (deal?.preserveAffiliateTag === true) return deal.url;
  return withAffiliateTag(deal.url);
}

export function filterDeals(deals, { category = "All", query = "" } = {}) {
  const needle = query.trim().toLowerCase();
  return deals.filter((deal) => {
    if (category !== "All" && deal.category !== category) return false;
    if (!needle) return true;
    const haystack = [deal.title, deal.category, deal.promoCode || "", deal.checkoutDiscount ? "checkout" : ""]
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
    .map(([date, items]) => ({ date, deals: preferMensAndWomensClothing(items) }));
}

/**
 * Day sections for the page. Today is expanded. Each earlier day in the
 * retention window is present and collapsed. Days outside the window are omitted.
 */
export function dayGroups(deals, today) {
  return groupDeals(deals)
    .filter((group) => isWithinRetention({ added: group.date }, today))
    .map((group) => ({
      date: group.date,
      deals: group.deals,
      expanded: group.date === today,
      collapsible: group.date !== today,
    }));
}

export function categoriesIn(deals) {
  const present = new Set(deals.map((deal) => deal.category));
  const ordered = CATEGORY_ORDER.filter((category) => present.has(category));
  const rest = [...present].filter((category) => !CATEGORY_ORDER.includes(category) && category !== "General").sort();
  const general = present.has("General") ? ["General"] : [];
  return ["All", ...ordered, ...rest, ...general];
}

/** Color names that contain "baby" and are not infant products. */
export const BABY_COLOR_PHRASES = ["baby blue", "baby pink", "baby-blue", "baby-pink"];

/**
 * Infant and toddler products. "baby" is included only after the color names above
 * are removed, so a Baby Blue hoodie stays and a baby onesie does not.
 */
export const BABY_PRODUCT_PHRASES = [
  "burp cloth",
  "baby bib",
  "baby clothes",
  "baby clothing",
  "baby outfit",
  "baby shoe",
  "baby dress",
  "bodysuit",
  "onesie",
  "romper",
  "swaddle",
  "newborn",
  "infant",
  "toddler",
  "diaper",
  "pacifier",
  "bib",
  "babies",
  "baby",
];

/** Men's and women's apparel, ranked above other clothing such as shoes. */
export const MENS_WOMENS_PHRASES = [
  "men's",
  "mens",
  "men",
  "women's",
  "womens",
  "women",
  "ladies",
  "lady",
  "hoodie",
  "shirt",
  "t-shirt",
  "tee",
  "shorts",
  "jeans",
  "jacket",
  "sweater",
  "sweatshirt",
  "sweatpants",
  "dress",
  "blouse",
  "skirt",
  "pants",
  "leggings",
  "joggers",
];

export const PRIORITY_WATCHES = [
  {
    id: "permanent-outdoor-lights",
    category: "Home",
    phrases: [
      "permanent outdoor light",
      "permanent light",
      "eave light",
      "roofline",
    ],
  },
  {
    id: "gaming-microphone",
    category: "Gaming",
    phrases: ["gaming microphone", "gaming mic", "streamer microphone", "streaming microphone"],
  },
  {
    id: "gaming-headset",
    category: "Gaming",
    phrases: ["gaming headset", "gaming headphones"],
  },
];

export function isBabyOrInfantTitle(title) {
  const text = titleWithoutBabyColors(title);
  return BABY_PRODUCT_PHRASES.some((phrase) => hasWord(text, phrase));
}

export function apparelRank(deal) {
  if (deal?.category !== "Clothing") return 0;
  return MENS_WOMENS_PHRASES.some((phrase) => hasWord(deal.title || "", phrase)) ? 1 : 0;
}

export function priorityWatch(title) {
  const text = String(title || "");
  for (const watch of PRIORITY_WATCHES) {
    if (watch.phrases.some((phrase) => hasWord(text, phrase))) return watch;
  }
  if (hasWord(text, "govee") && /light|outdoor|eave|permanent/i.test(text)) return PRIORITY_WATCHES[0];
  return null;
}

export function preferMensAndWomensClothing(deals) {
  const ranked = deals
    .map((deal, index) => ({ deal, index }))
    .filter(({ deal }) => deal.category === "Clothing")
    .sort((a, b) => apparelRank(b.deal) - apparelRank(a.deal) || a.index - b.index);
  let cursor = 0;
  return deals.map((deal) => (deal.category === "Clothing" ? ranked[cursor++].deal : deal));
}

function titleWithoutBabyColors(title) {
  let text = String(title || "");
  for (const phrase of BABY_COLOR_PHRASES) {
    const pattern = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(pattern, "ig"), " ");
  }
  return text;
}

function hasWord(text, phrase) {
  const hay = String(text).toLowerCase();
  const needle = phrase.toLowerCase();
  let from = 0;
  while (from <= hay.length - needle.length) {
    const at = hay.indexOf(needle, from);
    if (at === -1) return false;
    const beforeOk = at === 0 || !/[a-z0-9]/i.test(hay[at - 1]);
    const after = hay[at + needle.length] || "";
    const afterOk = !after || !/[a-z0-9]/i.test(after) || after === "s";
    if (beforeOk && afterOk) return true;
    from = at + 1;
  }
  return false;
}

export function dealsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.deals)) return payload.deals;
  throw new Error("deals.json must be an array or an object with a deals array");
}
