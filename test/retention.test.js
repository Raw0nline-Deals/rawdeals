import assert from "node:assert/strict";
import test from "node:test";
import {
  DEAL_RETENTION_DAYS,
  dayGroups,
  inactiveReason,
  isWithinRetention,
  retentionStart,
  visibleDeals,
} from "../js/deals.js";
import {
  partitionDiscoveredDeals,
  planDealMerge,
  refreshSummary,
} from "../scripts/fetch-deals.js";

const today = "2026-11-11";

function deal(overrides = {}) {
  return {
    id: "B0DEAL",
    title: "Widget",
    image: "https://m.media-amazon.com/images/I/widget.jpg",
    price: 10,
    originalPrice: 20,
    percentOff: 50,
    category: "Home",
    url: "https://www.amazon.com/dp/B0DEAL",
    added: "2026-11-10",
    sample: false,
    source: "api",
    ...overrides,
  };
}

function item(asin, title = "Widget") {
  return {
    asin,
    detailPageURL: `https://www.amazon.com/dp/${asin}`,
    images: { primary: { large: { url: "https://m.media-amazon.com/images/I/widget.jpg" } } },
    itemInfo: { title: { displayValue: title } },
    offersV2: {
      listings: [{
        isBuyBoxWinner: true,
        price: {
          money: { amount: 20 },
          savingBasis: { money: { amount: 40 } },
          savings: { percentage: 50 },
        },
      }],
    },
  };
}

test("the retention window is 7 days including today", () => {
  assert.equal(DEAL_RETENTION_DAYS, 7);
  assert.equal(retentionStart(today), "2026-11-05");
  assert.equal(retentionStart("2026-11-01"), "2026-10-26");
  assert.equal(isWithinRetention({ added: "2026-11-05" }, today), true);
  assert.equal(isWithinRetention({ added: "2026-11-11" }, today), true);
  assert.equal(isWithinRetention({ added: "2026-11-04" }, today), false);
  assert.equal(isWithinRetention({ added: "2026-11-12" }, today), false);
  assert.equal(isWithinRetention({ added: "not-a-date" }, today), false);

  const deals = [
    deal({ id: "edge", added: "2026-11-05" }),
    deal({ id: "today", added: today }),
    deal({ id: "old", added: "2026-11-04" }),
    deal({ id: "dead", added: "2026-11-10", verifiedDead: true }),
    deal({ id: "sample", added: today, sample: true, title: "EXAMPLE mug" }),
  ];
  assert.deepEqual(visibleDeals(deals, today).map((entry) => entry.id), ["edge", "today"]);
  assert.equal(inactiveReason(deals[3], today), "verified dead");

  const groups = dayGroups(visibleDeals(deals, today), today);
  assert.deepEqual(groups.map((group) => [group.date, group.expanded, group.collapsible]), [
    [today, true, false],
    ["2026-11-05", false, true],
  ]);
});

test("a discovery that misses today's cut stays when it is still inside 7 days", () => {
  const missed = deal({
    id: "B0HLL1RSKC",
    title: "Titanium pan",
    category: "Kitchen",
    added: today,
    discovered: true,
    expires: "2026-11-19",
    percentOff: 20,
  });
  const aged = deal({
    id: "B0AGED",
    added: "2026-11-04",
    discovered: true,
  });
  const ended = deal({
    id: "B0ENDED",
    added: "2026-11-09",
    expires: "2026-11-10",
    discovered: true,
  });
  const stock = deal({
    id: "B0STOCK",
    added: "2026-11-09",
    inStock: false,
    discovered: true,
  });
  const verified = deal({
    id: "B0VERIFIED",
    added: "2026-11-09",
    verifiedDead: true,
    discovered: true,
  });
  const flat = deal({
    id: "B0FLAT",
    added: "2026-11-09",
    percentOff: 0,
    originalPrice: undefined,
    discovered: true,
  });
  const handwritten = deal({
    id: "hand",
    source: undefined,
    added: "2026-11-06",
    percentOff: 0,
    expires: "2026-11-07",
  });
  const oldHand = deal({
    id: "old-hand",
    source: undefined,
    added: "2026-11-01",
    percentOff: 0,
  });
  const { deals, dropped } = planDealMerge(
    [missed, aged, ended, stock, verified, flat, handwritten, oldHand],
    new Map(),
    today,
    [],
  );
  assert.deepEqual(deals.map((entry) => entry.id), ["B0HLL1RSKC", "hand"]);
  assert.equal(deals[0].added, today);
  const reasons = Object.fromEntries(dropped.map((entry) => [entry.id, entry.reason]));
  assert.equal(reasons.B0AGED, "older than 7 days");
  assert.equal(reasons.B0ENDED, "deal ended");
  assert.equal(reasons.B0STOCK, "out of stock");
  assert.equal(reasons.B0VERIFIED, "verified dead");
  assert.equal(reasons.B0FLAT, "no longer discounted");
  assert.equal(reasons["old-hand"], "older than 7 days");
  assert.equal(reasons.B0HLL1RSKC, undefined);
});

