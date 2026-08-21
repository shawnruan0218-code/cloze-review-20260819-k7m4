import crypto from "node:crypto";

export const NAMESPACE = "cloze-review-20260819-k7m4";
export const ANNOTATION_MARKER = "::cloze-annotation::";
export const ROUND_PATTERN = /^(.*)::review-round-([2-4])$/;

export function normalizeSupabaseExport(exportData) {
  const rows = Array.isArray(exportData.review_items) ? exportData.review_items : [];
  const byUserAndKey = new Map();
  const annotations = [];

  for (const row of rows) {
    if (String(row.item_key).startsWith(ANNOTATION_MARKER)) {
      annotations.push(normalizeAnnotation(row));
      continue;
    }
    const match = String(row.item_key).match(ROUND_PATTERN);
    const baseKey = match ? match[1] : String(row.item_key);
    const round = match ? Number(match[2]) : 1;
    const mapKey = `${row.user_id}\u0000${baseKey}`;
    const current = byUserAndKey.get(mapKey) || {
      legacyUserId: String(row.user_id),
      entityType: "review_item",
      itemKey: baseKey,
      payloadVersion: 1,
      createdAt: normalizeTime(row.added_at),
      updatedAt: normalizeTime(row.updated_at || row.added_at),
      deletedAt: null,
      source: "supabase-migration-v1",
      clientId: "supabase-import",
      payload: {
        examId: row.exam_id,
        cardId: row.card_id,
        termId: row.term_id,
        addedAt: normalizeTime(row.added_at),
        reviewRound: 1,
        _legacyRows: [],
      },
    };
    current.payload.reviewRound = Math.max(Number(current.payload.reviewRound || 1), round);
    current.createdAt = minTime(current.createdAt, normalizeTime(row.added_at));
    current.updatedAt = maxTime(current.updatedAt, normalizeTime(row.updated_at || row.added_at));
    current.payload._legacyRows.push(preserveRow(row));
    byUserAndKey.set(mapKey, current);
  }

  const records = [...byUserAndKey.values(), ...annotations]
    .sort((a, b) => `${a.legacyUserId}:${a.entityType}:${a.itemKey}`.localeCompare(`${b.legacyUserId}:${b.entityType}:${b.itemKey}`));
  return {
    format: "cloze-review-d1-import",
    version: 1,
    namespace: NAMESPACE,
    sourceProjectRef: exportData.project_ref,
    exportedAt: new Date().toISOString(),
    records,
    counts: countRecords(records, rows.length),
  };
}

function normalizeAnnotation(row) {
  let parsed;
  try { parsed = JSON.parse(row.term_id || "{}"); } catch { parsed = { rawTermId: row.term_id }; }
  const id = String(parsed.id || String(row.item_key).slice(ANNOTATION_MARKER.length));
  const createdAt = normalizeTime(parsed.createdAt || row.added_at);
  const updatedAt = maxTime(normalizeTime(parsed.updatedAt || createdAt), normalizeTime(row.updated_at || createdAt));
  return {
    legacyUserId: String(row.user_id), entityType: "annotation", itemKey: id,
    payload: {
      ...parsed,
      id,
      examId: row.exam_id,
      cardId: row.card_id,
      _legacyRows: [preserveRow(row)],
    },
    payloadVersion: 1, createdAt, updatedAt,
    deletedAt: parsed.deletedAt || null,
    source: "supabase-migration-v1", clientId: "supabase-import",
  };
}

function preserveRow(row) {
  return {
    id: row.id, item_key: row.item_key, exam_id: row.exam_id, card_id: row.card_id,
    term_id: row.term_id, added_at: row.added_at, updated_at: row.updated_at,
  };
}

export function countRecords(records, rawRows = 0) {
  const result = { rawRows, reviewItems: 0, annotations: 0, settings: 0, deleted: 0, rounds: { 1: 0, 2: 0, 3: 0, 4: 0 } };
  for (const record of records) {
    if (record.entityType === "review_item") {
      result.reviewItems += 1;
      result.rounds[record.payload.reviewRound || 1] += 1;
    } else if (record.entityType === "annotation") result.annotations += 1;
    else if (record.entityType === "setting") result.settings += 1;
    if (record.deletedAt) result.deleted += 1;
  }
  return result;
}

export function buildImportSql(normalized) {
  const table = quoteIdentifier(`${NAMESPACE}_records`);
  const changes = quoteIdentifier(`${NAMESPACE}_changes`);
  const statements = ["PRAGMA foreign_keys=ON;"];
  for (const record of normalized.records) {
    const userId = `legacy:supabase:${record.legacyUserId}`;
    statements.push(
      `INSERT INTO ${table} (user_id, entity_type, item_key, payload, payload_version, updated_at, deleted_at, created_at, source, client_id) VALUES (` +
      [userId, record.entityType, record.itemKey, JSON.stringify(record.payload), record.payloadVersion,
        record.updatedAt, record.deletedAt, record.createdAt, record.source, record.clientId].map(sqlValue).join(",") +
      `) ON CONFLICT(user_id,entity_type,item_key) DO UPDATE SET ` +
      `payload=excluded.payload,payload_version=excluded.payload_version,updated_at=excluded.updated_at,` +
      `deleted_at=excluded.deleted_at,source=excluded.source,client_id=excluded.client_id ` +
      `WHERE excluded.updated_at > ${table}.updated_at;`
    );
  }
  statements.push(
    `INSERT INTO ${changes} (user_id,entity_type,item_key,payload,payload_version,updated_at,deleted_at,created_at,source,client_id) ` +
    `SELECT r.user_id,r.entity_type,r.item_key,r.payload,r.payload_version,r.updated_at,r.deleted_at,r.created_at,r.source,r.client_id ` +
    `FROM ${table} r WHERE r.source='supabase-migration-v1' AND NOT EXISTS (` +
    `SELECT 1 FROM ${changes} c WHERE c.user_id=r.user_id AND c.entity_type=r.entity_type AND c.item_key=r.item_key AND c.updated_at=r.updated_at);`
  );
  return `${statements.join("\n")}\n`;
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeTime(value) {
  const time = new Date(value || 0);
  if (!Number.isFinite(time.getTime())) throw new Error(`Invalid timestamp: ${value}`);
  return time.toISOString();
}
function minTime(a, b) { return a < b ? a : b; }
function maxTime(a, b) { return a > b ? a : b; }
function quoteIdentifier(value) { return `"${String(value).replaceAll('"', '""')}"`; }
function sqlValue(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}
