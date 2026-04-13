(function () {
  const COLORS = ["#2563eb", "#f97316", "#10b981", "#e11d48", "#8b5cf6", "#14b8a6", "#f59e0b", "#0ea5e9"];
  const JOB_COLORS = ["#0ea5e9", "#f97316", "#34d399", "#f43f5e", "#a855f7", "#14b8a6", "#f59e0b", "#6366f1", "#ec4899", "#22d3ee"];
  const state = {
    defaultStart: "",
    defaultEnd: "",
    start: "",
    end: "",
    minFeet: null,
    yMin: -5,
    yMax: 5,
    errShrink: null,
    errExpand: null,
    compressGaps: true,
    showOobMarkers: false,
    showReelMarkers: true,
    summaryExpanded: false,
    machineOptions: [],
    selections: new Map(),
    rawData: null,
    data: null,
    optionsStatus: "idle",
    dataStatus: "idle",
    optionsError: "",
    dataError: "",
  };

  const elements = {};
  const jobColorMap = new Map();
  let optionsRequestToken = 0;
  let dataRequestToken = 0;
  let optionsAbortController = null;
  let dataAbortController = null;
  let loadingOverlayCount = 0;

  function init() {
    elements.app = document.querySelector(".rlm-delta-trends-app");
    if (!elements.app) return;
    cacheDom();
    state.defaultStart = elements.app.dataset.defaultStart || "";
    state.defaultEnd = elements.app.dataset.defaultEnd || "";
    state.start = state.defaultStart;
    state.end = state.defaultEnd;
    if (elements.start) elements.start.value = state.start;
    if (elements.end) elements.end.value = state.end;
    syncLocalFilterInputs();
    renderGlobalFilterChips();
    renderLocalFilterChips();
    bindEvents();
    loadOptionsAndData();
  }

  function cacheDom() {
    elements.start = document.getElementById("deltaTrendsStart");
    elements.end = document.getElementById("deltaTrendsEnd");
    elements.minFeet = document.getElementById("deltaTrendsMinFeet");
    elements.yMin = document.getElementById("deltaTrendsYMin");
    elements.yMax = document.getElementById("deltaTrendsYMax");
    elements.errShrink = document.getElementById("deltaTrendsErrShrink");
    elements.errExpand = document.getElementById("deltaTrendsErrExpand");
    elements.apply = document.getElementById("deltaTrendsApply");
    elements.loadingOverlay = document.getElementById("deltaTrendsLoadingOverlay");
    elements.loadingText = document.getElementById("deltaTrendsLoadingText");
    elements.compressToggle = document.getElementById("deltaTrendsCompressToggle");
    elements.oobToggle = document.getElementById("deltaTrendsOobToggle");
    elements.reelToggle = document.getElementById("deltaTrendsReelToggle");
    elements.summaryToggle = document.getElementById("deltaTrendsSummaryToggle");
    elements.selectAll = document.getElementById("deltaTrendsSelectAll");
    elements.clearAll = document.getElementById("deltaTrendsClearAll");
    elements.machineSelector = document.getElementById("deltaTrendsMachineSelector");
    elements.globalFilterChips = document.getElementById("deltaTrendsGlobalFilterChips");
    elements.localFilterChips = document.getElementById("deltaTrendsLocalFilterChips");
    elements.selectionSummary = document.getElementById("deltaTrendsSelectionSummary");
    elements.combinedSubtitle = document.getElementById("deltaTrendsCombinedSubtitle");
    elements.detailSubtitle = document.getElementById("deltaTrendsDetailSubtitle");
    elements.combinedChart = document.getElementById("deltaTrendsCombinedChart");
    elements.combinedTable = document.getElementById("deltaTrendsCombinedTable");
    elements.machinePanels = document.getElementById("deltaTrendsMachinePanels");
  }

  function bindEvents() {
    if (elements.apply) {
      elements.apply.addEventListener("click", () => {
        const nextMinFeet = parsePositiveNumberInput(elements.minFeet);
        const nextYMin = parseOptionalNumberInput(elements.yMin);
        const nextYMax = parseOptionalNumberInput(elements.yMax);
        const nextErrShrink = parseOptionalNumberInput(elements.errShrink);
        const nextErrExpand = parseOptionalNumberInput(elements.errExpand);
        const needsDataReload =
          state.minFeet !== nextMinFeet;

        state.minFeet = nextMinFeet;
        state.yMin = nextYMin;
        state.yMax = nextYMax;
        state.errShrink = nextErrShrink;
        state.errExpand = nextErrExpand;
        syncLocalFilterInputs();
        renderLocalFilterChips();
        if (needsDataReload) {
          loadOptionsAndData();
        } else {
          syncDataToCurrentSelections();
        }
      });
    }
    if (elements.start) {
      elements.start.addEventListener("change", applyDateRangeFilters);
    }
    if (elements.end) {
      elements.end.addEventListener("change", applyDateRangeFilters);
    }
    if (elements.compressToggle) {
      updateCompressToggle();
      elements.compressToggle.addEventListener("click", (event) => {
        const nextValue = event.target.closest("button[data-value]");
        if (!nextValue) return;
        state.compressGaps = nextValue.dataset.value === "on";
        updateCompressToggle();
        renderCharts();
      });
    }
    if (elements.oobToggle) {
      updateOobToggle();
      elements.oobToggle.addEventListener("click", (event) => {
        const nextValue = event.target.closest("button[data-value]");
        if (!nextValue) return;
        state.showOobMarkers = nextValue.dataset.value === "on";
        updateOobToggle();
        renderCharts();
      });
    }
    if (elements.reelToggle) {
      updateReelToggle();
      elements.reelToggle.addEventListener("click", (event) => {
        const nextValue = event.target.closest("button[data-value]");
        if (!nextValue) return;
        state.showReelMarkers = nextValue.dataset.value === "on";
        updateReelToggle();
        renderCharts();
      });
    }
    if (elements.summaryToggle) {
      updateSummaryToggle();
      elements.summaryToggle.addEventListener("click", () => {
        state.summaryExpanded = !state.summaryExpanded;
        updateSummaryToggle();
        renderCombinedSummaryTable((state.data && state.data.machines) || []);
      });
    }
    if (elements.selectAll) {
      elements.selectAll.addEventListener("click", () => {
        state.machineOptions.forEach((machine) => {
          state.selections.set(String(machine.machineId), { enabled: true, expanded: false, jobKeys: [] });
        });
        renderMachineSelector();
        renderSelectionSummary();
        syncDataToCurrentSelections();
        fetchData();
      });
    }
    if (elements.clearAll) {
      elements.clearAll.addEventListener("click", () => {
        state.machineOptions.forEach((machine) => {
          state.selections.set(String(machine.machineId), { enabled: false, expanded: false, jobKeys: [] });
        });
        renderMachineSelector();
        renderSelectionSummary();
        syncDataToCurrentSelections();
        fetchData();
      });
    }
    if (elements.machineSelector) {
      elements.machineSelector.addEventListener("click", handleSelectorClick);
      elements.machineSelector.addEventListener("change", handleSelectorChange);
    }
    if (elements.localFilterChips) {
      elements.localFilterChips.addEventListener("click", handleChipClick);
    }
    if (elements.globalFilterChips) {
      elements.globalFilterChips.addEventListener("click", handleChipClick);
    }
  }

  function updateCompressToggle() {
    if (!elements.compressToggle) return;
    updateSegmentedControl(elements.compressToggle, state.compressGaps ? "on" : "off");
  }

  function updateOobToggle() {
    if (!elements.oobToggle) return;
    updateSegmentedControl(elements.oobToggle, state.showOobMarkers ? "on" : "off");
  }

  function updateReelToggle() {
    if (!elements.reelToggle) return;
    updateSegmentedControl(elements.reelToggle, state.showReelMarkers ? "on" : "off");
  }

  function updateSegmentedControl(container, selectedValue) {
    container.querySelectorAll("button[data-value]").forEach((button) => {
      const isSelected = button.dataset.value === selectedValue;
      button.classList.toggle("is-selected", isSelected);
      button.setAttribute("aria-pressed", isSelected ? "true" : "false");
    });
  }

  function updateSummaryToggle() {
    if (!elements.summaryToggle) return;
    elements.summaryToggle.textContent = state.summaryExpanded ? "Collapse Table" : "Expand Table";
    elements.summaryToggle.setAttribute("aria-expanded", state.summaryExpanded ? "true" : "false");
  }

  async function loadOptionsAndData() {
    optionsRequestToken += 1;
    const requestToken = optionsRequestToken;
    if (optionsAbortController) optionsAbortController.abort();
    optionsAbortController = new AbortController();
    showLoadingOverlay("Loading presses and trend data…");
    state.optionsStatus = "loading";
    state.optionsError = "";
    state.rawData = null;
    state.data = null;
    state.dataStatus = "idle";
    state.dataError = "";
    renderLoadingState("Loading presses…");
    renderGlobalFilterChips();
    renderLocalFilterChips();
    try {
      const params = new URLSearchParams();
      if (state.start) params.set("start", state.start);
      if (state.end) params.set("end", state.end);
      if (Number.isFinite(state.minFeet)) params.set("min_feet", state.minFeet);
      const response = await fetch(`/rlm/api/delta-trends/options?${params.toString()}`, {
        signal: optionsAbortController.signal,
      });
      const payload = await readJsonResponse(response, "delta-trends options");
      if (requestToken !== optionsRequestToken) return;
      const normalized = normalizeOptionsResponse(payload);
      console.info("[RLM Delta Trends] options response count:", normalized.machines.length);
      state.machineOptions = normalized.machines;
      state.optionsStatus = "ready";
      reconcileSelections();
      renderMachineSelector();
      renderSelectionSummary();
      renderGlobalFilterChips();
      renderLocalFilterChips();
      if (!state.machineOptions.length) {
        state.rawData = { machines: [] };
        state.data = { machines: [] };
        state.dataStatus = "empty";
        renderCharts();
        return;
      }
      await fetchData();
    } catch (error) {
      if (error && error.name === "AbortError") return;
      if (requestToken !== optionsRequestToken) return;
      state.machineOptions = [];
      state.selections = new Map();
      state.optionsStatus = "error";
      state.optionsError = error && error.message ? error.message : "Unable to load delta trend options.";
      console.error("[RLM Delta Trends] options load failed", error);
      renderMachineSelector();
      renderSelectionSummary();
      renderGlobalFilterChips();
      renderLocalFilterChips();
      renderDataErrorState("Unable to load delta trend options.");
    } finally {
      hideLoadingOverlay();
    }
  }

  function applyDateRangeFilters() {
    const nextStart = elements.start ? elements.start.value : "";
    const nextEnd = elements.end ? elements.end.value : "";
    if (state.start === nextStart && state.end === nextEnd) return;
    state.start = nextStart;
    state.end = nextEnd;
    renderGlobalFilterChips();
    loadOptionsAndData();
  }

  function handleChipClick(event) {
    const button = event.target.closest("button");
    if (!button) return;
    const chipType = String(button.dataset.chip || "");
    if (chipType === "start") {
      state.start = state.defaultStart;
      if (elements.start) elements.start.value = state.start;
      renderGlobalFilterChips();
      loadOptionsAndData();
      return;
    }
    if (chipType === "end") {
      state.end = state.defaultEnd;
      if (elements.end) elements.end.value = state.end;
      renderGlobalFilterChips();
      loadOptionsAndData();
      return;
    }
    if (chipType === "minFeet") {
      state.minFeet = null;
      syncLocalFilterInputs();
      renderLocalFilterChips();
      loadOptionsAndData();
      return;
    }
    if (chipType === "yMin") {
      state.yMin = null;
      syncLocalFilterInputs();
      renderLocalFilterChips();
      renderCharts();
      return;
    }
    if (chipType === "yMax") {
      state.yMax = null;
      syncLocalFilterInputs();
      renderLocalFilterChips();
      renderCharts();
      return;
    }
    if (chipType === "errShrink") {
      state.errShrink = null;
      syncLocalFilterInputs();
      renderLocalFilterChips();
      syncDataToCurrentSelections();
      return;
    }
    if (chipType === "errExpand") {
      state.errExpand = null;
      syncLocalFilterInputs();
      renderLocalFilterChips();
      syncDataToCurrentSelections();
    }
  }

  function renderGlobalFilterChips() {
    if (!elements.globalFilterChips) return;
    const chips = [];
    if (state.start && state.start !== state.defaultStart) {
      chips.push(`
        <span class="filter-chip">
          <span>Start: ${escapeHtml(formatDateTime(state.start))}</span>
          <button type="button" data-chip="start" aria-label="Reset start date/time filter">×</button>
        </span>
      `);
    }
    if (state.end && state.end !== state.defaultEnd) {
      chips.push(`
        <span class="filter-chip">
          <span>End: ${escapeHtml(formatDateTime(state.end))}</span>
          <button type="button" data-chip="end" aria-label="Reset end date/time filter">×</button>
        </span>
      `);
    }
    elements.globalFilterChips.innerHTML = chips.join("");
    elements.globalFilterChips.style.display = chips.length ? "flex" : "none";
  }

  function renderLocalFilterChips() {
    if (!elements.localFilterChips) return;
    const chips = [];
    if (Number.isFinite(state.minFeet)) {
      chips.push(`
        <span class="filter-chip">
          <span>Min reel feet: ${escapeHtml(formatNumber(state.minFeet, 0))}</span>
          <button type="button" data-chip="minFeet" aria-label="Clear minimum reel feet filter">×</button>
        </span>
      `);
    }
    if (Number.isFinite(state.yMin)) {
      chips.push(`
        <span class="filter-chip">
          <span>Trend Y min: ${escapeHtml(formatNumber(state.yMin, 3))}</span>
          <button type="button" data-chip="yMin" aria-label="Clear trend Y minimum filter">×</button>
        </span>
      `);
    }
    if (Number.isFinite(state.yMax)) {
      chips.push(`
        <span class="filter-chip">
          <span>Trend Y max: ${escapeHtml(formatNumber(state.yMax, 3))}</span>
          <button type="button" data-chip="yMax" aria-label="Clear trend Y maximum filter">×</button>
        </span>
      `);
    }
    if (Number.isFinite(state.errShrink)) {
      chips.push(`
        <span class="filter-chip">
          <span>Error shrink: ${escapeHtml(formatNumber(state.errShrink, 3))}</span>
          <button type="button" data-chip="errShrink" aria-label="Clear error shrink override">×</button>
        </span>
      `);
    }
    if (Number.isFinite(state.errExpand)) {
      chips.push(`
        <span class="filter-chip">
          <span>Error expansion: ${escapeHtml(formatNumber(state.errExpand, 3))}</span>
          <button type="button" data-chip="errExpand" aria-label="Clear error expansion override">×</button>
        </span>
      `);
    }
    elements.localFilterChips.innerHTML = chips.join("");
    elements.localFilterChips.style.display = chips.length ? "flex" : "none";
  }

  function syncLocalFilterInputs() {
    if (elements.minFeet) elements.minFeet.value = Number.isFinite(state.minFeet) ? String(state.minFeet) : "";
    if (elements.yMin) elements.yMin.value = Number.isFinite(state.yMin) ? String(state.yMin) : "";
    if (elements.yMax) elements.yMax.value = Number.isFinite(state.yMax) ? String(state.yMax) : "";
    if (elements.errShrink) elements.errShrink.value = Number.isFinite(state.errShrink) ? String(state.errShrink) : "";
    if (elements.errExpand) elements.errExpand.value = Number.isFinite(state.errExpand) ? String(state.errExpand) : "";
  }

  function reconcileSelections() {
    const nextSelections = new Map();
    const previous = state.selections || new Map();
    state.machineOptions.forEach((machine) => {
      const key = String(machine.machineId);
      const prior = previous.get(key);
      const validJobValues = new Set((machine.jobOptions || []).map((job) => job.value));
      nextSelections.set(key, {
        enabled: prior ? prior.enabled !== false : true,
        expanded: prior ? !!prior.expanded : false,
        jobKeys: prior ? (prior.jobKeys || []).filter((value) => validJobValues.has(value)) : [],
      });
    });
    state.selections = nextSelections;
  }

  function renderMachineSelector() {
    if (!elements.machineSelector) return;
    if (state.optionsStatus === "loading") {
      elements.machineSelector.innerHTML = '<div class="delta-trends-empty">Loading presses…</div>';
      return;
    }
    if (state.optionsStatus === "error") {
      elements.machineSelector.innerHTML = `<div class="delta-trends-empty">${escapeHtml(state.optionsError || "Unable to load delta trend options.")}</div>`;
      return;
    }
    if (!state.machineOptions.length) {
      elements.machineSelector.innerHTML = '<div class="delta-trends-empty">No presses with delta data in the selected window.</div>';
      return;
    }
    elements.machineSelector.innerHTML = state.machineOptions
      .map((machine) => {
        const selection = state.selections.get(String(machine.machineId)) || { enabled: true, expanded: false, jobKeys: [] };
        const selectedCount = selection.jobKeys.length;
        const summary = !selection.enabled
          ? "Excluded from view"
          : selectedCount
            ? `${selectedCount} selected job${selectedCount === 1 ? "" : "s"}`
            : "All jobs in range";
        const jobsHtml = (machine.jobOptions || [])
          .map(
            (job) => `
              <label class="delta-machine-select-card__job ${selection.jobKeys.includes(job.value) ? "is-selected" : ""}">
                <input type="checkbox"
                       data-job-toggle="${machine.machineId}"
                       value="${escapeAttr(job.value)}"
                       ${selection.jobKeys.includes(job.value) ? "checked" : ""}
                       ${selection.enabled ? "" : "disabled"}>
                <span class="delta-machine-select-card__job-copy">
                  <strong>${escapeHtml(job.label)}</strong>
                  <small>${escapeHtml(formatCount(job.reelCount, "reel"))}</small>
                </span>
              </label>`
          )
          .join("");
        return `
          <div class="delta-machine-select-card ${selection.enabled ? "" : "is-disabled"} ${selection.expanded ? "is-expanded" : ""}">
            <div class="delta-machine-select-card__top">
              <label class="delta-machine-select-card__label">
                <input type="checkbox" data-machine-toggle="${machine.machineId}" ${selection.enabled ? "checked" : ""}>
                <span>
                  <strong>${escapeHtml(machine.machineName)}</strong>
                  <span>${escapeHtml(formatCount(machine.reelCount, "reel"))}</span>
                </span>
              </label>
              <button type="button" class="delta-machine-select-card__expand" data-machine-expand="${machine.machineId}">
                ${selection.expanded ? "Hide jobs" : "Choose jobs"}
              </button>
            </div>
            <p class="delta-machine-select-card__summary">${escapeHtml(summary)}</p>
            <div class="delta-machine-select-card__jobs">
              <label class="delta-machine-select-card__all">
                <input type="checkbox" data-machine-all-jobs="${machine.machineId}" ${selection.enabled && !selectedCount ? "checked" : ""} ${selection.enabled ? "" : "disabled"}>
                <span>All jobs for this press</span>
              </label>
              <div class="delta-machine-select-card__job-list">${jobsHtml || '<span class="delta-machine-select-card__summary">No jobs in range.</span>'}</div>
            </div>
          </div>`;
      })
      .join("");
  }

  function handleSelectorClick(event) {
    const expandButton = event.target.closest("[data-machine-expand]");
    if (!expandButton) return;
    const machineId = String(expandButton.dataset.machineExpand || "");
    const selection = state.selections.get(machineId);
    if (!selection) return;
    selection.expanded = !selection.expanded;
    renderMachineSelector();
  }

  function handleSelectorChange(event) {
    const machineToggle = event.target.closest("[data-machine-toggle]");
    if (machineToggle) {
      const machineId = String(machineToggle.dataset.machineToggle || "");
      const selection = state.selections.get(machineId);
      if (!selection) return;
      selection.enabled = machineToggle.checked;
      renderMachineSelector();
      renderSelectionSummary();
      syncDataToCurrentSelections();
      fetchData();
      return;
    }

    const allJobsToggle = event.target.closest("[data-machine-all-jobs]");
    if (allJobsToggle) {
      const machineId = String(allJobsToggle.dataset.machineAllJobs || "");
      const selection = state.selections.get(machineId);
      if (!selection) return;
      selection.enabled = true;
      if (allJobsToggle.checked) {
        selection.jobKeys = [];
      }
      renderMachineSelector();
      renderSelectionSummary();
      syncDataToCurrentSelections();
      fetchData();
      return;
    }

    const jobToggle = event.target.closest("[data-job-toggle]");
    if (jobToggle) {
      const machineId = String(jobToggle.dataset.jobToggle || "");
      const selection = state.selections.get(machineId);
      if (!selection) return;
      selection.enabled = true;
      const next = new Set(selection.jobKeys || []);
      if (jobToggle.checked) next.add(jobToggle.value);
      else next.delete(jobToggle.value);
      selection.jobKeys = Array.from(next);
      renderMachineSelector();
      renderSelectionSummary();
      syncDataToCurrentSelections();
      fetchData();
    }
  }

  function buildSelectionsPayload() {
    return state.machineOptions.map((machine) => {
      const selection = state.selections.get(String(machine.machineId)) || { enabled: true, jobKeys: [] };
      return {
        machineId: machine.machineId,
        enabled: selection.enabled !== false,
        jobKeys: selection.jobKeys || [],
      };
    });
  }

  async function fetchData() {
    if (state.optionsStatus !== "ready") return;
    const selectionsPayload = buildSelectionsPayload();
    const enabledSelections = selectionsPayload.filter((item) => item.enabled !== false);
    if (!enabledSelections.length) {
      state.rawData = { machines: [] };
      state.data = { machines: [] };
      state.dataStatus = "empty";
      state.dataError = "";
      renderCharts();
      return;
    }
    dataRequestToken += 1;
    const requestToken = dataRequestToken;
    if (dataAbortController) dataAbortController.abort();
    dataAbortController = new AbortController();
    showLoadingOverlay("Reloading delta trends…");
    console.info("[RLM Delta Trends] selected press count after action:", enabledSelections.length);
    const payload = {
      start: state.start,
      end: state.end,
      min_feet: state.minFeet,
      selections: selectionsPayload,
    };
    console.info("[RLM Delta Trends] outgoing data request payload:", payload);
    try {
      state.dataStatus = "loading";
      state.dataError = "";
      const response = await fetch("/rlm/api/delta-trends/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: dataAbortController.signal,
        body: JSON.stringify(payload),
      });
      const responsePayload = await readJsonResponse(response, "delta-trends data");
      if (requestToken !== dataRequestToken) return;
      state.rawData = responsePayload || { machines: [] };
      state.data = {
        ...(state.rawData || {}),
        machines: applySelectionFiltersToMachines((state.rawData && state.rawData.machines) || [], selectionsPayload),
      };
      state.dataStatus = ((state.data && state.data.machines) || []).length ? "ready" : "empty";
      renderCharts();
    } catch (error) {
      if (error && error.name === "AbortError") return;
      if (requestToken !== dataRequestToken) return;
      state.data = null;
      state.dataStatus = "error";
      state.dataError = error && error.message ? error.message : "Unable to load delta trend data.";
      console.error("[RLM Delta Trends] data load failed", error);
      renderCharts();
    } finally {
      hideLoadingOverlay();
    }
  }

  function renderSelectionSummary() {
    if (!elements.selectionSummary) return;
    if (state.optionsStatus === "loading") {
      elements.selectionSummary.textContent = "Loading presses…";
      if (elements.combinedSubtitle) elements.combinedSubtitle.textContent = "Loading press options…";
      if (elements.detailSubtitle) elements.detailSubtitle.textContent = "Loading press options…";
      return;
    }
    if (state.optionsStatus === "error") {
      elements.selectionSummary.textContent = state.optionsError || "Unable to load delta trend options.";
      if (elements.combinedSubtitle) elements.combinedSubtitle.textContent = "Options request failed.";
      if (elements.detailSubtitle) elements.detailSubtitle.textContent = "Options request failed.";
      return;
    }
    if (!state.machineOptions.length) {
      elements.selectionSummary.textContent = "No presses with delta data in the selected window.";
      if (elements.combinedSubtitle) elements.combinedSubtitle.textContent = "No presses available for the selected time window.";
      if (elements.detailSubtitle) elements.detailSubtitle.textContent = "No press-specific trends available for the selected time window.";
      return;
    }
    const activeSelections = Array.from(state.selections.values()).filter((selection) => selection.enabled !== false);
    if (!activeSelections.length) {
      elements.selectionSummary.textContent = "No presses selected";
      if (elements.combinedSubtitle) elements.combinedSubtitle.textContent = "No presses selected.";
      if (elements.detailSubtitle) elements.detailSubtitle.textContent = "No presses selected.";
      return;
    }
    const filteredCount = activeSelections.filter((selection) => (selection.jobKeys || []).length > 0).length;
    const pressLabel = `${activeSelections.length} press${activeSelections.length === 1 ? "" : "es"} selected`;
    const filterLabel = filteredCount ? ` · ${filteredCount} with job-specific filters` : " · all at press level";
    const gapLabel = state.compressGaps ? " · gaps compressed" : " · real time spacing";
    const text = `${pressLabel}${filterLabel}${gapLabel}`;
    elements.selectionSummary.textContent = text;
    if (elements.combinedSubtitle) {
      elements.combinedSubtitle.textContent = `${pressLabel}. Jobs are applied per press selection.`;
    }
    if (elements.detailSubtitle) {
      elements.detailSubtitle.textContent = "Each press below stays in sync with the same time window and machine/job selections.";
    }
  }

  function renderCharts() {
    if (state.optionsStatus === "loading") {
      renderDataLoadingState();
      return;
    }
    if (state.optionsStatus === "error") {
      renderDataErrorState("Unable to load delta trend options.");
      return;
    }
    if (!state.machineOptions.length) {
      renderNoOptionsDataState();
      return;
    }
    if (state.dataStatus === "loading") {
      renderDataLoadingState();
      return;
    }
    if (state.dataStatus === "error") {
      renderDataErrorState(state.dataError || "Unable to load delta trend data.");
      return;
    }
    const machines = (state.data && state.data.machines) || [];
    renderCombinedChart(machines);
    renderCombinedSummaryTable(machines);
    renderMachinePanels(machines);
  }

  function purgePlotlyNode(node) {
    if (!node || !window.Plotly) return;
    try {
      window.Plotly.purge(node);
    } catch (error) {
      console.warn("[RLM Delta Trends] failed to purge Plotly node", error);
    }
  }

  function purgePlotlyWithin(container) {
    if (!container || !window.Plotly) return;
    if (container.classList && container.classList.contains("js-plotly-plot")) {
      purgePlotlyNode(container);
    }
    container.querySelectorAll(".js-plotly-plot").forEach((node) => {
      purgePlotlyNode(node);
    });
  }

  function setChartPlaceholder(container, message) {
    if (!container) return;
    purgePlotlyWithin(container);
    container.innerHTML = `<div class="delta-trends-empty">${escapeHtml(message)}</div>`;
  }

  function showLoadingOverlay(message) {
    loadingOverlayCount += 1;
    if (elements.loadingText && message) {
      elements.loadingText.textContent = message;
    }
    if (elements.loadingOverlay) {
      elements.loadingOverlay.classList.remove("hidden");
      elements.loadingOverlay.setAttribute("aria-hidden", "false");
    }
    if (elements.app) {
      elements.app.setAttribute("aria-busy", "true");
    }
  }

  function hideLoadingOverlay() {
    loadingOverlayCount = Math.max(loadingOverlayCount - 1, 0);
    if (loadingOverlayCount > 0) return;
    if (elements.loadingOverlay) {
      elements.loadingOverlay.classList.add("hidden");
      elements.loadingOverlay.setAttribute("aria-hidden", "true");
    }
    if (elements.app) {
      elements.app.setAttribute("aria-busy", "false");
    }
  }

  function resizeAllCharts() {
    if (!window.Plotly || !window.Plotly.Plots || typeof window.Plotly.Plots.resize !== "function") return;
    document.querySelectorAll(".js-plotly-plot").forEach((node) => {
      try {
        window.Plotly.Plots.resize(node);
      } catch (error) {
        console.warn("[RLM Delta Trends] failed to resize Plotly chart", error);
      }
    });
  }

  function scheduleChartResize() {
    const resizeSteps = [0, 180, 360];
    resizeSteps.forEach((delay) => {
      window.setTimeout(resizeAllCharts, delay);
    });
  }

  function renderCombinedChart(machines) {
    if (!elements.combinedChart) return;
    if (!machines.length) {
      setChartPlaceholder(elements.combinedChart, "No delta trend data matches the current filter state.");
      return;
    }
    if (elements.combinedChart.innerHTML.includes("delta-trends-empty")) {
      elements.combinedChart.innerHTML = "";
    }
    const sortedMachines = sortMachines(machines);
    const traces = sortedMachines.flatMap((machine, index) => buildTrendTraces(machine, colorForMachine(index), true));
    Plotly.react(
      elements.combinedChart,
      traces,
      themedLayout({
        height: 440,
        margin: { t: 30, r: 30, b: 60, l: 70 },
        xaxis: {
          type: state.compressGaps ? "linear" : "date",
          title: state.compressGaps ? "Monitoring sequence" : "Timestamp",
        },
        yaxis: buildYAxisConfig(machines),
        showlegend: true,
        legend: { orientation: "h", y: -0.18 },
      })
    );
  }

  function renderCombinedSummaryTable(machines) {
    if (!elements.combinedTable) return;
    if (!machines.length) {
      elements.combinedTable.classList.remove("is-collapsed");
      elements.combinedTable.innerHTML = '<div class="delta-trends-empty">No press summary stats available for the current filter state.</div>';
      return;
    }
    if (!state.summaryExpanded) {
      elements.combinedTable.classList.add("is-collapsed");
      elements.combinedTable.innerHTML = "";
      return;
    }
    elements.combinedTable.classList.remove("is-collapsed");
    const rows = sortMachines(machines)
      .map((machine) => buildMachineStats(machine))
      .map(
        (stats) => `
          <tr>
            <td><strong>${escapeHtml(stats.machineName)}</strong></td>
            <td>${escapeHtml(formatCount(stats.reelCount, "reel"))}</td>
            <td>${escapeHtml(formatCount(stats.pointCount, "point"))}</td>
            <td>${escapeHtml(formatNumber(stats.avgDelta, 3))}</td>
            <td>${escapeHtml(formatNumber(stats.minDelta, 3))}</td>
            <td>${escapeHtml(formatNumber(stats.maxDelta, 3))}</td>
            <td>${escapeHtml(formatNumber(stats.stdDelta, 3))}</td>
            <td>${escapeHtml(formatNumber(stats.avgAbsDelta, 3))}</td>
            <td>${escapeHtml(formatCount(stats.oobCount, "point"))}</td>
            <td>${escapeHtml(formatPercent(stats.badPct))}</td>
            <td>${escapeHtml(formatDateTime(stats.latestTimestamp))}</td>
          </tr>`
      )
      .join("");
    elements.combinedTable.innerHTML = `
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Press</th>
              <th>Reels</th>
              <th>Total Monitoring Points</th>
              <th>Avg Delta</th>
              <th>Min</th>
              <th>Max</th>
              <th>Std Dev</th>
              <th>Avg |Delta|</th>
              <th>Bad Points</th>
              <th>Bad %</th>
              <th>Latest Point</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function renderMachinePanels(machines) {
    if (!elements.machinePanels) return;
    if (!machines.length) {
      setChartPlaceholder(elements.machinePanels, "No press-specific trends to render.");
      return;
    }
    const sortedMachines = sortMachines(machines);
    purgePlotlyWithin(elements.machinePanels);
    elements.machinePanels.innerHTML = sortedMachines
      .map(
        (machine) => `
          <section class="delta-machine-panel">
            <div class="delta-machine-panel__header">
              <div>
                <p class="delta-machine-panel__eyebrow">Press Detail</p>
                <h3>${escapeHtml(machine.machineName)}</h3>
              </div>
              <div class="delta-machine-panel__stats">
                <span class="delta-machine-panel__stat">
                  <strong>${escapeHtml(formatCount(machine.reelCount, "reel"))}</strong>
                  <small>Reels</small>
                </span>
                <span class="delta-machine-panel__stat">
                  <strong>${escapeHtml(formatCount(countMachineOobPoints(machine), "point"))}</strong>
                  <small>Out of Bound</small>
                </span>
                <span class="delta-machine-panel__stat">
                  <strong>${escapeHtml(formatCount(machine.pointCount, "point"))}</strong>
                  <small>Total Delta Points</small>
                </span>
              </div>
            </div>
            <p class="delta-machine-panel__subtitle">${escapeHtml(buildMachineSubtitle(machine))}</p>
            <div class="delta-machine-panel__timeline">
              <p class="delta-machine-panel__timeline-label">Jobs</p>
              <div id="deltaMachineTimeline-${machine.machineId}" class="delta-machine-panel__timeline-bar"></div>
            </div>
            <div class="delta-machine-panel__chart-wrap">
              <div id="deltaMachineChart-${machine.machineId}" class="delta-machine-panel__chart"></div>
            </div>
          </section>`
      )
      .join("");
    sortedMachines.forEach((machine, index) => {
      renderMachineTimeline(machine);
      const target = document.getElementById(`deltaMachineChart-${machine.machineId}`);
      if (!target) return;
      Plotly.react(
        target,
        buildTrendTraces(machine, colorForMachine(index), false),
        themedLayout({
          height: 360,
          margin: { t: 26, r: 30, b: 60, l: 70 },
          xaxis: {
            type: state.compressGaps ? "linear" : "date",
            title: state.compressGaps ? "Monitoring sequence" : "Timestamp",
          },
          yaxis: buildYAxisConfig([machine]),
          shapes: [
            ...(state.showReelMarkers ? buildReelMarkerShapes(machine) : []),
            ...buildErrorBoundShapes(machine),
          ],
          showlegend: false,
        }),
        { displayModeBar: true, responsive: true }
      );
    });
  }

  function renderMachineTimeline(machine) {
    const target = document.getElementById(`deltaMachineTimeline-${machine.machineId}`);
    if (!target) return;
    const segments = buildMachineTimelineSegments(machine);
    if (!segments.length) {
      target.innerHTML = '<div class="delta-machine-panel__timeline-empty">No job timeline data</div>';
      return;
    }
    const totalSpan = Math.max(segments[segments.length - 1].xEnd - segments[0].xStart, 1);
    target.innerHTML = segments
      .map((segment) => {
        const color = colorForJob(segment.jobName);
        const leftPct = ((segment.xStart - segments[0].xStart) / totalSpan) * 100;
        const widthPct = Math.max(((segment.xEnd - segment.xStart) / totalSpan) * 100, 1);
        return `
          <div
            class="delta-machine-panel__timeline-segment"
            style="left:${leftPct}%; width:${widthPct}%; background:${hexToRgba(color, 0.14)}; border-color:${color}; --timeline-accent:${color};"
            title="${escapeAttr(segment.jobLabel)}"
          >
            <span>${escapeHtml(segment.jobLabel)}</span>
            <div class="delta-machine-panel__timeline-tooltip" role="presentation">
              <div class="delta-machine-panel__timeline-tooltip-eyebrow">Press Job Window</div>
              <div class="delta-machine-panel__timeline-tooltip-title">${escapeHtml(segment.jobLabel)}</div>
              <div class="delta-machine-panel__timeline-tooltip-time">${escapeHtml(segment.timeLabel)}</div>
              <div class="delta-machine-panel__timeline-tooltip-grid">
                <div class="delta-machine-panel__timeline-tooltip-metric">
                  <span>Reels</span>
                  <strong>${escapeHtml(formatNumber(segment.reelCount, 0))}</strong>
                </div>
                <div class="delta-machine-panel__timeline-tooltip-metric">
                  <span>Points</span>
                  <strong>${escapeHtml(formatNumber(segment.pointCount, 0))}</strong>
                </div>
                <div class="delta-machine-panel__timeline-tooltip-metric">
                  <span>OOB</span>
                  <strong>${escapeHtml(formatNumber(segment.oobCount, 0))}</strong>
                </div>
              </div>
            </div>
          </div>`;
      })
      .join("");
  }

  function buildMachineTimelineSegments(machine) {
    const points = (machine.points || [])
      .slice()
      .sort((left, right) => {
        const timeDiff = new Date(left.timestamp) - new Date(right.timestamp);
        if (timeDiff !== 0) return timeDiff;
        return Number(left.id || 0) - Number(right.id || 0);
      });
    if (!points.length) return [];
    const rawSegments = [];
    let currentSegment = null;
    points.forEach((point, index) => {
      const jobKey = buildJobKey(point.jobName, point.orderNumber) || `job-${index}`;
      const timestampMs = Date.parse(point.timestamp || "");
      const pointX = state.compressGaps ? index : (Number.isFinite(timestampMs) ? timestampMs : index);
      if (!currentSegment || currentSegment.jobKey !== jobKey) {
        if (currentSegment) rawSegments.push(currentSegment);
        currentSegment = {
          jobKey,
          jobName: point.jobName || "Job",
          jobLabel: point.jobLabel || point.jobName || "Job",
          startTime: point.timestamp || null,
          endTime: point.timestamp || null,
          xStart: pointX,
          xEnd: pointX,
          pointCount: 0,
          oobCount: 0,
          reelIds: new Set(),
        };
      }
      currentSegment.pointCount += 1;
      if (point.outOfRange) currentSegment.oobCount += 1;
      if (point.reelDbId || point.reelId) currentSegment.reelIds.add(String(point.reelDbId || point.reelId));
      currentSegment.endTime = point.timestamp || currentSegment.endTime;
      currentSegment.xEnd = state.compressGaps ? index + 1 : pointX;
    });
    if (currentSegment) rawSegments.push(currentSegment);
    return rawSegments.map((segment) => {
      const safeEnd = segment.xEnd <= segment.xStart ? segment.xStart + 1 : segment.xEnd;
      return {
        ...segment,
        xEnd: safeEnd,
        reelCount: segment.reelIds.size,
        timeLabel: buildTimelineTimeLabel(segment),
      };
    });
  }

  function buildTimelineTimeLabel(segment) {
    if (state.compressGaps) {
      return `${formatCount(segment.pointCount, "point")} in compressed sequence`;
    }
    return `${formatDateTime(segment.startTime)} -> ${formatDateTime(segment.endTime)}`;
  }

  function buildTrendTraces(machine, color, includeLegend) {
    const points = (machine.points || []).slice().sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const indexedPoints = points.map((point, index) => ({
      point,
      index,
      x: state.compressGaps ? index : point.timestamp,
    }));
    const gapThresholdMs = computeGapThresholdMs(indexedPoints);
    const segmentedLine = buildSegmentedLineSeries(indexedPoints, machine, gapThresholdMs);
    const lineTrace = {
      type: "scatter",
      mode: "lines",
      name: machine.machineName,
      x: segmentedLine.x,
      y: segmentedLine.y,
      line: { color, width: 2 },
      hovertemplate: segmentedLine.hover,
      showlegend: includeLegend,
      connectgaps: false,
    };
    const gapTraces = buildGapTraces(indexedPoints, machine, color, gapThresholdMs);
    const oobPoints = points.filter((point) => point.outOfRange);
    const oobTrace =
      state.showOobMarkers && oobPoints.length > 0
        ? {
            type: "scatter",
            mode: "markers",
            x: indexedPoints.filter((entry) => entry.point.outOfRange).map((entry) => entry.x),
            y: oobPoints.map((point) => point.delta),
            marker: { color: "#dc2626", size: 7, symbol: "circle-open" },
            hovertemplate: oobPoints.map(
              (point) =>
                `<b>${escapeHtml(machine.machineName)} · OOB</b><br>` +
                `${escapeHtml(point.jobLabel || point.jobName || "Job")}<br>` +
                `Reel: ${escapeHtml(point.reelId || point.reelDbId || "--")}<br>` +
                `Time: ${escapeHtml(formatDateTime(point.timestamp))}<br>` +
                `Delta: ${escapeHtml(formatNumber(point.delta, 3))} mm<extra></extra>`
            ),
            showlegend: false,
          }
        : null;
    return [lineTrace, ...gapTraces, ...(oobTrace ? [oobTrace] : [])];
  }

  function buildReelMarkerShapes(machine) {
    const points = (machine.points || []).slice().sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const shapes = [];
    let previousReelKey = null;
    points.forEach((point, index) => {
      const reelKey = String(point.reelDbId || point.reelId || "");
      if (!reelKey) return;
      if (index === 0 || reelKey !== previousReelKey) {
        const xValue = state.compressGaps ? index : point.timestamp;
        shapes.push({
          type: "line",
          xref: "x",
          yref: "paper",
          x0: xValue,
          x1: xValue,
          y0: 0,
          y1: 1,
          line: {
            color: "rgba(59, 130, 246, 0.82)",
            width: 2,
            dash: "2px,10px",
          },
        });
      }
      previousReelKey = reelKey;
    });
    return shapes;
  }

  function buildErrorBoundShapes(machine) {
    const points = Array.isArray(machine.points) ? machine.points : [];
    const shapes = [];
    const lowerBound = Number.isFinite(state.errShrink) ? -Math.abs(state.errShrink) : null;
    const upperBound = Number.isFinite(state.errExpand) ? Math.abs(state.errExpand) : null;
    if (!points.length) return shapes;
    if (Number.isFinite(lowerBound)) {
      shapes.push({
        type: "line",
        xref: "paper",
        yref: "y",
        x0: 0,
        x1: 1,
        y0: lowerBound,
        y1: lowerBound,
        line: {
          color: "rgba(220, 38, 38, 0.72)",
          width: 2,
          dash: "dot",
        },
      });
    }
    if (Number.isFinite(upperBound)) {
      shapes.push({
        type: "line",
        xref: "paper",
        yref: "y",
        x0: 0,
        x1: 1,
        y0: upperBound,
        y1: upperBound,
        line: {
          color: "rgba(220, 38, 38, 0.72)",
          width: 2,
          dash: "dot",
        },
      });
    }
    return shapes;
  }

  function buildSegmentedLineSeries(indexedPoints, machine, gapThresholdMs) {
    const x = [];
    const y = [];
    const hover = [];
    for (let index = 0; index < indexedPoints.length; index += 1) {
      const entry = indexedPoints[index];
      const point = entry.point;
      if (index > 0 && gapThresholdMs > 0) {
        const previousTime = Date.parse(indexedPoints[index - 1].point.timestamp || "");
        const currentTime = Date.parse(point.timestamp || "");
        if (Number.isFinite(previousTime) && Number.isFinite(currentTime) && currentTime - previousTime > gapThresholdMs) {
          x.push(null);
          y.push(null);
          hover.push("<extra></extra>");
        }
      }
      x.push(entry.x);
      y.push(point.delta);
      hover.push(
        `<b>${escapeHtml(machine.machineName)}</b><br>` +
        `${escapeHtml(point.jobLabel || point.jobName || "Job")}<br>` +
        `Reel: ${escapeHtml(point.reelId || point.reelDbId || "--")}<br>` +
        `Time: ${escapeHtml(formatDateTime(point.timestamp))}<br>` +
        `Delta: ${escapeHtml(formatNumber(point.delta, 3))} mm<extra></extra>`
      );
    }
    return { x, y, hover };
  }

  function buildGapTraces(indexedPoints, machine, color, gapThresholdMs) {
    if (indexedPoints.length < 2) return [];
    if (!Number.isFinite(gapThresholdMs) || gapThresholdMs <= 0) return [];
    const traces = [];
    for (let index = 1; index < indexedPoints.length; index += 1) {
      const previous = indexedPoints[index - 1];
      const current = indexedPoints[index];
      const previousTime = Date.parse(previous.point.timestamp || "");
      const currentTime = Date.parse(current.point.timestamp || "");
      if (!Number.isFinite(previousTime) || !Number.isFinite(currentTime)) continue;
      if (currentTime - previousTime <= gapThresholdMs) continue;
      traces.push({
        type: "scatter",
        mode: "lines",
        x: [previous.x, current.x],
        y: [previous.point.delta, current.point.delta],
        line: { color, width: 2, dash: "dot" },
        hovertemplate:
          `<b>${escapeHtml(machine.machineName)} · Gap</b><br>` +
          `${escapeHtml(formatDateTime(previous.point.timestamp))} to ${escapeHtml(formatDateTime(current.point.timestamp))}<br>` +
          `Elapsed: ${escapeHtml(formatDuration(currentTime - previousTime))}<extra></extra>`,
        showlegend: false,
      });
    }
    return traces;
  }

  function computeGapThresholdMs(indexedPoints) {
    const intervals = [];
    for (let index = 1; index < indexedPoints.length; index += 1) {
      const previousTime = Date.parse(indexedPoints[index - 1].point.timestamp || "");
      const currentTime = Date.parse(indexedPoints[index].point.timestamp || "");
      if (!Number.isFinite(previousTime) || !Number.isFinite(currentTime)) continue;
      const interval = currentTime - previousTime;
      if (interval > 0) intervals.push(interval);
    }
    if (!intervals.length) return 0;
    intervals.sort((left, right) => left - right);
    const medianInterval = intervals[Math.floor(intervals.length / 2)];
    return Math.max(medianInterval * 3, 15 * 60 * 1000);
  }

  function formatDuration(durationMs) {
    const totalMinutes = Math.round(durationMs / 60000);
    if (totalMinutes < 60) return `${totalMinutes} min`;
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (!minutes) return `${hours} hr`;
    return `${hours} hr ${minutes} min`;
  }

  function themedLayout(layout) {
    const style = getComputedStyle(document.body);
    const surface = style.getPropertyValue("--surface").trim() || "#ffffff";
    const textPrimary = style.getPropertyValue("--text-primary").trim() || "#0f172a";
    return {
      paper_bgcolor: surface,
      plot_bgcolor: surface,
      font: { family: "'Inter', sans-serif", color: textPrimary },
      hoverlabel: {
        bgcolor: surface,
        bordercolor: style.getPropertyValue("--border").trim() || "rgba(148,163,184,0.24)",
        font: { family: "'Inter', sans-serif", color: textPrimary, size: 12 },
        align: "left",
      },
      xaxis: {
        gridcolor: style.getPropertyValue("--chart-grid-color").trim() || "rgba(148,163,184,0.35)",
        linecolor: style.getPropertyValue("--chart-axis-color").trim() || "#94a3b8",
        tickfont: { color: style.getPropertyValue("--text-secondary").trim() || "#475569" },
        automargin: true,
        ...(layout.xaxis || {}),
      },
      yaxis: {
        gridcolor: style.getPropertyValue("--chart-grid-color").trim() || "rgba(148,163,184,0.35)",
        linecolor: style.getPropertyValue("--chart-axis-color").trim() || "#94a3b8",
        tickfont: { color: style.getPropertyValue("--text-secondary").trim() || "#475569" },
        automargin: true,
        ...(layout.yaxis || {}),
      },
      ...layout,
    };
  }

  function renderLoadingState(message) {
    if (elements.machineSelector) {
      elements.machineSelector.innerHTML = `<div class="delta-trends-empty">${escapeHtml(message)}</div>`;
    }
    renderSelectionSummary();
    renderDataLoadingState();
  }

  function renderDataLoadingState() {
    if (elements.combinedChart) {
      setChartPlaceholder(elements.combinedChart, "Loading trend data…");
    }
    if (elements.combinedTable) {
      elements.combinedTable.innerHTML = '<div class="delta-trends-empty">Loading press summary…</div>';
    }
    if (elements.machinePanels) {
      setChartPlaceholder(elements.machinePanels, "Loading press panels…");
    }
  }

  function renderDataErrorState(message) {
    if (elements.combinedChart) {
      setChartPlaceholder(elements.combinedChart, message);
    }
    if (elements.combinedTable) {
      elements.combinedTable.innerHTML = `<div class="delta-trends-empty">${escapeHtml(message)}</div>`;
    }
    if (elements.machinePanels) {
      setChartPlaceholder(elements.machinePanels, message);
    }
  }

  function renderNoOptionsDataState() {
    if (elements.combinedChart) {
      setChartPlaceholder(elements.combinedChart, "No presses with delta data in the selected window.");
    }
    if (elements.combinedTable) {
      elements.combinedTable.innerHTML = '<div class="delta-trends-empty">No press summary stats available for the selected time window.</div>';
    }
    if (elements.machinePanels) {
      setChartPlaceholder(elements.machinePanels, "No press-specific trends available for the selected time window.");
    }
  }

  async function readJsonResponse(response, label) {
    let payload = null;
    try {
      payload = await response.json();
    } catch (error) {
      payload = null;
    }
    if (!response.ok) {
      console.error(`[RLM Delta Trends] ${label} response error`, {
        status: response.status,
        statusText: response.statusText,
        payload,
      });
      throw new Error(`Failed to load ${label} (${response.status})`);
    }
    return payload;
  }

  function normalizeOptionsResponse(payload) {
    const machines = Array.isArray(payload?.machines)
      ? payload.machines
      : Array.isArray(payload?.presses)
        ? payload.presses
        : [];
    return {
      start: payload?.start || "",
      end: payload?.end || "",
      machines: machines
        .map((machine) => ({
          machineId: machine.machineId ?? machine.pressId ?? machine.machine_id,
          machineName: machine.machineName ?? machine.pressName ?? machine.machine_name ?? "Unknown Press",
          reelCount: Number(machine.reelCount ?? machine.reels ?? 0) || 0,
          jobOptions: Array.isArray(machine.jobOptions)
            ? machine.jobOptions
                .map((job) => ({
                  value: job.value,
                  label: buildJobOptionLabel(job),
                  reelCount: Number(job.reelCount ?? job.reels ?? 0) || 0,
                }))
                .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" }))
            : [],
        }))
        .filter((machine) => machine.machineId !== undefined && machine.machineId !== null)
        .sort((a, b) => compareMachineNames(a.machineName, b.machineName)),
    };
  }

  function buildJobOptionLabel(job) {
    const explicit = String(job?.label || "").trim();
    if (explicit) return explicit;
    const jobName = String(job?.jobName || job?.job_name || "").trim() || "Job";
    const orderNumber = String(job?.orderNumber || job?.order_number || "").trim();
    return orderNumber ? `${jobName} - ${orderNumber}` : jobName;
  }

  function compareMachineNames(left, right) {
    const leftName = String(left || "");
    const rightName = String(right || "");
    const leftMatch = leftName.match(/(\d+)/);
    const rightMatch = rightName.match(/(\d+)/);
    if (leftMatch && rightMatch) {
      const diff = Number(leftMatch[1]) - Number(rightMatch[1]);
      if (diff !== 0) return diff;
    }
    return leftName.localeCompare(rightName, undefined, { numeric: true, sensitivity: "base" });
  }

  function sortMachines(machines) {
    return (machines || []).slice().sort((left, right) => compareMachineNames(left.machineName, right.machineName));
  }

  function syncDataToCurrentSelections() {
    if (!state.rawData) return;
    const selectionsPayload = buildSelectionsPayload();
    state.data = {
      ...state.rawData,
      machines: applySelectionFiltersToMachines((state.rawData.machines || []), selectionsPayload),
    };
    state.dataStatus = ((state.data && state.data.machines) || []).length ? "ready" : "empty";
    state.dataError = "";
    renderCharts();
  }

  function buildJobKey(jobName, orderNumber) {
    const cleanedJob = String(jobName || "").trim();
    if (!cleanedJob) return null;
    const cleanedOrder = String(orderNumber || "").trim();
    return `${cleanedJob}|||${cleanedOrder}`;
  }

  function applySelectionFiltersToMachines(machines, selectionsPayload) {
    const selectionByMachineId = new Map(
      (selectionsPayload || []).map((selection) => [String(selection.machineId), selection])
    );
    return (machines || [])
      .map((machine) => {
        const selection = selectionByMachineId.get(String(machine.machineId));
        if (!selection || selection.enabled === false) return null;
        const selectedJobKeys = Array.isArray(selection.jobKeys) ? selection.jobKeys.filter(Boolean) : [];
        const points = Array.isArray(machine.points) ? machine.points : [];
        const filteredPoints = !selectedJobKeys.length
          ? points
          : points.filter((point) => selectedJobKeys.includes(buildJobKey(point.jobName, point.orderNumber)));
        if (!filteredPoints.length) return null;
        const derivedPoints = filteredPoints.map((point) => applyPointDisplayOverrides(point));
        const selectedJobs = !selectedJobKeys.length
          ? machine.selectedJobs || []
          : selectedJobKeys
              .map((jobKey) => {
                const option = (state.machineOptions || [])
                  .find((optionMachine) => String(optionMachine.machineId) === String(machine.machineId))
                  ?.jobOptions?.find((jobOption) => jobOption.value === jobKey);
                return option ? option.label : null;
              })
              .filter(Boolean);
        return {
          ...machine,
          selectedJobs,
          selectionMode: selectedJobKeys.length ? "selected_jobs" : "all_jobs",
          pointCount: derivedPoints.length,
          points: derivedPoints,
        };
      })
      .filter(Boolean);
  }

  function applyPointDisplayOverrides(point) {
    const nextPoint = { ...point };
    const lowerBound = Number.isFinite(state.errShrink)
      ? normalizeOverrideErrorValue(state.errShrink, "lower")
      : normalizeBoundValue(point.lowerBound, point.appliedErrShrink, "lower");
    const upperBound = Number.isFinite(state.errExpand)
      ? normalizeOverrideErrorValue(state.errExpand, "upper")
      : normalizeBoundValue(point.upperBound, point.appliedErrExpand, "upper");
    const delta = Number(point.delta);
    nextPoint.lowerBound = lowerBound;
    nextPoint.upperBound = upperBound;
    if (Number.isFinite(delta)) {
      if (Number.isFinite(lowerBound) && Number.isFinite(upperBound)) {
        nextPoint.outOfRange = delta < lowerBound || delta > upperBound;
      } else if (Number.isFinite(lowerBound)) {
        nextPoint.outOfRange = delta < lowerBound;
      } else if (Number.isFinite(upperBound)) {
        nextPoint.outOfRange = delta > upperBound;
      }
    }
    return nextPoint;
  }

  function normalizeBoundValue(primaryValue, fallbackErrorValue, side) {
    const primary = Number(primaryValue);
    if (Number.isFinite(primary)) return primary;
    const fallback = Number(fallbackErrorValue);
    if (!Number.isFinite(fallback)) return null;
    return side === "lower" ? -Math.abs(fallback) : Math.abs(fallback);
  }

  function normalizeOverrideErrorValue(value, side) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    if (side === "lower") return numeric <= 0 ? numeric : -Math.abs(numeric);
    return numeric >= 0 ? numeric : Math.abs(numeric);
  }

  function buildMachineSubtitle(machine) {
    const selectedJobs = machine.selectedJobs || [];
    if (!selectedJobs.length) {
      return `All jobs in selected window · ${formatCount(machine.reelCount, "reel")} · ${formatCount(machine.pointCount, "delta point")}`;
    }
    const labels = selectedJobs.slice(0, 3).join(", ");
    const extra = selectedJobs.length > 3 ? ` +${selectedJobs.length - 3} more` : "";
    return `Filtered to: ${labels}${extra} · ${formatCount(machine.reelCount, "reel")} · ${formatCount(machine.pointCount, "delta point")}`;
  }

  function colorForMachine(index) {
    return COLORS[index % COLORS.length];
  }

  function colorForJob(jobName) {
    const key = String(jobName || "Job").trim().toLowerCase() || "job";
    if (!jobColorMap.has(key)) {
      jobColorMap.set(key, JOB_COLORS[jobColorMap.size % JOB_COLORS.length]);
    }
    return jobColorMap.get(key);
  }

  function formatNumber(value, digits) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "--";
    return number.toLocaleString(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function formatDateTime(value) {
    if (!value) return "--";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "--";
    return date.toLocaleString();
  }

  function formatCount(value, noun) {
    const amount = Number(value) || 0;
    return `${amount.toLocaleString()} ${noun}${amount === 1 ? "" : "s"}`;
  }

  function formatPercent(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "--";
    return `${number.toFixed(1)}%`;
  }

  function parsePositiveNumberInput(input) {
    const raw = input ? input.value : "";
    if (raw === "" || raw === null || raw === undefined) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  function parseOptionalNumberInput(input) {
    const raw = input ? input.value : "";
    if (raw === "" || raw === null || raw === undefined) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }

  function buildYAxisConfig(machines) {
    let minValue = null;
    let maxValue = null;
    (machines || []).forEach((machine) => {
      (machine.points || []).forEach((point) => {
        const delta = Number(point.delta);
        if (!Number.isFinite(delta)) return;
        if (minValue === null || delta < minValue) minValue = delta;
        if (maxValue === null || delta > maxValue) maxValue = delta;
      });
    });
    const nextMin = Number.isFinite(state.yMin) ? state.yMin : minValue;
    const nextMax = Number.isFinite(state.yMax) ? state.yMax : maxValue;
    const yaxis = { title: "Delta (mm)" };
    if (Number.isFinite(nextMin) && Number.isFinite(nextMax)) {
      if (nextMin === nextMax) {
        const padding = nextMin === 0 ? 1 : Math.abs(nextMin) * 0.05;
        yaxis.range = [nextMin - padding, nextMax + padding];
      } else {
        yaxis.range = [Math.min(nextMin, nextMax), Math.max(nextMin, nextMax)];
      }
    }
    return yaxis;
  }

  function buildMachineStats(machine) {
    const points = Array.isArray(machine.points) ? machine.points : [];
    const deltas = points
      .map((point) => Number(point.delta))
      .filter((delta) => Number.isFinite(delta));
    const oobCount = points.filter((point) => point.outOfRange).length;
    const latestTimestamp = points.reduce((latest, point) => {
      const current = Date.parse(point.timestamp || "");
      if (!Number.isFinite(current)) return latest;
      if (!latest) return point.timestamp || null;
      return current > Date.parse(latest) ? point.timestamp : latest;
    }, null);
    const avgDelta = computeMean(deltas);
    const deltaRange = computeMinMax(deltas);
    return {
      machineName: machine.machineName || "Unknown Press",
      reelCount: Number(machine.reelCount) || 0,
      pointCount: points.length,
      avgDelta,
      minDelta: deltaRange.min,
      maxDelta: deltaRange.max,
      stdDelta: computeStdDev(deltas, avgDelta),
      avgAbsDelta: computeMean(deltas.map((delta) => Math.abs(delta))),
      oobCount,
      badPct: points.length ? (oobCount / points.length) * 100 : null,
      latestTimestamp,
    };
  }

  function countMachineOobPoints(machine) {
    const points = Array.isArray(machine.points) ? machine.points : [];
    return points.filter((point) => point.outOfRange).length;
  }

  function computeMean(values) {
    if (!values.length) return null;
    const total = values.reduce((sum, value) => sum + value, 0);
    return total / values.length;
  }

  function computeStdDev(values, meanValue) {
    if (!values.length) return null;
    const mean = Number.isFinite(meanValue) ? meanValue : computeMean(values);
    if (!Number.isFinite(mean)) return null;
    const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
    return Math.sqrt(variance);
  }

  function computeMinMax(values) {
    if (!values.length) return { min: null, max: null };
    let min = values[0];
    let max = values[0];
    for (let index = 1; index < values.length; index += 1) {
      const value = values[index];
      if (value < min) min = value;
      if (value > max) max = value;
    }
    return { min, max };
  }

  function escapeHtml(value) {
    if (value === null || value === undefined) return "";
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/\n/g, "&#10;");
  }

  function hexToRgba(hex, alpha = 0.1) {
    const normalized = String(hex || "").replace("#", "");
    if (![3, 6].includes(normalized.length)) return `rgba(37, 99, 235, ${alpha})`;
    const fullHex = normalized.length === 3
      ? normalized.split("").map((char) => `${char}${char}`).join("")
      : normalized;
    const integer = Number.parseInt(fullHex, 16);
    const red = (integer >> 16) & 255;
    const green = (integer >> 8) & 255;
    const blue = integer & 255;
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
  }

  window.addEventListener("bst:themechange", () => renderCharts());
  window.addEventListener("bst:layoutchange", scheduleChartResize);
  window.addEventListener("resize", scheduleChartResize);
  document.addEventListener("DOMContentLoaded", init);
})();
