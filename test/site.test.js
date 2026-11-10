import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ASSOCIATE_TAG, withAffiliateTag } from "../js/affiliate.js";
import { beehiivSignupUrl } from "../js/signup.js";
import { createDeadDealStore, memoryStorage } from "../js/dead-deals.js";
import {
  dayHeading,
  dealHref,
  filterDeals,
  formatMoney,
  groupDeals,
  todayISO,
} from "../js/deals.js";
import {
  buildGetItemsBody,
  credentialStatus,
  mapCreatorsItemToDeal,
  mergeDeals,
  planText,
  tokenEndpoint,
} from "../scripts/fetch-deals.js";
import { validatePayload } from "../scripts/validate-deals.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

test("affiliate helper is the only runtime source of the Associates tag", () => {
  const runtime = ["js/app.js", "js/deals.js", "js/dead-deals.js", "data/deals.json"];
  for (const path of runtime) {
    assert.equal(read(path).includes(ASSOCIATE_TAG), false, path);
  }
  const allowed = [
    "https://www.amazon.com/prime?tag=onamzeddie0c-20",
    "https://www.amazon.com/hz/audible/arya/mlp?tag=onamzeddie0c-20",
    "https://www.amazon.com/gp/video/primesignup?tag=onamzeddie0c-20",
  ];
  let html = read("index.html");
  for (const url of allowed) html = html.replaceAll(url, "");
  assert.equal(html.includes(ASSOCIATE_TAG), false);
  assert.equal(ASSOCIATE_TAG, "onamzeddie0c-20");
});

test("affiliate helper sets the US tag and leaves other links alone", () => {
  const search = new URL(withAffiliateTag("https://www.amazon.com/s?k=EXAMPLE%20Studio%20Earbuds"));
  assert.equal(search.searchParams.get("tag"), ASSOCIATE_TAG);
  assert.equal(search.searchParams.get("k"), "EXAMPLE Studio Earbuds");

  const replaced = new URL(withAffiliateTag("https://www.amazon.com/dp/B00TEST?tag=someone-20&psc=1"));
  assert.equal(replaced.searchParams.get("tag"), ASSOCIATE_TAG);
  assert.equal(replaced.searchParams.get("psc"), "1");

  const storefront = withAffiliateTag("https://www.amazon.com/shop/twitch.tvraw0nline");
  assert.equal(storefront, "https://www.amazon.com/shop/twitch.tvraw0nline?tag=onamzeddie0c-20");

  assert.equal(withAffiliateTag("https://linktr.ee/raw0nline"), "https://linktr.ee/raw0nline");
  assert.equal(withAffiliateTag("https://www.amazon.co.uk/dp/B00TEST"), "https://www.amazon.co.uk/dp/B00TEST");
  assert.equal(withAffiliateTag("not a url"), "not a url");
});

test("deal links go through the affiliate helper", () => {
  const href = dealHref({ url: "https://www.amazon.com/dp/B00TEST" });
  assert.equal(new URL(href).searchParams.get("tag"), ASSOCIATE_TAG);
});

test("days are grouped with today first, using the America/Chicago calendar date", () => {
  assert.equal(todayISO(new Date("2026-11-09T05:00:00Z")), "2026-11-08");
  assert.equal(todayISO(new Date("2026-11-09T15:00:00Z")), "2026-11-09");
  assert.equal(dayHeading("2026-11-09", "2026-11-09"), "Today");
  assert.equal(dayHeading("2026-11-08", "2026-11-09"), "Yesterday");
  assert.equal(dayHeading("2026-11-07", "2026-11-09"), "Saturday, Nov 7");

  const groups = groupDeals([
    { added: "2026-11-07", id: "old" },
    { added: "2026-11-09", id: "new" },
    { added: "2026-11-08", id: "mid" },
  ]);
  assert.deepEqual(groups.map((group) => group.date), ["2026-11-09", "2026-11-08", "2026-11-07"]);
});

test("search and category filters combine", () => {
  const deals = [
    { title: "EXAMPLE Studio Earbuds", category: "Electronics", promoCode: "RAWSAMPLE" },
    { title: "EXAMPLE Hill Country Skillet", category: "Kitchen" },
  ];
  assert.equal(filterDeals(deals, { query: "rawsample" }).length, 1);
  assert.equal(filterDeals(deals, { category: "Kitchen", query: "earbuds" }).length, 0);
  assert.equal(formatMoney(18.5), "$18.50");
});

test("dead deal reports stay local and keep a stable shape", async () => {
  const store = createDeadDealStore(memoryStorage());
  const when = new Date("2026-11-09T12:00:00.000Z");
  const record = await store.report("ex-studio-earbuds", when);
  assert.deepEqual(record, {
    id: "ex-studio-earbuds",
    reportedAt: "2026-11-09T12:00:00.000Z",
    source: "local",
  });
  assert.equal((await store.report("ex-studio-earbuds", new Date())).reportedAt, record.reportedAt);
  assert.equal((await store.list()).length, 1);
  await store.retract("ex-studio-earbuds");
  assert.deepEqual(await store.list(), []);
});

