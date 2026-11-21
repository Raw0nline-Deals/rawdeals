import { withAffiliateTag } from "./affiliate.js";
import { isExpired, shortDate } from "./deals.js";

/**
 * Hand-edited promo codes in data/codes.json.
 * The daily refresh does not read or write that file.
 * `expires` is inclusive through the end of that America/Chicago calendar day.
 * `starts`, when set, is the first Chicago day the code may appear.
 */

export const CODE_FIELDS = [
  "id",
  "brand",
  "title",
  "description",
  "code",
  "url",
  "discount",
  "expires",
  "starts",
  "notes",
];

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function isIsoDate(value) {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

export function codeTitle(entry) {
  return clean(entry?.title) || clean(entry?.description);
}

export function codeDescription(entry) {
  const title = clean(entry?.title);
  const description = clean(entry?.description);
  if (title && description && description !== title) return description;
  return "";
}

function isHttps(value) {
  const raw = clean(value);
  if (!/^https:\/\//i.test(raw)) return false;
  try {
    return new URL(raw).protocol === "https:";
  } catch {
    return false;
  }
}

export function isWellFormedCode(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  if (!clean(entry.id) || !clean(entry.brand) || !clean(entry.code) || !clean(entry.discount)) return false;
  if (!codeTitle(entry)) return false;
  if (!isIsoDate(entry.expires)) return false;
  if (entry.starts != null && entry.starts !== "" && !isIsoDate(entry.starts)) return false;
  if (isIsoDate(entry.starts) && entry.starts > entry.expires) return false;
  if (entry.url != null && entry.url !== "" && !isHttps(entry.url)) return false;
  if (entry.notes != null && entry.notes !== "" && !clean(entry.notes)) return false;
  if (entry.title != null && entry.title !== "" && !clean(entry.title)) return false;
  if (entry.description != null && entry.description !== "" && !clean(entry.description)) return false;
  return true;
}

/**
 * Active on the Chicago calendar date `today` (YYYY-MM-DD).
 * A code with expires equal to today is still shown. A future starts date is not.
 */
export function isCodeActive(entry, today) {
  if (!isWellFormedCode(entry)) return false;
  if (!isIsoDate(today)) return false;
  if (isIsoDate(entry.starts) && entry.starts > today) return false;
  if (isExpired(entry, today)) return false;
  return true;
}

export function codesFromPayload(payload) {
  if (!Array.isArray(payload)) return [];
  return payload.filter(isWellFormedCode);
}

export function activeCodes(entries, today) {
  if (!Array.isArray(entries)) return [];
  return entries.filter((entry) => isCodeActive(entry, today));
}

export function codeHref(entry) {
  const raw = clean(entry?.url);
  if (!isHttps(raw)) return "";
  return withAffiliateTag(raw);
}

export function codeLinkLabel(rawUrl) {
  let host = "";
  try {
    host = new URL(clean(rawUrl)).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "Open offer";
  }
  if (
    host === "amazon.com"
    || host.endsWith(".amazon.com")
    || host === "a.co"
    || host === "amzn.to"
    || host.endsWith(".amzn.to")
  ) {
    return "View on Amazon";
  }
  return "Open offer";
}

export function presentCode(entry) {
  if (!isWellFormedCode(entry)) return null;
  const href = codeHref(entry);
  return {
    id: clean(entry.id),
    brand: clean(entry.brand),
    title: codeTitle(entry),
    description: codeDescription(entry),
    discount: clean(entry.discount),
    code: clean(entry.code),
    expires: entry.expires,
    expiresLabel: `Ends ${shortDate(entry.expires)}`,
    notes: clean(entry.notes),
    href,
    linkLabel: href ? codeLinkLabel(entry.url) : "",
  };
}

export function validateCodes(payload) {
  const errors = [];
  if (!Array.isArray(payload)) return ["codes.json must be a JSON array"];
  const ids = new Set();
  payload.forEach((entry, index) => {
    const where = `codes[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${where} must be an object`);
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!CODE_FIELDS.includes(key)) errors.push(`${where} has unknown field "${key}"`);
    }
    if (!clean(entry.id)) errors.push(`${where}.id is required`);
    else if (ids.has(clean(entry.id))) errors.push(`${where}.id "${clean(entry.id)}" is duplicated`);
    else ids.add(clean(entry.id));

    if (!clean(entry.brand)) errors.push(`${where}.brand is required`);
    if (!codeTitle(entry)) errors.push(`${where} needs a title or a description`);
    if (entry.title != null && !clean(entry.title)) errors.push(`${where}.title must be a non-empty string when present`);
    if (entry.description != null && !clean(entry.description)) {
      errors.push(`${where}.description must be a non-empty string when present`);
    }
    if (!clean(entry.code)) errors.push(`${where}.code is required`);
    if (!clean(entry.discount)) errors.push(`${where}.discount is required`);
    if (!isIsoDate(entry.expires)) errors.push(`${where}.expires must be YYYY-MM-DD`);
    if (entry.starts != null && !isIsoDate(entry.starts)) errors.push(`${where}.starts must be YYYY-MM-DD when present`);
    if (isIsoDate(entry.starts) && isIsoDate(entry.expires) && entry.starts > entry.expires) {
      errors.push(`${where}.starts is after expires`);
    }
    if (entry.url != null && !isHttps(entry.url)) errors.push(`${where}.url must be an https link when present`);
    if (entry.notes != null && !clean(entry.notes)) errors.push(`${where}.notes must be a non-empty string when present`);
  });
  return errors;
}
