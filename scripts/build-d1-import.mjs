import fs from "node:fs";
import path from "node:path";
import { buildImportSql, normalizeSupabaseExport, sha256, stableJson } from "./migration-lib.mjs";

const defaultInput = path.resolve("../../backups/cloze-review-20260819-k7m4/supabase-vsnskovjhfycodrfoisd-export-v1.json");
const defaultOutDir = path.resolve("../../backups/cloze-review-20260819-k7m4/generated");
const input = path.resolve(process.argv[2] || defaultInput);
const outDir = path.resolve(process.argv[3] || defaultOutDir);
fs.mkdirSync(outDir, { recursive: true });

const source = JSON.parse(fs.readFileSync(input, "utf8"));
const normalized = normalizeSupabaseExport(source);
const normalizedJson = `${JSON.stringify(normalized, null, 2)}\n`;
const sql = buildImportSql(normalized);
const chunksDir = path.join(outDir, "chunks");
fs.rmSync(chunksDir, { recursive: true, force: true });
fs.mkdirSync(chunksDir, { recursive: true });
const chunkFiles = [];
for (let index = 0; index < normalized.records.length; index += 200) {
  const name = `d1-import-${String(index / 200 + 1).padStart(3, "0")}.sql`;
  const chunk = buildImportSql({ ...normalized, records: normalized.records.slice(index, index + 200) });
  fs.writeFileSync(path.join(chunksDir, name), chunk, { mode: 0o600 });
  chunkFiles.push({ name, records: Math.min(200, normalized.records.length - index), sha256: sha256(chunk) });
}
fs.writeFileSync(path.join(outDir, "normalized-supabase-v1.json"), normalizedJson, { mode: 0o600 });
fs.writeFileSync(path.join(outDir, "d1-import-v1.sql"), sql, { mode: 0o600 });
fs.writeFileSync(path.join(outDir, "checksums-v1.txt"), [
  `${sha256(normalizedJson)}  normalized-supabase-v1.json`,
  `${sha256(sql)}  d1-import-v1.sql`,
].join("\n") + "\n", { mode: 0o600 });
fs.writeFileSync(path.join(outDir, "migration-report-v1.json"), `${stableJson({
  namespace: normalized.namespace,
  sourceProjectRef: normalized.sourceProjectRef,
  counts: normalized.counts,
  normalizedSha256: sha256(normalizedJson),
  sqlSha256: sha256(sql),
  chunkFiles,
})}\n`, { mode: 0o600 });
console.log(JSON.stringify({ outDir, counts: normalized.counts, chunks: chunkFiles.length }, null, 2));
