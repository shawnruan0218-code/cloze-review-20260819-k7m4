import test from "node:test";
import assert from "node:assert/strict";
import { appFixture, baseKey, oldItem, plain } from "./app-fixture.mjs";

test("new chapter starts empty without carrying old membership or promoted rounds", () => {
  const { app } = appFixture();
  assert.equal(app.state.reviewChapter, 2);
  assert.equal(app.state.reviewRound, 1);
  assert.equal(app.itemsForChapter(2).length, 0);
  assert.equal(app.isSaved("year-test", "card-test", "term-0"), false);
  assert.deepEqual(plain(app.state.library[baseKey]), oldItem);
  assert.equal(app.itemsForChapter(1).length, 1);
});

test("the same word can belong to four independent chapters and removal is scoped", () => {
  const { app, mutations } = appFixture();
  for (const chapter of [2, 3, 4]) {
    app.switchReviewChapter(chapter);
    app.toggleTerm("year-test", "card-test", "term-0");
    assert.equal(app.itemsForChapter(chapter).length, 1);
    assert.equal(app.state.library[app.makeKey("year-test", "card-test", "term-0")].reviewRound, 1);
  }
  assert.equal(Object.keys(app.state.library).length, 4);
  app.switchReviewChapter(2);
  app.toggleTerm("year-test", "card-test", "term-0");
  assert.equal(app.itemsForChapter(2).length, 0);
  assert.equal(app.itemsForChapter(3).length, 1);
  assert.equal(app.itemsForChapter(4).length, 1);
  assert.deepEqual(plain(app.state.library[baseKey]), oldItem);
  assert.equal(mutations.at(-1)[2], `${baseKey}::review-chapter-2`);
  assert.equal(mutations.at(-1)[0], "delete");
});

test("switching chapters clears answer and search state and keeps per-chapter rounds", () => {
  const { app, storage, nodes } = appFixture();
  storage.set("cloze-review-active-round", "4");
  storage.set("cloze-review-active-round-chapter-2", "2");
  app.state.showAnswers = true;
  app.state.revealedTermKeys.add(baseKey);
  app.state.query = "alpha";
  app.state.mode = "review";
  const before = JSON.stringify(app.state.library);
  app.switchReviewChapter(3);
  assert.equal(app.state.mode, "study");
  assert.equal(app.state.showAnswers, false);
  assert.equal(app.state.revealedTermKeys.size, 0);
  assert.equal(app.state.query, "");
  assert.equal(nodes.get("#searchInput").value, "");
  app.switchReviewChapter(1);
  assert.equal(app.state.reviewRound, 4);
  app.switchReviewChapter(2);
  assert.equal(app.state.reviewRound, 2);
  assert.equal(JSON.stringify(app.state.library), before);
});

test("new chapter membership survives reload and cloud updates stay in their chapter", () => {
  const { app, storage } = appFixture();
  app.toggleTerm("year-test", "card-test", "term-0");
  const reloaded = appFixture({ storage }).app;
  assert.equal(reloaded.state.reviewChapter, 2);
  assert.equal(reloaded.savedItemsForExam("year-test").length, 1);
  reloaded.applyCloudRecords([{ entityType: "review_item", itemKey: `${baseKey}::review-chapter-3`, payload: { ...oldItem, reviewChapter: 3, reviewRound: 1 } }]);
  assert.equal(reloaded.itemsForChapter(2).length, 1);
  assert.equal(reloaded.itemsForChapter(3).length, 1);
  reloaded.applyCloudRecords([{ entityType: "review_item", itemKey: `${baseKey}::review-chapter-3`, deletedAt: "2026-10-13T00:00:00Z" }]);
  assert.equal(reloaded.itemsForChapter(3).length, 0);
  assert.equal(reloaded.itemsForChapter(1).length, 1);
});

test("round promotion and removal protection apply only inside the active chapter", () => {
  const { app } = appFixture();
  app.toggleTerm("year-test", "card-test", "term-0");
  app.state.mode = "review";
  app.advanceTermToNextRound("year-test", "card-test", "term-0");
  const item = app.state.library[`${baseKey}::review-chapter-2`];
  assert.equal(item.reviewRound, 2);
  assert.deepEqual(plain(app.state.library[baseKey]), oldItem);
  app.state.reviewRound = 2;
  assert.equal(app.canRemoveSavedItem(item), false);
  app.toggleTerm("year-test", "card-test", "term-0");
  assert.equal(app.itemsForChapter(2).length, 1);
});

test("Q can add and remove without moving the pointer after a render", () => {
  const { app, nodes } = appFixture();
  const row = { dataset: { examId: "year-test", cardId: "card-test", termId: "term-0" },
    classList: { add() {}, remove() {} } };
  nodes.get("#content").querySelectorAll = () => [row];
  app.state.hoveredTermRow = row;
  app.handleHoveredTermShortcut(row);
  assert.equal(app.itemsForChapter(2).length, 1);
  assert.equal(app.state.hoveredTermRow, row);
  app.handleHoveredTermShortcut(app.state.hoveredTermRow);
  assert.equal(app.itemsForChapter(2).length, 0);
  assert.equal(app.itemsForChapter(1).length, 1);
});

test("a cloud refresh keeps the hovered word available to cancel with Q", () => {
  const { app, nodes } = appFixture();
  const row = { dataset: { examId: "year-test", cardId: "card-test", termId: "term-0" },
    classList: { add() {}, remove() {} } };
  nodes.get("#content").querySelectorAll = () => [row];
  app.state.hoveredTermRow = row;
  app.handleHoveredTermShortcut(row);
  const key = `${baseKey}::review-chapter-2`;
  app.applyCloudRecords([{ entityType: "review_item", itemKey: key, payload: { ...app.state.library[key] } }]);
  assert.equal(app.state.hoveredTermRow, row);
  app.handleHoveredTermShortcut(row);
  assert.equal(app.itemsForChapter(2).length, 0);
  assert.equal(app.itemsForChapter(1).length, 1);
});
