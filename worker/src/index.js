const NS = "cloze-review-20260819-k7m4";
const TABLE = `"${NS}_records"`;
const CHANGES = `"${NS}_changes"`;
const SESSIONS = `"${NS}_sessions"`;
const STATES = `"${NS}_oauth_states"`;
const AUTH_CODES = `"${NS}_auth_codes"`;
const MAPPINGS = `"${NS}_user_mappings"`;
const RATE_LIMITS = `"${NS}_rate_limits"`;
const DIAGNOSTICS = `"${NS}_diagnostics"`;
const MAX_BODY_BYTES = 512 * 1024;
const MAX_PUSH_RECORDS = 200;
const MAX_PULL_RECORDS = 500;
const SESSION_DAYS = 30;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: cors ? 204 : 403, headers: cors || {} });
    }

    try {
      if (url.pathname === "/api/health") {
        return json({ ok: true, namespace: NS, protocolVersion: 2 }, 200, cors);
      }
      if (url.pathname === "/api/auth/github/start" && request.method === "GET") {
        return startGithubLogin(url, env);
      }
      if (url.pathname === "/api/auth/github/callback" && request.method === "GET") {
        return finishGithubLogin(url, env);
      }
      if (url.pathname === "/api/auth/exchange" && request.method === "POST") {
        requireCors(cors);
        return exchangeAuthCode(request, env, cors);
      }

      requireCors(cors);
      requireClientVersion(request, env);
      const session = await authenticate(request, env);
      await enforceRateLimit(env, session.userId);
      ctx.waitUntil(recordDiagnostic(env, session.userId, { requestCount: 1 }));

      if (url.pathname === "/api/auth/session" && request.method === "GET") {
        return json({ user: session.publicUser, expiresAt: session.expiresAt }, 200, cors);
      }
      if (url.pathname === "/api/auth/logout" && request.method === "POST") {
        await env.DB.prepare(`DELETE FROM ${SESSIONS} WHERE token_hash = ?`)
          .bind(session.tokenHash).run();
        return json({ ok: true }, 200, cors);
      }
      if (url.pathname === "/api/sync/push" && request.method === "POST") {
        return pushChanges(request, env, session, cors, ctx);
      }
      if (url.pathname === "/api/sync/pull" && request.method === "GET") {
        return pullChanges(url, env, session, cors, ctx);
      }
      if (url.pathname === "/api/diagnostics" && request.method === "GET") {
        return diagnostics(env, session, cors);
      }
      return json({ error: "not_found" }, 404, cors);
    } catch (error) {
      const status = Number(error.status) || 500;
      const code = error.code || (status === 500 ? "internal_error" : "request_failed");
      if (status >= 500) console.error(code, error.message);
      return json({ error: code, message: publicMessage(status, code) }, status, cors);
    }
  },
};

