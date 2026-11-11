/**
 * Dead-deal reports for RawDeals.
 *
 * The page keeps an instant copy in this browser. When the shared API is up,
 * report() and retract() also talk to it, and list() treats the API as the
 * source of truth for verified deals. If the API is down or not deployed yet,
 * those three methods keep working from localStorage alone.
 *
 * Local record:
 *   { id: string, reportedAt: ISO-8601 string, source: "local" }
 *
 * Shared record:
 *   { id, reportedAt, source: "api", verified: boolean }
 *
 * Storage key: rawdeals.deadReports.v1
 * Visitor key: rawdeals.visitor.v1
 *
 *   GET    /api/dead-deals
 *   POST   /api/dead-deals      { id }
 *   DELETE /api/dead-deals/:id
 */

export const DEAD_REPORTS_KEY = "rawdeals.deadReports.v1";
export const VISITOR_KEY = "rawdeals.visitor.v1";
export const DEAD_DEALS_API_ORIGIN = "https://api.getrawdeals.com";
const LOCAL_SYNC_LIMIT = 6;
const VISITOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function memoryStorage() {
  const data = new Map();
  return {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
  };
}

function browserStorage() {
  try {
    if (typeof localStorage === "undefined") return memoryStorage();
    const probe = "__rawdeals_probe__";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return memoryStorage();
  }
}

export function createDeadDealStore(storage = browserStorage(), key = DEAD_REPORTS_KEY) {
  function read() {
    try {
      const raw = storage.getItem(key);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((record) => record && typeof record.id === "string" && record.id);
    } catch {
      return [];
    }
  }

  function write(records) {
    storage.setItem(key, JSON.stringify(records));
  }

  return {
    key,
    async list() {
      return read();
    },
    async report(id, now = new Date()) {
      if (typeof id !== "string" || !id) {
        throw new Error("A deal id is required");
      }
      const records = read();
      const existing = records.find((record) => record.id === id);
      if (existing) return existing;
      const record = {
        id,
        reportedAt: now.toISOString(),
        source: "local",
      };
      records.push(record);
      write(records);
      return record;
    },
    async retract(id) {
      write(read().filter((record) => record.id !== id));
    },
  };
}

export function mergeReports(localRecords, remoteRecords) {
  const byId = new Map();
  for (const record of localRecords || []) {
    if (!record || typeof record.id !== "string" || !record.id) continue;
    byId.set(record.id, {
      id: record.id,
      reportedAt: record.reportedAt,
      source: record.source === "api" ? "api" : "local",
      verified: record.verified === true,
    });
  }
  for (const record of remoteRecords || []) {
    if (!record || typeof record.id !== "string" || !record.id) continue;
    const existing = byId.get(record.id);
    if (record.verified === true) {
      byId.set(record.id, {
        id: record.id,
        reportedAt: record.reportedAt || existing?.reportedAt,
        source: "api",
        verified: true,
      });
      continue;
    }
    if (!existing) {
      byId.set(record.id, {
        id: record.id,
        reportedAt: record.reportedAt,
        source: "api",
        verified: false,
      });
    }
  }
  return [...byId.values()];
}

function randomVisitorId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function readVisitorId(storage) {
  try {
    const existing = storage.getItem(VISITOR_KEY);
    if (typeof existing === "string" && VISITOR_ID.test(existing)) return existing;
    const id = randomVisitorId();
    storage.setItem(VISITOR_KEY, id);
    return id;
  } catch {
    return randomVisitorId();
  }
}

function apiOrigin(apiBase) {
  return String(apiBase || DEAD_DEALS_API_ORIGIN).replace(/\/+$/, "");
}

/**
 * Local store plus the shared API. Network failures leave the local record in place.
 */
export function createSharedDeadDealStore({
  storage = browserStorage(),
  key = DEAD_REPORTS_KEY,
  fetchImpl = globalThis.fetch,
  apiBase = DEAD_DEALS_API_ORIGIN,
  timeoutMs = 4000,
} = {}) {
  const local = createDeadDealStore(storage, key);
  const origin = apiOrigin(apiBase);
  const visitorId = readVisitorId(storage);

  async function request(path, { method = "GET", body } = {}) {
    const signal = typeof AbortSignal !== "undefined" && AbortSignal.timeout
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
    return fetchImpl(`${origin}${path}`, {
      method,
      headers: {
        accept: "application/json",
        "x-visitor-id": visitorId,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal,
      cache: "no-store",
    });
  }

  async function remoteList() {
    const response = await request("/api/dead-deals");
    if (!response?.ok) throw new Error("Dead-deal list failed.");
    const body = await response.json();
    const records = Array.isArray(body) ? body : body?.deals;
    if (!Array.isArray(records)) throw new Error("Dead-deal list was not a list.");
    return records;
  }

  async function postReport(id) {
    const response = await request("/api/dead-deals", { method: "POST", body: { id } });
    if (!response) throw new Error("Dead-deal report failed.");
    if (response.status === 429) {
      const error = new Error("Dead-deal report was rate limited.");
      error.rateLimited = true;
      throw error;
    }
    if (!response.ok) throw new Error("Dead-deal report failed.");
    return response.json();
  }

  return {
    key,
    visitorId,
    async list() {
      const localRecords = await local.list();
      let remote;
      try {
        remote = await remoteList();
      } catch {
        return localRecords;
      }
      const merged = mergeReports(localRecords, remote);
      const known = new Set(remote.map((record) => record && record.id));
      let synced = 0;
      for (const record of localRecords) {
        if (!record?.id || known.has(record.id) || synced >= LOCAL_SYNC_LIMIT) continue;
        synced += 1;
        try {
          const posted = await postReport(record.id);
          if (posted?.verified === true) {
            const index = merged.findIndex((entry) => entry.id === record.id);
            const next = {
              id: record.id,
              reportedAt: posted.reportedAt || record.reportedAt,
              source: "api",
              verified: true,
            };
            if (index === -1) merged.push(next);
            else merged[index] = next;
          }
        } catch {
          break;
        }
      }
      return merged;
    },
    async report(id, now = new Date()) {
      const record = await local.report(id, now);
      try {
        const posted = await postReport(id);
        if (posted?.verified === true) {
          return {
            id: record.id,
            reportedAt: posted.reportedAt || record.reportedAt,
            source: "api",
            verified: true,
          };
        }
      } catch {
        /* the local report is already saved */
      }
      return record;
    },
    async retract(id) {
      await local.retract(id);
      try {
        const response = await request(`/api/dead-deals/${encodeURIComponent(id)}`, { method: "DELETE" });
        if (!response?.ok) return null;
        const body = await response.json();
        if (body?.verified === true) {
          return {
            id,
            reportedAt: body.reportedAt,
            source: "api",
            verified: true,
          };
        }
      } catch {
        /* the local undo is already saved */
      }
      return null;
    },
  };
}
