(() => {
  function escape(text) {
    return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function textOnly(text) {
    return String(text).replace(/<[^>]*>/g, "").replace(/\\([.()[\]_*`])/g, "$1");
  }

  function inline(text) {
    const html = String(text).split(/(<\/?(?:font|u|b|strong|i|em)\b[^>]*>)/gi).map((part) => {
      const font = part.match(/^<font\s+color=["'](#[a-f\d]{3,8})["']\s*>$/i);
      if (font) {
        const yellow = ["#ffff00", "#ffc000", "#ffcc00", "#fff000"].includes(font[1].toLowerCase());
        return yellow ? `<mark style="background-color:${font[1]}">` : `<span style="color:${font[1]}">`;
      }
      if (/^<\/font\s*>$/i.test(part)) return "</span>";
      if (/^<\/?(?:u|b|strong|i|em)\s*>$/i.test(part)) return part;
      return escape(part.replace(/\\([.()[\]_*`])/g, "$1"));
    }).join("");
    // Font tags may nest; use spans consistently for balanced source markup.
    return html.replace(/<mark style="background-color:([^"<>]+)">/g, '<span class="writing-highlight" style="background-color:$1">')
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
  }

  function bullet(body, className = "") {
    return `<li class="writing-line ${className}"><span class="writing-bullet" aria-hidden="true">·</span><div>${body}</div></li>`;
  }

  function visibleCards(exam, options) {
    const query = String(options.query || "").toLowerCase();
    if (!query && options.mode !== "review") return exam.cards;
    const matchingSections = new Set(exam.cards.filter((card) => card.type === "section" && textOnly(card.title).toLowerCase().includes(query)).map((card) => card.id));
    const content = exam.cards.filter((card) => {
      if (card.type === "section") return false;
      if (card.writingModule && options.mode === "review" && !options.isInRound(card)) return false;
      if (!query) return true;
      if (card.sectionIds?.some((id) => matchingSections.has(id))) return true;
      return textOnly([card.english || "", ...(card.chinese || []), ...(card.lines || []), ...(card.rows?.flat() || []), card.alt || ""].join(" ")).toLowerCase().includes(query);
    });
    const ids = new Set(content.flatMap((card) => card.sectionIds || []));
    const included = new Set(content.map((card) => card.id));
    return exam.cards.filter((card) => card.type === "section" ? ids.has(card.id) : included.has(card.id));
  }

  function renderModule(card, options) {
    const key = options.keyFor(card);
    const item = options.itemFor(card);
    const saved = Boolean(item);
    const locked = saved && !options.canRemove(item);
    const title = locked ? "已保护，请到第 1 轮移出" : saved ? "移出整个复习库" : "加入复习库";
    const revealed = options.revealed.get(key) ?? options.showAnswers;
    const attrs = `data-exam-id="${escape(card.examId)}" data-card-id="${escape(card.id)}" data-term-id="module"`;
    const english = `<button class="writing-answer${revealed ? "" : " is-hidden"}" type="button" data-action="toggle-writing-answer" data-answer-key="${escape(key)}" aria-label="${revealed ? "隐藏英文" : "显示英文"}" aria-expanded="${revealed}"><span class="writing-answer-text" aria-hidden="${!revealed}">${inline(card.english)}</span></button>`;
    return `<article class="writing-module term-row${saved ? " writing-module-saved" : ""}" ${attrs}>
      <div class="term-actions">
        <button class="term-toggle${saved ? " is-saved" : ""}${locked ? " is-removal-locked" : ""}" type="button" title="${title}" aria-label="${title}" data-action="toggle-term" ${attrs}${locked ? " disabled" : ""}>${saved ? "✓" : "+"}</button>
        ${options.mode === "review" ? options.advanceButton(card) : ""}
      </div>
      <div class="writing-module-body"><ul class="writing-lines">${bullet(english, "writing-english")}${card.chinese.map((line) => bullet(inline(line), "writing-chinese")).join("")}</ul></div>
    </article>`;
  }

  function render(exam, options) {
    const cards = visibleCards(exam, options);
    const html = cards.map((card) => {
      if (card.type === "section") return `<h${card.level} class="writing-heading writing-level-${card.level}" id="${escape(card.id)}">${inline(card.title)}</h${card.level}>`;
      if (card.writingModule) return renderModule(card, options);
      if (card.type === "writing-note") return `<div class="writing-notes"><ul class="writing-lines">${card.lines.map((line) => bullet(inline(line), "writing-chinese writing-annotation")).join("")}</ul></div>`;
      if (card.type === "writing-table") return `<div class="writing-table-wrap"><table class="writing-table"><thead><tr>${card.rows[0].map((cell) => `<th>${inline(cell)}</th>`).join("")}</tr></thead><tbody>${card.rows.slice(1).map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
      if (card.type === "writing-image") return `<details class="writing-original"><summary>${escape(card.alt)}</summary><img src="${escape(card.src)}" alt="${escape(card.alt)}" loading="lazy" /></details>`;
      return "";
    }).join("");
    return {
      html: html ? `<div class="writing-document">${html}</div>` : '<div class="empty">没有匹配内容。</div>',
      toc: cards.filter((card) => card.type === "section").map(({ id, title, level }) => ({ id, title: textOnly(title), level })),
      visibleModules: cards.filter((card) => card.writingModule).length,
    };
  }

  window.ClozeWriting = { inline, textOnly, visibleCards, render };
})();
