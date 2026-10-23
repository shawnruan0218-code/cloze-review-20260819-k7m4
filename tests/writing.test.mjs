import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { buildWritingData, parseWritingMarkdown, compileWritingDocument } from "../scripts/build-writing-data.mjs";
import { appFixture, baseKey, oldItem, plain } from "./app-fixture.mjs";

const documents = buildWritingData();
const index = JSON.parse(fs.readFileSync(new URL("../sources/writing/index.json", import.meta.url), "utf8"));
const viewSource = fs.readFileSync(new URL("../writing-view.js", import.meta.url), "utf8");
const viewContext = vm.createContext({ window: {} });
vm.runInContext(viewSource, viewContext);
const view = viewContext.window.ClozeWriting;
const options = (overrides = {}) => ({ mode: "study", showAnswers: false, revealed: new Map(), query: "",
  isInRound: () => false, keyFor: (card) => card.id, itemFor: () => undefined,
  canRemove: () => true, advanceButton: () => "", ...overrides });

function writingFixture() {
  const fixture = appFixture();
  vm.runInContext(viewSource, fixture.context);
  for (const document of documents) {
    fixture.app.state.exams.push(document);
    fixture.app.state.examById.set(document.id, document);
  }
  fixture.app.switchReviewChapter(5);
  return fixture;
}

test("four source documents retain every bullet, heading, table, and image without rewriting text", () => {
  assert.equal(documents.length, 4);
  for (let i = 0; i < documents.length; i += 1) {
    const document = documents[i];
    const markdown = fs.readFileSync(new URL(`../sources/writing/${index[i].filename}`, import.meta.url), "utf8");
    const blocks = parseWritingMarkdown(markdown);
    const expected = blocks.filter((block) => block.type === "group").flatMap((block) => block.parts);
    const actual = document.cards.flatMap((card) => card.writingModule ? [card.english, ...card.chinese] : card.type === "writing-note" ? card.lines : []);
    assert.deepEqual([...actual].sort(), [...expected].sort(), document.title);
    assert.equal(document.cards.filter((card) => card.type === "section").length, blocks.filter((block) => block.type === "heading").length);
    assert.equal(document.cards.filter((card) => card.type === "writing-table").length, blocks.filter((block) => block.type === "table").length);
    assert.equal(document.cards.filter((card) => card.type === "writing-image").length, blocks.filter((block) => block.type === "raw").length);
    assert.equal(new Set(document.cards.map((card) => card.id)).size, document.cards.length);
    assert.deepEqual(compileWritingDocument(index[i], markdown), document);
  }
  assert.ok(documents.every((document) => document.termCount > 25));
});

test("published writing data matches the verified sources and every source heading remains navigable", () => {
  const context = vm.createContext({ window: {} });
  vm.runInContext(fs.readFileSync(new URL("../writing-data.js", import.meta.url), "utf8"), context);
  assert.deepEqual(plain(context.window.WRITING_DATA), documents);
  for (const document of documents) {
    const result = view.render(document, options());
    assert.equal(result.toc.length, document.inventory.sections, document.title);
  }
});

test("verified added translations stay attached to their own English sentence", () => {
  for (let i = 0; i < documents.length; i += 1) {
    const blocks = parseWritingMarkdown(fs.readFileSync(new URL(`../sources/writing/${index[i].filename}`, import.meta.url), "utf8"));
    documents[i].cards.filter((card) => card.writingModule).forEach((card) => {
      const entries = index[i].nodeHints[card.sourceBlock].entries;
      const translation = entries.findIndex((entry) => entry.kind === "translation" && entry.ref === card.sourceRef);
      if (translation >= 0) assert.equal(card.chinese[0], blocks[card.sourceBlock].parts[translation]);
    });
  }
});

