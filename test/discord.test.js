import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ASSOCIATE_TAG } from "../js/affiliate.js";
import { dealHref } from "../js/deals.js";
import {
  buildGetItemsBody,
  buildSearchBody,
  dealFromCreatorsItem,
  featureBulletsFromItem,
  GET_ITEMS_RESOURCES,
  mapCreatorsItemToDeal,
} from "../scripts/fetch-deals.js";
import {
  batchDealMessages,
  dailyHeader,
  DISCORD_CONTENT_LIMIT,
  DISCORD_FEATURE_LIMIT,
  DISCORD_FOOTER,
  DISCORD_PAUSE_MS,
  DISCORD_SUPPRESS_EMBEDS,
  DISCORD_TITLE_LIMIT,
  DISCORD_USERNAME,
  featurePhrase,
  formatDealBlock,
  formatDiscordPrice,
  MAX_DISCORD_DEALS,
  postDiscordMessages,
  selectNewDeals,
  shortenText,
} from "../scripts/post-discord.js";

const today = "2026-11-14";
const secret = "https://discord.com/api/webhooks/123/super-secret-webhook-token";

function deal(overrides = {}) {
  return {
    id: "B0NEWDEAL01",
    title: "Cast iron skillet",
    image: "https://m.media-amazon.com/images/I/skillet.jpg",
    price: 49,
    originalPrice: 79,
    percentOff: 38,
    category: "Kitchen",
    url: "https://www.amazon.com/dp/B0NEWDEAL01?tag=onamzeddie0c-20&linkCode=ogi&th=1&psc=1",
    added: today,
    sample: false,
    source: "api",
    ...overrides,
  };
}

test("new deals are ids missing from the previous file, capped, and not posted again", () => {
  const previous = [
    deal({ id: "B0ALREADY01", added: today, title: "Already posted lamp" }),
    deal({ id: "B0OLD000001", added: "2026-11-10", title: "Older kettle" }),
  ];
  const current = [
    deal({ id: "B0SAMPLE000", sample: true, title: "EXAMPLE sample mug" }),
    deal({ id: "B0BABY00001", title: "Baby onesie cotton sleeper" }),
    deal({ id: "B0ALREADY01", added: today, price: 40, title: "Already posted lamp" }),
    deal({ id: "B0FRESH0001", title: "Fresh headphones" }),
    deal({ id: "B0FRESH0002", added: "2026-11-13", title: "Fresh mug from yesterday" }),
    ...Array.from({ length: 30 }, (_, index) => deal({
      id: `B0EXTRA${String(index).padStart(4, "0")}`,
      title: `Extra deal ${index}`,
    })),
  ];
  const picked = selectNewDeals(previous, current, { today });
  assert.deepEqual(picked.map((entry) => entry.id).slice(0, 2), ["B0FRESH0001", "B0FRESH0002"]);
  assert.equal(picked.some((entry) => entry.id === "B0ALREADY01"), false);
  assert.equal(picked.some((entry) => entry.id === "B0SAMPLE000"), false);
  assert.equal(picked.some((entry) => entry.id === "B0BABY00001"), false);
  assert.equal(picked.length, MAX_DISCORD_DEALS);
  assert.equal(picked.at(-1).id, "B0EXTRA0022");
  assert.equal(picked.some((entry) => entry.id === "B0EXTRA0023"), false);
});

test("deal text includes percent, was-price, code, exact API url, and a short feature", () => {
  const longTitle = "CMF BY Nothing Headphone Pro Active Noise Canceling Wireless Headphones Bluetooth 5.4 Over The Ear Headset, 50H ANC Playtime, Bass&Treble Slider, Custom EQ&Spatial Audio, Hi-Res LDAC, Light Grey";
  const apiUrl = "https://www.amazon.com/dp/B0FLKC5JN4?tag=onamzeddie0c-20&linkCode=ogi&th=1&psc=1";
  const feature = "Custom EQ and spatial audio with a 50 hour battery and a bass and treble slider for late sessions.";
  const apiDeal = deal({
    id: "B0FLKC5JN4",
    title: longTitle,
    url: apiUrl,
    price: 49,
    originalPrice: 79,
    percentOff: 38,
    features: [feature, "This second bullet must not be posted."],
  });
  const block = formatDealBlock(apiDeal);
  const [line, phrase] = block.split("\n");
  const label = shortenText(longTitle, DISCORD_TITLE_LIMIT);
  assert.ok(label.length <= DISCORD_TITLE_LIMIT);
  assert.ok(label.endsWith("…"));
  assert.equal(longTitle.startsWith(label.slice(0, -1)), true);
  assert.equal(longTitle[label.length - 1], " ");
  assert.equal(line, `**[${label}](<${apiUrl}>)** — 38% off • $49 (was $79)`);
  assert.equal(line.includes(ASSOCIATE_TAG), false);
  assert.equal(phrase, featurePhrase(apiDeal));
  assert.ok(phrase.length <= DISCORD_FEATURE_LIMIT);
  assert.equal(phrase.includes("second bullet"), false);
  assert.equal(formatDiscordPrice(50.99), "$50.99");
  assert.equal(formatDiscordPrice(79), "$79");

  const skilletUrl = "https://www.amazon.com/dp/B0NEWDEAL01?tag=onamzeddie0c-20&linkCode=ogi&th=1&psc=1";
  const coded = formatDealBlock(deal({
    title: "10-inch skillet",
    url: skilletUrl,
    price: 29.99,
    originalPrice: 44.99,
    percentOff: 33,
    promoCode: "PAN10",
    features: ["Holds heat for searing. A second sentence stays off this line because the first one is short."],
  }));
  assert.equal(
    coded,
    `**[10-inch skillet](<${skilletUrl}>)** — 33% off • $29.99 (was $44.99) • code PAN10\nHolds heat for searing.`,
  );

  const handwritten = deal({
    id: "hand-skillet",
    source: undefined,
    title: "Hand skillet",
    url: "https://www.amazon.com/dp/B0HAND00001",
    promoCode: "PAN10",
    features: undefined,
    description: undefined,
  });
  const handBlock = formatDealBlock(handwritten);
  assert.equal(handBlock.includes("\n"), false);
  assert.equal(handBlock.includes(dealHref(handwritten)), true);
  assert.equal(new URL(dealHref(handwritten)).searchParams.get("tag"), ASSOCIATE_TAG);
  assert.equal(handBlock.includes("Hand skillet"), true);
  assert.equal(handBlock.includes("code PAN10"), true);
});

