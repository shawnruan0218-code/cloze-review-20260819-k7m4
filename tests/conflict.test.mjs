import test from "node:test";
import assert from "node:assert/strict";
import { mergeRecord } from "../worker/src/index.js";

const base = {
  entityType: "review_item", itemKey: "x", payload: { reviewRound: 1 }, payloadVersion: 1,
  updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z", source: "test", clientId: "a",
};

test("newer timestamp wins deterministically", () => {
  const newer = { ...base, updatedAt: "2026-01-02T00:00:00.000Z", payload: { reviewRound: 2 } };
  assert.equal(mergeRecord(base, newer), newer);
  assert.equal(mergeRecord(newer, base), newer);
});

test("a tombstone wins when it is newer", () => {
  const deleted = { ...base, updatedAt: "2026-01-03T00:00:00.000Z", deletedAt: "2026-01-03T00:00:00.000Z" };
  assert.equal(mergeRecord(base, deleted), deleted);
});

test("equal timestamp and version use a stable client and payload tie break", () => {
  const other = { ...base, clientId: "z", payload: { reviewRound: 4 } };
  assert.equal(mergeRecord(base, other), other);
  assert.equal(mergeRecord(other, base), other);
});
