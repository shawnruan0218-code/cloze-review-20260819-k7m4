import fs from "node:fs";
import vm from "node:vm";

export const baseKey = "year-test::card-test::term-0";
export const oldItem = {
  examId: "year-test", cardId: "card-test", termId: "term-0",
  addedAt: "2026-07-01T00:00:00.000Z", reviewRound: 4,
  preservedField: { original: true },
};

export function appFixture({ storage = new Map(), library = { [baseKey]: oldItem }, touch = false } = {}) {
  if (!storage.has("cloze-review-library-v1")) storage.set("cloze-review-library-v1", JSON.stringify(library));
  const nodes = new Map();
  const mutations = [];
  const element = () => ({
    innerHTML: "", textContent: "", value: "", dataset: {}, attrs: {}, listeners: {},
    addEventListener(type, handler) { this.listeners[type] = handler; },
    setAttribute(key, value) { this.attrs[key] = value; },
    querySelectorAll() { return []; },
    classList: { add() {}, remove() {}, toggle() {} },
  });
  const context = vm.createContext({
    console, setTimeout: () => 1, clearTimeout() {},
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
    },
    document: {
      querySelector(selector) {
        if (!nodes.has(selector)) nodes.set(selector, element());
        return nodes.get(selector);
      },
      querySelectorAll() { return []; }, addEventListener() {},
      body: { ...element(), contains: () => true },
    },
    window: {
      EXAM_DATA: [], matchMedia: () => ({ matches: touch, addEventListener() {} }),
      ClozeCloudSync: { configured: false, enqueueReview: (...args) => mutations.push(args) },
    },
  });
  vm.runInContext(fs.readFileSync(new URL("../app.js", import.meta.url), "utf8"), context);
  const app = vm.runInContext(`({ state, switchReviewChapter, makeKey, itemsForChapter,
    savedItemsForExam, isSaved, isInReviewRound, toggleTerm, advanceTermToNextRound,
    applyCloudRecords, loadLibrary, canRemoveSavedItem, handleHoveredTermShortcut,
    availableExams, getActiveExam, renderContent, renderYearList, toggleWritingAnswer, bindEvents })`, context);
  const exam = {
    id: "year-test", title: "测试真题", year: "2020", courseId: "english1", courseTitle: "英语一", clozeCount: 2,
    cards: [{ id: "card-test", examId: "year-test", type: "card", clozeCount: 2,
      sentenceLines: ['An <font color="#ffff00">alpha</font> sentence.'],
      translationLine: "翻译：<u>一个句子。</u>",
      terms: [{ id: "term-0", title: "alpha", lines: ["**alpha**：<u>第一个。</u>"] }] }],
  };
  app.state.exams = [exam];
  app.state.examById.set(exam.id, exam);
  app.state.activeExamId = exam.id;
  return { app, storage, nodes, mutations, context };
}

export function plain(value) { return JSON.parse(JSON.stringify(value)); }
