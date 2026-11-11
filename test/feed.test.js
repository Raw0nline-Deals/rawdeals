import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ASSOCIATE_TAG } from "../js/affiliate.js";
import { dealsFromPayload, groupDeals, visibleDeals } from "../js/deals.js";
import {
  DISCLOSURE,
  buildFeedXml,
  dealDescription,
  escapeXml,
  orderedFeedDeals,
  orderedVisibleDeals,
  writeFeedFile,
} from "../scripts/build-feed.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const today = "2026-11-11";

function deal(overrides = {}) {
  return {
    id: "B0GOOD000001",
    title: "Cast iron pan",
    image: "https://m.media-amazon.com/images/I/pan.jpg",
    price: 29.99,
    originalPrice: 44.99,
    percentOff: 33,
    promoCode: "PAN10",
    category: "Kitchen",
    url: "https://www.amazon.com/dp/B0GOOD000001?tag=someone-20",
    added: "2026-11-11",
    sample: false,
    source: "api",
    ...overrides,
  };
}

function parseFeed(xml) {
  const result = spawnSync("python3", ["-c", `
import json, sys
import xml.etree.ElementTree as ET
root = ET.fromstring(sys.stdin.read())
ns = {"media": "http://search.yahoo.com/mrss/", "atom": "http://www.w3.org/2005/Atom"}
channel = root.find("channel")
items = []
for item in channel.findall("item"):
    enclosure = item.find("enclosure")
    media = item.find("media:content", ns)
    items.append({
        "title": item.findtext("title"),
        "link": item.findtext("link"),
        "guid": item.findtext("guid"),
        "pubDate": item.findtext("pubDate"),
        "category": item.findtext("category"),
        "description": item.findtext("description"),
        "enclosure": None if enclosure is None else enclosure.get("url"),
        "enclosureType": None if enclosure is None else enclosure.get("type"),
        "media": None if media is None else media.get("url"),
    })
json.dump({
    "description": channel.findtext("description"),
    "lastBuildDate": channel.findtext("lastBuildDate"),
    "items": items,
}, sys.stdout)
`], { input: xml, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test("the feed lists today's deals and leaves earlier days on the page", () => {
  const deals = [
    deal({ id: "old", title: "Older lamp", added: "2026-11-09", category: "Home", promoCode: undefined, percentOff: 20 }),
    deal({ id: "ancient", title: "Week-old lamp", added: "2026-11-01", category: "Home", promoCode: undefined, percentOff: 20 }),
    deal({ id: "sample", title: "EXAMPLE Skillet", sample: true, source: undefined }),
    deal({ id: "expired", title: "Ended mat", expires: "2026-11-08", added: "2026-11-07" }),
    deal({ id: "flat", title: "Full price headphones", percentOff: 0, originalPrice: undefined, promoCode: undefined }),
    deal({ id: "coded", title: "Coded bottle", percentOff: 0, originalPrice: undefined, promoCode: "SIP", added: "2026-11-11" }),
    deal({ id: "oos", title: "Gone toy", inStock: false, category: "Toys" }),
    deal({ id: "second", title: "Second today", added: "2026-11-11", promoCode: undefined, category: "Tech" }),
  ];
  const visible = visibleDeals(deals, today).map((entry) => entry.id);
  assert.deepEqual(visible, ["old", "coded", "second"]);
  const ordered = orderedVisibleDeals(deals, today).map((entry) => entry.id);
  assert.deepEqual(ordered, groupDeals(visibleDeals(deals, today)).flatMap((group) => group.deals.map((entry) => entry.id)));
  assert.deepEqual(ordered, ["coded", "second", "old"]);
  const feedIds = orderedFeedDeals(deals, today).map((entry) => entry.id);
  assert.deepEqual(feedIds, ["coded", "second"]);

  const parsed = parseFeed(buildFeedXml(deals, { today }));
  assert.deepEqual(parsed.items.map((item) => item.guid), feedIds);
  assert.equal(parsed.items.some((item) => item.guid === "old"), false);
  assert.equal(parsed.items.some((item) => item.guid === "ancient"), false);
  assert.equal(parsed.items.some((item) => item.title.includes("EXAMPLE")), false);
  assert.equal(parsed.items.some((item) => item.guid === "expired"), false);
  assert.equal(parsed.items.some((item) => item.guid === "flat"), false);
  assert.equal(parsed.items.some((item) => item.guid === "oos"), false);
});

test("feed items carry the affiliate link, prices, picture, and escaped text", () => {
  const tricky = deal({
    id: "b&b",
    title: 'Tom & Jerry <pan>',
    promoCode: "SAVE&GO",
    category: "Kitchen & Dining",
  });
  const xml = buildFeedXml([tricky], { today });
  assert.equal(xml.includes("Tom & Jerry"), false);
  assert.equal(xml.includes("Tom &amp; Jerry &lt;pan&gt;"), true);
  assert.equal(xml.includes("SAVE&GO"), false);
  assert.equal(xml.includes("SAVE&amp;GO"), true);
  assert.equal(xml.includes("Kitchen & Dining"), false);
  assert.equal(xml.includes("Kitchen &amp; Dining"), true);
  assert.equal(escapeXml(`a&b<c>"'`), "a&amp;b&lt;c&gt;&quot;&apos;");

  const parsed = parseFeed(xml);
  const item = parsed.items[0];
  assert.equal(item.title, "Tom & Jerry <pan>");
  assert.equal(item.category, "Kitchen & Dining");
  assert.equal(new URL(item.link).searchParams.get("tag"), ASSOCIATE_TAG);
  assert.equal(item.guid, "b&b");
  assert.match(item.pubDate, /11 Nov 2026 12:00:00 GMT/);
  assert.equal(item.enclosure, tricky.image);
  assert.equal(item.enclosureType, "image/jpeg");
  assert.equal(item.media, tricky.image);
  assert.match(item.description, /Sale price: \$29\.99/);
  assert.match(item.description, /Original price: \$44\.99/);
  assert.match(item.description, /33% off/);
  assert.match(item.description, /Promo code: SAVE&GO/);
  assert.match(parsed.description, new RegExp(DISCLOSURE.replaceAll(".", "\\.")));
  assert.equal(dealDescription(deal({ promoCode: undefined, originalPrice: undefined, percentOff: 0, price: 16 })).includes("Promo code"), false);
});

test("a failed feed write leaves the previous file in place", () => {
  const dir = mkdtempSync(join(tmpdir(), "rawdeals-feed-"));
  const feedPath = join(dir, "feed.xml");
  writeFileSync(feedPath, "<rss>keep</rss>\n");
  const xml = buildFeedXml([deal()], { today });
  assert.equal(writeFeedFile(feedPath, xml).changed, true);
  assert.equal(writeFeedFile(feedPath, xml).changed, false);
  assert.equal(readFileSync(feedPath, "utf8"), xml);
  rmSync(dir, { recursive: true, force: true });
});

test("the published feed matches the page filter and the workflow refreshes it with deals.json", () => {
  const page = read("js/app.js");
  const builder = read("scripts/build-feed.js");
  assert.match(page, /visibleDeals\(/);
  assert.match(builder, /visibleDeals\(/);
  assert.equal(builder.includes("sample !== true"), false);
  const html = read("index.html");
  assert.match(html, /<link rel="alternate" type="application\/rss\+xml" title="RawDeals" href="https:\/\/getrawdeals\.com\/feed\.xml">/);

  const payload = JSON.parse(read("data/deals.json"));
  const feed = parseFeed(read("feed.xml"));
  const months = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
  const stamp = feed.lastBuildDate.match(/(\d{2}) ([A-Za-z]{3}) (\d{4})/);
  const buildDay = `${stamp[3]}-${months[stamp[2]]}-${stamp[1]}`;
  const expected = orderedFeedDeals(dealsFromPayload(payload), buildDay);
  assert.deepEqual(feed.items.map((item) => item.guid), expected.map((entry) => entry.id));
  assert.ok(feed.items.length > 0);
  assert.equal(feed.items.some((item) => item.title.includes("EXAMPLE")), false);
  assert.match(feed.description, /As an Amazon Associate I earn from qualifying purchases\./);
  for (const item of feed.items) {
    assert.equal(new URL(item.link).searchParams.get("tag"), ASSOCIATE_TAG);
    assert.ok(item.enclosure);
    assert.equal(item.media, item.enclosure);
  }

  const workflow = read(".github/workflows/refresh-deals.yml");
  assert.match(workflow, /data\/deals\.json/);
  assert.ok(workflow.indexOf("node scripts/fetch-deals.js --live") < workflow.indexOf("node scripts/build-feed.js"));
  assert.match(workflow, /git add -- data\/deals\.json feed\.xml/);
  assert.doesNotMatch(workflow, /continue-on-error:\s*true/);
});