test("maxDeals caps new discoveries and a reconfirmed old deal is dated today", () => {
  const existing = deal({ id: "B0OLDHIT", added: "2026-11-01", discovered: true, percentOff: 40 });
  const kept = deal({ id: "B0KEPT", added: "2026-11-08", discovered: true, title: "Kept lamp" });
  const rejected = deal({ id: "B0THIN", added: "2026-11-08", discovered: true, percentOff: 40 });
  const tagged = [
    { category: "Tech", item: item("B0OLDHIT", "Still a lamp") },
    { category: "Tech", item: item("B0NEW1", "New one") },
    { category: "Home", item: item("B0NEW2", "New two") },
    { category: "Kitchen", item: item("B0THIN", "Thin discount") },
  ];
  tagged[3].item.offersV2.listings[0].price.savings.percentage = 5;
  tagged[3].item.offersV2.listings[0].price.money.amount = 38;
  const split = partitionDiscoveredDeals(tagged, {
    today,
    existingDeals: [existing, kept, rejected],
    knownAsins: new Set(["B0OLDHIT", "B0KEPT", "B0THIN"]),
    minDiscountPercent: 20,
    minRating: 4,
    maxDeals: 1,
  });
  assert.deepEqual(split.fresh.map((entry) => entry.id), ["B0NEW1"]);
  assert.deepEqual(split.refreshed.map((entry) => entry.id), ["B0OLDHIT"]);
  assert.deepEqual(split.rejected, [{ id: "B0THIN", reason: "discount below the discovery minimum" }]);

  const updates = new Map([
    ["B0ASIN", deal({ id: "B0ASIN", added: "2026-10-01", discovered: undefined, title: "Listed" })],
  ]);
  const { deals, dropped } = planDealMerge(
    [existing, kept, rejected],
    updates,
    today,
    split.fresh,
    { refreshed: split.refreshed, rejected: split.rejected },
  );
  assert.deepEqual(deals.map((entry) => entry.id), ["B0ASIN", "B0NEW1", "B0OLDHIT", "B0KEPT"]);
  assert.equal(deals.find((entry) => entry.id === "B0OLDHIT").added, today);
  assert.equal(deals.find((entry) => entry.id === "B0ASIN").added, today);
  assert.equal(deals.find((entry) => entry.id === "B0KEPT").added, "2026-11-08");
  assert.equal(deals.find((entry) => entry.id === "B0KEPT").title, "Kept lamp");
  assert.deepEqual(dropped, [{ id: "B0THIN", reason: "discount below the discovery minimum" }]);
});

test("the refresh log names dropped ASINs and skips the hand-written line when there are none", () => {
  const quiet = refreshSummary({
    changed: true,
    count: 2,
    discovered: 1,
    addedDiscoveries: 0,
    handWritten: 0,
    priority: [],
    dropped: [{ id: "B0HLL1RSKC", reason: "older than 7 days" }],
  });
  assert.deepEqual(quiet, [
    "Updated data/deals.json (2 API deals, 1 discovered).",
    "Dropped B0HLL1RSKC (older than 7 days).",
  ]);
  assert.equal(quiet.join("\n").includes("Hand-written"), false);

  const withHand = refreshSummary({
    changed: true,
    count: 1,
    discovered: 0,
    addedDiscoveries: 1,
    handWritten: 2,
    priority: ["B0WATCH"],
    dropped: [],
  });
  assert.match(withHand[0], /1 new discovery\./);
  assert.match(withHand[0], /Hand-written deals were kept\./);
  assert.match(withHand[0], /Priority watch: B0WATCH\./);
});
