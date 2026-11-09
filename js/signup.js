/** Beehiiv magic link. The page only navigates here; it does not store the address. */
export const BEEHIIV_MAGIC_LINK = "https://magic.beehiiv.com/v1/085d2554-2a2b-4438-9442-7f3b58ba41f3";

/**
 * @param {string} email
 * @returns {string}
 */
export function beehiivSignupUrl(email) {
  const trimmed = String(email).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    throw new Error("Enter a valid email address");
  }
  return `${BEEHIIV_MAGIC_LINK}?email=${encodeURIComponent(trimmed)}`;
}
