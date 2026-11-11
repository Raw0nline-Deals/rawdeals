/**
 * Shared dead-deal votes for RawDeals.
 *
 * The browser sends an anonymous visitor id. This worker stores only hashes
 * of that id and of the visitor IP, plus the deal id and a timestamp. It never
 * stores the raw IP, and it never sees Amazon credentials. GitHub Actions
 * calls the admin routes with DEAD_DEALS_TOKEN, checks the ASIN with the
 * Creators API, and posts a verdict.
 *
 * One vote per visitor per deal. A visitor's delete removes only that vote.
 * A verified deal stays verified until reconcile says it is on the site again.
 */

export const REPORT_THRESHOLD = 3;
export const VISITOR_HOUR_LIMIT = 4;
export const VISITOR_DAY_LIMIT = 6;
export const IP_HOUR_LIMIT = 6;
export const IP_DAY_LIMIT = 10;
export const COOLDOWN_MS = 48 * 60 * 60 * 1000;
export const MIN_SECRET_LENGTH = 16;
export const MAX_VOTES = 50;
export const MAX_INDEX = 200;
export const MAX_BODY_BYTES = 2048;

const DEAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const VISITOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIXED_ORIGINS = new Set([
  "https://getrawdeals.com",
  "https://www.getrawdeals.com",
  "https://raw0nline-deals.github.io",
]);

export function memoryKv() {
  const data = new Map();
  return {
    async get(key) {
      return data.has(key) ? data.get(key) : null;
    },
    async put(key, value) {
      data.set(key, String(value));
    },
    async delete(key) {
      data.delete(key);
    },
    dump() {
      return [...data.entries()];
    },
  };
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function handleDeadDeals(request, env, options = {}) {
  const now = typeof options.now === "function" ? options.now() : new Date();
  const url = new URL(request.url);
  const origin = allowOrigin(request.headers.get("origin"));
  if (request.method === "OPTIONS") return preflight(origin);

  const route = routeOf(url.pathname);
  if (route.name === "none") return json({ error: "Not found." }, 404, origin);

  if (route.name === "admin" || route.name === "verdicts" || route.name === "reconcile") {
    const auth = await authorize(request, env);
    if (!auth.ok) return json({ error: auth.error }, auth.status, origin);
    if (!env?.DEAD_DEALS) return json({ error: "Dead-deal API is not configured." }, 503, origin);
    if (request.method === "GET" && route.name === "admin") {
      return json(await adminView(env.DEAD_DEALS, now), 200, origin);
    }
    if (request.method === "POST" && route.name === "verdicts") {
      const body = await readJson(request);
      if (body.error) return json({ error: body.error }, 400, origin);
      const verdicts = normalizeVerdicts(body.value);
      if (!verdicts) return json({ error: "verdicts must be a list of { id, dead }." }, 400, origin);
      await applyVerdicts(env.DEAD_DEALS, verdicts, now);
      return json({ ok: true, count: verdicts.length }, 200, origin);
    }
    if (request.method === "POST" && route.name === "reconcile") {
      const body = await readJson(request);
      if (body.error) return json({ error: body.error }, 400, origin);
      const activeIds = normalizeIdList(body.value?.activeIds);
      if (!activeIds) return json({ error: "activeIds must be a list of deal ids." }, 400, origin);
      const cleared = await reconcileActive(env.DEAD_DEALS, activeIds);
      return json({ ok: true, cleared }, 200, origin);
    }
    return json({ error: "Not found." }, 404, origin);
  }

  if (!publicReady(env)) return json({ error: "Dead-deal API is not configured." }, 503, origin);

  if (request.method === "GET" && route.name === "collection") {
    const records = await publicRecords(env, request, now);
    return json(records, 200, origin);
  }
  if (request.method === "POST" && route.name === "collection") {
    const body = await readJson(request);
    if (body.error) return json({ error: body.error }, 400, origin);
    const id = body.value?.id;
    if (!validDealId(id)) return json({ error: "A deal id is required." }, 400, origin);
    const visitorId = request.headers.get("x-visitor-id");
    if (!validVisitorId(visitorId)) return json({ error: "A visitor id is required." }, 400, origin);
    const ip = clientIp(request);
    if (!ip) return json({ error: "Missing client address." }, 400, origin);
    const result = await castVote(env, { id, visitorId, ip, now });
    return json(result.body, result.status, origin, result.headers);
  }
  if (request.method === "DELETE" && route.name === "one") {
    if (!validDealId(route.id)) return json({ error: "A deal id is required." }, 400, origin);
    const visitorId = request.headers.get("x-visitor-id");
    if (!validVisitorId(visitorId)) return json({ error: "A visitor id is required." }, 400, origin);
    const result = await retractVote(env, { id: route.id, visitorId, now });
    return json(result, 200, origin);
  }
  return json({ error: "Not found." }, 404, origin);
}

function publicReady(env) {
  return Boolean(env?.DEAD_DEALS) && typeof env.IP_HASH_SALT === "string" && env.IP_HASH_SALT.length >= MIN_SECRET_LENGTH;
}

async function authorize(request, env) {
  const expected = env?.DEAD_DEALS_TOKEN;
  if (typeof expected !== "string" || expected.length < MIN_SECRET_LENGTH) {
    return { ok: false, status: 503, error: "Dead-deal API is not configured." };
  }
  const header = request.headers.get("authorization") || "";
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!(await tokenMatches(expected, presented))) return { ok: false, status: 401, error: "Unauthorized." };
  return { ok: true };
}

