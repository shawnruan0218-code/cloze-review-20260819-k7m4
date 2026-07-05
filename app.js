const STORAGE_KEY = "cloze-review-library-v1";
const LAST_YEAR_KEY = "cloze-review-last-year";
const HOVER_REVEAL_KEY = "cloze-review-hover-reveal";
const AUTH_SESSION_KEY = "cloze-review-supabase-session";
const TOUCH_MODE_QUERY = "(hover: none), (pointer: coarse), (max-width: 700px)";

const els = {
  yearList: document.querySelector("#yearList"),
  yearTitle: document.querySelector("#yearTitle"),
  modeLabel: document.querySelector("#modeLabel"),
  studyMode: document.querySelector("#studyMode"),
  reviewMode: document.querySelector("#reviewMode"),
  toggleAnswers: document.querySelector("#toggleAnswers"),
  hoverReveal: document.querySelector("#hoverReveal"),
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
};

const syncConfig = normalizeSyncConfig(window.SYNC_CONFIG || {});
const touchModeMedia = window.matchMedia(TOUCH_MODE_QUERY);

const state = {
  exams: [],
  examById: new Map(),
  activeExamId: "",
  mode: "study",
  showAnswers: false,
  hoverReveal: localStorage.getItem(HOVER_REVEAL_KEY) !== "off",
  touchMode: touchModeMedia.matches,
  query: "",
  library: loadLibrary(),
  hoveredTermRow: null,
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

  els.toggleAnswers.addEventListener("click", () => {
    state.showAnswers = !state.showAnswers;
    render();
  });

  els.hoverReveal.addEventListener("click", () => {
    state.hoverReveal = !state.hoverReveal;
    localStorage.setItem(HOVER_REVEAL_KEY, state.hoverReveal ? "on" : "off");
    renderChrome();
  });

  els.authForm.addEventListener("submit", (event) => {
    event.preventDefault();
    signIn();
  });

  els.signUpButton.addEventListener("click", () => signUp());
  els.syncNowButton.addEventListener("click", () => syncFromCloud({ mergeLocal: true }));
  els.signOutButton.addEventListener("click", () => signOut());

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
    if (event.key.toLowerCase() !== "q" || event.repeat) return;
    if (isEditableTarget(event.target)) return;

    const row = state.hoveredTermRow;
    if (!row || !document.body.contains(row)) return;

    event.preventDefault();
    toggleHoveredTerm(row);
  });

  els.yearList.addEventListener("click", (event) => {
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

    const rowTarget = event.target.closest(".term-row[data-term-id]");
    if (rowTarget) {
      if (state.touchMode && state.mode === "review") return;
      toggleTerm(rowTarget.dataset.examId, rowTarget.dataset.cardId, rowTarget.dataset.termId);
      return;
    }
  });

  els.content.addEventListener("mouseover", (event) => {
    if (state.touchMode) return;
    updateHoveredTermRow(event);
    if (!state.hoverReveal) return;
    const cloze = event.target.closest(".cloze.is-hidden");
    if (cloze) cloze.classList.add("is-hovered");
  });

  els.content.addEventListener("mousemove", (event) => {
    if (!state.touchMode) updateHoveredTermRow(event);
  });
  els.content.addEventListener("pointerover", (event) => {
    if (!state.touchMode) updateHoveredTermRow(event);
  });
  els.content.addEventListener("pointermove", (event) => {
    if (!state.touchMode) updateHoveredTermRow(event);
  });

  els.content.addEventListener("mouseout", (event) => {
    const row = event.target.closest(".term-row[data-term-id]");
    if (row && !row.contains(event.relatedTarget)) clearHoveredTermRow(row);

    const cloze = event.target.closest(".cloze.is-hidden");
    if (!cloze || cloze.contains(event.relatedTarget)) return;
    cloze.classList.remove("is-hovered");
  });

  els.content.addEventListener("pointerout", (event) => {
    const row = event.target.closest(".term-row[data-term-id]");
    if (row && !row.contains(event.relatedTarget)) clearHoveredTermRow(row);
  });
}

function parseExam(file) {
  const blocks = file.content
    .replace(/\r\n/g, "\n")
    .split(/^---\s*$/m)
    .map((block) => block.trim())
    .filter(Boolean);

  const cards = blocks.map((block, index) => parseBlock(file, block, index));
  const termCount = cards.reduce((sum, card) => sum + (card.terms?.length || 0), 0);
  const clozeCount = cards.reduce((sum, card) => sum + (card.clozeCount || 0), 0);

  return {
    ...file,
    cards,
    termCount,
    clozeCount,
  };
}