test("messages stay within 2000 characters, with the header first and the footer last", () => {
  const deals = Array.from({ length: 12 }, (_, index) => deal({
    id: `B0BATCH${String(index).padStart(4, "0")}`,
    title: `Batch deal number ${index} with a longish product name`,
    url: `https://www.amazon.com/dp/B0BATCH${String(index).padStart(4, "0")}?tag=eddie060-20&linkCode=ogi&th=1&psc=1`,
    price: 49.99,
    originalPrice: 79.99,
    percentOff: 38,
    features: ["Soft grip handle stays comfortable through a long weeknight cook and still fits in the dishwasher."],
  }));
  const messages = batchDealMessages(deals, { today });
  assert.ok(messages.length > 1);
  assert.equal(messages[0].startsWith(dailyHeader(today)), true);
  assert.match(messages[0], /Nov 14/);
  assert.equal(messages.at(-1).endsWith(DISCORD_FOOTER), true);
  for (const message of messages) assert.ok(message.length <= DISCORD_CONTENT_LIMIT, message.length);
  assert.equal(messages.slice(1).some((message) => message.startsWith(dailyHeader(today))), false);
  assert.equal(messages.slice(0, -1).some((message) => message.includes(DISCORD_FOOTER)), false);
  const combined = messages.join("\n");
  for (const entry of deals) assert.equal(combined.includes(entry.url), true);
  assert.equal(combined.split("**[").length - 1, deals.length);
});

test("a missing webhook skips without fetching", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    throw new Error(`should not fetch ${secret}`);
  };
  for (const webhookUrl of [undefined, "", "   "]) {
    const result = await postDiscordMessages(["hello"], { webhookUrl, fetchImpl });
    assert.deepEqual(result, { skipped: true, reason: "missing webhook", posted: 0 });
  }
  const empty = await postDiscordMessages([], { webhookUrl: secret, fetchImpl });
  assert.equal(empty.skipped, true);
  assert.equal(empty.reason, "no new deals");
  assert.equal(called, false);
  assert.equal(JSON.stringify(empty).includes(secret), false);
});

test("webhook posts use suppress-embeds and retry 429 using retry_after", async () => {
  const sleeps = [];
  const bodies = [];
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls += 1;
    assert.equal(url, secret);
    const payload = JSON.parse(options.body);
    bodies.push(payload);
    assert.equal(payload.flags, DISCORD_SUPPRESS_EMBEDS);
    assert.equal(payload.username, DISCORD_USERNAME);
    assert.equal(payload.embeds, undefined);
    assert.equal(JSON.stringify(payload).includes(secret), false);
    if (calls === 1) {
      return {
        ok: false,
        status: 429,
        json: async () => ({ retry_after: 0.25, message: "You are being rate limited." }),
        headers: { get: () => null },
      };
    }
    return { ok: true, status: 204, json: async () => ({}) };
  };
  const messages = [
    `${dailyHeader(today)}\n\n**[First lamp](<https://www.amazon.com/dp/B0ONE000001>)** — 38% off • $49 (was $79)`,
    `**[Second lamp](<https://www.amazon.com/dp/B0TWO000002>)** — 38% off • $49 (was $79) • code LAMP\n\n${DISCORD_FOOTER}`,
  ];
  const result = await postDiscordMessages(messages, {
    webhookUrl: secret,
    fetchImpl,
    pauseMs: DISCORD_PAUSE_MS,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(result.skipped, false);
  assert.equal(result.posted, messages.length);
  assert.equal(calls, messages.length + 1);
  assert.deepEqual(sleeps, [250, DISCORD_PAUSE_MS]);
  assert.equal(bodies[0].content, bodies[1].content);
  assert.equal(bodies[0].flags, 4);
});

test("a webhook that keeps returning 429 fails without revealing the secret", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 429,
    json: async () => ({ retry_after: 0.01, message: secret }),
    headers: { get: () => null },
  });
  await assert.rejects(
    () => postDiscordMessages(["**[Lamp](<https://www.amazon.com/dp/B0X>)** — $10"], {
      webhookUrl: secret,
      fetchImpl,
      maxRetries: 2,
      sleep: async () => {},
    }),
    (error) => {
      assert.equal(error.message.includes(secret), false);
      assert.match(error.message, /Discord webhook failed \(429\)/);
      return true;
    },
  );
});

