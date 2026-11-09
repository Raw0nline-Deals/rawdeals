/**
 * The only place the Amazon Associates tag is applied.
 * Deal cards, the storefront link, and any other element with
 * data-affiliate go through withAffiliateTag().
 */
export const ASSOCIATE_TAG = "onamzeddie0c-20";

function isUsAmazonHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "a.co" || host === "amzn.to" || host.endsWith(".amzn.to")) return true;
  if (host === "amazon.com" || host.endsWith(".amazon.com")) return true;
  return false;
}

/**
 * Return an Amazon URL carrying the Associates tag.
 * Replaces any existing tag. Leaves non-US and non-Amazon links unchanged.
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
  url.searchParams.set("tag", ASSOCIATE_TAG);
  return url.toString();
}