async function startGithubLogin(url, env) {
  const returnUrl = validateReturnUrl(url.searchParams.get("return_url"), env);
  const state = randomToken(32);
  const now = new Date();
  const expires = new Date(now.getTime() + 10 * 60_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO ${STATES} (state_hash, return_url, created_at, expires_at) VALUES (?, ?, ?, ?)`
  ).bind(await digest(state), returnUrl, now.toISOString(), expires).run();

  const callback = `${url.origin}/api/auth/github/callback`;
  const target = new URL("https://github.com/login/oauth/authorize");
  target.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  target.searchParams.set("redirect_uri", callback);
  target.searchParams.set("state", state);
  target.searchParams.set("scope", "read:user");
  return Response.redirect(target.toString(), 302);
}

async function finishGithubLogin(url, env) {
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code") || "";
  if (!state || !code) throw httpError(400, "oauth_missing_parameters");

  const stateHash = await digest(state);
  const saved = await env.DB.prepare(
    `SELECT return_url, expires_at FROM ${STATES} WHERE state_hash = ?`
  ).bind(stateHash).first();
  await env.DB.prepare(`DELETE FROM ${STATES} WHERE state_hash = ?`).bind(stateHash).run();
  if (!saved || Date.parse(saved.expires_at) < Date.now()) {
    throw httpError(400, "oauth_state_invalid");
  }

  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${url.origin}/api/auth/github/callback`,
    }),
  });
  const tokenData = await tokenResponse.json();
  if (!tokenResponse.ok || !tokenData.access_token) throw httpError(502, "github_token_failed");

  const githubResponse = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": NS,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  const github = await githubResponse.json();
  if (!githubResponse.ok || !github.id || !github.login) throw httpError(502, "github_profile_failed");

  const userId = `github:${github.id}`;
  await claimLegacyData(env, userId, github.login);
  const authCode = randomToken(32);
  const now = new Date();
  await env.DB.prepare(
    `INSERT INTO ${AUTH_CODES}
      (code_hash, user_id, github_login, github_avatar_url, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    await digest(authCode), userId, github.login, github.avatar_url || null,
    now.toISOString(), new Date(now.getTime() + 2 * 60_000).toISOString()
  ).run();

  const target = new URL(saved.return_url);
  target.searchParams.set(`${NS}_auth_code`, authCode);
  return Response.redirect(target.toString(), 302);
}

async function exchangeAuthCode(request, env, cors) {
  const body = await readJson(request);
  const code = String(body.code || "");
  if (!code) throw httpError(400, "auth_code_missing");
  const codeHash = await digest(code);
  const saved = await env.DB.prepare(
    `SELECT user_id, github_login, github_avatar_url, expires_at FROM ${AUTH_CODES} WHERE code_hash = ?`
  ).bind(codeHash).first();
  await env.DB.prepare(`DELETE FROM ${AUTH_CODES} WHERE code_hash = ?`).bind(codeHash).run();
  if (!saved || Date.parse(saved.expires_at) < Date.now()) throw httpError(401, "auth_code_invalid");

  const token = randomToken(48);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 86400_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO ${SESSIONS}
      (token_hash, user_id, github_login, github_avatar_url, created_at, expires_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    await digest(`${token}:${env.SESSION_PEPPER}`), saved.user_id, saved.github_login,
    saved.github_avatar_url || null, now.toISOString(), expiresAt, now.toISOString()
  ).run();

  return json({
    token,
    expiresAt,
    user: { id: saved.user_id, login: saved.github_login, avatarUrl: saved.github_avatar_url || null },
  }, 200, cors);
}

async function authenticate(request, env) {
  const authorization = request.headers.get("Authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token) throw httpError(401, "session_missing");
  const tokenHash = await digest(`${token}:${env.SESSION_PEPPER}`);
  const row = await env.DB.prepare(
    `SELECT user_id, github_login, github_avatar_url, expires_at FROM ${SESSIONS} WHERE token_hash = ?`
  ).bind(tokenHash).first();
  if (!row || Date.parse(row.expires_at) < Date.now()) {
    if (row) await env.DB.prepare(`DELETE FROM ${SESSIONS} WHERE token_hash = ?`).bind(tokenHash).run();
    throw httpError(401, "session_expired");
  }
  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE ${SESSIONS} SET last_seen_at = ? WHERE token_hash = ?`)
    .bind(now, tokenHash).run();
  return {
    tokenHash,
    userId: row.user_id,
    expiresAt: row.expires_at,
    publicUser: { id: row.user_id, login: row.github_login, avatarUrl: row.github_avatar_url || null },
  };
}