test("feature bullets are requested on the same catalog call and stored for the post", () => {
  assert.equal(GET_ITEMS_RESOURCES.includes("itemInfo.features"), true);
  assert.equal(buildGetItemsBody(["B0FLKC5JN4"]).resources.includes("itemInfo.features"), true);
  assert.equal(buildSearchBody(
    { keywords: "headphones", category: "Tech" },
    { minDiscountPercent: 20, minRating: 4 },
  ).resources.includes("itemInfo.features"), true);

  const item = {
    asin: "B0FLKC5JN4",
    detailPageURL: "https://www.amazon.com/dp/B0FLKC5JN4?tag=onamzeddie0c-20&linkCode=ogi&th=1&psc=1",
    images: { primary: { large: { url: "https://m.media-amazon.com/images/I/x.jpg" } } },
    itemInfo: {
      title: { displayValue: "Headphone Pro" },
      features: {
        displayValues: [
          "  Custom EQ and spatial audio.  ",
          "Fifty hour battery.",
          "A third bullet is not stored.",
        ],
      },
    },
    offersV2: {
      listings: [{
        isBuyBoxWinner: true,
        price: {
          money: { amount: 49 },
          savingBasis: { money: { amount: 79 } },
          savings: { percentage: 38 },
        },
      }],
    },
  };
  assert.deepEqual(featureBulletsFromItem(item), [
    "Custom EQ and spatial audio.",
    "Fifty hour battery.",
  ]);
  const mapped = mapCreatorsItemToDeal(item, {}, today);
  assert.deepEqual(mapped.features, [
    "Custom EQ and spatial audio.",
    "Fifty hour battery.",
  ]);
  assert.equal(mapped.url, item.detailPageURL);
  const built = dealFromCreatorsItem(item, { asin: item.asin }, { today });
  assert.deepEqual(built.features, mapped.features);
  assert.equal(featurePhrase({ title: "Headphone Pro" }), "");
  assert.equal(formatDealBlock({ ...mapped, features: undefined }).includes("\n"), false);
});

test("the command skips a missing secret and does not print it", () => {
  const dir = mkdtempSync(join(tmpdir(), "rawdeals-discord-"));
  const previous = join(dir, "before.json");
  const current = join(dir, "after.json");
  const body = `${JSON.stringify({ deals: [deal()] }, null, 2)}\n`;
  writeFileSync(previous, body);
  writeFileSync(current, `${JSON.stringify({ deals: [deal(), deal({ id: "B0NEW000009", title: "New lamp" })] }, null, 2)}\n`);
  const script = join(import.meta.dirname, "..", "scripts", "post-discord.js");
  const skipped = spawnSync(process.execPath, [script, "--previous", previous, "--current", current, "--today", today], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  assert.equal(skipped.status, 0);
  assert.match(skipped.stdout, /skipped \(missing webhook\)/);
  assert.equal(`${skipped.stdout}${skipped.stderr}`.includes(secret), false);

  writeFileSync(current, body);
  const quiet = spawnSync(process.execPath, [script, "--previous", previous, "--current", current, "--today", today], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, DISCORD_WEBHOOK_URL: secret },
  });
  assert.equal(quiet.status, 0);
  assert.match(quiet.stdout, /skipped \(no new deals\)/);
  assert.equal(`${quiet.stdout}${quiet.stderr}`.includes(secret), false);
  assert.equal(`${quiet.stdout}${quiet.stderr}`.includes("super-secret-webhook-token"), false);
  rmSync(dir, { recursive: true, force: true });
});

test("the workflow passes DISCORD_WEBHOOK_URL only to the Discord step", () => {
  const workflow = readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "refresh-deals.yml"), "utf8");
  const postAt = workflow.indexOf("Post new deals to Discord");
  assert.ok(postAt > workflow.indexOf("git push origin HEAD:main"));
  assert.match(workflow, /DISCORD_WEBHOOK_URL: \$\{\{ secrets\.DISCORD_WEBHOOK_URL \}\}/);
  assert.match(workflow, /node scripts\/post-discord\.js --previous "\$RUNNER_TEMP\/deals-before\.json"/);
  assert.equal(workflow.slice(0, postAt).includes("DISCORD_WEBHOOK_URL"), false);
  assert.doesNotMatch(workflow, /DISCORD_WEBHOOK_URL:\s*["']https/);
});
