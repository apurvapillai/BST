const DefectTrendsTab = (() => {
  const MAGNITUDE_COLOR = "#2563eb";
  const SPEED_COLOR = "rgba(34, 197, 94, 0.5)";
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
    patternData: null,
    optionsStatus: "idle",
    dataStatus: "idle",
    patternStatus: "idle",
    optionsError: "",
    dataError: "",
    patternError: "",
    showImageDefects: true,
    showReferenceFlags: true,
    showMaskFlags: true,
    rawDataCoverage: new Map(),
    recurringGroupFilters: new Map(),
    recurringPanelExpansions: new Map(),
    recurringOccurrenceSorts: new Map(),
    recurringClusterSelections: new Map(),
    patternClassFilters: new Map(),
    patternSelectedReels: new Map(),
    patternSelectedLocationGroups: new Map(),
    patternSelectedLocationExamples: new Map(),
    reelNavigatorItems: [],
    reelNavigatorIndex: -1,
    referenceNavigatorItems: [],
    referenceNavigatorIndex: -1,
    maskNavigatorItems: [],
    maskNavigatorIndex: -1,
  };

  const elements = {};
  let optionsAbortController = null;
  let dataAbortController = null;
  let patternAbortController = null;
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
    syncTimeFromGlobalFilters();
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

  function onFiltersUpdated() {
    if (!state.active) return;
    syncTimeFromGlobalFilters();
    loadOptionsAndData();
  }

  function getDashboardFilters() {
    if (typeof Filters === "undefined" || !Filters || typeof Filters.getState !== "function") {
      return {};
    }
    const filters = Filters.getState() || {};
    return {
      start: filters.start || "",
      end: filters.end || "",
    };
  }

  function syncTimeFromGlobalFilters() {
    const filters = getDashboardFilters();
    const nextStart = filters.start || state.defaultStart || "";
    const nextEnd = filters.end || state.defaultEnd || "";
    state.start = nextStart;
    state.end = nextEnd;
    if (elements.start) elements.start.value = state.start;
    if (elements.end) elements.end.value = state.end;
  }

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
    elements.detailSubtitle = document.getElementById("defectTrendsDetailSubtitle");
    elements.showImageDefects = document.getElementById("defectTrendsLegendShowImageDefects");
    elements.showReferenceFlags = document.getElementById("defectTrendsLegendShowReferenceFlags");
    elements.showMaskFlags = document.getElementById("defectTrendsLegendShowMaskFlags");
    elements.reelPrev = document.getElementById("defectTrendsReelPrev");
    elements.reelNext = document.getElementById("defectTrendsReelNext");
    elements.reelStatus = document.getElementById("defectTrendsReelStatus");
    elements.referencePrev = document.getElementById("defectTrendsReferencePrev");
    elements.referenceNext = document.getElementById("defectTrendsReferenceNext");
    elements.referenceStatus = document.getElementById("defectTrendsReferenceStatus");
    elements.maskPrev = document.getElementById("defectTrendsMaskPrev");
    elements.maskNext = document.getElementById("defectTrendsMaskNext");
    elements.maskStatus = document.getElementById("defectTrendsMaskStatus");
    elements.machinePanels = document.getElementById("defectTrendsMachinePanels");
    elements.loadingOverlay = document.getElementById("defectTrendsLoadingOverlay");
    elements.loadingText = document.getElementById("defectTrendsLoadingText");
  }

  function bindEvents() {
    if (elements.start) {
      elements.start.addEventListener("change", () => {
        const nextStart = elements.start.value || state.defaultStart;
        state.start = nextStart;
        if (typeof Filters !== "undefined" && Filters && typeof Filters.set === "function") {
          Filters.set("start", nextStart, { emit: true, updateUrl: true });
          return;
        }
        renderGlobalFilterChips();
        loadOptionsAndData();
      });
    }
    if (elements.end) {
      elements.end.addEventListener("change", () => {
        const nextEnd = elements.end.value || state.defaultEnd;
        state.end = nextEnd;
        if (typeof Filters !== "undefined" && Filters && typeof Filters.set === "function") {
          Filters.set("end", nextEnd, { emit: true, updateUrl: true });
          return;
        }
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
    if (elements.reelPrev) elements.reelPrev.addEventListener("click", () => moveToCategoryEvent("reel", -1));
    if (elements.reelNext) elements.reelNext.addEventListener("click", () => moveToCategoryEvent("reel", 1));
    if (elements.referencePrev) elements.referencePrev.addEventListener("click", () => moveToCategoryEvent("reference", -1));
    if (elements.referenceNext) elements.referenceNext.addEventListener("click", () => moveToCategoryEvent("reference", 1));
    if (elements.maskPrev) elements.maskPrev.addEventListener("click", () => moveToCategoryEvent("mask", -1));
    if (elements.maskNext) elements.maskNext.addEventListener("click", () => moveToCategoryEvent("mask", 1));
    if (elements.selectAll) {
      elements.selectAll.addEventListener("click", () => {
        state.machineOptions.forEach((machine) => {
          state.selections.set(String(machine.machineId), { enabled: true, expanded: false, jobKeys: [] });
        });
        renderMachineSelector();
        renderSelectionSummary();
        updateDataForCurrentSelections();
      });
    }
    if (elements.clearAll) {
      elements.clearAll.addEventListener("click", () => {
        state.machineOptions.forEach((machine) => {
          state.selections.set(String(machine.machineId), { enabled: false, expanded: false, jobKeys: [] });
        });
        renderMachineSelector();
        renderSelectionSummary();
        updateDataForCurrentSelections();
      });
    }
    if (elements.machineSelector) {
      elements.machineSelector.addEventListener("click", handleSelectorClick);
      elements.machineSelector.addEventListener("change", handleSelectorChange);
    }
    if (elements.machinePanels) {
      elements.machinePanels.addEventListener("click", handleMachinePanelClick);
      elements.machinePanels.addEventListener("change", handleMachinePanelChange);
    }
    document.addEventListener("keydown", handlePatternViewerKeydown);
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
    const filters = getDashboardFilters();
    Object.entries(filters).forEach(([key, value]) => {
      if (value === undefined || value === null || value === "") return;
      if (Array.isArray(value)) {
        value.forEach((item) => {
          if (item === undefined || item === null || item === "") return;
          params.append(key, item);
        });
        return;
      }
      params.append(key, value);
    });
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
        state.selections.set(machineId, {
          enabled: true,
          expanded: false,
          jobKeys: [],
        });
        return;
      }
      current.jobKeys = (current.jobKeys || []).filter((jobKey) => validJobKeys.has(jobKey));
      if (current.enabled === undefined) {
        current.enabled = true;
      }
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

  function buildSelectionCoverage(selectionsPayload) {
    const coverage = new Map();
    (selectionsPayload || []).forEach((selection) => {
      if (selection.enabled === false) return;
      const jobKeys = Array.isArray(selection.jobKeys) ? selection.jobKeys.filter(Boolean) : [];
      coverage.set(String(selection.machineId), {
        allJobs: !jobKeys.length,
        jobKeys: new Set(jobKeys),
      });
    });
    return coverage;
  }

  function canSatisfySelectionsFromRawData(selectionsPayload) {
    const rawMachines = Array.isArray(state.rawData && state.rawData.machines) ? state.rawData.machines : [];
    if (!rawMachines.length) return false;
    const rawByMachine = new Map(rawMachines.map((machine) => [String(machine.machineId), machine]));
    return (selectionsPayload || [])
      .filter((selection) => selection.enabled !== false)
      .every((selection) => {
        const machineId = String(selection.machineId);
        if (!rawByMachine.has(machineId)) return false;
        const coverage = state.rawDataCoverage.get(machineId);
        if (!coverage) return false;
        const requestedJobKeys = Array.isArray(selection.jobKeys) ? selection.jobKeys.filter(Boolean) : [];
        if (!requestedJobKeys.length) return coverage.allJobs;
        if (coverage.allJobs) return true;
        return requestedJobKeys.every((jobKey) => coverage.jobKeys.has(jobKey));
      });
  }

  function updateDataForCurrentSelections() {
    const selections = buildSelectionsPayload();
    const enabledSelections = selections.filter((selection) => selection.enabled !== false);
    if (!enabledSelections.length) {
      state.data = { ...(state.rawData || {}), machines: [] };
      state.patternData = { machines: [] };
      state.dataStatus = "empty";
      state.patternStatus = "empty";
      state.dataError = "";
      state.patternError = "";
      renderCharts();
      return;
    }
    if (canSatisfySelectionsFromRawData(selections)) {
      syncDataToCurrentSelections(selections);
      schedulePatternFetch(selections);
      return;
    }
    fetchData(selections);
  }

  async function fetchData(selectionsPayload = null) {
    if (!state.active || state.optionsStatus !== "ready") return;
    const selections = selectionsPayload || buildSelectionsPayload();
    const enabledSelections = selections.filter((selection) => selection.enabled !== false);
    if (!enabledSelections.length) {
      state.rawData = { machines: [] };
      state.data = { machines: [] };
      state.patternData = { machines: [] };
      state.rawDataCoverage = new Map();
      state.dataStatus = "empty";
      state.patternStatus = "empty";
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
          ...getDashboardFilters(),
          start: state.start,
          end: state.end,
          min_feet: state.minFeet,
          selections,
        }),
      });
      const payload = await readJsonResponse(response, "defect-trends data");
      state.rawData = payload || { machines: [] };
      state.rawDataCoverage = buildSelectionCoverage(selections);
      state.data = {
        ...(state.rawData || {}),
        machines: applySelectionFiltersToMachines((state.rawData && state.rawData.machines) || [], selections),
      };
      state.dataStatus = ((state.data && state.data.machines) || []).length ? "ready" : "empty";
      renderCharts();
      schedulePatternFetch(selections);
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

  function schedulePatternFetch(selectionsPayload) {
    const selections = selectionsPayload || buildSelectionsPayload();
    if (!state.active || state.optionsStatus !== "ready") return;
    state.patternStatus = "loading";
    state.patternError = "";
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(() => {
        void fetchPatternData(selections);
      }, { timeout: 500 });
      return;
    }
    window.setTimeout(() => {
      void fetchPatternData(selections);
    }, 0);
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

  function syncDataToCurrentSelections(selectionsPayload = null) {
    if (!state.rawData) return;
    const selections = selectionsPayload || buildSelectionsPayload();
    state.data = {
      ...(state.rawData || {}),
      machines: applySelectionFiltersToMachines((state.rawData && state.rawData.machines) || [], selections),
    };
    state.dataStatus = ((state.data && state.data.machines) || []).length ? "ready" : "empty";
    state.dataError = "";
    renderCharts();
  }

  async function fetchPatternData(selectionsPayload = null) {
    if (!state.active || state.optionsStatus !== "ready") return;
    const selections = selectionsPayload || buildSelectionsPayload();
    const enabledSelections = selections.filter((selection) => selection.enabled !== false);
    if (!enabledSelections.length) {
      state.patternData = { machines: [] };
      state.patternStatus = "empty";
      state.patternError = "";
      renderMachinePanels();
      return;
    }
    if (patternAbortController) patternAbortController.abort();
    patternAbortController = new AbortController();
    state.patternStatus = "loading";
    state.patternError = "";
    renderMachinePanels();
    try {
      const response = await fetch("/dashboard/api/defect-trends/pattern-analyzer", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        signal: patternAbortController.signal,
        body: JSON.stringify({
          ...getDashboardFilters(),
          start: state.start,
          end: state.end,
          min_feet: state.minFeet,
          selections,
        }),
      });
      const payload = await readJsonResponse(response, "defect pattern analyzer");
      state.patternData = payload || { machines: [] };
      state.patternStatus = ((state.patternData && state.patternData.machines) || []).length ? "ready" : "empty";
      state.patternError = "";
      renderMachinePanels();
    } catch (error) {
      if (error && error.name === "AbortError") return;
      state.patternData = { machines: [] };
      state.patternStatus = "error";
      state.patternError = error && error.message ? error.message : "Unable to load defect pattern analyzer.";
      renderMachinePanels();
      throw error;
    }
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
      updateDataForCurrentSelections();
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
      updateDataForCurrentSelections();
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
      updateDataForCurrentSelections();
    }
  }

  function handleMachinePanelClick(event) {
    const groupButton = event.target.closest("[data-recurring-group-filter]");
    if (groupButton) {
      event.preventDefault();
      const machineId = String(groupButton.getAttribute("data-machine-id") || "");
      const nextKey = groupButton.getAttribute("data-recurring-group-filter") || "all";
      state.recurringGroupFilters.set(machineId, nextKey || "all");
      const host = document.getElementById(`defectTrendsMachineGroupList-${machineId}`);
      const machine = (((state.data && state.data.machines) || []).find((item) => String(item && item.machineId || "") === machineId)) || null;
      renderMachineDefectGroupList(host, machine);
      return;
    }
    const expandButton = event.target.closest("[data-recurring-panel-expand]");
    if (expandButton) {
      event.preventDefault();
      const machineId = String(expandButton.getAttribute("data-machine-id") || "");
      const isExpanded = state.recurringPanelExpansions.get(machineId) === true;
      state.recurringPanelExpansions.set(machineId, !isExpanded);
      const host = document.getElementById(`defectTrendsMachineGroupList-${machineId}`);
      const machine = (((state.data && state.data.machines) || []).find((item) => String(item && item.machineId || "") === machineId)) || null;
      renderMachineDefectGroupList(host, machine);
      return;
    }
    const sortButton = event.target.closest("[data-recurring-sort]");
    if (sortButton) {
      event.preventDefault();
      const machineId = String(sortButton.getAttribute("data-machine-id") || "");
      const nextSort = sortButton.getAttribute("data-recurring-sort") || "asc";
      state.recurringOccurrenceSorts.set(machineId, nextSort === "desc" ? "desc" : "asc");
      const host = document.getElementById(`defectTrendsMachineGroupList-${machineId}`);
      const machine = (((state.data && state.data.machines) || []).find((item) => String(item && item.machineId || "") === machineId)) || null;
      renderMachineDefectGroupList(host, machine);
      return;
    }
    const navButton = event.target.closest("[data-recurring-occurrence-nav]");
    if (navButton) {
      event.preventDefault();
      const machineId = String(navButton.getAttribute("data-machine-id") || "");
      const groupKey = String(navButton.getAttribute("data-group-key") || "");
      const clusterKey = String(navButton.getAttribute("data-cluster-key") || "");
      const direction = Number(navButton.getAttribute("data-direction")) || 0;
      moveRecurringClusterSelection(machineId, groupKey, clusterKey, direction);
      return;
    }
    const imageButton = event.target.closest("[data-defect-group-image]");
    if (imageButton) {
      event.preventDefault();
      const imagePath = imageButton.getAttribute("data-defect-group-image") || "";
      if (imagePath && typeof window.showImageModal === "function") {
        window.showImageModal(urlForStatic(imagePath), null);
      }
      return;
    }
    const jumpButton = event.target.closest("[data-defect-group-jump]");
    if (jumpButton) {
      event.preventDefault();
      jumpToAxisOffset(Number(jumpButton.getAttribute("data-defect-group-jump")));
      return;
    }
    const locationGroupButton = event.target.closest("[data-pattern-location-view]");
    if (locationGroupButton) {
      event.preventDefault();
      const machineId = String(locationGroupButton.getAttribute("data-machine-id") || "");
      const groupKey = String(locationGroupButton.getAttribute("data-pattern-location-view") || "");
      state.patternSelectedLocationGroups.set(machineId, groupKey);
      state.patternSelectedLocationExamples.set(`${machineId}:${groupKey}`, 0);
      const host = document.getElementById(`defectTrendsMachinePatternAnalyzer-${machineId}`);
      const machine = (((state.data && state.data.machines) || []).find((item) => String(item && item.machineId || "") === machineId)) || null;
      renderMachinePatternAnalyzer(host, machine);
      return;
    }
    const locationNavButton = event.target.closest("[data-pattern-location-example-nav]");
    if (locationNavButton) {
      event.preventDefault();
      const machineId = String(locationNavButton.getAttribute("data-machine-id") || "");
      const groupKey = String(locationNavButton.getAttribute("data-group-key") || "");
      const delta = Number(locationNavButton.getAttribute("data-direction")) || 0;
      movePatternLocationExample(machineId, groupKey, delta);
      return;
    }
    const locationThumbButton = event.target.closest("[data-pattern-location-thumb]");
    if (locationThumbButton) {
      event.preventDefault();
      const machineId = String(locationThumbButton.getAttribute("data-machine-id") || "");
      const groupKey = String(locationThumbButton.getAttribute("data-group-key") || "");
      const exampleIndex = Number(locationThumbButton.getAttribute("data-pattern-location-thumb")) || 0;
      state.patternSelectedLocationExamples.set(`${machineId}:${groupKey}`, Math.max(0, exampleIndex));
      const host = document.getElementById(`defectTrendsMachinePatternAnalyzer-${machineId}`);
      const machine = (((state.data && state.data.machines) || []).find((item) => String(item && item.machineId || "") === machineId)) || null;
      renderMachinePatternAnalyzer(host, machine);
      return;
    }
    const closeLocationButton = event.target.closest("[data-pattern-location-close]");
    if (closeLocationButton) {
      event.preventDefault();
      const machineId = String(closeLocationButton.getAttribute("data-machine-id") || "");
      state.patternSelectedLocationGroups.delete(machineId);
      const host = document.getElementById(`defectTrendsMachinePatternAnalyzer-${machineId}`);
      const machine = (((state.data && state.data.machines) || []).find((item) => String(item && item.machineId || "") === machineId)) || null;
      renderMachinePatternAnalyzer(host, machine);
      return;
    }
    const clearPatternSelectionButton = event.target.closest("[data-pattern-clear-selection]");
    if (clearPatternSelectionButton) {
      event.preventDefault();
      const machineId = String(clearPatternSelectionButton.getAttribute("data-machine-id") || "");
      state.patternSelectedReels.delete(machineId);
      const host = document.getElementById(`defectTrendsMachinePatternAnalyzer-${machineId}`);
      const machine = (((state.data && state.data.machines) || []).find((item) => String(item && item.machineId || "") === machineId)) || null;
      renderMachinePatternAnalyzer(host, machine);
    }
  }

  function handleMachinePanelChange(event) {
    const classFilter = event.target.closest("[data-pattern-class-filter]");
    if (!classFilter) return;
    const machineId = String(classFilter.getAttribute("data-machine-id") || "");
    const nextKey = String(classFilter.value || "all");
    state.patternClassFilters.set(machineId, nextKey);
    const host = document.getElementById(`defectTrendsMachinePatternAnalyzer-${machineId}`);
    const machine = (((state.data && state.data.machines) || []).find((item) => String(item && item.machineId || "") === machineId)) || null;
    renderMachinePatternAnalyzer(host, machine);
  }

  function handlePatternViewerKeydown(event) {
    if (!state.active) return;
    if (event.defaultPrevented) return;
    const targetTag = String(event.target && event.target.tagName || "").toLowerCase();
    if (targetTag === "input" || targetTag === "textarea" || targetTag === "select") return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const activeEntry = Array.from(state.patternSelectedLocationGroups.entries()).find(([, groupKey]) => !!groupKey);
    if (!activeEntry) return;
    const [machineId, groupKey] = activeEntry;
    event.preventDefault();
    movePatternLocationExample(machineId, groupKey, event.key === "ArrowRight" ? 1 : -1);
  }

  function renderSelectionSummary() {
    if (!elements.selectionSummary) return;
    if (state.optionsStatus === "loading") {
      elements.selectionSummary.textContent = "Loading presses…";
      if (elements.detailSubtitle) elements.detailSubtitle.textContent = "Loading press options…";
      return;
    }
    if (state.optionsStatus === "error") {
      elements.selectionSummary.textContent = state.optionsError || "Unable to load defect trend options.";
      if (elements.detailSubtitle) elements.detailSubtitle.textContent = "Options request failed.";
      return;
    }
    if (!state.machineOptions.length) {
      elements.selectionSummary.textContent = "No presses with defect data in the selected window.";
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
      if (typeof Filters !== "undefined" && Filters && typeof Filters.set === "function") {
        Filters.set("start", "", { emit: true, updateUrl: true });
        return;
      }
      state.start = state.defaultStart;
      if (elements.start) elements.start.value = state.start;
      renderGlobalFilterChips();
      loadOptionsAndData();
      return;
    }
    if (key === "end") {
      if (typeof Filters !== "undefined" && Filters && typeof Filters.set === "function") {
        Filters.set("end", "", { emit: true, updateUrl: true });
        return;
      }
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
      return;
    }
  }

  function renderCharts() {
    const machines = ((state.data && state.data.machines) || []).filter((machine) => (machine.points || []).length);
    renderMachinePanels(machines);
    renderEventNavigator(machines);
  }

  function renderMachinePanels(machinesInput = null) {
    if (!elements.machinePanels) return;
    if (state.dataStatus === "loading") {
      elements.machinePanels.innerHTML = '<div class="delta-trends-empty">Loading press defect trends…</div>';
      return;
    }
    if (state.dataStatus === "error") {
      elements.machinePanels.innerHTML = `<div class="delta-trends-empty">${escapeHtml(state.dataError || "Unable to load press defect trends.")}</div>`;
      return;
    }
    const machines = Array.isArray(machinesInput)
      ? machinesInput
      : ((state.data && state.data.machines) || []).filter((machine) => (machine.points || []).length);
    if (!machines.length) {
      elements.machinePanels.innerHTML = '<div class="delta-trends-empty">No press defect trends available for the current filter state.</div>';
      return;
    }
    const sortedMachines = sortMachines(machines);
    const patternByMachine = new Map((((state.patternData && state.patternData.machines) || []).map((item) => [String(item.machineId), item])));
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
                  <div class="delta-machine-panel__subchart-header">
                    <strong>Defect Position Map</strong>
                    <span>Repeated positions show up as horizontal bands across reels.</span>
                  </div>
                  <div id="defectTrendsMachinePositionChart-${machine.machineId}" class="delta-machine-panel__chart delta-machine-panel__chart--secondary"></div>
                </div>
              </div>
            </div>
            <div class="delta-trends-chart-card delta-machine-panel__summary-card">
              <div class="delta-machine-panel__subchart-header delta-machine-panel__subchart-header--summary">
                <strong>Recurring Defect Groups</strong>
                <span>Grouped by defect category only, sorted from highest to lowest occurrence.</span>
              </div>
              <div id="defectTrendsMachineGroupList-${machine.machineId}" class="delta-machine-panel__group-list"></div>
            </div>
            <div class="delta-trends-chart-card delta-machine-panel__summary-card">
              <div class="delta-machine-panel__subchart-header delta-machine-panel__subchart-header--summary">
                <strong>Defect Pattern Analyzer</strong>
                <span>Job-level pattern review across reels, defect shapes, and severity progression.</span>
              </div>
              <div
                id="defectTrendsMachinePatternAnalyzer-${machine.machineId}"
                class="delta-machine-panel__pattern-analyzer"
                data-has-pattern="${patternByMachine.has(String(machine.machineId)) ? "true" : "false"}"
              ></div>
            </div>
          </article>
        `;
      })
      .join("");

    sortedMachines.forEach((machine) => {
      renderMachineTimeline(machine);
      const host = document.getElementById(`defectTrendsMachineChart-${machine.machineId}`);
      const positionHost = document.getElementById(`defectTrendsMachinePositionChart-${machine.machineId}`);
      const groupListHost = document.getElementById(`defectTrendsMachineGroupList-${machine.machineId}`);
      const patternHost = document.getElementById(`defectTrendsMachinePatternAnalyzer-${machine.machineId}`);
      renderMachineChart(host, machine);
      renderMachinePositionChart(positionHost, machine);
      renderMachineDefectGroupList(groupListHost, machine);
      renderMachinePatternAnalyzer(patternHost, machine);
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

  function renderEventNavigator(machines) {
    const navigator = buildEventNavigatorState(machines);
    state.reelNavigatorItems = navigator.reels;
    state.referenceNavigatorItems = navigator.references;
    state.maskNavigatorItems = navigator.masks;
    state.reelNavigatorIndex = normalizeNavigatorIndex(state.reelNavigatorIndex, navigator.reels.length);
    state.referenceNavigatorIndex = normalizeNavigatorIndex(state.referenceNavigatorIndex, navigator.references.length);
    state.maskNavigatorIndex = normalizeNavigatorIndex(state.maskNavigatorIndex, navigator.masks.length);
    updateCategoryNavigatorUi("reel", "reels", state.reelNavigatorItems, state.reelNavigatorIndex);
    updateCategoryNavigatorUi("reference", "new refs", state.referenceNavigatorItems, state.referenceNavigatorIndex);
    updateCategoryNavigatorUi("mask", "mask changes", state.maskNavigatorItems, state.maskNavigatorIndex);
  }

  function buildEventNavigatorState(machines) {
    const sortedMachines = sortMachines(Array.isArray(machines) ? machines : []);
    const reels = [];
    const references = [];
    const masks = [];
    sortedMachines.forEach((machine) => {
      collectMachineNavigatorEvents(machine).forEach((item) => {
        if (item.type === "reel") reels.push(item);
        if (item.type === "reference") references.push(item);
        if (item.type === "mask") masks.push(item);
      });
    });
    return {
      reels,
      references: state.showReferenceFlags ? references : [],
      masks: state.showMaskFlags ? masks : [],
    };
  }

  function collectMachineNavigatorEvents(machine) {
    const items = [];
    const reels = getSortedMachineReels(machine);
    let cumulativeFeet = 0;
    reels.forEach((reel, index) => {
      const reelFeet = Math.max(Number(reel && reel.reelFeetTotal) || 0, 0);
      if (index > 0) {
        items.push({
          id: `reel-${machine.machineId}-${reel.reelId}`,
          type: "reel",
          machineId: machine.machineId,
          xValue: cumulativeFeet,
          label: `${machine.machineName || `Press ${machine.machineId}`} · New Reel · ${reel && reel.reelCode ? reel.reelCode : "Unknown Reel"}`,
        });
      }
      cumulativeFeet += reelFeet;
    });
    const { referenceBaseFeet, maskBaseFeet } = buildEventBaseFeetMap(reels);
    const referenceEvents = Array.isArray(machine && machine.referenceImageEvents) ? machine.referenceImageEvents : [];
    referenceEvents.forEach((event, index) => {
      const reelKey = String(event && event.reelId || "");
      const localFeet = Number(event && event.feetFromReelStart);
      if (!reelKey || !referenceBaseFeet.has(reelKey) || !Number.isFinite(localFeet)) return;
      items.push({
        id: `reference-${machine.machineId}-${reelKey}-${index}`,
        type: "reference",
        machineId: machine.machineId,
        xValue: referenceBaseFeet.get(reelKey) + localFeet,
        label: `${machine.machineName || `Press ${machine.machineId}`} · New Ref · ${event && event.reelCode ? event.reelCode : "Unknown Reel"}`,
      });
    });
    const maskEvents = Array.isArray(machine && machine.maskEvents) ? machine.maskEvents : [];
    maskEvents.forEach((event, index) => {
      const reelKey = String(event && event.reelId || "");
      const localFeet = Number(event && event.feetFromReelStart);
      if (!reelKey || !maskBaseFeet.has(reelKey) || !Number.isFinite(localFeet)) return;
      items.push({
        id: `mask-${machine.machineId}-${reelKey}-${index}`,
        type: "mask",
        machineId: machine.machineId,
        xValue: maskBaseFeet.get(reelKey) + localFeet,
        label: `${machine.machineName || `Press ${machine.machineId}`} · Mask Chg · ${event && event.reelCode ? event.reelCode : "Unknown Reel"}`,
      });
    });
    const typeRank = { reel: 0, reference: 1, mask: 2 };
    return items.sort((left, right) => {
      const xDiff = Number(left.xValue || 0) - Number(right.xValue || 0);
      if (xDiff !== 0) return xDiff;
      return (typeRank[left.type] || 0) - (typeRank[right.type] || 0);
    });
  }

  function buildEventBaseFeetMap(reels) {
    const referenceBaseFeet = new Map();
    const maskBaseFeet = new Map();
    let cumulativeFeet = 0;
    (Array.isArray(reels) ? reels : []).forEach((reel) => {
      const reelKey = String(reel && reel.reelId || "");
      if (reelKey) {
        referenceBaseFeet.set(reelKey, cumulativeFeet);
        maskBaseFeet.set(reelKey, cumulativeFeet);
      }
      cumulativeFeet += Math.max(Number(reel && reel.reelFeetTotal) || 0, 0);
    });
    return { referenceBaseFeet, maskBaseFeet };
  }

  function normalizeNavigatorIndex(currentIndex, itemCount) {
    if (!itemCount) return -1;
    if (currentIndex < 0 || currentIndex >= itemCount) return 0;
    return currentIndex;
  }

  function updateCategoryNavigatorUi(category, emptyLabel, items, index) {
    const statusElement = elements[`${category}Status`];
    const prevElement = elements[`${category}Prev`];
    const nextElement = elements[`${category}Next`];
    if (statusElement) {
      statusElement.textContent = items.length
        ? `${index + 1}/${items.length} ${emptyLabel}`
        : `0 ${emptyLabel}`;
    }
    if (prevElement) prevElement.disabled = !items.length;
    if (nextElement) nextElement.disabled = !items.length;
  }

  function moveToCategoryEvent(category, direction) {
    const items = Array.isArray(state[`${category}NavigatorItems`]) ? state[`${category}NavigatorItems`] : [];
    if (!items.length) return;
    const indexKey = `${category}NavigatorIndex`;
    if (state[indexKey] < 0) {
      state[indexKey] = 0;
    } else {
      const itemCount = items.length;
      state[indexKey] = (state[indexKey] + direction + itemCount) % itemCount;
    }
    const activeItem = items[state[indexKey]];
    if (activeItem) {
      jumpToNavigatorEvent(activeItem);
    }
    renderEventNavigator(((state.data && state.data.machines) || []).filter((machine) => (machine.points || []).length));
  }

  function jumpToNavigatorEvent(item) {
    if (!item) return;
    jumpToAxisOffset(Number(item.xValue));
  }

  function jumpToAxisOffset(rawAxisOffset) {
    const axisOffset = Math.max(Number(rawAxisOffset) || 0, 0);
    const firstChartScroll = document.querySelector('.delta-machine-panel__chart-scroll[data-machine-scroll^="chart-"]');
    const baselineSpan = Math.max(Number(firstChartScroll && firstChartScroll.dataset.baselineSpan) || 0, 1);
    const centeredOffset = Math.max(axisOffset - (baselineSpan / 2), 0);
    setInitialMachineScrollOffset(centeredOffset);
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

  function renderMachinePositionChart(host, machine) {
    if (!host) return;
    const series = buildMachinePositionSeries(machine);
    if (!series.x.length) {
      host.innerHTML = '<div class="delta-trends-empty">No defect positions available.</div>';
      return;
    }
    const bstOffLayout = buildBstOffLayout(machine);
    const reelMarkerLayout = buildReelMarkerLayout(machine);
    const referenceImageLayout = buildReferenceImageChangeLayout(machine);
    const maskLayout = buildMaskChangeLayout(machine);
    const maxReelFeet = Math.max(series.maxFeet, state.binSizeFeet, 1);
    window.Plotly.react(host, [
      {
        x: series.x,
        y: series.y,
        text: series.hover,
        mode: "markers",
        name: "Defect Position",
        marker: {
          color: series.color,
          size: series.size,
          opacity: 0.8,
          line: {
            color: "rgba(15, 23, 42, 0.18)",
            width: 0.8,
          },
        },
        hovertemplate: "%{text}<extra></extra>",
        showlegend: false,
      },
    ], buildChartLayout({
      xTitle: "Feet",
      yTitle: "Feet From Reel Start",
      xRange: [0, Math.max(getMachineFeetSpan(machine), state.binSizeFeet)],
      xDtick: 500,
      yRange: [0, maxReelFeet],
      showLegend: false,
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

  function renderMachineCoordinateChart(host, machine) {
    if (!host) return;
    const series = buildMachineCoordinateSeries(machine);
    if (!series.x.length) {
      host.innerHTML = '<div class="delta-trends-empty">No defect coordinates available.</div>';
      return;
    }
    const bstOffLayout = buildBstOffLayout(machine);
    const reelMarkerLayout = buildReelMarkerLayout(machine);
    const referenceImageLayout = buildReferenceImageChangeLayout(machine);
    const maskLayout = buildMaskChangeLayout(machine);
    window.Plotly.react(host, [
      {
        x: series.x,
        y: series.xPct,
        text: series.xHover,
        mode: "markers",
        name: "Centroid X",
        marker: {
          color: "#0ea5e9",
          size: series.size,
          opacity: 0.78,
          line: { color: "rgba(14, 165, 233, 0.24)", width: 0.8 },
          symbol: "circle",
        },
        hovertemplate: "%{text}<extra></extra>",
        showlegend: true,
      },
      {
        x: series.x,
        y: series.yPct,
        text: series.yHover,
        mode: "markers",
        name: "Centroid Y",
        marker: {
          color: "#f97316",
          size: series.size,
          opacity: 0.74,
          line: { color: "rgba(249, 115, 22, 0.24)", width: 0.8 },
          symbol: "diamond",
        },
        hovertemplate: "%{text}<extra></extra>",
        showlegend: true,
      },
    ], buildChartLayout({
      xTitle: "Feet",
      yTitle: "Normalized Coordinate (%)",
      xRange: [0, Math.max(getMachineFeetSpan(machine), state.binSizeFeet)],
      xDtick: 500,
      yRange: [0, 100],
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

  function renderMachineDefectGroupList(host, machine) {
    if (!host) return;
    const summary = buildMachineDefectGroupSummary(machine);
    if (!summary.totalCount) {
      host.innerHTML = '<div class="delta-trends-empty">No grouped defects available for the current filter state.</div>';
      return;
    }
    const machineId = String(machine && machine.machineId || "");
    const requestedKey = state.recurringGroupFilters.get(machineId) || "all";
    const activeKey = requestedKey === "all" || summary.groups.some((group) => group.key === requestedKey)
      ? requestedKey
      : "all";
    if (activeKey !== requestedKey) {
      state.recurringGroupFilters.set(machineId, activeKey);
    }
    const isExpanded = state.recurringPanelExpansions.get(machineId) === true;
    const activeSort = state.recurringOccurrenceSorts.get(machineId) || "asc";
    const groups = activeKey === "all"
      ? summary.groups
      : summary.groups.filter((group) => group.key === activeKey);
    host.innerHTML = `
      <div class="delta-machine-panel__group-list-shell${isExpanded ? " is-expanded" : ""}">
        <div class="delta-machine-panel__group-list-header">
          <button
            type="button"
            class="delta-machine-panel__group-list-toggle"
            data-machine-id="${escapeAttr(machineId)}"
            data-recurring-panel-expand="true"
            aria-expanded="${isExpanded ? "true" : "false"}"
          >
            ${isExpanded ? "Hide recurring defects" : "Show recurring defects"}
          </button>
          <span class="delta-machine-panel__group-list-total">${escapeHtml(formatCount(summary.totalCount, "defect"))}</span>
        </div>
        <div class="delta-machine-panel__group-list-content">
          <div class="delta-recurring-group-summary">
            <button
              type="button"
              class="delta-recurring-group-summary__chip${activeKey === "all" ? " is-active" : ""}"
              data-machine-id="${escapeAttr(machineId)}"
              data-recurring-group-filter="all"
            >
              <strong>All</strong>
              <span>${escapeHtml(formatCount(summary.totalCount, "defect"))}</span>
            </button>
            ${summary.groups.map((group) => `
              <button
                type="button"
                class="delta-recurring-group-summary__chip${activeKey === group.key ? " is-active" : ""}"
                data-machine-id="${escapeAttr(machineId)}"
                data-recurring-group-filter="${escapeAttr(group.key)}"
              >
                <strong>${escapeHtml(group.label)}</strong>
                <span>${escapeHtml(formatCount(group.count, "defect"))}</span>
              </button>
            `).join("")}
          </div>
          <div class="delta-recurring-group-toolbar">
            <span class="delta-recurring-group-toolbar__label">Sort by Job Feet</span>
            <div class="delta-recurring-group-toolbar__actions">
              <button
                type="button"
                class="delta-recurring-group-toolbar__button${activeSort === "asc" ? " is-active" : ""}"
                data-machine-id="${escapeAttr(machineId)}"
                data-recurring-sort="asc"
              >
                Asc
              </button>
              <button
                type="button"
                class="delta-recurring-group-toolbar__button${activeSort === "desc" ? " is-active" : ""}"
                data-machine-id="${escapeAttr(machineId)}"
                data-recurring-sort="desc"
              >
                Desc
              </button>
            </div>
          </div>
          <div class="delta-machine-panel__group-list-body">
        ${groups.map((group, index) => {
      const previewSrc = group.previewImageSrc ? urlForStatic(group.previewImageSrc) : "";
      const jobs = group.jobs.slice(0, 3);
      const remainingJobs = Math.max(group.jobs.length - jobs.length, 0);
      return `
        <article class="delta-defect-group-row">
          <div class="delta-defect-group-row__rank">${index + 1}</div>
          <button
            type="button"
            class="delta-defect-group-row__thumb${previewSrc ? "" : " is-empty"}"
            ${group.previewImageSrc ? `data-defect-group-image="${escapeAttr(group.previewImageSrc)}"` : "disabled"}
            aria-label="Open representative defect image"
          >
            ${previewSrc
              ? `<img src="${escapeAttr(previewSrc)}" alt="${escapeAttr(group.label)}" loading="lazy" decoding="async">`
              : `<span>No image</span>`}
          </button>
          <div class="delta-defect-group-row__main">
            <div class="delta-defect-group-row__header">
              <div>
                <strong>${escapeHtml(group.label)}</strong>
                <span>${escapeHtml(formatCount(group.jobs.length, "job"))} · ${escapeHtml(formatCount(group.coordinateGroups.length, "position cluster"))}</span>
              </div>
              <div class="delta-defect-group-row__count">${escapeHtml(formatCount(group.count, "hit"))}</div>
            </div>
            <div class="delta-defect-group-row__stats">
              ${renderRecurringStatPill("Job Range", formatFeetRange(group.stats.jobFeetMin, group.stats.jobFeetMax))}
              ${renderRecurringStatPill("Reel Range", formatFeetRange(group.stats.reelFeetMin, group.stats.reelFeetMax))}
              ${renderRecurringStatPill("Repeat Spread", formatFeetSpan(group.stats.jobFeetMin, group.stats.jobFeetMax))}
            </div>
            <div class="delta-defect-group-row__jobs">
              ${jobs.map((job) => `<span class="delta-defect-group-row__job">${escapeHtml(job)}</span>`).join("")}
              ${remainingJobs ? `<span class="delta-defect-group-row__job delta-defect-group-row__job--more">+${remainingJobs} more job${remainingJobs === 1 ? "" : "s"}</span>` : ""}
            </div>
            <div class="delta-defect-group-row__coordinate-groups">
              ${group.coordinateGroups.map((coordinateGroup) => {
      const coordinateOccurrences = sortRecurringOccurrences(coordinateGroup.occurrences, activeSort);
      const occurrencesByReel = groupRecurringOccurrencesByReel(coordinateOccurrences);
      const selectionKey = buildRecurringClusterSelectionKey(machineId, group.key, coordinateGroup.key);
      const activeOccurrenceIndex = normalizeRecurringClusterIndex(
        state.recurringClusterSelections.get(selectionKey),
        coordinateOccurrences.length,
      );
      return `
                <section class="delta-defect-coordinate-group">
                  <div class="delta-defect-coordinate-group__header">
                    <div>
                      <strong>${escapeHtml(coordinateGroup.label)}</strong>
                      <span>${escapeHtml(formatCount(coordinateGroup.count, "defect"))}</span>
                    </div>
                    <div class="delta-defect-coordinate-group__stats">
                      ${renderRecurringStatPill("Job", formatFeetRange(coordinateGroup.stats.jobFeetMin, coordinateGroup.stats.jobFeetMax))}
                      ${renderRecurringStatPill("Reel", formatFeetRange(coordinateGroup.stats.reelFeetMin, coordinateGroup.stats.reelFeetMax))}
                      ${renderRecurringStatPill("Spread", formatFeetSpan(coordinateGroup.stats.jobFeetMin, coordinateGroup.stats.jobFeetMax))}
                    </div>
                  </div>
                  <div class="delta-defect-coordinate-group__toolbar">
                    <span class="delta-defect-coordinate-group__status">${escapeHtml(`${activeOccurrenceIndex + 1}/${coordinateOccurrences.length}`)}</span>
                    <div class="delta-defect-coordinate-group__nav">
                      <button
                        type="button"
                        class="delta-defect-coordinate-group__nav-btn"
                        data-recurring-occurrence-nav="true"
                        data-machine-id="${escapeAttr(machineId)}"
                        data-group-key="${escapeAttr(group.key)}"
                        data-cluster-key="${escapeAttr(coordinateGroup.key)}"
                        data-direction="-1"
                      >
                        Prev
                      </button>
                      <button
                        type="button"
                        class="delta-defect-coordinate-group__nav-btn"
                        data-recurring-occurrence-nav="true"
                        data-machine-id="${escapeAttr(machineId)}"
                        data-group-key="${escapeAttr(group.key)}"
                        data-cluster-key="${escapeAttr(coordinateGroup.key)}"
                        data-direction="1"
                      >
                        Next
                      </button>
                    </div>
                  </div>
                  <div class="delta-defect-coordinate-group__occurrences">
                    ${occurrencesByReel.map((reelGroup) => `
                      <section class="delta-defect-reel-group">
                        <div class="delta-defect-reel-group__header">
                          <strong>${escapeHtml(formatRecurringReelGroupLabel(reelGroup))}</strong>
                          <span>${escapeHtml(formatCount(reelGroup.occurrences.length, "defect"))}</span>
                        </div>
                        <div class="delta-defect-reel-group__cards">
                    ${reelGroup.occurrences.map((occurrence) => {
      const occurrenceIndex = coordinateOccurrences.indexOf(occurrence);
      const imageSrc = occurrence.imageSrc ? urlForStatic(occurrence.imageSrc) : "";
      return `
                      <article class="delta-defect-occurrence-card${occurrenceIndex === activeOccurrenceIndex ? " is-active" : ""}" data-recurring-occurrence-card="${escapeAttr(selectionKey)}">
                        <button
                          type="button"
                          class="delta-defect-occurrence-card__image${imageSrc ? "" : " is-empty"}"
                          ${occurrence.imageSrc ? `data-defect-group-image="${escapeAttr(occurrence.imageSrc)}"` : "disabled"}
                          aria-label="Open defect image"
                        >
                          ${imageSrc
                            ? `<img src="${escapeAttr(imageSrc)}" alt="${escapeAttr(`${group.label} ${coordinateGroup.label}`)}" loading="lazy" decoding="async">`
                            : `<span>No image</span>`}
                        </button>
                        <button
                          type="button"
                          class="delta-defect-occurrence-card__jump"
                          data-defect-group-jump="${escapeAttr(occurrence.xValue)}"
                          title="${escapeAttr(`${occurrence.reelCode} · Reel ${formatNumber(occurrence.feetFromReelStart, 1)} ft · Job ${formatNumber(occurrence.jobFeetFromStart, 1)} ft · ${occurrence.jobLabel}`)}"
                        >
                          <strong>${escapeHtml(occurrence.reelCode)}</strong>
                          <span>Reel ${escapeHtml(formatNumber(occurrence.feetFromReelStart, 1))} ft</span>
                          <span>Job ${escapeHtml(formatNumber(occurrence.jobFeetFromStart, 1))} ft</span>
                        </button>
                      </article>
                    `;
    }).join("")}
                        </div>
                      </section>
                    `).join("")}
                  </div>
                </section>
              `;
    }).join("")}
            </div>
          </div>
        </article>
      `;
    }).join("")}
          </div>
        </div>
      </div>
    `;
  }

  function getMachinePatternData(machineId) {
    const machines = (state.patternData && state.patternData.machines) || [];
    return machines.find((item) => String(item && item.machineId || "") === String(machineId || "")) || null;
  }

  function resolvePatternClassKey(machineId, analyzer) {
    const options = Array.isArray(analyzer && analyzer.classOptions) ? analyzer.classOptions : [];
    const requested = state.patternClassFilters.get(String(machineId || "")) || "all";
    const valid = options.some((option) => String(option && option.key || "") === requested);
    const nextKey = valid ? requested : (options[0] && options[0].key) || "all";
    if (nextKey !== requested) {
      state.patternClassFilters.set(String(machineId || ""), nextKey);
    }
    return String(nextKey || "all");
  }

  function resolveSelectedPatternLocationGroup(machineId, locationGroups) {
    const groups = Array.isArray(locationGroups) ? locationGroups : [];
    const requested = state.patternSelectedLocationGroups.get(String(machineId || "")) || "";
    const selected = groups.find((group) => String(group && group.key || "") === requested) || null;
    if (!selected && requested) {
      state.patternSelectedLocationGroups.delete(String(machineId || ""));
    }
    return selected;
  }

  function movePatternLocationExample(machineId, groupKey, delta) {
    const analyzer = getMachinePatternData(machineId);
    if (!analyzer) return;
    const activeClassKey = resolvePatternClassKey(machineId, analyzer);
    const locationGroups = (analyzer.locationGroupsByClass && (analyzer.locationGroupsByClass[activeClassKey] || analyzer.locationGroupsByClass.all)) || [];
    const group = (Array.isArray(locationGroups) ? locationGroups : []).find((item) => String(item && item.key || "") === String(groupKey || ""));
    if (!group) return;
    const examples = Array.isArray(group.examples) ? group.examples : [];
    if (!examples.length) return;
    const selectionKey = `${machineId}:${groupKey}`;
    const currentIndex = Number(state.patternSelectedLocationExamples.get(selectionKey)) || 0;
    const nextIndex = (currentIndex + delta + examples.length) % examples.length;
    state.patternSelectedLocationExamples.set(selectionKey, nextIndex);
    const host = document.getElementById(`defectTrendsMachinePatternAnalyzer-${machineId}`);
    const machine = (((state.data && state.data.machines) || []).find((item) => String(item && item.machineId || "") === String(machineId || ""))) || null;
    renderMachinePatternAnalyzer(host, machine);
  }

  function renderMachinePatternAnalyzer(host, machine) {
    if (!host || !machine) return;
    const machineId = String(machine && machine.machineId || "");
    const analyzer = getMachinePatternData(machineId);
    if ((state.patternStatus === "idle" || state.patternStatus === "loading") && !analyzer) {
      host.innerHTML = '<div class="delta-trends-empty">Loading defect pattern analyzer…</div>';
      return;
    }
    if (state.patternStatus === "error") {
      host.innerHTML = `<div class="delta-trends-empty">${escapeHtml(state.patternError || "Unable to load defect pattern analyzer.")}</div>`;
      return;
    }
    if (!analyzer) {
      host.innerHTML = '<div class="delta-trends-empty">No pattern-analysis data available for the current filter state.</div>';
      return;
    }
    const activeClassKey = resolvePatternClassKey(machineId, analyzer);
    const classOptions = Array.isArray(analyzer.classOptions) ? analyzer.classOptions : [];
    const heatmapData = (analyzer.heatmapByClass && (analyzer.heatmapByClass[activeClassKey] || analyzer.heatmapByClass.all)) || null;
    const trendSeries = (analyzer.trendByClass && (analyzer.trendByClass[activeClassKey] || analyzer.trendByClass.all)) || [];
    const locationMap = (analyzer.locationMapByClass && (analyzer.locationMapByClass[activeClassKey] || analyzer.locationMapByClass.all)) || null;
    const locationGroups = (((analyzer.locationGroupsByClass && (analyzer.locationGroupsByClass[activeClassKey] || analyzer.locationGroupsByClass.all)) || [])
      .slice()
      .sort((left, right) => (
        (Number(right && right.uniqueReelCount) || 0) - (Number(left && left.uniqueReelCount) || 0)
        || (Number(right && right.count) || 0) - (Number(left && left.count) || 0)
        || (Number(right && right.avgMagnitude) || Number(right && right.avgSeverity) || 0) - (Number(left && left.avgMagnitude) || Number(left && left.avgSeverity) || 0)
      )));
    const selectedLocationGroup = resolveSelectedPatternLocationGroup(machineId, locationGroups);
    const baseSummaryCards = (analyzer.summaryCardsByClass && (analyzer.summaryCardsByClass[activeClassKey] || analyzer.summaryCardsByClass.all)) || [];
    const patternHeatmapData = heatmapData ? buildPatternHeatmapData(heatmapData) : null;
    const eventData = patternHeatmapData ? buildPatternEventData(machine, patternHeatmapData) : null;
    const eventInsights = patternHeatmapData ? buildPatternEventInsights(patternHeatmapData, eventData) : [];
    if (eventData) {
      eventData.insights = eventInsights;
    }
    const summaryCards = patternHeatmapData
      ? [...baseSummaryCards, ...eventInsights]
      : baseSummaryCards;
    const selectedReelIndex = Number(state.patternSelectedReels.get(machineId));
    host.innerHTML = `
      <div class="delta-pattern-analyzer">
        <div class="delta-pattern-analyzer__toolbar">
          <div>
            <p class="delta-pattern-analyzer__eyebrow">Pattern Focus</p>
            <h4>Defect Pattern Analyzer</h4>
          </div>
          <label class="delta-pattern-analyzer__filter">
            <span>Class Filter</span>
            <select data-pattern-class-filter="true" data-machine-id="${escapeAttr(machineId)}">
              ${classOptions.map((option) => `
                <option value="${escapeAttr(option.key)}"${String(option.key) === activeClassKey ? " selected" : ""}>
                  ${escapeHtml(option.label)} (${escapeHtml(formatNumber(option.count, 0))})
                </option>
              `).join("")}
            </select>
          </label>
        </div>
        <div class="delta-pattern-summary-grid">
          ${summaryCards.map((card) => `
            <article class="delta-pattern-summary-card delta-pattern-summary-card--${escapeAttr(card.tone || "neutral")}">
              <span>${escapeHtml(card.title || "Insight")}</span>
              <strong>${escapeHtml(card.body || "--")}</strong>
            </article>
          `).join("")}
        </div>
        <section class="delta-pattern-card delta-pattern-card--full">
          <div class="delta-pattern-card__header">
            <div>
              <strong>Reel Position Pattern Heatmap</strong>
              <span>Color intensity shows defect count by reel order and reel region, with severity kept in hover details.</span>
            </div>
          </div>
          <div id="defectPatternHeatmap-${machineId}" class="delta-pattern-card__chart delta-pattern-card__chart--heatmap"></div>
          <div id="defectPatternHeatmapDetail-${machineId}" class="delta-pattern-heatmap-detail"></div>
        </section>
        <section class="delta-pattern-card delta-pattern-card--full">
          <div class="delta-pattern-card__header">
            <div>
              <strong>Magnitude Trend by Reel Position</strong>
              <span>Smoothed region trends show whether defect magnitude is improving, worsening, or staying stable across reels.</span>
            </div>
          </div>
          <div id="defectPatternTrendSummary-${machineId}" class="delta-pattern-trend-summary"></div>
          <div id="defectPatternTrend-${machineId}" class="delta-pattern-card__chart delta-pattern-card__chart--trend"></div>
          <p class="delta-pattern-trend-caption">Lines show smoothed magnitude trends by reel region; shaded bands show process events aligned to reel order.</p>
        </section>
        <section class="delta-pattern-card">
          <div class="delta-pattern-card__header">
            <div>
              <strong>Defect Location Explorer</strong>
              <span>Grouped by where defects land on the normalized format, with real-image evidence behind each zone.</span>
            </div>
          </div>
          ${renderPatternLocationHighlights(locationGroups)}
          <div class="delta-pattern-location-layout">
            <div class="delta-pattern-location-group-grid">
              ${locationGroups.length
              ? locationGroups.map((group) => `
                <article
                  class="delta-pattern-location-card${selectedLocationGroup && selectedLocationGroup.key === group.key ? " is-selected" : ""}"
                  data-machine-id="${escapeAttr(machineId)}"
                  data-pattern-location-view="${escapeAttr(group.key)}"
                  tabindex="0"
                  role="button"
                  aria-pressed="${selectedLocationGroup && selectedLocationGroup.key === group.key ? "true" : "false"}"
                >
                  <div class="delta-pattern-location-card__header">
                    <div>
                      <strong>${escapeHtml(group.label || "Location Group")}</strong>
                      <span>${escapeHtml(formatNumber(group.sharePct, 1))}% of defects</span>
                    </div>
                    ${group.thumbnailSrc ? `<img src="${escapeAttr(urlForStatic(group.thumbnailSrc))}" alt="${escapeAttr(group.label || "Location group")}" loading="lazy" decoding="async" onerror="this.remove()">` : ""}
                  </div>
                  <div class="delta-pattern-location-card__metrics">
                    <article><span>Reels Affected</span><strong>${escapeHtml(formatNumber(group.uniqueReelCount, 0))}</strong></article>
                    <article><span>Defects</span><strong>${escapeHtml(formatNumber(group.count, 0))}</strong></article>
                    <article><span>Avg Severity</span><strong>${escapeHtml(formatMetric(group.avgSeverity))}</strong></article>
                    <article><span>Avg Magnitude</span><strong>${escapeHtml(formatMetric(group.avgMagnitude))}</strong></article>
                  </div>
                  <div class="delta-pattern-location-card__chips">
                    ${renderPatternBadge("Dominant Class", group.dominantClassName || "--")}
                  </div>
                </article>
              `).join("")
              : '<div class="delta-trends-empty">No location groups available for the current class filter.</div>'}
            </div>
          </div>
          ${selectedLocationGroup ? renderPatternLocationViewer(machineId, selectedLocationGroup) : ""}
        </section>
      </div>
    `;
    renderPatternHeatmap(
      document.getElementById(`defectPatternHeatmap-${machineId}`),
      heatmapData,
      machine,
      patternHeatmapData,
      eventData,
      selectedReelIndex,
      document.getElementById(`defectPatternHeatmapDetail-${machineId}`)
    );
    renderPatternTrend(
      document.getElementById(`defectPatternTrend-${machineId}`),
      trendSeries,
      document.getElementById(`defectPatternTrendSummary-${machineId}`),
      eventData
    );
  }

  function renderPatternBadge(label, value) {
    return `
      <span class="delta-pattern-badge">
        <strong>${escapeHtml(label)}</strong>
        <span>${escapeHtml(value)}</span>
      </span>
    `;
  }

  function describePatternLocationWhy(group) {
    const parts = [];
    if (group && group.label) parts.push(`Defects land in the ${group.label} zone of the normalized format`);
    if (group && group.dominantClassName) parts.push(`the dominant class is ${group.dominantClassName}`);
    if (Number.isFinite(Number(group && group.uniqueReelCount))) parts.push(`this zone repeats across ${formatNumber(group.uniqueReelCount, 0)} reels`);
    return parts.join(", ");
  }

  function renderPatternLocationHighlights(locationGroups) {
    const groups = Array.isArray(locationGroups) ? locationGroups : [];
    if (!groups.length) return "";
    const mostDefects = groups[0] || null;
    const mostReels = groups.slice().sort((left, right) => (
      (Number(right && right.uniqueReelCount) || 0) - (Number(left && left.uniqueReelCount) || 0)
      || (Number(right && right.count) || 0) - (Number(left && left.count) || 0)
    ))[0] || null;
    const highestSeverity = groups.slice().sort((left, right) => (
      (Number(right && right.avgSeverity) || 0) - (Number(left && left.avgSeverity) || 0)
      || (Number(right && right.count) || 0) - (Number(left && left.count) || 0)
    ))[0] || null;
    const items = [
      mostDefects ? `Most defects cluster in ${mostDefects.label}.` : "",
      mostReels ? `${mostReels.label} affects the most reels.` : "",
      highestSeverity ? `${highestSeverity.label} has the highest average severity.` : "",
    ].filter(Boolean);
    return `
      <div class="delta-pattern-location-highlights">
        ${items.map((item) => `<article>${escapeHtml(item)}</article>`).join("")}
      </div>
    `;
  }

  function inferExampleOverlayBounds(coords, formatWidth, formatLength) {
    const shapes = Array.isArray(coords) ? coords : [];
    const xs = [];
    const ys = [];
    shapes.forEach((shape) => {
      const shapeXs = Array.isArray(shape && shape.x) ? shape.x : [];
      const shapeYs = Array.isArray(shape && shape.y) ? shape.y : [];
      const count = Math.min(shapeXs.length, shapeYs.length);
      for (let index = 0; index < count; index += 1) {
        const x = Number(shapeXs[index]);
        const y = Number(shapeYs[index]);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          xs.push(x);
          ys.push(y);
        }
      }
    });
    if (!xs.length || !ys.length) {
      const width = Math.max(1, Number(formatWidth) || 100);
      const height = Math.max(1, Number(formatLength) || 100);
      return { viewBox: `0 0 ${width} ${height}`, strokeWidth: Math.max(width, height) * 0.01 };
    }
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const width = Math.max(maxX - minX, 1);
    const height = Math.max(maxY - minY, 1);
    const padX = width * 0.08;
    const padY = height * 0.08;
    return {
      viewBox: `${minX - padX} ${minY - padY} ${width + (padX * 2)} ${height + (padY * 2)}`,
      strokeWidth: Math.max(width, height) * 0.018,
    };
  }

  function renderPatternExampleOverlay(example) {
    const coords = Array.isArray(example && example.coords) ? example.coords : [];
    if (!coords.length) return "";
    const bounds = inferExampleOverlayBounds(coords, example && example.formatWidth, example && example.formatLength);
    const polygons = coords.map((shape, index) => {
      const xs = Array.isArray(shape && shape.x) ? shape.x : [];
      const ys = Array.isArray(shape && shape.y) ? shape.y : [];
      const count = Math.min(xs.length, ys.length);
      if (count < 3) return "";
      const points = Array.from({ length: count }, (_, pointIndex) => `${xs[pointIndex]},${ys[pointIndex]}`).join(" ");
      const fill = index === 0 ? "rgba(239, 68, 68, 0.16)" : "rgba(249, 115, 22, 0.13)";
      const stroke = index === 0 ? "rgba(220, 38, 38, 0.96)" : "rgba(234, 88, 12, 0.9)";
      return `<polygon points="${escapeAttr(points)}" fill="${fill}" stroke="${stroke}" stroke-width="${escapeAttr(bounds.strokeWidth)}"></polygon>`;
    }).join("");
    return `
      <svg class="delta-pattern-family-viewer__overlay" viewBox="${escapeAttr(bounds.viewBox)}" preserveAspectRatio="xMidYMid meet" aria-label="Defect polygon overlay">
        ${polygons}
      </svg>
    `;
  }

  function describePatternLocationZone(colIndex, rowIndex, cols, rows) {
    const horizontal = describePatternLocationAxis(colIndex, cols, "x");
    const vertical = describePatternLocationAxis(rowIndex, rows, "y");
    if (horizontal === "Center" && vertical === "Center") return "Center";
    if (horizontal === "Center") return `${vertical} Center`;
    if (vertical === "Center") return `${horizontal} Center`;
    return `${horizontal} / ${vertical}`;
  }

  function describePatternLocationAxis(index, total, axis) {
    if (total <= 1) return "Center";
    const ratio = index / Math.max(total - 1, 1);
    if (axis === "x") {
      if (ratio <= 0.15) return "Left Edge";
      if (ratio <= 0.35) return "Left";
      if (ratio < 0.65) return "Center";
      if (ratio < 0.85) return "Right";
      return "Right Edge";
    }
    if (ratio <= 0.15) return "Top Edge";
    if (ratio <= 0.35) return "Upper";
    if (ratio < 0.65) return "Center";
    if (ratio < 0.85) return "Lower";
    return "Bottom Edge";
  }

  function renderPatternLocationViewer(machineId, group) {
    const examples = Array.isArray(group && group.examples) ? group.examples : [];
    if (!examples.length) {
      return '<div class="delta-trends-empty">No real-image examples are available for this location group.</div>';
    }
    const selectionKey = `${machineId}:${group.key}`;
    const selectedIndex = Math.max(0, Math.min(Number(state.patternSelectedLocationExamples.get(selectionKey)) || 0, examples.length - 1));
    const example = examples[selectedIndex] || examples[0];
    const imageSrc = example && example.imageSrc ? urlForStatic(example.imageSrc) : "";
    return `
      <section class="delta-pattern-family-viewer">
        <div class="delta-pattern-family-viewer__header">
          <div>
            <p class="delta-pattern-analyzer__eyebrow">Evidence Viewer</p>
            <h5>${escapeHtml(group.label || "Location Group")}</h5>
            <p>${escapeHtml(describePatternLocationWhy(group))}</p>
          </div>
          <button type="button" class="delta-machine-panel__group-list-toggle" data-pattern-location-close="true" data-machine-id="${escapeAttr(machineId)}">Close viewer</button>
        </div>
        <div class="delta-pattern-family-viewer__summary">
          ${renderPatternBadge("Zone", group.label || "--")}
          ${renderPatternBadge("Dominant Class", group.dominantClassName || "--")}
          ${renderPatternBadge("Reels Affected", formatNumber(group.uniqueReelCount, 0))}
          ${renderPatternBadge("Defect Count", formatNumber(group.count, 0))}
          ${renderPatternBadge("Avg Severity", formatMetric(group.avgSeverity))}
          ${renderPatternBadge("Avg Magnitude", formatMetric(group.avgMagnitude))}
        </div>
        <div class="delta-pattern-family-viewer__body">
          <div class="delta-pattern-family-viewer__main">
            <div class="delta-pattern-family-viewer__toolbar">
              <button type="button" class="delta-machine-panel__group-list-toggle" data-machine-id="${escapeAttr(machineId)}" data-group-key="${escapeAttr(group.key)}" data-pattern-location-example-nav="true" data-direction="-1">Prev</button>
              <span>Example ${escapeHtml(formatNumber(selectedIndex + 1, 0))} of ${escapeHtml(formatNumber(examples.length, 0))}</span>
              <button type="button" class="delta-machine-panel__group-list-toggle" data-machine-id="${escapeAttr(machineId)}" data-group-key="${escapeAttr(group.key)}" data-pattern-location-example-nav="true" data-direction="1">Next</button>
            </div>
            <div class="delta-pattern-family-viewer__image-shell${imageSrc ? "" : " is-empty"}">
              ${imageSrc
                ? `
                  <img
                    src="${escapeAttr(imageSrc)}"
                    alt="${escapeAttr(`${group.label || "Location Group"} example ${selectedIndex + 1}`)}"
                    loading="lazy"
                    decoding="async"
                    onerror="this.closest('.delta-pattern-family-viewer__image-shell').classList.add('is-broken'); this.remove();"
                  >
                  ${renderPatternExampleOverlay(example)}
                `
                : '<div class="delta-pattern-family-viewer__fallback">No image available for this example</div>'}
              <div class="delta-pattern-family-viewer__fallback">Image unavailable</div>
            </div>
            <div class="delta-pattern-family-viewer__thumbs">
              ${examples.slice(0, 10).map((item, index) => {
      const thumbSrc = item && item.imageSrc ? urlForStatic(item.imageSrc) : "";
      const isActive = index === selectedIndex;
      return `
                <button
                  type="button"
                  class="delta-pattern-family-viewer__thumb${isActive ? " is-active" : ""}"
                  data-machine-id="${escapeAttr(machineId)}"
                  data-group-key="${escapeAttr(group.key)}"
                  data-pattern-location-thumb="${escapeAttr(index)}"
                  title="${escapeAttr((item.selectionTags || []).join(", ") || `Example ${index + 1}`)}"
                >
                  ${thumbSrc
                    ? `<img src="${escapeAttr(thumbSrc)}" alt="${escapeAttr(`Example ${index + 1}`)}" loading="lazy" decoding="async" onerror="this.remove()">`
                    : `<span>${escapeHtml(formatNumber(index + 1, 0))}</span>`}
                </button>
              `;
    }).join("")}
            </div>
          </div>
          <aside class="delta-pattern-family-viewer__meta">
            <article class="delta-pattern-family-viewer__meta-card">
              <span>Grouping Basis</span>
              <strong>${escapeHtml(group.label || "Location Group")}</strong>
              <p>${escapeHtml("Grouped by normalized defect centroid on the format map using a coarse 5 x 5 location grid.")}</p>
            </article>
            <article class="delta-pattern-family-viewer__meta-card">
              <span>Example Tags</span>
              <strong>${escapeHtml((example.selectionTags || []).join(" · ") || (example.isOutlier ? "Outlier" : "Representative example"))}</strong>
              <p>${escapeHtml(example.isOutlier ? "This example sits farther from the family center than the most typical members." : "This example is representative of the family grouping.")}</p>
            </article>
            <article class="delta-pattern-family-viewer__meta-card">
              <span>Defect Context</span>
              <strong>${escapeHtml(example.className || "--")}</strong>
              <p>
                ${escapeHtml(`Magnitude ${formatMetric(example.magnitudeValue)} · Severity ${formatMetric(example.severityValue)}`)}<br>
                ${escapeHtml(`Format zone ${example.locationLabel || group.label || "--"} · Reel region ${example.bucketLabel || "--"} · Format position ${formatNumber(example.formatPosition, 2)}`)}<br>
                ${escapeHtml(`Reel ${example.reelCode || "--"} (#${formatNumber(example.reelIndex, 0)}) · ${example.jobLabel || "--"}`)}<br>
                ${escapeHtml(`Format ${formatNumber(example.formatWidth, 2)} x ${formatNumber(example.formatLength, 2)}`)}<br>
                ${escapeHtml(`Time ${example.defectTime || "--"}`)}
              </p>
            </article>
          </aside>
        </div>
      </section>
    `;
  }

  function buildPatternChartLayout({ xTitle, yTitle, showLegend = false }) {
    const isDark = document.body.classList.contains("dark-mode");
    const textColor = readThemeColor("--text-primary", isDark ? "#e2e8f0" : "#0f172a");
    const gridColor = isDark ? "rgba(148, 163, 184, 0.16)" : "rgba(148, 163, 184, 0.18)";
    const hoverBg = readThemeColor("--surface", isDark ? "#0f172a" : "#ffffff");
    const hoverBorder = readThemeColor("--border", isDark ? "#334155" : "#cbd5e1");
    return {
      autosize: true,
      paper_bgcolor: "transparent",
      plot_bgcolor: "transparent",
      margin: { t: 24, r: 18, b: 62, l: 58 },
      showlegend: !!showLegend,
      legend: {
        orientation: "h",
        x: 0,
        y: 1.18,
        font: { color: textColor },
      },
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
        type: "category",
        tickangle: -35,
      },
      yaxis: {
        title: yTitle,
        automargin: true,
        color: textColor,
        gridcolor: gridColor,
      },
    };
  }

  function renderPatternHeatmap(host, heatmapData, machine = null, patternDataInput = null, eventDataInput = null, selectedReelIndexInput = null, detailHost = null) {
    if (!host) return;
    if (!heatmapData || !Array.isArray(heatmapData.z) || !heatmapData.z.length) {
      host.innerHTML = '<div class="delta-trends-empty">No position pattern data available.</div>';
      return;
    }
    const reelLabels = Array.isArray(heatmapData.reelLabels) ? heatmapData.reelLabels : [];
    const bucketLabels = Array.isArray(heatmapData.bucketLabels) ? heatmapData.bucketLabels : [];
    const maxCount = Math.max(0, ...heatmapData.z.flat().map((value) => Number(value) || 0));
    if (!maxCount) {
      host.innerHTML = '<div class="delta-trends-empty">No defect counts available for the current pattern view.</div>';
      return;
    }
    const patternData = patternDataInput || buildPatternHeatmapData(heatmapData);
    const eventData = eventDataInput || buildPatternEventData(machine, patternData);
    const machineId = String(machine && machine.machineId || "");
    const selectedReelIndex = Number.isInteger(Number(selectedReelIndexInput))
      ? Number(selectedReelIndexInput)
      : (eventData && eventData.highlightedReels && eventData.highlightedReels[0] ? eventData.highlightedReels[0].reelIndex : 0);
    host.innerHTML = `
      <div class="delta-pattern-heatmap-shell">
        ${renderPatternDistributionBar(patternData)}
        ${renderPatternDominantRegionStrip(patternData)}
        ${renderPatternEventImpactPanel(eventData)}
        <div class="delta-pattern-heatmap-chart" data-pattern-heatmap-chart="true"></div>
      </div>
    `;
    const chartHost = host.querySelector('[data-pattern-heatmap-chart="true"]');
    const xPositions = reelLabels.map((_, index) => index + 1);
    const tickConfig = buildSparseNumericCategoryTicks(xPositions, reelLabels, 14);
    const hoverMatrix = buildPatternHeatmapHoverMatrix(patternData, eventData);
    const textMatrix = patternData.pctMatrix.map((row) => (
      Array.isArray(row)
        ? row.map((value) => (Number.isFinite(Number(value)) && reelLabels.length <= 14 ? `${formatNumber(value, 0)}%` : ""))
        : []
    ));
    const maxDeviation = Math.max(5, ...patternData.deviationMatrix.flat().map((value) => Math.abs(Number(value) || 0)));
    const traces = [
      {
        type: "heatmap",
        x: xPositions,
        y: bucketLabels,
        z: patternData.deviationMatrix,
        text: textMatrix,
        texttemplate: "%{text}",
        textfont: { size: 10 },
        colorscale: [
          [0, "#b91c1c"],
          [0.25, "#fca5a5"],
          [0.5, "#f8fafc"],
          [0.75, "#93c5fd"],
          [1, "#1d4ed8"],
        ],
        zmid: 0,
        zmin: -maxDeviation,
        zmax: maxDeviation,
        hovertemplate: "%{customdata}<extra></extra>",
        customdata: hoverMatrix,
        colorbar: { title: "Deviation vs Avg %", thickness: 12, ticksuffix: " pts" },
      },
      ...buildPatternEventMarkerTraces(patternData, eventData),
    ];
    window.Plotly.react(chartHost, traces, {
      ...buildPatternChartLayout({ xTitle: "Reel Order", yTitle: "Reel Region" }),
      xaxis: {
        ...buildPatternChartLayout({ xTitle: "Reel Order", yTitle: "Reel Region" }).xaxis,
        tickmode: "array",
        tickvals: tickConfig.tickvals,
        ticktext: tickConfig.ticktext,
        tickangle: reelLabels.length > 16 ? 0 : -25,
        type: "linear",
        range: [0.5, xPositions.length + 0.5],
      },
      yaxis: {
        ...buildPatternChartLayout({ xTitle: "Reel Order", yTitle: "Reel Region" }).yaxis,
        autorange: "reversed",
      },
      shapes: buildPatternEventShapes(selectedReelIndex),
    }, getPlotConfig());
    if (detailHost) {
      renderPatternSelectedReelDetail(detailHost, patternData, eventData, selectedReelIndex, machineId);
    }
    if (chartHost && typeof chartHost.on === "function") {
      chartHost.removeAllListeners?.("plotly_click");
      chartHost.on("plotly_click", (plotEvent) => {
        const point = plotEvent && plotEvent.points && plotEvent.points[0];
        if (!point) return;
        const xValue = Number(point.x);
        if (!Number.isFinite(xValue)) return;
        state.patternSelectedReels.set(machineId, Math.max(0, Math.round(xValue) - 1));
        const analyzerHost = document.getElementById(`defectTrendsMachinePatternAnalyzer-${machineId}`);
        renderMachinePatternAnalyzer(analyzerHost, machine);
      });
    }
  }

  function buildPatternHeatmapData(heatmapData) {
    const reels = Array.isArray(heatmapData && heatmapData.reels) ? heatmapData.reels : [];
    const bucketLabels = Array.isArray(heatmapData && heatmapData.bucketLabels) ? heatmapData.bucketLabels : [];
    const countsMatrix = Array.isArray(heatmapData && heatmapData.z) ? heatmapData.z : [];
    const avgSeverityMatrix = Array.isArray(heatmapData && heatmapData.avgSeverity) ? heatmapData.avgSeverity : [];
    const rawHoverMatrix = Array.isArray(heatmapData && heatmapData.hover) ? heatmapData.hover : [];
    const reelTotals = reels.map((_, reelIndex) => countsMatrix.reduce((sum, row) => sum + (Number(row && row[reelIndex]) || 0), 0));
    const bucketTotals = bucketLabels.map((_, bucketIndex) => countsMatrix[bucketIndex].reduce((sum, value) => sum + (Number(value) || 0), 0));
    const overallTotal = bucketTotals.reduce((sum, value) => sum + value, 0);
    const globalPctByBucket = bucketTotals.map((count) => overallTotal > 0 ? (count / overallTotal) * 100 : 0);
    const pctMatrix = countsMatrix.map((row, bucketIndex) => row.map((value, reelIndex) => {
      const reelTotal = reelTotals[reelIndex];
      if (!reelTotal) return null;
      return ((Number(value) || 0) / reelTotal) * 100;
    }));
    const deviationMatrix = pctMatrix.map((row, bucketIndex) => row.map((value) => (
      Number.isFinite(Number(value)) ? Number((Number(value) - globalPctByBucket[bucketIndex]).toFixed(2)) : null
    )));
    const reelSummaries = reels.map((reel, reelIndex) => {
      const percentages = bucketLabels.map((label, bucketIndex) => ({
        label,
        count: Number(countsMatrix[bucketIndex] && countsMatrix[bucketIndex][reelIndex]) || 0,
        pct: Number.isFinite(Number(pctMatrix[bucketIndex] && pctMatrix[bucketIndex][reelIndex]))
          ? Number(pctMatrix[bucketIndex][reelIndex])
          : 0,
        avgSeverity: Number(avgSeverityMatrix[bucketIndex] && avgSeverityMatrix[bucketIndex][reelIndex]),
        dominantClass: extractHoverField(rawHoverMatrix[bucketIndex] && rawHoverMatrix[bucketIndex][reelIndex], "Dominant class"),
      }));
      const sortedPercentages = percentages.slice().sort((left, right) => right.pct - left.pct);
      const dominant = sortedPercentages[0] || { label: "Unknown", pct: 0 };
      const bucketBaseline = bucketLabels.length ? 100 / bucketLabels.length : 0;
      const strength = bucketBaseline < 100
        ? Math.max(0, Math.min(1, (dominant.pct - bucketBaseline) / (100 - bucketBaseline)))
        : 0;
      return {
        reel,
        reelIndex,
        totalDefects: reelTotals[reelIndex],
        percentages,
        dominantLabel: dominant.label,
        dominantPct: dominant.pct,
        dominantClass: dominant.dominantClass || "",
        patternStrength: strength,
      };
    });
    return {
      reels,
      bucketLabels,
      countsMatrix,
      avgSeverityMatrix,
      pctMatrix,
      deviationMatrix,
      globalPctByBucket,
      reelSummaries,
      rawHoverMatrix,
    };
  }

  function buildPatternHeatmapHoverMatrix(patternData, eventData) {
    const bucketLabels = Array.isArray(patternData && patternData.bucketLabels) ? patternData.bucketLabels : [];
    const reels = Array.isArray(patternData && patternData.reels) ? patternData.reels : [];
    const summaries = Array.isArray(patternData && patternData.reelSummaries) ? patternData.reelSummaries : [];
    return bucketLabels.map((bucketLabel, bucketIndex) => reels.map((reel, reelIndex) => {
      const summary = summaries[reelIndex];
      const pct = patternData.pctMatrix[bucketIndex] && patternData.pctMatrix[bucketIndex][reelIndex];
      const deviation = patternData.deviationMatrix[bucketIndex] && patternData.deviationMatrix[bucketIndex][reelIndex];
      const avgSeverity = patternData.avgSeverityMatrix[bucketIndex] && patternData.avgSeverityMatrix[bucketIndex][reelIndex];
      const dominantClass = summary && summary.dominantClass ? summary.dominantClass : extractHoverField(patternData.rawHoverMatrix[bucketIndex] && patternData.rawHoverMatrix[bucketIndex][reelIndex], "Dominant class") || "--";
      const cellEvents = ((eventData && eventData.cellEventMap && eventData.cellEventMap.get(`${reelIndex}:${bucketIndex}`)) || []);
      const eventText = cellEvents.length
        ? cellEvents.map((event) => event.detail).join(" | ")
        : "None";
      return [
        `<b>${escapeHtml((reel && reel.reelCode) || `#${reelIndex + 1}`)}</b>`,
        `Region: ${escapeHtml(bucketLabel)}`,
        `Deviation vs avg: ${escapeHtml(formatNumber(deviation, 1))} pts`,
        `Defect count: ${escapeHtml(formatNumber(summary && summary.totalDefects, 0))}`,
        `Avg severity: ${escapeHtml(formatNumber(avgSeverity, 2))}`,
        `Dominant class: ${escapeHtml(dominantClass)}`,
        `Events: ${escapeHtml(eventText)}`,
      ].join("<br>");
    }));
  }

  function buildPatternEventData(machine, patternData) {
    const reels = Array.isArray(patternData && patternData.reels) ? patternData.reels : [];
    const referenceEvents = Array.isArray(machine && machine.referenceImageEvents) ? machine.referenceImageEvents : [];
    const speedPoints = Array.isArray(machine && machine.speedPoints) ? machine.speedPoints : [];
    const machineReels = Array.isArray(machine && machine.reels) ? machine.reels : [];
    const machineReelMap = new Map(machineReels.map((reel) => [String(reel && reel.reelId || ""), reel]));
    const reelEventMap = new Map(reels.map((reel, index) => [String(reel && reel.reelId || ""), {
      reel,
      reelIndex: index,
      events: [],
      eventLabels: [],
    }]));
    const cellEventMap = new Map();

    referenceEvents.forEach((event) => {
      const reelId = String(event && event.reelId || "");
      const target = reelEventMap.get(reelId);
      if (!target) return;
      const reelRow = machineReelMap.get(reelId);
      const bucketIndex = resolvePatternEventBucketIndex(event, target.reel, reelRow, patternData.bucketLabels);
      const nextLabel = `Reference image change${event && event.filename ? `: ${event.filename}` : ""}`;
      const eventPayload = {
        type: "reference",
        shortLabel: "Ref",
        detail: nextLabel,
        bucketIndex,
      };
      target.events.push(eventPayload);
      target.eventLabels.push(nextLabel);
      appendPatternCellEvent(cellEventMap, target.reelIndex, bucketIndex, eventPayload);
    });

    const speedPointsByReel = new Map();
    speedPoints.forEach((point) => {
      const reelId = String(point && point.reelId || "");
      if (!reelId || !reelEventMap.has(reelId)) return;
      if (!speedPointsByReel.has(reelId)) speedPointsByReel.set(reelId, []);
      speedPointsByReel.get(reelId).push(point);
    });
    const allAbsDeltas = [];
    const reelSpeedStats = new Map();
    speedPointsByReel.forEach((points, reelId) => {
      const orderedPoints = points.slice().sort((a, b) => {
        const af = Number(a && a.feetFromReelStart);
        const bf = Number(b && b.feetFromReelStart);
        if (Number.isFinite(af) && Number.isFinite(bf) && af !== bf) return af - bf;
        const at = a && a.time ? new Date(a.time).getTime() : 0;
        const bt = b && b.time ? new Date(b.time).getTime() : 0;
        return at - bt;
      });
      let previousSpeed = null;
      let spikeCount = 0;
      let peakAbsDelta = 0;
      orderedPoints.forEach((point) => {
        const speed = Number(point && point.webspeed);
        if (!Number.isFinite(speed)) return;
        if (Number.isFinite(previousSpeed)) {
          const absDelta = Math.abs(speed - previousSpeed);
          allAbsDeltas.push(absDelta);
          peakAbsDelta = Math.max(peakAbsDelta, absDelta);
        }
        previousSpeed = speed;
      });
      reelSpeedStats.set(reelId, { orderedPoints, spikeCount, peakAbsDelta });
    });
    const speedThreshold = Math.max(5, percentile(allAbsDeltas, 0.85));
    reelSpeedStats.forEach((stats, reelId) => {
      let previousSpeed = null;
      let spikeCount = 0;
      let peakAbsDelta = 0;
      const spikes = [];
      stats.orderedPoints.forEach((point) => {
        const speed = Number(point && point.webspeed);
        if (!Number.isFinite(speed)) return;
        if (Number.isFinite(previousSpeed)) {
          const absDelta = Math.abs(speed - previousSpeed);
          peakAbsDelta = Math.max(peakAbsDelta, absDelta);
          if (absDelta >= speedThreshold) {
            spikeCount += 1;
            spikes.push({ point, absDelta });
          }
        }
        previousSpeed = speed;
      });
      const target = reelEventMap.get(reelId);
      if (!target || spikeCount <= 0) return;
      const label = `Speed deviation: ${spikeCount} spike${spikeCount === 1 ? "" : "s"} · peak ${formatNumber(peakAbsDelta, 1)}`;
      target.events.push({
        type: "speed",
        shortLabel: spikeCount > 1 ? `Spd ${spikeCount}` : "Spd",
        detail: label,
      });
      target.eventLabels.push(label);
      const reelRow = machineReelMap.get(reelId);
      spikes.forEach((spike) => {
        const bucketIndex = resolvePatternEventBucketIndex(spike.point, target.reel, reelRow, patternData.bucketLabels);
        appendPatternCellEvent(cellEventMap, target.reelIndex, bucketIndex, {
          type: "speed",
          shortLabel: "Spd",
          detail: `Speed deviation ${formatNumber(spike.absDelta, 1)}`,
          bucketIndex,
        });
      });
    });

    const reelSummaries = reels.map((reel, index) => {
      const entry = reelEventMap.get(String(reel && reel.reelId || "")) || { events: [], eventLabels: [] };
      const patternSummary = (patternData && patternData.reelSummaries && patternData.reelSummaries[index]) || null;
      const maxDeviation = patternSummary
        ? Math.max(...(patternSummary.percentages || []).map((item, bucketIndex) => Math.abs(Number(patternData.deviationMatrix[bucketIndex] && patternData.deviationMatrix[bucketIndex][index]) || 0)), 0)
        : 0;
      const isMeaningful = !!entry.events.length && (
        (patternSummary && patternSummary.patternStrength >= 0.32)
        || maxDeviation >= 8
      );
      return {
        reel,
        reelIndex: index,
        events: entry.events,
        eventLabels: entry.eventLabels,
        hasEvents: !!entry.events.length,
        isMeaningful,
        maxDeviation,
        patternStrength: patternSummary ? Number(patternSummary.patternStrength) || 0 : 0,
      };
    });
    let highlightedReels = reelSummaries.filter((item) => item.isMeaningful);
    if (!highlightedReels.length) {
      highlightedReels = reelSummaries.filter((item) => item.hasEvents);
    }
    highlightedReels.sort((left, right) => (
      (Number(right.patternStrength) || 0) - (Number(left.patternStrength) || 0)
      || (Number(right.maxDeviation) || 0) - (Number(left.maxDeviation) || 0)
      || (right.events.length - left.events.length)
    ));
    if (highlightedReels.length > Math.max(12, Math.ceil(reelSummaries.length * 0.35))) {
      highlightedReels = highlightedReels.slice(0, Math.max(8, Math.ceil(reelSummaries.length * 0.2)));
    }
    const highlightedReelIndexSet = new Set(highlightedReels.map((item) => item.reelIndex));
    const filteredCellEventMap = new Map();
    cellEventMap.forEach((events, key) => {
      const [reelIndexText] = String(key || "").split(":");
      const reelIndex = Number(reelIndexText);
      if (!highlightedReelIndexSet.has(reelIndex)) return;
      filteredCellEventMap.set(key, events);
    });
    return {
      speedThreshold,
      reelSummaries,
      highlightedReels,
      cellEventMap: filteredCellEventMap,
      eventReelIndices: highlightedReels.map((item) => item.reelIndex),
    };
  }

  function appendPatternCellEvent(cellEventMap, reelIndex, bucketIndex, eventPayload) {
    if (!(cellEventMap instanceof Map) || !Number.isInteger(reelIndex) || !Number.isInteger(bucketIndex)) return;
    const key = `${reelIndex}:${bucketIndex}`;
    if (!cellEventMap.has(key)) cellEventMap.set(key, []);
    cellEventMap.get(key).push(eventPayload);
  }

  function resolvePatternEventBucketIndex(event, analyzerReel, machineReel, bucketLabels) {
    const bucketCount = Math.max(Array.isArray(bucketLabels) ? bucketLabels.length : 0, 1);
    const localFeet = Number(event && event.feetFromReelStart);
    const reelFeetTotal = Number((analyzerReel && analyzerReel.reelFeetTotal) || (machineReel && machineReel.reelFeetTotal));
    let ratio = null;
    if (Number.isFinite(localFeet) && Number.isFinite(reelFeetTotal) && reelFeetTotal > 0) {
      ratio = localFeet / reelFeetTotal;
    } else {
      const eventTime = event && event.time ? new Date(event.time).getTime() : NaN;
      const startTime = machineReel && machineReel.timeStart ? new Date(machineReel.timeStart).getTime() : NaN;
      const endTime = machineReel && machineReel.timeEnd ? new Date(machineReel.timeEnd).getTime() : NaN;
      if (Number.isFinite(eventTime) && Number.isFinite(startTime) && Number.isFinite(endTime) && endTime > startTime) {
        ratio = (eventTime - startTime) / (endTime - startTime);
      }
    }
    const normalizedRatio = Math.max(0, Math.min(0.999999, Number.isFinite(ratio) ? ratio : 0.5));
    return Math.min(bucketCount - 1, Math.floor(normalizedRatio * bucketCount));
  }

  function percentile(valuesInput, ratio = 0.5) {
    const values = (Array.isArray(valuesInput) ? valuesInput : [])
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => a - b);
    if (!values.length) return 0;
    const clampedRatio = Math.max(0, Math.min(1, Number(ratio) || 0));
    const index = Math.min(values.length - 1, Math.max(0, Math.floor(clampedRatio * (values.length - 1))));
    return values[index];
  }

  function buildPatternEventInsights(patternData, eventData) {
    if (!patternData || !eventData) return [];
    const withEvents = eventData.reelSummaries.filter((item) => item.hasEvents);
    const withoutEvents = eventData.reelSummaries.filter((item) => !item.hasEvents);
    if (!withEvents.length || !withoutEvents.length) return [];
    const withIndices = withEvents.map((item) => item.reelIndex);
    const withoutIndices = withoutEvents.map((item) => item.reelIndex);
    const withBucketAverages = averageBucketsForReels(patternData, withIndices);
    const withoutBucketAverages = averageBucketsForReels(patternData, withoutIndices);
    const bucketDiffs = patternData.bucketLabels.map((label, index) => ({
      label,
      diff: (withBucketAverages[index] || 0) - (withoutBucketAverages[index] || 0),
    })).sort((left, right) => Math.abs(right.diff) - Math.abs(left.diff));
    const topBucketShift = bucketDiffs[0];
    const withSeverity = weightedSeverityForReels(patternData, withIndices);
    const withoutSeverity = weightedSeverityForReels(patternData, withoutIndices);
    const withSpikeRate = withEvents.filter((item) => {
      const summary = patternData.reelSummaries[item.reelIndex];
      return summary && summary.patternStrength >= 0.35;
    }).length / Math.max(withEvents.length, 1);
    const withoutSpikeRate = withoutEvents.filter((item) => {
      const summary = patternData.reelSummaries[item.reelIndex];
      return summary && summary.patternStrength >= 0.35;
    }).length / Math.max(withoutEvents.length, 1);
    const cards = [];
    if (topBucketShift && Math.abs(topBucketShift.diff) >= 6) {
      cards.push({
        title: "Event Shift",
        body: `Reels with events lean ${topBucketShift.diff > 0 ? "more" : "less"} toward ${topBucketShift.label} by ${formatNumber(Math.abs(topBucketShift.diff), 1)} pts.`,
        tone: "info",
      });
    }
    if (Number.isFinite(withSeverity) && Number.isFinite(withoutSeverity) && Math.abs(withSeverity - withoutSeverity) >= 0.2) {
      cards.push({
        title: "Event Severity",
        body: `Reels with events average ${formatNumber(Math.abs(withSeverity - withoutSeverity), 2)} ${withSeverity > withoutSeverity ? "higher" : "lower"} severity than reels without events.`,
        tone: withSeverity > withoutSeverity ? "warn" : "info",
      });
    }
    if (Math.abs(withSpikeRate - withoutSpikeRate) >= 0.12) {
      cards.push({
        title: "Pattern Strength",
        body: `Strong region spikes appear on ${formatNumber(withSpikeRate * 100, 0)}% of event reels vs ${formatNumber(withoutSpikeRate * 100, 0)}% without events.`,
        tone: withSpikeRate > withoutSpikeRate ? "strong" : "neutral",
      });
    }
    return cards.slice(0, 3);
  }

  function averageBucketsForReels(patternData, reelIndices) {
    const indices = Array.isArray(reelIndices) ? reelIndices : [];
    return (Array.isArray(patternData && patternData.bucketLabels) ? patternData.bucketLabels : []).map((_, bucketIndex) => {
      const values = indices
        .map((reelIndex) => Number(patternData.pctMatrix[bucketIndex] && patternData.pctMatrix[bucketIndex][reelIndex]))
        .filter((value) => Number.isFinite(value));
      if (!values.length) return 0;
      return values.reduce((sum, value) => sum + value, 0) / values.length;
    });
  }

  function weightedSeverityForReels(patternData, reelIndices) {
    const indices = new Set(Array.isArray(reelIndices) ? reelIndices : []);
    let severityTotal = 0;
    let countTotal = 0;
    (patternData.avgSeverityMatrix || []).forEach((row, bucketIndex) => {
      (row || []).forEach((severity, reelIndex) => {
        if (!indices.has(reelIndex)) return;
        const count = Number(patternData.countsMatrix[bucketIndex] && patternData.countsMatrix[bucketIndex][reelIndex]) || 0;
        const value = Number(severity);
        if (!count || !Number.isFinite(value)) return;
        severityTotal += value * count;
        countTotal += count;
      });
    });
    return countTotal ? severityTotal / countTotal : NaN;
  }

  function renderPatternEventImpactPanel(eventData) {
    const insightCards = Array.isArray(eventData && eventData.insights) ? eventData.insights : [];
    if (!insightCards.length) return "";
    return `
      <div class="delta-pattern-impact-panel">
        <div class="delta-pattern-impact-panel__header">
          <strong>Event Impact Summary</strong>
          <span>Event reels are compared against reels without events.</span>
        </div>
        <div class="delta-pattern-impact-panel__grid">
          ${insightCards.map((card) => `
            <article class="delta-pattern-impact-panel__card delta-pattern-summary-card--${escapeAttr(card.tone || "neutral")}">
              <span>${escapeHtml(card.title || "Insight")}</span>
              <strong>${escapeHtml(card.body || "--")}</strong>
            </article>
          `).join("")}
        </div>
      </div>
    `;
  }

  function buildPatternEventMarkerTraces(patternData, eventData) {
    const cellEventMap = eventData && eventData.cellEventMap instanceof Map ? eventData.cellEventMap : new Map();
    if (!cellEventMap.size) return [];
    const bucketLabels = Array.isArray(patternData && patternData.bucketLabels) ? patternData.bucketLabels : [];
    const pointsByType = {
      reference: { x: [], y: [], text: [], size: [], textValues: [] },
      speed: { x: [], y: [], text: [], size: [], textValues: [] },
    };
    cellEventMap.forEach((events, key) => {
      const [reelIndexText, bucketIndexText] = String(key || "").split(":");
      const reelIndex = Number(reelIndexText);
      const bucketIndex = Number(bucketIndexText);
      const bucketLabel = bucketLabels[bucketIndex];
      if (!Number.isFinite(reelIndex) || !bucketLabel) return;
      const grouped = new Map();
      events.forEach((event) => {
        const type = String(event && event.type || "reference");
        if (!grouped.has(type)) grouped.set(type, []);
        grouped.get(type).push(event);
      });
      Array.from(grouped.entries()).forEach(([type, groupedEvents], groupIndex) => {
        const target = pointsByType[type];
        if (!target) return;
        target.x.push(reelIndex + 1 + (groupIndex === 0 ? -0.09 : 0.09));
        target.y.push(bucketLabel);
        target.text.push(groupedEvents.map((event) => event.detail).join(" | "));
        target.size.push(groupedEvents.length > 1 ? 13 : 8);
        target.textValues.push(groupedEvents.length > 1 ? String(groupedEvents.length) : "");
      });
    });
    return [
      {
        type: "scatter",
        mode: "markers+text",
        x: pointsByType.reference.x,
        y: pointsByType.reference.y,
        text: pointsByType.reference.textValues,
        textposition: "middle center",
        textfont: { size: 8, color: "#ffffff" },
        hoverinfo: "skip",
        showlegend: false,
        marker: {
          size: pointsByType.reference.size,
          color: "rgba(8, 145, 178, 0.72)",
          symbol: "circle",
          line: { width: 0.8, color: "rgba(255,255,255,0.7)" },
        },
      },
      {
        type: "scatter",
        mode: "markers+text",
        x: pointsByType.speed.x,
        y: pointsByType.speed.y,
        text: pointsByType.speed.textValues,
        textposition: "middle center",
        textfont: { size: 8, color: "#ffffff" },
        hoverinfo: "skip",
        showlegend: false,
        marker: {
          size: pointsByType.speed.size,
          color: "rgba(220, 38, 38, 0.68)",
          symbol: "diamond",
          line: { width: 0.8, color: "rgba(255,255,255,0.7)" },
        },
      },
    ].filter((trace) => Array.isArray(trace.x) && trace.x.length);
  }

  function buildPatternEventShapes(selectedReelIndex = null) {
    const shapes = [];
    if (Number.isInteger(Number(selectedReelIndex))) {
      const xSelected = Number(selectedReelIndex) + 1;
      shapes.push({
        type: "rect",
        xref: "x",
        yref: "paper",
        x0: xSelected - 0.5,
        x1: xSelected + 0.5,
        y0: 0,
        y1: 1,
        fillcolor: "rgba(15, 23, 42, 0.06)",
        line: { width: 0 },
        layer: "below",
      });
    }
    return shapes;
  }

  function renderPatternSelectedReelDetail(host, patternData, eventData, selectedReelIndex, machineId) {
    if (!host) return;
    const summary = Array.isArray(patternData && patternData.reelSummaries) ? patternData.reelSummaries[selectedReelIndex] : null;
    if (!summary) {
      host.innerHTML = "";
      return;
    }
    const eventSummary = ((eventData && eventData.reelSummaries) || []).find((item) => item.reelIndex === selectedReelIndex) || { events: [] };
    const previous = Array.isArray(patternData && patternData.reelSummaries) ? patternData.reelSummaries[selectedReelIndex - 1] : null;
    const next = Array.isArray(patternData && patternData.reelSummaries) ? patternData.reelSummaries[selectedReelIndex + 1] : null;
    const compareRegion = summary.dominantLabel || "--";
    const previousPct = findBucketPct(previous, compareRegion);
    const currentPct = findBucketPct(summary, compareRegion);
    const nextPct = findBucketPct(next, compareRegion);
    host.innerHTML = `
      <div class="delta-pattern-selected-reel">
        <div class="delta-pattern-selected-reel__header">
          <div>
            <strong>${escapeHtml(summary.reel && summary.reel.reelCode || `Reel ${selectedReelIndex + 1}`)}</strong>
            <span>Selected reel detail and neighboring comparison.</span>
          </div>
          <button type="button" class="delta-machine-panel__group-list-toggle" data-pattern-clear-selection="true" data-machine-id="${escapeAttr(machineId)}">Clear highlight</button>
        </div>
        <div class="delta-pattern-selected-reel__grid">
          <article class="delta-pattern-selected-reel__card">
            <span>Events</span>
            <strong>${eventSummary.events.length ? escapeHtml(eventSummary.events.map((event) => event.detail).join(" | ")) : "No major events selected"}</strong>
          </article>
          <article class="delta-pattern-selected-reel__card">
            <span>Pattern Strength</span>
            <strong>${escapeHtml(formatNumber((summary.patternStrength || 0) * 100, 0))}% concentration</strong>
          </article>
          <article class="delta-pattern-selected-reel__card">
            <span>Before / Current / After</span>
            <strong>${escapeHtml(compareRegion)} ${escapeHtml(formatNumber(previousPct, 1))}% / ${escapeHtml(formatNumber(currentPct, 1))}% / ${escapeHtml(formatNumber(nextPct, 1))}%</strong>
          </article>
        </div>
      </div>
    `;
  }

  function findBucketPct(summary, label) {
    if (!summary || !Array.isArray(summary.percentages)) return 0;
    const match = summary.percentages.find((item) => String(item && item.label || "") === String(label || ""));
    return match ? Number(match.pct) || 0 : 0;
  }

  function buildSparseNumericCategoryTicks(valuesInput, labelsInput, maxVisible = 12) {
    const values = Array.isArray(valuesInput) ? valuesInput : [];
    const labels = Array.isArray(labelsInput) ? labelsInput : [];
    if (!values.length || !labels.length) return { tickvals: [], ticktext: [] };
    const step = Math.max(1, Math.ceil(values.length / Math.max(maxVisible, 1)));
    const tickvals = [];
    const ticktext = [];
    values.forEach((value, index) => {
      if (index % step === 0 || index === values.length - 1) {
        tickvals.push(value);
        ticktext.push(labels[index] || String(value));
      }
    });
    return { tickvals, ticktext };
  }

  function extractHoverField(hoverText, label) {
    const text = String(hoverText || "");
    if (!text || !label) return "";
    const match = text.match(new RegExp(`${label}:\\s*([^<]+)`));
    return match ? String(match[1] || "").trim() : "";
  }

  function renderPatternDistributionBar(patternData) {
    const buckets = Array.isArray(patternData && patternData.bucketLabels) ? patternData.bucketLabels : [];
    const percentages = Array.isArray(patternData && patternData.globalPctByBucket) ? patternData.globalPctByBucket : [];
    if (!buckets.length || !percentages.length) return "";
    return `
      <div class="delta-pattern-distribution">
        <div class="delta-pattern-distribution__header">
          <strong>Overall Reel Region Mix</strong>
          <span>Global defect share by reel region.</span>
        </div>
        <div class="delta-pattern-distribution__bar">
          ${buckets.map((label, index) => `
            <div
              class="delta-pattern-distribution__segment"
              style="width:${escapeAttr(`${Math.max(percentages[index] || 0, 0)}%`)}; background:${escapeAttr(patternRegionColor(label))};"
              title="${escapeAttr(`${label}: ${formatNumber(percentages[index], 1)}% of all defects`)}"
            >
              <span>${escapeHtml(label)}</span>
              <strong>${escapeHtml(formatNumber(percentages[index], 1))}%</strong>
            </div>
          `).join("")}
        </div>
      </div>
    `;
  }

  function renderPatternDominantRegionStrip(patternData) {
    const summaries = Array.isArray(patternData && patternData.reelSummaries) ? patternData.reelSummaries : [];
    if (!summaries.length) return "";
    return `
      <div class="delta-pattern-dominant-strip">
        <div class="delta-pattern-dominant-strip__header">
          <strong>Dominant Region Per Reel</strong>
          <span>Higher-opacity blocks indicate stronger concentration in that reel.</span>
        </div>
        <div class="delta-pattern-dominant-strip__grid">
          ${summaries.map((summary) => {
            const label = summary.dominantLabel || "Unknown";
            const opacity = (0.26 + (summary.patternStrength * 0.74)).toFixed(3);
            return `
              <div
                class="delta-pattern-dominant-strip__cell"
                style="background:${escapeAttr(patternRegionColor(label))}; opacity:${escapeAttr(opacity)};"
                title="${escapeAttr(`${(summary.reel && summary.reel.reelCode) || `Reel ${summary.reelIndex + 1}`}: ${label} ${formatNumber(summary.dominantPct, 1)}% (${formatNumber(summary.totalDefects, 0)} defects)`)}"
              >
                <span>${escapeHtml(summary.reel && summary.reel.reelCode || `#${summary.reelIndex + 1}`)}</span>
              </div>
            `;
          }).join("")}
        </div>
      </div>
    `;
  }

  function patternRegionColor(label) {
    const value = String(label || "").toLowerCase();
    if (value.includes("begin")) return "#2563eb";
    if (value.includes("mid")) return "#f97316";
    if (value.includes("end")) return "#dc2626";
    return "#64748b";
  }

  function buildSparseCategoryTicks(labelsInput, maxVisible = 12) {
    const labels = Array.isArray(labelsInput) ? labelsInput : [];
    if (!labels.length) return { tickvals: [], ticktext: [] };
    const step = Math.max(1, Math.ceil(labels.length / Math.max(maxVisible, 1)));
    const tickvals = [];
    const ticktext = [];
    labels.forEach((label, index) => {
      if (index % step === 0 || index === labels.length - 1) {
        tickvals.push(label);
        ticktext.push(label);
      }
    });
    return { tickvals, ticktext };
  }

  function choosePatternTrendWindow(pointCount) {
    const count = Math.max(0, Number(pointCount) || 0);
    if (count >= 30) return 9;
    if (count >= 18) return 7;
    if (count >= 8) return 5;
    return 3;
  }

  function percentileOfNumeric(valuesInput, ratio = 0.5) {
    const values = (Array.isArray(valuesInput) ? valuesInput : [])
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value))
      .sort((left, right) => left - right);
    if (!values.length) return null;
    const clamped = Math.max(0, Math.min(1, Number(ratio) || 0));
    const index = Math.min(values.length - 1, Math.max(0, Math.floor(clamped * (values.length - 1))));
    return values[index];
  }

  function buildWeightedWinsorizedRollingAverage(valuesInput, weightsInput, windowSize = 5) {
    const values = Array.isArray(valuesInput) ? valuesInput : [];
    const weights = Array.isArray(weightsInput) ? weightsInput : [];
    if (!values.length) return [];
    const halfWindow = Math.floor(windowSize / 2);
    return values.map((value, index) => {
      if (!Number.isFinite(Number(value))) return null;
      const windowValues = [];
      const windowWeights = [];
      for (let offset = -halfWindow; offset <= halfWindow; offset += 1) {
        const neighborIndex = index + offset;
        const neighbor = Number(values[neighborIndex]);
        if (!Number.isFinite(neighbor)) continue;
        windowValues.push(neighbor);
        windowWeights.push(Math.max(1, Number(weights[neighborIndex]) || 1));
      }
      if (!windowValues.length) return null;
      const lower = percentileOfNumeric(windowValues, 0.15);
      const upper = percentileOfNumeric(windowValues, 0.85);
      let weightedTotal = 0;
      let totalWeight = 0;
      windowValues.forEach((entry, entryIndex) => {
        const clamped = Math.max(lower ?? entry, Math.min(upper ?? entry, entry));
        const weight = windowWeights[entryIndex];
        weightedTotal += clamped * weight;
        totalWeight += weight;
      });
      return totalWeight ? Number((weightedTotal / totalWeight).toFixed(3)) : null;
    });
  }

  function summarizePatternTrendDirection(valuesInput) {
    const values = (Array.isArray(valuesInput) ? valuesInput : []).filter((value) => Number.isFinite(Number(value))).map(Number);
    if (values.length < 3) return "stable";
    const first = values[0];
    const last = values[values.length - 1];
    const delta = last - first;
    const span = Math.max(...values) - Math.min(...values);
    const threshold = Math.max(0.18, span * 0.2);
    if (delta >= threshold) return "increasing";
    if (delta <= -threshold) return "decreasing";
    return "stable";
  }

  function buildPatternTrendAnomalies(rawValuesInput, smoothValuesInput, xValuesInput) {
    const rawValues = Array.isArray(rawValuesInput) ? rawValuesInput : [];
    const smoothValues = Array.isArray(smoothValuesInput) ? smoothValuesInput : [];
    const xValues = Array.isArray(xValuesInput) ? xValuesInput : [];
    const residuals = rawValues.map((value, index) => {
      const raw = Number(value);
      const smooth = Number(smoothValues[index]);
      if (!Number.isFinite(raw) || !Number.isFinite(smooth)) return null;
      return raw - smooth;
    });
    const absResiduals = residuals.map((value) => Number.isFinite(value) ? Math.abs(value) : null).filter((value) => Number.isFinite(value));
    const medianAbsResidual = percentileOfNumeric(absResiduals, 0.5) || 0;
    const threshold = Math.max(0.35, medianAbsResidual * 2.2);
    return residuals
      .map((residual, index) => {
        if (!Number.isFinite(residual) || Math.abs(residual) < threshold) return null;
        return Number(xValues[index]);
      })
      .filter((value) => Number.isFinite(value));
  }

  function resolvePatternTrendYRange(seriesInput) {
    const values = [];
    (Array.isArray(seriesInput) ? seriesInput : []).forEach((series) => {
      (Array.isArray(series && series.smoothedValues) ? series.smoothedValues : []).forEach((value) => {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) values.push(numeric);
      });
      (Array.isArray(series && series.rawValues) ? series.rawValues : []).forEach((value) => {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) values.push(numeric);
      });
    });
    if (!values.length) return null;
    let min = values[0];
    let max = values[0];
    values.forEach((value) => {
      if (value < min) min = value;
      if (value > max) max = value;
    });
    const span = Math.max(max - min, 0.4);
    const bottomPadding = span * 0.08;
    const topPadding = span * 0.14;
    const resolvedMin = Math.max(0, min - bottomPadding);
    const resolvedMax = max + topPadding;
    return [resolvedMin, resolvedMax];
  }

  function classifyPatternTrendEventState(summary) {
    const events = Array.isArray(summary && summary.events) ? summary.events : [];
    const hasReference = events.some((event) => String(event && event.type || "") === "reference");
    const hasSpeed = events.some((event) => String(event && event.type || "") === "speed");
    if (hasReference && hasSpeed) return "combined";
    if (hasReference) return "reference";
    if (hasSpeed) return "speed";
    return null;
  }

  function buildPatternTrendEventBandTraces(eventData, yRange) {
    const summaries = Array.isArray(eventData && eventData.highlightedReels) ? eventData.highlightedReels : [];
    const yMin = Array.isArray(yRange) ? Number(yRange[0]) : 0;
    const yMax = Array.isArray(yRange) ? Number(yRange[1]) : 1;
    const height = Math.max(0.0001, yMax - yMin);
    const styles = {
      reference: {
        fillcolor: "rgba(8, 145, 178, 0.10)",
        line: { color: "rgba(8, 145, 178, 0.34)", width: 1 },
        name: "Reference image change",
        legendrank: 100,
      },
      speed: {
        fillcolor: "rgba(220, 38, 38, 0.09)",
        line: { color: "rgba(220, 38, 38, 0.30)", width: 1 },
        name: "Speed deviation",
        legendrank: 110,
      },
      combined: {
        fillcolor: "rgba(124, 58, 237, 0.12)",
        line: { color: "rgba(124, 58, 237, 0.36)", width: 1.2 },
        name: "Combined reference change and speed deviation",
        legendrank: 120,
      },
    };
    const buckets = { reference: [], speed: [], combined: [] };
    summaries.forEach((summary) => {
      const eventState = classifyPatternTrendEventState(summary);
      if (!eventState || !styles[eventState]) return;
      buckets[eventState].push(Number(summary.reelIndex) + 1);
    });
    return Object.entries(buckets)
      .filter(([, xValues]) => xValues.length)
      .map(([eventState, xValues]) => ({
        type: "bar",
        x: xValues,
        y: xValues.map(() => height),
        base: xValues.map(() => yMin),
        width: xValues.map(() => 0.16),
        name: styles[eventState].name,
        legendrank: styles[eventState].legendrank,
        hoverinfo: "skip",
        marker: {
          color: styles[eventState].fillcolor,
          line: styles[eventState].line,
        },
        opacity: 1,
        showlegend: true,
      }));
  }

  function renderPatternTrend(host, trendSeries, summaryHost = null, eventData = null) {
    if (!host) return;
    const palette = {
      beginning: "#2563eb",
      middle: "#f97316",
      end: "#dc2626",
    };
    const normalizedSeries = (Array.isArray(trendSeries) ? trendSeries : [])
      .map((series) => {
        const points = Array.isArray(series && series.points) ? series.points : [];
        if (!points.length) return null;
        const windowSize = choosePatternTrendWindow(points.length);
        const xValues = points.map((point) => Number(point.reelIndex));
        const rawValues = points.map((point) => Number(point.avgMagnitude));
        const counts = points.map((point) => Math.max(1, Number(point.count) || 1));
        const smoothedValues = buildWeightedWinsorizedRollingAverage(rawValues, counts, windowSize);
        return {
          key: series.key || "bucket",
          label: series.label || "Bucket",
          color: palette[series.key] || colorForJob(series.label),
          windowSize,
          points,
          xValues,
          rawValues,
          counts,
          smoothedValues,
          direction: summarizePatternTrendDirection(smoothedValues),
          anomalyXs: buildPatternTrendAnomalies(rawValues, smoothedValues, xValues),
        };
      })
      .filter(Boolean);
    const traces = normalizedSeries.map((series) => ({
      x: series.xValues,
      y: series.smoothedValues,
      mode: "lines",
      name: `${series.label} magnitude trend`,
      legendgroup: series.key,
      legendrank: series.key === "beginning" ? 10 : (series.key === "middle" ? 20 : 30),
      text: series.points.map((point, index) => [
        `<b>${escapeHtml(point.reelCode || `#${point.reelIndex}`)}</b>`,
        `Job: ${escapeHtml(point.jobLabel || "--")}`,
        `Region: ${escapeHtml(series.label)}`,
        `Raw magnitude: ${escapeHtml(formatNumber(series.rawValues[index], 3))}`,
        `Smoothed magnitude: ${escapeHtml(formatNumber(series.smoothedValues[index], 3))}`,
        `Defect count: ${escapeHtml(formatNumber(series.counts[index], 0))}`,
      ].join("<br>")),
      hovertemplate: "%{text}<extra></extra>",
      line: { color: series.color, width: 4.8, shape: "spline", smoothing: 0.55 },
      connectgaps: true,
      opacity: 1,
    }));
    if (!traces.length) {
      host.innerHTML = '<div class="delta-trends-empty">Not enough magnitude trend data for the current filter state.</div>';
      if (summaryHost) summaryHost.innerHTML = "";
      return;
    }
    if (summaryHost) {
      const latestRegion = normalizedSeries
        .map((series) => ({ label: series.label, value: findLastFinite(series.smoothedValues) }))
        .filter((entry) => Number.isFinite(entry.value))
        .sort((left, right) => right.value - left.value)[0];
      summaryHost.innerHTML = `
        <div class="delta-pattern-trend-summary__grid">
          ${normalizedSeries.map((series) => `
            <article class="delta-pattern-trend-summary__card">
              <span>${escapeHtml(series.label)} Magnitude Trend</span>
              <strong>${escapeHtml(series.direction)}</strong>
            </article>
          `).join("")}
          <article class="delta-pattern-trend-summary__card delta-pattern-trend-summary__card--highlight">
            <span>Highest Current Magnitude</span>
            <strong>${escapeHtml(latestRegion ? latestRegion.label : "--")}</strong>
          </article>
        </div>
      `;
    }
    const yRange = resolvePatternTrendYRange(normalizedSeries);
    const allXValues = Array.from(new Set(traces.flatMap((trace) => Array.isArray(trace.x) ? trace.x : []))).sort((left, right) => left - right);
    const tickConfig = buildSparseNumericCategoryTicks(allXValues, allXValues.map((value) => `#${value}`), 14);
    const eventBandTraces = buildPatternTrendEventBandTraces(eventData, yRange);
    window.Plotly.react(host, [...eventBandTraces, ...traces], {
      ...buildPatternChartLayout({ xTitle: "Reel Order", yTitle: "Average Magnitude", showLegend: true }),
      legend: {
        orientation: "h",
        x: 0,
        y: 1.2,
        font: { color: readThemeColor("--text-primary", document.body.classList.contains("dark-mode") ? "#e2e8f0" : "#0f172a") },
        traceorder: "normal",
      },
      barmode: "overlay",
      xaxis: {
        ...buildPatternChartLayout({ xTitle: "Reel Order", yTitle: "Average Magnitude", showLegend: true }).xaxis,
        tickmode: "array",
        tickvals: tickConfig.tickvals,
        ticktext: tickConfig.ticktext,
        tickangle: allXValues.length > 16 ? 0 : -25,
        type: "linear",
        range: [0.5, Math.max(...allXValues, 1) + 0.5],
      },
      yaxis: {
        ...buildPatternChartLayout({ xTitle: "Reel Order", yTitle: "Average Magnitude", showLegend: true }).yaxis,
        range: yRange,
      },
    }, getPlotConfig());
  }

  function findLastFinite(valuesInput) {
    const values = Array.isArray(valuesInput) ? valuesInput : [];
    for (let index = values.length - 1; index >= 0; index -= 1) {
      const value = Number(values[index]);
      if (Number.isFinite(value)) return value;
    }
    return null;
  }

  function buildVisibleMachineStats(machine) {
    const reels = Array.isArray(machine && machine.reels) ? machine.reels : [];
    const points = Array.isArray(machine && machine.points) ? machine.points : [];
    const visibleDefects = points.filter((point) => pointIsPlottable(point));
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

  function buildMachinePositionSeries(machine) {
    const reels = getSortedMachineReels(machine);
    const points = Array.isArray(machine && machine.points) ? machine.points : [];
    const pointsByReel = new Map();
    points.forEach((point) => {
      const reelId = String(point && point.reelId || "");
      if (!reelId) return;
      if (!pointsByReel.has(reelId)) pointsByReel.set(reelId, []);
      pointsByReel.get(reelId).push(point);
    });
    let cumulativeFeet = 0;
    const x = [];
    const y = [];
    const hover = [];
    const color = [];
    const size = [];
    let maxFeet = 0;
    reels.forEach((reel) => {
      const reelId = String(reel && reel.reelId || "");
      const reelPoints = (pointsByReel.get(reelId) || [])
        .filter((point) => pointIsPlottable(point))
        .slice()
        .sort((a, b) => {
          const af = Number(a && a.feetFromReelStart);
          const bf = Number(b && b.feetFromReelStart);
          if (Number.isFinite(af) && Number.isFinite(bf) && af !== bf) return af - bf;
          const at = a && a.time ? new Date(a.time).getTime() : 0;
          const bt = b && b.time ? new Date(b.time).getTime() : 0;
          return at - bt || Number(a && a.defectId || 0) - Number(b && b.defectId || 0);
        });
      reelPoints.forEach((point) => {
        const localFeet = Number(point && point.feetFromReelStart);
        if (!Number.isFinite(localFeet)) return;
        x.push(cumulativeFeet + localFeet);
        y.push(localFeet);
        hover.push(buildPositionHoverText(point));
        color.push(colorForJob(formatJobLabel(point && point.jobName, point && point.orderNumber)));
        size.push(scalePositionMarkerSize(point && point.severityValue));
        if (localFeet > maxFeet) maxFeet = localFeet;
      });
      cumulativeFeet += Math.max(Number(reel && reel.reelFeetTotal) || 0, 0);
    });
    return { x, y, hover, color, size, maxFeet };
  }

  function buildMachineCoordinateSeries(machine) {
    const reels = getSortedMachineReels(machine);
    const points = Array.isArray(machine && machine.points) ? machine.points : [];
    const pointsByReel = new Map();
    points.forEach((point) => {
      const reelId = String(point && point.reelId || "");
      if (!reelId) return;
      if (!pointsByReel.has(reelId)) pointsByReel.set(reelId, []);
      pointsByReel.get(reelId).push(point);
    });
    let cumulativeFeet = 0;
    const x = [];
    const xPct = [];
    const yPct = [];
    const xHover = [];
    const yHover = [];
    const size = [];
    reels.forEach((reel) => {
      const reelId = String(reel && reel.reelId || "");
      const reelPoints = (pointsByReel.get(reelId) || [])
        .filter((point) => pointIsPlottable(point))
        .slice()
        .sort((a, b) => {
          const af = Number(a && a.feetFromReelStart);
          const bf = Number(b && b.feetFromReelStart);
          if (Number.isFinite(af) && Number.isFinite(bf) && af !== bf) return af - bf;
          const at = a && a.time ? new Date(a.time).getTime() : 0;
          const bt = b && b.time ? new Date(b.time).getTime() : 0;
          return at - bt || Number(a && a.defectId || 0) - Number(b && b.defectId || 0);
        });
      reelPoints.forEach((point) => {
        const localFeet = Number(point && point.feetFromReelStart);
        const centroidX = Number(point && point.coordCentroidX);
        const centroidY = Number(point && point.coordCentroidY);
        const formatWidth = Number(point && point.formatWidth);
        const formatLength = Number(point && point.formatLength);
        if (!Number.isFinite(localFeet)) return;
        const xValue = cumulativeFeet + localFeet;
        const normalizedX = Number.isFinite(centroidX) && Number.isFinite(formatWidth) && formatWidth > 0
          ? (centroidX / formatWidth) * 100
          : null;
        const normalizedY = Number.isFinite(centroidY) && Number.isFinite(formatLength) && formatLength > 0
          ? (centroidY / formatLength) * 100
          : null;
        if (normalizedX === null && normalizedY === null) return;
        x.push(xValue);
        xPct.push(normalizedX);
        yPct.push(normalizedY);
        xHover.push(buildCoordinateHoverText(point, "Centroid X", normalizedX, centroidX, formatWidth));
        yHover.push(buildCoordinateHoverText(point, "Centroid Y", normalizedY, centroidY, formatLength));
        size.push(scalePositionMarkerSize(point && point.severityValue));
      });
      cumulativeFeet += Math.max(Number(reel && reel.reelFeetTotal) || 0, 0);
    });
    return { x, xPct, yPct, xHover, yHover, size };
  }

  function buildMachineDefectGroupSummary(machine) {
    const reels = getSortedMachineReels(machine);
    const points = Array.isArray(machine && machine.points) ? machine.points : [];
    const pointsByReel = new Map();
    let cumulativeFeet = 0;
    let previousJobRunKey = "";
    let previousJobRunFeet = 0;
    points.forEach((point) => {
      const reelId = String(point && point.reelId || "");
      if (!reelId) return;
      if (!pointsByReel.has(reelId)) pointsByReel.set(reelId, []);
      pointsByReel.get(reelId).push(point);
    });
    const groups = new Map();
    reels.forEach((reel) => {
      const reelId = String(reel && reel.reelId || "");
      const reelPoints = (pointsByReel.get(reelId) || [])
        .filter((point) => pointIsPlottable(point))
        .slice()
        .sort((a, b) => {
          const af = Number(a && a.feetFromReelStart);
          const bf = Number(b && b.feetFromReelStart);
          if (Number.isFinite(af) && Number.isFinite(bf) && af !== bf) return af - bf;
          const at = a && a.time ? new Date(a.time).getTime() : 0;
          const bt = b && b.time ? new Date(b.time).getTime() : 0;
          return at - bt || Number(a && a.defectId || 0) - Number(b && b.defectId || 0);
        });
      const reelFeet = Math.max(Number(reel && reel.reelFeetTotal) || 0, 0);
      const jobLabel = formatJobLabel(reel && reel.jobName, reel && reel.orderNumber);
      const jobRunKey = normalizeRecurringGroupKey(jobLabel);
      const baseJobFeet = jobRunKey && jobRunKey === previousJobRunKey ? previousJobRunFeet : 0;
      reelPoints.forEach((point) => {
        const centroidX = Number(point && point.coordCentroidX);
        const centroidY = Number(point && point.coordCentroidY);
        const formatWidth = Number(point && point.formatWidth);
        const formatLength = Number(point && point.formatLength);
        const descriptor = buildPointGroupDescriptor({
          className: point && point.className,
          coordCentroidX: centroidX,
          coordCentroidY: centroidY,
          formatWidth,
          formatLength,
        });
        const key = descriptor.key;
        if (!groups.has(key)) {
          groups.set(key, {
            key,
            label: descriptor.label,
            count: 0,
            jobs: new Set(),
            previewImageSrc: "",
            occurrences: [],
            coordinateGroups: [],
            sortTime: 0,
          });
        }
        const group = groups.get(key);
        group.count += 1;
        group.jobs.add(formatJobLabel(point && point.jobName, point && point.orderNumber));
        if (!group.previewImageSrc && point && point.imageSrc) {
          group.previewImageSrc = point.imageSrc;
        }
        const localFeet = Number(point && point.feetFromReelStart);
        const jobFeetFromStart = baseJobFeet + (Number.isFinite(localFeet) ? localFeet : 0);
        group.occurrences.push({
          defectId: Number(point && point.defectId) || 0,
          reelId: String(point && point.reelId || ""),
          reelCode: point && point.reelCode ? point.reelCode : "Unknown Reel",
          reelFeetTotal: Number(point && point.reelFeetTotal),
          feetFromReelStart: Number.isFinite(localFeet) ? localFeet : 0,
          jobFeetFromStart,
          jobLabel: formatJobLabel(point && point.jobName, point && point.orderNumber),
          xValue: cumulativeFeet + (Number.isFinite(localFeet) ? localFeet : 0),
          imageSrc: point && point.imageSrc ? point.imageSrc : "",
          timeValue: point && point.time ? new Date(point.time).getTime() : 0,
        });
        const coordinateDescriptor = buildPointCoordinateDescriptor({
          coordCentroidX: centroidX,
          coordCentroidY: centroidY,
          coordMinX: point && point.coordMinX,
          coordMaxX: point && point.coordMaxX,
          coordMinY: point && point.coordMinY,
          coordMaxY: point && point.coordMaxY,
          formatWidth,
          formatLength,
        });
        const coordinateGroup = resolveCoordinateCluster(group.coordinateGroups, coordinateDescriptor);
        coordinateGroup.count += 1;
        coordinateGroup.occurrences.push({
          defectId: Number(point && point.defectId) || 0,
          reelId: String(point && point.reelId || ""),
          reelCode: point && point.reelCode ? point.reelCode : "Unknown Reel",
          reelFeetTotal: Number(point && point.reelFeetTotal),
          feetFromReelStart: Number.isFinite(localFeet) ? localFeet : 0,
          jobFeetFromStart,
          jobLabel: formatJobLabel(point && point.jobName, point && point.orderNumber),
          xValue: cumulativeFeet + (Number.isFinite(localFeet) ? localFeet : 0),
          imageSrc: point && point.imageSrc ? point.imageSrc : "",
          timeValue: point && point.time ? new Date(point.time).getTime() : 0,
        });
        group.sortTime = Math.max(group.sortTime, point && point.time ? new Date(point.time).getTime() : 0);
      });
      previousJobRunKey = jobRunKey;
      previousJobRunFeet = baseJobFeet + reelFeet;
      cumulativeFeet += reelFeet;
    });
    const normalizedGroups = Array.from(groups.values())
      .map((group) => ({
        ...group,
        jobs: Array.from(group.jobs).sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" })),
        occurrences: group.occurrences
          .sort((left, right) => left.xValue - right.xValue || left.timeValue - right.timeValue),
        stats: summarizeOccurrenceStats(group.occurrences),
        coordinateGroups: group.coordinateGroups
          .filter((coordinateGroup) => Number(coordinateGroup && coordinateGroup.count) > 1)
          .map((coordinateGroup) => ({
            ...coordinateGroup,
            label: formatCoordinateClusterLabel(coordinateGroup),
            stats: summarizeOccurrenceStats(coordinateGroup.occurrences),
            occurrences: coordinateGroup.occurrences
              .sort((left, right) => left.xValue - right.xValue || left.timeValue - right.timeValue),
          }))
          .sort((left, right) => right.count - left.count || left.clusterIndex - right.clusterIndex),
      }))
      .filter((group) => Number(group && group.count) > 1)
      .sort((left, right) => right.count - left.count || right.sortTime - left.sortTime || left.label.localeCompare(right.label));
    return {
      totalCount: normalizedGroups.reduce((sum, group) => sum + group.count, 0),
      groups: normalizedGroups,
    };
  }

  function buildPointGroupDescriptor(point) {
    const classLabel = String(point && point.className || "").trim() || "Unclassified";
    return {
      key: normalizeRecurringGroupKey(classLabel),
      label: classLabel,
    };
  }

  function normalizeRecurringGroupKey(value) {
    return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
  }

  function buildPointCoordinateDescriptor(point) {
    const centroidX = Number(point && point.coordCentroidX);
    const centroidY = Number(point && point.coordCentroidY);
    const minX = Number(point && point.coordMinX);
    const maxX = Number(point && point.coordMaxX);
    const minY = Number(point && point.coordMinY);
    const maxY = Number(point && point.coordMaxY);
    const formatWidth = Number(point && point.formatWidth);
    const formatLength = Number(point && point.formatLength);
    const normalizedX = Number.isFinite(centroidX) && Number.isFinite(formatWidth) && formatWidth > 0
      ? (centroidX / formatWidth) * 100
      : null;
    const normalizedY = Number.isFinite(centroidY) && Number.isFinite(formatLength) && formatLength > 0
      ? (centroidY / formatLength) * 100
      : null;
    return {
      centroidXPct: normalizedX,
      centroidYPct: normalizedY,
      widthPct: Number.isFinite(minX) && Number.isFinite(maxX) && Number.isFinite(formatWidth) && formatWidth > 0
        ? ((maxX - minX) / formatWidth) * 100
        : null,
      heightPct: Number.isFinite(minY) && Number.isFinite(maxY) && Number.isFinite(formatLength) && formatLength > 0
        ? ((maxY - minY) / formatLength) * 100
        : null,
    };
  }

  function resolveCoordinateCluster(clusters, descriptor) {
    if (!Array.isArray(clusters)) return createCoordinateCluster([], descriptor);
    if (!descriptorHasCoordinateMetrics(descriptor)) {
      const fallbackCluster = clusters.find((cluster) => cluster && cluster.key === "cluster-unlocated");
      if (fallbackCluster) return fallbackCluster;
      return createCoordinateCluster(clusters, descriptor, { key: "cluster-unlocated", label: "Unlocated" });
    }
    let bestCluster = null;
    let bestScore = Number.POSITIVE_INFINITY;
    clusters.forEach((cluster) => {
      const score = computeCoordinateClusterScore(cluster, descriptor);
      if (!Number.isFinite(score)) return;
      if (score < bestScore) {
        bestScore = score;
        bestCluster = cluster;
      }
    });
    if (!bestCluster || bestScore > 8) {
      return createCoordinateCluster(clusters, descriptor);
    }
    updateCoordinateCluster(bestCluster, descriptor);
    return bestCluster;
  }

  function createCoordinateCluster(clusters, descriptor, overrides = null) {
    const cluster = {
      key: overrides && overrides.key ? overrides.key : `cluster-${clusters.length + 1}`,
      clusterIndex: clusters.length + 1,
      customLabel: overrides && overrides.label ? overrides.label : "",
      count: 0,
      occurrences: [],
      centroidXPct: valueOrNull(descriptor && descriptor.centroidXPct),
      centroidYPct: valueOrNull(descriptor && descriptor.centroidYPct),
      widthPct: valueOrNull(descriptor && descriptor.widthPct),
      heightPct: valueOrNull(descriptor && descriptor.heightPct),
    };
    clusters.push(cluster);
    return cluster;
  }

  function descriptorHasCoordinateMetrics(descriptor) {
    return [
      descriptor && descriptor.centroidXPct,
      descriptor && descriptor.centroidYPct,
      descriptor && descriptor.widthPct,
      descriptor && descriptor.heightPct,
    ].some((value) => Number.isFinite(Number(value)));
  }

  function updateCoordinateCluster(cluster, descriptor) {
    const nextCount = Number(cluster.count || 0) + 1;
    cluster.centroidXPct = blendClusterMetric(cluster.centroidXPct, descriptor && descriptor.centroidXPct, nextCount);
    cluster.centroidYPct = blendClusterMetric(cluster.centroidYPct, descriptor && descriptor.centroidYPct, nextCount);
    cluster.widthPct = blendClusterMetric(cluster.widthPct, descriptor && descriptor.widthPct, nextCount);
    cluster.heightPct = blendClusterMetric(cluster.heightPct, descriptor && descriptor.heightPct, nextCount);
  }

  function blendClusterMetric(currentValue, nextValue, nextCount) {
    const current = Number(currentValue);
    const incoming = Number(nextValue);
    if (!Number.isFinite(incoming)) return Number.isFinite(current) ? current : null;
    if (!Number.isFinite(current) || nextCount <= 1) return incoming;
    return ((current * (nextCount - 1)) + incoming) / nextCount;
  }

  function computeCoordinateClusterScore(cluster, descriptor) {
    const centerDistance = distance2d(
      cluster && cluster.centroidXPct,
      cluster && cluster.centroidYPct,
      descriptor && descriptor.centroidXPct,
      descriptor && descriptor.centroidYPct,
    );
    const sizeDistance = distance2d(
      cluster && cluster.widthPct,
      cluster && cluster.heightPct,
      descriptor && descriptor.widthPct,
      descriptor && descriptor.heightPct,
    );
    if (!Number.isFinite(centerDistance)) return Number.POSITIVE_INFINITY;
    if (!Number.isFinite(sizeDistance)) return centerDistance;
    return centerDistance + (sizeDistance * 0.45);
  }

  function distance2d(ax, ay, bx, by) {
    const leftX = Number(ax);
    const leftY = Number(ay);
    const rightX = Number(bx);
    const rightY = Number(by);
    if (!Number.isFinite(leftX) || !Number.isFinite(leftY) || !Number.isFinite(rightX) || !Number.isFinite(rightY)) {
      return Number.NaN;
    }
    return Math.hypot(leftX - rightX, leftY - rightY);
  }

  function formatCoordinateClusterLabel(cluster) {
    if (cluster && cluster.customLabel) return cluster.customLabel;
    const centerX = Number(cluster && cluster.centroidXPct);
    const centerY = Number(cluster && cluster.centroidYPct);
    const width = Number(cluster && cluster.widthPct);
    const height = Number(cluster && cluster.heightPct);
    const parts = [`Cluster ${cluster && cluster.clusterIndex ? cluster.clusterIndex : "?"}`];
    if (Number.isFinite(centerX) && Number.isFinite(centerY)) {
      parts.push(`center ${formatNumber(centerX, 1)}%, ${formatNumber(centerY, 1)}%`);
    }
    if (Number.isFinite(width) && Number.isFinite(height)) {
      parts.push(`size ${formatNumber(width, 1)}% x ${formatNumber(height, 1)}%`);
    }
    return parts.join(" · ");
  }

  function sortRecurringOccurrences(occurrences, direction) {
    const items = Array.isArray(occurrences) ? [...occurrences] : [];
    const multiplier = direction === "desc" ? -1 : 1;
    return items.sort((left, right) => {
      const leftFeet = Number(left && left.jobFeetFromStart);
      const rightFeet = Number(right && right.jobFeetFromStart);
      if (Number.isFinite(leftFeet) && Number.isFinite(rightFeet) && leftFeet !== rightFeet) {
        return (leftFeet - rightFeet) * multiplier;
      }
      const leftX = Number(left && left.xValue);
      const rightX = Number(right && right.xValue);
      if (Number.isFinite(leftX) && Number.isFinite(rightX) && leftX !== rightX) {
        return (leftX - rightX) * multiplier;
      }
      return (Number(left && left.timeValue) || 0) - (Number(right && right.timeValue) || 0);
    });
  }

  function groupRecurringOccurrencesByReel(occurrences) {
    const groups = [];
    let current = null;
    (Array.isArray(occurrences) ? occurrences : []).forEach((occurrence) => {
      const reelKey = String(occurrence && occurrence.reelId || occurrence && occurrence.reelCode || "Unknown Reel");
      const reelCode = String(occurrence && occurrence.reelCode || "Unknown Reel");
      if (!current || current.reelKey !== reelKey) {
        current = { reelKey, reelCode, reelFeetTotal: null, occurrences: [] };
        groups.push(current);
      }
      const reelFeetTotal = Number(occurrence && occurrence.reelFeetTotal);
      if (Number.isFinite(reelFeetTotal)) {
        current.reelFeetTotal = reelFeetTotal;
      }
      current.occurrences.push(occurrence);
    });
    return groups;
  }

  function formatRecurringReelGroupLabel(reelGroup) {
    const reelCode = String(reelGroup && reelGroup.reelCode || "Unknown Reel");
    const reelFeetTotal = Number(reelGroup && reelGroup.reelFeetTotal);
    if (!Number.isFinite(reelFeetTotal)) return reelCode;
    return `${reelCode} - ${formatNumber(reelFeetTotal, 0)} ft`;
  }

  function moveRecurringClusterSelection(machineId, groupKey, clusterKey, direction) {
    const machine = (((state.data && state.data.machines) || []).find((item) => String(item && item.machineId || "") === String(machineId || ""))) || null;
    if (!machine) return;
    const summary = buildMachineDefectGroupSummary(machine);
    const group = (summary.groups || []).find((item) => item.key === groupKey);
    if (!group) return;
    const coordinateGroup = (group.coordinateGroups || []).find((item) => item.key === clusterKey);
    if (!coordinateGroup) return;
    const activeSort = state.recurringOccurrenceSorts.get(String(machineId || "")) || "asc";
    const occurrences = sortRecurringOccurrences(coordinateGroup.occurrences, activeSort);
    if (!occurrences.length) return;
    const selectionKey = buildRecurringClusterSelectionKey(machineId, groupKey, clusterKey);
    const currentIndex = normalizeRecurringClusterIndex(state.recurringClusterSelections.get(selectionKey), occurrences.length);
    const nextIndex = (currentIndex + direction + occurrences.length) % occurrences.length;
    state.recurringClusterSelections.set(selectionKey, nextIndex);
    const host = document.getElementById(`defectTrendsMachineGroupList-${machineId}`);
    renderMachineDefectGroupList(host, machine);
    const nextOccurrence = occurrences[nextIndex];
    if (nextOccurrence) {
      jumpToAxisOffset(Number(nextOccurrence.xValue));
    }
    requestAnimationFrame(() => {
      const activeCard = document.querySelector(`[data-recurring-occurrence-card="${escapeCssSelectorValue(selectionKey)}"].is-active`);
      if (activeCard && typeof activeCard.scrollIntoView === "function") {
        activeCard.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    });
  }

  function buildRecurringClusterSelectionKey(machineId, groupKey, clusterKey) {
    return `${String(machineId || "")}__${String(groupKey || "")}__${String(clusterKey || "")}`;
  }

  function normalizeRecurringClusterIndex(value, itemCount) {
    if (!itemCount) return 0;
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0 || numeric >= itemCount) return 0;
    return numeric;
  }

  function escapeCssSelectorValue(value) {
    const text = String(value || "");
    if (typeof CSS !== "undefined" && CSS && typeof CSS.escape === "function") {
      return CSS.escape(text);
    }
    return text.replace(/["\\]/g, "\\$&");
  }

  function summarizeOccurrenceStats(occurrences) {
    const items = Array.isArray(occurrences) ? occurrences : [];
    let reelFeetMin = null;
    let reelFeetMax = null;
    let jobFeetMin = null;
    let jobFeetMax = null;
    items.forEach((occurrence) => {
      const reelFeet = Number(occurrence && occurrence.feetFromReelStart);
      const jobFeet = Number(occurrence && occurrence.jobFeetFromStart);
      if (Number.isFinite(reelFeet)) {
        reelFeetMin = reelFeetMin === null ? reelFeet : Math.min(reelFeetMin, reelFeet);
        reelFeetMax = reelFeetMax === null ? reelFeet : Math.max(reelFeetMax, reelFeet);
      }
      if (Number.isFinite(jobFeet)) {
        jobFeetMin = jobFeetMin === null ? jobFeet : Math.min(jobFeetMin, jobFeet);
        jobFeetMax = jobFeetMax === null ? jobFeet : Math.max(jobFeetMax, jobFeet);
      }
    });
    return {
      reelFeetMin,
      reelFeetMax,
      jobFeetMin,
      jobFeetMax,
    };
  }

  function formatFeetRange(minValue, maxValue) {
    const min = Number(minValue);
    const max = Number(maxValue);
    if (!Number.isFinite(min) && !Number.isFinite(max)) return "--";
    if (Number.isFinite(min) && Number.isFinite(max) && Math.abs(max - min) < 0.05) {
      return `${formatNumber(min, 1)} ft`;
    }
    if (Number.isFinite(min) && Number.isFinite(max)) {
      return `${formatNumber(min, 1)}-${formatNumber(max, 1)} ft`;
    }
    if (Number.isFinite(min)) return `${formatNumber(min, 1)} ft`;
    return `${formatNumber(max, 1)} ft`;
  }

  function formatFeetSpan(minValue, maxValue) {
    const min = Number(minValue);
    const max = Number(maxValue);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return "--";
    return `${formatNumber(Math.max(max - min, 0), 1)} ft`;
  }

  function renderRecurringStatPill(label, value) {
    return `
      <span class="delta-recurring-stat-pill">
        <strong>${escapeHtml(label)}</strong>
        <span>${escapeHtml(value)}</span>
      </span>
    `;
  }

  function buildPositionHoverText(point) {
    const parts = [
      `<b>${escapeHtml(point && point.machineName || "")}</b>`,
      `Job: ${escapeHtml(formatJobLabel(point && point.jobName, point && point.orderNumber))}`,
      `Reel: ${escapeHtml(point && point.reelCode || "Unknown Reel")}`,
      `Time: ${escapeHtml(formatDateTimeLabel(point && point.time))}`,
      `Reel position: ${escapeHtml(formatNumber(point && point.feetFromReelStart, 2))} ft`,
      `Severity: ${escapeHtml(formatMetric(point && point.severityValue))}`,
      `Magnitude: ${escapeHtml(formatMetric(point && point.magnitudeValue))}`,
      `Class: ${escapeHtml(point && point.className || "--")}`,
    ];
    return parts.join("<br>");
  }

  function buildCoordinateHoverText(point, label, normalizedValue, rawValue, axisExtent) {
    const parts = [
      `<b>${escapeHtml(point && point.machineName || "")}</b>`,
      `Job: ${escapeHtml(formatJobLabel(point && point.jobName, point && point.orderNumber))}`,
      `Reel: ${escapeHtml(point && point.reelCode || "Unknown Reel")}`,
      `Time: ${escapeHtml(formatDateTimeLabel(point && point.time))}`,
      `Reel position: ${escapeHtml(formatNumber(point && point.feetFromReelStart, 2))} ft`,
      `${escapeHtml(label)}: ${Number.isFinite(Number(normalizedValue)) ? escapeHtml(formatNumber(normalizedValue, 2)) : "--"}%`,
      `Raw ${escapeHtml(label)}: ${Number.isFinite(Number(rawValue)) ? escapeHtml(formatNumber(rawValue, 2)) : "--"}`,
      `Axis extent: ${Number.isFinite(Number(axisExtent)) ? escapeHtml(formatNumber(axisExtent, 2)) : "--"}`,
      `Severity: ${escapeHtml(formatMetric(point && point.severityValue))}`,
      `Class: ${escapeHtml(point && point.className || "--")}`,
    ];
    return parts.join("<br>");
  }

  function buildCoordinateBucket(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return { key: "na", label: "--" };
    }
    const bucketSize = 5;
    const clamped = Math.max(0, Math.min(100, numeric));
    const start = Math.floor(clamped / bucketSize) * bucketSize;
    const end = Math.min(start + bucketSize, 100);
    return {
      key: `${start}-${end}`,
      label: `${formatNumber(start, 0)}-${formatNumber(end, 0)}%`,
    };
  }

  function scalePositionMarkerSize(value) {
    const severity = Number(value);
    if (!Number.isFinite(severity)) return 8;
    return Math.max(7, Math.min(16, 7 + (severity * 0.8)));
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
    if (chartScroll.dataset.scrollBound === "true") {
      return;
    }
    chartScroll.dataset.scrollBound = "true";
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

  function getSortedMachineReels(machine) {
    if (!machine) return [];
    if (Array.isArray(machine.__sortedReelsCache)) {
      return machine.__sortedReelsCache;
    }
    const sortedReels = Array.isArray(machine.reels) ? [...machine.reels] : [];
    sortedReels.sort((a, b) => {
      const at = a && a.timeStart ? new Date(a.timeStart).getTime() : 0;
      const bt = b && b.timeStart ? new Date(b.timeStart).getTime() : 0;
      return at - bt || Number(a.reelId || 0) - Number(b.reelId || 0);
    });
    machine.__sortedReelsCache = sortedReels;
    return sortedReels;
  }

  function buildMachineSeries(machine) {
    const reels = getSortedMachineReels(machine);
    const points = Array.isArray(machine.points) ? machine.points : [];
    const pointsByReel = new Map();
    points.forEach((point) => {
      const reelId = String(point.reelId || "");
      if (!reelId) return;
      if (!pointsByReel.has(reelId)) pointsByReel.set(reelId, []);
      pointsByReel.get(reelId).push(point);
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
        const visible = pointIsPlottable(point);
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
    const reels = getSortedMachineReels(machine);
    const points = Array.isArray(machine && machine.points) ? machine.points : [];
    const pointsByReel = new Map();
    points.forEach((point) => {
      const reelId = String(point && point.reelId || "");
      if (!reelId) return;
      if (!pointsByReel.has(reelId)) pointsByReel.set(reelId, []);
      pointsByReel.get(reelId).push(point);
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
        if (pointIsPlottable(point)) {
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
    const reels = getSortedMachineReels(machine);
    const speedPoints = Array.isArray(machine && machine.speedPoints) ? machine.speedPoints : [];
    const speedPointsByReel = new Map();
    speedPoints.forEach((point) => {
      const reelId = String(point && point.reelId || "");
      if (!reelId) return;
      if (!speedPointsByReel.has(reelId)) speedPointsByReel.set(reelId, []);
      speedPointsByReel.get(reelId).push(point);
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

  function pointIsBaseVisible(point) {
    if (state.showImageDefects) return !!(point && point.imageSrc);
    return true;
  }

  function pointIsPlottable(point) {
    return !!point;
  }

  function pointIsVisible(point) {
    return pointIsBaseVisible(point);
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
      if (annotation.text === "New<br>Reel") {
        jumpToAxisOffset(Number(annotation.x));
        return;
      }
      if (annotation.text === "New<br>Ref") {
        const match = findAnnotationClickEvent(annotation, referenceClickEvents);
        if (match && match.detail) {
          jumpToAnnotationEvent(match);
          openReferenceViewer(match.detail);
          return;
        }
      }
      if (annotation.text === "Mask<br>Chg") {
        const match = findAnnotationClickEvent(annotation, maskClickEvents);
        if (match && match.detail) {
          jumpToAnnotationEvent(match);
          openMaskViewer(match.detail);
        }
      }
    });
  }

  function jumpToAnnotationEvent(match) {
    jumpToAxisOffset(Number(match && match.xValue));
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
    const formatWidth = Number(detail && detail.formatWidth);
    const formatLength = Number(detail && detail.formatLength);
    const polygons = collectMaskPolygons(masks, formatLength);
    if (!polygons.length) {
      return "<div class='drivers-empty placeholder'>No masks</div>";
    }
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

  // Rectangular masks are wrapped into the repeat length (wrapMaskY lives in MaskHeatmap),
  // so masks that cross or sit outside the image frame are drawn where they land.
  function collectMaskPolygons(masks, formatLength) {
    const helpers = typeof MaskHeatmap === "object" && MaskHeatmap ? MaskHeatmap : null;
    const canWrap =
      Number.isFinite(formatLength) &&
      formatLength > 0 &&
      helpers &&
      typeof helpers.wrapMaskY === "function" &&
      typeof helpers.isAxisAlignedRect === "function";
    const polygons = [];
    (Array.isArray(masks) ? masks : []).forEach((mask) => {
      parseMaskCoords(mask && mask.coords).forEach((polygon) => {
        const normalized = polygon.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
        if (normalized.length < 3) return;
        if (canWrap && helpers.isAxisAlignedRect(normalized)) {
          const xs = normalized.map((point) => point.x);
          const ys = normalized.map((point) => point.y);
          const x0 = Math.min(...xs);
          const x1 = Math.max(...xs);
          helpers.wrapMaskY(Math.min(...ys), Math.max(...ys), formatLength).forEach(([y0, y1]) => {
            polygons.push([
              { x: x0, y: y0 },
              { x: x1, y: y0 },
              { x: x1, y: y1 },
              { x: x0, y: y1 },
            ]);
          });
        } else {
          polygons.push(normalized);
        }
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
      return String(point && point.reelId || "") === target && pointIsPlottable(point);
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