test("seeded deals validate and the publishing files are in place", () => {
  const payload = JSON.parse(read("data/deals.json"));
  const errors = validatePayload(payload, {
    fileExists: (relativePath) => readFileSync(join(root, relativePath)).byteLength > 0,
  });
  assert.deepEqual(errors, []);
  assert.ok(payload.deals.every((deal) => deal.sample === true));
  assert.equal(read("CNAME").trim(), "getrawdeals.com");
  assert.match(read("index.html"), /As an Amazon Associate I earn from qualifying purchases\./);
  assert.match(read("index.html"), /https:\/\/linktr\.ee\/raw0nline/);
  assert.match(read("index.html"), /https:\/\/www\.amazon\.com\/shop\/twitch\.tvraw0nline/);
  const page = read("index.html");
  const headerAt = page.indexOf("site-header");
  const howAt = page.indexOf('id="how-to-coupon"');
  const bannerAt = page.indexOf('id="sample-banner"');
  const filtersAt = page.indexOf('id="filters"');
  const dealsAt = page.indexOf('id="deals"');
  const newsAt = page.indexOf('id="newsletter-slot"');
  assert.ok(headerAt !== -1 && howAt !== -1 && bannerAt !== -1 && filtersAt !== -1 && dealsAt !== -1 && newsAt !== -1);
  assert.ok(headerAt < howAt && howAt < bannerAt && bannerAt < filtersAt && filtersAt < dealsAt);
  const howTo = page.slice(howAt, bannerAt);
  assert.match(howTo, /<h2[^>]*>How to use a coupon code<\/h2>/);
  assert.match(howTo, /<ol>/);
  assert.match(howTo, /tap the code on a deal card to copy it/);
  assert.match(howTo, /Some deals apply the discount automatically or use an on-page coupon checkbox, so no code is needed\./);
  assert.match(page, /<h2 id="try-prime-title">Join Amazon Prime<\/h2>/);
  assert.match(page, /New members may get a free trial\./);
  assert.match(page, />See Prime plans</);
  assert.match(page, /<h2>Get Audible<\/h2>/);
  assert.match(page, />See Audible plans</);
  assert.match(page, /<h2>Get Prime Video<\/h2>/);
  assert.match(page, />See Prime Video plans</);
  assert.match(page, /aria-label="More from Amazon"/);
  assert.doesNotMatch(page, /Try Amazon Prime free|Try Prime free|Try Audible free|Try Prime Video free|More to try free/);
  const slot = page.slice(newsAt);
  assert.match(slot, /<form[\s>]/);
  assert.match(slot, /type="email"/);
  assert.match(slot, /required/);
  assert.match(slot, /Sign Up/);
  assert.match(read("index.html"), /https:\/\/www\.tiktok\.com\/@raw0nline/);
  assert.match(read("index.html"), /https:\/\/www\.instagram\.com\/raw0nline/);
  assert.match(read("index.html"), /aria-label="Raw0nline on TikTok"/);
  assert.match(read("index.html"), /aria-label="Raw0nline on Instagram"/);
  assert.match(read("index.html"), /theme-color" content="#0a0a0f"/);
  assert.match(slot, /One email a day with the best Amazon deals\. Unsubscribe anytime\./);
  assert.doesNotMatch(slot, /disabled|Coming soon|coming soon/);
  assert.equal(
    beehiivSignupUrl("eddie+deals@example.com"),
    "https://magic.beehiiv.com/v1/085d2554-2a2b-4438-9442-7f3b58ba41f3?email=eddie%2Bdeals%40example.com",
  );
});

test("Creators API mapper stays offline and hides secrets", () => {
  const fixture = JSON.parse(read("scripts/fixtures/get-items.sample-from-docs.json"));
  const item = fixture.itemsResult.items[0];
  const deal = mapCreatorsItemToDeal(item, { category: "Electronics", promoCode: "SAVE10" }, "2026-11-09");
  assert.equal(deal.price, 59.49);
  assert.equal(deal.originalPrice, 69.99);
  assert.equal(deal.percentOff, 15);
  assert.equal(deal.expires, "2024-11-06");
  assert.equal(deal.promoCode, "SAVE10");
  assert.equal(deal.sample, false);
  assert.equal(deal.category, "Electronics");

  const merged = mergeDeals([{ id: "keep", added: "2026-11-08" }], [deal, { id: "keep" }]);
  assert.deepEqual(merged.map((entry) => entry.id), [deal.id, "keep"]);

  const body = buildGetItemsBody(["B0EXAMPLE01"]);
  assert.equal(body.partnerTag, ASSOCIATE_TAG);
  assert.equal(body.marketplace, "www.amazon.com");
  assert.equal(tokenEndpoint("3.2"), "https://api.amazon.co.uk/auth/o2/token");

  const secret = "super-secret-value-do-not-print";
  const text = planText({
    entries: [{ asin: "B0EXAMPLE01" }],
    status: credentialStatus({
      CREATORS_API_CREDENTIAL_ID: "credential-id",
      CREATORS_API_CREDENTIAL_SECRET: secret,
      CREATORS_API_CREDENTIAL_VERSION: "3.1",
    }),
  });
  assert.match(text, /No request was sent/);
  assert.equal(text.includes(secret), false);
  assert.equal(read("scripts/fetch-deals.js").includes("node:http"), false);
  assert.equal(read("scripts/fetch-deals.js").includes("node:https"), false);

  const dealsBefore = read("data/deals.json");
  const live = spawnSync(process.execPath, ["scripts/fetch-deals.js", "--live"], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  assert.equal(live.status, 1);
  assert.match(`${live.stdout}\n${live.stderr}`, /No request was sent/);
  assert.equal(`${live.stdout}${live.stderr}`.includes(secret), false);
  assert.equal(read("data/deals.json"), dealsBefore);
});
