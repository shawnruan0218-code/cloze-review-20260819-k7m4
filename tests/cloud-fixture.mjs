import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import { mergeRecord } from "../worker/src/index.js";

export const namespace = "cloze-review-chapter-test";
const source = fs.readFileSync(new URL("../cloud-sync.js", import.meta.url), "utf8");

export function syncServer() {
  const records = new Map();
  const changes = [];
  return {
    records,
    fetch: async (address, options = {}) => {
      const url = new URL(address);
      let data;
      if (url.pathname === "/api/auth/session") data = { user: { id: "test", login: "test" } };
      if (url.pathname === "/api/sync/push") {
        const accepted = [];
        for (const incoming of JSON.parse(options.body).records) {
          const id = `${incoming.entityType}:${incoming.itemKey}`;
          if (mergeRecord(records.get(id), incoming) !== incoming) continue;
          records.set(id, incoming);
          changes.push({ ...incoming, seq: changes.length + 1 });
          accepted.push(id);
        }
        data = { accepted };
      }
      if (url.pathname === "/api/sync/pull") {
        const cursor = Number(url.searchParams.get("cursor") || 0);
        const page = changes.filter((row) => row.seq > cursor).slice(0, Number(url.searchParams.get("limit")));
        data = { records: page, cursor: page.at(-1)?.seq || cursor, hasMore: false };
      }
      if (!data) throw new Error(`Unexpected request: ${url.pathname}`);
      return { ok: true, json: async () => data };
    },
  };
}

export async function cloudFixture({ indexedDB = new IDBFactory(), library = {}, server = null } = {}) {
  if (server) {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(`${namespace}-idb`, 1);
      request.onupgradeneeded = () => {
        for (const [name, keyPath] of [["records", "id"], ["dirty", "id"], ["meta", "key"]]) request.result.createObjectStore(name, { keyPath });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("meta", "readwrite");
      tx.objectStore("meta").put({ key: "session", value: { token: "test-token", user: { id: "test", login: "test" } } });
      tx.oncomplete = resolve;
      tx.onerror = reject;
    });
    db.close();
  }
  let currentLibrary = structuredClone(library);
  const annotations = {};
  const status = [];
  const sessionStorage = new Map();
  const context = vm.createContext({
    console, indexedDB, crypto: webcrypto, TextEncoder, URL, Date,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    addEventListener() {}, document: { hidden: false, addEventListener() {} },
    navigator: { onLine: true },
    sessionStorage: {
      getItem: (key) => sessionStorage.get(key) ?? null,
      setItem: (key, value) => sessionStorage.set(key, value),
    },
    location: { href: "https://test.invalid/" },
    window: { CLOZE_CLOUD_CONFIG: { namespace, apiBase: server ? "https://sync.invalid" : "" } },
    fetch: server?.fetch || (() => { throw new Error("Offline test made a request"); }),
  });
  vm.runInContext(source, context);
  const cloud = context.window.ClozeCloudSync;
  await cloud.init({
    getLibrary: () => currentLibrary,
    getAnnotations: () => annotations,
    applyRemote: (records) => {
      for (const row of records) {
        const target = row.entityType === "annotation" ? annotations : currentLibrary;
        if (row.deletedAt) delete target[row.itemKey];
        else target[row.itemKey] = row.payload;
      }
    },
    onStatus: (entry) => status.push(entry),
  });
  return { cloud, indexedDB, status, library: () => currentLibrary };
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export async function signBackup(envelope) {
  const { checksum, ...unsigned } = envelope;
  const bytes = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(stableJson(unsigned)));
  return { ...unsigned, checksum: Buffer.from(bytes).toString("hex") };
}
