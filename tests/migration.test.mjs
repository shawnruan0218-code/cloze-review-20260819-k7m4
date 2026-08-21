import test from "node:test";
import assert from "node:assert/strict";
import { buildImportSql, normalizeSupabaseExport } from "../scripts/migration-lib.mjs";

test("collapses legacy round marker rows into one canonical review item", () => {
  const source = {
    project_ref: "fixture",
    review_items: [
      row("item-a", "2026-01-01T00:00:00Z"),
      row("item-a::review-round-2", "2026-01-02T00:00:00Z"),
      row("item-a::review-round-3", "2026-01-03T00:00:00Z"),
    ],
  };
  const result = normalizeSupabaseExport(source);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].payload.reviewRound, 3);
  assert.equal(result.records[0].payload._legacyRows.length, 3);
  assert.equal(result.records[0].updatedAt, "2026-01-03T00:00:00.000Z");
});

test("preserves annotations and produces an idempotent upsert", () => {
  const annotation = row("::cloze-annotation::note-1", "2026-01-02T00:00:00Z");
  annotation.term_id = JSON.stringify({ id: "note-1", selectedText: "Unless", note: "if not" });
  const result = normalizeSupabaseExport({ project_ref: "fixture", review_items: [annotation] });
  assert.equal(result.counts.annotations, 1);
  assert.equal(result.records[0].payload.note, "if not");
  const sql = buildImportSql(result);
  assert.match(sql, /ON CONFLICT\(user_id,entity_type,item_key\) DO UPDATE/);
  assert.match(sql, /WHERE excluded\.updated_at/);
  assert.match(sql, /NOT EXISTS/);
});

function row(itemKey, updatedAt) {
  return {
    id: `id-${itemKey}`,
    user_id: "old-user",
    item_key: itemKey,
    exam_id: "year-2022",
    card_id: "card-1",
    term_id: "term-1",
    added_at: "2026-01-01T00:00:00Z",
    updated_at: updatedAt,
  };
}
