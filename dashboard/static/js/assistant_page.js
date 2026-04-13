(function () {
  const RESPONSE_MODE_STORAGE_KEY = "assistant-response-mode";
  const CONTEXT_COLLAPSED_STORAGE_KEY = "assistant-context-collapsed";
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
  let responseModeInputs = [];
  let sendButtonEl = null;
  let newChatButtonEl = null;
  let contextBarEl = null;
  let contextToggleEl = null;
  let initialEmptyStateMarkup = "";
  let scrollFrameId = 0;
  let scrollTimeoutId = 0;
  let isSendingRequest = false;

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

  function getSelectedResponseMode() {
    const selected = responseModeInputs.find((input) => input.checked);
    return selected ? selected.value : "simple";
  }

  function simpleModeEnabled() {
    return getSelectedResponseMode() === "simple";
  }

  function localTodayIsoDate() {
    const now = new Date();
    const offsetMs = now.getTimezoneOffset() * 60 * 1000;
    return new Date(now.getTime() - offsetMs).toISOString().slice(0, 10);
  }

  function initializeDefaultDateWindow() {
    const today = localTodayIsoDate();
    if (startEl) startEl.value = today;
    if (endEl) endEl.value = today;
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
      `Response: ${getSelectedResponseMode() === "simple" ? "Simple" : "Full"}`,
    ];
    summaryEl.innerHTML = chips.map((item) => `<span class="filter-chip">${escapeHtml(item)}</span>`).join("");
  }

  function setContextCollapsed(collapsed) {
    if (!contextBarEl || !contextToggleEl) return;
    const isCollapsed = Boolean(collapsed);
    contextBarEl.classList.toggle("assistant-context-bar--collapsed", isCollapsed);
    contextToggleEl.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
    contextToggleEl.textContent = isCollapsed ? "Show Filters" : "Hide Filters";
    try {
      window.sessionStorage.setItem(CONTEXT_COLLAPSED_STORAGE_KEY, isCollapsed ? "true" : "false");
    } catch (err) {
      // Ignore storage issues.
    }
  }

  function toggleContextCollapsed() {
    if (!contextBarEl) return;
    setContextCollapsed(!contextBarEl.classList.contains("assistant-context-bar--collapsed"));
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
    if (!minimalUnsupported && simpleModeEnabled() && supportsSimpleMode(payload)) {
      return renderSimpleMessage(payload, prompts, selectSimpleChart(payload), index);
    }
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
          <div class="rlm-assistant-section${sectionDisplayClass(section)}">
            <p class="rlm-assistant-section__label">${escapeHtml(section.label || "")}</p>
            ${renderSectionContent(section)}
          </div>
        `).join("") : ""}
        ${!minimalUnsupported ? renderAnalysisSummaryBlock(payload) : ""}
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

  function supportsSimpleMode(payload) {
    const kind = String((((payload || {}).context || {}).resolvedRequest || {}).kind || "");
    return [
      "status",
      "discovery",
      "reel_summary",
      "compare",
      "ranking_summary",
      "job_list",
      "job_analysis",
      "trend",
      "activity",
    ].includes(kind);
  }

  function getAnswerSection(payload, label) {
    const sections = ((((payload || {}).answer || {}).sections) || []);
    return sections.find((section) => String(section && section.label || "").toLowerCase() === String(label || "").toLowerCase()) || null;
  }

  function compactText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function firstSentence(text) {
    const source = compactText(text);
    if (!source) return "";
    const match = source.match(/^.*?[.!?](?:\s|$)/);
    return match ? match[0].trim() : source;
  }

  function stripLeadingLabel(text) {
    return compactText(text).replace(/^[A-Za-z][A-Za-z\s/-]{1,32}:\s*/, "");
  }

  function metricMapFromPayload(payload) {
    const metrics = (((payload || {}).evidence || {}).metrics) || [];
    return Object.fromEntries(metrics.map((metric) => [String(metric.label || ""), String(metric.value || "")]));
  }

  function listItemsFromSection(payload, label, limit) {
    const section = getAnswerSection(payload, label);
    if (!section || !section.text) return [];
    return splitSectionItems(section.text).map((item) => stripLeadingLabel(item)).filter(Boolean).slice(0, limit || 3);
  }

  function firstMeaningfulSectionText(payload, labels) {
    for (const label of labels) {
      const section = getAnswerSection(payload, label);
      if (section && section.text) return firstSentence(stripLeadingLabel(section.text));
    }
    return "";
  }

  function simpleTrendSentence(metricMap, fallbackText) {
    const trend = compactText(metricMap["Trend"] || "");
    if (trend && trend !== "--") {
      return `Trend is ${trend.toLowerCase()}.`;
    }
    return firstSentence(fallbackText);
  }

  function sectionDisplayClass(section) {
    const label = String((section && section.label) || "").toLowerCase();
    if (label === "qualification summary") return " rlm-assistant-section--secondary";
    return "";
  }

  function selectSimpleChart(payload) {
    const evidenceChart = (((payload || {}).evidence || {}).chart) || null;
    if (isRenderableChart(evidenceChart)) return evidenceChart;
    const answerChart = (((payload || {}).answer || {}).chart) || null;
    if (isRenderableChart(answerChart)) return answerChart;
    const contextChart = (((payload || {}).context || {}).chart) || null;
    if (isRenderableChart(contextChart)) return contextChart;
    const discoveryChart = (((payload || {}).context || {}).discovery || {}).chart || null;
    if (isRenderableChart(discoveryChart)) return discoveryChart;
    return null;
  }

  function buildSimpleSummary(payload, prompts) {
    const context = (payload || {}).context || {};
    const answer = (payload || {}).answer || {};
    const resolved = context.resolvedRequest || {};
    const kind = String(resolved.kind || "");
    const metricMap = metricMapFromPayload(payload);
    const firstPrompt = Array.isArray(prompts) && prompts.length ? prompts[0] : "";
    const statusPeer = getAnswerSection(payload, "Peer ranking in selected window");
    const windowSummary = getAnswerSection(payload, "Window summary");
    const findings = getAnswerSection(payload, "Findings");
    const drivers = getAnswerSection(payload, "Drivers");
    const issueShape = getAnswerSection(payload, "Issue shape");
    const changePoint = getAnswerSection(payload, "Change point");
    const recentReels = getAnswerSection(payload, "Recent reels");
    const productionContext = getAnswerSection(payload, "Production context");
    const comparisonSummary = getAnswerSection(payload, "Comparison summary");
    const decisionSummary = getAnswerSection(payload, "Decision summary");
    const fairnessNotes = getAnswerSection(payload, "Fairness notes");
    const comparisonConfidence = getAnswerSection(payload, "Comparison confidence");
    const rankingSummary = getAnswerSection(payload, "Ranking summary");
    const availableJobs = getAnswerSection(payload, "Available jobs");
    const selectedJobSection = getAnswerSection(payload, "Selected job");
    const recentJobBaseline = getAnswerSection(payload, "Recent-job baseline");
    const recentJobRanking = getAnswerSection(payload, "Recent job ranking");
    const jobConcentration = getAnswerSection(payload, "Job concentration");
    const latestPoint = getAnswerSection(payload, "Latest point");
    const mainDrivers = getAnswerSection(payload, "Main drivers");
    const patternSummary = getAnswerSection(payload, "Pattern summary");
    const trendBasis = getAnswerSection(payload, "Trend basis");
    const metricDefinition = getAnswerSection(payload, "Metric definition");
    const simple = {
      verdict: compactText(answer.title || ""),
      primaryLabel: "Overall standing",
      takeawayPrimaryLabel: "Main issue or strength",
      takeawaySecondaryLabel: "Also worth noting",
      trendLabel: "Trend",
      nextCheckLabel: "Next check",
      peerSummary: "",
      takeaways: [],
      trendSentence: "",
      nextCheck: firstPrompt ? stripLeadingLabel(firstPrompt) : "",
      listLabel: "",
      listItems: [],
    };

    if (kind === "status") {
      const statusSimple = context.statusSimpleSummary || null;
      if (statusSimple) {
        simple.verdict = compactText(statusSimple.verdict || simple.verdict || answer.title || "");
        simple.peerSummary = compactText(statusSimple.overallStanding || "");
        simple.takeaways = Array.isArray(statusSimple.takeaways) ? statusSimple.takeaways.map((item) => compactText(item)).filter(Boolean) : [];
        simple.trendSentence = compactText(statusSimple.trend || "");
        simple.nextCheck = compactText(statusSimple.nextCheck || simple.nextCheck || "");
      } else {
        simple.peerSummary = firstSentence(stripLeadingLabel((statusPeer && statusPeer.text) || ""));
        if (windowSummary && windowSummary.text) simple.takeaways.push(`Main read: ${stripLeadingLabel(firstSentence(windowSummary.text))}`);
        if (productionContext && productionContext.text) simple.takeaways.push(`Context: ${stripLeadingLabel(firstSentence(productionContext.text))}`);
        simple.trendSentence = simpleTrendSentence(metricMap, answer.summary || "");
      }
    } else if (kind === "discovery") {
      simple.primaryLabel = "Main read";
      simple.takeawayPrimaryLabel = "Main driver";
      const baseline = getAnswerSection(payload, "Previous-window comparison");
      simple.peerSummary = baseline
        ? firstSentence(stripLeadingLabel(baseline.text || ""))
        : firstSentence(stripLeadingLabel(answer.summary || ""));
      if (drivers && drivers.text) simple.takeaways.push(`Main driver: ${stripLeadingLabel(firstSentence(drivers.text))}`);
      else if (findings && findings.text) simple.takeaways.push(`Main driver: ${stripLeadingLabel(firstSentence(findings.text))}`);
      if (issueShape && issueShape.text) simple.takeaways.push(`Shape: ${stripLeadingLabel(firstSentence(issueShape.text))}`);
      if (changePoint && changePoint.text) simple.takeaways.push(`Shift: ${stripLeadingLabel(firstSentence(changePoint.text))}`);
      simple.trendSentence = simpleTrendSentence(metricMap, (findings && findings.text) || answer.summary || "");
    } else if (kind === "reel_summary") {
      simple.primaryLabel = "Current read";
      simple.takeawayPrimaryLabel = "Recent movement";
      simple.peerSummary = firstSentence(stripLeadingLabel(answer.summary || ""));
      if (recentReels && recentReels.text) simple.takeaways.push(`Recent movement: ${stripLeadingLabel(firstSentence(recentReels.text))}`);
      if (productionContext && productionContext.text) simple.takeaways.push(`Context: ${stripLeadingLabel(firstSentence(productionContext.text))}`);
      simple.trendSentence = simpleTrendSentence(metricMap, answer.summary || "");
    } else if (kind === "compare") {
      simple.primaryLabel = "Comparison";
      simple.takeawayPrimaryLabel = "Main difference";
      simple.trendLabel = "Confidence";
      simple.peerSummary = firstSentence(stripLeadingLabel(answer.summary || ""));
      const biggestDiff = firstMeaningfulSectionText(payload, ["Category win summary", "Category ranking comparison"]);
      if (biggestDiff) simple.takeaways.push(`Biggest difference: ${biggestDiff}`);
      if (productionContext && productionContext.text) simple.takeaways.push(`Context: ${stripLeadingLabel(firstSentence(productionContext.text))}`);
      simple.trendSentence = comparisonConfidence && comparisonConfidence.text
        ? firstSentence(stripLeadingLabel(comparisonConfidence.text))
        : "";
    } else if (kind === "ranking_summary") {
      simple.primaryLabel = "Top line";
      simple.takeawayPrimaryLabel = "Why it stands out";
      simple.peerSummary = firstSentence(stripLeadingLabel(answer.summary || ""));
      if (mainDrivers && mainDrivers.text) simple.takeaways.push(`Why it stands out: ${stripLeadingLabel(firstSentence(mainDrivers.text))}`);
      else {
        const categoryContext = (answer.sections || []).find((section) => /category (breakdown|context)/i.test(String(section.label || "")));
        if (categoryContext && categoryContext.text) simple.takeaways.push(`Why it stands out: ${stripLeadingLabel(firstSentence(categoryContext.text))}`);
      }
      simple.listItems = listItemsFromSection(payload, "Ranking summary", 3);
      if (!simple.listItems.length) {
        const fallbackListSection = (answer.sections || []).find((section) => / ranking$/i.test(String(section.label || "")));
        if (fallbackListSection && fallbackListSection.text) {
          simple.listItems = splitSectionItems(fallbackListSection.text).map((item) => stripLeadingLabel(item)).filter(Boolean).slice(0, 3);
        }
      }
      simple.listLabel = simple.listItems.length ? "Ranking snapshot" : "";
      simple.trendSentence = "";
    } else if (kind === "job_list") {
      simple.primaryLabel = "Job scope";
      simple.peerSummary = firstSentence(stripLeadingLabel(answer.summary || ""));
      simple.listItems = availableJobs && availableJobs.text
        ? splitSectionItems(availableJobs.text).map((item) => stripLeadingLabel(item)).filter(Boolean).slice(0, 5)
        : [];
      simple.listLabel = simple.listItems.length ? "Recent jobs" : "";
      simple.trendSentence = "";
    } else if (kind === "job_analysis") {
      simple.primaryLabel = "Bottom line";
      simple.takeawayPrimaryLabel = "Selected job";
      simple.peerSummary = firstSentence(stripLeadingLabel(answer.summary || ""));
      if (selectedJobSection && selectedJobSection.text) simple.takeaways.push(`Selected job: ${stripLeadingLabel(firstSentence(selectedJobSection.text))}`);
      else if (recentJobBaseline && recentJobBaseline.text) simple.takeaways.push(`Recent baseline: ${stripLeadingLabel(firstSentence(recentJobBaseline.text))}`);
      if (jobConcentration && jobConcentration.text) simple.takeaways.push(`Concentration: ${stripLeadingLabel(firstSentence(jobConcentration.text))}`);
      simple.listItems = recentJobRanking && recentJobRanking.text
        ? splitSectionItems(recentJobRanking.text).map((item) => stripLeadingLabel(item)).filter(Boolean).slice(0, 4)
        : [];
      simple.listLabel = simple.listItems.length ? "Recent jobs" : "";
      simple.trendSentence = "";
    } else if (kind === "trend") {
      simple.primaryLabel = "Current read";
      simple.takeawayPrimaryLabel = "Latest point";
      simple.peerSummary = firstSentence(stripLeadingLabel(answer.summary || ""));
      if (latestPoint && latestPoint.text) simple.takeaways.push(`Current read: ${stripLeadingLabel(firstSentence(latestPoint.text))}`);
      if (productionContext && productionContext.text) simple.takeaways.push(`Context: ${stripLeadingLabel(firstSentence(productionContext.text))}`);
      simple.trendSentence = simpleTrendSentence(metricMap, trendBasis && trendBasis.text || answer.summary || "");
    } else if (kind === "activity") {
      simple.primaryLabel = comparisonModeLabel(resolved);
      simple.takeawayPrimaryLabel = "Main takeaway";
      simple.peerSummary = firstMeaningfulSectionText(payload, ["Comparison summary", "Decision summary"]) || firstSentence(stripLeadingLabel(answer.summary || ""));
      const mainTakeaway = firstMeaningfulSectionText(payload, ["Main drivers", "Pattern summary", "Metric definition"]);
      if (mainTakeaway) simple.takeaways.push(`Main takeaway: ${mainTakeaway}`);
      if (fairnessNotes && fairnessNotes.text) simple.takeaways.push(`Fairness: ${stripLeadingLabel(firstSentence(fairnessNotes.text))}`);
      else if (comparisonConfidence && comparisonConfidence.text) simple.takeaways.push(`Confidence: ${stripLeadingLabel(firstSentence(comparisonConfidence.text))}`);
      const shape = firstMeaningfulSectionText(payload, ["Concentration pattern", "Run-position pattern"]);
      if (shape) simple.takeaways.push(`Pattern: ${shape}`);
      simple.trendSentence = simpleTrendSentence(metricMap, (decisionSummary && decisionSummary.text) || (patternSummary && patternSummary.text) || answer.summary || "");
    }

    simple.takeaways = simple.takeaways.filter(Boolean).slice(0, 3);
    return simple;
  }

  function comparisonModeLabel(resolved) {
    const comparisonMode = String((resolved && (resolved.comparison_mode || resolved.comparisonMode)) || "");
    if (comparisonMode === "press_vs_press") return "Comparison";
    if (comparisonMode === "press_vs_average") return "Versus average";
    return "Main read";
  }

  function renderSimpleList(summary) {
    if (!Array.isArray(summary.listItems) || !summary.listItems.length) return "";
    return `
      <div class="assistant-simple-summary-list">
        ${summary.listLabel ? `<p class="assistant-simple-summary-list__label">${escapeHtml(summary.listLabel)}</p>` : ""}
        <div class="rlm-assistant-section-cards rlm-assistant-section-cards--compact">
          ${summary.listItems.map((item) => `
            <div class="rlm-assistant-section-card">
              <p class="rlm-assistant-section-card__body">${escapeHtml(item)}</p>
            </div>
          `).join("")}
        </div>
      </div>
    `;
  }

  function buildSimpleSummaryBlocks(summary) {
    const blocks = [];
    if (summary.peerSummary) blocks.push({ label: summary.primaryLabel || "Summary", body: summary.peerSummary });
    summary.takeaways.forEach((item, index) => blocks.push({
      label: index === 0 ? (summary.takeawayPrimaryLabel || "Main takeaway") : (summary.takeawaySecondaryLabel || "Also worth noting"),
      body: item,
    }));
    if (summary.trendSentence) blocks.push({ label: summary.trendLabel || "Trend", body: summary.trendSentence });
    if (summary.nextCheck) blocks.push({ label: summary.nextCheckLabel || "Next check", body: summary.nextCheck });
    const seen = new Set();
    return blocks.filter((block) => {
      const key = compactText(block.body || "").toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function renderSimpleSummaryCards(summary) {
    const blocks = buildSimpleSummaryBlocks(summary);
    if (!blocks.length) return "";
    return `
      <div class="assistant-simple-summary-grid">
        ${blocks.map((block) => `
          <div class="assistant-simple-summary-card">
            <p class="assistant-simple-summary-card__label">${escapeHtml(block.label)}</p>
            ${renderSimpleCardBody(block.body)}
          </div>
        `).join("")}
      </div>
    `;
  }

  function renderSimpleCardBody(text) {
    const lines = splitSimpleCardLines(text);
    if (!lines.length) {
      return `<p class="assistant-simple-summary-card__body">--</p>`;
    }
    if (lines.length === 1) {
      return `<p class="assistant-simple-summary-card__body">${escapeHtml(lines[0])}</p>`;
    }
    return `
      <div class="assistant-simple-summary-card__body assistant-simple-summary-card__body--stacked">
        ${lines.map((line) => `<div class="assistant-simple-summary-card__line">${escapeHtml(line)}</div>`).join("")}
      </div>
    `;
  }

  function splitSimpleCardLines(text) {
    const source = compactText(text);
    if (!source) return [];
    const hardParts = source
      .split(/\s+\|\s+|;\s+/)
      .map((part) => compactText(part))
      .filter(Boolean);
    if (hardParts.length > 1) return hardParts;
    const commaParts = source.split(/,\s+/).map((part) => compactText(part)).filter(Boolean);
    if (shouldSplitSimpleCommaClauses(source, commaParts)) return commaParts;
    return [source];
  }

  function shouldSplitSimpleCommaClauses(source, parts) {
    if (!Array.isArray(parts) || parts.length < 2 || parts.length > 4) return false;
    if (!/, /.test(source)) return false;
    const metricPattern = /(rank|bad feet|variation|drift|speed|monitoring|coverage|trend|check|watch|stable|reels?|feet|pts\/1k|mm|%|healthy|warning|critical|improving|worse|better)/i;
    const datePattern = /\b(?:\d{4}-\d{2}-\d{2}|[A-Z][a-z]{2,8}\s+\d{1,2},\s+\d{4})\b/;
    return parts.every((part) => !datePattern.test(part) && metricPattern.test(part));
  }

  function renderSimpleMessage(payload, prompts, chart, index) {
    const answer = payload.answer || {};
    const context = payload.context || {};
    const resolved = context.resolvedRequest || {};
    const summary = buildSimpleSummary(payload, prompts);
    const analysisSummary = context.analysisSummary || null;
    const summaryBlocks = buildSimpleSummaryBlocks(summary);
    const statusSummary = compactText((context.statusPerformanceSummary || {}).overallSummary || "");
    const isStatus = String(resolved.kind || "") === "status";
    const hasAnalysisSummary = Boolean(analysisSummary);
    const showLeadBody = isStatus
      ? Boolean(statusSummary)
      : Boolean(summary.peerSummary) && !summaryBlocks.length && !hasAnalysisSummary;
    return `
      <article class="rlm-assistant-message rlm-assistant-message--assistant assistant-chat-bubble assistant-chat-bubble--assistant assistant-chat-bubble--simple">
        <p class="rlm-assistant-message__eyebrow">Simple summary</p>
        <h3 class="rlm-assistant-message__title">${escapeHtml(summary.verdict || answer.title || "Assistant response")}</h3>
        ${showLeadBody ? `<p class="rlm-assistant-message__body assistant-simple-summary__body">${escapeHtml(isStatus ? statusSummary : summary.peerSummary)}</p>` : ""}
        ${(!isStatus && !hasAnalysisSummary) ? renderSimpleSummaryCards(summary) : ""}
        ${renderAnalysisSummaryBlock(payload)}
        ${renderSimpleList(summary)}
        ${isRenderableChart(chart) ? `
          <div class="rlm-assistant-section assistant-simple-chart-section">
            <p class="rlm-assistant-section__label">Trend</p>
            <div class="assistant-chart assistant-chart--simple" data-chart-index="${index}"></div>
          </div>
        ` : ""}
        ${renderInlineSuggestedPrompts(prompts)}
      </article>
    `;
  }

  function isMinimalUnsupportedResponse(payload) {
    const context = (payload || {}).context || {};
    return context.dataSemantics === "request-validation";
  }

  function statusChipClass(value) {
    const normalized = String(value || "").toLowerCase();
    if (/(critical|warning|worsening)/.test(normalized)) return "assistant-status-chip assistant-status-chip--hot";
    if (/(watch|mixed)/.test(normalized)) return "assistant-status-chip assistant-status-chip--warm";
    if (/(healthy|stable|improving)/.test(normalized)) return "assistant-status-chip assistant-status-chip--cool";
    return "assistant-status-chip";
  }

  function sparklinePath(points, width, height) {
    const values = Array.isArray(points) ? points.map((value) => Number(value)).filter((value) => Number.isFinite(value)) : [];
    if (!values.length) return "";
    if (values.length === 1) {
      const y = height / 2;
      return `M 0 ${y} L ${width} ${y}`;
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    return values.map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      const y = height - ((value - min) / span) * height;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    }).join(" ");
  }

  function renderStatusSparkline(item) {
    const points = Array.isArray(item && item.trendPoints) ? item.trendPoints : [];
    if (!points.length) {
      return `<div class="assistant-status-sparkline assistant-status-sparkline--empty">No trend strip</div>`;
    }
    const width = 120;
    const height = 28;
    return `
      <div class="assistant-status-sparkline" aria-hidden="true">
        <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
          <path d="${sparklinePath(points, width, height)}"></path>
        </svg>
      </div>
    `;
  }

  function renderStatusMetaRow(label, value) {
    if (!String(value || "").trim()) return "";
    return `
      <div class="assistant-status-meta__row">
        <span class="assistant-status-meta__label">${escapeHtml(label)}</span>
        <span class="assistant-status-meta__value">${escapeHtml(value)}</span>
      </div>
    `;
  }

  function renderStatusTags(tags) {
    const items = Array.isArray(tags) ? tags.map((tag) => String(tag || "").trim()).filter(Boolean) : [];
    if (!items.length) return "";
    return `
      <div class="assistant-status-tags">
        ${items.map((tag) => `<span class="assistant-status-tag">${escapeHtml(tag)}</span>`).join("")}
      </div>
    `;
  }

  function renderAnalysisContextMetric(label, value, auxiliary) {
    if (!String(value || "").trim() && !String(auxiliary || "").trim()) return "";
    return `
      <div class="assistant-status-outcome__metric">
        <span class="assistant-status-outcome__metric-label">${escapeHtml(label || "--")}</span>
        <span class="assistant-status-outcome__metric-value">${escapeHtml(value || "--")}</span>
        <span class="assistant-status-outcome__metric-rank">${escapeHtml(auxiliary || "--")}</span>
      </div>
    `;
  }

  function renderAnalysisContextBlock(items) {
    const rows = Array.isArray(items) ? items.filter((item) => item && (item.label || item.value || item.auxiliary)) : [];
    if (!rows.length) return "";
    return `
      <div class="assistant-status-outcome">
        <div class="assistant-status-outcome__grid">
          ${rows.map((item) => renderAnalysisContextMetric(item.label, item.value, item.auxiliary)).join("")}
        </div>
      </div>
    `;
  }

  function normalizeAnalysisCard(item) {
    if (!item) return null;
    if (item.title || item.value || item.meta) return item;
    return {
      title: item.label || "",
      value: item.currentDisplay || "--",
      condition: item.condition || "",
      trend: item.trend || "",
      meta: [
        { label: item.deltaLabel || "vs previous window", value: item.deltaDisplay || "--" },
        { label: "Peer rank", value: item.peerRankDisplay || "--" },
      ],
      tags: item.tags || [],
      trendPoints: item.trendPoints || [],
      note: item.interpretation || "",
    };
  }

  function renderAnalysisCard(item) {
    const card = normalizeAnalysisCard(item);
    if (!card) return "";
    const trendLabel = String(card.trend || "").replace(/^./, (c) => c.toUpperCase());
    const metaRows = Array.isArray(card.meta) ? card.meta : [];
    return `
      <article class="assistant-status-card">
        <div class="assistant-status-card__header">
          <p class="assistant-status-card__title">${escapeHtml(card.title || "")}</p>
          <div class="assistant-status-card__chips">
            ${card.condition ? `<span class="${statusChipClass(card.condition)}">${escapeHtml(card.condition || "--")}</span>` : ""}
            ${card.trend ? `<span class="${statusChipClass(card.trend)}">${escapeHtml(trendLabel || "--")}</span>` : ""}
          </div>
        </div>
        <div class="assistant-status-card__value">${escapeHtml(card.value || "--")}</div>
        ${renderStatusSparkline(card)}
        <div class="assistant-status-meta">
          ${metaRows.map((row) => renderStatusMetaRow(row && row.label, row && row.value)).join("")}
        </div>
        ${renderStatusTags(card && card.tags)}
        <details class="assistant-status-card__details">
          <summary>Details</summary>
          <p class="assistant-status-card__note">${escapeHtml(card.note || "")}</p>
        </details>
      </article>
    `;
  }

  function renderAnalysisCardGroup(label, cards) {
    const items = Array.isArray(cards) ? cards.map((item) => normalizeAnalysisCard(item)).filter((item) => item && item.title) : [];
    if (!items.length) return "";
    return `
      ${label ? `<p class="rlm-assistant-section__label">${escapeHtml(label)}</p>` : ""}
      <div class="assistant-status-cards">
        ${items.map((item) => renderAnalysisCard(item)).join("")}
      </div>
    `;
  }

  function renderAnalysisSummaryBlock(payload) {
    const context = (payload || {}).context || {};
    const answer = (payload || {}).answer || {};
    const summary = context.analysisSummary || null;
    if (!summary) return "";
    const lead = compactText(summary.lead || "");
    const answerSummary = compactText(answer.summary || "");
    const nextChecks = Array.isArray(summary.nextChecks) ? summary.nextChecks.filter(Boolean) : [];
    return `
      <div class="rlm-assistant-section">
        ${lead && lead !== answerSummary ? `<p class="assistant-status-outcome__summary">${escapeHtml(lead)}</p>` : ""}
        ${renderAnalysisContextBlock(summary.keyContext)}
        ${renderAnalysisCardGroup(summary.primaryLabel || "Primary Findings", summary.primaryCards)}
        ${renderAnalysisCardGroup(summary.supportingLabel || "Supporting Factors", summary.supportingCards)}
        ${renderAnalysisCardGroup(summary.productionLabel || "Production Context", summary.productionCards)}
        ${nextChecks.length ? `
          <p class="rlm-assistant-section__label">Next Checks</p>
          <div class="assistant-status-tags">
            ${nextChecks.map((item) => `<span class="assistant-status-tag">${escapeHtml(item)}</span>`).join("")}
          </div>
        ` : ""}
      </div>
    `;
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
      <div class="rlm-assistant-section rlm-assistant-section--secondary">
        <p class="rlm-assistant-section__label">Applied Filters</p>
        ${renderSectionItems(items, { compact: true })}
      </div>
    `;
  }

  function renderFilterChangesBlock(filterChanges) {
    const items = Array.isArray(filterChanges) ? filterChanges.filter(Boolean) : [];
    if (!items.length) return "";
    return `
      <div class="rlm-assistant-section rlm-assistant-section--secondary">
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
    const chartAnnotations = Array.isArray(chart.annotations) ? chart.annotations : [];
    const layoutAnnotations = [];
    const layoutShapes = [];
    chartAnnotations.forEach((annotation) => {
      if (!annotation || !annotation.kind) return;
      if (annotation.kind === "vertical-line" && annotation.x != null) {
        layoutShapes.push({
          type: "line",
          xref: "x",
          yref: "paper",
          x0: annotation.x,
          x1: annotation.x,
          y0: 0,
          y1: 1,
          line: {
            color: annotation.color || "#94a3b8",
            width: 1,
            dash: annotation.dash || "dot",
          },
        });
        if (annotation.label) {
          layoutAnnotations.push({
            x: annotation.x,
            y: 1,
            xref: "x",
            yref: "paper",
            text: annotation.label,
            showarrow: false,
            yshift: 10,
            font: { size: 11, color: annotation.color || "#64748b" },
            bgcolor: "rgba(255,255,255,0.75)",
          });
        }
      } else if ((annotation.kind === "point-label" || annotation.kind === "text-label") && annotation.x != null && annotation.y != null) {
        layoutAnnotations.push({
          x: annotation.x,
          y: annotation.y,
          xref: "x",
          yref: "y",
          text: annotation.label || "",
          showarrow: true,
          arrowhead: 2,
          arrowsize: 0.8,
          ax: 0,
          ay: -24,
          font: { size: 11, color: annotation.color || "#334155" },
          arrowcolor: annotation.color || "#334155",
          bgcolor: "rgba(255,255,255,0.82)",
        });
      }
    });
    return {
      data: chart.series
        .filter((series) => Array.isArray(series.x) && Array.isArray(series.y) && series.x.length && series.y.length)
        .map((series) => {
          const trace = {
            x: series.x,
            y: series.y,
            type: plotType,
            mode,
            name: series.name || "",
          };
          if (Array.isArray(series.hoverText) && series.hoverText.length === series.y.length) {
            trace.text = series.hoverText;
            trace.hovertemplate = "%{text}<extra></extra>";
            trace.hoverlabel = { align: "left" };
          }
          return trace;
        }),
      layout: {
        title: chart.title || "",
        margin: { t: 40, l: 40, r: 20, b: 40 },
        paper_bgcolor: "transparent",
        plot_bgcolor: "transparent",
        annotations: layoutAnnotations,
        shapes: layoutShapes,
      },
    };
  }

  function renderConversationCharts() {
    if (!historyEl || typeof window.Plotly === "undefined") return;
    const containers = historyEl.querySelectorAll(".assistant-chart[data-chart-index]");
    containers.forEach((container) => {
      const index = Number(container.getAttribute("data-chart-index"));
      const entry = Number.isInteger(index) ? conversation[index] : null;
      const payload = ((entry || {}).payload) || {};
      const chart = simpleModeEnabled() && supportsSimpleMode(payload)
        ? selectSimpleChart(payload)
        : ((((payload || {}).evidence || {}).chart) || null);
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
    isSendingRequest = Boolean(isSending);
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
    if (isSendingRequest) return;
    const prompt = typeof promptOverride === "string" ? promptOverride.trim() : (inputEl ? inputEl.value.trim() : "");
    if (!prompt) return;
    if (inputEl) {
      inputEl.value = prompt;
    }
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
          response_mode: getSelectedResponseMode(),
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

  function submitPromptFromClick(prompt) {
    const value = String(prompt || "").trim();
    if (!value || isSendingRequest) return;
    if (inputEl) {
      inputEl.value = value;
      inputEl.focus();
      const caret = inputEl.value.length;
      inputEl.setSelectionRange(caret, caret);
    }
    submitPrompt();
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
    if (contextToggleEl) {
      contextToggleEl.addEventListener("click", toggleContextCollapsed);
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
    responseModeInputs.forEach((input) => {
      input.addEventListener("change", () => {
        try {
          window.sessionStorage.setItem(RESPONSE_MODE_STORAGE_KEY, getSelectedResponseMode());
        } catch (err) {
          // Ignore storage issues.
        }
        renderContextSummary();
        renderConversation();
      });
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
      submitPromptFromClick(prompt);
    });
  }

  function init() {
    inputEl = document.getElementById("assistantInput");
    sendButtonEl = document.getElementById("assistantSend");
    newChatButtonEl = document.getElementById("assistantNewChat");
    contextBarEl = document.getElementById("assistantContextBar");
    contextToggleEl = document.getElementById("assistantContextToggle");
    historyEl = document.getElementById("assistantHistory");
    emptyPromptGroupsEl = document.getElementById("assistantEmptyPromptGroups");
    initialEmptyStateMarkup = historyEl ? historyEl.innerHTML : "";
    summaryEl = document.getElementById("assistantContextSummary");
    dataModeEl = document.getElementById("assistantDataMode");
    startEl = document.getElementById("assistantStart");
    endEl = document.getElementById("assistantEnd");
    diagnosticsToggleEl = document.getElementById("assistantDiagnostics");
    modeInputs = Array.from(document.querySelectorAll('input[name="assistantMode"]'));
    responseModeInputs = Array.from(document.querySelectorAll('input[name="assistantResponseMode"]'));
    try {
      const storedMode = window.sessionStorage.getItem(RESPONSE_MODE_STORAGE_KEY);
      if (storedMode === "simple" || storedMode === "full") {
        responseModeInputs.forEach((input) => {
          input.checked = input.value === storedMode;
        });
      }
    } catch (err) {
      // Ignore storage issues.
    }
    try {
      const storedCollapsed = window.sessionStorage.getItem(CONTEXT_COLLAPSED_STORAGE_KEY);
      setContextCollapsed(storedCollapsed !== "false");
    } catch (err) {
      setContextCollapsed(true);
    }
    initializeDefaultDateWindow();
    renderContextSummary();
    renderConversation();
    bindEvents();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
