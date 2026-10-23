(() => {
  const config = window.CLOZE_CLOUD_CONFIG || {};
  const namespace = String(config.namespace || "cloze-review-20260819-k7m4");
  const DB_NAME = `${namespace}-idb`;
  const AUTH_CODE_PARAM = `${namespace}_auth_code`;
  const CLIENT_VERSION = String(config.protocolVersion || 2);
  const PUSH_BATCH = 100;
  const PULL_PAGE = 500;
  const MAX_PULL_PAGES = 50;
  const IDLE_MS = 5 * 60_000;
  let dbPromise;
  let hooks;
  let session = null;
  let syncPromise = null;
  let rerun = false;
  let debounceTimer = null;
  let backoffUntil = 0;
  let failures = 0;
  let idleTimer = null;
  let pendingWrite = Promise.resolve();
  const clientId = getClientId();
  const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(`${namespace}-sync`) : null;

  window.ClozeCloudSync = {
    configured: Boolean(config.apiBase && !String(config.apiBase).includes("REPLACE_")),
    init,
    login,
    logout,
    syncNow: (reason = "manual") => requestSync(reason, true),
    enqueueReview,
    enqueueAnnotation,
    exportBackup,
    importBackup,
    diagnostics,
    getSession: () => session,
  };

  async function init(nextHooks) {
    hooks = nextHooks;
    await openDb();
    await migrateLegacyOnce();
    const db = await openDb();
    const cached = await requestToPromise(db.transaction("records").objectStore("records").getAll());
    if (cached.length) hooks.applyRemote(cached);
    session = await metaGet("session");
    await finishOAuthIfPresent();
    bindLifecycle();
    if (session) {
      try {
        const restored = await api("/api/auth/session");
        session = { ...session, ...restored };
        await metaSet("session", session);
        notify("ready", `GitHub @${session.user.login}`);
        requestSync("startup", true);
      } catch (error) {
        if (error.status === 401) {
          session = null;
          await metaDelete("session");
          notify("signed-out", "登录已过期，请重新登录");
        } else {
          notify("offline", "本地已保存，云同步暂不可用");
        }
      }
    } else {
      notify("signed-out", "使用 GitHub 登录后同步手机和电脑");
    }
    return session;
  }

  function login() {
    if (!window.ClozeCloudSync.configured) return notify("offline", "云端地址尚未部署");
    const target = `${apiBase()}/api/auth/github/start?return_url=${encodeURIComponent(location.href.split("?")[0])}`;
    location.assign(target);
  }

  async function logout() {
    try { if (session) await api("/api/auth/logout", { method: "POST", body: "{}" }); } catch {}
    session = null;
    await Promise.all([metaDelete("session"), metaDelete("cursor")]);
    notify("signed-out", "已退出，当前设备仍保留全部复习数据");
  }

  async function finishOAuthIfPresent() {
    const url = new URL(location.href);
    const code = url.searchParams.get(AUTH_CODE_PARAM);
    if (!code) return;
    try {
      const result = await api("/api/auth/exchange", {
        method: "POST",
        body: JSON.stringify({ code }),
        anonymous: true,
      });
      session = result;
      await metaSet("session", result);
      notify("ready", `GitHub @${result.user.login}`);
    } finally {
      url.searchParams.delete(AUTH_CODE_PARAM);
      history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
  }

  async function migrateLegacyOnce() {
    if (await metaGet("legacy-migrated-v1")) return;
    const library = hooks.getLibrary();
    const annotations = hooks.getAnnotations();
    const records = [];
    Object.entries(library).forEach(([itemKey, item]) => {
      const timestamp = validTime(item.updatedAt || item.addedAt) || new Date().toISOString();
      records.push(makeRecord("review_item", itemKey, { ...item }, timestamp, null, item.addedAt || timestamp, "legacy-localStorage"));
    });
    Object.values(annotations).forEach((annotation) => {
      const timestamp = validTime(annotation.updatedAt || annotation.createdAt) || new Date().toISOString();
      records.push(makeRecord("annotation", annotation.id, { ...annotation }, timestamp,
        annotation.deletedAt || null, annotation.createdAt || timestamp, "legacy-localStorage"));
    });
    await putLocalRecords(records, true);
    await metaSet("legacy-migrated-v1", {
      at: new Date().toISOString(),
      reviewItems: Object.keys(library).length,
      annotations: Object.keys(annotations).length,
      sourceKeysPreserved: true,
    });
  }

  function enqueueReview(action, item, itemKey) {
    const now = new Date().toISOString();
    const deletedAt = action === "delete" ? now : null;
    const payload = { ...item, updatedAt: action === "delete" ? (item.updatedAt || now) : (item.updatedAt || now) };
    const record = makeRecord("review_item", itemKey, payload, payload.updatedAt, deletedAt,
      item.addedAt || now, "client");
    return queueLocalRecord(record);
  }

  function enqueueAnnotation(annotation) {
    const now = new Date().toISOString();
    const record = makeRecord("annotation", annotation.id, { ...annotation },
      annotation.updatedAt || now, annotation.deletedAt || null, annotation.createdAt || now, "client");
    return queueLocalRecord(record);
  }

  function queueLocalRecord(record) {
    pendingWrite = pendingWrite.catch(() => {}).then(() => putLocalRecords([record], true));
    pendingWrite.then(
      () => requestSync("local-change"),
      () => notify("offline", "本机保存失败，请导出备份后检查存储空间")
    );
    return pendingWrite;
  }

  function requestSync(reason, immediate = false) {
    if (!session || !window.ClozeCloudSync.configured || !navigator.onLine || document.hidden) return;
    clearTimeout(debounceTimer);
    if (immediate) return runAsLeader(reason);
    debounceTimer = setTimeout(() => runAsLeader(reason), 2000);
  }

  async function runAsLeader(reason) {
    if (navigator.locks?.request) {
      return navigator.locks.request(`${namespace}-sync-leader`, { ifAvailable: true }, (lock) => lock ? synchronize(reason) : undefined);
    }
    channel?.postMessage({ type: "sync-intent", clientId, at: Date.now() });
    return synchronize(reason);
  }

  async function synchronize(reason) {
    if (syncPromise) {
      rerun = true;
      return syncPromise;
    }
    if (!session || Date.now() < backoffUntil || document.hidden || !navigator.onLine) return;
    syncPromise = performSync(reason).finally(async () => {
      syncPromise = null;
      if (rerun) {
        rerun = false;
        requestSync("queued-change", true);
      }
    });
    return syncPromise;
  }

  async function performSync(reason) {
    notify("syncing", "正在增量同步");
    let pushed = 0;
    let pulled = 0;
    let pages = 0;
    try {
      await pendingWrite;
      while (true) {
        const dirty = await dirtyList(PUSH_BATCH);
        if (!dirty.length) break;
        const result = await api("/api/sync/push", {
          method: "POST",
          body: JSON.stringify({ records: dirty.map(({ id, ...record }) => record) }),
        });
        const accepted = new Set(result.accepted || []);
        await clearAcceptedDirty(dirty, accepted);
        pushed += accepted.size;
        if (!accepted.size && dirty.length) break;
      }

      let cursor = Number(await metaGet("cursor") || 0);
      for (; pages < MAX_PULL_PAGES; pages += 1) {
        const page = await api(`/api/sync/pull?cursor=${cursor}&limit=${PULL_PAGE}`);
        await applyRemotePage(page.records || []);
        cursor = Number(page.cursor || cursor);
        await metaSet("cursor", cursor);
        pulled += (page.records || []).length;
        if (!page.hasMore) break;
      }
      if (pages >= MAX_PULL_PAGES) throw Object.assign(new Error("同步分页超过安全上限"), { code: "page_limit" });
      failures = 0;
      backoffUntil = 0;
      await logSync({ reason, pushed, pulled, pages: pages + 1, cursor, error: null });
      notify("ready", `所有篇章已同步，共 ${Object.keys(hooks.getLibrary()).length} 个词条`);
      channel?.postMessage({ type: "synced", clientId, cursor, at: Date.now() });
    } catch (error) {
      failures += 1;
      const quota = [402, 429, 1027].includes(Number(error.status)) || /quota|limit/i.test(error.code || "");
      const delay = quota ? 30 * 60_000 : Math.min(5 * 60_000, 2000 * (2 ** Math.min(failures, 7))) + Math.random() * 1500;
      backoffUntil = Date.now() + delay;
      await logSync({ reason, pushed, pulled, pages, cursor: await metaGet("cursor") || 0, error: error.code || "network" });
      notify("offline", quota ? "本地已保存，云同步因配额限制暂时暂停" : "本地已保存，稍后自动重试云同步");
      if (!quota) setTimeout(() => requestSync("backoff-retry", true), delay);
    }
  }

  async function applyRemotePage(records) {
    const applied = [];
    const db = await openDb();
    for (const remote of records) {
      const normalized = { ...remote, id: recordId(remote.entityType, remote.itemKey) };
      const local = await requestToPromise(db.transaction("records").objectStore("records").get(normalized.id));
      const winner = chooseWinner(local, normalized);
      if (winner === normalized || !local) {
        await putLocalRecords([normalized], false);
        await clearDirtyIfNotNewer(normalized);
        applied.push(normalized);
      }
    }
    if (applied.length) hooks.applyRemote(applied);
  }

  async function putLocalRecords(records, markDirty) {
    if (!records.length) return;
    const db = await openDb();
    const tx = db.transaction(markDirty ? ["records", "dirty"] : ["records"], "readwrite");
    for (const record of records) {
      const normalized = { ...record, id: recordId(record.entityType, record.itemKey) };
      tx.objectStore("records").put(normalized);
      if (markDirty) tx.objectStore("dirty").put(normalized);
    }
    await transactionDone(tx);
  }

  async function dirtyList(limit) {
    const db = await openDb();
    const all = await requestToPromise(db.transaction("dirty").objectStore("dirty").getAll());
    return all.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).slice(0, limit);
  }

  async function clearAcceptedDirty(batch, accepted) {
    const db = await openDb();
    const tx = db.transaction("dirty", "readwrite");
    for (const record of batch) {
      const key = `${record.entityType}:${record.itemKey}`;
      if (!accepted.has(key)) continue;
      const current = await requestToPromise(tx.objectStore("dirty").get(record.id));
      if (current && sameRecordVersion(current, record)) tx.objectStore("dirty").delete(record.id);
    }
    await transactionDone(tx);
  }

  async function clearDirtyIfNotNewer(remote) {
    const db = await openDb();
    const tx = db.transaction("dirty", "readwrite");
    const store = tx.objectStore("dirty");
    const dirty = await requestToPromise(store.get(remote.id));
    if (dirty && chooseWinner(dirty, remote) === remote) store.delete(remote.id);
    await transactionDone(tx);
  }

  function sameRecordVersion(left, right) {
    return left.updatedAt === right.updatedAt &&
      left.payloadVersion === right.payloadVersion &&
      left.deletedAt === right.deletedAt &&
      left.clientId === right.clientId &&
      stableJson(left.payload) === stableJson(right.payload);
  }

  function makeRecord(entityType, itemKey, payload, updatedAt, deletedAt, createdAt, source) {
    return {
      id: recordId(entityType, itemKey), entityType, itemKey, payload, payloadVersion: 1,
      updatedAt: validTime(updatedAt) || new Date().toISOString(), deletedAt: deletedAt || null,
      createdAt: validTime(createdAt) || validTime(updatedAt) || new Date().toISOString(), source, clientId,
    };
  }

  function chooseWinner(local, remote) {
    if (!local) return remote;
    const time = remote.updatedAt.localeCompare(local.updatedAt);
    if (time !== 0) return time > 0 ? remote : local;
    if (remote.payloadVersion !== local.payloadVersion) return remote.payloadVersion > local.payloadVersion ? remote : local;
    return `${remote.clientId}\u0000${stableJson(remote.payload)}\u0000${remote.deletedAt || ""}` >=
      `${local.clientId}\u0000${stableJson(local.payload)}\u0000${local.deletedAt || ""}` ? remote : local;
  }

  async function exportBackup() {
    await pendingWrite;
    const db = await openDb();
    const records = await requestToPromise(db.transaction("records").objectStore("records").getAll());
    const envelope = {
      format: "cloze-review-backup", version: 3, namespace,
      exportedAt: new Date().toISOString(), records,
      counts: records.reduce((counts, row) => ({ ...counts, [row.entityType]: (counts[row.entityType] || 0) + 1 }), {}),
      chapters: records.reduce((counts, row) => {
        if (row.entityType !== "review_item" || row.deletedAt) return counts;
        const match = row.itemKey.match(/::review-chapter-([2-5])$/);
        const chapter = match ? Number(match[1]) : Number(row.payload.reviewChapter || 1);
        counts[chapter] = (counts[chapter] || 0) + 1;
        return counts;
      }, { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }),
    };
    envelope.checksum = await checksum(stableJson(envelope));
    return envelope;
  }

  async function importBackup(envelope) {
    if (envelope?.format !== "cloze-review-backup" || envelope.namespace !== namespace || !Array.isArray(envelope.records)) {
      throw new Error("备份格式或项目标识不匹配");
    }
    const { checksum: expected, ...unsigned } = envelope;
    if (expected !== await checksum(stableJson(unsigned))) throw new Error("备份校验失败");
    if (![2, 3].includes(envelope.version)) throw new Error("请更新软件以导入此版本的备份");
    const staged = new Map();
    for (const row of envelope.records) {
      if (!row || !["review_item", "annotation", "setting"].includes(row.entityType) ||
          typeof row.itemKey !== "string" || !row.itemKey || !row.payload ||
          typeof row.payload !== "object" || Array.isArray(row.payload) ||
          !validTime(row.updatedAt) || (row.deletedAt && !validTime(row.deletedAt))) {
        throw new Error("备份包含无效记录");
      }
      const normalized = { ...row, id: recordId(row.entityType, row.itemKey) };
      staged.set(normalized.id, chooseWinner(staged.get(normalized.id), normalized));
    }
    await pendingWrite;
    const db = await openDb();
    const current = new Map((await requestToPromise(db.transaction("records").objectStore("records").getAll()))
      .map((row) => [row.id, row]));
    const applied = [...staged.values()].filter((row) => chooseWinner(current.get(row.id), row) === row);
    await putLocalRecords(applied, true);
    hooks.applyRemote(applied);
    requestSync("backup-import");
  }

  async function diagnostics() {
    const local = await metaGet(`requests:${new Date().toISOString().slice(0, 10)}`) || { count: 0 };
    const remote = session ? await api("/api/diagnostics") : null;
    return { local, remote };
  }

  function bindLifecycle() {
    addEventListener("online", () => requestSync("online", true));
    addEventListener("focus", () => requestSync("focus"));
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) requestSync("visible");
    });
    clearInterval(idleTimer);
    idleTimer = setInterval(() => {
      if (!document.hidden && session) requestSync("idle-fallback", true);
    }, IDLE_MS);
    channel?.addEventListener("message", (event) => {
      if (event.data?.type === "synced" && event.data.clientId !== clientId) notify("ready", "其他标签页已完成同步");
    });
  }

  async function api(path, options = {}) {
    const headers = { "Content-Type": "application/json", "X-Cloze-Client-Version": CLIENT_VERSION, ...(options.headers || {}) };
    if (!options.anonymous && session?.token) headers.Authorization = `Bearer ${session.token}`;
    await countRequest(path);
    let response;
    try {
      response = await fetch(`${apiBase()}${path}`, { ...options, headers });
    } catch (error) {
      throw Object.assign(error, { code: "network_error" });
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.message || "云同步失败"), { status: response.status, code: data.error });
    return data;
  }

  function apiBase() { return String(config.apiBase || "").replace(/\/$/, ""); }
  function notify(kind, message) { hooks?.onStatus?.({ kind, message, session }); }
  function recordId(type, key) { return `${type}:${key}`; }
  function validTime(value) { return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null; }
  function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
    return JSON.stringify(value);
  }
  async function checksum(value) {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  function getClientId() {
    const key = `${namespace}-client-id`;
    let value = sessionStorage.getItem(key);
    if (!value) {
      value = crypto.randomUUID();
      sessionStorage.setItem(key, value);
    }
    return value;
  }

  async function countRequest(path) {
    const day = new Date().toISOString().slice(0, 10);
    const current = await metaGet(`requests:${day}`) || { count: 0, paths: {} };
    current.count += 1;
    const group = path.split("?")[0];
    current.paths[group] = (current.paths[group] || 0) + 1;
    await metaSet(`requests:${day}`, current);
  }
  async function logSync(entry) {
    const key = "sync-log";
    const current = await metaGet(key) || [];
    current.push({ at: new Date().toISOString(), ...entry });
    await metaSet(key, current.slice(-100));
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("records")) db.createObjectStore("records", { keyPath: "id" });
        if (!db.objectStoreNames.contains("dirty")) db.createObjectStore("dirty", { keyPath: "id" });
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return dbPromise;
  }
  async function metaGet(key) {
    const db = await openDb();
    const row = await requestToPromise(db.transaction("meta").objectStore("meta").get(key));
    return row?.value;
  }
  async function metaSet(key, value) {
    const db = await openDb();
    const tx = db.transaction("meta", "readwrite");
    tx.objectStore("meta").put({ key, value });
    await transactionDone(tx);
  }
  async function metaDelete(key) {
    const db = await openDb();
    const tx = db.transaction("meta", "readwrite");
    tx.objectStore("meta").delete(key);
    await transactionDone(tx);
  }
  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  function transactionDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
    });
  }
})();
