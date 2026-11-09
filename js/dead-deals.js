/**
 * Dead-deal reports for RawDeals.
 *
 * v1 stores reports only in this browser. Nothing is sent to Eddie or to a server.
 * Each report has this shape:
 *   { id: string, reportedAt: ISO-8601 string, source: "local" }
 *
 * Storage key: rawdeals.deadReports.v1
 * Value: a JSON array of those reports.
 *
 * The page only calls list(), report(), and retract(). To plug in a shared
 * backend later, replace those three methods with requests that use the same
 * record shape (set source to "api"). A natural fit:
 *   GET    /api/dead-deals
 *   POST   /api/dead-deals      { id }
 *   DELETE /api/dead-deals/:id
 */

export const DEAD_REPORTS_KEY = "rawdeals.deadReports.v1";

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