test("English is hidden, Chinese remains visible, and original bullets and highlights survive", () => {
  const result = view.render(documents[0], options());
  assert.match(result.html, /writing-answer is-hidden/);
  assert.match(result.html, /aria-label="显示英文" aria-expanded="false"/);
  assert.match(result.html, /writing-chinese/);
  assert.match(result.html, /正向——激动地/);
  assert.match(result.html, /writing-bullet[^>]*>·/);
  assert.match(result.html, /writing-highlight/);
  assert.equal(result.toc.length, documents[0].inventory.sections);
  const first = documents[0].cards.find((card) => card.writingModule);
  const revealed = view.render(documents[0], options({ revealed: new Map([[first.id, true]]) }));
  assert.match(revealed.html, /aria-label="隐藏英文" aria-expanded="true"/);
  const hidden = view.render(documents[0], options({ showAnswers: true, revealed: new Map([[first.id, false]]) }));
  assert.match(hidden.html, /writing-answer is-hidden/);
});

test("review shows selected English modules together with all independent Chinese annotations", () => {
  const document = documents[0];
  const first = document.cards.find((card) => card.writingModule);
  const result = view.render(document, options({ mode: "review", isInRound: (card) => card.id === first.id, itemFor: (card) => card.id === first.id ? { reviewRound: 1 } : undefined }));
  assert.equal(result.visibleModules, 1);
  assert.match(result.html, /Brimming with  excitement/);
  assert.doesNotMatch(result.html, /Remain composed/);
  for (const note of document.cards.filter((card) => card.type === "writing-note")) {
    for (const line of note.lines) assert.ok(result.html.includes(view.inline(line)), line);
  }
  assert.match(result.html, /writing-table/);
  const small = view.render(documents[1], options({ mode: "review" }));
  assert.match(small.html, /会议纪要/);
  assert.match(small.html, /meeting-minutes\.png/);
});

test("chapter five exposes only four writing files and membership does not touch old chapters", () => {
  const { app, nodes, mutations } = writingFixture();
  assert.equal(app.availableExams().length, 4);
  assert.equal(app.getActiveExam().id, documents[0].id);
  assert.equal((nodes.get("#yearList").innerHTML.match(/data-exam-id=/g) || []).length, 4);
  const card = documents[0].cards.find((item) => item.writingModule);
  const key = app.makeKey(documents[0].id, card.id, "module");
  assert.match(key, /::review-chapter-5$/);
  app.toggleTerm(documents[0].id, card.id, "module");
  assert.equal(app.itemsForChapter(5).length, 1);
  assert.deepEqual(plain(app.state.library[baseKey]), oldItem);
  assert.equal(mutations.at(-1)[1].reviewChapter, 5);
  app.state.mode = "review";
  app.renderContent();
  assert.equal((nodes.get("#content").innerHTML.match(/class="writing-module term-row/g) || []).length, 1);
  app.switchReviewChapter(2);
  assert.equal(app.availableExams().length, 1);
  assert.equal(app.getActiveExam().id, "year-test");
  assert.equal(app.itemsForChapter(2).length, 0);
  app.switchReviewChapter(5);
  assert.equal(app.itemsForChapter(5).length, 1);
});

test("revealing English does not add the module or change visible Chinese annotations", () => {
  const { app, nodes } = writingFixture();
  const card = documents[0].cards.find((item) => item.writingModule);
  const key = app.makeKey(documents[0].id, card.id, "module");
  app.toggleWritingAnswer(key);
  assert.equal(app.state.writingRevealedAnswers.get(key), true);
  assert.equal(app.itemsForChapter(5).length, 0);
  assert.match(nodes.get("#content").innerHTML, /aria-label="隐藏英文"/);
  app.toggleWritingAnswer(key);
  assert.equal(app.state.writingRevealedAnswers.get(key), false);
  assert.equal(app.itemsForChapter(1).length, 1);
});

test("source formatting is allowed but executable HTML remains escaped", () => {
  const html = view.inline('<font color="#ffff00">word</font><u>下划线</u><img src=x onerror=alert(1)><script>alert(2)</script>');
  assert.match(html, /writing-highlight/);
  assert.match(html, /<u>下划线<\/u>/);
  assert.doesNotMatch(html, /<img|<script/);
});
