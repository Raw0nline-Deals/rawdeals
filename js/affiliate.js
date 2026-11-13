/**
 * The only place the Amazon Associates tag string is defined.
 * This is the regular Store ID for traffic this site sends to Amazon.
 * Deal cards, the storefront link, and any other element with
 * data-affiliate go through withAffiliateTag().
 * The Prime, Audible, and Prime Video hrefs in index.html repeat this value.
 */
export const ASSOCIATE_TAG = "eddie060-20";

function isUsAmazonHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "a.co" || host === "amzn.to" || host.endsWith(".amzn.to")) return true;
  if (host === "amazon.com" || host.endsWith(".amazon.com")) return true;
  return false;
}

/**
 * Return an Amazon URL carrying the Associates tag.
 * Replaces any other tag. A URL that already has this tag is returned unchanged
 * so a Creators API detailPageURL is not rewritten. Leaves non-US and
 * non-Amazon links unchanged.
 * @param {string} rawUrl
 * @returns {string}
 */
export function withAffiliateTag(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  if (!isUsAmazonHost(url.hostname)) return rawUrl;
  if (url.searchParams.get("tag") === ASSOCIATE_TAG) return rawUrl;
  url.searchParams.set("tag", ASSOCIATE_TAG);
  return url.toString();
}