async function tokenMatches(expected, presented) {
  const [left, right] = await Promise.all([
    sha256Hex(`token:${expected}`),
    sha256Hex(`token:${presented}`),
  ]);
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

function routeOf(pathname) {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/api/dead-deals") return { name: "collection" };
  if (path === "/api/dead-deals/admin") return { name: "admin" };
  if (path === "/api/dead-deals/verdicts") return { name: "verdicts" };
  if (path === "/api/dead-deals/reconcile") return { name: "reconcile" };
  const prefix = "/api/dead-deals/";
  if (path.startsWith(prefix)) {
    let id = path.slice(prefix.length);
    try { id = decodeURIComponent(id); } catch { return { name: "none" }; }
    if (id && !id.includes("/")) return { name: "one", id };
  }
  return { name: "none" };
}

function allowOrigin(origin) {
  if (!origin) return "";
  if (FIXED_ORIGINS.has(origin)) return origin;
  try {
    const url = new URL(origin);
    if (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) return origin;
  } catch { /* ignore bad origin headers */ }
  return "";
}

function preflight(origin) {
  if (!origin) return new Response(null, { status: 204 });
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      "access-control-allow-headers": "Content-Type, X-Visitor-Id",
      "access-control-max-age": "86400",
      vary: "Origin",
    },
  });
}

function json(body, status, origin, extra = {}) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    vary: origin ? "Origin, X-Visitor-Id" : "X-Visitor-Id",
    ...extra,
  };
  if (origin) headers["access-control-allow-origin"] = origin;
  return new Response(JSON.stringify(body), { status, headers });
}

async function readJson(request) {
  const declared = Number(request.headers.get("content-length") || "0");
  if (declared > MAX_BODY_BYTES) return { error: "Report body is too large." };
  let text = "";
  try {
    text = await request.text();
  } catch {
    return { error: "Report body could not be read." };
  }
  if (text.length > MAX_BODY_BYTES) return { error: "Report body is too large." };
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "Report body must be a JSON object." };
    return { value };
  } catch {
    return { error: "Report body must be JSON." };
  }
}

function validDealId(id) {
  return typeof id === "string" && DEAL_ID.test(id);
}

function validVisitorId(id) {
  return typeof id === "string" && VISITOR_ID.test(id);
}

function clientIp(request) {
  const ip = request.headers.get("cf-connecting-ip");
  if (typeof ip !== "string") return "";
  const trimmed = ip.trim();
  if (!trimmed || trimmed.length > 64) return "";
  return trimmed;
}

function emptyDeal() {
  return {
    votes: {},
    verified: false,
    verifiedAt: null,
    cooldownUntil: null,
    needsVerification: false,
    reason: null,
  };
}

