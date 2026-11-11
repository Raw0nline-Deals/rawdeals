import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  DEAD_DEALS_API_ORIGIN,
  createSharedDeadDealStore,
  memoryStorage,
  mergeReports,
} from "../js/dead-deals.js";
import { visibleDeals } from "../js/deals.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

test("merge keeps a local report and lets a verified deal win for everyone", () => {
  const merged = mergeReports(
    [{ id: "local-only", reportedAt: "2026-11-09T12:00:00.000Z", source: "local" }],
    [
      { id: "local-only", reportedAt: "2026-11-09T12:00:01.000Z", source: "api", verified: false },
      { id: "checked", reportedAt: "2026-11-09T13:00:00.000Z", source: "api", verified: true },
    ],
  );
  const local = merged.find((record) => record.id === "local-only");
  const checked = merged.find((record) => record.id === "checked");
  assert.equal(local.source, "local");
  assert.equal(local.verified, false);
  assert.equal(local.reportedAt, "2026-11-09T12:00:00.000Z");
  assert.equal(checked.source, "api");
  assert.equal(checked.verified, true);
});

test("a dead API or a network failure leaves the local report in place", async () => {
  const storage = memoryStorage();
  let calls = 0;
  const store = createSharedDeadDealStore({
    storage,
    fetchImpl: async () => {
      calls += 1;
      throw new Error("offline");
    },
  });
  const when = new Date("2026-11-09T12:00:00.000Z");
  const record = await store.report("B0KEEP000001", when);
  assert.deepEqual(record, {
    id: "B0KEEP000001",
    reportedAt: "2026-11-09T12:00:00.000Z",
    source: "local",
  });
  assert.equal((await store.list()).length, 1);
  await store.retract("B0KEEP000001");
  assert.deepEqual(await store.list(), []);
  assert.ok(calls >= 1);
});

test("the shared store posts the report and hides a verified deal on the next read", async () => {
  const storage = memoryStorage();
  const seen = [];
  const store = createSharedDeadDealStore({
    storage,
    fetchImpl: async (url, options) => {
      seen.push({ url, options });
      if (options.method === "POST") {
        assert.equal(options.headers.authorization, undefined);
        assert.equal(options.body, JSON.stringify({ id: "B0KEEP000001" }));
        return { ok: true, status: 201, json: async () => ({ id: "B0KEEP000001", verified: false, source: "api" }) };
      }
      if (options.method === "DELETE") {
        return { ok: true, status: 200, json: async () => ({ id: "B0KEEP000001", verified: true, source: "api" }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => [{ id: "B0GONE000001", reportedAt: "2026-11-11T00:00:00.000Z", source: "api", verified: true }],
      };
    },
  });
  const reported = await store.report("B0KEEP000001", new Date("2026-11-11T12:00:00.000Z"));
  assert.equal(reported.source, "local");
  const listed = await store.list();
  assert.equal(listed.some((record) => record.id === "B0GONE000001" && record.verified), true);
  const still = await store.retract("B0KEEP000001");
  assert.equal(still.verified, true);
  assert.equal(seen.some((call) => String(call.options?.headers?.authorization || "").includes("Bearer")), false);
  assert.equal(JSON.stringify(seen).includes("CREATORS_API"), false);
});

test("verified deals are hidden from the page and the feed filter", () => {
  const deals = [
    {
      id: "B0KEEP000001",
      title: "Still good",
      price: 10,
      percentOff: 20,
      category: "Home",
      added: "2026-11-11",
      sample: false,
      source: "api",
    },
    {
      id: "B0GONE000001",
      title: "Checked dead",
      price: 10,
      percentOff: 20,
      category: "Home",
      added: "2026-11-11",
      sample: false,
      source: "api",
      verifiedDead: true,
    },
  ];
  assert.deepEqual(visibleDeals(deals, "2026-11-11").map((deal) => deal.id), ["B0KEEP000001"]);
  assert.equal(DEAD_DEALS_API_ORIGIN, "https://api.getrawdeals.com");
  assert.match(read("js/app.js"), /createSharedDeadDealStore/);
  assert.match(read("js/app.js"), /verifiedIds/);
  assert.match(read("js/deals.js"), /verifiedDead/);
});
