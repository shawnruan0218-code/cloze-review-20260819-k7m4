import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const input = process.argv[2];
if (!input) throw new Error("Usage: node scripts/import-writing-sources.mjs /path/to/print-nodes.json");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.join(root, "sources/writing");
fs.mkdirSync(destination, { recursive: true });
const identifiers = {
  "miu 老师最新版本": "writing-miu-large",
  "miu 老师最新版本小作文": "writing-miu-small",
  "小于大作文": "writing-xiaoyu-large",
  "小予小作文": "writing-xiaoyu-small",
};
const documents = JSON.parse(fs.readFileSync(input, "utf8"));
if (documents.length !== 4) throw new Error("Expected four verified documents");
const index = documents.map((document) => {
  const id = identifiers[document.name];
  if (!id) throw new Error(`Unexpected source: ${document.name}`);
  const filename = `${document.name}_复核排版版.md`;
  const bytes = fs.readFileSync(document.markdown);
  fs.writeFileSync(path.join(destination, filename), bytes);
  return {
    id, title: document.name, filename,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    nodeHints: document.nodes.map((node) => ({
      type: node.type,
      ...(node.entries ? { entries: node.entries.map(({ kind, ref }) => ({ kind, ref })) } : {}),
    })),
  };
});
index.sort((a, b) => ["writing-miu-large", "writing-miu-small", "writing-xiaoyu-large", "writing-xiaoyu-small"].indexOf(a.id)
  - ["writing-miu-large", "writing-miu-small", "writing-xiaoyu-large", "writing-xiaoyu-small"].indexOf(b.id));
const imageDocument = documents.find((document) => document.nodes.some((node) => node.type === "raw" && node.text.includes("Pasted image")));
fs.mkdirSync(path.join(root, "assets/writing"), { recursive: true });
fs.copyFileSync(path.join(path.dirname(imageDocument.markdown), "Pasted image 20261020174522.png"), path.join(root, "assets/writing/meeting-minutes.png"));
fs.writeFileSync(path.join(destination, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
console.log(JSON.stringify(index.map(({ id, title, sha256 }) => ({ id, title, sha256 })), null, 2));
