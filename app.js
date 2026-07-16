const STORAGE_KEY = "cloze-review-library-v1";
const LAST_YEAR_KEY = "cloze-review-last-year";
const HOVER_REVEAL_KEY = "cloze-review-hover-reveal";
const AUTH_SESSION_KEY = "cloze-review-supabase-session";
const COLLAPSED_GROUPS_KEY = "cloze-review-collapsed-groups";
const FONT_SIZE_KEY = "cloze-review-font-size";
const REVIEW_ROUND_KEY = "cloze-review-active-round";
const ANNOTATION_STORAGE_KEY = "cloze-review-annotations-v1";
const TOUCH_MODE_QUERY = "(hover: none), (pointer: coarse), (max-width: 700px)";
const FONT_SIZES = new Set(["small", "medium", "large"]);
const CLOUD_PAGE_SIZE = 1000;
const CLOUD_WRITE_BATCH_SIZE = 500;
const MAX_REVIEW_ROUND = 4;
const CLOUD_ROUND_MARKER = "::review-round-";
const CLOUD_ANNOTATION_MARKER = "::cloze-annotation::";

const els = {
  yearList: document.querySelector("#yearList"),
  yearTitle: document.querySelector("#yearTitle"),
  modeLabel: document.querySelector("#modeLabel"),
  studyMode: document.querySelector("#studyMode"),
  reviewMode: document.querySelector("#reviewMode"),
  reviewRounds: document.querySelector("#reviewRounds"),
  reviewRoundButtons: [...document.querySelectorAll("[data-review-round]")],
  toggleAnswers: document.querySelector("#toggleAnswers"),
  hoverReveal: document.querySelector("#hoverReveal"),
  fontSizeButtons: [...document.querySelectorAll("[data-font-size]")],
  searchInput: document.querySelector("#searchInput"),
  syncCard: document.querySelector("#syncCard"),
  syncTitle: document.querySelector("#syncTitle"),
  syncDetail: document.querySelector("#syncDetail"),
  authForm: document.querySelector("#authForm"),
  emailInput: document.querySelector("#emailInput"),
  passwordInput: document.querySelector("#passwordInput"),
  signInButton: document.querySelector("#signInButton"),
  signUpButton: document.querySelector("#signUpButton"),
  syncNowButton: document.querySelector("#syncNowButton"),
  signOutButton: document.querySelector("#signOutButton"),
  statsStrip: document.querySelector("#statsStrip"),
  content: document.querySelector("#content"),
  toast: document.querySelector("#toast"),
  sourceDialog: document.querySelector("#sourceDialog"),
  sourceTitle: document.querySelector("#sourceTitle"),
  sourceSentence: document.querySelector("#sourceSentence"),
  sourceTranslation: document.querySelector("#sourceTranslation"),
  sourceNote: document.querySelector("#sourceNote"),
  sourceClose: document.querySelector("#sourceClose"),
  annotationDialog: document.querySelector("#annotationDialog"),
  annotationSelection: document.querySelector("#annotationSelection"),
  annotationInput: document.querySelector("#annotationInput"),
  annotationCancel: document.querySelector("#annotationCancel"),
  annotationDelete: document.querySelector("#annotationDelete"),
  annotationSave: document.querySelector("#annotationSave"),
  annotationTooltip: document.querySelector("#annotationTooltip"),
};

const syncConfig = normalizeSyncConfig(window.SYNC_CONFIG || {});
const touchModeMedia = window.matchMedia(TOUCH_MODE_QUERY);

const state = {
  exams: [],
  examById: new Map(),
  activeExamId: "",
  mode: "study",
  reviewRound: loadReviewRound(),
  showAnswers: false,
  hoverReveal: localStorage.getItem(HOVER_REVEAL_KEY) !== "off",
  fontSize: loadFontSize(),
  touchMode: touchModeMedia.matches,
  query: "",
  library: loadLibrary(),
  annotations: loadAnnotations(),
  collapsedCourseIds: loadCollapsedCourseIds(),
  hoveredTermRow: null,
  hoveredEnglishCell: null,
  hoveredAnnotationId: "",
  pendingAnnotation: null,
  revealedTermKeys: new Set(),
  authSession: loadAuthSession(),
  syncConfigured: Boolean(syncConfig.supabaseUrl && syncConfig.supabaseAnonKey),
  syncBusy: false,
  syncMessage: "",
  syncTimer: null,
  toastTimer: null,
};

init();

function init() {
  if (!Array.isArray(window.EXAM_DATA) || window.EXAM_DATA.length === 0) {
    els.content.innerHTML = `<div class="empty">没有找到真题数据。</div>`;
    return;
  }

  state.exams = window.EXAM_DATA.map(parseExam);
  state.examById = new Map(state.exams.map((exam) => [exam.id, exam]));
  state.activeExamId =
    localStorage.getItem(LAST_YEAR_KEY) || state.exams[0]?.id || "";

  if (!state.examById.has(state.activeExamId)) {
    state.activeExamId = state.exams[0].id;
  }

  bindEvents();
  render();
  bootstrapSync();
}

function bindEvents() {
  els.studyMode.addEventListener("click", () => {
    state.mode = "study";
    render();
  });

  els.reviewMode.addEventListener("click", () => {
    state.mode = "review";
    render();
  });

  els.reviewRoundButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.reviewRound = normalizeReviewRound(button.dataset.reviewRound);
      localStorage.setItem(REVIEW_ROUND_KEY, String(state.reviewRound));
      render();
    });
  });

  els.toggleAnswers.addEventListener("click", () => {
    state.showAnswers = !state.showAnswers;
    render();
  });

  els.hoverReveal.addEventListener("click", () => {
    state.hoverReveal = !state.hoverReveal;
    localStorage.setItem(HOVER_REVEAL_KEY, state.hoverReveal ? "on" : "off");
    renderChrome();
  });

  els.fontSizeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.fontSize = normalizeFontSize(button.dataset.fontSize);
      localStorage.setItem(FONT_SIZE_KEY, state.fontSize);
      renderChrome();
    });
  });

  els.authForm.addEventListener("submit", (event) => {
    event.preventDefault();
    signIn();
  });

  els.signUpButton.addEventListener("click", () => signUp());
  els.syncNowButton.addEventListener("click", () => syncFromCloud({ mergeLocal: true }));
  els.signOutButton.addEventListener("click", () => signOut());
  els.sourceClose.addEventListener("click", () => closeSourceDialog());
  els.sourceDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeSourceDialog();
  });
  els.annotationCancel.addEventListener("click", () => closeAnnotationDialog());
  els.annotationDelete.addEventListener("click", () => deletePendingAnnotation());
  els.annotationSave.addEventListener("click", () => savePendingAnnotation());
  els.annotationDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeAnnotationDialog();
  });

  els.searchInput.addEventListener("input", (event) => {
    state.query = event.target.value.trim().toLowerCase();
    renderContent();
  });

  touchModeMedia.addEventListener("change", (event) => {
    state.touchMode = event.matches;
    if (state.touchMode) clearHoveredTermRow();
    renderChrome();
  });

  window.addEventListener("focus", () => {
    if (state.authSession) syncFromCloud({ silent: true });
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.authSession) syncFromCloud({ silent: true });
  });

  document.addEventListener("keydown", (event) => {
    if (state.touchMode) return;
    const key = event.key.toLowerCase();
    if (!new Set(["q", "w", "e"]).has(key) || event.repeat) return;

    if (key === "w") {
      const hasAnnotationTarget = Boolean(
        state.hoveredAnnotationId || hoveredEnglishTarget()
      );
      if (isEditableTarget(event.target) && !hasAnnotationTarget) return;
      event.preventDefault();
      openAnnotationEditorFromHover();
      return;
    }

    if (isEditableTarget(event.target)) return;

    const row = state.hoveredTermRow;
    if (!row || !document.body.contains(row)) return;

    event.preventDefault();
    if (key === "e") {
      openSourceDialogFromHover(row);
      return;
    }
    handleHoveredTermShortcut(row);
  });

  els.yearList.addEventListener("click", (event) => {
    const groupButton = event.target.closest("[data-course-toggle]");
    if (groupButton) {
      toggleCourseGroup(groupButton.dataset.courseToggle);
      return;
    }

    const button = event.target.closest("[data-exam-id]");
    if (!button) return;
    state.activeExamId = button.dataset.examId;
    localStorage.setItem(LAST_YEAR_KEY, state.activeExamId);
    render();
  });

  els.content.addEventListener("click", (event) => {
    const cloze = event.target.closest(".cloze");
    if (cloze) {
      cloze.classList.toggle("is-hidden");
      cloze.classList.toggle("is-revealed");
      return;
    }

    const termTarget = event.target.closest("[data-action='toggle-term']");
    if (termTarget) {
      toggleTerm(termTarget.dataset.examId, termTarget.dataset.cardId, termTarget.dataset.termId);
      return;
    }

    const advanceTarget = event.target.closest("[data-action='advance-round']");
    if (advanceTarget) {
      advanceTermToNextRound(
        advanceTarget.dataset.examId,
        advanceTarget.dataset.cardId,
        advanceTarget.dataset.termId
      );
      return;
    }

    const rowTarget = event.target.closest(".term-row[data-term-id], .cloze-table-row[data-term-id]");
    if (rowTarget) {
      if (rowTarget.classList.contains("cloze-table-row")) return;
      if (state.mode === "review") return;
      toggleTerm(rowTarget.dataset.examId, rowTarget.dataset.cardId, rowTarget.dataset.termId);
      return;
    }
  });

  els.content.addEventListener("mouseover", (event) => {
    if (state.touchMode) return;
    updateHoveredTermRow(event);
    updateHoveredEnglishCell(event);
    updateHoveredAnnotation(event);
    if (!state.hoverReveal) return;
    const cloze = event.target.closest(".cloze.is-hidden");
    if (cloze) cloze.classList.add("is-hovered");
  });

  els.content.addEventListener("mousemove", (event) => {
    if (!state.touchMode) {
      updateHoveredTermRow(event);
      updateHoveredEnglishCell(event);
      updateHoveredAnnotation(event);
      positionAnnotationTooltip(event);
    }
  });
  els.content.addEventListener("pointerover", (event) => {
    if (!state.touchMode) {
      updateHoveredTermRow(event);
      updateHoveredEnglishCell(event);
      updateHoveredAnnotation(event);
    }
  });
  els.content.addEventListener("pointermove", (event) => {
    if (!state.touchMode) {
      updateHoveredTermRow(event);
      updateHoveredEnglishCell(event);
    }
  });

  els.content.addEventListener("mouseout", (event) => {
    const row = event.target.closest(".term-row[data-term-id], .cloze-table-row[data-term-id]");
    if (row && !row.contains(event.relatedTarget)) clearHoveredTermRow(row);

    const cloze = event.target.closest(".cloze.is-hidden");
    const englishCell = event.target.closest(".cloze-english-cell");
    if (englishCell && !englishCell.contains(event.relatedTarget)) {
      clearHoveredEnglishCell(englishCell);
    }
    const annotation = event.target.closest(".cloze-annotation[data-annotation-id]");
    if (annotation && !annotation.contains(event.relatedTarget)) clearHoveredAnnotation(annotation);
    if (!cloze || cloze.contains(event.relatedTarget)) return;
    cloze.classList.remove("is-hovered");
  });

  els.content.addEventListener("pointerout", (event) => {
    const row = event.target.closest(".term-row[data-term-id], .cloze-table-row[data-term-id]");
    if (row && !row.contains(event.relatedTarget)) clearHoveredTermRow(row);
    const englishCell = event.target.closest(".cloze-english-cell");
    if (englishCell && !englishCell.contains(event.relatedTarget)) {
      clearHoveredEnglishCell(englishCell);
    }
    const annotation = event.target.closest(".cloze-annotation[data-annotation-id]");
    if (annotation && !annotation.contains(event.relatedTarget)) clearHoveredAnnotation(annotation);
  });
}

