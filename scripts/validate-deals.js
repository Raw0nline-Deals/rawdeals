import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validatePayload(payload, { fileExists }) {
  const errors = [];
  const deals = Array.isArray(payload) ? payload : payload?.deals;
  if (!Array.isArray(deals)) {
    return ["deals.json must be an array, or an object with a deals array"];
  }

  const ids = new Set();
  deals.forEach((deal, index) => {
    const where = `deals[${index}]`;
    if (!deal || typeof deal !== "object") {
      errors.push(`${where} must be an object`);
      return;
    }
    if (typeof deal.id !== "string" || !deal.id) errors.push(`${where}.id is required`);
    else if (ids.has(deal.id)) errors.push(`${where}.id "${deal.id}" is duplicated`);
    else ids.add(deal.id);

    if (typeof deal.title !== "string" || !deal.title.trim()) errors.push(`${where}.title is required`);
    if (typeof deal.sample !== "boolean") errors.push(`${where}.sample must be true or false`);
    if (deal.sample === true && !String(deal.title || "").includes("EXAMPLE")) {
      errors.push(`${where}.title must include EXAMPLE while sample is true`);
    }
    if (deal.sample === false && String(deal.title || "").includes("EXAMPLE")) {
      errors.push(`${where}.title should not say EXAMPLE once sample is false`);
    }

    if (typeof deal.image !== "string" || !deal.image) errors.push(`${where}.image is required`);
    else if (!isImageAvailable(deal.image, fileExists)) errors.push(`${where}.image does not exist: ${deal.image}`);

    if (!isMoney(deal.price)) errors.push(`${where}.price must be a number of 0 or more`);
    if (deal.originalPrice != null && !isMoney(deal.originalPrice)) {
      errors.push(`${where}.originalPrice must be a number when present`);
    }
    if (typeof deal.originalPrice === "number" && typeof deal.price === "number" && deal.originalPrice <= deal.price) {
      errors.push(`${where}.originalPrice must be greater than price`);
    }
    if (typeof deal.percentOff !== "number" || deal.percentOff < 0 || deal.percentOff > 100) {
      errors.push(`${where}.percentOff must be a number from 0 to 100`);
    }
    if (typeof deal.originalPrice === "number" && typeof deal.price === "number" && deal.originalPrice > 0) {
      const expected = Math.round((1 - deal.price / deal.originalPrice) * 100);
      if (Math.abs(expected - deal.percentOff) > 1) {
        errors.push(`${where}.percentOff is ${deal.percentOff}, expected about ${expected}`);
      }
    }
    if (deal.originalPrice == null && deal.percentOff !== 0) {
      errors.push(`${where}.percentOff must be 0 when originalPrice is omitted`);
    }

    if (deal.promoCode != null && (typeof deal.promoCode !== "string" || !deal.promoCode.trim())) {
      errors.push(`${where}.promoCode must be a non-empty string when present`);
    }
    if (typeof deal.category !== "string" || !deal.category.trim()) errors.push(`${where}.category is required`);

    if (typeof deal.url !== "string" || !deal.url.startsWith("https://")) {
      errors.push(`${where}.url must be an https link`);
    } else {
      try {
        const host = new URL(deal.url).hostname;
        if (!(host === "amazon.com" || host.endsWith(".amazon.com"))) {
          errors.push(`${where}.url must be an amazon.com link`);
        }
      } catch {
        errors.push(`${where}.url is not a valid URL`);
      }
    }

    if (!isDate(deal.added)) errors.push(`${where}.added must be YYYY-MM-DD`);
    if (deal.expires != null && !isDate(deal.expires)) errors.push(`${where}.expires must be YYYY-MM-DD`);
    if (isDate(deal.added) && isDate(deal.expires) && deal.expires < deal.added) {
      errors.push(`${where}.expires is before added`);
    }
  });

  return errors;
}

function isMoney(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isDate(value) {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

function isImageAvailable(src, fileExists) {
  if (/^https?:\/\//i.test(src)) return true;
  return fileExists(src.replace(/^\//, ""));
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const payload = JSON.parse(readFileSync(join(root, "data", "deals.json"), "utf8"));
  const errors = validatePayload(payload, {
    fileExists: (relativePath) => existsSync(join(root, relativePath)),
  });
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exit(1);
  }
  const count = Array.isArray(payload) ? payload.length : payload.deals.length;
  console.log(`deals.json ok (${count} deals)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