async function readDeal(kv, id) {
  const raw = await kv.get(`deal:${id}`);
  if (!raw) return emptyDeal();
  try {
    const parsed = JSON.parse(raw);
    const votes = parsed?.votes && typeof parsed.votes === "object" && !Array.isArray(parsed.votes) ? parsed.votes : {};
    const cleanVotes = {};
    for (const [key, value] of Object.entries(votes)) {
      if (typeof key === "string" && typeof value === "string") cleanVotes[key] = value;
    }
    return {
      votes: cleanVotes,
      verified: parsed?.verified === true,
      verifiedAt: typeof parsed?.verifiedAt === "string" ? parsed.verifiedAt : null,
      cooldownUntil: typeof parsed?.cooldownUntil === "string" ? parsed.cooldownUntil : null,
      needsVerification: parsed?.needsVerification === true,
      reason: typeof parsed?.reason === "string" ? parsed.reason : null,
    };
  } catch {
    return emptyDeal();
  }
}

async function writeDeal(kv, id, deal) {
  await kv.put(`deal:${id}`, JSON.stringify(deal));
}

async function readVisitor(kv, visitorHash) {
  const raw = await kv.get(`visitor:${visitorHash}`);
  if (!raw) return { votes: {} };
  try {
    const parsed = JSON.parse(raw);
    const votes = parsed?.votes && typeof parsed.votes === "object" ? parsed.votes : {};
    const clean = {};
    for (const [key, value] of Object.entries(votes)) {
      if (validDealId(key) && typeof value === "string") clean[key] = value;
    }
    return { votes: clean };
  } catch {
    return { votes: {} };
  }
}

async function writeVisitor(kv, visitorHash, record) {
  await kv.put(`visitor:${visitorHash}`, JSON.stringify(record));
}

async function readIndex(kv, name) {
  const raw = await kv.get(name);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(validDealId) : [];
  } catch {
    return [];
  }
}

async function writeIndex(kv, name, ids) {
  await kv.put(name, JSON.stringify([...new Set(ids)].slice(-MAX_INDEX)));
}

function cooldownActive(deal, now) {
  if (!deal.cooldownUntil) return false;
  const until = Date.parse(deal.cooldownUntil);
  return Number.isFinite(until) && until > now.getTime();
}

function voteCount(deal) {
  return Object.keys(deal.votes).length;
}

async function hashesFor(env, visitorId, ip) {
  const visitorHash = await sha256Hex(`${env.IP_HASH_SALT}:browser:${visitorId}`);
  const ipHash = ip ? await sha256Hex(`${env.IP_HASH_SALT}:ip:${ip}`) : "";
  return { visitorHash, ipHash };
}

async function publicRecords(env, request, now) {
  const kv = env.DEAD_DEALS;
  const verified = await loadVerified(kv);
  const byId = new Map();
  for (const entry of verified) {
    byId.set(entry.id, {
      id: entry.id,
      reportedAt: entry.verifiedAt || now.toISOString(),
      source: "api",
      verified: true,
    });
  }
  const visitorId = request.headers.get("x-visitor-id");
  if (!validVisitorId(visitorId)) return [...byId.values()];
  const { visitorHash } = await hashesFor(env, visitorId, "");
  const visitor = await readVisitor(kv, visitorHash);
  for (const [id, reportedAt] of Object.entries(visitor.votes)) {
    if (byId.has(id)) continue;
    const deal = await readDeal(kv, id);
    if (deal.verified) {
      byId.set(id, {
        id,
        reportedAt: deal.verifiedAt || reportedAt,
        source: "api",
        verified: true,
      });
      continue;
    }
    byId.set(id, { id, reportedAt, source: "api", verified: false });
  }
  return [...byId.values()];
}

