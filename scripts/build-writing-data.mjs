import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hash = (text) => createHash("sha256").update(text).digest("hex");
export const plainWritingText = (text) => String(text).replace(/<[^>]*>/g, "").replace(/\\([.()[\]_*`])/g, "$1");

export function isEnglishWritingLine(text) {
  const visible = plainWritingText(text).trim();
  if (/^(?:\/Users\/|https?:\/\/|!\[)/.test(visible)) return false;
  const chinese = visible.match(/[\u3400-\u9fff]/g)?.length || 0;
  const latin = visible.match(/[A-Za-z]/g)?.length || 0;
  if (chinese > latin) return false;
  return /^[\s\d\W_①②③④⑤⑥⑦⑧⑨⑩]*[A-Za-z]/u.test(visible)
    && !/^[^A-Za-z]*[\u3400-\u9fff]/u.test(visible);
}

export function parseWritingMarkdown(markdown) {
  return markdown.trim().split(/\n\s*\n/).map((raw) => {
    const heading = raw.match(/^(#{4,6})\s+(.+)$/);
    if (heading) return { type: "heading", level: heading[1].length, text: heading[2] };
    const lines = raw.split("\n");
    if (lines.every((line) => line.startsWith("- "))) return { type: "group", parts: lines.map((line) => line.slice(2)) };
    if (lines.every((line) => line.startsWith("|"))) {
      return { type: "table", rows: lines.filter((line) => !/^\|[\s:|\-]+$/.test(line))
        .map((line) => line.slice(1, -1).split("|").map((cell) => cell.trim())) };
    }
    if (/^!\[\[Pasted image 20261020174522\.png\]\]$/.test(raw)) return { type: "raw", text: raw };
    throw new Error(`Unrecognized writing block: ${raw.slice(0, 80)}`);
  });
}

export function compileWritingDocument(source, markdown) {
  if (hash(markdown) !== source.sha256) throw new Error(`Source checksum mismatch: ${source.filename}`);
  const blocks = parseWritingMarkdown(markdown);
  if (blocks.length !== source.nodeHints.length) throw new Error(`Source structure changed: ${source.filename}`);
  const cards = [];
  const occurrences = new Map();
  let sections = [];
  let groupNumber = 0;
  const nextId = (kind, content) => {
    const digest = hash(JSON.stringify([kind, sections.map((section) => section.title), content])).slice(0, 16);
    const count = (occurrences.get(digest) || 0) + 1;
    occurrences.set(digest, count);
    return `${source.id}-${kind}-${digest}-${count}`;
  };
  const addNote = (lines, sourceBlock) => {
    if (!lines.length) return;
    cards.push({ type: "writing-note", id: nextId("note", lines), lines, sectionIds: sections.map(({ id }) => id), sourceBlock });
  };
  blocks.forEach((block, sourceBlock) => {
    const hint = source.nodeHints[sourceBlock];
    if (hint.type !== block.type) throw new Error(`Block type mismatch: ${source.filename}:${sourceBlock}`);
    if (block.type === "heading") {
      sections = sections.filter((section) => section.level < block.level);
      const id = nextId("section", [block.level, block.text]);
      sections.push({ id, level: block.level, title: block.text });
      cards.push({ type: "section", id, level: block.level, title: block.text, sourceBlock });
      return;
    }
    if (block.type === "table") {
      cards.push({ type: "writing-table", id: nextId("table", block.rows), rows: block.rows, sectionIds: sections.map(({ id }) => id), sourceBlock });
      return;
    }
    if (block.type === "raw") {
      cards.push({ type: "writing-image", id: nextId("image", block.text), src: "./assets/writing/meeting-minutes.png",
        alt: "会议纪要原图", sectionIds: sections.map(({ id }) => id), sourceBlock });
      return;
    }
    if (hint.entries.length !== block.parts.length) throw new Error(`Group size mismatch: ${source.filename}:${sourceBlock}`);
    let pending = [];
    block.parts.forEach((line, index) => {
      if (hint.entries[index].kind === "translation" || !isEnglishWritingLine(line)) {
        pending.push(line);
        return;
      }
      const chinese = pending.length ? [pending.at(-1)] : [];
      addNote(pending.slice(0, -1), sourceBlock);
      pending = [];
      const id = nextId("module", [line, chinese]);
      groupNumber += 1;
      cards.push({
        type: "card", writingModule: true, id, examId: source.id,
        english: line, chinese, sectionIds: sections.map(({ id }) => id),
        sourceBlock, sourceRef: hint.entries[index].ref, number: groupNumber,
        sentenceLines: [line], translationLine: chinese.join("\n"), clozeCount: 1,
        terms: [{ id: "module", title: plainWritingText(line), lines: [] }],
        searchableText: plainWritingText([line, ...chinese].join(" ")).toLowerCase(),
      });
    });
    addNote(pending, sourceBlock);
  });
  return {
    id: source.id, title: source.title, filename: source.filename, sourceSha256: source.sha256,
    parserVersion: 1, courseId: "writing", courseTitle: "结构重塑", year: source.title,
    cards, termCount: groupNumber, clozeCount: groupNumber,
    inventory: {
      sourceBlocks: blocks.length,
      bulletLines: blocks.filter((block) => block.type === "group").reduce((count, block) => count + block.parts.length, 0),
      modules: groupNumber, notes: cards.filter((card) => card.type === "writing-note").length,
      sections: cards.filter((card) => card.type === "section").length,
    },
  };
}

export function buildWritingData(directory = path.join(root, "sources/writing")) {
  const index = JSON.parse(fs.readFileSync(path.join(directory, "index.json"), "utf8"));
  return index.map((source) => compileWritingDocument(source, fs.readFileSync(path.join(directory, source.filename), "utf8")));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const documents = buildWritingData();
  fs.writeFileSync(path.join(root, "writing-data.js"), `window.WRITING_DATA = ${JSON.stringify(documents, null, 2)};\n`);
  console.log(JSON.stringify(documents.map(({ title, inventory }) => ({ title, ...inventory })), null, 2));
}