async function pushChanges(request, env, session, cors, ctx) {
  const body = await readJson(request);
  const records = body.records;
  if (!Array.isArray(records) || records.length > MAX_PUSH_RECORDS) {
    throw httpError(400, "invalid_push_batch");
  }
  const accepted = [];
  for (const raw of records) {
    const incoming = validateRecord(raw);
    const existing = await env.DB.prepare(
      `SELECT payload, payload_version, updated_at, deleted_at, created_at, source, client_id
       FROM ${TABLE} WHERE user_id = ? AND entity_type = ? AND item_key = ?`
    ).bind(session.userId, incoming.entityType, incoming.itemKey).first();
    const winner = mergeRecord(existing && fromDb(existing, incoming.entityType, incoming.itemKey), incoming);
    if (existing && !sameRecord(winner, incoming)) continue;

    const payload = JSON.stringify(winner.payload);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO ${TABLE}
          (user_id, entity_type, item_key, payload, payload_version, updated_at, deleted_at, created_at, source, client_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, entity_type, item_key) DO UPDATE SET
           payload=excluded.payload, payload_version=excluded.payload_version,
           updated_at=excluded.updated_at, deleted_at=excluded.deleted_at,
           source=excluded.source, client_id=excluded.client_id`
      ).bind(session.userId, winner.entityType, winner.itemKey, payload, winner.payloadVersion,
        winner.updatedAt, winner.deletedAt, winner.createdAt, winner.source, winner.clientId),
      env.DB.prepare(
        `INSERT INTO ${CHANGES}
          (user_id, entity_type, item_key, payload, payload_version, updated_at, deleted_at, created_at, source, client_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(session.userId, winner.entityType, winner.itemKey, payload, winner.payloadVersion,
        winner.updatedAt, winner.deletedAt, winner.createdAt, winner.source, winner.clientId),
    ]);
    accepted.push(`${winner.entityType}:${winner.itemKey}`);
  }
  ctx.waitUntil(recordDiagnostic(env, session.userId, { syncCount: 1, pushedRecords: accepted.length }));
  return json({ accepted, rejected: records.length - accepted.length }, 200, cors);
}

async function pullChanges(url, env, session, cors, ctx) {
  const cursor = parseInteger(url.searchParams.get("cursor"), 0, Number.MAX_SAFE_INTEGER);
  const limit = parseInteger(url.searchParams.get("limit"), 100, MAX_PULL_RECORDS);
  const result = await env.DB.prepare(
    `SELECT seq, entity_type, item_key, payload, payload_version, updated_at,
            deleted_at, created_at, source, client_id
     FROM ${CHANGES} WHERE user_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`
  ).bind(session.userId, cursor, limit).all();
  const rows = result.results || [];
  const nextCursor = rows.length ? Number(rows[rows.length - 1].seq) : cursor;
  ctx.waitUntil(recordDiagnostic(env, session.userId, {
    syncCount: 1, pullPages: 1, pulledRecords: rows.length,
  }));
  return json({
    records: rows.map((row) => ({
      seq: Number(row.seq), entityType: row.entity_type, itemKey: row.item_key,
      payload: JSON.parse(row.payload), payloadVersion: Number(row.payload_version),
      updatedAt: row.updated_at, deletedAt: row.deleted_at, createdAt: row.created_at,
      source: row.source, clientId: row.client_id,
    })),
    cursor: nextCursor,
    hasMore: rows.length === limit,
  }, 200, cors);
}

async function diagnostics(env, session, cors) {
  const day = new Date().toISOString().slice(0, 10);
  const row = await env.DB.prepare(
    `SELECT request_count, sync_count, pull_pages, pushed_records, pulled_records, error_count
     FROM ${DIAGNOSTICS} WHERE user_id = ? AND day = ?`
  ).bind(session.userId, day).first();
  const requestCount = Number(row?.request_count || 0);
  const elapsedMinutes = Math.max(1, (Date.now() - Date.parse(`${day}T00:00:00Z`)) / 60_000);
  return json({
    day,
    requestCount,
    estimatedDailyRequests: Math.round(requestCount * 1440 / elapsedMinutes),
    syncCount: Number(row?.sync_count || 0),
    pullPages: Number(row?.pull_pages || 0),
    pushedRecords: Number(row?.pushed_records || 0),
    pulledRecords: Number(row?.pulled_records || 0),
    errorCount: Number(row?.error_count || 0),
  }, 200, cors);
}