function parseExam(file) {
  const blocks = file.content
    .replace(/\r\n/g, "\n")
    .split(/^---\s*$/m)
    .map((block) => block.trim())
    .filter(Boolean);

  const cards = blocks.flatMap((block, index) =>
    expandEmbeddedSeparatorBlock(file, block, index)
  );
  const termCount = cards.reduce((sum, card) => sum + (card.terms?.length || 0), 0);
  const clozeCount = cards.reduce((sum, card) => sum + (card.clozeCount || 0), 0);

  return {
    ...file,
    cards,
    termCount,
    clozeCount,
  };
}

function expandEmbeddedSeparatorBlock(file, raw, index) {
  if (file.id !== "year-2012") return [parseBlock(file, raw, index)];

  const legacyCard = parseBlock(file, raw, index);
  const parts = raw
    .split(/^⸻\s*$/m)
    .flatMap(splitReadingSectionParts)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 1) return [legacyCard];

  const legacyTerms = legacyCard.terms || [];
  let legacyTermCursor = 0;
  let fallbackTermIndex = legacyTerms.length;

  return parts.map((part, partIndex) => {
    const card = parseBlock(file, part, index);
    const terms = (card.terms || []).map((term) => {
      const signature = termSignature(term);
      let legacyIndex = legacyTerms.findIndex(
        (legacyTerm, candidateIndex) =>
          candidateIndex >= legacyTermCursor &&
          termSignature(legacyTerm) === signature
      );
      if (legacyIndex < 0) {
        legacyIndex = legacyTerms.findIndex(
          (legacyTerm, candidateIndex) =>
            candidateIndex >= legacyTermCursor &&
            normalizeMatchText(legacyTerm.title) === normalizeMatchText(term.title)
        );
      }

      if (legacyIndex >= 0) {
        legacyTermCursor = legacyIndex + 1;
        return { ...term, id: legacyTerms[legacyIndex].id };
      }

      const fallbackId = `term-${fallbackTermIndex}`;
      fallbackTermIndex += 1;
      return { ...term, id: fallbackId };
    });

    return {
      ...card,
      id: `${legacyCard.id}-part-${partIndex}`,
      storageCardId: legacyCard.id,
      terms,
    };
  });
}