function parseBlock(file, raw, index) {
  const lines = raw.split("\n");
  const translationIndex = lines.findIndex((line) =>
    /^翻译\s*[:：]/.test(line.trim())
  );

  if (translationIndex < 0) {
    return {
      type: "section",
      id: `${file.id}-section-${index}`,
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
    id: `${file.id}-card-${index}`,
    examId: file.id,
    raw,
    sentenceLines,
    translationLine,
    terms,
    clozeCount,
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
  renderSyncPanel();
  renderStats();
  renderContent();
}

function renderYearList() {
  els.yearList.innerHTML = groupedExams()
    .map(
      (group) => `
        <div class="exam-group">
          <div class="exam-group-title">${group.title}</div>
          <div class="exam-group-items">
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
      `
    )
    .join("");
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
  document.body.classList.toggle("hover-reveal", !state.touchMode && state.hoverReveal);
  document.body.classList.toggle("touch-mode", state.touchMode);
  if (state.touchMode || !state.hoverReveal) clearHoveredClozes();
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
  const reviewCards = new Set(reviewItems.map((item) => item.cardId)).size;

  els.statsStrip.innerHTML = `
    <div class="stat"><strong>${exam.cards.filter((card) => card.type === "card").length}</strong><span>句子</span></div>
    <div class="stat"><strong>${exam.clozeCount}</strong><span>挖空</span></div>
    <div class="stat"><strong>${state.mode === "review" ? reviewCards : reviewItems.length}</strong><span>${state.mode === "review" ? "复习句子" : "复习词条"}</span></div>
  `;
}

function renderContent() {
  const exam = getActiveExam();
  if (!exam) return;
  state.hoveredTermRow = null;

  const cards = state.mode === "review" ? reviewCardsForExam(exam) : studyCardsForExam(exam);
  const filtered = filterCards(cards);

  if (filtered.length === 0) {
    els.content.innerHTML =
      state.mode === "review"
        ? `<div class="empty">复习库还是空的。</div>`
        : `<div class="empty">没有匹配内容。</div>`;
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
      terms: card.terms.filter((term) => isSaved(exam.id, card.id, term.id)),
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

function renderSentence(card, selectedTerms = null) {
  if (!card.sentenceLines.length) return "";
  return `
    <div class="sentence">
      ${card.sentenceLines
        .map((line) => renderInline(line, "sentence", selectedTerms))
        .join("<br>")}
    </div>
  `;
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
  return `
    <div class="term-list">
      ${terms
        .map((term) => {
          const termKey = makeKey(card.examId, card.id, term.id);
          const saved = isSaved(card.examId, card.id, term.id);
          const revealTerm = state.revealedTermKeys.has(termKey);
          const savedClass = saved ? " is-saved" : "";
          const symbol = saved ? "✓" : "+";
          const title = saved ? "移出复习库" : "加入复习库";
          return `
            <div class="term-row" data-exam-id="${card.examId}" data-card-id="${card.id}" data-term-id="${term.id}">
              <button class="term-toggle${savedClass}" type="button" title="${title}" data-action="toggle-term" data-exam-id="${card.examId}" data-card-id="${card.id}" data-term-id="${term.id}">${symbol}</button>
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
    return (
      sameMatchText(normalizedFragment, highlight) ||
      containsMatchText(normalizedFragment, highlight) ||
      containsMatchText(highlight, normalizedFragment)
    );
  });
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
    .replace(/[：:，,。.;；!?？!—–\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

  if (wasSaved) {
    delete state.library[key];
    state.revealedTermKeys.delete(key);
  } else {
    state.library[key] = {
      examId,
      cardId,
      termId,
      addedAt: new Date().toISOString(),
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

function toggleHoveredTerm(row) {
  const { examId, cardId, termId } = row.dataset;
  if (!examId || !cardId || !termId) return;

  toggleTerm(examId, cardId, termId);
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
    const remoteLibrary = await fetchCloudLibrary();
    const nextLibrary = mergeLocal ? { ...remoteLibrary, ...state.library } : remoteLibrary;

    if (mergeLocal) {
      const missingItems = Object.entries(nextLibrary)
        .filter(([key]) => !remoteLibrary[key])
        .map(([key, item]) => cloudItemFromLocal(key, item));
      if (missingItems.length) await upsertCloudItems(missingItems);
    }

    state.library = nextLibrary;
    saveLibrary();
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

async function syncItemMutation(action, item, key) {
  if (!state.syncConfigured || !state.authSession) return;

  try {
    await refreshSessionIfNeeded();
    if (action === "delete") {
      await deleteCloudItem(key);
      state.syncMessage = "已同步删除";
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

async function fetchCloudLibrary() {
  const rows = await supabaseRest(
    "/review_items?select=item_key,exam_id,card_id,term_id,added_at&order=added_at.asc"
  );

  return rows.reduce((library, row) => {
    library[row.item_key] = {
      examId: row.exam_id,
      cardId: row.card_id,
      termId: row.term_id,
      addedAt: row.added_at,
    };
    return library;
  }, {});
}

async function upsertCloudItems(items) {
  if (!items.length) return;
  await supabaseRest("/review_items?on_conflict=id", {
    method: "POST",
    headers: {
      "Prefer": "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(items),
  });
}

async function deleteCloudItem(key) {
  await supabaseRest(`/review_items?id=eq.${encodeURIComponent(cloudIdForKey(key))}`, {
    method: "DELETE",
    headers: {
      "Prefer": "return=minimal",
    },
  });
}

function cloudItemFromLocal(key, item) {
  const userId = state.authSession?.user?.id;
  return {
    id: cloudIdForKey(key),
    user_id: userId,
    item_key: key,
    exam_id: item.examId,
    card_id: item.cardId,
    term_id: item.termId,
    added_at: item.addedAt || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function cloudIdForKey(key) {
  return `${state.authSession.user.id}::${key}`;
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

function readableError(error) {
  return error?.message || "操作失败";
}

function updateHoveredTermRow(event) {
  const row = event.target.closest(".term-row[data-term-id]");
  if (row) {
    setHoveredTermRow(row);
    return;
  }

  if (state.hoveredTermRow && !state.hoveredTermRow.contains(event.target)) {
    clearHoveredTermRow();
  }
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

function savedItemsForExam(examId) {
  return Object.values(state.library).filter((item) => item.examId === examId);
}

function makeKey(examId, cardId, termId) {
  return `${examId}::${cardId}::${termId}`;
}

function loadLibrary() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveLibrary() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.library));
}

function getActiveExam() {
  return state.examById.get(state.activeExamId) || state.exams[0];
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
    target?.closest?.("input, textarea, select, button, [contenteditable='true']")
  );
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
