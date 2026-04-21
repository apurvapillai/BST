const DefectTrendsTab = (() => {
  const MAGNITUDE_COLOR = "#2563eb";
  const SPEED_COLOR = "rgba(34, 197, 94, 0.5)";
  const PRESS_COLORS = ["#2563eb", "#f97316", "#10b981", "#e11d48", "#8b5cf6", "#14b8a6", "#f59e0b", "#0ea5e9"];
  const BST_OFF_ANNOTATION_Y = 0.94;
  const REEL_CHANGE_ANNOTATION_Y = 0.78;
  const REFERENCE_CHANGE_ANNOTATION_Y = 0.62;
  const MASK_CHANGE_ANNOTATION_Y = 0.28;

  const state = {
    initialized: false,
    active: false,
    defaultStart: "",
    defaultEnd: "",
    start: "",
    end: "",
    draftMinFeet: "",
    draftBinSize: "500",
    draftYMin: "0",
    draftYMax: "50",
    minFeet: null,
    binSizeFeet: 500,
    yMin: 0,
    yMax: 50,
    machineOptions: [],
    selections: new Map(),
    rawData: null,
    data: null,
    optionsStatus: "idle",
    dataStatus: "idle",
    optionsError: "",
    dataError: "",
    showImageDefects: true,
    showReferenceFlags: true,
    showMaskFlags: true,
  };

  const elements = {};
  let optionsAbortController = null;
  let dataAbortController = null;
  let loadingOverlayCount = 0;
  let machineScrollSyncing = false;
  let maskViewerSerial = 0;
  let referenceViewerBound = false;

  function init() {
    cacheDom();
    if (!elements.app) return;
    state.initialized = true;
    state.defaultStart = elements.app.dataset.defaultStart || "";
    state.defaultEnd = elements.app.dataset.defaultEnd || "";
    state.start = state.defaultStart;
    state.end = state.defaultEnd;
    state.draftMinFeet = "";
    state.draftBinSize = "500";
    state.draftYMin = "0";
    state.draftYMax = "50";
    syncFilterInputs();
    ensureReferenceViewerBindings();
    bindEvents();
  }

  function activate() {
    if (!state.initialized) init();
    if (!elements.app) return;
    state.active = true;
    if (state.optionsStatus === "idle") {
      loadOptionsAndData();
      return;
    }
    renderMachineSelector();
    renderSelectionSummary();
    renderGlobalFilterChips();
    renderLocalFilterChips();
    renderCharts();
    requestAnimationFrame(resizeAllCharts);
  }

  function deactivate() {
    state.active = false;
  }

  function onFiltersUpdated() {}

  function cacheDom() {
    elements.app = document.querySelector(".dashboard-defect-trends-app");
    elements.start = document.getElementById("defectTrendsStart");
    elements.end = document.getElementById("defectTrendsEnd");
    elements.selectionSummary = document.getElementById("defectTrendsSelectionSummary");
    elements.machineSelector = document.getElementById("defectTrendsMachineSelector");
    elements.selectAll = document.getElementById("defectTrendsSelectAll");
    elements.clearAll = document.getElementById("defectTrendsClearAll");
    elements.globalFilterChips = document.getElementById("defectTrendsGlobalFilterChips");
    elements.minFeet = document.getElementById("defectTrendsMinFeet");
    elements.binSize = document.getElementById("defectTrendsBinSize");
    elements.yMin = document.getElementById("defectTrendsYMin");
    elements.yMax = document.getElementById("defectTrendsYMax");
    elements.apply = document.getElementById("defectTrendsApply");
    elements.localFilterChips = document.getElementById("defectTrendsLocalFilterChips");
    elements.combinedSubtitle = document.getElementById("defectTrendsCombinedSubtitle");
    elements.detailSubtitle = document.getElementById("defectTrendsDetailSubtitle");
    elements.showImageDefects = document.getElementById("defectTrendsLegendShowImageDefects");
    elements.showReferenceFlags = document.getElementById("defectTrendsLegendShowReferenceFlags");
    elements.showMaskFlags = document.getElementById("defectTrendsLegendShowMaskFlags");
    elements.combinedChart = document.getElementById("defectTrendsCombinedChart");
    elements.machinePanels = document.getElementById("defectTrendsMachinePanels");
    elements.loadingOverlay = document.getElementById("defectTrendsLoadingOverlay");
    elements.loadingText = document.getElementById("defectTrendsLoadingText");
  }

  function bindEvents() {
    if (elements.start) {
      elements.start.addEventListener("change", () => {
        state.start = elements.start.value || state.defaultStart;
        renderGlobalFilterChips();
        loadOptionsAndData();
      });
    }
    if (elements.end) {
      elements.end.addEventListener("change", () => {
        state.end = elements.end.value || state.defaultEnd;
        renderGlobalFilterChips();
        loadOptionsAndData();
      });
    }
    if (elements.minFeet) {
      elements.minFeet.addEventListener("input", () => {
        state.draftMinFeet = elements.minFeet.value || "";
      });
    }
    if (elements.binSize) {
      elements.binSize.addEventListener("input", () => {
        state.draftBinSize = elements.binSize.value || "";
        const nextBinSize = parsePositiveNumber(state.draftBinSize);
        if (nextBinSize === null) return;
        state.binSizeFeet = nextBinSize;
        renderLocalFilterChips();
        renderMachinePanels();
      });
      elements.binSize.addEventListener("change", () => {
        const nextBinSize = parsePositiveNumber(state.draftBinSize) || 500;
        state.binSizeFeet = nextBinSize;
        state.draftBinSize = String(nextBinSize);
        elements.binSize.value = state.draftBinSize;
        renderLocalFilterChips();
        renderMachinePanels();
      });
    }
    if (elements.yMin) {
      elements.yMin.addEventListener("input", () => {
        state.draftYMin = elements.yMin.value || "";
      });
    }
    if (elements.yMax) {
      elements.yMax.addEventListener("input", () => {
        state.draftYMax = elements.yMax.value || "";
      });
    }
    if (elements.apply) {
      elements.apply.addEventListener("click", applyLocalFilters);
    }
    if (elements.showImageDefects) {
      elements.showImageDefects.checked = state.showImageDefects;
      elements.showImageDefects.addEventListener("change", () => {
        state.showImageDefects = !!elements.showImageDefects.checked;
        renderMachinePanels();
      });
    }
    if (elements.showReferenceFlags) {
      elements.showReferenceFlags.checked = state.showReferenceFlags;
      elements.showReferenceFlags.addEventListener("change", () => {
        state.showReferenceFlags = !!elements.showReferenceFlags.checked;
        renderMachinePanels();
      });
    }
    if (elements.showMaskFlags) {
      elements.showMaskFlags.checked = state.showMaskFlags;
      elements.showMaskFlags.addEventListener("change", () => {
        state.showMaskFlags = !!elements.showMaskFlags.checked;
        renderMachinePanels();
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
    if (elements.globalFilterChips) {
      elements.globalFilterChips.addEventListener("click", handleChipClick);
    }
    if (elements.localFilterChips) {
      elements.localFilterChips.addEventListener("click", handleChipClick);
    }
    window.addEventListener("resize", Utils.debounce(resizeAllCharts, 120));
    window.addEventListener("bst:themechange", () => {
      if (!state.active) return;
      renderCharts();
    });
  }

  function ensureReferenceViewerBindings() {
    if (referenceViewerBound) return;
    const modal = document.getElementById("driversReferenceViewerModal");
    const close = document.getElementById("driversReferenceViewerClose");
    const dismiss = document.getElementById("driversReferenceViewerDismiss");
    const closeViewer = () => {
      if (modal) modal.classList.add("hidden");
      document.body.classList.remove("drivers-reference-viewer-open");
    };
    if (modal) {
      modal.addEventListener("click", (event) => {
        if (event.target === modal) closeViewer();
      });
    }
    if (close) close.addEventListener("click", closeViewer);
    if (dismiss) dismiss.addEventListener("click", closeViewer);
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (modal && !modal.classList.contains("hidden")) {
        closeViewer();
      }
    });
    referenceViewerBound = true;
  }

  function syncFilterInputs() {
    if (elements.start) elements.start.value = state.start;
    if (elements.end) elements.end.value = state.end;
    if (elements.minFeet) elements.minFeet.value = state.draftMinFeet;
    if (elements.binSize) elements.binSize.value = state.draftBinSize;
    if (elements.yMin) elements.yMin.value = state.draftYMin;
    if (elements.yMax) elements.yMax.value = state.draftYMax;
  }

  function parseOptionalNumber(value) {
    const raw = `${value ?? ""}`.trim();
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function parsePositiveNumber(value) {
    const raw = `${value ?? ""}`.trim();
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  function applyLocalFilters() {
    const nextMinFeet = parseOptionalNumber(state.draftMinFeet);
    const nextYMin = parseOptionalNumber(state.draftYMin);
    const nextYMax = parseOptionalNumber(state.draftYMax);
    const minFeetChanged = nextMinFeet !== state.minFeet;
    const yChanged = nextYMin !== state.yMin || nextYMax !== state.yMax;
    state.minFeet = nextMinFeet;
    state.yMin = nextYMin;
    state.yMax = nextYMax;
    renderLocalFilterChips();
    if (minFeetChanged) {
      loadOptionsAndData();
      return;
    }
    if (yChanged) {
      renderCharts();
    }
  }

  function buildOptionsQuery() {
    const params = new URLSearchParams();
    if (state.start) params.set("start", state.start);
    if (state.end) params.set("end", state.end);
    if (state.minFeet !== null) params.set("min_feet", String(state.minFeet));
    return params.toString();
  }

  async function loadOptionsAndData() {
    if (!state.active) return;
    showLoadingOverlay("Loading defect trend options…");
    try {
      await fetchOptions();
      syncSelectionsFromOptions();
      renderMachineSelector();
      renderSelectionSummary();
      renderGlobalFilterChips();
      renderLocalFilterChips();
      await fetchData();
    } catch (error) {
      console.error("[Dashboard Defect Trends] options/data load failed", error);
    } finally {
      hideLoadingOverlay();
    }
  }

  async function fetchOptions() {
    if (optionsAbortController) optionsAbortController.abort();
    optionsAbortController = new AbortController();
    state.optionsStatus = "loading";
    state.optionsError = "";
    renderMachineSelector();
    renderSelectionSummary();
    const query = buildOptionsQuery();
    try {
      const response = await fetch(`/dashboard/api/defect-trends/options?${query}`, {
        headers: { Accept: "application/json" },
        signal: optionsAbortController.signal,
      });
      const payload = await readJsonResponse(response, "defect-trends options");
      state.machineOptions = Array.isArray(payload && payload.machines) ? payload.machines : [];
      state.optionsStatus = "ready";
      state.optionsError = "";
    } catch (error) {
      if (error && error.name === "AbortError") return;
      state.machineOptions = [];
      state.optionsStatus = "error";
      state.optionsError = error && error.message ? error.message : "Unable to load defect trend options.";
      throw error;
    }
  }

  function syncSelectionsFromOptions() {
    const validMachineIds = new Set(state.machineOptions.map((machine) => String(machine.machineId)));
    Array.from(state.selections.keys()).forEach((machineId) => {
      if (!validMachineIds.has(machineId)) {
        state.selections.delete(machineId);
      }
    });
    state.machineOptions.forEach((machine) => {
      const machineId = String(machine.machineId);
      const current = state.selections.get(machineId);
      const validJobKeys = new Set((machine.jobOptions || []).map((job) => job.value));
      if (!current) {
        state.selections.set(machineId, { enabled: true, expanded: false, jobKeys: [] });
        return;
      }
      current.jobKeys = (current.jobKeys || []).filter((jobKey) => validJobKeys.has(jobKey));
      state.selections.set(machineId, current);
    });
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
    if (!state.active || state.optionsStatus !== "ready") return;
    const selections = buildSelectionsPayload();
    const enabledSelections = selections.filter((selection) => selection.enabled !== false);
    if (!enabledSelections.length) {
      state.rawData = { machines: [] };
      state.data = { machines: [] };
      state.dataStatus = "empty";
      renderCharts();
      return;
    }
    if (dataAbortController) dataAbortController.abort();
    dataAbortController = new AbortController();
    showLoadingOverlay("Loading defect trends…");
    state.dataStatus = "loading";
    state.dataError = "";
    try {
      const response = await fetch("/dashboard/api/defect-trends/data", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        signal: dataAbortController.signal,
        body: JSON.stringify({
          start: state.start,
          end: state.end,
          min_feet: state.minFeet,
          selections,
        }),
      });
      const payload = await readJsonResponse(response, "defect-trends data");
      state.rawData = payload || { machines: [] };
      state.data = {
        ...(state.rawData || {}),
        machines: applySelectionFiltersToMachines((state.rawData && state.rawData.machines) || [], selections),
      };
      state.dataStatus = ((state.data && state.data.machines) || []).length ? "ready" : "empty";
      renderCharts();
    } catch (error) {
      if (error && error.name === "AbortError") return;
      state.data = null;
      state.dataStatus = "error";
      state.dataError = error && error.message ? error.message : "Unable to load defect trend data.";
      renderCharts();
      throw error;
    } finally {
      hideLoadingOverlay();
    }
  }

  function applySelectionFiltersToMachines(machines, selectionsPayload) {
    const selectionsByMachine = new Map((selectionsPayload || []).map((selection) => [String(selection.machineId), selection]));
    return (Array.isArray(machines) ? machines : [])
      .filter((machine) => {
        const selection = selectionsByMachine.get(String(machine.machineId));
        return selection && selection.enabled !== false;
      })
      .map((machine) => {
        const selection = selectionsByMachine.get(String(machine.machineId)) || { jobKeys: [] };
        const selectedJobs = new Set(selection.jobKeys || []);
        if (!selectedJobs.size) return machine;
        const filteredReels = (machine.reels || []).filter((reel) => selectedJobs.has(buildJobKey(reel.jobName, reel.orderNumber)));
        const validReelIds = new Set(filteredReels.map((reel) => reel.reelId));
        const filteredPoints = (machine.points || []).filter((point) => validReelIds.has(point.reelId));
        const stats = {
          ...(machine.stats || {}),
          reelCount: filteredReels.length,
          defectCount: filteredPoints.length,
        };
        return {
          ...machine,
          reels: filteredReels,
          points: filteredPoints,
          stats,
        };
      })
      .filter((machine) => (machine.points || []).length);
  }

  function syncDataToCurrentSelections() {
    if (!state.rawData) return;
    state.data = {
      ...(state.rawData || {}),
      machines: applySelectionFiltersToMachines((state.rawData && state.rawData.machines) || [], buildSelectionsPayload()),
    };
    state.dataStatus = ((state.data && state.data.machines) || []).length ? "ready" : "empty";
    renderCharts();
  }

  function renderMachineSelector() {
    if (!elements.machineSelector) return;
    if (state.optionsStatus === "loading") {
      elements.machineSelector.innerHTML = '<div class="delta-trends-empty">Loading presses…</div>';
      return;
    }
    if (state.optionsStatus === "error") {
      elements.machineSelector.innerHTML = `<div class="delta-trends-empty">${escapeHtml(state.optionsError || "Unable to load defect trend options.")}</div>`;
      return;
    }
    if (!state.machineOptions.length) {
      elements.machineSelector.innerHTML = '<div class="delta-trends-empty">No presses with defect data in the selected window.</div>';
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
                  <small>${escapeHtml(formatCount(job.defectCount, "defect"))}</small>
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
                  <span>${escapeHtml(formatCount(machine.defectCount, "defect"))}</span>
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

  function renderSelectionSummary() {
    if (!elements.selectionSummary) return;
    if (state.optionsStatus === "loading") {
      elements.selectionSummary.textContent = "Loading presses…";
      if (elements.combinedSubtitle) elements.combinedSubtitle.textContent = "Loading press options…";
      if (elements.detailSubtitle) elements.detailSubtitle.textContent = "Loading press options…";
      return;
    }
    if (state.optionsStatus === "error") {
      elements.selectionSummary.textContent = state.optionsError || "Unable to load defect trend options.";
      if (elements.combinedSubtitle) elements.combinedSubtitle.textContent = "Options request failed.";
      if (elements.detailSubtitle) elements.detailSubtitle.textContent = "Options request failed.";
      return;
    }
    if (!state.machineOptions.length) {
      elements.selectionSummary.textContent = "No presses with defect data in the selected window.";
      if (elements.combinedSubtitle) elements.combinedSubtitle.textContent = "No presses available for the selected time window.";
      if (elements.detailSubtitle) elements.detailSubtitle.textContent = "No presses available for the selected time window.";
      return;
    }
    const enabledMachines = state.machineOptions.filter((machine) => {
      const selection = state.selections.get(String(machine.machineId));
      return !selection || selection.enabled !== false;
    });
    const selectedJobs = enabledMachines.reduce((total, machine) => {
      const selection = state.selections.get(String(machine.machineId));
      return total + ((selection && selection.jobKeys && selection.jobKeys.length) || 0);
    }, 0);
    const summary = !enabledMachines.length
      ? "No presses selected."
      : selectedJobs
        ? `${enabledMachines.length} presses selected · ${selectedJobs} job overrides active`
        : `${enabledMachines.length} presses selected · all jobs included`;
    elements.selectionSummary.textContent = summary;
    if (elements.combinedSubtitle) {
      elements.combinedSubtitle.textContent = enabledMachines.length
        ? `Magnitude value by feet across ${formatCount(enabledMachines.length, "selected press")}.`
        : "Select at least one press to view the combined defect trend.";
    }
    if (elements.detailSubtitle) {
      elements.detailSubtitle.textContent = enabledMachines.length
        ? `Each selected press plotted with magnitude, severity, and speed delta on the same feet axis.`
        : "Select at least one press to view per-press defect trends.";
    }
  }

  function renderGlobalFilterChips() {
    if (!elements.globalFilterChips) return;
    const chips = [];
    if (state.start && state.start !== state.defaultStart) {
      chips.push(renderChip("start", `Start: ${formatDateTimeLabel(state.start)}`));
    }
    if (state.end && state.end !== state.defaultEnd) {
      chips.push(renderChip("end", `End: ${formatDateTimeLabel(state.end)}`));
    }
    elements.globalFilterChips.innerHTML = chips.join("");
  }

  function renderLocalFilterChips() {
    if (!elements.localFilterChips) return;
    const chips = [];
    if (state.minFeet !== null) chips.push(renderChip("minFeet", `Min reel feet: ${formatNumber(state.minFeet, 0)} ft`));
    if (state.binSizeFeet !== 500) chips.push(renderChip("binSizeFeet", `Bin size: ${formatNumber(state.binSizeFeet, 0)} ft`));
    if (state.yMin !== null) chips.push(renderChip("yMin", `Trend Y min: ${formatNumber(state.yMin, 3)}`));
    if (state.yMax !== null) chips.push(renderChip("yMax", `Trend Y max: ${formatNumber(state.yMax, 3)}`));
    elements.localFilterChips.innerHTML = chips.join("");
  }

  function renderChip(key, label) {
    return `
      <span class="filter-chip">
        <span>${escapeHtml(label)}</span>
        <button type="button" class="chip-remove" data-chip-key="${escapeAttr(key)}" aria-label="Clear ${escapeAttr(label)}">&times;</button>
      </span>
    `;
  }

  function handleChipClick(event) {
    const removeButton = event.target.closest("[data-chip-key]");
    if (!removeButton) return;
    const key = removeButton.dataset.chipKey || "";
    if (key === "start") {
      state.start = state.defaultStart;
      if (elements.start) elements.start.value = state.start;
      renderGlobalFilterChips();
      loadOptionsAndData();
      return;
    }
    if (key === "end") {
      state.end = state.defaultEnd;
      if (elements.end) elements.end.value = state.end;
      renderGlobalFilterChips();
      loadOptionsAndData();
      return;
    }
    if (key === "minFeet") {
      state.minFeet = null;
      state.draftMinFeet = "";
      if (elements.minFeet) elements.minFeet.value = "";
      renderLocalFilterChips();
      loadOptionsAndData();
      return;
    }
    if (key === "binSizeFeet") {
      state.binSizeFeet = 500;
      state.draftBinSize = "500";
      if (elements.binSize) elements.binSize.value = "500";
      renderLocalFilterChips();
      renderMachinePanels();
      return;
    }
    if (key === "yMin") {
      state.yMin = null;
      state.draftYMin = "";
      if (elements.yMin) elements.yMin.value = "";
      renderLocalFilterChips();
      renderCharts();
      return;
    }
    if (key === "yMax") {
      state.yMax = null;
      state.draftYMax = "";
      if (elements.yMax) elements.yMax.value = "";
      renderLocalFilterChips();
      renderCharts();
    }
  }

  function renderCharts() {
    renderCombinedChart();
    renderMachinePanels();
  }

  function renderCombinedChart() {
    if (!elements.combinedChart) return;
    if (state.dataStatus === "loading") {
      elements.combinedChart.innerHTML = '<div class="delta-trends-empty">Loading combined defect trend…</div>';
      return;
    }
    if (state.dataStatus === "error") {
      elements.combinedChart.innerHTML = `<div class="delta-trends-empty">${escapeHtml(state.dataError || "Unable to load defect trend data.")}</div>`;
      return;
    }
    const machines = ((state.data && state.data.machines) || []).filter((machine) => (machine.points || []).length);
    if (!machines.length) {
      elements.combinedChart.innerHTML = '<div class="delta-trends-empty">No defect points available for the current filter state.</div>';
      return;
    }
    const traces = machines
      .map((machine, index) => buildCombinedTrace(machine, PRESS_COLORS[index % PRESS_COLORS.length]))
      .flat()
      .filter(Boolean);
    const chartNode = resetChartHost(elements.combinedChart, "defectTrendsCombinedPlot");
    window.Plotly.react(chartNode, traces, buildChartLayout({
      xTitle: "Feet",
      yTitle: "Severity Value",
      xRange: resolveFullXRangeFromTraces(traces),
      yRange: resolveYRangeFromValues(traces.flatMap((trace) => (Array.isArray(trace && trace.y) ? trace.y : []))),
      showLegend: true,
    }), getPlotConfig());
    bindCombinedLegendSync(chartNode);
  }

  function buildCombinedTrace(machine, color) {
    const series = buildMachineSeries(machine);
    if (!series.x.length) return null;
    const legendGroup = `machine-${machine.machineId}`;
    return [
      {
        x: series.x,
        y: series.severity,
        mode: "lines",
        name: machine.machineName || `Press ${machine.machineId}`,
        legendgroup: legendGroup,
        line: { color, width: 2.4, shape: "linear" },
        hoverinfo: "skip",
        connectgaps: false,
      },
      {
        x: series.hoverX,
        y: series.hoverSeverity,
        text: series.severityHover,
        mode: "markers",
        name: machine.machineName || `Press ${machine.machineId}`,
        legendgroup: legendGroup,
        marker: { color, size: 10, opacity: 0.001 },
        hovertemplate: "%{text}<extra></extra>",
        showlegend: false,
      },
    ];
  }

  function bindCombinedLegendSync(target) {
    if (!target || typeof target.on !== "function") return;
    if (typeof target.removeAllListeners === "function") {
      target.removeAllListeners("plotly_legendclick");
    }
    target.on("plotly_legendclick", (event) => {
      const trace = event && event.data && event.data[event.curveNumber];
      if (!trace) return false;
      const group = trace.legendgroup || "";
      if (!group || !Array.isArray(target.data)) return false;
      const nextVisible = trace.visible === "legendonly" ? true : "legendonly";
      const indices = [];
      target.data.forEach((candidate, index) => {
        if ((candidate && candidate.legendgroup) === group) {
          indices.push(index);
        }
      });
      if (indices.length && window.Plotly && typeof window.Plotly.restyle === "function") {
        window.Plotly.restyle(target, { visible: nextVisible }, indices);
      }
      return false;
    });
  }

  function renderMachinePanels() {
    if (!elements.machinePanels) return;
    if (state.dataStatus === "loading") {
      elements.machinePanels.innerHTML = '<div class="delta-trends-empty">Loading press defect trends…</div>';
      return;
    }
    if (state.dataStatus === "error") {
      elements.machinePanels.innerHTML = `<div class="delta-trends-empty">${escapeHtml(state.dataError || "Unable to load press defect trends.")}</div>`;
      return;
    }
    const machines = ((state.data && state.data.machines) || []).filter((machine) => (machine.points || []).length);
    if (!machines.length) {
      elements.machinePanels.innerHTML = '<div class="delta-trends-empty">No press defect trends available for the current filter state.</div>';
      return;
    }
    const sortedMachines = sortMachines(machines);
    elements.machinePanels.innerHTML = sortedMachines
      .map((machine) => {
        const visibleStats = buildVisibleMachineStats(machine);
        const axisSpan = getMachineFeetSpan(machine);
        const scrollWidthPercent = formatScrollScalePercent(axisSpan, 20000);
        return `
          <article class="delta-machine-panel">
            <div class="delta-machine-panel__header">
              <div>
                <p class="delta-trends-panel__eyebrow">Press Detail</p>
                <h3>${escapeHtml(machine.machineName || `Press ${machine.machineId}`)}</h3>
              </div>
              <div class="delta-machine-panel__stats">
                <span>${escapeHtml(formatCount(visibleStats.reelCount, "reel"))}</span>
                <span>${escapeHtml(formatCount(visibleStats.defectCount, "defect"))}</span>
                <span>${escapeHtml(formatCount(visibleStats.jobCount, "job"))}</span>
              </div>
            </div>
            <div class="delta-machine-panel__timeline">
              <p class="delta-machine-panel__timeline-label">Jobs</p>
              <div class="delta-machine-panel__timeline-scroll" data-machine-scroll="timeline-${machine.machineId}">
                <div class="delta-machine-panel__timeline-wrap" style="width:${escapeAttr(scrollWidthPercent)}%">
                  <div id="defectMachineTimeline-${machine.machineId}" class="delta-machine-panel__timeline-bar"></div>
                </div>
              </div>
            </div>
            <div class="delta-trends-chart-card">
              <div
                class="delta-machine-panel__chart-scroll"
                data-machine-scroll="chart-${machine.machineId}"
                data-machine-id="${escapeAttr(machine.machineId)}"
                data-axis-span="${escapeAttr(axisSpan)}"
                data-baseline-span="20000"
              >
                <div class="delta-machine-panel__chart-wrap" style="width:${escapeAttr(scrollWidthPercent)}%">
                  <div id="defectTrendsMachineChart-${machine.machineId}" class="delta-machine-panel__chart"></div>
                </div>
              </div>
            </div>
          </article>
        `;
      })
      .join("");

    sortedMachines.forEach((machine) => {
      renderMachineTimeline(machine);
      const host = document.getElementById(`defectTrendsMachineChart-${machine.machineId}`);
      renderMachineChart(host, machine);
      syncMachineScroll(machine.machineId);
    });
    setInitialMachineScrollOffset(0);
  }

  function sortMachines(machines) {
    return [...machines].sort((left, right) => {
      const leftName = String(left && left.machineName || "");
      const rightName = String(right && right.machineName || "");
      const leftNumber = Number.parseInt(leftName.replace(/[^0-9]/g, ""), 10);
      const rightNumber = Number.parseInt(rightName.replace(/[^0-9]/g, ""), 10);
      if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
        return leftNumber - rightNumber;
      }
      return leftName.localeCompare(rightName, undefined, { numeric: true, sensitivity: "base" });
    });
  }

  function renderMachineChart(host, machine) {
    if (!host) return;
    const series = buildBinnedMachineSeries(machine);
    if (!series.x.length) {
      host.innerHTML = '<div class="delta-trends-empty">No defect points available.</div>';
      return;
    }
    const yRange = resolveYRangeFromValues(series.defectCounts);
    const speedSeries = buildMachineSpeedSeries(machine);
    const scaledSolidSpeedDelta = scaleFixedSpeedDeltaToTopBand(speedSeries.solidY, yRange, 0.3, 5);
    const scaledDashedSpeedDelta = scaleFixedSpeedDeltaToTopBand(speedSeries.dashedY, yRange, 0.3, 5);
    const bstOffLayout = buildBstOffLayout(machine);
    const reelMarkerLayout = buildReelMarkerLayout(machine);
    const referenceImageLayout = buildReferenceImageChangeLayout(machine);
    const maskLayout = buildMaskChangeLayout(machine);
    const traces = [
      {
        x: series.x,
        y: series.defectCounts,
        mode: "lines",
        name: "Defect Count",
        line: { color: MAGNITUDE_COLOR, width: 2.35, shape: "linear" },
        hoverinfo: "skip",
        connectgaps: false,
      },
      {
        x: series.hoverX,
        y: series.hoverCounts,
        text: series.binHover,
        mode: "markers",
        name: "Defect Count",
        marker: { color: MAGNITUDE_COLOR, size: 10, opacity: 0.001 },
        hovertemplate: "%{text}<extra></extra>",
        showlegend: false,
      },
      {
        x: speedSeries.solidX,
        y: scaledSolidSpeedDelta,
        mode: "lines",
        name: "Speed Delta",
        line: { color: SPEED_COLOR, width: 1.2, shape: "linear" },
        hoverinfo: "skip",
        connectgaps: false,
      },
      {
        x: speedSeries.dashedX,
        y: scaledDashedSpeedDelta,
        mode: "lines",
        name: "Speed Delta",
        line: { color: SPEED_COLOR, width: 1.2, shape: "linear", dash: "dash" },
        hoverinfo: "skip",
        connectgaps: false,
        showlegend: false,
      },
    ];
    window.Plotly.react(host, traces, buildChartLayout({
      xTitle: "Feet",
      yTitle: "Defect Count",
      xRange: [0, Math.max(getMachineFeetSpan(machine), state.binSizeFeet)],
      xDtick: 500,
      yRange,
      showLegend: true,
      shapes: [
        ...bstOffLayout.shapes,
        ...reelMarkerLayout.shapes,
        ...(state.showReferenceFlags ? referenceImageLayout.shapes : []),
        ...(state.showMaskFlags ? maskLayout.shapes : []),
      ],
      annotations: [
        ...bstOffLayout.annotations,
        ...reelMarkerLayout.annotations,
        ...(state.showReferenceFlags ? referenceImageLayout.annotations : []),
        ...(state.showMaskFlags ? maskLayout.annotations : []),
      ],
    }), getPlotConfig()).then(() => {
      bindAnnotationClicks(host, referenceImageLayout.clickEvents, maskLayout.clickEvents);
    });
  }

  function buildVisibleMachineStats(machine) {
    const reels = Array.isArray(machine && machine.reels) ? machine.reels : [];
    const points = Array.isArray(machine && machine.points) ? machine.points : [];
    const visibleDefects = points.filter((point) => pointIsVisible(point));
    const visibleReelIds = new Set(visibleDefects.map((point) => String(point && point.reelId || "")).filter(Boolean));
    const visibleJobs = new Set(
      reels
        .filter((reel) => visibleReelIds.has(String(reel && reel.reelId || "")))
        .map((reel) => formatJobLabel(reel && reel.jobName, reel && reel.orderNumber))
    );
    return {
      reelCount: visibleReelIds.size || reels.length,
      defectCount: visibleDefects.length,
      jobCount: visibleJobs.size || new Set(reels.map((reel) => formatJobLabel(reel && reel.jobName, reel && reel.orderNumber))).size,
    };
  }

  function renderMachineTimeline(machine) {
    const target = document.getElementById(`defectMachineTimeline-${machine.machineId}`);
    if (!target) return;
    const segments = buildMachineTimelineSegments(machine);
    if (!segments.length) {
      target.innerHTML = '<div class="delta-machine-panel__timeline-empty">No job timeline data</div>';
      return;
    }
    const totalSpan = Math.max(getMachineFeetSpan(machine), 1);
    target.innerHTML = segments
      .map((segment) => {
        const leftPct = (segment.xStart / totalSpan) * 100;
        const widthPct = Math.max(((segment.xEnd - segment.xStart) / totalSpan) * 100, 1);
        const color = colorForJob(segment.jobLabel);
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
              <div class="delta-machine-panel__timeline-tooltip-time">${escapeHtml(segment.reelLabel)}</div>
              <div class="delta-machine-panel__timeline-tooltip-grid">
                <div class="delta-machine-panel__timeline-tooltip-metric">
                  <span>Reels</span>
                  <strong>${escapeHtml(formatNumber(segment.reelCount, 0))}</strong>
                </div>
                <div class="delta-machine-panel__timeline-tooltip-metric">
                  <span>Feet</span>
                  <strong>${escapeHtml(formatNumber(segment.xEnd - segment.xStart, 0))}</strong>
                </div>
                <div class="delta-machine-panel__timeline-tooltip-metric">
                  <span>Defects</span>
                  <strong>${escapeHtml(formatNumber(segment.defectCount, 0))}</strong>
                </div>
              </div>
            </div>
          </div>`;
      })
      .join("");
  }

  function buildMachineTimelineSegments(machine) {
    const reels = Array.isArray(machine && machine.reels) ? [...machine.reels] : [];
    if (!reels.length) return [];
    reels.sort((a, b) => {
      const at = a && a.timeStart ? new Date(a.timeStart).getTime() : 0;
      const bt = b && b.timeStart ? new Date(b.timeStart).getTime() : 0;
      return at - bt || Number(a.reelId || 0) - Number(b.reelId || 0);
    });
    let cursor = 0;
    const segments = [];
    let current = null;
    reels.forEach((reel) => {
      const feet = Math.max(Number(reel && reel.reelFeetTotal) || 0, 0);
      const jobLabel = formatJobLabel(reel && reel.jobName, reel && reel.orderNumber);
      const defectCount = countVisibleDefectsForReel(machine, reel && reel.reelId);
      if (!current || current.jobLabel !== jobLabel) {
        if (current) segments.push(current);
        current = {
          jobLabel,
          xStart: cursor,
          xEnd: cursor + feet,
          reelCount: 1,
          defectCount,
          reelCodes: [reel && reel.reelCode ? reel.reelCode : "Unknown Reel"],
        };
      } else {
        current.xEnd += feet;
        current.reelCount += 1;
        current.defectCount += defectCount;
        current.reelCodes.push(reel && reel.reelCode ? reel.reelCode : "Unknown Reel");
      }
      cursor += feet;
    });
    if (current) segments.push(current);
    return segments.map((segment) => ({
      ...segment,
      reelLabel: segment.reelCodes.length > 2
        ? `${segment.reelCodes[0]} - ${segment.reelCodes[segment.reelCodes.length - 1]}`
        : segment.reelCodes.join(", "),
    }));
  }

  function syncMachineScroll(machineId) {
    const timelineScroll = document.querySelector(`[data-machine-scroll="timeline-${machineId}"]`);
    const chartScroll = document.querySelector(`[data-machine-scroll="chart-${machineId}"]`);
    if (!timelineScroll || !chartScroll) return;
    let syncing = false;
    const mirror = (source, target) => {
      source.addEventListener("scroll", () => {
        if (syncing) return;
        syncing = true;
        target.scrollLeft = source.scrollLeft;
        if (source === chartScroll && !machineScrollSyncing) {
          syncAllMachineCharts(chartScroll);
        }
        window.requestAnimationFrame(() => {
          syncing = false;
        });
      });
    };
    mirror(timelineScroll, chartScroll);
    mirror(chartScroll, timelineScroll);
  }

  function syncAllMachineCharts(sourceScroll) {
    if (!sourceScroll || machineScrollSyncing) return;
    const baselineSpan = Math.max(Number(sourceScroll.dataset.baselineSpan) || 0, 1);
    const sourceClientWidth = sourceScroll.clientWidth || 1;
    const axisOffset = (sourceScroll.scrollLeft / sourceClientWidth) * baselineSpan;
    machineScrollSyncing = true;
    document.querySelectorAll('.delta-machine-panel__chart-scroll[data-machine-scroll^="chart-"]').forEach((targetScroll) => {
      if (targetScroll === sourceScroll) return;
      const targetAxisSpan = Math.max(Number(targetScroll.dataset.axisSpan) || 0, 1);
      const targetBaselineSpan = Math.max(Number(targetScroll.dataset.baselineSpan) || 0, baselineSpan, 1);
      const targetClientWidth = targetScroll.clientWidth || 1;
      const maxAxisOffset = Math.max(targetAxisSpan - targetBaselineSpan, 0);
      const clampedAxisOffset = Math.max(0, Math.min(axisOffset, maxAxisOffset));
      const nextScrollLeft = (clampedAxisOffset / targetBaselineSpan) * targetClientWidth;
      targetScroll.scrollLeft = nextScrollLeft;
      const targetTimeline = document.querySelector(`[data-machine-scroll="timeline-${targetScroll.dataset.machineId}"]`);
      if (targetTimeline) targetTimeline.scrollLeft = nextScrollLeft;
    });
    window.requestAnimationFrame(() => {
      machineScrollSyncing = false;
    });
  }

  function setInitialMachineScrollOffset(axisOffset) {
    const targetOffset = Math.max(Number(axisOffset) || 0, 0);
    machineScrollSyncing = true;
    document.querySelectorAll('.delta-machine-panel__chart-scroll[data-machine-scroll^="chart-"]').forEach((chartScroll) => {
      const axisSpan = Math.max(Number(chartScroll.dataset.axisSpan) || 0, 0);
      const baselineSpan = Math.max(Number(chartScroll.dataset.baselineSpan) || 0, 1);
      const clientWidth = chartScroll.clientWidth || 1;
      const maxAxisOffset = Math.max(axisSpan - baselineSpan, 0);
      const clampedAxisOffset = Math.max(0, Math.min(targetOffset, maxAxisOffset));
      const nextScrollLeft = (clampedAxisOffset / baselineSpan) * clientWidth;
      chartScroll.scrollLeft = nextScrollLeft;
      const timelineScroll = document.querySelector(`[data-machine-scroll="timeline-${chartScroll.dataset.machineId}"]`);
      if (timelineScroll) timelineScroll.scrollLeft = nextScrollLeft;
    });
    window.requestAnimationFrame(() => {
      machineScrollSyncing = false;
    });
  }

  function getMachineFeetSpan(machine) {
    const reels = Array.isArray(machine && machine.reels) ? machine.reels : [];
    const total = reels.reduce((sum, reel) => {
      const feet = Number(reel && reel.reelFeetTotal);
      return sum + (Number.isFinite(feet) ? feet : 0);
    }, 0);
    return total > 0 ? total : 0;
  }

  function formatScrollScalePercent(span, baselineSpan) {
    const current = Math.max(Number(span) || 0, 1);
    const baseline = Math.max(Number(baselineSpan) || 0, 1);
    const ratio = current / baseline;
    return Math.max(100, Math.round(ratio * 100));
  }

  function buildMachineSeries(machine) {
    const reels = Array.isArray(machine.reels) ? [...machine.reels] : [];
    const points = Array.isArray(machine.points) ? machine.points : [];
    const pointsByReel = new Map();
    points.forEach((point) => {
      const reelId = String(point.reelId || "");
      if (!reelId) return;
      if (!pointsByReel.has(reelId)) pointsByReel.set(reelId, []);
      pointsByReel.get(reelId).push(point);
    });
    reels.sort((a, b) => {
      const at = a && a.timeStart ? new Date(a.timeStart).getTime() : 0;
      const bt = b && b.timeStart ? new Date(b.timeStart).getTime() : 0;
      return at - bt || Number(a.reelId || 0) - Number(b.reelId || 0);
    });
    let cumulativeFeet = 0;
    const x = [];
    const severity = [];
    const speedX = [];
    const speedValues = [];
    const hoverX = [];
    const hoverSeverity = [];
    const severityHover = [];

    reels.forEach((reel, index) => {
      const reelId = String(reel.reelId || "");
      const reelPoints = (pointsByReel.get(reelId) || [])
        .slice()
        .sort((a, b) => {
          const af = Number(a && a.feetFromReelStart);
          const bf = Number(b && b.feetFromReelStart);
          if (Number.isFinite(af) && Number.isFinite(bf) && af !== bf) return af - bf;
          const at = a && a.time ? new Date(a.time).getTime() : 0;
          const bt = b && b.time ? new Date(b.time).getTime() : 0;
          return at - bt || Number(a.defectId || 0) - Number(b.defectId || 0);
        });
      if (!reelPoints.length) {
        cumulativeFeet += Number(reel && reel.reelFeetTotal) || 0;
        return;
      }
      reelPoints.forEach((point) => {
        const localFeet = Number(point && point.feetFromReelStart);
        const xValue = cumulativeFeet + (Number.isFinite(localFeet) ? localFeet : 0);
        const visible = pointIsVisible(point);
        const severityValue = visible ? valueOrNull(point && point.severityValue) : 0;
        x.push(xValue);
        severity.push(0);
        x.push(xValue);
        severity.push(severityValue);
        x.push(xValue);
        severity.push(0);
        if (visible) {
          severityHover.push(buildHoverText(point, "Severity Value", point && point.severityValue));
          hoverX.push(xValue);
          hoverSeverity.push(valueOrNull(point && point.severityValue));
        }
        speedX.push(xValue);
        speedValues.push(valueOrNull(point && point.webspeed));
      });
      if (index < reels.length - 1) {
        x.push(null);
        severity.push(null);
        speedX.push(null);
        speedValues.push(null);
      }
      cumulativeFeet += Number.isFinite(reelFeetValue(reel, reelPoints[reelPoints.length - 1]))
        ? reelFeetValue(reel, reelPoints[reelPoints.length - 1])
        : 0;
    });

    return { x, severity, speedX, speedValues, hoverX, hoverSeverity, severityHover };
  }

  function buildBinnedMachineSeries(machine) {
    const reels = Array.isArray(machine && machine.reels) ? [...machine.reels] : [];
    const points = Array.isArray(machine && machine.points) ? machine.points : [];
    const pointsByReel = new Map();
    points.forEach((point) => {
      const reelId = String(point && point.reelId || "");
      if (!reelId) return;
      if (!pointsByReel.has(reelId)) pointsByReel.set(reelId, []);
      pointsByReel.get(reelId).push(point);
    });
    reels.sort((a, b) => {
      const at = a && a.timeStart ? new Date(a.timeStart).getTime() : 0;
      const bt = b && b.timeStart ? new Date(b.timeStart).getTime() : 0;
      return at - bt || Number(a.reelId || 0) - Number(b.reelId || 0);
    });
    const totalSpan = Math.max(getMachineFeetSpan(machine), 0);
    const binSize = Math.max(Number(state.binSizeFeet) || 25, 1);
    const binCounts = new Map();
    const speedBinStats = new Map();
    const reelSpans = [];
    let cumulativeFeet = 0;

    reels.forEach((reel, index) => {
      const reelId = String(reel && reel.reelId || "");
      const reelPoints = (pointsByReel.get(reelId) || [])
        .slice()
        .sort((a, b) => {
          const af = Number(a && a.feetFromReelStart);
          const bf = Number(b && b.feetFromReelStart);
          if (Number.isFinite(af) && Number.isFinite(bf) && af !== bf) return af - bf;
          const at = a && a.time ? new Date(a.time).getTime() : 0;
          const bt = b && b.time ? new Date(b.time).getTime() : 0;
          return at - bt || Number(a.defectId || 0) - Number(b.defectId || 0);
        });
      const cumulativeVisibleByLocalBin = new Map();
      let visibleReelDefectCount = 0;
      const reelSpanFeet = Number.isFinite(reelFeetValue(reel, reelPoints[reelPoints.length - 1]))
        ? reelFeetValue(reel, reelPoints[reelPoints.length - 1])
        : Math.max(Number(reel && reel.reelFeetTotal) || 0, 0);
      reelSpans.push({
        xStart: cumulativeFeet,
        xEnd: cumulativeFeet + Math.max(reelSpanFeet, 0),
        reelCode: reel && reel.reelCode ? reel.reelCode : "Unknown Reel",
        jobLabel: formatJobLabel(reel && reel.jobName, reel && reel.orderNumber),
        visibleReelDefectCount,
        cumulativeVisibleByLocalBin,
      });
      reelPoints.forEach((point) => {
        const localFeet = Number(point && point.feetFromReelStart);
        const xValue = cumulativeFeet + (Number.isFinite(localFeet) ? localFeet : 0);
        if (pointIsVisible(point)) {
          visibleReelDefectCount += 1;
          const localBinStart = Math.floor(Math.max(Number.isFinite(localFeet) ? localFeet : 0, 0) / binSize) * binSize;
          cumulativeVisibleByLocalBin.set(localBinStart, visibleReelDefectCount);
          const binStart = Math.floor(Math.max(xValue, 0) / binSize) * binSize;
          binCounts.set(binStart, (binCounts.get(binStart) || 0) + 1);
        }
      });
      reelSpans[reelSpans.length - 1].visibleReelDefectCount = visibleReelDefectCount;
      cumulativeFeet += Number.isFinite(reelFeetValue(reel, reelPoints[reelPoints.length - 1]))
        ? reelFeetValue(reel, reelPoints[reelPoints.length - 1])
        : 0;
    });

    const speedSeries = buildMachineSpeedSeries(machine);
    speedSeries.deltaEntries.forEach((entry) => {
      const xValue = Number(entry && entry.x);
      const speedDelta = Number(entry && entry.speedDelta);
      if (!Number.isFinite(xValue) || !Number.isFinite(speedDelta)) return;
      const binStart = Math.floor(Math.max(xValue, 0) / binSize) * binSize;
      const current = speedBinStats.get(binStart) || { sum: 0, count: 0 };
      current.sum += speedDelta;
      current.count += 1;
      speedBinStats.set(binStart, current);
    });

    const maxFeet = Math.max(totalSpan, ...Array.from(binCounts.keys(), (value) => Number(value) || 0), 0);
    const x = [];
    const defectCounts = [];
    const hoverX = [];
    const hoverCounts = [];
    const binHover = [];
    for (let binStart = 0; binStart <= maxFeet; binStart += binSize) {
      const count = binCounts.get(binStart) || 0;
      const reelContext = resolveReelContextForBin(reelSpans, binStart, binSize);
      const speedStat = speedBinStats.get(binStart);
      const avgSpeedDelta = speedStat && speedStat.count ? speedStat.sum / speedStat.count : null;
      x.push(binStart);
      defectCounts.push(count);
      hoverX.push(binStart);
      hoverCounts.push(count);
      binHover.push(buildBinHoverText(machine, binStart, binSize, count, maxFeet, reelContext, avgSpeedDelta));
    }

    return { x, defectCounts, hoverX, hoverCounts, binHover };
  }

  function buildMachineSpeedSeries(machine) {
    const reels = Array.isArray(machine && machine.reels) ? [...machine.reels] : [];
    const speedPoints = Array.isArray(machine && machine.speedPoints) ? machine.speedPoints : [];
    const speedPointsByReel = new Map();
    speedPoints.forEach((point) => {
      const reelId = String(point && point.reelId || "");
      if (!reelId) return;
      if (!speedPointsByReel.has(reelId)) speedPointsByReel.set(reelId, []);
      speedPointsByReel.get(reelId).push(point);
    });
    reels.sort((a, b) => {
      const at = a && a.timeStart ? new Date(a.timeStart).getTime() : 0;
      const bt = b && b.timeStart ? new Date(b.timeStart).getTime() : 0;
      return at - bt || Number(a.reelId || 0) - Number(b.reelId || 0);
    });
    let cumulativeFeet = 0;
    const solidX = [];
    const solidY = [];
    const dashedX = [];
    const dashedY = [];
    const deltaEntries = [];
    let lastKnownDelta = null;

    reels.forEach((reel, index) => {
      const reelId = String(reel && reel.reelId || "");
      const reelSpeedPoints = (speedPointsByReel.get(reelId) || [])
        .slice()
        .sort((a, b) => {
          const af = Number(a && a.feetFromReelStart);
          const bf = Number(b && b.feetFromReelStart);
          if (Number.isFinite(af) && Number.isFinite(bf) && af !== bf) return af - bf;
          const at = a && a.time ? new Date(a.time).getTime() : 0;
          const bt = b && b.time ? new Date(b.time).getTime() : 0;
          return at - bt;
        });
      let previousSpeed = null;
      let reelDeltaCount = 0;
      reelSpeedPoints.forEach((point) => {
        const localFeet = Number(point && point.feetFromReelStart);
        const xValue = cumulativeFeet + (Number.isFinite(localFeet) ? localFeet : 0);
        const parsedSpeed = valueOrNull(point && point.webspeed);
        const webspeed = Number.isFinite(Number(parsedSpeed)) ? parsedSpeed : previousSpeed;
        if (Number.isFinite(Number(webspeed)) && Number.isFinite(Number(previousSpeed))) {
          const speedDelta = webspeed - previousSpeed;
          solidX.push(xValue);
          solidY.push(speedDelta);
          deltaEntries.push({ x: xValue, speedDelta });
          lastKnownDelta = speedDelta;
          reelDeltaCount += 1;
        }
        previousSpeed = webspeed;
      });
      const reelSpanFeet = Number.isFinite(reelFeetValue(reel, reelSpeedPoints[reelSpeedPoints.length - 1]))
        ? reelFeetValue(reel, reelSpeedPoints[reelSpeedPoints.length - 1])
        : Number(reel && reel.reelFeetTotal) || 0;
      if (reelDeltaCount === 0 && Number.isFinite(Number(lastKnownDelta)) && reelSpanFeet > 0) {
        dashedX.push(cumulativeFeet);
        dashedY.push(lastKnownDelta);
        dashedX.push(cumulativeFeet + reelSpanFeet);
        dashedY.push(lastKnownDelta);
        dashedX.push(null);
        dashedY.push(null);
      }
      if (index < reels.length - 1 && reelSpeedPoints.length) {
        solidX.push(null);
        solidY.push(null);
      }
      cumulativeFeet += reelSpanFeet;
    });

    return { solidX, solidY, dashedX, dashedY, deltaEntries };
  }

  function resolveReelContextForBin(reelSpans, binStart, binSize) {
    if (!Array.isArray(reelSpans) || !reelSpans.length) return null;
    const probe = binStart + (binSize / 2);
    return reelSpans.find((span) => probe >= span.xStart && probe < span.xEnd)
      || reelSpans.find((span) => binStart >= span.xStart && binStart < span.xEnd)
      || reelSpans[reelSpans.length - 1]
      || null;
  }

  function buildBinHoverText(machine, binStart, binSize, defectCount, maxFeet, reelContext, avgSpeedDelta) {
    const rangeEnd = Math.min(binStart + binSize, Math.max(maxFeet, binStart + binSize));
    const reelCumulativeDefects = resolveReelCumulativeDefects(reelContext, binStart, binSize);
    const parts = [
      `<b>${escapeHtml(machine && machine.machineName || "")}</b>`,
      `Job: ${escapeHtml(reelContext && reelContext.jobLabel ? reelContext.jobLabel : "--")}`,
      `Reel: ${escapeHtml(reelContext && reelContext.reelCode ? reelContext.reelCode : "--")}`,
      `Speed delta: ${Number.isFinite(Number(avgSpeedDelta)) ? escapeHtml(formatSignedNumber(avgSpeedDelta, 3)) : "--"}`,
      `Feet bin: ${escapeHtml(formatNumber(binStart, 0))}–${escapeHtml(formatNumber(rangeEnd, 0))} ft`,
      `Defect count: ${escapeHtml(formatNumber(defectCount, 0))}`,
      `Reel cumulative defects: ${escapeHtml(formatNumber(reelCumulativeDefects, 0))}`,
    ];
    return parts.join("<br>");
  }

  function resolveReelCumulativeDefects(reelContext, globalBinStart, binSize) {
    if (!reelContext) return 0;
    const localBinStart = Math.floor(Math.max((Number(globalBinStart) || 0) - (Number(reelContext.xStart) || 0), 0) / binSize) * binSize;
    const cumulativeMap = reelContext.cumulativeVisibleByLocalBin;
    if (!(cumulativeMap instanceof Map) || !cumulativeMap.size) return 0;
    let cumulativeCount = 0;
    cumulativeMap.forEach((count, binStart) => {
      if (Number(binStart) <= localBinStart) {
        cumulativeCount = Math.max(cumulativeCount, Number(count) || 0);
      }
    });
    return cumulativeCount;
  }

  function reelFeetValue(reel, point) {
    const reelFeet = Number(point && point.reelFeetTotal);
    if (Number.isFinite(reelFeet)) return reelFeet;
    const fallback = Number(reel && reel.reelFeetTotal);
    return Number.isFinite(fallback) ? fallback : 0;
  }

  function buildHoverText(point, metricLabel, metricValue) {
    if (!point) return "";
    const reelFeet = Number(point.feetFromReelStart);
    const reelFeetTotal = Number(point.reelFeetTotal);
    const webspeed = Number(point.webspeed);
    const parts = [
      `<b>${escapeHtml(point.machineName || "")}</b>`,
      `Job: ${escapeHtml(formatJobLabel(point.jobName, point.orderNumber))}`,
      `Reel: ${escapeHtml(point.reelCode || "Unknown Reel")}`,
      `Time: ${escapeHtml(formatDateTimeLabel(point.time))}`,
    ];
    if (Number.isFinite(reelFeet) || Number.isFinite(reelFeetTotal)) {
      const currentFeet = Number.isFinite(reelFeet) ? formatNumber(reelFeet, 1) : "—";
      const totalFeet = Number.isFinite(reelFeetTotal) ? formatNumber(reelFeetTotal, 1) : "—";
      parts.push(`Reel feet: ${currentFeet} / ${totalFeet} ft`);
    }
    if (Number.isFinite(webspeed)) {
      parts.push(`Web speed: ${formatNumber(webspeed, 3)}`);
    }
    parts.push(`Severity: ${formatMetric(point.severityValue)}`);
    if (metricLabel) {
      parts.push(`${escapeHtml(metricLabel)}: ${formatMetric(metricValue)}`);
    }
    return parts.join("<br>");
  }

  function buildChartLayout({ xTitle, yTitle, xRange, xDtick, yRange, showLegend, shapes, annotations }) {
    const isDark = document.body.classList.contains("dark-mode");
    const textColor = readThemeColor("--text-primary", isDark ? "#e2e8f0" : "#0f172a");
    const gridColor = isDark ? "rgba(148, 163, 184, 0.16)" : "rgba(148, 163, 184, 0.18)";
    const zeroLineColor = isDark ? "rgba(148, 163, 184, 0.24)" : "rgba(100, 116, 139, 0.24)";
    const hoverBg = readThemeColor("--surface", isDark ? "#0f172a" : "#ffffff");
    const hoverBorder = readThemeColor("--border", isDark ? "#334155" : "#cbd5e1");
    return {
      title: "",
      autosize: true,
      paper_bgcolor: "transparent",
      plot_bgcolor: "transparent",
      margin: { t: 24, r: 24, b: 68, l: 58 },
      showlegend: !!showLegend,
      legend: {
        orientation: "h",
        x: 0,
        y: 1.16,
        font: { color: textColor },
      },
      shapes: Array.isArray(shapes) ? shapes : [],
      annotations: Array.isArray(annotations) ? annotations : [],
      hoverlabel: {
        bgcolor: hoverBg,
        bordercolor: hoverBorder,
        font: { color: textColor },
      },
      xaxis: {
        title: xTitle,
        automargin: true,
        color: textColor,
        gridcolor: gridColor,
        zerolinecolor: zeroLineColor,
        tick0: 0,
        dtick: xDtick || 5000,
        range: xRange || undefined,
      },
      yaxis: {
        title: yTitle,
        automargin: true,
        color: textColor,
        gridcolor: gridColor,
        zerolinecolor: zeroLineColor,
        range: yRange || undefined,
      },
    };
  }

  function resolveYRangeFromValues(valuesInput) {
    const values = [];
    (Array.isArray(valuesInput) ? valuesInput : []).forEach((value) => {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) values.push(numeric);
    });
    if (!values.length) {
      if (state.yMin !== null && state.yMax !== null) return [state.yMin, state.yMax];
      return null;
    }
    let min = values[0];
    let max = values[0];
    values.forEach((value) => {
      if (value < min) min = value;
      if (value > max) max = value;
    });
    const span = Math.max(max - min, 1);
    const padding = span * 0.08;
    const resolvedMin = state.yMin !== null ? state.yMin : min - padding;
    const resolvedMax = state.yMax !== null ? state.yMax : max + padding;
    return [resolvedMin, resolvedMax];
  }

  function resolveFullXRangeFromTraces(traces) {
    const values = [];
    (Array.isArray(traces) ? traces : []).forEach((trace) => {
      (trace && Array.isArray(trace.x) ? trace.x : []).forEach((value) => {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) values.push(numeric);
      });
    });
    if (!values.length) return null;
    let max = values[0];
    values.forEach((value) => {
      if (value > max) max = value;
    });
    return [0, max];
  }


  function scaleSeriesToBottomBand(valuesInput, yRange, pct = 0.2) {
    const values = Array.isArray(valuesInput) ? valuesInput : [];
    if (!Array.isArray(yRange) || yRange.length < 2) {
      return values.map((value) => valueOrNull(value));
    }
    const numericValues = values
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));
    if (!numericValues.length) {
      return values.map(() => null);
    }
    let min = numericValues[0];
    let max = numericValues[0];
    numericValues.forEach((value) => {
      if (value < min) min = value;
      if (value > max) max = value;
    });
    const chartMin = Number(yRange[0]);
    const chartMax = Number(yRange[1]);
    const bandHeight = (chartMax - chartMin) * pct;
    const bandTop = chartMin + bandHeight;
    const span = max - min;
    return values.map((value) => {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return null;
      if (span <= 0) return chartMin + bandHeight / 2;
      return chartMin + ((numeric - min) / span) * (bandTop - chartMin);
    });
  }

  function scaleSeriesToTopBand(valuesInput, yRange, pct = 0.25) {
    const values = Array.isArray(valuesInput) ? valuesInput : [];
    if (!Array.isArray(yRange) || yRange.length < 2) {
      return values.map((value) => valueOrNull(value));
    }
    const numericValues = values
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));
    if (!numericValues.length) {
      return values.map(() => null);
    }
    const sorted = [...numericValues].sort((left, right) => left - right);
    const percentile = (ratio) => {
      if (!sorted.length) return null;
      const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)));
      return sorted[index];
    };
    let min = percentile(0.1);
    let max = percentile(0.9);
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
      min = sorted[0];
      max = sorted[sorted.length - 1];
    }
    const chartMin = Number(yRange[0]);
    const chartMax = Number(yRange[1]);
    const bandHeight = (chartMax - chartMin) * pct;
    const bandBottom = chartMax - bandHeight;
    const bandTop = chartMax - (bandHeight * 0.12);
    const span = max - min;
    return values.map((value) => {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return null;
      if (span <= 0) return bandBottom + ((bandTop - bandBottom) / 2);
      const clamped = Math.max(min, Math.min(max, numeric));
      return bandBottom + ((clamped - min) / span) * (bandTop - bandBottom);
    });
  }

  function scaleFixedSpeedDeltaToTopBand(valuesInput, yRange, pct = 0.3, limit = 5) {
    const values = Array.isArray(valuesInput) ? valuesInput : [];
    if (!Array.isArray(yRange) || yRange.length < 2) {
      return values.map((value) => valueOrNull(value));
    }
    const chartMin = Number(yRange[0]);
    const chartMax = Number(yRange[1]);
    const bandHeight = (chartMax - chartMin) * pct;
    const bandBottom = chartMax - bandHeight;
    const bandTop = chartMax;
    const safeLimit = Math.max(Number(limit) || 0, 0.001);
    return values.map((value) => {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return null;
      const clamped = Math.max(-safeLimit, Math.min(safeLimit, numeric));
      const normalized = (clamped + safeLimit) / (safeLimit * 2);
      return bandBottom + normalized * (bandTop - bandBottom);
    });
  }

  function pointIsVisible(point) {
    if (state.showImageDefects) return !!(point && point.imageSrc);
    return true;
  }

  function buildBstOffLayout(machine) {
    const reels = Array.isArray(machine && machine.reels) ? [...machine.reels] : [];
    reels.sort((a, b) => {
      const at = a && a.timeStart ? new Date(a.timeStart).getTime() : 0;
      const bt = b && b.timeStart ? new Date(b.timeStart).getTime() : 0;
      return at - bt || Number(a.reelId || 0) - Number(b.reelId || 0);
    });
    let cumulativeFeet = 0;
    const shapes = [];
    const annotations = [];
    reels.forEach((reel) => {
      const segments = Array.isArray(reel && reel.bstOffSegments) ? reel.bstOffSegments : [];
      segments.forEach((segment) => {
        const startFeet = Number(segment && segment.startFeet);
        const endFeet = Number(segment && segment.endFeet);
        if (!Number.isFinite(startFeet) || !Number.isFinite(endFeet) || endFeet <= startFeet) return;
        const xStart = cumulativeFeet + startFeet;
        const xEnd = cumulativeFeet + endFeet;
        shapes.push({
          type: "rect",
          xref: "x",
          yref: "paper",
          x0: xStart,
          x1: xEnd,
          y0: 0,
          y1: 1,
          fillcolor: "rgba(220, 38, 38, 0.14)",
          line: {
            color: "rgba(220, 38, 38, 0.5)",
            width: 1,
          },
          layer: "below",
        });
        annotations.push({
          xref: "x",
          yref: "paper",
          x: (xStart + xEnd) / 2,
          y: BST_OFF_ANNOTATION_Y,
          text: `BST Off<br>${escapeHtml(reel && reel.reelCode ? reel.reelCode : "Unknown Reel")}`,
          showarrow: false,
          font: { size: 11, color: "rgba(153, 27, 27, 1)" },
          bgcolor: "rgba(255,255,255,0.82)",
          bordercolor: "rgba(220, 38, 38, 0.28)",
          borderwidth: 1,
          borderpad: 3,
        });
      });
      cumulativeFeet += Number(reel && reel.reelFeetTotal) || 0;
    });
    return { shapes, annotations };
  }

  function buildReelMarkerShapes(machine) {
    return buildReelMarkerLayout(machine).shapes;
  }

  function buildReelMarkerLayout(machine) {
    const reels = Array.isArray(machine && machine.reels) ? [...machine.reels] : [];
    reels.sort((a, b) => {
      const at = a && a.timeStart ? new Date(a.timeStart).getTime() : 0;
      const bt = b && b.timeStart ? new Date(b.timeStart).getTime() : 0;
      return at - bt || Number(a.reelId || 0) - Number(b.reelId || 0);
    });
    let cumulativeFeet = 0;
    const shapes = [];
    const annotations = [];
    reels.forEach((reel, index) => {
      if (index > 0) {
        shapes.push({
          type: "line",
          xref: "x",
          yref: "paper",
          x0: cumulativeFeet,
          x1: cumulativeFeet,
          y0: 0,
          y1: 1,
          line: {
            color: "rgba(59, 130, 246, 0.82)",
            width: 2,
            dash: "2px,10px",
          },
        });
        annotations.push({
          xref: "x",
          yref: "paper",
          x: cumulativeFeet,
          y: REEL_CHANGE_ANNOTATION_Y,
          text: `New<br>Reel`,
          showarrow: false,
          font: { size: 10, color: "rgba(30, 64, 175, 1)" },
          bgcolor: "rgba(255,255,255,0.9)",
          bordercolor: "rgba(59, 130, 246, 0.32)",
          borderwidth: 1,
          borderpad: 2,
          hovertext: [
            `New reel: ${escapeHtml(reel && reel.reelCode ? reel.reelCode : "Unknown Reel")}`,
            `Job: ${escapeHtml(formatJobLabel(reel && reel.jobName, reel && reel.orderNumber))}`,
            `Start: ${escapeHtml(formatDateTimeLabel(reel && reel.timeStart))}`,
          ].join("<br>"),
        });
      }
      cumulativeFeet += Number(reel && reel.reelFeetTotal) || 0;
    });
    return { shapes, annotations };
  }

  function buildReferenceImageChangeLayout(machine) {
    const reels = Array.isArray(machine && machine.reels) ? [...machine.reels] : [];
    const events = Array.isArray(machine && machine.referenceImageEvents) ? machine.referenceImageEvents : [];
    if (!reels.length || !events.length) return { shapes: [], annotations: [], clickEvents: [] };
    reels.sort((a, b) => {
      const at = a && a.timeStart ? new Date(a.timeStart).getTime() : 0;
      const bt = b && b.timeStart ? new Date(b.timeStart).getTime() : 0;
      return at - bt || Number(a.reelId || 0) - Number(b.reelId || 0);
    });
    const baseFeetByReel = new Map();
    let cumulativeFeet = 0;
    reels.forEach((reel) => {
      baseFeetByReel.set(String(reel && reel.reelId || ""), cumulativeFeet);
      cumulativeFeet += Number(reel && reel.reelFeetTotal) || 0;
    });
    const shapes = [];
    const annotations = [];
    const clickEvents = [];
    events.forEach((event) => {
      const reelKey = String(event && event.reelId || "");
      if (!reelKey || !baseFeetByReel.has(reelKey)) return;
      const localFeet = Number(event && event.feetFromReelStart);
      if (!Number.isFinite(localFeet)) return;
      const xValue = baseFeetByReel.get(reelKey) + localFeet;
      const hoverText = [
        `Ref change: ${escapeHtml(String(event.previousFilename || "--"))} -> ${escapeHtml(String(event.filename || "--"))}`,
        `Job: ${escapeHtml(formatJobLabel(event.jobName, event.orderNumber))}`,
        `Reel: ${escapeHtml(event.reelCode || "Unknown Reel")}`,
        `Time: ${escapeHtml(formatDateTimeLabel(event.time))}`,
      ].join("<br>");
      shapes.push({
        type: "line",
        xref: "x",
        yref: "paper",
        x0: xValue,
        x1: xValue,
        y0: 0,
        y1: 1,
        line: {
          color: "rgba(245, 158, 11, 0.9)",
          width: 2,
        },
      });
      annotations.push({
        xref: "x",
        yref: "paper",
        x: xValue,
        y: REFERENCE_CHANGE_ANNOTATION_Y,
        yanchor: "middle",
        text: "New<br>Ref",
        captureevents: true,
        showarrow: false,
        font: { size: 10, color: "#92400e" },
        bgcolor: "rgba(255,255,255,0.92)",
        bordercolor: "rgba(245, 158, 11, 0.35)",
        borderwidth: 1,
        borderpad: 2,
        hovertext: hoverText,
        hoverlabel: {
          bgcolor: "#ffffff",
          bordercolor: "rgba(245, 158, 11, 0.35)",
          font: { color: "#111827" },
        },
      });
      clickEvents.push({
        xValue,
        detail: event,
      });
    });
    return { shapes, annotations, clickEvents };
  }

  function bindAnnotationClicks(host, referenceClickEvents, maskClickEvents) {
    if (!host || typeof host.on !== "function") return;
    host.removeAllListeners?.("plotly_clickannotation");
    host.on("plotly_clickannotation", (payload) => {
      const annotation = payload && payload.annotation ? payload.annotation : null;
      if (!annotation) return;
      if (annotation.text === "New<br>Ref") {
        const match = findAnnotationClickEvent(annotation, referenceClickEvents);
        if (match && match.detail) {
          openReferenceViewer(match.detail);
          return;
        }
      }
      if (annotation.text === "Mask<br>Chg") {
        const match = findAnnotationClickEvent(annotation, maskClickEvents);
        if (match && match.detail) {
          openMaskViewer(match.detail);
        }
      }
    });
  }

  function buildMaskChangeLayout(machine) {
    const reels = Array.isArray(machine && machine.reels) ? [...machine.reels] : [];
    const events = Array.isArray(machine && machine.maskEvents) ? machine.maskEvents : [];
    if (!reels.length || !events.length) return { shapes: [], annotations: [], clickEvents: [] };
    reels.sort((a, b) => {
      const at = a && a.timeStart ? new Date(a.timeStart).getTime() : 0;
      const bt = b && b.timeStart ? new Date(b.timeStart).getTime() : 0;
      return at - bt || Number(a.reelId || 0) - Number(b.reelId || 0);
    });
    const baseFeetByReel = new Map();
    let cumulativeFeet = 0;
    reels.forEach((reel) => {
      baseFeetByReel.set(String(reel && reel.reelId || ""), cumulativeFeet);
      cumulativeFeet += Number(reel && reel.reelFeetTotal) || 0;
    });
    const shapes = [];
    const annotations = [];
    const clickEvents = [];
    events.forEach((event) => {
      const reelKey = String(event && event.reelId || "");
      if (!reelKey || !baseFeetByReel.has(reelKey)) return;
      const localFeet = Number(event && event.feetFromReelStart);
      if (!Number.isFinite(localFeet)) return;
      const xValue = baseFeetByReel.get(reelKey) + localFeet;
      const previousLabel = summarizeMaskCoords(event.previousCoords);
      const currentLabel = summarizeMaskCoords(event.coords);
      const hoverText = [
        `Mask change: ${escapeHtml(previousLabel)} -> ${escapeHtml(currentLabel)}`,
        `Job: ${escapeHtml(formatJobLabel(event.jobName, event.orderNumber))}`,
        `Reel: ${escapeHtml(event.reelCode || "Unknown Reel")}`,
        `Time: ${escapeHtml(formatDateTimeLabel(event.time))}`,
      ].join("<br>");
      shapes.push({
        type: "line",
        xref: "x",
        yref: "paper",
        x0: xValue,
        x1: xValue,
        y0: 0,
        y1: 1,
        line: {
          color: "rgba(16, 185, 129, 0.9)",
          width: 2,
        },
      });
      annotations.push({
        xref: "x",
        yref: "paper",
        x: xValue,
        y: MASK_CHANGE_ANNOTATION_Y,
        yanchor: "middle",
        text: "Mask<br>Chg",
        captureevents: true,
        showarrow: false,
        font: { size: 10, color: "#065f46" },
        bgcolor: "rgba(255,255,255,0.92)",
        bordercolor: "rgba(16, 185, 129, 0.35)",
        borderwidth: 1,
        borderpad: 2,
        hovertext: hoverText,
        hoverlabel: {
          bgcolor: "#ffffff",
          bordercolor: "rgba(16, 185, 129, 0.35)",
          font: { color: "#111827" },
        },
      });
      clickEvents.push({
        xValue,
        detail: event,
      });
    });
    return { shapes, annotations, clickEvents };
  }

  function findAnnotationClickEvent(annotation, clickEvents) {
    const annotationX = Number(annotation && annotation.x);
    if (!Number.isFinite(annotationX)) return null;
    return (Array.isArray(clickEvents) ? clickEvents : []).find((entry) => {
      const xValue = Number(entry && entry.xValue);
      return Number.isFinite(xValue) && Math.abs(xValue - annotationX) < 0.001;
    }) || null;
  }

  function openMaskViewer(detail) {
    if (!detail || typeof window.openFootprintModalContent !== "function") return;
    const content = document.createElement("div");
    content.className = "defect-footprints-inline drivers-mask-footprint-compare";
    content.innerHTML = `
      ${buildMaskViewerPanelHtml("Before", detail.beforeMasks || [], detail)}
      ${buildMaskViewerPanelHtml("After", detail.afterMasks || [], detail)}
    `;
    const subtitle = `${formatJobLabel(detail.jobName, detail.orderNumber)} · ${detail.reelCode || "Reel"}`;
    window.openFootprintModalContent(content, `Mask Change · ${subtitle}`);
  }

  function buildMaskViewerPanelHtml(title, masks, detail) {
    const parsedMasks = Array.isArray(masks) ? masks : [];
    const maskCount = parsedMasks.length;
    return `
      <div class="drivers-mask-viewer__panel">
        <div class="drivers-mask-viewer__panel-header">
          <div>
            <h4>${escapeHtml(title)}</h4>
            <small>${escapeHtml(maskCount ? formatCount(maskCount, "mask") : "No masks")}</small>
          </div>
        </div>
        <div class="drivers-mask-viewer__heatmap">
          ${buildMaskSvgHtml(parsedMasks, detail)}
        </div>
      </div>
    `;
  }

  function buildMaskSvgHtml(masks, detail) {
    const polygons = collectMaskPolygons(masks);
    if (!polygons.length) {
      return "<div class='drivers-empty placeholder'>No masks</div>";
    }
    const formatWidth = Number(detail && detail.formatWidth);
    const formatLength = Number(detail && detail.formatLength);
    const width = Number.isFinite(formatWidth) && formatWidth > 0 ? formatWidth : inferMaskDimension(polygons, "x");
    const length = Number.isFinite(formatLength) && formatLength > 0 ? formatLength : inferMaskDimension(polygons, "y");
    const halfWidth = Math.max(width / 2, 1);
    const halfLength = Math.max(length / 2, 1);
    const viewBox = `${-halfWidth} ${-halfLength} ${halfWidth * 2} ${halfLength * 2}`;
    const polygonMarkup = polygons.map((polygon) => {
      const points = polygon.map((point) => `${point.x},${point.y}`).join(" ");
      return `<polygon points="${escapeAttr(points)}" fill="rgba(16, 185, 129, 0.22)" stroke="rgba(5, 150, 105, 0.92)" stroke-width="${Math.max(width, length) * 0.0035}" />`;
    }).join("");
    return `
      <svg viewBox="${escapeAttr(viewBox)}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" aria-label="${escapeAttr("Mask footprints")}">
        <rect x="${-halfWidth}" y="${-halfLength}" width="${halfWidth * 2}" height="${halfLength * 2}" fill="rgba(248, 250, 252, 0.96)" stroke="rgba(148, 163, 184, 0.55)" stroke-width="${Math.max(width, length) * 0.0025}" rx="${Math.max(width, length) * 0.01}" />
        <line x1="${-halfWidth}" y1="0" x2="${halfWidth}" y2="0" stroke="rgba(148, 163, 184, 0.5)" stroke-width="${Math.max(width, length) * 0.0018}" stroke-dasharray="${Math.max(width, length) * 0.01} ${Math.max(width, length) * 0.01}" />
        <line x1="0" y1="${-halfLength}" x2="0" y2="${halfLength}" stroke="rgba(148, 163, 184, 0.5)" stroke-width="${Math.max(width, length) * 0.0018}" stroke-dasharray="${Math.max(width, length) * 0.01} ${Math.max(width, length) * 0.01}" />
        ${polygonMarkup}
      </svg>
    `;
  }

  function collectMaskPolygons(masks) {
    const polygons = [];
    (Array.isArray(masks) ? masks : []).forEach((mask) => {
      parseMaskCoords(mask && mask.coords).forEach((polygon) => {
        const normalized = polygon.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
        if (normalized.length >= 3) polygons.push(normalized);
      });
    });
    return polygons;
  }

  function inferMaskDimension(polygons, axis) {
    const values = [];
    (Array.isArray(polygons) ? polygons : []).forEach((polygon) => {
      polygon.forEach((point) => {
        const value = Number(axis === "x" ? point.x : point.y);
        if (Number.isFinite(value)) values.push(Math.abs(value));
      });
    });
    if (!values.length) return 100;
    let max = values[0];
    values.forEach((value) => {
      if (value > max) max = value;
    });
    return Math.max(max * 2.2, 100);
  }

  function parseMaskCoords(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) {
      return normalizeArrayCoords(raw);
    }
    const text = String(raw || "").trim();
    if (!text) return [];
    if (/^\s*[\[{]/.test(text)) {
      try {
        const parsed = JSON.parse(text);
        const normalized = normalizeArrayCoords(parsed);
        if (normalized.length) return normalized;
      } catch (error) {
        // ignore parse failures and fall through to text parsing
      }
    }
    const segments = text.split(/\|+/).map((segment) => segment.trim()).filter(Boolean);
    if (!segments.length) segments.push(text);
    const polygons = [];
    segments.forEach((segment) => {
      const pairs = [];
      const pairRegex = /(-?\d+(?:\.\d+)?)\s*(?:,|:|;|\s)\s*(-?\d+(?:\.\d+)?)/g;
      let match;
      while ((match = pairRegex.exec(segment)) !== null) {
        const x = Number(match[1]);
        const y = Number(match[2]);
        if (Number.isFinite(x) && Number.isFinite(y)) pairs.push({ x, y });
      }
      if (pairs.length >= 3) {
        polygons.push(pairs);
        return;
      }
      if (pairs.length === 2) {
        const [p1, p2] = pairs;
        polygons.push([
          { x: p1.x, y: p1.y },
          { x: p2.x, y: p1.y },
          { x: p2.x, y: p2.y },
          { x: p1.x, y: p2.y },
        ]);
        return;
      }
      const tokens = segment.match(/-?\d+(?:\.\d+)?/g);
      if (!tokens) return;
      const points = [];
      for (let index = 0; index + 1 < tokens.length; index += 2) {
        const x = Number(tokens[index]);
        const y = Number(tokens[index + 1]);
        if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y });
      }
      if (points.length >= 3) {
        polygons.push(points);
      } else if (points.length === 2) {
        const [p1, p2] = points;
        polygons.push([
          { x: p1.x, y: p1.y },
          { x: p2.x, y: p1.y },
          { x: p2.x, y: p2.y },
          { x: p1.x, y: p2.y },
        ]);
      }
    });
    return polygons;
  }

  function normalizeArrayCoords(value) {
    if (!value) return [];
    if (!Array.isArray(value) && value && typeof value === "object") {
      if (Array.isArray(value.x) && Array.isArray(value.y)) {
        const points = [];
        const length = Math.min(value.x.length, value.y.length);
        for (let index = 0; index < length; index += 1) {
          const x = Number(value.x[index]);
          const y = Number(value.y[index]);
          if (Number.isFinite(x) && Number.isFinite(y)) {
            points.push({ x, y });
          }
        }
        return points.length >= 3 ? [points] : [];
      }
      return [];
    }
    if (!Array.isArray(value)) return [];
    const polygons = [];
    value.forEach((entry) => {
      if (entry && typeof entry === "object" && Array.isArray(entry.x) && Array.isArray(entry.y)) {
        polygons.push(...normalizeArrayCoords(entry));
        return;
      }
      if (Array.isArray(entry)) {
        const points = entry.map((point) => {
          if (Array.isArray(point) && point.length >= 2) {
            return { x: Number(point[0]), y: Number(point[1]) };
          }
          if (point && typeof point === "object") {
            return { x: Number(point.x), y: Number(point.y) };
          }
          return null;
        }).filter((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y));
        if (points.length >= 3) polygons.push(points);
      }
    });
    return polygons;
  }

  function openReferenceViewer(detail) {
    if (!detail) return;
    const modal = document.getElementById("driversReferenceViewerModal");
    const title = document.getElementById("driversReferenceViewerTitle");
    const subtitle = document.getElementById("driversReferenceViewerSubtitle");
    const count = document.getElementById("driversReferenceViewerCount");
    const grid = document.getElementById("driversReferenceViewerGrid");
    if (!modal || !grid) return;
    const images = [
      {
        filename: detail.previousFilename || "Previous Reference",
        image_src: detail.previousImageSrc || "",
        order_index: 1,
        captured_at: detail.time || "",
      },
      {
        filename: detail.filename || "Current Reference",
        image_src: detail.imageSrc || "",
        order_index: 2,
        captured_at: detail.time || "",
      },
    ];
    if (title) title.textContent = "Reference Change";
    if (subtitle) {
      subtitle.textContent = `${formatJobLabel(detail.jobName, detail.orderNumber)} · ${detail.reelCode || "Reel"} · 2 images`;
    }
    if (count) count.textContent = "2 of 2";
    grid.dataset.imageCount = "2";
    grid.innerHTML = images.map((image, index) => {
      const src = image.image_src ? urlForStatic(image.image_src) : "";
      const cardTitle = index === 0 ? "Before" : "After";
      return `
        <article class="drivers-reference-viewer__card${index === 1 ? " is-active" : ""}">
          <div class="drivers-reference-viewer__frame">
            ${src
              ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(image.filename || cardTitle)}" loading="lazy" decoding="async">`
              : `<div class="drivers-empty placeholder">No preview</div>`}
          </div>
          <div class="drivers-reference-viewer__meta">
            <strong>${escapeHtml(cardTitle)}</strong>
            <span>${escapeHtml(image.filename || "--")}</span>
            <span>${escapeHtml(formatDateTimeLabel(image.captured_at))}</span>
          </div>
        </article>
      `;
    }).join("");
    modal.classList.remove("hidden");
    document.body.classList.add("drivers-reference-viewer-open");
  }

  function summarizeMaskCoords(value) {
    const text = String(value || "").trim();
    if (!text) return "empty";
    return text.length > 42 ? `${text.slice(0, 42)}...` : text;
  }

  function countVisibleDefectsForReel(machine, reelId) {
    const target = String(reelId || "");
    return (Array.isArray(machine && machine.points) ? machine.points : []).filter((point) => {
      return String(point && point.reelId || "") === target && pointIsVisible(point);
    }).length;
  }

  function colorForJob(label) {
    const palette = ["#0ea5e9", "#f97316", "#34d399", "#f43f5e", "#a855f7", "#14b8a6", "#f59e0b", "#6366f1"];
    const key = String(label || "");
    let hash = 0;
    for (let i = 0; i < key.length; i += 1) hash = ((hash << 5) - hash) + key.charCodeAt(i);
    return palette[Math.abs(hash) % palette.length];
  }

  function hexToRgba(hex, alpha) {
    const normalized = String(hex || "").replace("#", "");
    if (normalized.length !== 6) return `rgba(148, 163, 184, ${alpha})`;
    const r = parseInt(normalized.slice(0, 2), 16);
    const g = parseInt(normalized.slice(2, 4), 16);
    const b = parseInt(normalized.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function getPlotConfig() {
    return {
      responsive: true,
      displaylogo: false,
      modeBarButtonsToRemove: ["lasso2d", "select2d"],
    };
  }

  function ensureChartHost(container, id) {
    if (!container) return null;
    let host = container.querySelector(`#${id}`);
    if (!host) {
      container.innerHTML = `<div id="${id}" class="delta-trends-chart"></div>`;
      host = container.querySelector(`#${id}`);
    }
    return host;
  }

  function resetChartHost(container, id) {
    if (!container) return null;
    const existing = container.querySelector(`#${id}`);
    if (existing && window.Plotly && typeof window.Plotly.purge === "function") {
      try {
        window.Plotly.purge(existing);
      } catch (error) {
        console.debug("[Dashboard Defect Trends] purge skipped", error);
      }
    }
    container.innerHTML = `<div id="${id}" class="delta-trends-chart"></div>`;
    return container.querySelector(`#${id}`);
  }

  function showLoadingOverlay(message) {
    if (!elements.loadingOverlay) return;
    loadingOverlayCount += 1;
    elements.loadingOverlay.classList.remove("hidden");
    elements.loadingOverlay.setAttribute("aria-hidden", "false");
    if (elements.loadingText && message) elements.loadingText.textContent = message;
  }

  function hideLoadingOverlay() {
    if (!elements.loadingOverlay) return;
    loadingOverlayCount = Math.max(loadingOverlayCount - 1, 0);
    if (loadingOverlayCount > 0) return;
    elements.loadingOverlay.classList.add("hidden");
    elements.loadingOverlay.setAttribute("aria-hidden", "true");
  }

  function resizeAllCharts() {
    if (!window.Plotly || !state.active) return;
    const charts = [];
    if (elements.combinedChart) {
      charts.push(...elements.combinedChart.querySelectorAll(".js-plotly-plot"));
    }
    if (elements.machinePanels) {
      charts.push(...elements.machinePanels.querySelectorAll(".js-plotly-plot"));
    }
    charts.forEach((chart) => {
      try {
        window.Plotly.Plots.resize(chart);
      } catch (error) {
        console.debug("[Dashboard Defect Trends] resize skipped", error);
      }
    });
  }

  async function readJsonResponse(response, context) {
    let payload = null;
    try {
      payload = await response.json();
    } catch (error) {
      throw new Error(`Unable to parse ${context || "response"} JSON.`);
    }
    if (!response.ok) {
      const message = payload && payload.error ? payload.error : `${context || "Request"} failed (${response.status})`;
      throw new Error(message);
    }
    if (payload && typeof payload.error === "string") {
      throw new Error(payload.error);
    }
    return payload;
  }

  function buildJobKey(jobName, orderNumber) {
    const cleanedJob = `${jobName || ""}`.trim();
    if (!cleanedJob) return "";
    const cleanedOrder = `${orderNumber || ""}`.trim();
    return `${cleanedJob}|||${cleanedOrder}`;
  }

  function formatJobLabel(jobName, orderNumber) {
    const cleanedJob = `${jobName || ""}`.trim() || "Unknown Job";
    const cleanedOrder = `${orderNumber || ""}`.trim();
    return cleanedOrder ? `${cleanedJob} - ${cleanedOrder}` : cleanedJob;
  }

  function formatDateTimeLabel(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return escapeHtml(String(value));
    return date.toLocaleString();
  }

  function formatCount(value, noun) {
    const count = Number(value) || 0;
    return `${formatNumber(count, 0)} ${noun}${count === 1 ? "" : "s"}`;
  }

  function formatMetric(value) {
    return valueOrNull(value) === null ? "—" : formatNumber(Number(value), 3);
  }

  function formatNumber(value, digits = 0) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "0";
    return number.toLocaleString(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function formatSignedNumber(value, digits = 0) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "--";
    const formatted = formatNumber(Math.abs(number), digits);
    if (number === 0) return formatted;
    return `${number > 0 ? "+" : "-"}${formatted}`;
  }

  function valueOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function readThemeColor(variable, fallback) {
    if (typeof window === "undefined" || !window.getComputedStyle) return fallback;
    const value = getComputedStyle(document.body || document.documentElement).getPropertyValue(variable).trim();
    return value || fallback;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, "&#96;");
  }

  return { init, activate, deactivate, onFiltersUpdated };
})();