async function castVote(env, { id, visitorId, ip, now }) {
  const kv = env.DEAD_DEALS;
  const { visitorHash, ipHash } = await hashesFor(env, visitorId, ip);
  const deal = await readDeal(kv, id);
  if (deal.verified) {
    return { status: 200, body: publicVerified(id, deal) };
  }
  if (cooldownActive(deal, now)) {
    return {
      status: 200,
      body: {
        id,
        reportedAt: now.toISOString(),
        source: "api",
        verified: false,
        accepted: false,
        reason: "cooldown",
      },
    };
  }
  if (deal.votes[visitorHash]) {
    return { status: 200, body: voteBody(id, deal.votes[visitorHash], deal) };
  }
  if (voteCount(deal) >= MAX_VOTES) {
    return { status: 200, body: { ...voteBody(id, now.toISOString(), deal), accepted: false, reason: "full" } };
  }
  const limited = await rateLimit(kv, { visitorHash, ipHash, now });
  if (!limited.ok) {
    return {
      status: 429,
      headers: { "retry-after": "3600" },
      body: { error: "Too many reports from this browser. Try again later." },
    };
  }
  const reportedAt = now.toISOString();
  deal.votes[visitorHash] = reportedAt;
  if (voteCount(deal) >= REPORT_THRESHOLD) deal.needsVerification = true;
  await writeDeal(kv, id, deal);
  const visitor = await readVisitor(kv, visitorHash);
  visitor.votes[id] = reportedAt;
  await writeVisitor(kv, visitorHash, visitor);
  if (deal.needsVerification) {
    const pending = await readIndex(kv, "idx:pending");
    if (!pending.includes(id)) await writeIndex(kv, "idx:pending", [...pending, id]);
  }
  return { status: 201, body: voteBody(id, reportedAt, deal) };
}

function voteBody(id, reportedAt, deal) {
  return {
    id,
    reportedAt,
    source: "api",
    verified: false,
    count: voteCount(deal),
    threshold: REPORT_THRESHOLD,
    pending: deal.needsVerification === true && voteCount(deal) >= REPORT_THRESHOLD,
  };
}

function publicVerified(id, deal) {
  return {
    id,
    reportedAt: deal.verifiedAt,
    source: "api",
    verified: true,
  };
}

async function rateLimit(kv, { visitorHash, ipHash, now }) {
  const hour = now.toISOString().slice(0, 13);
  const day = now.toISOString().slice(0, 10);
  const buckets = [
    [`rl:b:h:${visitorHash}:${hour}`, VISITOR_HOUR_LIMIT],
    [`rl:b:d:${visitorHash}:${day}`, VISITOR_DAY_LIMIT],
    [`rl:i:h:${ipHash}:${hour}`, IP_HOUR_LIMIT],
    [`rl:i:d:${ipHash}:${day}`, IP_DAY_LIMIT],
  ];
  const counts = [];
  for (const [key, limit] of buckets) {
    const count = Number(await kv.get(key) || "0");
    if (!Number.isFinite(count) || count >= limit) return { ok: false };
    counts.push([key, count]);
  }
  for (const [key, count] of counts) {
    // Two days covers the daily bucket. Deal records themselves are not expired.
    await kv.put(key, String(count + 1), { expirationTtl: 172800 });
  }
  return { ok: true };
}

async function retractVote(env, { id, visitorId, now }) {
  const kv = env.DEAD_DEALS;
  const { visitorHash } = await hashesFor(env, visitorId, "");
  const deal = await readDeal(kv, id);
  const visitor = await readVisitor(kv, visitorHash);
  if (!deal.votes[visitorHash] && !visitor.votes[id]) {
    if (deal.verified) return publicVerified(id, deal);
    return { id, removed: false, verified: false, reportedAt: now.toISOString(), source: "api" };
  }
  delete deal.votes[visitorHash];
  delete visitor.votes[id];
  if (!deal.verified && voteCount(deal) < REPORT_THRESHOLD) deal.needsVerification = false;
  await writeDeal(kv, id, deal);
  await writeVisitor(kv, visitorHash, visitor);
  if (!deal.needsVerification) {
    const pending = await readIndex(kv, "idx:pending");
    if (pending.includes(id)) await writeIndex(kv, "idx:pending", pending.filter((entry) => entry !== id));
  }
  if (deal.verified) return publicVerified(id, deal);
  return { id, removed: true, verified: false, reportedAt: now.toISOString(), source: "api" };
}

