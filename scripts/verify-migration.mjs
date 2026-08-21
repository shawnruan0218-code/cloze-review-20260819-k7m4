import fs from "node:fs";
import path from "node:path";
import { countRecords, sha256 } from "./migration-lib.mjs";

const dir = path.resolve(process.argv[2] || "../../backups/cloze-review-20260819-k7m4/generated");
const normalizedPath = path.join(dir, "normalized-supabase-v1.json");
const normalized = JSON.parse(fs.readFileSync(normalizedPath, "utf8"));
const counts = countRecords(normalized.records, normalized.counts.rawRows);
if (JSON.stringify(counts) !== JSON.stringify(normalized.counts)) throw new Error("Entity counts do not match the manifest");
if (counts.rawRows !== 4081 || counts.reviewItems !== 2796 || counts.annotations !== 1) {
  throw new Error(`Unexpected migration counts: ${JSON.stringify(counts)}`);
}
const keys = new Set();
for (const record of normalized.records) {
  const key = `${record.legacyUserId}:${record.entityType}:${record.itemKey}`;
  if (keys.has(key)) throw new Error(`Duplicate canonical key: ${key}`);
  keys.add(key);
  if (!record.createdAt || !record.updatedAt || !record.payload) throw new Error(`Incomplete record: ${key}`);
}
console.log(JSON.stringify({ ok: true, counts, recordsSha256: sha256(JSON.stringify(normalized.records)) }, null, 2));