function splitReadingSectionParts(raw) {
  const parts = [];
  let current = [];

  const pushCurrent = () => {
    const content = current.join("\n").trim();
    if (content) parts.push(content);
    current = [];
  };

  raw.split("\n").forEach((line) => {
    const cleaned = line.trim();
    const isSectionHeading =
      /^#{1,6}\s+/.test(cleaned) ||
      /^第[一二三四五六七八九十]+篇(?:阅读)?$/.test(cleaned);
    if (!isSectionHeading) {
      current.push(line);
      return;
    }

    pushCurrent();
    parts.push(cleaned.replace(/^#{1,6}\s+/, ""));
  });

  pushCurrent();
  return parts;
}

function termSignature(term) {
  return stripMarkup(term?.lines?.[0] || term?.title || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function parseBlock(file, raw, index) {
  const explicitIdMatch = raw.match(/<!--\s*card-id:\s*([a-z0-9_-]+)\s*-->/i);
  const sourceContext = explicitIdMatch
    ? file.clozeContexts?.[explicitIdMatch[1]] || null
    : null;
  const lines = raw
    .split("\n")
    .filter((line) => !/^<!--\s*card-id:/i.test(line.trim()));
  const translationIndex = lines.findIndex((line) =>
    /^翻译\s*[:：]/.test(line.trim())
  );

  if (translationIndex < 0) {
    return {
      type: "section",
      id: explicitIdMatch ? `${file.id}-section-${explicitIdMatch[1]}` : `${file.id}-section-${index}`,
      examId: file.id,
      raw,
      title: stripMarkup(raw).trim(),
      searchableText: stripMarkup(raw).toLowerCase(),
    };
  }

  const sentenceLines = trimBlankLines(lines.slice(0, translationIndex));
  const translationLine = lines[translationIndex] || "";
  const explainLines = lines.slice(translationIndex + 1);
  const terms = parseTerms(explainLines).map((term, termIndex) => ({
    ...term,
    id: `term-${termIndex}`,
  }));

  const clozeCount = countMatches(
    [translationLine, ...explainLines].join("\n"),
    /<u\b[^>]*>/gi
  );

  return {
    type: "card",
    id: explicitIdMatch ? `${file.id}-card-${explicitIdMatch[1]}` : `${file.id}-card-${index}`,
    examId: file.id,
    raw,
    sentenceLines,
    translationLine,
    terms,
    clozeCount,
    sourceContext,
    searchableText: stripMarkup(raw).toLowerCase(),
  };
}

function parseTerms(lines) {
  const terms = [];
  let current = null;

  lines.forEach((line) => {
    const cleaned = line.trim();

    if (!cleaned) {
      if (current) current.lines.push("");
      return;
    }

    if (isNoiseLine(cleaned)) return;

    if (isTermStart(cleaned, Boolean(current))) {
      if (current) terms.push(normalizeTerm(current));
      const body = cleanTermLine(cleaned);
      current = {
        title: extractTermTitle(body),
        lines: [body],
      };
      return;
    }

    if (current) {
      current.lines.push(cleaned);
      return;
    }

    if (cleaned.includes("<u")) {
      current = {
        title: extractTermTitle(cleaned) || "说明",
        lines: [cleaned],
      };
    }
  });

  if (current) terms.push(normalizeTerm(current));
  return terms.filter((term) => term.lines.some((line) => line.trim()));
}

function isTermStart(line, hasCurrent) {
  if (!/^\(?\s*-\s*/.test(line)) return false;
  const body = cleanTermLine(line);
  if (!body || body === "-") return false;
  if (/^\*\*.+?\*\*/.test(body)) return true;

  const beforeUnderline = body.split(/<u\b/i)[0].trim();
  const beforeColon = body.split(/[：:]/)[0].trim();
  const candidate = stripMarkup(beforeUnderline || beforeColon)
    .replace(/^[-\s]+/, "")
    .replace(/[：:，,。.;；]+$/, "")
    .trim();

  if (!candidate && !hasCurrent && body.includes("<u")) return true;
  if (!candidate) return false;
  if (/[`=+]/.test(beforeUnderline || beforeColon)) return false;
  if (candidate.length > 80) return false;
  return body.includes("<u") || body.includes("：") || body.includes(":");
}

function cleanTermLine(line) {
  return line
    .trim()
    .replace(/^\(\s*/, "")
    .replace(/^-\s*/, "")
    .trim();
}

function normalizeTerm(term) {
  return {
    ...term,
    title: term.title || "说明",
    lines: trimBlankLines(term.lines),
  };
}

function extractTermTitle(body) {
  const boldMatch = body.match(/\*\*(.+?)\*\*/);
  if (boldMatch) return stripMarkup(boldMatch[1]).trim();

  const beforeUnderline = body.split(/<u\b/i)[0].trim();
  const beforeColon = body.split(/[：:]/)[0].trim();
  const candidate = stripMarkup(beforeUnderline || beforeColon)
    .replace(/^[-\s]+/, "")
    .replace(/[：:，,。.;；]+$/, "")
    .trim();

  if (candidate) return candidate;

  return stripMarkup(body)
    .replace(/\s+/g, " ")
    .slice(0, 24)
    .trim();
}

function render() {
  renderYearList();
  renderChrome();
  renderReviewRounds();
  renderSyncPanel();
  renderStats();
  renderContent();
}

function renderYearList() {
  els.yearList.innerHTML = groupedExams()
    .map(
      (group) => {
        const collapsed = state.collapsedCourseIds.has(group.id);
        const savedCount = group.exams.reduce(
          (sum, exam) => sum + savedItemsForExam(exam.id).length,
          0
        );
        return `
        <div class="exam-group${collapsed ? " is-collapsed" : ""}">
          <button class="exam-group-title" type="button" data-course-toggle="${group.id}" aria-expanded="${String(!collapsed)}">
            <span>${group.title}</span>
            <small>${savedCount}</small>
          </button>
          <div class="exam-group-items" ${collapsed ? "hidden" : ""}>
            ${group.exams
              .map((exam) => {
                const savedCount = savedItemsForExam(exam.id).length;
                const activeClass = exam.id === state.activeExamId ? " is-active" : "";
                return `
                  <button class="year-button${activeClass}" type="button" data-exam-id="${exam.id}">
                    <strong>${exam.year}</strong>
                    <span>${savedCount}</span>
                  </button>
                `;
              })
              .join("")}
          </div>
        </div>
      `;
      }
    )
    .join("");
}

function toggleCourseGroup(courseId) {
  if (!courseId) return;
  if (state.collapsedCourseIds.has(courseId)) {
    state.collapsedCourseIds.delete(courseId);
  } else {
    state.collapsedCourseIds.add(courseId);
  }
  saveCollapsedCourseIds();
  renderYearList();
}

function groupedExams() {
  const groups = [];
  const groupById = new Map();

  state.exams.forEach((exam) => {
    const id = exam.courseId || "english1";
    if (!groupById.has(id)) {
      const group = {
        id,
        title: exam.courseTitle || "英语一",
        exams: [],
      };
      groups.push(group);
      groupById.set(id, group);
    }
    groupById.get(id).exams.push(exam);
  });

  return groups;
}

function renderChrome() {
  const exam = getActiveExam();
  els.yearTitle.textContent = exam?.title || "英语真题";
  els.modeLabel.textContent = state.mode === "study" ? "真题训练" : "复习库";
  els.studyMode.classList.toggle("is-active", state.mode === "study");
  els.reviewMode.classList.toggle("is-active", state.mode === "review");
  els.toggleAnswers.classList.toggle("is-on", state.showAnswers);
  els.toggleAnswers.title = state.showAnswers ? "隐藏答案" : "显示答案";
  els.hoverReveal.hidden = state.touchMode;
  els.hoverReveal.classList.toggle("is-on", !state.touchMode && state.hoverReveal);
  els.hoverReveal.title = state.hoverReveal ? "关闭悬停显示" : "开启悬停显示";
  document.body.dataset.fontSize = state.fontSize;
  els.fontSizeButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.fontSize === state.fontSize);
  });
  document.body.classList.toggle("hover-reveal", !state.touchMode && state.hoverReveal);
  document.body.classList.toggle("touch-mode", state.touchMode);
  if (state.touchMode || !state.hoverReveal) clearHoveredClozes();
}

function renderReviewRounds() {
  const reviewMode = state.mode === "review";
  els.reviewRounds.hidden = !reviewMode;
  if (!reviewMode) return;

  const exam = getActiveExam();
  els.reviewRoundButtons.forEach((button) => {
    const round = normalizeReviewRound(button.dataset.reviewRound);
    const count = savedItemsForExam(exam.id).filter(
      (item) => reviewRoundOf(item) >= round
    ).length;
    button.classList.toggle("is-active", round === state.reviewRound);
    button.setAttribute("aria-pressed", String(round === state.reviewRound));
    button.innerHTML = `<span>${round} 轮</span><small>${count}</small>`;
  });
}

function renderSyncPanel() {
  const signedIn = Boolean(state.authSession?.access_token);
  const email = state.authSession?.user?.email || "";

  els.syncCard.classList.toggle("is-configured", state.syncConfigured);
  els.syncCard.classList.toggle("is-signed-in", signedIn);
  els.syncCard.classList.toggle("is-busy", state.syncBusy);
  els.emailInput.disabled = !state.syncConfigured || signedIn || state.syncBusy;
  els.passwordInput.disabled = !state.syncConfigured || signedIn || state.syncBusy;
  els.signInButton.disabled = !state.syncConfigured || signedIn || state.syncBusy;
  els.signUpButton.disabled = !state.syncConfigured || signedIn || state.syncBusy;
  els.syncNowButton.disabled = !state.syncConfigured || !signedIn || state.syncBusy;
  els.signOutButton.disabled = !signedIn || state.syncBusy;

  if (!state.syncConfigured) {
    els.syncTitle.textContent = "本地模式";
    els.syncDetail.textContent = "填好 sync-config.js 后可跨设备同步";
    return;
  }

  if (!signedIn) {
    els.syncTitle.textContent = "云同步未登录";
    els.syncDetail.textContent = state.syncMessage || "登录同一个账号即可同步手机和电脑";
    return;
  }

  els.syncTitle.textContent = state.syncBusy ? "正在同步" : "云同步已登录";
  els.syncDetail.textContent = state.syncMessage || email;
}

function renderStats() {
  const exam = getActiveExam();
  const reviewItems = savedItemsForExam(exam.id);
  const activeRoundItems = reviewItems.filter(
    (item) => reviewRoundOf(item) >= state.reviewRound
  );
  const reviewCards = state.mode === "review"
    ? reviewCardsForExam(exam).length
    : new Set(activeRoundItems.map((item) => item.cardId)).size;
  const clozeExam = isClozeExam(exam);

  els.statsStrip.innerHTML = `
    <div class="stat"><strong>${exam.cards.filter((card) => card.type === "card").length}</strong><span>${clozeExam ? "表格词条" : "句子"}</span></div>
    <div class="stat"><strong>${exam.clozeCount}</strong><span>${clozeExam ? "中文挖空" : "挖空"}</span></div>
    <div class="stat"><strong>${state.mode === "review" ? reviewCards : reviewItems.length}</strong><span>${state.mode === "review" ? (clozeExam ? "复习词条" : "复习句子") : "复习词条"}</span></div>
  `;
}

function renderContent() {
  const exam = getActiveExam();
  if (!exam) return;
  state.hoveredTermRow = null;
  state.hoveredEnglishCell = null;
  clearHoveredAnnotation();

  const cards = state.mode === "review" ? reviewCardsForExam(exam) : studyCardsForExam(exam);
  const filtered = filterCards(cards);

  if (filtered.length === 0) {
    els.content.innerHTML =
      state.mode === "review"
        ? `<div class="empty">第 ${state.reviewRound} 轮还没有内容。</div>`
        : `<div class="empty">没有匹配内容。</div>`;
    return;
  }

  if (isClozeExam(exam)) {
    els.content.innerHTML = renderClozeTable(filtered);
    return;
  }

  els.content.innerHTML = filtered
    .map((card) => {
      if (card.type === "section") {
        return `<div class="section-title">${renderInline(card.title, "text")}</div>`;
      }
      return state.mode === "review" ? renderReviewCard(card) : renderStudyCard(card);
    })
    .join("");
}

function studyCardsForExam(exam) {
  return exam.cards;
}

function reviewCardsForExam(exam) {
  return exam.cards
    .filter((card) => card.type === "card")
    .map((card) => ({
      ...card,
      terms: card.terms.filter((term) =>
        isInReviewRound(exam.id, storageCardId(card), term.id, state.reviewRound)
      ),
    }))
    .filter((card) => card.terms.length > 0);
}

function filterCards(cards) {
  if (!state.query) return cards;
  return cards.filter((card) => {
    if (card.searchableText?.includes(state.query)) return true;
    return card.terms?.some((term) =>
      `${term.title} ${stripMarkup(term.lines.join(" "))}`
        .toLowerCase()
        .includes(state.query)
    );
  });
}

function renderStudyCard(card) {
  return `
    <article class="card" data-card-id="${card.id}">
      <div class="card-inner">
        ${renderSentence(card)}
        ${renderTranslation(card)}
        ${renderTermList(card, card.terms, "study")}
      </div>
    </article>
  `;
}

function renderReviewCard(card) {
  return `
    <article class="card review-card" data-card-id="${card.id}">
      <div class="card-inner">
        ${renderSentence(card, card.terms)}
        ${renderTranslation(card)}
        ${renderTermList(card, card.terms, "review")}
      </div>
    </article>
  `;
}

function renderClozeTable(cards) {
  const rows = cards.filter((card) => card.type === "card");
  return `
    <article class="card cloze-table-card">
      <div class="cloze-table-wrap">
        <table class="cloze-table">
          <thead>
            <tr>
              <th class="cloze-action-col"></th>
              <th>English</th>
              <th>中文</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((card) => renderClozeTableRow(card)).join("")}
          </tbody>
        </table>
      </div>
    </article>
  `;
}

function renderClozeTableRow(card) {
  const term = card.terms[0];
  if (!term) return "";

  const termKey = makeKey(card.examId, card.id, term.id);
  const saved = isSaved(card.examId, card.id, term.id);
  const item = state.library[termKey];
  const removalLocked = saved && !canRemoveSavedItem(item);
  const revealTerm = state.revealedTermKeys.has(termKey);
  const savedClass = saved ? " is-saved" : "";
  const lockedClass = removalLocked ? " is-removal-locked" : "";
  const symbol = saved ? "✓" : "+";
  const title = removalLocked
    ? "已保护，请到第 1 轮移出"
    : saved
      ? "移出整个复习库"
      : "加入复习库";
  const disabled = removalLocked ? " disabled" : "";
  const englishText = stripMarkup(card.sentenceLines.join(" ")).trim();
  const english = renderAnnotatedEnglish(card.examId, card.id, englishText);
  const meaning = card.translationLine.replace(/^翻译\s*[:：]\s*/, "");

  return `
    <tr class="cloze-table-row" data-exam-id="${card.examId}" data-card-id="${card.id}" data-term-id="${term.id}">
      <td class="cloze-action-col">
        <div class="term-actions">
          <button class="term-toggle${savedClass}${lockedClass}" type="button" title="${title}" aria-label="${title}" data-action="toggle-term" data-exam-id="${card.examId}" data-card-id="${card.id}" data-term-id="${term.id}"${disabled}>${symbol}</button>
          ${state.mode === "review" ? renderAdvanceButton(card, term) : ""}
        </div>
      </td>
      <td class="cloze-english-cell" tabindex="-1"><span class="cloze-english-text">${english}</span></td>
      <td class="cloze-meaning-cell">${renderInline(meaning, "translation", null, revealTerm)}</td>
    </tr>
  `;
}

function renderAnnotatedEnglish(examId, cardId, english) {
  const annotations = Object.values(state.annotations)
    .filter(
      (annotation) =>
        !annotation.deletedAt &&
        annotation.examId === examId &&
        annotation.cardId === cardId
    )
    .map((annotation) => ({
      annotation,
      range: resolveAnnotationRange(annotation, english),
    }))
    .filter((entry) => entry.range)
    .sort((left, right) => left.range.start - right.range.start);

  if (!annotations.length) return escapeHtml(english);

  let cursor = 0;
  let html = "";
  annotations.forEach(({ annotation, range }) => {
    if (range.start < cursor) return;
    html += escapeHtml(english.slice(cursor, range.start));
    html += `<mark class="cloze-annotation" data-annotation-id="${escapeHtml(annotation.id)}" tabindex="0">${escapeHtml(english.slice(range.start, range.end))}</mark>`;
    cursor = range.end;
  });
  html += escapeHtml(english.slice(cursor));
  return html;
}

function resolveAnnotationRange(annotation, english) {
  const start = Number(annotation.start);
  const end = Number(annotation.end);
  if (
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end > start &&
    english.slice(start, end) === annotation.selectedText
  ) {
    return { start, end };
  }

  const selectedText = String(annotation.selectedText || "");
  if (!selectedText) return null;
  const fallbackStart = english.indexOf(selectedText);
  if (fallbackStart < 0) return null;
  return { start: fallbackStart, end: fallbackStart + selectedText.length };
}

function openSourceDialogFromHover(row) {
  const exam = getActiveExam();
  if (!isClozeExam(exam)) return;

  const card = exam.cards.find(
    (candidate) =>
      candidate.type === "card" &&
      (candidate.id === row.dataset.cardId ||
        storageCardId(candidate) === row.dataset.cardId)
  );
  const term = card?.terms?.find((candidate) => candidate.id === row.dataset.termId);
  const context = card?.sourceContext;

  if (!context?.sentence || !context?.translation) {
    showToast("这个词条没有对应的文章原句");
    return;
  }

  els.sourceTitle.textContent = term?.title || "词条原句";
  els.sourceSentence.innerHTML = renderInline(context.sentence, "sentence");
  els.sourceTranslation.textContent = context.translation;
  els.sourceNote.classList.toggle("is-correct", context.answerStatus === "correct");
  els.sourceNote.classList.toggle("is-wrong", context.answerStatus === "wrong");
  els.sourceNote.textContent =
    context.answerStatus === "correct"
      ? "正确答案：该词已放回对应空位。"
      : context.answerStatus === "wrong"
        ? "错误选项：该词仅为回看而放回对应空位，并不是本题正确答案。"
        : "该词已放回对应空位，便于查看它在句中的搭配。";
  els.sourceNote.hidden = !context.substituted;
  els.sourceDialog.showModal();
}

function closeSourceDialog() {
  if (els.sourceDialog.open) els.sourceDialog.close();
}

function openAnnotationEditorFromHover() {
  if (!isClozeExam(getActiveExam())) {
    showToast("W 注释仅用于完形表格");
    return;
  }

  const existing = state.annotations[state.hoveredAnnotationId];
  if (existing && !existing.deletedAt) {
    openAnnotationDialog(existing);
    return;
  }

  const target = hoveredEnglishTarget();
  if (!target) {
    showToast("请把鼠标悬停在英文词条上");
    return;
  }

  const existingForTerm = Object.values(state.annotations).find(
    (annotation) =>
      !annotation.deletedAt &&
      annotation.examId === target.examId &&
      annotation.cardId === target.cardId
  );
  if (existingForTerm) {
    openAnnotationDialog(existingForTerm);
    return;
  }

  openAnnotationDialog({
    id: createAnnotationId(),
    examId: target.examId,
    cardId: target.cardId,
    start: target.start,
    end: target.end,
    selectedText: target.selectedText,
    note: "",
    createdAt: new Date().toISOString(),
  }, true);
}

function hoveredEnglishTarget() {
  const cell = state.hoveredEnglishCell;
  if (!cell || !document.body.contains(cell)) return null;

  const row = cell.closest(".cloze-table-row[data-card-id]");
  const selectedText = cell.textContent?.trim() || "";
  if (!row || !selectedText) return null;
  return {
    examId: row.dataset.examId,
    cardId: row.dataset.cardId,
    start: 0,
    end: selectedText.length,
    selectedText,
  };
}

function openAnnotationDialog(annotation, isNew = false) {
  state.pendingAnnotation = { ...annotation, isNew };
  els.annotationSelection.textContent = annotation.selectedText;
  els.annotationInput.value = annotation.note || "";
  els.annotationDelete.hidden = isNew;
  els.annotationDialog.showModal();
  requestAnimationFrame(() => els.annotationInput.focus());
}

function closeAnnotationDialog() {
  if (els.annotationDialog.open) els.annotationDialog.close();
  state.pendingAnnotation = null;
}

function savePendingAnnotation() {
  const pending = state.pendingAnnotation;
  if (!pending) return;
  const note = els.annotationInput.value.trim();
  if (!note) {
    showToast("请输入注释内容");
    els.annotationInput.focus();
    return;
  }

  const annotation = {
    id: pending.id,
    examId: pending.examId,
    cardId: pending.cardId,
    start: pending.start,
    end: pending.end,
    selectedText: pending.selectedText,
    note,
    createdAt: pending.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  state.annotations[annotation.id] = annotation;
  saveAnnotations();
  closeAnnotationDialog();
  renderContent();
  syncAnnotationMutation(annotation);
  showToast(pending.isNew ? "注释已添加" : "注释已更新");
}

function deletePendingAnnotation() {
  const pending = state.pendingAnnotation;
  if (!pending || pending.isNew) return;
  const annotation = {
    ...pending,
    deletedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  delete annotation.isNew;
  state.annotations[annotation.id] = annotation;
  saveAnnotations();
  closeAnnotationDialog();
  renderContent();
  syncAnnotationMutation(annotation);
  showToast("注释已删除");
}

function createAnnotationId() {
  return globalThis.crypto?.randomUUID?.() ||
    `note-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function renderSentence(card, selectedTerms = null) {
  if (!card.sentenceLines.length) return "";
  const baseLines = card.sentenceLines.map(mergeAdjacentSentenceMarks);
  const sentenceLines = selectedTerms
    ? addMissingSentenceHighlights(baseLines, selectedTerms)
    : baseLines;
  return `
    <div class="sentence">
      ${sentenceLines
        .map((line) => renderInline(line, "sentence", selectedTerms))
        .join("<br>")}
    </div>
  `;
}

function mergeAdjacentSentenceMarks(line) {
  return String(line).replace(
    /<\/(?:font|u)><(?:font|u)\b[^>]*>/gi,
    ""
  );
}

function addMissingSentenceHighlights(lines, selectedTerms) {
  const sourceMarks = lines.flatMap(sentenceMarksInLine);
  const nextLines = lines.map(stripSentenceMarkTags);

  selectedTerms.forEach((term) => {
    const candidates = fallbackTermCandidates(term.title);
    let generatedCount = applyHighlightCandidates(nextLines, candidates);

    if (generatedCount === 0) {
      const matchingSourceMarks = sourceMarks
        .filter((mark) => termMatchesHighlight(term, normalizeMatchText(mark)))
        .map(stripMarkup);
      generatedCount += applyHighlightCandidates(nextLines, matchingSourceMarks);
    }
  });

  return nextLines;
}

function stripSentenceMarkTags(line) {
  return String(line).replace(/<\/?(?:font|u)\b[^>]*>/gi, "");
}

function applyHighlightCandidates(lines, candidates) {
  let generatedCount = 0;

  candidates.forEach((candidate) => {
    for (let index = 0; index < lines.length; index += 1) {
      const result = wrapMatchingPhrase(lines[index], candidate);
      if (!result.matched) continue;
      lines[index] = result.text;
      generatedCount += 1;
      break;
    }
  });

  return generatedCount;
}

function sentenceMarksInLine(line) {
  const marks = [];
  for (const match of String(line).matchAll(/<font\b[^>]*>([\s\S]*?)<\/font>/gi)) {
    marks.push(match[1]);
  }
  for (const match of String(line).matchAll(/<u\b[^>]*>([\s\S]*?)<\/u>/gi)) {
    marks.push(match[1]);
  }
  return marks;
}

function fallbackTermCandidates(title) {
  return termFragments(stripMarkup(title))
    .flatMap((candidate) => {
      const cleaned = candidate
        .split(/\s+\+\s+/)[0]
        .replace(/\s*\([^)]*\)\s*$/, "")
        .replace(/^[-–—(\s]+/, "")
        .replace(/[：:，,。.;；!?？!）)\s]+$/, "")
        .trim();
      return [cleaned, ...grammarPatternAlternatives(cleaned)];
    })
    .filter((candidate) => {
      const shortAllowed = /^(it|do)$/i.test(candidate);
      if ((!shortAllowed && candidate.length < 3) || /[\u3400-\u9fff]/.test(candidate)) {
        return false;
      }
      const words = matchWords(candidate);
      return words.length > 0 && words.length <= 10;
    });
}

function grammarPatternAlternatives(candidate) {
  const alternatives = [];
  const words = matchWords(candidate);
  const particleWords = new Set(["away", "down", "in", "off", "on", "out", "up"]);

  if (words.length === 3 && particleWords.has(words[1].toLowerCase())) {
    alternatives.push(`${words[2]} ${words[0]} ${words[1]}`);
    alternatives.push(`${words[2]} A ${words[0]} ${words[1]}`);
  }

  const passiveMatch = candidate.match(
    /^([A-Za-z]+)\s+(?:a|an|the)\s+([A-Za-z]+)\s+(at|as|to|with|into|from|of|on)\s+(sb|someone|sth|something)\.?$/i
  );
  if (passiveMatch) {
    alternatives.push(
      `${passiveMatch[2]} ${passiveMatch[1]} ${passiveMatch[3]} ${passiveMatch[4]}`
    );
  }

  return alternatives;
}

function wrapMatchingPhrase(html, candidate) {
  const parts = String(html).split(/(<[^>]+>)/g);
  let markDepth = 0;

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (/^<[^>]+>$/.test(part)) {
      if (/^<\/(?:font|u)\b/i.test(part)) markDepth = Math.max(0, markDepth - 1);
      if (/^<(?:font|u)\b/i.test(part)) markDepth += 1;
      continue;
    }
    if (markDepth > 0) continue;

    const match = findMorphologicalPhrase(part, candidate);
    if (!match) continue;
    parts[index] = `${part.slice(0, match.start)}<font color="#ffff00">${part.slice(match.start, match.end)}</font>${part.slice(match.end)}`;
    return { text: parts.join(""), matched: true };
  }

  return { text: html, matched: false };
}

function renderTranslation(card) {
  const body = card.translationLine.replace(/^翻译\s*[:：]\s*/, "");
  return `
    <div class="translation">
      <span class="translation-label">翻译：</span>${renderInline(body, "translation")}
    </div>
  `;
}

function renderTermList(card, terms, mode) {
  if (!terms.length) return "";
  const cardId = storageCardId(card);
  return `
    <div class="term-list">
      ${terms
        .map((term) => {
          const termKey = makeKey(card.examId, cardId, term.id);
          const saved = isSaved(card.examId, cardId, term.id);
          const item = state.library[termKey];
          const removalLocked = saved && !canRemoveSavedItem(item);
          const revealTerm = state.revealedTermKeys.has(termKey);
          const savedClass = saved ? " is-saved" : "";
          const lockedClass = removalLocked ? " is-removal-locked" : "";
          const symbol = saved ? "✓" : "+";
          const title = removalLocked
            ? "已保护，请到第 1 轮移出"
            : saved
              ? "移出整个复习库"
              : "加入复习库";
          const disabled = removalLocked ? " disabled" : "";
          return `
            <div class="term-row" data-exam-id="${card.examId}" data-card-id="${cardId}" data-term-id="${term.id}">
              <div class="term-actions">
                <button class="term-toggle${savedClass}${lockedClass}" type="button" title="${title}" aria-label="${title}" data-action="toggle-term" data-exam-id="${card.examId}" data-card-id="${cardId}" data-term-id="${term.id}"${disabled}>${symbol}</button>
                ${mode === "review" ? renderAdvanceButton(card, term) : ""}
              </div>
              <div class="term-body">
                ${term.lines
                  .filter((line) => line.trim())
                  .map((line) => `<p>${renderInline(line, "definition", null, revealTerm)}</p>`)
                  .join("")}
              </div>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderAdvanceButton(card, term) {
  const cardId = storageCardId(card);
  const item = state.library[makeKey(card.examId, cardId, term.id)];
  const itemRound = reviewRoundOf(item);
  const activeRound = state.reviewRound;

  if (activeRound >= MAX_REVIEW_ROUND) {
    return `<button class="round-advance is-complete" type="button" disabled title="已经到第 4 轮">4</button>`;
  }

  if (itemRound > activeRound) {
    return `<button class="round-advance is-complete" type="button" disabled title="已进入第 ${itemRound} 轮">${itemRound}</button>`;
  }

  const nextRound = activeRound + 1;
  return `<button class="round-advance" type="button" title="加入第 ${nextRound} 轮（电脑端可按 Q）" data-action="advance-round" data-exam-id="${card.examId}" data-card-id="${cardId}" data-term-id="${term.id}">→${nextRound}</button>`;
}

function storageCardId(card) {
  return card.storageCardId || card.id;
}

function renderInline(text, context, selectedTerms = null, forceReveal = false) {
  let html = text;

  html = html.replace(/<font\b[^>]*>([\s\S]*?)<\/font>/gi, (_match, inner) =>
    shouldKeepSentenceMark(inner, selectedTerms)
      ? `<span class="highlight">${inner}</span>`
      : inner
  );

  if (context === "translation" || context === "definition") {
    html = html.replace(/<u\b[^>]*>([\s\S]*?)<\/u>/gi, (_match, inner) =>
      wrapCloze(inner, forceReveal)
    );
  } else {
    html = html.replace(/<u\b[^>]*>([\s\S]*?)<\/u>/gi, (_match, inner) =>
      shouldKeepSentenceMark(inner, selectedTerms) ? `<u>${inner}</u>` : inner
    );
  }

  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  return html;
}

function wrapCloze(inner, forceReveal = false) {
  const answerClass = state.showAnswers || forceReveal ? "is-revealed" : "is-hidden";
  return `<span class="cloze ${answerClass}">${inner}</span>`;
}

function shouldKeepSentenceMark(inner, selectedTerms) {
  if (!selectedTerms) return true;
  if (!selectedTerms.length) return false;

  const highlight = normalizeMatchText(inner);
  if (!highlight) return false;

  return selectedTerms.some((term) => termMatchesHighlight(term, highlight));
}

function termMatchesHighlight(term, highlight) {
  if (
    fallbackTermCandidates(term.title).some(
      (candidate) =>
        placeholderPhraseMatch(candidate, highlight) ||
        flexiblePhraseMatch(candidate, highlight)
    )
  ) {
    return true;
  }
  if (placeholderPhraseMatch(term.title, highlight)) return true;
  if (flexiblePhraseMatch(term.title, highlight)) return true;
  const title = normalizeMatchText(term.title);
  if (!title) return false;

  if (sameMatchText(title, highlight)) return true;
  if (containsMatchText(title, highlight)) return true;
  if (containsMatchText(highlight, title)) return true;

  const relaxedTitle = stripLeadingBeVerb(title);
  const relaxedHighlight = stripLeadingBeVerb(highlight);
  if (sameMatchText(relaxedTitle, relaxedHighlight)) return true;
  if (containsMatchText(relaxedTitle, relaxedHighlight)) return true;
  if (containsMatchText(relaxedHighlight, relaxedTitle)) return true;

  return termFragments(term.title).some((fragment) => {
    const normalizedFragment = normalizeMatchText(fragment);
    if (!normalizedFragment) return false;
    const relaxedFragment = stripLeadingBeVerb(normalizedFragment);
    return (
      sameMatchText(normalizedFragment, highlight) ||
      containsMatchText(normalizedFragment, highlight) ||
      containsMatchText(highlight, normalizedFragment) ||
      sameMatchText(relaxedFragment, relaxedHighlight) ||
      containsMatchText(relaxedFragment, relaxedHighlight) ||
      containsMatchText(relaxedHighlight, relaxedFragment) ||
      placeholderPhraseMatch(fragment, highlight) ||
      flexiblePhraseMatch(fragment, highlight) ||
      morphologicalPhraseMatch(normalizedFragment, highlight) ||
      meaningfulCommonPhraseMatch(normalizedFragment, highlight) ||
      fuzzyMatchText(normalizedFragment, highlight)
    );
  }) ||
    morphologicalPhraseMatch(title, highlight) ||
    meaningfulCommonPhraseMatch(title, highlight) ||
    fuzzyMatchText(title, highlight);
}

function termFragments(title) {
  return String(title)
    .replace(/\.\.\./g, "…")
    .split(/[…/／|]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeMatchText(text) {
  return stripMarkup(text)
    .toLowerCase()
    .replace(/&nbsp;/g, " ")
    .replace(/[“”‘’"'`]/g, "")
    .replace(/[()（）[\]{}<>]/g, " ")
    .replace(/[：:，,。.;；!?？!—–\-…]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function morphologicalPhraseMatch(left, right) {
  const leftWords = matchWords(left);
  const rightWords = matchWords(right);
  if (!leftWords.length || !rightWords.length) return false;

  return (
    phraseWordsContain(leftWords, rightWords) ||
    phraseWordsContain(rightWords, leftWords)
  );
}

function meaningfulCommonPhraseMatch(left, right) {
  const leftWords = matchWords(left);
  const rightWords = matchWords(right);
  if (!leftWords.length || !rightWords.length) return false;

  for (let leftIndex = 0; leftIndex < leftWords.length; leftIndex += 1) {
    for (let rightIndex = 0; rightIndex < rightWords.length; rightIndex += 1) {
      let length = 0;
      let letterCount = 0;
      while (
        leftIndex + length < leftWords.length &&
        rightIndex + length < rightWords.length &&
        wordsMorphologicallyMatch(
          leftWords[leftIndex + length],
          rightWords[rightIndex + length]
        )
      ) {
        letterCount += Math.min(
          leftWords[leftIndex + length].length,
          rightWords[rightIndex + length].length
        );
        length += 1;
      }

      if (length >= 2 && letterCount >= 4) return true;
      if (length === 1 && letterCount >= 6) return true;
    }
  }

  return false;
}

function findMorphologicalPhrase(text, candidate) {
  const textWords = indexedMatchWords(text);
  const candidateWords = matchWords(candidate);
  if (!candidateWords.length || !textWords.length) return null;

  const placeholderMatch = findPlaceholderPhrase(textWords, candidateWords);
  if (placeholderMatch) return placeholderMatch;
  if (candidateWords.length > textWords.length) return null;

  for (let index = 0; index <= textWords.length - candidateWords.length; index += 1) {
    const windowWords = textWords.slice(index, index + candidateWords.length);
    if (!phraseWordsEqual(candidateWords, windowWords.map((word) => word.value))) continue;
    return {
      start: windowWords[0].start,
      end: windowWords[windowWords.length - 1].end,
    };
  }

  return findGappedPhrase(textWords, candidateWords);
}

function flexiblePhraseMatch(pattern, text) {
  return Boolean(findMorphologicalPhrase(stripMarkup(text), stripMarkup(pattern)));
}

function placeholderPhraseMatch(pattern, text) {
  const textWords = indexedMatchWords(text);
  const patternWords = matchWords(pattern);
  if (!textWords.length || !patternWords.length) return false;
  if (!patternWords.some((word, index) => isPatternPlaceholder(word, patternWords, index))) {
    return false;
  }
  return Boolean(findPlaceholderPhrase(textWords, patternWords));
}

function findPlaceholderPhrase(textWords, patternWords) {
  const hasPlaceholder = patternWords.some((word, index) =>
    isPatternPlaceholder(word, patternWords, index)
  );
  if (!hasPlaceholder) return null;

  for (let start = 0; start < textWords.length; start += 1) {
    const endIndex = matchPatternWords(textWords, patternWords, start, 0, 6);
    if (endIndex == null || endIndex <= start) continue;
    return {
      start: textWords[start].start,
      end: textWords[endIndex - 1].end,
    };
  }

  return null;
}

function matchPatternWords(textWords, patternWords, textIndex, patternIndex, gapBudget) {
  if (patternIndex >= patternWords.length) return textIndex;
  if (textIndex > textWords.length) return null;

  const patternWord = patternWords[patternIndex];
  if (isSpanPlaceholder(patternWord)) {
    const remainingPatternWords = patternWords
      .slice(patternIndex + 1)
      .filter((word) => !isSpanPlaceholder(word)).length;
    const maxLength = Math.min(
      10,
      textWords.length - textIndex - remainingPatternWords
    );
    for (let length = 0; length <= maxLength; length += 1) {
      const result = matchPatternWords(
        textWords,
        patternWords,
        textIndex + length,
        patternIndex + 1,
        gapBudget
      );
      if (result != null) return result;
    }
    return null;
  }

  if (textIndex >= textWords.length) return null;
  if (
    wordsMorphologicallyMatch(patternWord, textWords[textIndex].value) ||
    isVerbPlaceholder(patternWord, patternWords, patternIndex)
  ) {
    return matchPatternWords(
      textWords,
      patternWords,
      textIndex + 1,
      patternIndex + 1,
      gapBudget
    );
  }

  if (patternIndex > 0 && gapBudget > 0) {
    return matchPatternWords(
      textWords,
      patternWords,
      textIndex + 1,
      patternIndex,
      gapBudget - 1
    );
  }

  return null;
}

function findGappedPhrase(textWords, patternWords) {
  if (patternWords.length < 2) return null;
  const letterCount = patternWords.reduce((sum, word) => sum + word.length, 0);
  if (letterCount < 6) return null;

  for (let start = 0; start < textWords.length; start += 1) {
    if (!wordsMorphologicallyMatch(patternWords[0], textWords[start].value)) continue;
    const endIndex = matchPatternWords(
      textWords,
      patternWords,
      start,
      0,
      6
    );
    if (endIndex == null || endIndex <= start) continue;
    return {
      start: textWords[start].start,
      end: textWords[endIndex - 1].end,
    };
  }

  return null;
}

function isPatternPlaceholder(word, patternWords, index) {
  return (
    isSpanPlaceholder(word) ||
    isVerbPlaceholder(word, patternWords, index)
  );
}

function isSpanPlaceholder(word) {
  if (word === "A" || word === "B") return true;
  return /^(something|someone|somebody|sth|sb)$/i.test(word);
}

function isVerbPlaceholder(word, patternWords, index) {
  const normalized = String(word).toLowerCase();
  if (patternWords.length <= 1) return false;
  if (normalized === "doing") return true;
  if (normalized !== "do") return false;
  return index === patternWords.length - 1 || String(patternWords[index - 1]).toLowerCase() === "to";
}

function phraseWordsContain(container, part) {
  if (part.length > container.length) return false;
  if (part.length === 1 && part[0].length < 3) return false;

  for (let index = 0; index <= container.length - part.length; index += 1) {
    if (phraseWordsEqual(container.slice(index, index + part.length), part)) return true;
  }
  return false;
}

function phraseWordsEqual(leftWords, rightWords) {
  return leftWords.every((word, index) => wordsMorphologicallyMatch(word, rightWords[index]));
}

function wordsMorphologicallyMatch(left, right) {
  const leftForms = wordForms(left);
  const rightForms = wordForms(right);
  if ([...leftForms].some((form) => rightForms.has(form))) return true;

  const leftWord = String(left).toLowerCase();
  const rightWord = String(right).toLowerCase();
  return (
    leftWord.length >= 5 &&
    rightWord.length >= 5 &&
    leftWord[0] === rightWord[0] &&
    editDistance(leftWord, rightWord) <= 1
  );
}

function wordForms(word) {
  const normalized = String(word)
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/'s$/, "");
  const special = canonicalSpecialWord(normalized);
  const forms = new Set([normalized, special]);
  const irregular = irregularWordForm(normalized);
  if (irregular) forms.add(irregular);

  if (normalized.endsWith("ies") && normalized.length > 4) {
    forms.add(`${normalized.slice(0, -3)}y`);
  }
  if (normalized.endsWith("s") && normalized.length > 3) {
    forms.add(normalized.slice(0, -1));
  }
  if (normalized.endsWith("es") && normalized.length > 3) {
    forms.add(normalized.slice(0, -2));
  }
  if (normalized.endsWith("ier") && normalized.length > 4) {
    forms.add(`${normalized.slice(0, -3)}y`);
  }
  if (normalized.endsWith("iest") && normalized.length > 5) {
    forms.add(`${normalized.slice(0, -4)}y`);
  }
  if (normalized.endsWith("ed") && normalized.length > 4) {
    addStemForms(forms, normalized.slice(0, -2));
    forms.add(normalized.slice(0, -1));
  }
  if (normalized.endsWith("ing") && normalized.length > 5) {
    const stem = normalized.slice(0, -3);
    addStemForms(forms, stem);
    forms.add(`${stem}e`);
  }

  return forms;
}

function addStemForms(forms, stem) {
  forms.add(stem);
  if (/(.)\1$/.test(stem)) forms.add(stem.slice(0, -1));
}

function canonicalSpecialWord(word) {
  if (/^(am|is|are|was|were|been|being)$/.test(word)) return "be";
  if (/^(did|does|done|doing)$/.test(word)) return "do";
  if (/^(has|had|having)$/.test(word)) return "have";
  if (/^(one|ones|his|her|their|our|my|your|its)$/.test(word)) return "possessive";
  if (/^(oneself|myself|yourself|himself|herself|itself|ourselves|yourselves|themselves)$/.test(word)) {
    return "reflexive";
  }
  if (/^(a|an|the)$/.test(word)) return "article";
  return word;
}

function irregularWordForm(word) {
  const forms = {
    brought: "bring",
    bought: "buy",
    came: "come",
    found: "find",
    gone: "go",
    left: "leave",
    lent: "lend",
    made: "make",
    paid: "pay",
    ran: "run",
    struck: "strike",
    taken: "take",
    thought: "think",
    took: "take",
    went: "go",
    written: "write",
    wrote: "write",
  };
  return forms[word] || "";
}

function matchWords(text) {
  return indexedMatchWords(text).map((word) => word.value);
}

function indexedMatchWords(text) {
  return [...String(text).matchAll(/[A-Za-z]+(?:[’'][A-Za-z]+)?/g)].map((match) => ({
    value: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function fuzzyMatchText(left, right) {
  const a = stripLeadingBeVerb(normalizeMatchText(left));
  const b = stripLeadingBeVerb(normalizeMatchText(right));
  if (a.length < 5 || b.length < 5) return false;
  const maxLength = Math.max(a.length, b.length);
  return 1 - editDistance(a, b) / maxLength >= 0.78;
}

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_unused, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = previous[0];
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = previous[rightIndex];
      previous[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + 1,
        diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

function sameMatchText(a, b) {
  return a === b;
}

function containsMatchText(container, part) {
  if (!container || !part) return false;
  if (part.length < 2) return false;
  const containerWords = ` ${container} `;
  const partWords = ` ${part} `;
  return containerWords.includes(partWords);
}

function stripLeadingBeVerb(text) {
  return text.replace(/^(be|am|is|are|was|were|been|being)\s+/, "");
}

function toggleTerm(examId, cardId, termId) {
  const key = makeKey(examId, cardId, termId);
  const wasSaved = Boolean(state.library[key]);

  if (wasSaved && !canRemoveSavedItem(state.library[key])) {
    showToast("请到复习库第 1 轮移出");
    return;
  }

  if (wasSaved) {
    delete state.library[key];
    state.revealedTermKeys.delete(key);
  } else {
    state.library[key] = {
      examId,
      cardId,
      termId,
      addedAt: new Date().toISOString(),
      reviewRound: 1,
    };
    state.revealedTermKeys.add(key);
  }

  saveLibrary();
  render();
  syncItemMutation(
    wasSaved ? "delete" : "upsert",
    state.library[key] || { examId, cardId, termId, addedAt: new Date().toISOString() },
    key
  );
  showToast(wasSaved ? "已移出复习库" : "已加入复习库");
}

function canRemoveSavedItem(item) {
  if (!item) return true;
  if (reviewRoundOf(item) <= 1) return true;
  return state.mode === "review" && state.reviewRound === 1;
}

function handleHoveredTermShortcut(row) {
  const { examId, cardId, termId } = row.dataset;
  if (!examId || !cardId || !termId) return;

  if (state.mode === "review") {
    advanceTermToNextRound(examId, cardId, termId);
    return;
  }

  toggleTerm(examId, cardId, termId);
}

function advanceTermToNextRound(examId, cardId, termId) {
  const key = makeKey(examId, cardId, termId);
  const item = state.library[key];
  if (!item) return;

  const currentRound = state.reviewRound;
  const itemRound = reviewRoundOf(item);

  if (currentRound >= MAX_REVIEW_ROUND) {
    showToast("已经是第 4 轮");
    return;
  }

  if (itemRound > currentRound) {
    showToast(`已经进入第 ${itemRound} 轮`);
    return;
  }

  const nextRound = currentRound + 1;
  item.reviewRound = nextRound;
  item.updatedAt = new Date().toISOString();
  saveLibrary();
  render();
  syncItemMutation("promote", item, key, nextRound);
  showToast(`已加入第 ${nextRound} 轮`);
}

async function bootstrapSync() {
  renderSyncPanel();
  if (!state.syncConfigured || !state.authSession) return;

  try {
    await refreshSessionIfNeeded();
    await syncFromCloud({ mergeLocal: true, silent: true });
    startAutoSync();
  } catch (error) {
    state.syncMessage = readableError(error);
    saveAuthSession(null);
    state.authSession = null;
    renderSyncPanel();
  }
}

async function signUp() {
  if (!state.syncConfigured || state.syncBusy) return;
  const credentials = readCredentials();
  if (!credentials) return;

  setSyncBusy(true, "正在注册");
  try {
    const redirectTo = window.location.href.split("#")[0];
    const session = await supabaseAuth(`/signup?redirect_to=${encodeURIComponent(redirectTo)}`, credentials);
    if (session?.access_token) {
      setAuthSession(session);
      await syncFromCloud({ mergeLocal: true, silent: true });
      startAutoSync();
      showToast("注册并登录成功");
    } else {
      state.syncMessage = "注册成功，请按邮箱提示验证后登录";
      showToast("请验证邮箱后登录");
    }
  } catch (error) {
    showToast(readableError(error));
    state.syncMessage = readableError(error);
  } finally {
    setSyncBusy(false);
    renderSyncPanel();
  }
}

async function signIn() {
  if (!state.syncConfigured || state.syncBusy) return;
  const credentials = readCredentials();
  if (!credentials) return;

  setSyncBusy(true, "正在登录");
  try {
    const session = await supabaseAuth("/token?grant_type=password", credentials);
    setAuthSession(session);
    await syncFromCloud({ mergeLocal: true, silent: true });
    startAutoSync();
    showToast("已登录并同步");
  } catch (error) {
    showToast(readableError(error));
    state.syncMessage = readableError(error);
  } finally {
    setSyncBusy(false);
    renderSyncPanel();
  }
}

function signOut() {
  stopAutoSync();
  setAuthSession(null);
  state.syncMessage = "已退出，当前设备仍保留本地复习库";
  renderSyncPanel();
  showToast("已退出同步账号");
}

async function syncFromCloud({ mergeLocal = false, silent = false } = {}) {
  if (!state.syncConfigured || !state.authSession || state.syncBusy) return;

  setSyncBusy(true, silent ? "" : "正在同步");
  try {
    await refreshSessionIfNeeded();
    const { library: remoteLibrary, annotations: remoteAnnotations } = await fetchCloudState();
    const nextLibrary = mergeLocal
      ? mergeReviewLibraries(remoteLibrary, state.library)
      : remoteLibrary;
    const nextAnnotations = mergeAnnotations(remoteAnnotations, state.annotations);

    if (mergeLocal) {
      const missingItems = Object.entries(nextLibrary)
        .filter(([key, item]) =>
          !remoteLibrary[key] || reviewRoundOf(item) > reviewRoundOf(remoteLibrary[key])
        )
        .flatMap(([key, item]) => cloudItemsFromLocal(key, item));
      if (missingItems.length) await upsertCloudItems(missingItems);
    }

    const pendingAnnotations = Object.values(nextAnnotations)
      .filter((annotation) => annotationIsNewer(annotation, remoteAnnotations[annotation.id]))
      .map((annotation) => cloudAnnotationFromLocal(annotation));
    if (pendingAnnotations.length) await upsertCloudItems(pendingAnnotations);

    state.library = nextLibrary;
    state.annotations = nextAnnotations;
    saveLibrary();
    saveAnnotations();
    renderYearList();
    renderStats();
    renderContent();
    state.syncMessage = `已同步 ${Object.keys(state.library).length} 个词条`;
    if (!silent) showToast("同步完成");
  } catch (error) {
    state.syncMessage = readableError(error);
    if (!silent) showToast(readableError(error));
  } finally {
    setSyncBusy(false);
    renderSyncPanel();
  }
}

async function syncItemMutation(action, item, key, round = 1) {
  if (!state.syncConfigured || !state.authSession) return;

  try {
    await refreshSessionIfNeeded();
    if (action === "delete") {
      await deleteCloudItem(key);
      state.syncMessage = "已同步删除";
    } else if (action === "promote") {
      await upsertCloudItems([cloudItemFromLocal(key, item, round)]);
      state.syncMessage = `已同步到第 ${round} 轮`;
    } else {
      await upsertCloudItems([cloudItemFromLocal(key, item)]);
      state.syncMessage = "已同步加入";
    }
    renderSyncPanel();
  } catch (error) {
    state.syncMessage = `本地已保存，云同步失败：${readableError(error)}`;
    renderSyncPanel();
  }
}

async function syncAnnotationMutation(annotation) {
  if (!state.syncConfigured || !state.authSession) return;

  try {
    await refreshSessionIfNeeded();
    await upsertCloudItems([cloudAnnotationFromLocal(annotation)]);
    state.syncMessage = "注释已同步";
    renderSyncPanel();
  } catch (error) {
    state.syncMessage = `注释已保存在本机，云同步失败：${readableError(error)}`;
    renderSyncPanel();
  }
}

async function fetchCloudState() {
  const rows = [];

  for (let offset = 0; ; offset += CLOUD_PAGE_SIZE) {
    const page = await supabaseRest(
      `/review_items?select=item_key,exam_id,card_id,term_id,added_at&order=added_at.asc&limit=${CLOUD_PAGE_SIZE}&offset=${offset}`
    );

    rows.push(...page);
    if (page.length < CLOUD_PAGE_SIZE) break;
  }

  return rows.reduce((cloudState, row) => {
    if (isCloudAnnotationKey(row.item_key)) {
      const annotation = parseCloudAnnotation(row);
      if (annotation) cloudState.annotations[annotation.id] = annotation;
      return cloudState;
    }

    const { baseKey, round } = parseCloudItemKey(row.item_key);
    const existing = cloudState.library[baseKey];
    cloudState.library[baseKey] = {
      ...existing,
      examId: row.exam_id,
      cardId: row.card_id,
      termId: row.term_id,
      addedAt: existing?.addedAt || row.added_at,
      reviewRound: Math.max(reviewRoundOf(existing), round),
    };
    return cloudState;
  }, { library: {}, annotations: {} });
}

async function upsertCloudItems(items) {
  if (!items.length) return;
  for (let index = 0; index < items.length; index += CLOUD_WRITE_BATCH_SIZE) {
    await supabaseRest("/review_items?on_conflict=id", {
      method: "POST",
      headers: {
        "Prefer": "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(items.slice(index, index + CLOUD_WRITE_BATCH_SIZE)),
    });
  }
}

async function deleteCloudItem(key) {
  const cloudKeys = [
    key,
    ...Array.from(
      { length: MAX_REVIEW_ROUND - 1 },
      (_unused, index) => cloudRoundKey(key, index + 2)
    ),
  ];

  await Promise.all(
    cloudKeys.map((cloudKey) =>
      supabaseRest(`/review_items?id=eq.${encodeURIComponent(cloudIdForKey(cloudKey))}`, {
        method: "DELETE",
        headers: {
          "Prefer": "return=minimal",
        },
      })
    )
  );
}

function cloudItemsFromLocal(key, item) {
  const reviewRound = reviewRoundOf(item);
  return Array.from({ length: reviewRound }, (_unused, index) =>
    cloudItemFromLocal(key, item, index + 1)
  );
}

function cloudItemFromLocal(key, item, round = 1) {
  const userId = state.authSession?.user?.id;
  const cloudKey = round > 1 ? cloudRoundKey(key, round) : key;
  return {
    id: cloudIdForKey(cloudKey),
    user_id: userId,
    item_key: cloudKey,
    exam_id: item.examId,
    card_id: item.cardId,
    term_id: item.termId,
    added_at: item.addedAt || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function cloudAnnotationFromLocal(annotation) {
  const cloudKey = `${CLOUD_ANNOTATION_MARKER}${annotation.id}`;
  return {
    id: cloudIdForKey(cloudKey),
    user_id: state.authSession?.user?.id,
    item_key: cloudKey,
    exam_id: annotation.examId,
    card_id: annotation.cardId,
    term_id: JSON.stringify({
      id: annotation.id,
      start: annotation.start,
      end: annotation.end,
      selectedText: annotation.selectedText,
      note: annotation.note,
      createdAt: annotation.createdAt,
      updatedAt: annotation.updatedAt,
      deletedAt: annotation.deletedAt || null,
    }),
    added_at: annotation.createdAt || new Date().toISOString(),
    updated_at: annotation.updatedAt || new Date().toISOString(),
  };
}

function isCloudAnnotationKey(key) {
  return String(key).startsWith(CLOUD_ANNOTATION_MARKER);
}

function parseCloudAnnotation(row) {
  try {
    const data = JSON.parse(row.term_id || "{}");
    const id = String(data.id || row.item_key.slice(CLOUD_ANNOTATION_MARKER.length));
    if (!id || !data.selectedText) return null;
    return {
      id,
      examId: row.exam_id,
      cardId: row.card_id,
      start: Number(data.start),
      end: Number(data.end),
      selectedText: String(data.selectedText),
      note: String(data.note || ""),
      createdAt: data.createdAt || row.added_at,
      updatedAt: data.updatedAt || data.createdAt || row.added_at,
      deletedAt: data.deletedAt || null,
    };
  } catch {
    return null;
  }
}

function mergeAnnotations(remoteAnnotations, localAnnotations) {
  const merged = { ...remoteAnnotations };
  Object.entries(localAnnotations).forEach(([id, localAnnotation]) => {
    const remoteAnnotation = merged[id];
    if (annotationIsNewer(localAnnotation, remoteAnnotation)) {
      merged[id] = localAnnotation;
    }
  });
  return merged;
}

function annotationIsNewer(candidate, existing) {
  if (!existing) return true;
  return annotationTimestamp(candidate) > annotationTimestamp(existing);
}

function annotationTimestamp(annotation) {
  return Date.parse(annotation?.updatedAt || annotation?.createdAt || 0) || 0;
}

function cloudIdForKey(key) {
  return `${state.authSession.user.id}::${key}`;
}

function cloudRoundKey(key, round) {
  return `${key}${CLOUD_ROUND_MARKER}${round}`;
}

function parseCloudItemKey(key) {
  const match = String(key).match(/^(.*)::review-round-([2-4])$/);
  if (!match) return { baseKey: key, round: 1 };
  return { baseKey: match[1], round: Number(match[2]) };
}

function mergeReviewLibraries(remoteLibrary, localLibrary) {
  const merged = { ...remoteLibrary };

  Object.entries(localLibrary).forEach(([key, localItem]) => {
    const remoteItem = merged[key];
    merged[key] = {
      ...(remoteItem || {}),
      ...localItem,
      reviewRound: Math.max(reviewRoundOf(remoteItem), reviewRoundOf(localItem)),
    };
  });

  return merged;
}

async function supabaseAuth(path, body) {
  const response = await fetch(`${syncConfig.supabaseUrl}/auth/v1${path}`, {
    method: "POST",
    headers: {
      "apikey": syncConfig.supabaseAnonKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return readSupabaseResponse(response);
}

async function supabaseRest(path, options = {}) {
  const headers = {
    "apikey": syncConfig.supabaseAnonKey,
    "Authorization": `Bearer ${state.authSession.access_token}`,
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };

  const response = await fetch(`${syncConfig.supabaseUrl}/rest/v1${path}`, {
    ...options,
    headers,
  });

  return readSupabaseResponse(response);
}

async function readSupabaseResponse(response) {
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(data?.msg || data?.message || response.statusText || "同步失败");
  }
  return data;
}

async function refreshSessionIfNeeded() {
  if (!state.authSession?.refresh_token) return;
  const expiresAt = state.authSession.expires_at || 0;
  if (Date.now() < expiresAt - 60_000) return;

  const session = await supabaseAuth("/token?grant_type=refresh_token", {
    refresh_token: state.authSession.refresh_token,
  });
  setAuthSession(session);
}

function setAuthSession(session) {
  state.authSession = session ? normalizeSession(session) : null;
  saveAuthSession(state.authSession);
  if (state.authSession?.user?.email) els.emailInput.value = state.authSession.user.email;
  if (!state.authSession) els.passwordInput.value = "";
}

function normalizeSession(session) {
  return {
    ...session,
    expires_at: session.expires_at
      ? session.expires_at * 1000
      : Date.now() + (session.expires_in || 3600) * 1000,
  };
}

function loadAuthSession() {
  try {
    const session = JSON.parse(localStorage.getItem(AUTH_SESSION_KEY) || "null");
    if (!session?.access_token) return null;
    return session;
  } catch {
    return null;
  }
}

function saveAuthSession(session) {
  if (session) {
    localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(session));
  } else {
    localStorage.removeItem(AUTH_SESSION_KEY);
  }
}

function startAutoSync() {
  stopAutoSync();
  state.syncTimer = setInterval(() => syncFromCloud({ silent: true }), 30_000);
}

function stopAutoSync() {
  if (!state.syncTimer) return;
  clearInterval(state.syncTimer);
  state.syncTimer = null;
}

function setSyncBusy(isBusy, message = "") {
  state.syncBusy = isBusy;
  if (message) state.syncMessage = message;
  renderSyncPanel();
}

function readCredentials() {
  const email = els.emailInput.value.trim();
  const password = els.passwordInput.value;

  if (!email || !password) {
    showToast("请填写邮箱和密码");
    return null;
  }

  return { email, password };
}

function normalizeSyncConfig(config) {
  return {
    supabaseUrl: String(config.supabaseUrl || "").replace(/\/$/, ""),
    supabaseAnonKey: String(config.supabaseAnonKey || ""),
  };
}

function loadFontSize() {
  return normalizeFontSize(localStorage.getItem(FONT_SIZE_KEY));
}

function normalizeFontSize(size) {
  return FONT_SIZES.has(size) ? size : "medium";
}

function loadReviewRound() {
  return normalizeReviewRound(localStorage.getItem(REVIEW_ROUND_KEY));
}

function normalizeReviewRound(round) {
  const value = Number(round);
  if (!Number.isInteger(value)) return 1;
  return Math.min(MAX_REVIEW_ROUND, Math.max(1, value));
}

function readableError(error) {
  return error?.message || "操作失败";
}

function updateHoveredTermRow(event) {
  const row = event.target.closest(".term-row[data-term-id], .cloze-table-row[data-term-id]");
  if (row) {
    setHoveredTermRow(row);
    return;
  }

  if (state.hoveredTermRow && !state.hoveredTermRow.contains(event.target)) {
    clearHoveredTermRow();
  }
}

function updateHoveredEnglishCell(event) {
  const cell = event.target.closest?.(".cloze-english-cell");
  if (cell) {
    state.hoveredEnglishCell = cell;
    return;
  }

  if (state.hoveredEnglishCell && !state.hoveredEnglishCell.contains(event.target)) {
    clearHoveredEnglishCell();
  }
}

function clearHoveredEnglishCell(cell = state.hoveredEnglishCell) {
  if (!cell || state.hoveredEnglishCell !== cell) return;
  state.hoveredEnglishCell = null;
}

function updateHoveredAnnotation(event) {
  const element = event.target.closest?.(".cloze-annotation[data-annotation-id]");
  if (!element) {
    if (state.hoveredAnnotationId) clearHoveredAnnotation();
    return;
  }

  const annotation = state.annotations[element.dataset.annotationId];
  if (!annotation || annotation.deletedAt) return;
  state.hoveredAnnotationId = annotation.id;
  els.annotationTooltip.textContent = annotation.note;
  els.annotationTooltip.hidden = false;
}

function positionAnnotationTooltip(event) {
  if (els.annotationTooltip.hidden) return;
  const margin = 14;
  const tooltipRect = els.annotationTooltip.getBoundingClientRect();
  const left = Math.min(event.clientX, window.innerWidth - tooltipRect.width - margin);
  const top = Math.min(event.clientY, window.innerHeight - tooltipRect.height - margin);
  els.annotationTooltip.style.left = `${Math.max(margin, left)}px`;
  els.annotationTooltip.style.top = `${Math.max(margin, top)}px`;
}

function clearHoveredAnnotation(element = null) {
  if (element && element.dataset.annotationId !== state.hoveredAnnotationId) return;
  state.hoveredAnnotationId = "";
  els.annotationTooltip.hidden = true;
  els.annotationTooltip.textContent = "";
}

function setHoveredTermRow(row) {
  if (state.hoveredTermRow === row) return;
  clearHoveredTermRow();
  state.hoveredTermRow = row;
  row.classList.add("is-key-target");
}

function clearHoveredTermRow(row = state.hoveredTermRow) {
  if (!row) return;
  row.classList.remove("is-key-target");
  if (state.hoveredTermRow === row) state.hoveredTermRow = null;
}

function isSaved(examId, cardId, termId) {
  return Boolean(state.library[makeKey(examId, cardId, termId)]);
}

function isInReviewRound(examId, cardId, termId, round) {
  const item = state.library[makeKey(examId, cardId, termId)];
  return Boolean(item) && reviewRoundOf(item) >= normalizeReviewRound(round);
}

function reviewRoundOf(item) {
  return item ? normalizeReviewRound(item.reviewRound) : 1;
}

function savedItemsForExam(examId) {
  return Object.values(state.library).filter((item) => item.examId === examId);
}

function makeKey(examId, cardId, termId) {
  return `${examId}::${cardId}::${termId}`;
}

function loadLibrary() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return Object.entries(stored).reduce((library, [key, item]) => {
      const { baseKey, round } = parseCloudItemKey(key);
      const existing = library[baseKey];
      library[baseKey] = {
        ...(existing || {}),
        ...item,
        reviewRound: Math.max(reviewRoundOf(existing), reviewRoundOf(item), round),
      };
      return library;
    }, {});
  } catch {
    return {};
  }
}

function saveLibrary() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.library));
}

function loadAnnotations() {
  try {
    const stored = JSON.parse(localStorage.getItem(ANNOTATION_STORAGE_KEY) || "{}");
    return stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
  } catch {
    return {};
  }
}

function saveAnnotations() {
  localStorage.setItem(ANNOTATION_STORAGE_KEY, JSON.stringify(state.annotations));
}

function loadCollapsedCourseIds() {
  try {
    const ids = JSON.parse(localStorage.getItem(COLLAPSED_GROUPS_KEY) || "[]");
    return new Set(Array.isArray(ids) ? ids : []);
  } catch {
    return new Set();
  }
}

function saveCollapsedCourseIds() {
  localStorage.setItem(
    COLLAPSED_GROUPS_KEY,
    JSON.stringify([...state.collapsedCourseIds])
  );
}

function getActiveExam() {
  return state.examById.get(state.activeExamId) || state.exams[0];
}

function isClozeExam(exam) {
  return exam?.courseId === "cloze";
}

function showToast(message) {
  clearTimeout(state.toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add("is-visible");
  state.toastTimer = setTimeout(() => {
    els.toast.classList.remove("is-visible");
  }, 1300);
}

function clearHoveredClozes() {
  document
    .querySelectorAll(".cloze.is-hovered")
    .forEach((cloze) => cloze.classList.remove("is-hovered"));
}

function isEditableTarget(target) {
  return Boolean(
    target?.closest?.("input, textarea, select, [contenteditable='true']")
  );
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stripMarkup(text) {
  return String(text)
    .replace(/<[^>]*>/g, "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/&nbsp;/g, " ");
}

function trimBlankLines(lines) {
  const copy = [...lines];
  while (copy.length && !copy[0].trim()) copy.shift();
  while (copy.length && !copy[copy.length - 1].trim()) copy.pop();
  return copy;
}

function countMatches(text, pattern) {
  return (text.match(pattern) || []).length;
}

function isNoiseLine(line) {
  return line === "()" || line === "(" || line === ")" || line === "-";
}