async function clearVisitorVotes(kv, deal, id) {
  for (const visitorHash of Object.keys(deal.votes)) {
    const visitor = await readVisitor(kv, visitorHash);
    if (visitor.votes[id]) {
      delete visitor.votes[id];
      await writeVisitor(kv, visitorHash, visitor);
    }
  }
  deal.votes = {};
}

async function applyVerdicts(kv, verdicts, now) {
  let pending = await readIndex(kv, "idx:pending");
  let verified = await readIndex(kv, "idx:verified");
  for (const verdict of verdicts) {
    const deal = await readDeal(kv, verdict.id);
    await clearVisitorVotes(kv, deal, verdict.id);
    deal.needsVerification = false;
    deal.reason = verdict.reason || null;
    pending = pending.filter((entry) => entry !== verdict.id);
    if (verdict.dead) {
      deal.verified = true;
      deal.verifiedAt = now.toISOString();
      deal.cooldownUntil = null;
      if (!verified.includes(verdict.id)) verified.push(verdict.id);
    } else {
      deal.verified = false;
      deal.verifiedAt = null;
      deal.cooldownUntil = new Date(now.getTime() + COOLDOWN_MS).toISOString();
      verified = verified.filter((entry) => entry !== verdict.id);
    }
    await writeDeal(kv, verdict.id, deal);
  }
  await writeIndex(kv, "idx:pending", pending);
  await writeIndex(kv, "idx:verified", verified);
}

async function reconcileActive(kv, activeIds) {
  const active = new Set(activeIds);
  let verified = await readIndex(kv, "idx:verified");
  let cleared = 0;
  for (const id of [...verified]) {
    if (!active.has(id)) continue;
    const deal = await readDeal(kv, id);
    if (!deal.verified) continue;
    deal.verified = false;
    deal.verifiedAt = null;
    deal.cooldownUntil = null;
    deal.needsVerification = false;
    deal.reason = null;
    await writeDeal(kv, id, deal);
    verified = verified.filter((entry) => entry !== id);
    cleared += 1;
  }
  await writeIndex(kv, "idx:verified", verified);
  return cleared;
}

function isPending(deal, now) {
  if (deal.verified || cooldownActive(deal, now)) return false;
  return deal.needsVerification === true && voteCount(deal) >= REPORT_THRESHOLD;
}

async function loadPending(kv, now) {
  const ids = await readIndex(kv, "idx:pending");
  const pending = [];
  const keep = [];
  for (const id of ids) {
    const deal = await readDeal(kv, id);
    if (!isPending(deal, now)) continue;
    const times = Object.values(deal.votes).sort();
    pending.push({ id, count: voteCount(deal), reportedAt: times[0] || null });
    keep.push(id);
  }
  if (keep.length !== ids.length) await writeIndex(kv, "idx:pending", keep);
  return pending;
}

async function loadVerified(kv) {
  const ids = await readIndex(kv, "idx:verified");
  const verified = [];
  const keep = [];
  for (const id of ids) {
    const deal = await readDeal(kv, id);
    if (!deal.verified) continue;
    verified.push({ id, verifiedAt: deal.verifiedAt, reason: deal.reason });
    keep.push(id);
  }
  if (keep.length !== ids.length) await writeIndex(kv, "idx:verified", keep);
  return verified;
}

async function adminView(kv, now) {
  return {
    pending: await loadPending(kv, now),
    verified: await loadVerified(kv),
    threshold: REPORT_THRESHOLD,
    cooldownHours: COOLDOWN_MS / 3600000,
  };
}

function normalizeVerdicts(value) {
  const list = value?.verdicts;
  if (!Array.isArray(list) || list.length > 100) return null;
  const verdicts = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object" || !validDealId(entry.id) || typeof entry.dead !== "boolean") return null;
    const reason = typeof entry.reason === "string" && entry.reason.length <= 40 ? entry.reason : null;
    verdicts.push({ id: entry.id, dead: entry.dead, reason });
  }
  return verdicts;
}

function normalizeIdList(value) {
  if (!Array.isArray(value) || value.length > 1000) return null;
  const ids = [];
  for (const id of value) {
    if (!validDealId(id)) return null;
    ids.push(id);
  }
  return ids;
}
