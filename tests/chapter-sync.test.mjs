import test from "node:test";
import assert from "node:assert/strict";
import { cloudFixture, syncServer, signBackup } from "./cloud-fixture.mjs";
import { baseKey, oldItem, plain } from "./app-fixture.mjs";

const chapter2Key = `${baseKey}::review-chapter-2`;
const newItem = { ...oldItem, reviewChapter: 2, reviewRound: 1, updatedAt: "2026-10-13T01:00:00.000Z" };

test("immediate backup includes queued chapter writes and reload restores both chapters", async () => {
  const device = await cloudFixture({ library: { [baseKey]: oldItem } });
  device.cloud.enqueueReview("upsert", newItem, chapter2Key);
  const backup = await device.cloud.exportBackup();
  assert.equal(backup.version, 3);
  assert.deepEqual(plain(backup.chapters), { 1: 1, 2: 1, 3: 0, 4: 0 });
  const reloaded = await cloudFixture({ indexedDB: device.indexedDB });
  assert.deepEqual(plain(reloaded.library()[chapter2Key]), newItem);
  assert.equal(reloaded.library()[baseKey].reviewRound, 4);
});

test("backup round trip preserves all chapters and importing older data does not reset selection", async () => {
  const device = await cloudFixture({ library: { [baseKey]: oldItem } });
  await device.cloud.enqueueReview("upsert", newItem, chapter2Key);
  const original = await device.cloud.exportBackup();
  const restored = await cloudFixture();
  await restored.cloud.importBackup(original);
  const roundTrip = await restored.cloud.exportBackup();
  assert.deepEqual(plain(roundTrip.records), plain(original.records));
  const older = await signBackup({ ...original, version: 2, records: original.records.map((row) => row.itemKey === chapter2Key
    ? { ...row, updatedAt: "2026-07-01T00:00:00.000Z", payload: { ...row.payload, reviewRound: 4 } }
    : row) });
  await restored.cloud.importBackup(older);
  assert.equal(restored.library()[chapter2Key].reviewRound, 1);
  assert.equal(restored.library()[baseKey].reviewRound, 4);
});

test("malformed or corrupted backup is rejected before any records change", async () => {
  const device = await cloudFixture({ library: { [baseKey]: oldItem } });
  const original = await device.cloud.exportBackup();
  await assert.rejects(device.cloud.importBackup({ ...original, checksum: "bad" }), /校验失败/);
  const bad = await signBackup({ ...original, records: [...original.records,
    { entityType: "review_item", itemKey: "bad", payload: {}, updatedAt: "invalid" }] });
  await assert.rejects(device.cloud.importBackup(bad), /无效记录/);
  assert.deepEqual(plain((await device.cloud.exportBackup()).records), plain(original.records));
});

test("offline chapter selection syncs to another device and scoped removal converges", async () => {
  const server = syncServer();
  const first = await cloudFixture({ library: { [baseKey]: oldItem }, server });
  await first.cloud.syncNow();
  const second = await cloudFixture({ server });
  await second.cloud.syncNow();
  await first.cloud.enqueueReview("upsert", newItem, chapter2Key);
  await first.cloud.syncNow();
  await second.cloud.syncNow();
  assert.deepEqual(plain(second.library()[chapter2Key]), newItem);
  assert.equal(second.library()[baseKey].reviewRound, 4);
  await second.cloud.enqueueReview("delete", { ...newItem, updatedAt: new Date().toISOString() }, chapter2Key);
  await second.cloud.syncNow();
  await first.cloud.syncNow();
  assert.equal(first.library()[chapter2Key], undefined);
  assert.equal(first.library()[baseKey].reviewRound, 4);
  assert.equal(server.records.get(`review_item:${baseKey}`).deletedAt, null);
  assert.ok(server.records.get(`review_item:${chapter2Key}`).deletedAt);
});
