(function () {
  const STARTER_PROMPT_GROUPS = [
    {
      title: "Performance",
      prompts: [
        "How is Press 8 performing?",
        "How is Press 5 performing in the last 10 reels?",
      ],
    },
    {
      title: "Ranking",
      prompts: [
        "Which press is performing the worst right now?",
        "Which press is performing the best today?",
      ],
    },
    {
      title: "Compare",
      prompts: [
        "Compare Press 5 to Press 6",
        "Compare Press 5 to Average",
      ],
    },
    {
      title: "Jobs",
      prompts: [
        "What jobs ran on Press 8 in the last 24 hours?",
        "Show me recent jobs for Press 5",
      ],
    },
    {
      title: "Process",
      prompts: [
        "Show speed instability for Press 14",
        "Show delta behavior for Press 7",
      ],
    },
  ];

  const conversation = [];
  let inputEl = null;
  let historyEl = null;
  let summaryEl = null;
  let emptyPromptGroupsEl = null;
  let dataModeEl = null;
  let startEl = null;
  let endEl = null;
  let diagnosticsToggleEl = null;
  let modeInputs = [];
  let sendButtonEl = null;
  let newChatButtonEl = null;
  let initialEmptyStateMarkup = "";
  let scrollFrameId = 0;
  let scrollTimeoutId = 0;

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function getSelectedMode() {
    const selected = modeInputs.find((input) => input.checked);
    return selected ? selected.value : "deterministic";
  }

  function diagnosticsEnabled() {
    return Boolean(diagnosticsToggleEl && diagnosticsToggleEl.checked);
  }

  function getContextState() {
    return {
      dataMode: dataModeEl ? dataModeEl.value : "rlm-only",
      machineId: null,
      start: startEl ? startEl.value : "",
      end: endEl ? endEl.value : "",
    };
  }

  function dataModeLabel(value) {
    if (value === "rlm-only") return "RLM Only";
    if (value === "defects-only") return "Defects Only";
    if (value === "combined") return "Combined";
    return value || "Unknown";
  }

  function getRequestFilters() {
    const context = getContextState();
    return {
      machine_id: context.machineId,
      start: context.start,
      end: context.end,
      job: "",
      order: "",
      reel_ids: [],
    };
  }

  function renderContextSummary() {
    if (!summaryEl) return;
    const context = getContextState();
    const chips = [
      "Scope: All Presses",
      `Data Mode: ${dataModeLabel(context.dataMode)}`,
      `Start: ${context.start || "--"}`,
      `End: ${context.end || "--"}`,
      `Mode: ${getSelectedMode()}`,
    ];
    summaryEl.innerHTML = chips.map((item) => `<span class="filter-chip">${escapeHtml(item)}</span>`).join("");
  }

  function renderConversation() {
    if (!historyEl) return;
    if (!conversation.length) {
      historyEl.classList.add("rlm-assistant-empty-state");
      historyEl.innerHTML = initialEmptyStateMarkup;
      emptyPromptGroupsEl = document.getElementById("assistantEmptyPromptGroups");
      renderStarterPrompts();
      scheduleScrollConversationToBottom();
      return;
    }
    historyEl.classList.remove("rlm-assistant-empty-state");
    historyEl.innerHTML = conversation.map((entry, index) => renderMessage(entry, index)).join("");
    renderConversationCharts();
    scheduleScrollConversationToBottom();
  }

  function scrollConversationToBottom() {
    if (!historyEl) return;
    historyEl.scrollTop = historyEl.scrollHeight;
    const lastMessage = historyEl.lastElementChild;
    if (lastMessage && typeof lastMessage.scrollIntoView === "function") {
      lastMessage.scrollIntoView({ block: "end" });
    }
    const pageBottom = Math.max(
      document.body ? document.body.scrollHeight : 0,
      document.documentElement ? document.documentElement.scrollHeight : 0
    );
    window.scrollTo(0, pageBottom);
  }

  function scheduleScrollConversationToBottom() {
    if (!historyEl) return;
    if (scrollFrameId) {
      cancelAnimationFrame(scrollFrameId);
    }
    if (scrollTimeoutId) {
      clearTimeout(scrollTimeoutId);
    }
    scrollFrameId = requestAnimationFrame(() => {
      scrollConversationToBottom();
      scrollFrameId = requestAnimationFrame(() => {
        scrollConversationToBottom();
        scrollFrameId = 0;
      });
    });
    scrollTimeoutId = window.setTimeout(() => {
      scrollConversationToBottom();
      scrollTimeoutId = 0;
    }, 120);
  }

  function renderMessage(entry, index) {
    if (entry.role === "user") {
      return `
        <article class="rlm-assistant-message rlm-assistant-message--user assistant-chat-bubble">
          <p class="rlm-assistant-message__eyebrow">Question</p>
          <p class="rlm-assistant-message__body">${escapeHtml(entry.content || "")}</p>
        </article>
      `;
    }
    if (entry.role === "assistant-loading") {
      return `
        <article class="rlm-assistant-message rlm-assistant-message--assistant assistant-chat-bubble assistant-chat-bubble--assistant">
          <p class="rlm-assistant-message__eyebrow">Assistant</p>
          <p class="rlm-assistant-message__body">Building a grounded response...</p>
        </article>
      `;
    }
    const payload = entry.payload || {};
    const answer = payload.answer || {};
    const sections = Array.isArray(answer.sections) ? answer.sections : [];
    const tools = Array.isArray(payload.toolsUsed) ? payload.toolsUsed : [];
    const context = payload.context || {};
    const evidence = payload.evidence || {};
    const metrics = Array.isArray(evidence.metrics) ? evidence.metrics : [];
    const chart = evidence.chart || null;
    const prompts = Array.isArray(payload.suggestedPrompts) ? payload.suggestedPrompts : [];
    const diagnostics = payload.diagnostics || null;
    const minimalUnsupported = isMinimalUnsupportedResponse(payload);
    const appliedFilters = context.appliedFilters || {};
    const filterChanges = Array.isArray(context.filterChanges) ? context.filterChanges : [];
    const contextParts = [];
    if (context.dataSemantics) contextParts.push(`Semantics: ${context.dataSemantics}`);
    if (context.executionMode) contextParts.push(`Mode: ${context.executionMode}`);
    if (context.filtersApplied && (context.filtersApplied.start || context.filtersApplied.end)) {
      contextParts.push(`Window: ${(context.filtersApplied.start || "--")} to ${(context.filtersApplied.end || "--")}`);
    }
    return `
      <article class="rlm-assistant-message rlm-assistant-message--assistant assistant-chat-bubble assistant-chat-bubble--assistant">
        <p class="rlm-assistant-message__eyebrow">Assistant</p>
        <h3 class="rlm-assistant-message__title">${escapeHtml(answer.title || "Assistant response")}</h3>
        <p class="rlm-assistant-message__body">${escapeHtml(answer.summary || "")}</p>
        ${!minimalUnsupported ? renderAppliedFiltersBlock(appliedFilters) : ""}
        ${!minimalUnsupported ? renderFilterChangesBlock(filterChanges) : ""}
        ${!minimalUnsupported && contextParts.length ? `
          <div class="rlm-assistant-context-row">
            ${contextParts.map((item) => `<span class="filter-chip">${escapeHtml(item)}</span>`).join("")}
          </div>
        ` : ""}
        ${!minimalUnsupported ? sections.map((section) => `
          <div class="rlm-assistant-section">
            <p class="rlm-assistant-section__label">${escapeHtml(section.label || "")}</p>
            ${renderSectionContent(section)}
          </div>
        `).join("") : ""}
        ${!minimalUnsupported ? renderInlineEvidence(metrics, context) : ""}
        ${!minimalUnsupported ? renderInlineChart(chart, context, index) : ""}
        ${renderInlineSuggestedPrompts(prompts)}
        ${!minimalUnsupported && diagnostics && diagnosticsEnabled() ? renderDiagnosticsBlock(diagnostics) : ""}
        ${!minimalUnsupported ? `<div class="rlm-assistant-tools">
          ${tools.map((tool) => `
            <span class="filter-chip">${escapeHtml(tool.tool || "tool")}: ${tool.ok ? "ok" : "failed"}</span>
          `).join("")}
        </div>` : ""}
      </article>
    `;
  }

  function isMinimalUnsupportedResponse(payload) {
    const context = (payload || {}).context || {};
    return context.dataSemantics === "request-validation";
  }

  function renderSectionContent(section) {
    const label = String((section && section.label) || "");
    const text = String((section && section.text) || "");
    const groupedBlocks = splitMachineBlocks(text);
    const normalizedLabel = label.toLowerCase();
    const shouldGroupByMachine =
      groupedBlocks.length >= 2
      && (
        label === "Production context"
        || label === "Category ranking comparison"
        || normalizedLabel.includes("category") && normalizedLabel.includes("comparison")
        || label.endsWith(" comparison")
        || label === "Overall comparison"
      );
    if (shouldGroupByMachine) {
      return `
        <div class="rlm-assistant-section-groups">
          ${groupedBlocks.map((block) => renderMachineGroup(block)).join("")}
        </div>
      `;
    }
    const items = splitSectionItems(text);
    if (shouldRenderSectionItems(label, items)) {
      return renderSectionItems(items);
    }
    return `<p class="rlm-assistant-section__text">${escapeHtml(text)}</p>`;
  }

  function splitMachineBlocks(text) {
    const source = String(text || "").trim();
    if (!source) return [];
    const matches = [...source.matchAll(/(?:^|\|\s*)(Press\s+\d+):\s*/g)];
    if (!matches.length) return [];
    return matches.map((match, index) => {
      const label = match[1];
      const contentStart = match.index + match[0].length;
      const contentEnd = index + 1 < matches.length ? matches[index + 1].index : source.length;
      const content = source.slice(contentStart, contentEnd).replace(/\s*\|\s*$/, "").trim();
      return { label, content };
    }).filter((block) => block.content);
  }

  function renderMachineGroup(block) {
    const parts = splitSectionItems(block.content || "");
    return `
      <div class="rlm-assistant-subgroup">
        <p class="rlm-assistant-subgroup__title">${escapeHtml(block.label || "")}</p>
        ${renderSectionItems(parts, { compact: true })}
      </div>
    `;
  }

  function splitSectionItems(text) {
    return String(text || "")
      .split(/\s+\|\s+|;\s+/)
      .map((part) => part.trim())
      .filter(Boolean);
  }

  function shouldRenderSectionItems(label, items) {
    if (!Array.isArray(items) || items.length < 2) return false;
    const normalizedLabel = String(label || "").toLowerCase();
    if (
      normalizedLabel.includes("ranking")
      || normalizedLabel.includes("breakdown")
      || normalizedLabel.includes("drivers")
      || normalizedLabel.includes("context")
      || normalizedLabel.includes("scope")
      || normalizedLabel.includes("reels")
      || normalizedLabel.includes("window")
    ) {
      return true;
    }
    return items.some((item) => item.includes(":"));
  }

  function renderSectionItems(items, options) {
    const compact = Boolean(options && options.compact);
    return `
      <div class="rlm-assistant-section-cards${compact ? " rlm-assistant-section-cards--compact" : ""}">
        ${items.map((item) => renderSectionItemCard(item)).join("")}
      </div>
    `;
  }

  function renderSectionItemCard(item) {
    const raw = String(item || "").trim();
    if (!raw) return "";
    const colonIndex = raw.indexOf(":");
    if (colonIndex > 0) {
      const title = raw.slice(0, colonIndex).trim();
      const body = raw.slice(colonIndex + 1).trim();
      return `
        <div class="rlm-assistant-section-card">
          <p class="rlm-assistant-section-card__title">${escapeHtml(title)}</p>
          <p class="rlm-assistant-section-card__body">${escapeHtml(body || "--")}</p>
        </div>
      `;
    }
    return `
      <div class="rlm-assistant-section-card">
        <p class="rlm-assistant-section-card__body">${escapeHtml(raw)}</p>
      </div>
    `;
  }

  function renderInlineEvidence(metrics, context) {
    if (!metrics.length) return "";
    return `
      <div class="rlm-assistant-section">
        <p class="rlm-assistant-section__label">Evidence</p>
        ${context.dataSemantics ? `<p class="rlm-assistant-panel-meta">Data semantics: ${escapeHtml(context.dataSemantics)}</p>` : ""}
        <div class="rlm-assistant-metrics">
          ${metrics.map((metric) => `
            <div class="rlm-assistant-metric-card">
              <p class="rlm-assistant-metric-card__label">${escapeHtml(metric.label || "")}</p>
              <p class="rlm-assistant-metric-card__value">${escapeHtml(metric.value || "--")}</p>
            </div>
          `).join("")}
        </div>
      </div>
    `;
  }

  function renderAppliedFiltersBlock(appliedFilters) {
    const entries = Object.entries(appliedFilters || {}).filter(([, value]) => String(value || "").trim());
    if (!entries.length) return "";
    const items = entries.map(([label, value]) => `${label}: ${value}`);
    return `
      <div class="rlm-assistant-section">
        <p class="rlm-assistant-section__label">Applied Filters</p>
        ${renderSectionItems(items, { compact: true })}
      </div>
    `;
  }

  function renderFilterChangesBlock(filterChanges) {
    const items = Array.isArray(filterChanges) ? filterChanges.filter(Boolean) : [];
    if (!items.length) return "";
    return `
      <div class="rlm-assistant-section">
        <p class="rlm-assistant-section__label">Changes This Turn</p>
        ${renderSectionItems(items, { compact: true })}
      </div>
    `;
  }

  function renderInlineChart(chart, context, index) {
    if (!isRenderableChart(chart)) return "";
    return `
      <div class="rlm-assistant-section">
        <p class="rlm-assistant-section__label">Chart</p>
        ${context.dataSemantics ? `<p class="rlm-assistant-panel-meta">Data semantics: ${escapeHtml(context.dataSemantics)}</p>` : ""}
        <div class="assistant-chart" data-chart-index="${index}"></div>
      </div>
    `;
  }

  function isRenderableChart(chart) {
    if (!chart || (chart.type !== "line" && chart.type !== "bar")) return false;
    if (!Array.isArray(chart.series) || !chart.series.length) return false;
    return chart.series.some((series) => Array.isArray(series.x) && Array.isArray(series.y) && series.x.length && series.y.length);
  }

  function buildPlotlyConfig(chart) {
    const plotType = chart.type === "bar" ? "bar" : "scatter";
    const mode = chart.type === "line" ? "lines+markers" : undefined;
    return {
      data: chart.series
        .filter((series) => Array.isArray(series.x) && Array.isArray(series.y) && series.x.length && series.y.length)
        .map((series) => ({
          x: series.x,
          y: series.y,
          type: plotType,
          mode,
          name: series.name || "",
        })),
      layout: {
        title: chart.title || "",
        margin: { t: 40, l: 40, r: 20, b: 40 },
        paper_bgcolor: "transparent",
        plot_bgcolor: "transparent",
      },
    };
  }

  function renderConversationCharts() {
    if (!historyEl || typeof window.Plotly === "undefined") return;
    const containers = historyEl.querySelectorAll(".assistant-chart[data-chart-index]");
    containers.forEach((container) => {
      const index = Number(container.getAttribute("data-chart-index"));
      const entry = Number.isInteger(index) ? conversation[index] : null;
      const chart = (((entry || {}).payload || {}).evidence || {}).chart || null;
      if (!isRenderableChart(chart)) return;
      const figure = buildPlotlyConfig(chart);
      if (!figure.data.length) return;
      window.Plotly.newPlot(container, figure.data, figure.layout, { responsive: true, displayModeBar: false });
    });
  }

  function renderInlineSuggestedPrompts(prompts) {
    if (!prompts.length) return "";
    return `
      <div class="rlm-assistant-section">
        <p class="rlm-assistant-section__label">Suggested follow-ups</p>
        <div class="filter-chips">
          ${prompts.map((prompt) => `
            <button type="button" class="filter-chip rlm-assistant-prompt-chip" data-prompt="${escapeHtml(prompt)}">${escapeHtml(prompt)}</button>
          `).join("")}
        </div>
      </div>
    `;
  }

  function renderDiagnosticsBlock(diagnostics) {
    const timing = diagnostics.timingMs || {};
    const rows = [
      `Planner attempted: ${diagnostics.plannerAttempted ? "yes" : "no"}`,
      `Planner succeeded: ${diagnostics.plannerSucceeded ? "yes" : "no"}`,
      `Plan validated: ${diagnostics.plannerValidationPassed ? "yes" : "no"}`,
      `Rewrite attempted: ${diagnostics.rewriteAttempted ? "yes" : "no"}`,
      `Rewrite applied: ${diagnostics.rewriteApplied ? "yes" : "no"}`,
      `Fallback: ${diagnostics.fallbackTriggered ? "yes" : "no"}`,
      `Parsed intent: ${diagnostics.parsedIntentKind || "-"}`,
      `Parsed machines: ${(diagnostics.parsedMachines || []).join(", ") || "-"}`,
      `Used conversation context: ${diagnostics.usedConversationContext ? "yes" : "no"}`,
      `Context source turn: ${diagnostics.contextSourceTurn ?? "-"}`,
      `Inherited intent: ${diagnostics.inheritedIntent || "-"}`,
      `Inherited machine id: ${diagnostics.inheritedMachineId || "-"}`,
      `Inherited metric key: ${diagnostics.inheritedMetricKey || "-"}`,
      `Inherited scope: ${diagnostics.inheritedScope ? JSON.stringify(diagnostics.inheritedScope) : "-"}`,
      `Overridden fields: ${(diagnostics.overriddenFields || []).join(", ") || "-"}`,
      `Requested scope: ${diagnostics.requestedScope || "-"}`,
      `Requested scope type: ${diagnostics.requestedScopeType || "-"}`,
      `Requested scope value: ${diagnostics.requestedScopeValue || "-"}`,
      `Scope source: ${diagnostics.scopeSource || "-"}`,
      `Scope override applied: ${diagnostics.scopeOverrideApplied ? "yes" : "no"}`,
      `Sticky filters before: ${diagnostics.stickyFiltersBefore ? JSON.stringify(diagnostics.stickyFiltersBefore) : "-"}`,
      `Sticky filters after: ${diagnostics.stickyFiltersAfter ? JSON.stringify(diagnostics.stickyFiltersAfter) : "-"}`,
      `Filter updates applied: ${diagnostics.filterUpdatesApplied ? JSON.stringify(diagnostics.filterUpdatesApplied) : "-"}`,
      `Active sticky filters: ${diagnostics.activeStickyFilters ? JSON.stringify(diagnostics.activeStickyFilters) : "-"}`,
      `Filter source: ${diagnostics.filterSource || "-"}`,
      `Effective time scope: ${diagnostics.effectiveTimeScope || "-"}`,
      `Effective reel scope: ${diagnostics.effectiveReelScope || "-"}`,
      `Effective feet filter: ${diagnostics.effectiveFeetFilter || "-"}`,
      `Original filter start: ${diagnostics.originalFilterStart || "-"}`,
      `Original filter end: ${diagnostics.originalFilterEnd || "-"}`,
      `Effective filter start: ${diagnostics.effectiveFilterStart || "-"}`,
      `Effective filter end: ${diagnostics.effectiveFilterEnd || "-"}`,
      `Effective reel count: ${diagnostics.effectiveReelCount || "-"}`,
      `Time range source: ${diagnostics.timeRangeSource || "-"}`,
      `Final resolved request: ${diagnostics.finalResolvedRequest ? JSON.stringify(diagnostics.finalResolvedRequest) : "-"}`,
      `Planned machines: ${(diagnostics.plannedMachines || []).join(", ") || "-"}`,
      `Executed machines: ${(diagnostics.executedMachines || []).join(", ") || "-"}`,
      `Base rendered machines: ${(diagnostics.baseRenderedMachines || []).join(", ") || "-"}`,
      `Rewrite rendered machines: ${(diagnostics.rewriteRenderedMachines || []).join(", ") || "-"}`,
      `Final rendered machines: ${(diagnostics.finalRenderedMachines || []).join(", ") || "-"}`,
      `Planner ms: ${timing.planner || 0}`,
      `Tools ms: ${timing.tools || 0}`,
      `Rewrite ms: ${timing.rewrite || 0}`,
      `Total ms: ${timing.total || 0}`,
    ];
    if (diagnostics.fallbackReason) {
      rows.push(`Fallback reason: ${diagnostics.fallbackReason}`);
    }
    return `
      <div class="rlm-assistant-section assistant-diagnostics-inline">
        <p class="rlm-assistant-section__label">Diagnostics</p>
        <div class="rlm-assistant-diagnostics">
          ${rows.map((row) => `<p class="rlm-assistant-diagnostics__row">${escapeHtml(row)}</p>`).join("")}
        </div>
      </div>
    `;
  }

  function renderStarterPromptGroups(groups, options) {
    const compact = Boolean(options && options.compact);
    return groups.map((group) => `
      <section class="assistant-starter-prompts__group${compact ? " assistant-starter-prompts__group--compact" : ""}">
        <p class="assistant-starter-prompts__group-title">${escapeHtml(group.title)}</p>
        <div class="filter-chips assistant-starter-prompts__chips">
          ${group.prompts.map((prompt) => `
            <button type="button" class="filter-chip rlm-assistant-prompt-chip" data-prompt="${escapeHtml(prompt)}">${escapeHtml(prompt)}</button>
          `).join("")}
        </div>
      </section>
    `).join("");
  }

  function renderStarterPrompts() {
    if (emptyPromptGroupsEl) {
      emptyPromptGroupsEl.innerHTML = renderStarterPromptGroups(STARTER_PROMPT_GROUPS, { compact: false });
    }
  }

  function appendConversation(role, content, payload) {
    conversation.push({ role, content, payload });
    renderConversation();
  }

  function setSendingState(isSending) {
    if (!sendButtonEl) return;
    sendButtonEl.disabled = isSending;
    sendButtonEl.textContent = isSending ? "Sending..." : "Send";
    if (newChatButtonEl) {
      newChatButtonEl.disabled = isSending;
    }
  }

  function resetConversation() {
    conversation.length = 0;
    if (inputEl) {
      inputEl.value = "";
      inputEl.focus();
    }
    renderConversation();
  }

  async function submitPrompt(promptOverride) {
    const prompt = typeof promptOverride === "string" ? promptOverride.trim() : (inputEl ? inputEl.value.trim() : "");
    if (!prompt) return;
    appendConversation("user", prompt);
    appendConversation("assistant-loading", "");
    if (inputEl) inputEl.value = "";
    setSendingState(true);
    try {
      const response = await fetch("/assistant/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: prompt,
          filters: getRequestFilters(),
          history: conversation
            .filter((entry) => entry.role === "user" || entry.role === "assistant")
            .slice(-8)
            .map((entry) => ({
            role: entry.role,
            content: entry.role === "assistant"
              ? (((entry.payload || {}).answer || {}).summary || "")
              : (entry.content || ""),
            resolvedRequest: entry.role === "assistant"
              ? ((((entry.payload || {}).context || {}).resolvedRequest) || null)
              : null,
            stickyFilters: entry.role === "assistant"
              ? ((((entry.payload || {}).context || {}).stickyFilters) || null)
              : null,
          })),
          mode: getSelectedMode(),
          diagnostic: diagnosticsEnabled(),
          data_mode: getContextState().dataMode,
        }),
      });
      if (!response.ok) {
        throw new Error(`Assistant request failed (${response.status})`);
      }
      const payload = await response.json();
      replaceLoadingMessage(payload);
      scheduleScrollConversationToBottom();
    } catch (err) {
      const message = err && err.message ? err.message : "Assistant request failed.";
      const payload = {
        answer: {
          title: "The assistant request failed.",
          summary: message,
          sections: [
            {
              label: "Scope",
              text: "This workspace currently supports RLM-only status, comparison, ranking, reel summary, and trend questions.",
            },
          ],
        },
        evidence: { metrics: [{ label: "Status", value: "Request failed" }], chart: null },
        toolsUsed: [{ tool: "request", ok: false }],
        suggestedPrompts: [],
        context: {
          filtersApplied: getRequestFilters(),
          dataSemantics: "request-failure",
        },
      };
      replaceLoadingMessage(payload);
      scheduleScrollConversationToBottom();
    } finally {
      setSendingState(false);
    }
  }

  function replaceLoadingMessage(payload) {
    const index = conversation.findIndex((entry) => entry.role === "assistant-loading");
    if (index >= 0) {
      conversation.splice(index, 1, { role: "assistant", content: "", payload });
    } else {
      conversation.push({ role: "assistant", content: "", payload });
    }
    renderConversation();
  }

  function bindEvents() {
    const sendButton = document.getElementById("assistantSend");
    if (sendButton) {
      sendButton.addEventListener("click", () => submitPrompt());
    }
    if (newChatButtonEl) {
      newChatButtonEl.addEventListener("click", resetConversation);
    }
    if (inputEl) {
      inputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          submitPrompt();
        }
      });
    }
    [dataModeEl, startEl, endEl].forEach((el) => {
      if (!el) return;
      el.addEventListener("change", () => {
        renderContextSummary();
      });
    });
    modeInputs.forEach((input) => {
      input.addEventListener("change", renderContextSummary);
    });
    if (diagnosticsToggleEl) {
      diagnosticsToggleEl.addEventListener("change", renderConversation);
    }
    document.addEventListener("click", (event) => {
      const button = event.target instanceof Element
        ? event.target.closest(".rlm-assistant-prompt-chip")
        : null;
      if (!button) return;
      const prompt = button.dataset.prompt || "";
      if (!prompt) return;
      if (inputEl) {
        inputEl.value = prompt;
        inputEl.focus();
        const caret = inputEl.value.length;
        inputEl.setSelectionRange(caret, caret);
      }
    });
  }

  function init() {
    inputEl = document.getElementById("assistantInput");
    sendButtonEl = document.getElementById("assistantSend");
    newChatButtonEl = document.getElementById("assistantNewChat");
    historyEl = document.getElementById("assistantHistory");
    emptyPromptGroupsEl = document.getElementById("assistantEmptyPromptGroups");
    initialEmptyStateMarkup = historyEl ? historyEl.innerHTML : "";
    summaryEl = document.getElementById("assistantContextSummary");
    dataModeEl = document.getElementById("assistantDataMode");
    startEl = document.getElementById("assistantStart");
    endEl = document.getElementById("assistantEnd");
    diagnosticsToggleEl = document.getElementById("assistantDiagnostics");
    modeInputs = Array.from(document.querySelectorAll('input[name="assistantMode"]'));
    renderContextSummary();
    renderConversation();
    bindEvents();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