async function claimLegacyData(env, newUserId, githubLogin) {
  if (githubLogin.toLowerCase() !== String(env.LEGACY_OWNER_LOGIN || "").toLowerCase()) return;
  const prior = await env.DB.prepare(
    `SELECT old_user_id FROM ${MAPPINGS} WHERE new_provider = 'github' AND new_user_id = ?`
  ).bind(newUserId).first();
  if (prior) return;
  const legacy = await env.DB.prepare(
    `SELECT user_id FROM ${TABLE} WHERE user_id LIKE 'legacy:supabase:%' GROUP BY user_id ORDER BY COUNT(*) DESC LIMIT 1`
  ).first();
  if (!legacy) return;
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE ${TABLE} SET user_id = ? WHERE user_id = ?`).bind(newUserId, legacy.user_id),
    env.DB.prepare(`UPDATE ${CHANGES} SET user_id = ? WHERE user_id = ?`).bind(newUserId, legacy.user_id),
    env.DB.prepare(
      `INSERT OR IGNORE INTO ${MAPPINGS}
        (old_provider, old_user_id, new_provider, new_user_id, mapped_at, confirmation_basis)
       VALUES ('supabase', ?, 'github', ?, ?, ?)`
    ).bind(legacy.user_id.slice("legacy:supabase:".length), newUserId, now,
      `Authenticated GitHub login matched configured legacy owner: ${githubLogin}`),
  ]);
}

export function mergeRecord(existing, incoming) {
  if (!existing) return incoming;
  const time = String(incoming.updatedAt).localeCompare(String(existing.updatedAt));
  if (time !== 0) return time > 0 ? incoming : existing;
  if (incoming.payloadVersion !== existing.payloadVersion) {
    return incoming.payloadVersion > existing.payloadVersion ? incoming : existing;
  }
  const incomingTie = `${incoming.clientId}\u0000${canonicalJson(incoming.payload)}\u0000${incoming.deletedAt || ""}`;
  const existingTie = `${existing.clientId}\u0000${canonicalJson(existing.payload)}\u0000${existing.deletedAt || ""}`;
  return incomingTie.localeCompare(existingTie) >= 0 ? incoming : existing;
}

function validateRecord(raw) {
  if (!raw || typeof raw !== "object") throw httpError(400, "invalid_record");
  const entityType = String(raw.entityType || "");
  if (!new Set(["review_item", "annotation", "setting"]).has(entityType)) {
    throw httpError(400, "invalid_entity_type");
  }
  const itemKey = String(raw.itemKey || "");
  if (!itemKey || itemKey.length > 500) throw httpError(400, "invalid_item_key");
  if (!raw.payload || typeof raw.payload !== "object" || Array.isArray(raw.payload)) {
    throw httpError(400, "invalid_payload");
  }
  const updatedAt = validTimestamp(raw.updatedAt, "updated_at");
  if (Date.parse(updatedAt) > Date.now() + 5 * 60_000) throw httpError(400, "future_timestamp");
  const createdAt = validTimestamp(raw.createdAt || updatedAt, "created_at");
  const deletedAt = raw.deletedAt ? validTimestamp(raw.deletedAt, "deleted_at") : null;
  return {
    entityType, itemKey, payload: raw.payload,
    payloadVersion: parseInteger(raw.payloadVersion, 1, 1000),
    updatedAt, deletedAt, createdAt,
    source: String(raw.source || "client").slice(0, 80),
    clientId: String(raw.clientId || "").slice(0, 120),
  };
}

function fromDb(row, entityType, itemKey) {
  return {
    entityType, itemKey, payload: JSON.parse(row.payload),
    payloadVersion: Number(row.payload_version), updatedAt: row.updated_at,
    deletedAt: row.deleted_at, createdAt: row.created_at,
    source: row.source, clientId: row.client_id,
  };
}

function sameRecord(a, b) {
  return a.entityType === b.entityType && a.itemKey === b.itemKey &&
    a.updatedAt === b.updatedAt && a.payloadVersion === b.payloadVersion &&
    a.deletedAt === b.deletedAt && a.clientId === b.clientId &&
    canonicalJson(a.payload) === canonicalJson(b.payload);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function readJson(request) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > MAX_BODY_BYTES) throw httpError(413, "payload_too_large");
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) throw httpError(413, "payload_too_large");
  try { return JSON.parse(text || "{}"); } catch { throw httpError(400, "invalid_json"); }
}

async function enforceRateLimit(env, userId) {
  const now = new Date();
  const minute = now.toISOString().slice(0, 16);
  const key = `${userId}:${minute}`;
  await env.DB.prepare(
    `INSERT INTO ${RATE_LIMITS} (bucket_key, request_count, window_started_at, updated_at)
     VALUES (?, 1, ?, ?)
     ON CONFLICT(bucket_key) DO UPDATE SET request_count=request_count+1, updated_at=excluded.updated_at`
  ).bind(key, `${minute}:00.000Z`, now.toISOString()).run();
  const row = await env.DB.prepare(`SELECT request_count FROM ${RATE_LIMITS} WHERE bucket_key = ?`)
    .bind(key).first();
  if (Number(row?.request_count || 0) > 120) throw httpError(429, "rate_limited");
}

async function recordDiagnostic(env, userId, values) {
  const now = new Date().toISOString();
  const day = now.slice(0, 10);
  try {
    await env.DB.prepare(
      `INSERT INTO ${DIAGNOSTICS}
        (user_id, day, request_count, sync_count, pull_pages, pushed_records, pulled_records, error_count, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, day) DO UPDATE SET
         request_count=request_count+excluded.request_count,
         sync_count=sync_count+excluded.sync_count,
         pull_pages=pull_pages+excluded.pull_pages,
         pushed_records=pushed_records+excluded.pushed_records,
         pulled_records=pulled_records+excluded.pulled_records,
         error_count=error_count+excluded.error_count,
         updated_at=excluded.updated_at`
    ).bind(userId, day, values.requestCount || 0, values.syncCount || 0, values.pullPages || 0,
      values.pushedRecords || 0, values.pulledRecords || 0, values.errorCount || 0, now).run();
  } catch (error) {
    console.error("diagnostic_write_failed", error.message);
  }
}

function corsHeaders(origin, env) {
  if (!origin || !allowedOrigins(env).has(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Cloze-Client-Version",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function allowedOrigins(env) {
  return new Set(String(env.ALLOWED_ORIGINS || "").split(",").map((part) => part.trim()).filter(Boolean));
}

function validateReturnUrl(value, env) {
  const candidate = new URL(value || env.FRONTEND_URL);
  if (!allowedOrigins(env).has(candidate.origin)) throw httpError(400, "return_url_not_allowed");
  candidate.hash = "";
  return candidate.toString();
}

function requireCors(cors) {
  if (!cors) throw httpError(403, "origin_not_allowed");
}

function requireClientVersion(request, env) {
  const version = Number(request.headers.get("X-Cloze-Client-Version") || 0);
  if (version < Number(env.MIN_CLIENT_VERSION || 2)) throw httpError(426, "client_update_required");
}

function validTimestamp(value, field) {
  const text = String(value || "");
  if (!text || !Number.isFinite(Date.parse(text))) throw httpError(400, `invalid_${field}`);
  return new Date(text).toISOString();
}

function parseInteger(value, fallback, max) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) throw httpError(400, "invalid_number");
  return parsed;
}

function randomToken(bytes) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return base64url(data);
}

async function digest(value) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64url(new Uint8Array(hash));
}

function base64url(bytes) {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function httpError(status, code) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  return error;
}

function publicMessage(status, code) {
  if (status >= 500) return "服务暂时不可用，本地数据不受影响";
  const messages = {
    session_missing: "请先登录 GitHub",
    session_expired: "登录已过期，请重新登录",
    rate_limited: "同步请求较多，已暂停快速重试",
    client_update_required: "请刷新网站后再同步",
    origin_not_allowed: "当前网站地址未获授权",
  };
  return messages[code] || "请求未完成";
}

function json(data, status = 200, cors = null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(cors || {}),
    },
  });
}
