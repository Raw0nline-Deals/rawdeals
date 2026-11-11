/**
 * Display categories for RawDeals.
 *
 * The list at the top is what discovery searches for and what the filter chips prefer.
 * To support another label for hand-picked ASINs that do not set a category, add a row
 * to CATEGORY_RULES. A category typed in data/asins.json or on a discovery search is used
 * as written, so a new chip does not require a rule.
 */

export const DISPLAY_CATEGORIES = [
  "Tech",
  "Home",
  "Pets",
  "Clothing",
  "Fragrances",
  "Drinks",
  "Food",
  "Kitchen",
  "Gaming",
  "Household",
  "Sports",
  "Toys",
];

export const CATEGORY_ORDER = [
  ...DISPLAY_CATEGORIES,
  "Electronics",
  "Outdoors",
  "Fitness",
];

const CATEGORY_RULES = [
  ["Fragrances", ["fragrance", "perfume", "cologne", "eau de toilette"]],
  ["Drinks", ["beverage", "coffee", "tea", "drink", "soda"]],
  ["Food", ["grocery", "gourmet", "snack", "pantry", "food"]],
  ["Kitchen", ["kitchen", "cookware", "bakeware", "cutlery", "dinnerware"]],
  ["Gaming", ["video game", "gaming", "playstation", "xbox", "nintendo"]],
  ["Household", ["household", "cleaning", "paper towel", "laundry", "detergent", "trash bag"]],
  ["Pets", ["pet", "dog food", "cat food"]],
  ["Clothing", ["clothing", "apparel", "shoe", "fashion"]],
  ["Sports", ["sport", "outdoor", "camping", "fitness", "exercise", "yoga", "patio", "lawn", "garden"]],
  ["Tech", ["electronic", "computer", "wireless", "phone", "headphone", "camera", "television", "tv", "software", "tablet", "laptop"]],
  ["Toys", ["toy"]],
  ["Home", ["home", "furniture", "bedding", "bath", "lighting", "decor", "storage"]],
];

export function matchCategory(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  for (const [category, phrases] of CATEGORY_RULES) {
    if (phrases.some((phrase) => hasPhrase(text, phrase))) return category;
  }
  return null;
}

function hasPhrase(text, phrase) {
  const hay = text.toLowerCase();
  const needle = phrase.toLowerCase();
  let from = 0;
  while (from <= hay.length - needle.length) {
    const at = hay.indexOf(needle, from);
    if (at === -1) return false;
    const beforeOk = at === 0 || !isWordChar(hay[at - 1]);
    const after = hay[at + needle.length] || "";
    const afterOk = !after || !isWordChar(after) || after === "s";
    if (beforeOk && afterOk) return true;
    from = at + 1;
  }
  return false;
}

function isWordChar(character) {
  return /[a-z0-9]/i.test(character);
}

function textOf(value) {
  if (typeof value === "string") return value;
  if (value && typeof value.displayValue === "string") return value.displayValue;
  return "";
}

const SPECIFICITY = [
  "Fragrances",
  "Drinks",
  "Gaming",
  "Household",
  "Pets",
  "Kitchen",
  "Toys",
  "Clothing",
  "Sports",
  "Tech",
  "Food",
  "Home",
];

function nodeNames(node) {
  const names = [];
  let current = node;
  let depth = 0;
  while (current && depth < 8) {
    if (!current.isRoot) {
      if (typeof current.contextFreeName === "string") names.push(current.contextFreeName);
      if (typeof current.displayName === "string" && current.displayName !== current.contextFreeName) {
        names.push(current.displayName);
      }
    }
    current = current.ancestor;
    depth += 1;
  }
  return names;
}

function categorySignals(item) {
  const texts = [];
  const group = textOf(item?.itemInfo?.classifications?.productGroup);
  const binding = textOf(item?.itemInfo?.classifications?.binding);
  if (group) texts.push(group);
  if (binding) texts.push(binding);
  const nodes = item?.browseNodeInfo?.browseNodes;
  if (Array.isArray(nodes)) {
    for (const node of nodes) {
      for (const name of nodeNames(node)) {
        if (hasPhrase(name, "home") && hasPhrase(name, "kitchen")) continue;
        texts.push(name);
      }
    }
  }
  return texts;
}

/**
 * Map a Creators API item to a display category.
 * A narrower name wins when several match. Grocery plus a coffee node is Drinks.
 * "Home & Kitchen" alone is too broad to decide. Returns null when nothing matches.
 */
export function displayCategoryFromItem(item) {
  const matches = categorySignals(item).map((text) => matchCategory(text)).filter(Boolean);
  if (matches.length === 0) return null;
  const rank = new Map(SPECIFICITY.map((category, index) => [category, index]));
  matches.sort((a, b) => (rank.get(a) ?? 99) - (rank.get(b) ?? 99));
  return matches[0];
}
