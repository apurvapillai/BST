(function () {
  const bootstrap = window.__RLM_BOOTSTRAP__ || {};

  const MACHINE_COLORS = ["#2563eb", "#f97316", "#10b981", "#ef4444", "#a855f7", "#0ea5e9", "#f59e0b", "#14b8a6", "#6366f1", "#dc2626"];
  const JOB_COLORS = ["#0ea5e9", "#f97316", "#34d399", "#f43f5e", "#a855f7", "#14b8a6", "#f59e0b", "#6366f1", "#ec4899", "#22d3ee"];
  const jobColorMap = new Map();
  const FEET_PER_FORMAT_UNIT = 3.0417;

  const state = {
    machineId: bootstrap.defaultMachineId ? String(bootstrap.defaultMachineId) : "",
    start: bootstrap.defaultStartDate,
    end: bootstrap.defaultEndDate,
    jobFilters: [],
    minFeet: null,
    customErrShrink: null,
    customErrExpand: null,
    deltaYMin: null,
    deltaYMax: null,
    monitoringPoints: [],
    monitoringSummary: [],
    tolerancePoints: [],
    reelMeta: {},
    reelTolerances: {},
    deltaRows: [],
    deltaShowOobOnly: false,
    reelRows: [],
    targetValue: null,
    minusTolerance: null,
    plusTolerance: null,
    contextRange: { min: null, max: null },
    selectedReelId: "",
    reelOobOptions: [],
    reelOobLookup: {},
  };

  const elements = {};

  function init() {
    cacheDom();
    bindEvents();
    hydrateMachineSelect();
    fetchJobs();
    renderJobChips();
    refreshAll();
  }

  function cacheDom() {
    elements.app = document.getElementById("rlmApp");
    elements.machine = document.getElementById("rlmMachine");
    elements.start = document.getElementById("rlmStart");
    elements.end = document.getElementById("rlmEnd");
    elements.job = document.getElementById("rlmJob");
    elements.minFeet = document.getElementById("rlmMinFeet");
    elements.jobChips = document.getElementById("rlmJobChips");
    elements.refresh = document.getElementById("rlmRefresh");
    elements.rangeLabel = document.getElementById("rlmRangeLabel");
    elements.summary = document.getElementById("rlmSummary");
    elements.targetValue = document.getElementById("rlmTargetValue");
    elements.minusTolerance = document.getElementById("rlmMinusTolerance");
    elements.plusTolerance = document.getElementById("rlmPlusTolerance");
    elements.errShrinkOverride = document.getElementById("rlmErrShrinkOverride");
    elements.errExpandOverride = document.getElementById("rlmErrExpandOverride");
    elements.deltaAxisMin = document.getElementById("rlmDeltaAxisMin");
    elements.deltaAxisMax = document.getElementById("rlmDeltaAxisMax");
    elements.deltaBoundsApply = document.getElementById("rlmDeltaBoundsApply");
    elements.curlengthStats = document.getElementById("rlmCurlengthStats");
    elements.loading = document.getElementById("rlmLoading");
    elements.curlengthChart = document.getElementById("rlmCurlengthChart");
    elements.deltaChart = document.getElementById("rlmDeltaChart");
    elements.deltaSummary = document.getElementById("rlmDeltaSummary");
    elements.deltaStd = document.getElementById("rlmDeltaStd");
    elements.deltaAvg = document.getElementById("rlmDeltaAvg");
    elements.deltaMin = document.getElementById("rlmDeltaMin");
    elements.deltaMax = document.getElementById("rlmDeltaMax");
    elements.deltaFeetGood = document.getElementById("rlmFeetGood");
    elements.deltaFeetBad = document.getElementById("rlmFeetBad");
    elements.deltaFeetTotal = document.getElementById("rlmFeetTotal");
    elements.deltaFeetGoodPct = document.getElementById("rlmFeetGoodPct");
    elements.deltaFeetBadPct = document.getElementById("rlmFeetBadPct");
    elements.deltaPointBar = document.getElementById("rlmDeltaPointBar");
    elements.deltaReelSelect = document.getElementById("rlmDeltaReelSelect");
    elements.deltaReelMeta = document.getElementById("rlmDeltaReelMeta");
    elements.deltaReelCurl = document.getElementById("rlmDeltaReelCurl");
    elements.deltaReelDelta = document.getElementById("rlmDeltaReelDelta");
    elements.deltaReelContext = document.getElementById("rlmDeltaReelContext");
    elements.contextRangeMin = document.getElementById("rlmContextRangeMin");
    elements.contextRangeMax = document.getElementById("rlmContextRangeMax");
    elements.summaryFeetPrev = document.getElementById("rlmSummaryFeetPrev");
    elements.summaryFeetCurrent = document.getElementById("rlmSummaryFeetCurrent");
    elements.summaryFeetNext = document.getElementById("rlmSummaryFeetNext");
    elements.summaryPointsPrev = document.getElementById("rlmSummaryPointsPrev");
    elements.summaryPointsCurrent = document.getElementById("rlmSummaryPointsCurrent");
    elements.summaryPointsNext = document.getElementById("rlmSummaryPointsNext");
    elements.summaryOobPrev = document.getElementById("rlmSummaryOobPrev");
    elements.summaryOobCurrent = document.getElementById("rlmSummaryOobCurrent");
    elements.summaryOobNext = document.getElementById("rlmSummaryOobNext");
    elements.summaryDeltaPrev = document.getElementById("rlmSummaryDeltaPrev");
    elements.summaryDeltaCurrent = document.getElementById("rlmSummaryDeltaCurrent");
    elements.summaryDeltaNext = document.getElementById("rlmSummaryDeltaNext");
    elements.reelCountTotal = document.getElementById("rlmReelCountTotal");
    elements.reelCountGood = document.getElementById("rlmReelCountGood");
    elements.reelCountBad = document.getElementById("rlmReelCountBad");
    elements.deltaChartLoader = document.getElementById("rlmDeltaChartLoader");
    elements.detailChart = document.getElementById("rlmDetailChart");
    elements.timelineBar = document.getElementById("rlmTimelineBar");
    elements.toleranceChart = document.getElementById("rlmToleranceChart");
    elements.errorTrendChart = document.getElementById("rlmErrorTrendChart");
    elements.monitoringTrendChart = document.getElementById("rlmMonitoringTrendChart");
    elements.toleranceSummary = document.getElementById("rlmToleranceSummary");
    elements.changeMixChart = document.getElementById("rlmChangeMixChart");
    elements.changeJobChart = document.getElementById("rlmChangeJobChart");
    elements.rawTable = document.querySelector("#rlmRawTable tbody");
    elements.changeTableOnce = document.querySelector("#rlmChangeTableOnce tbody");
    elements.changeTableMulti = document.querySelector("#rlmChangeTableMulti tbody");
    elements.changeOnceCount = document.getElementById("rlmChangeOnceCount");
    elements.changeMultiCount = document.getElementById("rlmChangeMultiCount");
    elements.errorChangeTable = document.querySelector("#rlmErrorChangeTable tbody");
    elements.errorChangeCount = document.getElementById("rlmErrorChangeCount");
    elements.deltaToggle = document.getElementById("rlmDeltaToggle");
  }

  function bindEvents() {
    if (elements.refresh) {
      elements.refresh.addEventListener("click", () => {
        readFilters();
        fetchJobs();
        refreshAll();
      });
    }
    if (elements.machine) {
      elements.machine.addEventListener("change", async () => {
        clearJobFilters();
        state.selectedReelId = "";
        updateMachineBadge();
        updateRangeLabel();
        try {
          await fetchJobs();
        } catch (error) {
          console.error("Failed to refresh job list", error);
        }
        await refreshAll();
      });
    }
    if (elements.job) {
      elements.job.addEventListener("change", () => {
        const value = elements.job.value;
        if (value) {
          addJobFilter(value);
          elements.job.value = "";
        }
      });
    }
    if (elements.deltaToggle) {
      elements.deltaToggle.checked = !!state.deltaShowOobOnly;
      elements.deltaToggle.addEventListener("change", () => {
        state.deltaShowOobOnly = elements.deltaToggle.checked;
        renderDeltaChart(state.monitoringPoints || []);
      });
    }
    elements.deltaChartLoader = document.getElementById("rlmDeltaChartLoader");

    const handleDeltaLimitsUpdate = () => {
      updateLimitState();
      renderCurlengthChart(state.monitoringPoints);
      renderDeltaChart(state.monitoringPoints);
    };
    if (elements.deltaAxisApply) {
      elements.deltaAxisApply.addEventListener("click", handleDeltaLimitsUpdate);
    }
    if (elements.deltaBoundsApply) {
      elements.deltaBoundsApply.addEventListener("click", handleDeltaLimitsUpdate);
    }
    if (elements.deltaReelSelect) {
      elements.deltaReelSelect.addEventListener("change", () => {
        state.selectedReelId = elements.deltaReelSelect.value;
        renderDeltaReelCharts();
      });
    }
    [elements.contextRangeMin, elements.contextRangeMax].forEach((input, idx) => {
      if (input) {
        input.addEventListener("input", () => {
          state.contextRange = state.contextRange || { min: null, max: null };
          if (idx === 0) {
            state.contextRange.min = input.value !== "" ? Number(input.value) : null;
          } else {
            state.contextRange.max = input.value !== "" ? Number(input.value) : null;
          }
          renderDeltaReelContext(state.selectedReelId);
        });
      }
    });
  }

  function updateLimitState() {
    state.targetValue = parseLimitValue(elements.targetValue);
    state.minusTolerance = parseLimitValue(elements.minusTolerance);
    state.plusTolerance = parseLimitValue(elements.plusTolerance);
    state.customErrShrink = parseLimitValue(elements.errShrinkOverride);
    state.customErrExpand = parseLimitValue(elements.errExpandOverride);
    state.deltaYMin = parseLimitValue(elements.deltaAxisMin);
    state.deltaYMax = parseLimitValue(elements.deltaAxisMax);
    updateCurlengthStats(state.monitoringPoints);
  }

  function parseLimitValue(input) {
    if (!input || !input.value) return null;
    const value = parseFloat(input.value);
    return Number.isFinite(value) ? value : null;
  }

  function hydrateMachineSelect() {
    if (!elements.machine || !bootstrap.machines) return;
    const existingValue = elements.machine.value;
    elements.machine.innerHTML = "";
    bootstrap.machines.forEach((machine) => {
      const option = document.createElement("option");
      option.value = machine.machine_id;
      option.textContent = machine.machine_name;
      elements.machine.appendChild(option);
    });
    const defaultValue = existingValue || bootstrap.defaultMachineId || (bootstrap.machines[0] && bootstrap.machines[0].machine_id) || "";
    elements.machine.value = defaultValue;
    state.machineId = String(defaultValue);
    updateMachineBadge();
  }

  function readFilters() {
    if (elements.machine && elements.machine.value) {
      state.machineId = elements.machine.value;
    } else if (bootstrap.defaultMachineId) {
      state.machineId = String(bootstrap.defaultMachineId);
      if (elements.machine) elements.machine.value = state.machineId;
    } else {
      state.machineId = "";
    }
    state.start = elements.start && elements.start.value ? elements.start.value : bootstrap.defaultStartDate;
    state.end = elements.end && elements.end.value ? elements.end.value : bootstrap.defaultEndDate;
    const minFeetValue = elements.minFeet && elements.minFeet.value ? parseFloat(elements.minFeet.value) : null;
    state.minFeet = Number.isFinite(minFeetValue) ? minFeetValue : null;
    updateLimitState();
    updateMachineBadge();
    renderJobChips();
  }

  function updateMachineBadge() {
    if (!elements.machine) return;
    elements.machine.classList.add("machine-select-active");
  }

  function buildParams(extra = {}) {
    const params = new URLSearchParams();
    if (state.start) params.append("start", state.start);
    if (state.end) params.append("end", state.end);
    if (state.machineId) params.append("machine_id", state.machineId);
    if (Number.isFinite(state.minFeet)) params.append("min_feet", state.minFeet);
    (state.jobFilters || []).forEach((job) => {
      if (job) params.append("job_name", job);
    });
    Object.entries(extra).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        params.append(key, value);
      }
    });
    return params.toString();
  }

  function buildParamsWithoutJobs(extra = {}) {
    const params = new URLSearchParams();
    if (state.start) params.append("start", state.start);
    if (state.end) params.append("end", state.end);
    if (state.machineId) params.append("machine_id", state.machineId);
    if (Number.isFinite(state.minFeet)) params.append("min_feet", state.minFeet);
    Object.entries(extra).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        params.append(key, value);
      }
    });
    return params.toString();
  }

  async function fetchJobs() {
    if (!elements.job) return;
    const params = new URLSearchParams();
    const startVal = elements.start && elements.start.value ? elements.start.value : bootstrap.defaultStartDate;
    const endVal = elements.end && elements.end.value ? elements.end.value : bootstrap.defaultEndDate;
    if (startVal) params.append("start", startVal);
    if (endVal) params.append("end", endVal);
    if (elements.machine && elements.machine.value) params.append("machine_id", elements.machine.value);
    if (Number.isFinite(state.minFeet)) params.append("min_feet", state.minFeet);
    try {
      const data = await apiGet(`/rlm/api/jobs?${params.toString()}`);
      const jobs = data.jobs || [];
      elements.job.innerHTML = ['<option value="">Add job filter…</option>', ...jobs.map((job) => `<option value="${job}">${job}</option>`)].join("");
      elements.job.value = "";
    } catch (error) {
      console.error("Failed to load jobs", error);
    }
  }

  function addJobFilter(jobName) {
    const cleaned = (jobName || "").trim();
    if (!cleaned) return;
    if (!state.jobFilters.includes(cleaned)) {
      state.jobFilters.push(cleaned);
      renderJobChips();
      refreshAll();
    }
  }

  function removeJobFilter(jobName) {
    state.jobFilters = state.jobFilters.filter((job) => job !== jobName);
    renderJobChips();
    refreshAll();
  }

  function renderJobChips() {
    if (!elements.jobChips) return;
    const chips = [];
    (state.jobFilters || []).forEach((job) => {
      chips.push(`
        <span class="job-chip">
          ${escapeHtml(job)}
          <button type="button" data-job="${job}" aria-label="Remove ${job}">&times;</button>
        </span>`);
    });
    if (Number.isFinite(state.minFeet)) {
      chips.push(`
        <span class="job-chip job-chip--min-feet">
          Min feet: ${formatNumber(state.minFeet, 0)}
          <button type="button" data-min-feet="clear" aria-label="Clear min feet">&times;</button>
        </span>`);
    }
    if (!chips.length) {
      elements.jobChips.innerHTML = "";
      elements.jobChips.classList.add("hidden");
      return;
    }
    elements.jobChips.classList.remove("hidden");
    elements.jobChips.innerHTML = chips.join("");
    elements.jobChips.querySelectorAll("button[data-job]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const value = btn.getAttribute("data-job");
        removeJobFilter(value);
      });
    });
    const minFeetBtn = elements.jobChips.querySelector("button[data-min-feet]");
    if (minFeetBtn) {
      minFeetBtn.addEventListener("click", () => {
        state.minFeet = null;
        if (elements.minFeet) elements.minFeet.value = "";
        renderJobChips();
        refreshAll();
      });
    }
  }

  function clearJobFilters() {
    state.jobFilters = [];
    renderJobChips();
    if (elements.job) {
      elements.job.value = "";
    }
  }

  async function refreshAll() {
    if (!elements.app) return;
    showLoading();
    readFilters();
    state.selectedReelId = "";
    updateRangeLabel();
    try {
      const baseQuery = buildParams();
      const reelsQuery = buildParams({ limit: "all" });
      const timelineQuery = buildParamsWithoutJobs({ limit: "all" });
      const monitoringsQuery = buildParams({ limit: "all" });
      const tolerancesQuery = buildParams({ limit: "all" });
      const [summary, reels, monitorings, tolerances, timelineReels] = await Promise.all([
        apiGet(`/rlm/api/summary?${baseQuery}`),
        apiGet(`/rlm/api/reels?${reelsQuery}`),
        apiGet(`/rlm/api/monitorings?${monitoringsQuery}`),
        apiGet(`/rlm/api/tolerances?${tolerancesQuery}`),
        apiGet(`/rlm/api/reels?${timelineQuery}`),
      ]);
      state.monitoringPoints = monitorings.points || [];
      state.monitoringSummary = monitorings.perReel || [];
      const toleranceRows = tolerances.tolerances || [];
      state.tolerancePoints = toleranceRows;
      state.reelMeta = buildReelMeta(timelineReels.reels || []);
      state.reelTolerances = buildReelTolerances(toleranceRows);
      const toleranceStats = toleranceRows.length ? computeToleranceStats(toleranceRows, state.reelMeta) : null;
      renderSummary(summary);
      const reelList = reels.reels || [];
      state.reelRows = reelList;
      renderReelTimeline(timelineReels.reels || []);
      renderCurlengthChart(state.monitoringPoints);
      renderDeltaChart(state.monitoringPoints);
      renderToleranceTrend(state.tolerancePoints);
      renderErrorTrend(state.tolerancePoints);
      renderMonitoringTrend(state.monitoringSummary, state.reelMeta);
      renderToleranceSummary(toleranceStats, summary);
      renderToleranceAnalytics(toleranceStats);
      renderErrorChangeTable(toleranceStats);
    } catch (error) {
      console.error("Failed to load RLM data", error);
    } finally {
      hideLoading();
    }
  }

  function showLoading() {
    if (elements.loading) elements.loading.classList.remove("hidden");
  }

  function hideLoading() {
    if (elements.loading) elements.loading.classList.add("hidden");
  }

  function showDeltaChartLoader() {
    if (elements.deltaChartLoader) elements.deltaChartLoader.classList.remove("hidden");
    else showLoading();
  }

  function hideDeltaChartLoader() {
    if (elements.deltaChartLoader) elements.deltaChartLoader.classList.add("hidden");
    else hideLoading();
  }

  async function apiGet(url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }
    return response.json();
  }

  function updateRangeLabel() {
    if (!elements.rangeLabel) return;
    const start = state.start || bootstrap.defaultStartDate;
    const end = state.end || bootstrap.defaultEndDate;
    const machineLabel =
      elements.machine && elements.machine.options && elements.machine.selectedIndex >= 0
        ? elements.machine.options[elements.machine.selectedIndex].text
        : "";
    const dateRange = `${start} → ${end}`;
    elements.rangeLabel.textContent = machineLabel ? `${machineLabel} · ${dateRange}` : dateRange;
  }

  function renderSummary(data) {
    if (!elements.summary) return;
    const nominal = Number.isFinite(data.avgNominalLength) ? data.avgNominalLength : null;
    const cards = [
      { label: "Total Jobs", value: formatNumber(data.totalJobs) },
      { label: "Total Reels", value: formatNumber(data.totalReels) },
      { label: "Avg Nominal (mm)", value: formatMm(data.avgNominalLength, 3) },
      {
        label: "Avg Curlength (mm)",
        value: formatMm(data.avgCurlength, 3),
        detail: deltaBadge(data.avgCurlength, nominal),
      },
      {
        label: "Min Curlength (mm)",
        value: formatMm(data.minCurlength, 3),
        detail: deltaBadge(data.minCurlength, nominal),
      },
      {
        label: "Max Curlength (mm)",
        value: formatMm(data.maxCurlength, 3),
        detail: deltaBadge(data.maxCurlength, nominal),
      },
      {
        label: "Avg Webspeed (m/s)",
        value: formatNumber(data.avgWebspeed, 3),
        detail: webspeedRangeDetail(data.minWebspeed, data.maxWebspeed),
      },
    ];
    elements.summary.innerHTML = cards
      .map((card) => {
        const detail = card.detail ? `<div class="summary-card__detail">${card.detail}</div>` : "";
        return `
        <div class="summary-card">
          <h3>${card.label}</h3>
          <div class="summary-card__value">${escapeHtml(card.value)}</div>
          ${detail}
        </div>`;
      })
      .join("");
  }

  function renderReelTimeline(reels) {
    if (!elements.timelineBar) return;
    const sortedReels = (reels || [])
      .filter((reel) => reel.productionStart)
      .map((reel) => {
        const start = new Date(reel.productionStart);
        const end = new Date(reel.productionEnd || reel.productionStart);
        if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return null;
        return {
          start,
          end,
          jobName: reel.jobName || "Job",
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.start - b.start);

    const segments = [];
    let currentSegment = null;
    sortedReels.forEach((item) => {
      const jobKey = (item.jobName || "job").toLowerCase();
      if (currentSegment && currentSegment.jobKey === jobKey) {
        if (item.end > currentSegment.end) {
          currentSegment.end = item.end;
        }
      } else {
        if (currentSegment) segments.push(currentSegment);
        currentSegment = {
          jobName: item.jobName,
          jobKey,
          start: item.start,
          end: item.end,
        };
      }
    });
    if (currentSegment) segments.push(currentSegment);

    if (!segments.length) {
      elements.timelineBar.innerHTML = "<p>No reels with timeline data</p>";
      return;
    }
    const filteredSegments =
      (state.jobFilters && state.jobFilters.length
        ? segments.filter((segment) => state.jobFilters.includes(segment.jobName))
        : segments) || [];
    if (!filteredSegments.length) {
      elements.timelineBar.innerHTML = "<p>No timeline data for selected jobs</p>";
      return;
    }
    const minStart = filteredSegments.reduce((min, seg) => Math.min(min, seg.start.getTime()), filteredSegments[0].start.getTime());
    const maxEnd = filteredSegments.reduce((max, seg) => Math.max(max, seg.end.getTime()), filteredSegments[0].end.getTime());
    const totalMs = Math.max(maxEnd - minStart, 1);

    elements.timelineBar.innerHTML = filteredSegments
      .map((segment) => {
        const duration = segment.end.getTime() - segment.start.getTime();
        const pct = Math.max((duration / totalMs) * 100, 1);
        const color = colorForJob(segment.jobName);
        const rawLabel = segment.jobName || "Job";
        const safeLabel = escapeHtml(rawLabel);
        const tooltip = `${safeLabel}: ${segment.start.toLocaleString()} → ${segment.end.toLocaleString()}`;
        return `
          <div class="timeline-segment" style="flex-basis:${pct}%; background:${color}1a; border-color:${color};" title="${tooltip}">
            <span>${safeLabel}</span>
          </div>`;
      })
      .join("");
  }

  function renderToleranceTrend(points) {
    if (!elements.toleranceChart) return;
    if (!points || !points.length) {
      elements.toleranceChart.innerHTML = "<p>No tolerance data</p>";
      return;
    }
    const metaByReel = state.reelMeta || {};
    const sorted = [...points].sort((a, b) => {
      const aMeta = metaByReel[a.reelDbId] || {};
      const bMeta = metaByReel[b.reelDbId] || {};
      const aTime = aMeta.start ? new Date(aMeta.start).getTime() : a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const bTime = bMeta.start ? new Date(bMeta.start).getTime() : b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return aTime - bTime;
    });
    const x = [];
    const hoverText = [];
    const nominal = [];
    const errUpper = [];
    const errLower = [];
    let hasDates = false;
    const historyByReelNominal = {};
    const historyByReelErr = {};
    sorted.forEach((pt, idx) => {
      const meta = metaByReel[pt.reelDbId] || {};
      const startDate = meta.start ? new Date(meta.start) : pt.timestamp ? new Date(pt.timestamp) : null;
      const endDate = meta.end ? new Date(meta.end) : null;
      const xValue = startDate ? startDate.toISOString() : `Step ${idx + 1}`;
      if (startDate) hasDates = true;
      x.push(xValue);
      const jobLabel = meta.jobName || pt.jobName || "Job";
      const reelLabel = meta.reelId || pt.reelId || pt.reelDbId || `Seq ${idx + 1}`;
      const nominalVal = toNumber(pt.nominalLength);
      const errShrink = toNumber(pt.errShrink);
      const errExpand = toNumber(pt.errExpand);
      const history = historyByReelNominal[pt.reelDbId] || { nominal: [], shrink: [], expand: [] };
      historyByReelNominal[pt.reelDbId] = history;
      addHistory(history.nominal, formatMm(nominalVal, 3));
      addHistory(history.shrink, formatRawTolerance(errShrink));
      addHistory(history.expand, formatRawTolerance(errExpand));
      const timeLine = startDate
        ? `${startDate.toLocaleString()}${endDate ? ` → ${endDate.toLocaleString()}` : ""}`
        : `Step ${idx + 1}`;
      const hoverLines = [
        `<b>${jobLabel}</b> · ${reelLabel}`,
        timeLine,
        historyLine("Nominal", history.nominal),
        historyLine("Err shrink", history.shrink),
        historyLine("Err expand", history.expand),
        `Feet: ${formatFeet(meta.feet)}`,
      ];
      hoverText.push(hoverLines.join("<br>"));
      nominal.push(nominalVal);
      errUpper.push(nominalVal !== null && errExpand !== null ? nominalVal + errExpand : null);
      errLower.push(nominalVal !== null && errShrink !== null ? nominalVal - Math.abs(errShrink) : null);
    });
    const traces = [
      {
        x,
        y: nominal,
        mode: "lines+markers",
        name: "Nominal",
        line: { color: "#2563eb", width: 2 },
        marker: { size: 5, color: "#2563eb" },
        text: hoverText,
        hoverinfo: "text",
      },
    ];

    Plotly.react(
      elements.toleranceChart,
      traces,
      {
        margin: { t: 65, r: 30, b: 50, l: 70 },
        title: { text: "", x: 0.5 },
        font: { family: "'Inter', sans-serif", color: "#0f172a" },
        height: 360,
        yaxis: {
          title: { text: "Length (mm)", standoff: 14, font: { size: 13, color: "#0f172a", family: "'Inter', sans-serif", weight: "600" } },
          tickfont: { family: "'Inter', sans-serif", color: "#475569" },
          automargin: true,
        },
        xaxis: {
          title: { text: "Timestamp", standoff: 12, font: { size: 13, color: "#0f172a", family: "'Inter', sans-serif", weight: "600" } },
          type: hasDates ? "date" : "category",
          tickfont: { family: "'Inter', sans-serif", color: "#475569" },
          automargin: true,
        },
        paper_bgcolor: "#ffffff",
        plot_bgcolor: "#ffffff",
        showlegend: true,
        legend: { orientation: "h", y: -0.2 },
      },
      { displayModeBar: true, responsive: true }
    );
  }

  function renderToleranceSummary(stats, summaryData) {
    if (!elements.toleranceSummary) return;
    if (!stats) {
      elements.toleranceSummary.innerHTML = "<p>No tolerance data.</p>";
      return;
    }
    const totalReelsValue = summaryData ? summaryData.totalReels : stats.totalReels;
    const missingReelsCount = summaryData ? Math.max((summaryData.totalReels || 0) - stats.totalReels, 0) : 0;
    const totalReelsDetail =
      missingReelsCount > 0 ? `Missing tolerances: ${formatNumber(missingReelsCount)}` : "All reels have tolerances";
    const zeroMonitoringReels =
      (state.reelRows || []).filter((reel) => !Number(reel.monitorCount)).map((reel) => ({
        reelDbId: reel.reelDbId,
        reelId: reel.reelId || reel.reelDbId,
        jobName: reel.jobName || "Unknown Job",
      })) || [];
    const zeroMonitoringCount = zeroMonitoringReels.length;
    const cardsGroupOne = [
      buildSummaryCard({
        label: "Total Reels",
        value: formatNumber(totalReelsValue),
        detail: totalReelsDetail,
        tooltip: buildMissingReelsTooltip(stats.missingReels),
      }),
      buildSummaryCard({
        label: "Repeat Length Changes",
        value: formatNumber(stats.repeatLengthOverall.totalChanges),
        detail: `Reels tracked: ${formatNumber(stats.repeatLengthOverall.reelCount)}`,
        tooltip: buildNominalDistributionTooltip(stats.repeatLengthOverall.distribution),
      }),
    ];
    const cardsGroupTwo = [
      buildSummaryCard({
        label: "Repeat Length (mm)",
        value: `Avg ${formatMm(stats.nominal.avg, 3)}`,
        detail: `Min ${formatMm(stats.nominal.min, 3)} · Max ${formatMm(stats.nominal.max, 3)}`,
      }),
      buildSummaryCard({
        label: "Err shrink",
        value: `Avg ${formatRawTolerance(stats.shrink.avg)}`,
        detail: `Min ${formatRawTolerance(stats.shrink.min)} · Max ${formatRawTolerance(stats.shrink.max)}`,
      }),
      buildSummaryCard({
        label: "Err expand",
        value: `Avg ${formatRawTolerance(stats.expand.avg)}`,
        detail: `Min ${formatRawTolerance(stats.expand.min)} · Max ${formatRawTolerance(stats.expand.max)}`,
      }),
    ];
    const allCards = [...cardsGroupOne, ...cardsGroupTwo];
    elements.toleranceSummary.innerHTML = allCards.map(renderSummaryCard).join("");
  }

  function buildSummaryCard(config) {
    return {
      label: config.label,
      value: config.value,
      detail: config.detail || "",
      tooltip: config.tooltip || "",
    };
  }

  function renderSummaryCard(card) {
    const detail = card.detail ? `<div class="summary-card__detail">${card.detail}</div>` : "";
    const infoButton = card.tooltip
      ? `<button type="button" class="summary-card__info" data-tooltip="${escapeAttr(card.tooltip)}" aria-label="More info">i</button>`
      : "";
    return `
      <div class="summary-card">
        ${infoButton}
        <h3>${card.label}</h3>
        <div class="summary-card__value">${escapeHtml(card.value)}</div>
        ${detail}
      </div>`;
  }

  function buildMissingReelsTooltip(missingReels) {
    if (!missingReels || !missingReels.length) return "";
    return missingReels
      .map((entry) => `${escapeHtml(entry.jobName || "Job")} · ${escapeHtml(entry.reelId)}`)
      .join("\n");
  }

  function buildZeroMonitoringTooltip(reels) {
    if (!reels || !reels.length) return "";
    return reels
      .slice(0, 10)
      .map((entry) => `${escapeHtml(entry.jobName || "Job")} · ${escapeHtml(entry.reelId)}`)
      .join("\n");
  }

  function buildChangeDetailTooltip(details) {
    if (!details) return "";
    const sections = [];
    if (details.once && details.once.length) {
      const lines = details.once
        .slice(0, 10)
        .map((entry) => `• ${escapeHtml(entry.jobName || "Job")} · ${escapeHtml(entry.reelId)}`);
      const extra = details.once.length > 10 ? `(+${details.once.length - 10} more)` : "";
      sections.push(`1 change:\n${lines.join("\n")}${extra ? `\n${extra}` : ""}`);
    }
    if (details.multi && details.multi.length) {
      const lines = details.multi
        .slice(0, 10)
        .map((entry) => `• ${escapeHtml(entry.jobName || "Job")} · ${escapeHtml(entry.reelId)}`);
      const extra = details.multi.length > 10 ? `(+${details.multi.length - 10} more)` : "";
      sections.push(`2+ changes:\n${lines.join("\n")}${extra ? `\n${extra}` : ""}`);
    }
    return sections.join("\n\n");
  }

  function renderToleranceAnalytics(stats) {
    renderChangeMixChart(stats ? stats.repeatLengthMix : null);
    renderJobChangeChart(stats ? stats.repeatLengthByJob : null);
    renderRawDataTable(stats);
    renderChangeTables(stats);
  }

  function renderErrorChangeTable(stats) {
    if (!elements.errorChangeTable) return;
    if (!stats) {
      elements.errorChangeTable.innerHTML = "<tr><td colspan=\"6\">No error change data.</td></tr>";
      if (elements.errorChangeCount) elements.errorChangeCount.textContent = "0";
      return;
    }
    const rows = stats.errorChanges || [];
    if (elements.errorChangeCount) elements.errorChangeCount.textContent = formatNumber(rows.length);
    if (!rows.length) {
      elements.errorChangeTable.innerHTML = "<tr><td colspan=\"6\">No error change data.</td></tr>";
      return;
    }
    const html = rows
      .map((row) => {
        const start = row.start ? new Date(row.start) : null;
        const end = row.end ? new Date(row.end) : null;
        return `
          <tr>
            <td>${escapeHtml(row.jobName)}</td>
            <td>${escapeHtml(row.reelId)}</td>
            <td>${formatTime(start)}</td>
            <td>${formatTime(end)}</td>
            <td>${row.errShrinkChanges.join("<br>") || "--"}</td>
            <td>${row.errExpandChanges.join("<br>") || "--"}</td>
          </tr>`;
      })
      .join("");
    elements.errorChangeTable.innerHTML = html;
  }

  function renderChangeTables(stats) {
    if (!stats) {
      if (elements.changeTableOnce) elements.changeTableOnce.innerHTML = "<tr><td colspan=\"5\">No data.</td></tr>";
      if (elements.changeTableMulti) elements.changeTableMulti.innerHTML = "<tr><td colspan=\"5\">No data.</td></tr>";
      if (elements.changeOnceCount) elements.changeOnceCount.textContent = "0";
      if (elements.changeMultiCount) elements.changeMultiCount.textContent = "0";
      return;
    }
    const onceRows = buildChangeTableRows(stats.changeDetails?.once || []);
    const multiRows = buildChangeTableRows(stats.changeDetails?.multi || []);
    if (elements.changeOnceCount) elements.changeOnceCount.textContent = formatNumber(onceRows.length);
    if (elements.changeMultiCount) elements.changeMultiCount.textContent = formatNumber(multiRows.length);
    if (elements.changeTableOnce) {
      elements.changeTableOnce.innerHTML = onceRows.length
        ? onceRows.join("")
        : "<tr><td colspan=\"5\">No reels with 1 change.</td></tr>";
    }
    if (elements.changeTableMulti) {
      elements.changeTableMulti.innerHTML = multiRows.length
        ? multiRows.join("")
        : "<tr><td colspan=\"5\">No reels with 2+ changes.</td></tr>";
    }
  }

  function buildChangeTableRows(entries) {
    if (!entries.length) return [];
    return entries
      .map((entry) => {
        const meta = state.reelMeta[entry.reelDbId] || {};
        const startDate = entry.start || meta.start || null;
        const endDate = entry.end || meta.end || null;
        const start = startDate ? new Date(startDate) : null;
        const end = endDate ? new Date(endDate) : null;
        const changes = (entry.changes || []).map((change) => `${formatMm(change.from, 3)} → ${formatMm(change.to, 3)}`).join("<br>");
        return {
          timestamp: start ? start.getTime() : 0,
          row: `
            <tr>
              <td>${escapeHtml(entry.jobName || meta.jobName || "Job")}</td>
              <td>${escapeHtml(entry.reelId || meta.reelId || entry.reelDbId)}</td>
              <td>${formatTime(start)}</td>
              <td>${formatTime(end)}</td>
              <td>${changes || "--"}</td>
            </tr>`,
        };
      })
      .sort((a, b) => a.timestamp - b.timestamp)
      .map((entry) => entry.row);
  }

  function renderDeltaMiniCharts(outOfBounds, totalPoints, shrinkCount, expandCount) {
    const pieTarget = document.getElementById("rlmDeltaOobPie");
    const barTarget = document.getElementById("rlmDeltaOobBar");
    if (!pieTarget || !barTarget) return;

    if (!totalPoints) {
      if (window.Plotly) {
        Plotly.purge(pieTarget);
        Plotly.purge(barTarget);
      }
      pieTarget.innerHTML = '<div class="chart-empty">No delta data</div>';
      barTarget.innerHTML = '<div class="chart-empty">No delta data</div>';
      return;
    }

    const oobPercent = totalPoints ? (outOfBounds / totalPoints) * 100 : 0;
    const pieData = [
      {
        values: [outOfBounds, Math.max(totalPoints - outOfBounds, 0)],
        labels: ["Out of bounds", "Within bounds"],
        type: "pie",
        hole: 0.55,
        marker: { colors: ["#ef4444", "#2563eb"] },
        textinfo: "label+percent",
        hoverinfo: "label+value+percent",
      },
    ];
    Plotly.react(
      pieTarget,
      pieData,
      {
        margin: { t: 50, b: 20, l: 10, r: 10 },
        showlegend: false,
        height: 260,
        annotations: [
          {
            text: `${oobPercent.toFixed(1)}%`,
            showarrow: false,
            font: { size: 16, color: "#0f172a" },
          },
        ],
      },
      { displayModeBar: false, responsive: true }
    );

    const barData = [
      {
        x: ["Below bounds", "Above bounds"],
        y: [shrinkCount, expandCount],
        type: "bar",
        marker: { color: ["#fb923c", "#3b82f6"] },
        text: [shrinkCount, expandCount],
        textposition: "auto",
      },
    ];
    Plotly.react(
      barTarget,
      barData,
      {
        margin: { t: 50, b: 30, l: 40, r: 10 },
        height: 260,
        yaxis: { title: "Points" },
      },
      { displayModeBar: false, responsive: true }
    );
  }

  function renderRawDataTable(stats) {
    if (!elements.rawTable) return;
    const rows = buildRawDataRows(stats);
    if (!rows.length) {
      elements.rawTable.innerHTML = '<tr><td colspan="9">No reel data available.</td></tr>';
      return;
    }
    elements.rawTable.innerHTML = rows
      .map(
        (row) => `
          <tr>
            <td>${escapeHtml(row.jobName)}</td>
            <td>${escapeHtml(row.reelLabel)}</td>
            <td>${formatFeet(row.feet)}</td>
            <td>${formatTime(row.start)}</td>
            <td>${formatTime(row.end)}</td>
            <td>${formatNumber(row.monitorCount)}</td>
            <td>${formatHistoryList(row.nominalHistory)}</td>
            <td>${formatHistoryList(row.shrinkHistory)}</td>
            <td>${formatHistoryList(row.expandHistory)}</td>
          </tr>`
      )
      .join("");
  }

  function buildRawDataRows(stats) {
    const histories = (stats && stats.histories) || {};
    const monitoringMap = (state.monitoringSummary || []).reduce((acc, item) => {
      acc[item.reelDbId] = item;
      return acc;
    }, {});
    return (state.reelRows || [])
      .map((reel) => {
        const meta = state.reelMeta[reel.reelDbId] || {
          jobName: reel.jobName || "",
          reelId: reel.reelId || reel.reelDbId,
          start: reel.productionStart ? new Date(reel.productionStart) : null,
          end: reel.productionEnd ? new Date(reel.productionEnd) : null,
          feet: computeFeetFromReel(reel),
        };
        const monitoring = monitoringMap[reel.reelDbId] || {};
        const history = histories[reel.reelDbId] || {};
        return {
          jobName: meta.jobName || reel.jobName || "Job",
          reelLabel: meta.reelId || reel.reelId || `#${reel.reelDbId}`,
          feet: typeof meta.feet === "number" ? meta.feet : computeFeetFromReel(reel),
          start: meta.start || (reel.productionStart ? new Date(reel.productionStart) : null),
          end: meta.end || (reel.productionEnd ? new Date(reel.productionEnd) : null),
          monitorCount: monitoring.monitorCount || reel.monitorCount || 0,
          nominalHistory: history.nominal || [],
          shrinkHistory: history.shrink || [],
          expandHistory: history.expand || [],
        };
      })
      .sort((a, b) => {
        const jobCompare = a.jobName.localeCompare(b.jobName);
        if (jobCompare !== 0) return jobCompare;
        const aTime = a.start ? new Date(a.start).getTime() : 0;
        const bTime = b.start ? new Date(b.start).getTime() : 0;
        return aTime - bTime;
      });
  }

  function computeMedian(values) {
    if (!values || !values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
      return (sorted[mid - 1] + sorted[mid]) / 2;
    }
    return sorted[mid];
  }

  function buildReelTolerances(rows) {
    const map = {};
    (rows || []).forEach((row) => {
      const reelId = row.reelDbId;
      if (!reelId) return;
      const existing = map[reelId];
      const sequence = Number(row.sequence) || 0;
      if (!existing || sequence >= existing.sequence) {
        map[reelId] = {
          sequence,
          reelId: row.reelId || row.reelDbId,
          jobName: row.jobName || "",
          nominalLength: toNumber(row.nominalLength),
          errShrink: toNumber(row.errShrink),
          errExpand: toNumber(row.errExpand),
        };
      }
    });
    return map;
  }

  function renderChangeMixChart(mix) {
    if (!elements.changeMixChart) return;
    if (!mix) {
      if (window.Plotly) {
        Plotly.purge(elements.changeMixChart);
      }
      elements.changeMixChart.innerHTML = "<p>No tolerance change data.</p>";
      return;
    }
    const values = [mix.none, mix.once, mix.multi];
    if (!values.some((val) => val > 0)) {
      if (window.Plotly) {
        Plotly.purge(elements.changeMixChart);
      }
      elements.changeMixChart.innerHTML = "<p>No in-reel changes recorded.</p>";
      return;
    }
    if (window.Plotly) {
      Plotly.purge(elements.changeMixChart);
    }
    elements.changeMixChart.innerHTML = "";
    Plotly.newPlot(
      elements.changeMixChart,
      [
        {
          values,
          labels: ["No change", "1 change", "2+ changes"],
          type: "pie",
          hole: 0.55,
          textinfo: "label+percent",
          hovertemplate: "%{label}<br>%{value} reels<extra></extra>",
          marker: { colors: ["#e2e8f0", "#a5b4fc", "#7c3aed", "#4c1d95"] },
        },
      ],
      {
        margin: { t: 10, b: 10, l: 10, r: 10 },
        height: 260,
        showlegend: false,
      },
      { displayModeBar: false, responsive: true }
    );
  }

  function renderJobChangeChart(jobStats) {
    if (!elements.changeJobChart) return;
    if (!jobStats || !jobStats.length) {
      if (window.Plotly) {
        Plotly.purge(elements.changeJobChart);
      }
      elements.changeJobChart.innerHTML = "<p>No job change data.</p>";
      return;
    }
    const topJobs = jobStats.slice(0, 5);
    if (window.Plotly) {
      Plotly.purge(elements.changeJobChart);
    }
    elements.changeJobChart.innerHTML = "";
    Plotly.newPlot(
      elements.changeJobChart,
      [
        {
          x: topJobs.map((entry) => entry.count),
          y: topJobs.map((entry) => entry.jobName),
          type: "bar",
          orientation: "h",
          marker: { color: "#6366f1" },
          hovertemplate: "<b>%{y}</b><br>%{x} total changes<extra></extra>",
        },
      ],
      {
        margin: { t: 20, b: 20, l: 140, r: 20 },
        height: 260,
        xaxis: { title: "Total in-reel changes" },
        yaxis: { automargin: true },
      },
      { displayModeBar: false, responsive: true }
    );
  }

  function renderErrorTrend(points) {
    if (!elements.errorTrendChart) return;
    if (!points || !points.length) {
      elements.errorTrendChart.innerHTML = "<p>No tolerance data</p>";
      return;
    }
    const metaByReel = state.reelMeta || {};
    const sorted = [...points].sort((a, b) => {
      const aMeta = metaByReel[a.reelDbId] || {};
      const bMeta = metaByReel[b.reelDbId] || {};
      const aTime = aMeta.start ? new Date(aMeta.start).getTime() : a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const bTime = bMeta.start ? new Date(bMeta.start).getTime() : b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return aTime - bTime;
    });
    const x = [];
    const shrinkValues = [];
    const expandValues = [];
    const hoverText = [];
    let hasDates = false;
    const historyByReelErr = {};

    sorted.forEach((pt, idx) => {
      const meta = metaByReel[pt.reelDbId] || {};
      const startDate = meta.start ? new Date(meta.start) : pt.timestamp ? new Date(pt.timestamp) : null;
      const endDate = meta.end ? new Date(meta.end) : null;
      const xValue = startDate ? startDate.toISOString() : `Step ${idx + 1}`;
      if (startDate) hasDates = true;
      x.push(xValue);
      const jobLabel = meta.jobName || pt.jobName || "Job";
      const reelLabel = meta.reelId || pt.reelId || pt.reelDbId || `Seq ${idx + 1}`;
      const errShrink = toNumber(pt.errShrink);
      const errExpand = toNumber(pt.errExpand);
      shrinkValues.push(errShrink);
      expandValues.push(errExpand);

      const history = historyByReelErr[pt.reelDbId] || { shrink: [], expand: [] };
      historyByReelErr[pt.reelDbId] = history;
      addHistory(history.shrink, formatRawTolerance(errShrink));
      addHistory(history.expand, formatRawTolerance(errExpand));

      const timeLine = startDate
        ? `${startDate.toLocaleString()}${endDate ? ` → ${endDate.toLocaleString()}` : ""}`
        : `Step ${idx + 1}`;

      const nominalVal = toNumber(pt.nominalLength);
      hoverText.push(
        [
          `<b>${jobLabel}</b> · ${reelLabel}`,
          timeLine,
          `Nominal: ${formatMm(nominalVal, 3)}`,
          historyLine("Err shrink", history.shrink),
          historyLine("Err expand", history.expand),
        ].join("<br>")
      );
    });

    const traces = [
      {
        x,
        y: shrinkValues,
        mode: "lines+markers",
        name: "Err shrink",
        line: { color: "#f97316", width: 2 },
        marker: { size: 5, color: "#f97316" },
        text: hoverText,
        hoverinfo: "text",
        hoverlabel: { bgcolor: "#e0f2fe", font: { color: "#0f172a" } },
      },
      {
        x,
        y: expandValues,
        mode: "lines+markers",
        name: "Err expand",
        line: { color: "#0ea5e9", width: 2 },
        marker: { size: 5, color: "#0ea5e9" },
        text: hoverText,
        hoverinfo: "skip",
      },
    ];

    Plotly.react(
      elements.errorTrendChart,
      traces,
      {
        margin: { t: 65, r: 30, b: 50, l: 70 },
        title: { text: "", x: 0.5 },
        font: { family: "'Inter', sans-serif", color: "#0f172a" },
        height: 320,
        yaxis: {
          title: { text: "Raw tolerance (units)", standoff: 16, font: { size: 13, color: "#0f172a", family: "'Inter', sans-serif", weight: "600" } },
          tickfont: { family: "'Inter', sans-serif", color: "#475569" },
          automargin: true,
        },
        xaxis: {
          title: { text: "Timestamp", standoff: 14, font: { size: 13, color: "#0f172a", family: "'Inter', sans-serif", weight: "600" } },
          type: hasDates ? "date" : "category",
          tickfont: { family: "'Inter', sans-serif", color: "#475569" },
          automargin: true,
        },
        paper_bgcolor: "#ffffff",
        plot_bgcolor: "#ffffff",
        showlegend: true,
        legend: { orientation: "h", y: -0.2 },
      },
      { displayModeBar: true, responsive: true }
    );
  }

  function renderMonitoringTrend(perReelSummary, reelMeta) {
    if (!elements.monitoringTrendChart) return;
    const summary = perReelSummary || [];
    if (!summary.length) {
      elements.monitoringTrendChart.innerHTML = "<p>No monitoring summary data.</p>";
      return;
    }
    const rows = summary
      .map((item) => {
        const meta = (reelMeta && reelMeta[item.reelDbId]) || {};
        const start = meta.start ? new Date(meta.start) : null;
        const monitorCount = Number(item.monitorCount) || 0;
        const feet = Number.isFinite(meta.feet) ? meta.feet : null;
        if (!feet || monitorCount <= 0) return null;
        const feetPerPoint = feet / monitorCount;
        const hover = [
          `<b>${escapeHtml(meta.jobName || "Job")}</b> · ${escapeHtml(meta.reelId || item.reelDbId)}`,
          `Monitoring points: ${formatNumber(monitorCount)}`,
          `Feet: ${formatFeet(feet)}`,
          `Feet per point: ${formatNumber(feetPerPoint, 2)} ft`,
          `Start: ${formatTime(meta.start)}`,
          `End: ${formatTime(meta.end)}`,
        ].join("<br>");
        return {
          timestamp: start ? start.toISOString() : `Reel ${item.reelDbId}`,
          feetPerPoint,
          hover,
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        const timeA = new Date(a.timestamp).getTime();
        const timeB = new Date(b.timestamp).getTime();
        if (Number.isFinite(timeA) && Number.isFinite(timeB)) {
          return timeA - timeB;
        }
        return a.timestamp.localeCompare(b.timestamp);
      });
    if (!rows.length) {
      elements.monitoringTrendChart.innerHTML = "<p>No monitoring density data.</p>";
      return;
    }
    const hasDates = rows.some((row) => !row.timestamp.startsWith("Reel "));

    Plotly.react(
      elements.monitoringTrendChart,
      [
        {
          x: rows.map((row) => row.timestamp),
          y: rows.map((row) => row.feetPerPoint),
          mode: "lines+markers",
          line: { color: "#0f62fe", width: 2 },
          marker: { size: 6, color: "#0f62fe" },
          hoverinfo: "text",
          text: rows.map((row) => row.hover),
          hoverlabel: { bgcolor: "#eef2ff", font: { color: "#0f172a" } },
        },
      ],
      {
        margin: { t: 65, r: 30, b: 50, l: 70 },
        title: { text: "", x: 0.5 },
        font: { family: "'Inter', sans-serif", color: "#0f172a" },
        height: 320,
        yaxis: {
          title: { text: "Feet per monitoring point", standoff: 16, font: { size: 13, color: "#0f172a", family: "'Inter', sans-serif", weight: "600" } },
          tickfont: { family: "'Inter', sans-serif", color: "#475569" },
          automargin: true,
        },
        xaxis: {
          title: { text: "Timestamp", standoff: 14, font: { size: 13, color: "#0f172a", family: "'Inter', sans-serif", weight: "600" } },
          type: hasDates ? "date" : "category",
          tickfont: { family: "'Inter', sans-serif", color: "#475569" },
          automargin: true,
        },
        paper_bgcolor: "#ffffff",
        plot_bgcolor: "#ffffff",
        showlegend: false,
      },
      { displayModeBar: true, responsive: true }
    );
  }

  function renderCurlengthChart(points) {
    if (!elements.curlengthChart) return;
    if (!points || !points.length) {
      elements.curlengthChart.innerHTML = "<p>No monitoring data</p>";
      updateCurlengthStats([]);
      return;
    }
    const lowerLimit = getLowerLimit();
    const upperLimit = getUpperLimit();
    updateCurlengthStats(points);

    const traces = [];
    const currentMachineLabel =
      elements.machine && elements.machine.options && elements.machine.selectedIndex >= 0
        ? elements.machine.options[elements.machine.selectedIndex].text
        : "Machine";
    const grouped = !state.machineId ? groupByMachine(points) : { [currentMachineLabel]: points };
    Object.entries(grouped).forEach(([machineName, machinePoints], idx) => {
      traces.push(buildTrace(machinePoints, machineName, MACHINE_COLORS[idx % MACHINE_COLORS.length]));
    });

    const shapes = [];
    if (lowerLimit !== null) {
      shapes.push(limitShape(lowerLimit, "#f97316"));
    }
    if (upperLimit !== null) {
      shapes.push(limitShape(upperLimit, "#ef4444"));
    }

    const curlengthValues = points.map((p) => Number(p.curlength)).filter((val) => Number.isFinite(val));
    const webspeedValues = points.map((p) => Number(p.webspeed)).filter((val) => Number.isFinite(val));
    const minCurlength = Math.min(...curlengthValues);
    const maxCurlength = Math.max(...curlengthValues);
    const curlengthRange = Math.max(maxCurlength - minCurlength, 1);
    const minWebspeed = Math.min(...webspeedValues);
    const maxWebspeed = Math.max(...webspeedValues);
    const webspeedRange = Math.max(maxWebspeed - minWebspeed, 1);

    traces.push({
      x: points.map((p) => p.timestamp),
      y: points.map((p) => {
        const speed = Number(p.webspeed);
        if (!Number.isFinite(speed)) return null;
        const normalized = (speed - minWebspeed) / webspeedRange;
        return minCurlength + normalized * (curlengthRange * 0.25);
      }),
      mode: "lines",
      name: "Webspeed (scaled)",
      line: { color: "#16a34a", width: 2, opacity: 0.8 },
      hoverinfo: "text",
      text: points.map((p) => `Webspeed: ${formatNumber(p.webspeed, 3)} m/s`),
    });

    Plotly.react(
      elements.curlengthChart,
      traces,
      {
        margin: { t: 65, r: 70, b: 50, l: 70 },
        title: { text: "", x: 0.5 },
        font: { family: "'Inter', sans-serif", color: "#0f172a" },
        height: 420,
        yaxis: {
          title: { text: "Curlength (mm)", standoff: 16, font: { size: 13, color: "#0f172a", family: "'Inter', sans-serif", weight: "600" } },
          tickfont: { family: "'Inter', sans-serif", color: "#475569" },
          automargin: true,
        },
        xaxis: {
          type: "date",
          title: { text: "Timestamp", standoff: 16, font: { size: 13, color: "#0f172a", family: "'Inter', sans-serif", weight: "600" } },
          tickfont: { family: "'Inter', sans-serif", color: "#475569" },
          automargin: true,
        },
        paper_bgcolor: "#ffffff",
        plot_bgcolor: "#ffffff",
        showlegend: true,
        legend: { orientation: "h" },
        shapes,
      },
      { displayModeBar: true, responsive: true }
    );
  }

  function renderDeltaChart(points) {
    if (!elements.deltaChart) return;

    const resetDeltaOutputs = (message) => {
      elements.deltaChart.innerHTML = message;
      if (elements.deltaSummary) elements.deltaSummary.textContent = "--";
      if (elements.deltaAvg) elements.deltaAvg.textContent = "--";
      if (elements.deltaMin) elements.deltaMin.textContent = "--";
      if (elements.deltaMax) elements.deltaMax.textContent = "--";
      if (elements.deltaStd) elements.deltaStd.textContent = "--";
      renderDeltaMiniCharts(0, 0, 0, 0);
      if (elements.deltaToggle) elements.deltaToggle.checked = !!state.deltaShowOobOnly;
    };

    if (!points || !points.length) {
      state.deltaRows = [];
      resetDeltaOutputs("<p>No monitoring data.</p>");
      return;
    }

    const toleranceMap = state.reelTolerances || {};
    const deltaRows = [];
    let totalPoints = 0;
    let outOfRangeCount = 0;

    points.forEach((point) => {
      const tolerance = toleranceMap[point.reelDbId];
      if (!tolerance || !Number.isFinite(tolerance.nominalLength) || !Number.isFinite(point.curlength)) return;
      const delta = point.curlength - tolerance.nominalLength;
      const errShrink = Number.isFinite(state.customErrShrink)
        ? state.customErrShrink
        : Math.abs(tolerance.errShrink || 0);
      const errExpand = Number.isFinite(state.customErrExpand)
        ? state.customErrExpand
        : Math.abs(tolerance.errExpand || 0);
      const lower = -Math.abs(errShrink);
      const upper = Math.abs(errExpand);
      const outOfRange = delta < lower || delta > upper;
      const meta = state.reelMeta[point.reelDbId] || {};
      const formatValue = toNumber(point.formatValue);
      const formatFeetLocation = Number.isFinite(formatValue) ? computeFeetFromValues(meta.formatStart, formatValue) : null;
      totalPoints += 1;
      if (outOfRange) outOfRangeCount += 1;
      const reelLabel = meta.reelId || point.reelId || tolerance.reelId || point.reelDbId;
      deltaRows.push({
        reelDbId: point.reelDbId,
        timestamp: point.timestamp ? new Date(point.timestamp).getTime() : 0,
        timestampIso: point.timestamp,
        timestampLabel: formatTime(point.timestamp),
        jobName: point.jobName || tolerance.jobName || meta.jobName || "Job",
        reelId: reelLabel,
        displayReel: reelLabel,
        productionStart: point.productionStart || (meta.start ? meta.start.toISOString() : null),
        nominal: tolerance.nominalLength,
        lower,
        upper,
        actual: point.curlength,
        delta,
        formatValue,
        formatFeet: formatFeetLocation,
        webspeed: Number.isFinite(point.webspeed) ? Number(point.webspeed) : null,
        outOfRange,
        shrink: delta < lower,
        expand: delta > upper,
        boundsLabel: `Shr ${formatMm(lower, 3)} / Exp ${formatMm(upper, 3)}`,
        hover: [
          `Reel: ${escapeHtml(point.reelId || tolerance.reelId || meta.reelId || point.reelDbId)}`,
          `Start: ${formatTime(point.productionStart || meta.start)}`,
          `Location: ${formatFeetLocation !== null ? `${formatNumber(formatFeetLocation, 0)} ft` : "Unknown"}`,
          `Job: ${escapeHtml(point.jobName || tolerance.jobName || meta.jobName || "Job")}`,
          `Feet: ${formatFeet(meta.feet)}`,
          `Bounds: ${formatMm(lower, 3)} → ${formatMm(upper, 3)}`,
          `Nominal: ${formatMm(tolerance.nominalLength, 3)}`,
          `Actual: ${formatMm(point.curlength, 3)}`,
          `Delta: ${formatMm(delta, 3)}`,
        ].join("<br>"),
      });
    });

    if (!deltaRows.length) {
      state.deltaRows = [];
      resetDeltaOutputs("<p>No tolerance data to compute deltas.</p>");
      return;
    }

    state.deltaRows = deltaRows.sort((a, b) => a.timestamp - b.timestamp);
    const reelAggregates = {};
    state.deltaRows.forEach((row) => {
      if (!row.reelDbId) return;
      if (!reelAggregates[row.reelDbId]) {
        const meta = state.reelMeta[row.reelDbId] || {};
        const startDate = meta.start || null;
        reelAggregates[row.reelDbId] = {
          total: 0,
          oob: 0,
          feet: Number.isFinite(meta.feet) ? meta.feet : null,
          startDate,
          startTs: null,
        };
      }
      const aggregate = reelAggregates[row.reelDbId];
      aggregate.total += 1;
      if (row.outOfRange) aggregate.oob += 1;
      if (Number.isFinite(row.timestamp) && row.timestamp > 0) {
        aggregate.startTs =
          aggregate.startTs === null || row.timestamp < aggregate.startTs ? row.timestamp : aggregate.startTs;
      }
    });
    let approxFeetOob = null;
    let goodReelCount = 0;
    let badReelCount = 0;
    Object.values(reelAggregates).forEach((entry) => {
      if (!Number.isFinite(entry.feet) || entry.total <= 0) return;
      if (entry.oob > 0) badReelCount += 1;
      else goodReelCount += 1;
      const reelFeet = (entry.oob / entry.total) * entry.feet;
      approxFeetOob = (approxFeetOob || 0) + reelFeet;
    });
    const totalReels = goodReelCount + badReelCount;
    if (elements.reelCountTotal) elements.reelCountTotal.textContent = `${totalReels}`;
    if (elements.reelCountGood) elements.reelCountGood.textContent = `${goodReelCount}`;
    if (elements.reelCountBad) elements.reelCountBad.textContent = `${badReelCount}`;
    const displayRows = state.deltaShowOobOnly ? state.deltaRows.filter((row) => row.outOfRange) : state.deltaRows;
    let goodFeetTotal = null;
    let badFeetTotal = null;
    if (Number.isFinite(approxFeetOob)) {
      badFeetTotal = approxFeetOob;
      const totalFeet = Object.values(reelAggregates)
        .filter((entry) => Number.isFinite(entry.feet))
        .reduce((sum, entry) => sum + entry.feet, 0);
      if (Number.isFinite(totalFeet)) {
        goodFeetTotal = Math.max(totalFeet - badFeetTotal, 0);
        if (elements.deltaFeetTotal) elements.deltaFeetTotal.textContent = `${formatNumber(totalFeet, 0)} ft`;
        const goodPct = totalFeet ? (goodFeetTotal / totalFeet) * 100 : null;
        const badPct = totalFeet ? (badFeetTotal / totalFeet) * 100 : null;
        if (elements.deltaFeetGoodPct) {
          elements.deltaFeetGoodPct.textContent = Number.isFinite(goodPct) ? `(${formatNumber(goodPct, 0)}%)` : "";
        }
        if (elements.deltaFeetBadPct) {
          elements.deltaFeetBadPct.textContent = Number.isFinite(badPct) ? `(${formatNumber(badPct, 0)}%)` : "";
        }
      } else if (elements.deltaFeetTotal) {
        elements.deltaFeetTotal.textContent = "--";
        if (elements.deltaFeetGoodPct) elements.deltaFeetGoodPct.textContent = "";
        if (elements.deltaFeetBadPct) elements.deltaFeetBadPct.textContent = "";
      }
    } else if (elements.deltaFeetTotal) {
      elements.deltaFeetTotal.textContent = "--";
      if (elements.deltaFeetGoodPct) elements.deltaFeetGoodPct.textContent = "";
      if (elements.deltaFeetBadPct) elements.deltaFeetBadPct.textContent = "";
    }
    if (elements.deltaFeetBad) {
      elements.deltaFeetBad.textContent = Number.isFinite(badFeetTotal) ? `${formatNumber(badFeetTotal, 0)} ft` : "--";
    }
    if (elements.deltaFeetGood) {
      elements.deltaFeetGood.textContent = Number.isFinite(goodFeetTotal) ? `${formatNumber(goodFeetTotal, 0)} ft` : "--";
    }

    const errShrink = Number.isFinite(state.customErrShrink) ? state.customErrShrink : null;
    const errExpand = Number.isFinite(state.customErrExpand) ? state.customErrExpand : null;
    const lower = errShrink !== null ? -Math.abs(errShrink) : null;
    const upper = errExpand !== null ? Math.abs(errExpand) : null;

    if (!displayRows.length) {
      elements.deltaChart.innerHTML = "<p>No delta points match the current filter.</p>";
      if (elements.deltaAvg) elements.deltaAvg.textContent = "--";
      if (elements.deltaMin) elements.deltaMin.textContent = "--";
      if (elements.deltaMax) elements.deltaMax.textContent = "--";
      if (elements.deltaStd) elements.deltaStd.textContent = "--";
      renderDeltaMiniCharts(0, 0, 0, 0);
      if (elements.deltaSummary) {
        const boundLabel =
          lower !== null && upper !== null ? `${formatMm(lower, 3)} → ${formatMm(upper, 3)}` : "per-reel bounds";
        elements.deltaSummary.textContent = `${outOfRangeCount} / ${totalPoints} pts outside ${boundLabel} - Filter: OOB only`;
      }
      if (elements.deltaToggle) elements.deltaToggle.checked = !!state.deltaShowOobOnly;
      return;
    }

    const yAxisConfig = {
      title: { text: "Delta (mm)", font: { size: 13, color: "#0f172a", family: "Inter", weight: "600" } },
      tickfont: { family: "Inter", color: "#475569" },
    };
    if (Number.isFinite(state.deltaYMin)) {
      yAxisConfig.range = yAxisConfig.range || [];
      yAxisConfig.range[0] = state.deltaYMin;
    }
    if (Number.isFinite(state.deltaYMax)) {
      yAxisConfig.range = yAxisConfig.range || [];
      yAxisConfig.range[1] = state.deltaYMax;
    }

    Plotly.react(
      elements.deltaChart,
      [
        {
          x: displayRows.map((row) => row.timestampIso),
          y: displayRows.map((row) => row.delta),
          mode: "lines+markers",
          line: { color: "#2563eb", width: 1.4 },
          marker: {
            size: 8,
            color: displayRows.map((row) => (row.outOfRange ? "#ef4444" : "rgba(0,0,0,0)")),
          },
          hoverinfo: "text",
          text: displayRows.map((row) => row.hover),
        },
      ],
      {
        margin: { t: 65, r: 30, b: 50, l: 70 },
        title: { text: "", x: 0.5 },
        font: { family: "'Inter', sans-serif", color: "#0f172a" },
        height: 420,
        yaxis: yAxisConfig,
        xaxis: {
          type: "date",
          title: { text: "Timestamp", font: { size: 13, color: "#0f172a", family: "Inter", weight: "600" } },
          tickfont: { family: "Inter", color: "#475569" },
        },
        shapes: [
          ...(lower !== null
            ? [
                {
                  type: "line",
                  xref: "paper",
                  x0: 0,
                  x1: 1,
                  y0: lower,
                  y1: lower,
                  line: { color: "#ef4444", dash: "dot" },
                },
              ]
            : []),
          ...(upper !== null
            ? [
                {
                  type: "line",
                  xref: "paper",
                  x0: 0,
                  x1: 1,
                  y0: upper,
                  y1: upper,
                  line: { color: "#ef4444", dash: "dot" },
                },
              ]
            : []),
          {
            type: "line",
            xref: "paper",
            x0: 0,
            x1: 1,
            y0: 0,
            y1: 0,
            line: { color: "#94a3b8", dash: "solid" },
          },
        ],
        paper_bgcolor: "#ffffff",
        plot_bgcolor: "#ffffff",
      showlegend: false,
    },
      { displayModeBar: true, responsive: true }
    );

    const displayTotal = displayRows.length;
    const displayOutOfRange = displayRows.filter((row) => row.outOfRange).length;
    const displayShrink = displayRows.filter((row) => row.shrink).length;
    const displayExpand = displayRows.filter((row) => row.expand).length;
    renderDeltaMiniCharts(displayOutOfRange, displayTotal, displayShrink, displayExpand);

    const avgDelta = displayTotal ? displayRows.reduce((acc, row) => acc + row.delta, 0) / displayTotal : null;
    const variance =
      displayTotal > 1 ? displayRows.reduce((acc, row) => acc + (row.delta - (avgDelta || 0)) ** 2, 0) / displayTotal : null;
    const stdDelta = variance !== null ? Math.sqrt(Math.max(variance, 0)) : null;
    const minRow = displayRows.reduce((min, row) => (row.delta < min.delta ? row : min), displayRows[0]);
    const maxRow = displayRows.reduce((max, row) => (row.delta > max.delta ? row : max), displayRows[0]);

    if (elements.deltaAvg) {
      elements.deltaAvg.textContent = avgDelta !== null ? formatMm(avgDelta, 3) : "--";
    }
    if (elements.deltaMin) {
      elements.deltaMin.textContent = formatMm(minRow.delta, 3);
    }
    if (elements.deltaMax) {
      elements.deltaMax.textContent = formatMm(maxRow.delta, 3);
    }
    if (elements.deltaStd) {
      elements.deltaStd.textContent = stdDelta !== null ? formatMm(stdDelta, 3) : "--";
    }

    if (elements.deltaSummary) {
      const boundLabel =
        lower !== null && upper !== null ? `${formatMm(lower, 3)} → ${formatMm(upper, 3)}` : "per-reel bounds";
      const filterSuffix = state.deltaShowOobOnly ? " - Filter: OOB only" : "";
      elements.deltaSummary.textContent = `${outOfRangeCount} / ${totalPoints} pts outside ${boundLabel}${filterSuffix}`;
    }

    if (elements.deltaToggle) elements.deltaToggle.checked = !!state.deltaShowOobOnly;
    renderDeltaFeetBar(reelAggregates);
    renderDeltaPointBar(reelAggregates);
    updateDeltaReelOptions();
    renderDeltaReelCharts();
  }

  function renderDeltaFeetBar(reelAggregates) {
    const target = document.getElementById("rlmDeltaFeetBar");
    if (!target) return;
    const entries = Object.entries(reelAggregates)
      .map(([reelDbId, data]) => {
        if (!Number.isFinite(data.feet) || data.total <= 0 || data.oob <= 0) return null;
        const good = Math.max(((data.total - data.oob) / data.total) * data.feet, 0);
        const bad = Math.max((data.oob / data.total) * data.feet, 0);
        const meta = state.reelMeta[Number(reelDbId)] || {};
        const startDate = determineStartDate(data, meta);
        return {
          label: meta.reelId || reelDbId,
          jobName: meta.jobName || "Job",
          totalFeet: data.feet,
          good,
          bad,
          start: startDate,
          startValue: startDate ? startDate.getTime() : Number.POSITIVE_INFINITY,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.startValue - b.startValue);
    if (!entries.length) {
      if (window.Plotly) Plotly.purge(target);
      target.innerHTML = '<div class="chart-empty">All reels are within bounds.</div>';
      return;
    }
    const tickValues = entries.map((_, idx) => idx);
    const tickLabels = entries.map((entry) => entry.label);
    const goodValues = entries.map((entry) => entry.good);
    const badValues = entries.map((entry) => entry.bad);
    Plotly.react(
      target,
      [
        {
          x: tickValues,
          y: goodValues,
          name: "Good feet",
          type: "bar",
          marker: { color: "#16a34a" },
          customdata: entries.map((entry) => [
            entry.label,
            entry.start ? formatTime(entry.start) : "--",
            entry.jobName,
            entry.totalFeet,
            entry.good,
            entry.bad,
          ]),
          hovertemplate:
            "<b>Reel: %{customdata[0]}</b><br>" +
            "Start: %{customdata[1]}<br>" +
            "Job: %{customdata[2]}<br>" +
            "Total feet: %{customdata[3]:,.0f}<br>" +
            "Good feet: %{customdata[4]:,.0f}<br>" +
            "Bad feet: %{customdata[5]:,.0f}<extra></extra>",
        },
        {
          x: tickValues,
          y: badValues,
          name: "Bad feet",
          type: "bar",
          marker: { color: "#dc2626" },
          customdata: entries.map((entry) => [
            entry.label,
            entry.start ? formatTime(entry.start) : "--",
            entry.jobName,
            entry.totalFeet,
            entry.good,
            entry.bad,
          ]),
          hovertemplate:
            "<b>Reel: %{customdata[0]}</b><br>" +
            "Start: %{customdata[1]}<br>" +
            "Job: %{customdata[2]}<br>" +
            "Total feet: %{customdata[3]:,.0f}<br>" +
            "Good feet: %{customdata[4]:,.0f}<br>" +
            "Bad feet: %{customdata[5]:,.0f}<extra></extra>",
        },
      ],
      {
        barmode: "stack",
        margin: { t: 50, r: 30, b: 80, l: 50 },
        height: 320,
        yaxis: { title: "Feet" },
        xaxis: {
          title: "Reel",
          type: "category",
          tickmode: "array",
          tickvals: tickValues,
          ticktext: tickLabels,
        },
        hovermode: "closest",
        showlegend: true,
      },
      { displayModeBar: false, responsive: true }
    );
  }

  function renderDeltaPointBar(reelAggregates) {
    const target = elements.deltaPointBar || document.getElementById("rlmDeltaPointBar");
    if (!target) return;
    const entries = Object.entries(reelAggregates)
      .map(([reelDbId, data]) => {
        if (!data || data.total <= 0) return null;
        const hasRows = (state.deltaRows || []).some((row) => Number(row.reelDbId) === Number(reelDbId));
        if (!hasRows) return null;
        const meta = state.reelMeta[Number(reelDbId)] || {};
        const startDate = determineStartDate(data, meta);
        return {
          label: meta.reelId || reelDbId,
          jobName: meta.jobName || "Job",
          start: startDate,
          startValue: startDate ? startDate.getTime() : Number.POSITIVE_INFINITY,
          totalFeet: data.feet,
          good: Math.max(data.total - data.oob, 0),
          bad: Math.max(data.oob, 0),
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.startValue - b.startValue);
    if (!entries.length) {
      if (window.Plotly) Plotly.purge(target);
      target.innerHTML = '<div class="chart-empty">No monitoring points detected.</div>';
      return;
    }
    const tickValues = entries.map((_, idx) => idx);
    const tickLabels = entries.map((entry) => entry.label);
    const goodValues = entries.map((entry) => entry.good);
    const badValues = entries.map((entry) => entry.bad);
    Plotly.react(
      target,
      [
        {
          x: tickValues,
          y: goodValues,
          name: "In bounds",
          type: "bar",
          marker: { color: "#16a34a" },
          customdata: entries.map((entry) => [
            entry.label,
            entry.start ? formatTime(entry.start) : "--",
            entry.jobName,
            entry.good,
            entry.bad,
            entry.totalFeet,
          ]),
          hovertemplate:
            "<b>Reel: %{customdata[0]}</b><br>" +
            "Start: %{customdata[1]}<br>" +
            "Job: %{customdata[2]}<br>" +
            "In-bounds points: %{customdata[3]:,.0f}<br>" +
            "Out-of-bounds points: %{customdata[4]:,.0f}<br>" +
            "Total feet: %{customdata[5]:,.0f}<extra></extra>",
        },
        {
          x: tickValues,
          y: badValues,
          name: "Out of bounds",
          type: "bar",
          marker: { color: "#dc2626" },
          customdata: entries.map((entry) => [
            entry.label,
            entry.start ? formatTime(entry.start) : "--",
            entry.jobName,
            entry.good,
            entry.bad,
            entry.totalFeet,
          ]),
          hovertemplate:
            "<b>Reel: %{customdata[0]}</b><br>" +
            "Start: %{customdata[1]}<br>" +
            "Job: %{customdata[2]}<br>" +
            "In-bounds points: %{customdata[3]:,.0f}<br>" +
            "Out-of-bounds points: %{customdata[4]:,.0f}<br>" +
            "Total feet: %{customdata[5]:,.0f}<extra></extra>",
        },
      ],
      {
        barmode: "stack",
        margin: { t: 50, r: 30, b: 80, l: 50 },
        height: 300,
        yaxis: { title: "Monitoring points" },
        xaxis: {
          title: "Reel",
          type: "category",
          tickmode: "array",
          tickvals: tickValues,
          ticktext: tickLabels,
        },
        hovermode: "closest",
        showlegend: true,
      },
      { displayModeBar: false, responsive: true }
    );
  }

  function updateDeltaReelOptions() {
    if (!elements.deltaReelSelect) return;
    const rowsByReel = (state.deltaRows || []).reduce((acc, row) => {
      const reelId = Number(row.reelDbId);
      if (!Number.isFinite(reelId)) return acc;
      acc[reelId] = acc[reelId] || [];
      acc[reelId].push(row);
      return acc;
    }, {});
    const entries = Object.entries(rowsByReel)
      .map(([reelDbId, rows]) => {
        if (!rows || !rows.length) return null;
        const meta = state.reelMeta[Number(reelDbId)] || {};
        const startCandidate = rows.reduce((min, row) => {
          if (!Number.isFinite(row.timestamp)) return min;
          if (min === null || row.timestamp < min) return row.timestamp;
          return min;
        }, null);
        const startDate = determineStartDate(
          startCandidate !== null ? { startTs: startCandidate } : { startTs: null },
          meta
        );
        return {
          reelDbId: Number(reelDbId),
          label: meta.reelId || reelDbId,
          jobName: meta.jobName || rows[0].jobName || "Job",
          start: startDate,
          startValue: startDate
            ? startDate.getTime()
            : Number.isFinite(startCandidate)
            ? startCandidate
            : Number.POSITIVE_INFINITY,
          totalFeet: meta.feet,
          oobPoints: rows.filter((row) => row.outOfRange).length,
          totalPoints: rows.length,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.startValue - b.startValue || a.reelDbId - b.reelDbId);
    state.reelOobOptions = entries;
    state.reelOobLookup = entries.reduce((acc, entry) => {
      acc[entry.reelDbId] = entry;
      return acc;
    }, {});
    if (!entries.length) {
      elements.deltaReelSelect.innerHTML = '<option value="">No reels available</option>';
      elements.deltaReelSelect.disabled = true;
      state.selectedReelId = "";
      if (elements.deltaReelMeta) elements.deltaReelMeta.textContent = "No reels available for this view.";
      if (elements.deltaReelCurl) elements.deltaReelCurl.innerHTML = "<p>No reels to inspect.</p>";
      if (elements.deltaReelDelta) elements.deltaReelDelta.innerHTML = "<p>No reels to inspect.</p>";
      if (elements.deltaReelContext) elements.deltaReelContext.innerHTML = "<p>No reels to inspect.</p>";
      return;
    }
    elements.deltaReelSelect.disabled = false;
    const optionsHtml = ['<option value="">Select a reel to investigate</option>'].concat(
      entries.map((entry) => {
        const startLabel = entry.start ? entry.start.toLocaleString() : "Unknown start";
        const oobLabel = entry.oobPoints ? ` · OOB ${entry.oobPoints}` : "";
        const optionClass = entry.oobPoints ? "option-oob" : "";
        return `<option value="${entry.reelDbId}" class="${optionClass}">${escapeHtml(entry.label)} · ${escapeHtml(entry.jobName)} · ${escapeHtml(
          startLabel
        )}${escapeHtml(oobLabel)}</option>`;
      })
    );
    elements.deltaReelSelect.innerHTML = optionsHtml.join("");
    const nextSelection = entries[0] ? String(entries[0].reelDbId) : "";
    state.selectedReelId = nextSelection;
    elements.deltaReelSelect.value = nextSelection;
  }

  function renderDeltaReelCharts() {
    if (!elements.deltaReelCurl || !elements.deltaReelDelta) return;
    const entries = state.reelOobOptions || [];
    if (!entries.length) {
      if (elements.deltaReelCurl) elements.deltaReelCurl.innerHTML = "<p>No reels to inspect.</p>";
      if (elements.deltaReelDelta) elements.deltaReelDelta.innerHTML = "<p>No reels to inspect.</p>";
      updateInvestigateSummary([], -1);
      return;
    }
    let selectedId = state.selectedReelId;
    if (selectedId && !state.reelOobLookup[Number(selectedId)]) {
      selectedId = "";
    }
    if (!selectedId || !state.reelOobLookup[Number(selectedId)]) {
      selectedId = entries.length ? String(entries[0].reelDbId) : "";
    }
    state.selectedReelId = selectedId;
    if (elements.deltaReelSelect) elements.deltaReelSelect.value = state.selectedReelId || "";
    let entry = state.reelOobLookup[Number(selectedId)];
    if (!entry) {
      if (elements.deltaReelCurl) elements.deltaReelCurl.innerHTML = "<p>No reel data available.</p>";
      if (elements.deltaReelDelta) elements.deltaReelDelta.innerHTML = "<p>No reel data available.</p>";
      if (elements.deltaReelContext) elements.deltaReelContext.innerHTML = "<p>No reel data available.</p>";
      updateInvestigateSummary([], -1);
      return;
    }
    let reelRows = (state.deltaRows || []).filter((row) => Number(row.reelDbId) === entry.reelDbId);
    if (!reelRows.length) {
      const fallbackEntry = entries.find((candidate) => (state.deltaRows || []).some((row) => Number(row.reelDbId) === candidate.reelDbId));
      if (fallbackEntry && fallbackEntry.reelDbId !== entry.reelDbId) {
        state.selectedReelId = String(fallbackEntry.reelDbId);
        if (elements.deltaReelSelect) elements.deltaReelSelect.value = state.selectedReelId;
        renderDeltaReelCharts();
        return;
      }
    }
    if (!reelRows.length) {
      if (elements.deltaReelCurl) elements.deltaReelCurl.innerHTML = "<p>No monitoring points for this reel.</p>";
      if (elements.deltaReelDelta) elements.deltaReelDelta.innerHTML = "<p>No monitoring points for this reel.</p>";
      if (elements.deltaReelContext) elements.deltaReelContext.innerHTML = "<p>No monitoring points for this view.</p>";
      if (elements.deltaReelMeta) elements.deltaReelMeta.textContent = "No monitoring data for the selected reel.";
      updateInvestigateSummary(entries, entries.findIndex((item) => item.reelDbId === entry.reelDbId));
      return;
    }
    const selectedIndex = entries.findIndex((item) => item.reelDbId === entry.reelDbId);
    updateInvestigateSummary(entries, selectedIndex);
    const oobRows = reelRows.filter((row) => row.outOfRange);
    const formatValues = reelRows.map((row) => row.formatValue).filter((val) => Number.isFinite(val));
    const oobFormatValues = oobRows.map((row) => row.formatValue).filter((val) => Number.isFinite(val));
    const feetValues = reelRows.map((row) => row.formatFeet).filter((val) => Number.isFinite(val));
    const oobFeetValues = oobRows.map((row) => row.formatFeet).filter((val) => Number.isFinite(val));
    if (elements.deltaReelMeta) {
      const startLabel = entry.start ? entry.start.toLocaleString() : "Unknown start";
      const feetLabel = Number.isFinite(entry.totalFeet) ? formatFeet(entry.totalFeet) : "--";
      const formatSpanLabel = formatValues.length
        ? `Format span: ${formatNumber(Math.min(...formatValues), 0)} → ${formatNumber(Math.max(...formatValues), 0)}`
        : "Format span: Unknown";
      const oobFormatLabel = oobFormatValues.length
        ? `OOB format: ${formatNumber(Math.min(...oobFormatValues), 0)} → ${formatNumber(Math.max(...oobFormatValues), 0)}`
        : "OOB format: Unknown";
      const feetSpanLabel = feetValues.length
        ? `Feet span: ${formatNumber(Math.min(...feetValues), 0)} ft → ${formatNumber(Math.max(...feetValues), 0)} ft`
        : "Feet span: Unknown";
      elements.deltaReelMeta.textContent = `${entry.label} · ${entry.jobName} · Start ${startLabel} · Feet ${feetLabel} · ${formatSpanLabel} · ${oobFormatLabel} · ${feetSpanLabel}`;
    }
    const hasFeetPositions = reelRows.some((row) => Number.isFinite(row.formatFeet));
    const xPositions = [];
    const indexMap = new Map();
    reelRows.forEach((row, idx) => {
      const pos = Number.isFinite(row.formatFeet) ? row.formatFeet : idx;
      xPositions.push(pos);
      indexMap.set(row, idx);
    });
    const axisTitle = hasFeetPositions ? "Feet along reel" : "Monitoring point index";
    const oobXPositions = oobRows.map((row) => {
      const idx = indexMap.get(row) || 0;
      return xPositions[idx];
    });
    const markerConfig = {
      size: 6,
      color: "#2563eb",
    };
    const formatLabels = reelRows.map((row) => (Number.isFinite(row.formatValue) ? formatNumber(row.formatValue, 0) : "--"));
    const feetLabels = reelRows.map((row) => (Number.isFinite(row.formatFeet) ? formatNumber(row.formatFeet, 0) : "--"));
    const curlTrace = {
      x: xPositions,
      y: reelRows.map((row) => row.actual),
      mode: "lines+markers",
      name: "Curlength",
      line: { color: "#2563eb", width: 1.5 },
      marker: markerConfig,
      hovertemplate:
        "<b>Curlength</b><br>" +
        "Format: %{customdata[0]}<br>" +
        "Feet: %{customdata[1]}<br>" +
        "Curlength: %{y:.3f} mm<extra></extra>",
      customdata: reelRows.map((row, idx) => [formatLabels[idx], feetLabels[idx]]),
    };
    const hasSpeed = reelRows.some((row) => Number.isFinite(row.webspeed));
    let speedTrace = null;
    if (hasSpeed) {
      const speedValues = reelRows.map((row) => (Number.isFinite(row.webspeed) ? row.webspeed : null));
      const finiteSpeeds = speedValues.filter((val) => Number.isFinite(val));
      const minSpeed = finiteSpeeds.length ? Math.min(...finiteSpeeds) : 0;
      const maxSpeed = finiteSpeeds.length ? Math.max(...finiteSpeeds) : 1;
      const speedRange = maxSpeed - minSpeed || 1;
      const scaledSpeed = speedValues.map((val) => (Number.isFinite(val) ? (val - minSpeed) / speedRange : null));
      speedTrace = {
        x: xPositions,
        y: scaledSpeed,
        mode: "lines",
        name: "Webspeed (scaled)",
        line: { color: "#16a34a", width: 1.5, dash: "dot" },
        hoverinfo: "skip",
        customdata: speedValues,
        yaxis: "y2",
        showlegend: false,
      };
    }
    const curlLayout = {
      margin: { t: 40, r: 60, b: 50, l: 60 },
      height: 360,
      yaxis: { title: "Curlength (mm)" },
      yaxis2: hasSpeed
        ? {
            title: "Webspeed (scaled)",
            overlaying: "y",
            side: "right",
            showgrid: false,
            zeroline: false,
            range: [0, 1],
          }
        : undefined,
      xaxis: { title: axisTitle },
      paper_bgcolor: "#ffffff",
      plot_bgcolor: "#ffffff",
      showlegend: !!speedTrace,
    };
    const curlTraces = speedTrace ? [curlTrace, speedTrace] : [curlTrace];
    redrawInvestigatePlot(elements.deltaReelCurl, curlTraces, curlLayout);

    const lower = reelRows[0].lower;
    const upper = reelRows[0].upper;
    const shapes = [];
    if (Number.isFinite(lower)) {
      shapes.push({
        type: "line",
        x0: Math.min(...xPositions),
        x1: Math.max(...xPositions),
        y0: lower,
        y1: lower,
        line: { color: "#f97316", dash: "dot" },
      });
    }
    if (Number.isFinite(upper)) {
      shapes.push({
        type: "line",
        x0: Math.min(...xPositions),
        x1: Math.max(...xPositions),
        y0: upper,
        y1: upper,
        line: { color: "#f97316", dash: "dot" },
      });
    }
    shapes.push({
      type: "line",
      x0: Math.min(...xPositions),
      x1: Math.max(...xPositions),
      y0: 0,
      y1: 0,
      line: { color: "#94a3b8", dash: "solid" },
    });
    const deltaTrace = {
      x: xPositions,
      y: reelRows.map((row) => row.delta),
      mode: "lines+markers",
      name: "Delta",
      line: { color: "#2563eb", width: 1.5 },
      marker: {
        size: 6,
        color: reelRows.map((row) => (row.outOfRange ? "#dc2626" : "#2563eb")),
      },
      hovertemplate:
        "<b>Delta</b><br>" +
        "Format: %{customdata[0]}<br>" +
        "Feet: %{customdata[1]}<br>" +
        "Delta: %{y:.3f} mm<extra></extra>",
      customdata: reelRows.map((row, idx) => [formatLabels[idx], feetLabels[idx]]),
    };
    const oobTrace =
      oobRows.length > 0
        ? {
            x: oobXPositions,
            y: oobRows.map((row) => row.delta),
            mode: "markers",
            name: "Out of bounds",
            marker: { color: "#dc2626", size: 8, symbol: "circle-open" },
          hovertemplate:
            "<b>OOB</b><br>" +
            (hasFeetPositions ? "Feet: " : "Index: ") +
            "%{x:.0f}<br>" +
            "Delta: %{y:.3f} mm<extra></extra>",
          }
        : null;
    const deltaLayout = {
      margin: { t: 40, r: 30, b: 50, l: 60 },
      height: 360,
      yaxis: { title: "Delta (mm)" },
      xaxis: { title: axisTitle },
      shapes,
      showlegend: !!oobTrace,
      paper_bgcolor: "#ffffff",
      plot_bgcolor: "#ffffff",
    };
    const deltaTraces = oobTrace ? [deltaTrace, oobTrace] : [deltaTrace];
    redrawInvestigatePlot(elements.deltaReelDelta, deltaTraces, deltaLayout);

    renderDeltaReelContext(selectedId);
  }

  function updateInvestigateSummary(entries, selectedIndex) {
    const positions = {
      Prev: selectedIndex > 0 ? entries[selectedIndex - 1] : null,
      Current: selectedIndex >= 0 ? entries[selectedIndex] : null,
      Next: selectedIndex < entries.length - 1 ? entries[selectedIndex + 1] : null,
    };
    Object.entries(positions).forEach(([label, entry]) => {
      const stats = computeInvestigateStats(entry);
      const feetEl = elements[`summaryFeet${label}`];
      const pointsEl = elements[`summaryPoints${label}`];
      const oobEl = elements[`summaryOob${label}`];
      const deltaEl = elements[`summaryDelta${label}`];
      if (feetEl) feetEl.textContent = stats.feet;
      if (pointsEl) pointsEl.textContent = stats.points;
      if (oobEl) oobEl.textContent = stats.oob;
      if (deltaEl) deltaEl.textContent = stats.deltaAvg;
    });
  }

  function computeInvestigateStats(entry) {
    if (!entry) {
      return { feet: "--", points: "--", oob: "--", deltaAvg: "--" };
    }
    const rows = (state.deltaRows || []).filter((row) => Number(row.reelDbId) === entry.reelDbId);
    const feetLabel = Number.isFinite(entry.totalFeet) ? `${formatNumber(entry.totalFeet, 0)} ft` : "--";
    const pointCount = rows.length;
    const oobCount = rows.filter((row) => row.outOfRange).length;
    const avgDelta =
      pointCount > 0 ? formatMm(rows.reduce((sum, row) => sum + row.delta, 0) / pointCount, 3) : "--";
    return {
      feet: feetLabel,
      points: formatNumber(pointCount, 0),
      oob: formatNumber(oobCount, 0),
      deltaAvg: avgDelta,
    };
  }

  function renderDeltaReelContext(selectedReelId) {
    if (!elements.deltaReelContext) return;
    const contextRange = state.contextRange || { min: null, max: null };
    if (elements.contextRangeMin) {
      elements.contextRangeMin.value =
        contextRange.min !== null && Number.isFinite(contextRange.min) ? contextRange.min : "";
    }
    if (elements.contextRangeMax) {
      elements.contextRangeMax.value =
        contextRange.max !== null && Number.isFinite(contextRange.max) ? contextRange.max : "";
    }
    const available = state.reelOobOptions || [];
    if (!available.length) {
      elements.deltaReelContext.innerHTML = "<p>No reel context available.</p>";
      return;
    }
    const idx = available.findIndex((entry) => entry.reelDbId === Number(selectedReelId));
    if (idx === -1) {
      elements.deltaReelContext.innerHTML = "<p>No reel context available.</p>";
      return;
    }
    const contextEntries = [];
    if (idx > 0) contextEntries.push({ ...available[idx - 1], id: available[idx - 1].reelDbId, role: "Previous" });
    contextEntries.push({ ...available[idx], id: available[idx].reelDbId, role: "Selected" });
    if (idx < available.length - 1) contextEntries.push({ ...available[idx + 1], id: available[idx + 1].reelDbId, role: "Next" });
    const colors = { Previous: "#0ea5e9", Selected: "#2563eb", Next: "#f97316" };
    const traces = [];
    let hasFormatPositions = false;
    let hasFeetPositions = false;
    contextEntries.forEach((entry) => {
      const rows = (state.deltaRows || []).filter((row) => Number(row.reelDbId) === entry.id);
      if (!rows.length) {
        return;
      }
      const entryHasFormat = rows.some((row) => Number.isFinite(row.formatValue));
      const entryHasFeet = rows.some((row) => Number.isFinite(row.formatFeet));
      if (entryHasFormat) hasFormatPositions = true;
      if (entryHasFeet) hasFeetPositions = true;
      traces.push({
        entry,
        rows,
        hasFormat: entryHasFormat,
        hasFeet: entryHasFeet,
      });
    });
    if (!traces.length) {
      elements.deltaReelContext.innerHTML = "<p>No monitoring data for adjacent reels.</p>";
      return;
    }
    const axisTitle = hasFormatPositions ? "Format value" : hasFeetPositions ? "Feet along reel" : "Point index";
    const allDeltaValues = traces.flatMap(({ rows }) => rows.map((row) => (Number.isFinite(row.delta) ? row.delta : 0)));
    const deltaMin = allDeltaValues.length ? Math.min(...allDeltaValues) : 0;
    const deltaMax = allDeltaValues.length ? Math.max(...allDeltaValues) : 0;
    const deltaRange = deltaMax - deltaMin || 1;
    const allSpeedValues = traces
      .flatMap(({ rows }) => rows.map((row) => (Number.isFinite(row.webspeed) ? row.webspeed : null)))
      .filter((val) => Number.isFinite(val));
    const speedMin = allSpeedValues.length ? Math.min(...allSpeedValues) : 0;
    const speedMax = allSpeedValues.length ? Math.max(...allSpeedValues) : 1;
    const speedRange = speedMax - speedMin || 1;
    const combinedSpeedTrace = {
      x: [],
      y: [],
      mode: "lines",
      name: "Webspeed (scaled)",
      line: { color: "#16a34a", width: 1.5, dash: "dot" },
      hoverinfo: "skip",
      customdata: [],
      yaxis: "y2",
      showlegend: false,
    };
    let selectedRange = null;

    const plotTraceSets = traces.map(({ entry, rows }) => {
      const xValues = rows.map((row, index) => {
        if (hasFormatPositions && Number.isFinite(row.formatValue)) return row.formatValue;
        if (!hasFormatPositions && hasFeetPositions && Number.isFinite(row.formatFeet)) return row.formatFeet;
        return index;
      });
      if (entry.role === "Selected" && xValues.length) {
        const minX = Math.min(...xValues);
        const maxX = Math.max(...xValues);
        if (Number.isFinite(minX) && Number.isFinite(maxX)) {
          selectedRange = { min: minX, max: maxX };
        }
      }
      const jobName = state.reelMeta[entry.id]?.jobName || rows[0].jobName || "Job";
      const formatVals = rows.map((row, idx) =>
        Number.isFinite(row.formatValue)
          ? formatNumber(row.formatValue, 0)
          : hasFormatPositions
          ? formatNumber(xValues[idx], 0)
          : "--"
      );
      const feetVals = rows.map((row, idx) =>
        Number.isFinite(row.formatFeet)
          ? formatNumber(row.formatFeet, 0)
          : hasFeetPositions
          ? formatNumber(xValues[idx], 0)
          : "--"
      );
      const speedValues = rows.map((row) => (Number.isFinite(row.webspeed) ? row.webspeed : null));
      const deltaTrace = {
        x: xValues,
        y: rows.map((row) => row.delta),
        mode: "lines+markers",
        name: `${entry.label} (${entry.role})`,
        line: { color: colors[entry.role] || "#2563eb", width: entry.role === "Selected" ? 2 : 1 },
        marker: {
          size: 6,
          color: rows.map((row) => (row.outOfRange ? "#dc2626" : colors[entry.role] || "#2563eb")),
        },
        hovertemplate:
          "<b>%{customdata[0]}</b><br>" +
          "Job: %{customdata[1]}<br>" +
          "Format: %{customdata[2]}<br>" +
          "Feet: %{customdata[3]}<br>" +
          "Delta: %{y:.3f} mm<extra></extra>",
        customdata: rows.map((row, idx) => [entry.label, jobName, formatVals[idx], feetVals[idx]]),
      };
      speedValues.forEach((speedVal, idx) => {
        if (!Number.isFinite(speedVal)) return;
        combinedSpeedTrace.x.push(xValues[idx]);
        combinedSpeedTrace.y.push((speedVal - speedMin) / speedRange);
        combinedSpeedTrace.customdata.push([entry.label, jobName, feetVals[idx], speedVal]);
      });
      combinedSpeedTrace.x.push(null);
      combinedSpeedTrace.y.push(null);
      combinedSpeedTrace.customdata.push([entry.label, jobName, null, null]);
      return [deltaTrace];
    });
    const flattened = plotTraceSets.flat();
    if (allSpeedValues.length) {
      flattened.push(combinedSpeedTrace);
    }
    const shapes =
      selectedRange && Number.isFinite(selectedRange.min) && Number.isFinite(selectedRange.max)
        ? [
            {
              type: "rect",
              xref: "x",
              yref: "paper",
              x0: selectedRange.min,
              x1: selectedRange.max,
              y0: 0,
              y1: 1,
              fillcolor: "rgba(248,113,113,0.12)",
              line: { width: 0 },
            },
          ]
        : undefined;
    const yAxisConfig = { title: "Delta (mm)" };
    if ((state.contextRange && Number.isFinite(state.contextRange.min)) || Number.isFinite(state.contextRange?.max)) {
      const rangeMin =
        Number.isFinite(state.contextRange?.min) && state.contextRange.min !== null
          ? state.contextRange.min
          : deltaMin - deltaRange * 0.05;
      const rangeMax =
        Number.isFinite(state.contextRange?.max) && state.contextRange.max !== null
          ? state.contextRange.max
          : deltaMax + deltaRange * 0.05;
      yAxisConfig.range = [rangeMin, rangeMax];
    }
    redrawInvestigatePlot(elements.deltaReelContext, flattened, {
      margin: { t: 40, r: 30, b: 50, l: 60 },
      height: 360,
      yaxis: yAxisConfig,
      xaxis: { title: axisTitle },
      showlegend: true,
      paper_bgcolor: "#ffffff",
      plot_bgcolor: "#ffffff",
      yaxis2: allSpeedValues.length
        ? { title: "Webspeed (scaled)", overlaying: "y", side: "right", showgrid: false, zeroline: false, range: [0, 1] }
        : undefined,
      shapes,
    });

  }

  function redrawInvestigatePlot(container, traces, layout) {
    if (!container || !window.Plotly) return;
    window.Plotly.purge(container);
    container.innerHTML = "";
    requestAnimationFrame(() => {
      window.Plotly.newPlot(container, traces, layout, { displayModeBar: true, responsive: true });
    });
  }

  function buildTrace(points, label, color) {
    const sorted = [...points].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    return {
      x: sorted.map((p) => p.timestamp),
      y: sorted.map((p) => p.curlength ?? null),
      mode: "lines",
      name: label,
      line: { color, width: 2 },
    };
  }

  function groupByMachine(points) {
    return points.reduce((acc, point) => {
      const key = point.machineName || `Machine ${point.machineId || "?"}`;
      acc[key] = acc[key] || [];
      acc[key].push(point);
      return acc;
    }, {});
  }

  function limitShape(value, color) {
    return {
      type: "line",
      xref: "paper",
      x0: 0,
      x1: 1,
      y0: value,
      y1: value,
      line: { color, width: 1.5, dash: "dot" },
    };
  }

  function getLowerLimit() {
    if (!Number.isFinite(state.targetValue)) return null;
    const minus = Number.isFinite(state.minusTolerance) ? state.minusTolerance : 0;
    return state.targetValue - minus;
  }

  function getUpperLimit() {
    if (!Number.isFinite(state.targetValue)) return null;
    const plus = Number.isFinite(state.plusTolerance) ? state.plusTolerance : 0;
    return state.targetValue + plus;
  }

  function formatHistoryList(values) {
    if (!values || !values.length) return "--";
    return values.join(" → ");
  }

  function computeFeetFromReel(reel) {
    if (!reel) return null;
    const start = toNumber(reel.reelStart ?? reel.reel_start);
    const end = toNumber(reel.reelEnd ?? reel.reel_end);
    return computeFeetFromValues(start, end);
  }

  function computeFeetFromValues(start, end) {
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    return Math.abs(end - start) * FEET_PER_FORMAT_UNIT;
  }

  function formatNumber(value, digits = 0) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
    return Number(value).toLocaleString(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function formatMm(value, digits = 3) {
    const formatted = formatNumber(value, digits);
    return formatted === "--" ? "--" : `${formatted} mm`;
  }

  function formatTime(value) {
    if (!value) return "--";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "--";
    return date.toLocaleString();
  }

  function formatTolerance(shrink, expand) {
    const shrinkVal = formatMm(shrink, 3);
    const expandVal = formatMm(expand, 3);
    if (shrinkVal === "--" && expandVal === "--") return "--";
    return `${shrinkVal} / ${expandVal}`;
  }

  function deltaBadge(value, nominal) {
    if (!Number.isFinite(value) || !Number.isFinite(nominal)) return "";
    const diff = value - nominal;
    const absValue = formatNumber(Math.abs(diff), 3);
    if (Math.abs(diff) < 0.0005) {
      return '<span class="summary-delta summary-delta--neutral">On nominal</span>';
    }
    const prefix = diff > 0 ? "+" : "-";
    const tone = diff > 0 ? "pos" : "neg";
    return `<span class="summary-delta summary-delta--${tone}">${prefix}${absValue} mm vs nominal</span>`;
  }

  function webspeedRangeDetail(minVal, maxVal) {
    if (!Number.isFinite(minVal) || !Number.isFinite(maxVal)) return "";
    return `<span class="summary-card__detail-note">Min ${formatNumber(minVal, 3)} · Max ${formatNumber(maxVal, 3)}</span>`;
  }

  function addHistory(historyList, value) {
    if (!value || value === "--") return historyList;
    if (!historyList.length || historyList[historyList.length - 1] !== value) {
      historyList.push(value);
    }
    return historyList;
  }

  function historyLine(label, values) {
    if (!values || !values.length) return `${label}: --`;
    return `${label}: ${values.join(" → ")}`;
  }

  function toNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }

  function formatRawTolerance(value) {
    if (!Number.isFinite(value)) return "--";
    return formatNumber(value, 4);
  }

  function formatFeet(feet) {
    if (!Number.isFinite(feet)) return "--";
    return `${formatNumber(feet, 2)} ft`;
  }

  function computeToleranceStats(points, metaByReel = {}) {
    const perReel = {};
    const reelFinalNominals = [];
    let repeatLengthInReelCount = 0;
    const changeMix = { none: 0, once: 0, multi: 0 };
    const changeDetails = { once: [], multi: [] };
    const errorChangeRows = [];
    const jobChangeTotals = {};
    const reelsWithTolerances = new Set();
    const histories = {};

    (points || []).forEach((pt) => {
      if (!perReel[pt.reelDbId]) perReel[pt.reelDbId] = [];
      perReel[pt.reelDbId].push(pt);
    });

    const nominalValues = [];
    const shrinkValues = [];
    const expandValues = [];
    let nominalChangeTotal = 0;
    let nominalChangeReels = 0;
    let errorChangeTotal = 0;
    let errorChangeReels = 0;

    Object.values(perReel).forEach((arr) => {
      arr.sort((a, b) => {
        const metaA = metaByReel[a.reelDbId] || {};
        const metaB = metaByReel[b.reelDbId] || {};
        const timeA = metaA.start ? new Date(metaA.start).getTime() : a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const timeB = metaB.start ? new Date(metaB.start).getTime() : b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return timeA - timeB;
      });
      const reelId = arr[0] ? arr[0].reelDbId : null;
      if (reelId === null) return;
      const meta = metaByReel[reelId] || {};
      const jobFallback = arr[0] && arr[0].jobName ? arr[0].jobName : null;
      const history = histories[reelId] || { nominal: [], shrink: [], expand: [], changes: [] };
      histories[reelId] = history;

      let lastNominal = null;
      let lastShrink = null;
      let lastExpand = null;
      let reelNominalChanged = false;
      let reelErrorChanged = false;
      let finalNominal = null;
      let lastTimestamp = null;

      arr.forEach((pt) => {
        const nominalVal = toNumber(pt.nominalLength);
        const shrinkVal = toNumber(pt.errShrink);
        const expandVal = toNumber(pt.errExpand);
        if (nominalVal !== null) {
          nominalValues.push(nominalVal);
          addHistory(history.nominal, formatMm(nominalVal, 3));
          if (lastNominal !== null && nominalVal !== lastNominal) {
            history.changes.push({ from: lastNominal, to: nominalVal });
          }
        }
        if (shrinkVal !== null) {
          shrinkValues.push(shrinkVal);
          addHistory(history.shrink, formatRawTolerance(shrinkVal));
          if (lastShrink !== null && shrinkVal !== lastShrink) {
            history.shrinkChanges = history.shrinkChanges || [];
            history.shrinkChanges.push({ from: lastShrink, to: shrinkVal });
          }
        }
        if (expandVal !== null) {
          expandValues.push(expandVal);
          addHistory(history.expand, formatRawTolerance(expandVal));
          if (lastExpand !== null && expandVal !== lastExpand) {
            history.expandChanges = history.expandChanges || [];
            history.expandChanges.push({ from: lastExpand, to: expandVal });
          }
        }
        if (nominalVal !== null && lastNominal !== null && nominalVal !== lastNominal) {
          nominalChangeTotal += 1;
          reelNominalChanged = true;
        }
        if (
          (shrinkVal !== null && lastShrink !== null && shrinkVal !== lastShrink) ||
          (expandVal !== null && lastExpand !== null && expandVal !== lastExpand)
        ) {
          errorChangeTotal += 1;
          reelErrorChanged = true;
        }
        if (nominalVal !== null) lastNominal = nominalVal;
        if (shrinkVal !== null) lastShrink = shrinkVal;
        if (expandVal !== null) lastExpand = expandVal;
        if (nominalVal !== null) finalNominal = nominalVal;
        if (pt.timestamp) {
          const ts = new Date(pt.timestamp).getTime();
          if (Number.isFinite(ts)) lastTimestamp = ts;
        }
      });

      if (reelNominalChanged) nominalChangeReels += 1;
      if (reelErrorChanged) errorChangeReels += 1;
      const maxSequence = arr.reduce((max, pt) => {
        const seq = Number(pt.sequence);
        return Number.isFinite(seq) ? Math.max(max, seq) : max;
      }, 1);
      const changeCount = Math.max(0, maxSequence - 1);
      const hasMultiChanges = maxSequence >= 3;
      if (hasMultiChanges) repeatLengthInReelCount += 1;

      const bucket = maxSequence <= 1 ? "none" : maxSequence === 2 ? "once" : "multi";
      changeMix[bucket] += 1;
      if (maxSequence === 2) {
        changeDetails.once.push({
          reelDbId: reelId,
          reelId: meta.reelId || reelId,
          jobName: meta.jobName || jobFallback || "Unknown Job",
          start: meta.start || null,
          end: meta.end || null,
          changes: history.changes || [],
        });
      } else if (hasMultiChanges) {
        changeDetails.multi.push({
          reelDbId: reelId,
          reelId: meta.reelId || reelId,
          jobName: meta.jobName || jobFallback || "Unknown Job",
          start: meta.start || null,
          end: meta.end || null,
          changes: history.changes || [],
        });
      }
      const shrinkChanged = history.shrinkChanges && history.shrinkChanges.length;
      const expandChanged = history.expandChanges && history.expandChanges.length;
      if (shrinkChanged || expandChanged) {
        errorChangeRows.push({
          jobName: meta.jobName || jobFallback || "Unknown Job",
          reelId: meta.reelId || reelId,
          start: meta.start || null,
          end: meta.end || null,
          errShrinkChanges: (history.shrinkChanges || []).map((change) => `${formatRawTolerance(change.from)} → ${formatRawTolerance(change.to)}`),
          errExpandChanges: (history.expandChanges || []).map((change) => `${formatRawTolerance(change.from)} → ${formatRawTolerance(change.to)}`),
          timestamp: meta.start ? new Date(meta.start).getTime() : 0,
        });
      }
      if (changeCount > 0) {
        const jobName = meta.jobName || jobFallback || "Unknown Job";
        jobChangeTotals[jobName] = (jobChangeTotals[jobName] || 0) + changeCount;
      }
      if (finalNominal !== null) {
        reelsWithTolerances.add(reelId);
        const orderTime = meta.start ? new Date(meta.start).getTime() : lastTimestamp || 0;
        reelFinalNominals.push({
          reelDbId: reelId,
          nominal: finalNominal,
          orderTime: Number.isFinite(orderTime) ? orderTime : 0,
        });
      }
    });

    reelFinalNominals.sort((a, b) => a.orderTime - b.orderTime);
    const distributionMap = {};
    let crossReelChanges = 0;
    let prevNominal = null;
    reelFinalNominals.forEach((entry) => {
      if (!Number.isFinite(entry.nominal)) return;
      const rounded = Number(entry.nominal.toFixed(3));
      const key = rounded.toFixed(3);
      distributionMap[key] = (distributionMap[key] || 0) + 1;
      if (prevNominal !== null && Math.abs(rounded - prevNominal) > 1e-6) {
        crossReelChanges += 1;
      }
      prevNominal = rounded;
    });
    const distribution = Object.entries(distributionMap)
      .map(([value, count]) => ({ nominal: Number(value), count }))
      .sort((a, b) => b.count - a.count);
    const repeatLengthByJob = Object.entries(jobChangeTotals)
      .map(([jobName, count]) => ({ jobName, count }))
      .sort((a, b) => b.count - a.count);
    const totalReels = Object.keys(perReel).length;
    const missingReels = new Set(Object.keys(metaByReel).map((id) => Number(id)));
    reelsWithTolerances.forEach((id) => missingReels.delete(id));

    return {
      nominal: {
        ...statsFromValues(nominalValues),
        totalChanges: nominalChangeTotal,
        reelChanges: nominalChangeReels,
      },
      shrink: statsFromValues(shrinkValues),
      expand: statsFromValues(expandValues),
      error: {
        totalChanges: errorChangeTotal,
        reelChanges: errorChangeReels,
      },
      repeatLengthOverall: {
        totalChanges: crossReelChanges,
        reelCount: reelFinalNominals.length,
        distribution,
      },
      repeatLengthInReel: {
        reelCount: repeatLengthInReelCount,
      },
    repeatLengthMix: changeMix,
    repeatLengthByJob,
    changeDetails,
    totalReels,
      missingReels: Array.from(missingReels).map((id) => {
        const meta = metaByReel[id] || {};
        return {
          reelDbId: id,
          reelId: meta.reelId || id,
          jobName: meta.jobName || "Unknown Job",
        };
      }),
      histories,
      errorChanges: errorChangeRows
        .sort((a, b) => a.timestamp - b.timestamp)
        .map((row) => ({
          jobName: row.jobName,
          reelId: row.reelId,
          start: row.start,
          end: row.end,
          errShrinkChanges: row.errShrinkChanges || [],
          errExpandChanges: row.errExpandChanges || [],
        })),
    };
  }

  function statsFromValues(values) {
    if (!values.length) {
      return { avg: null, min: null, max: null };
    }
    const sum = values.reduce((acc, val) => acc + val, 0);
    return {
      avg: sum / values.length,
      min: Math.min(...values),
      max: Math.max(...values),
    };
  }

  function hexToRgba(hex, alpha = 0.1) {
    const normalized = hex.replace("#", "");
    const bigint = parseInt(normalized.length === 3 ? normalized.split("").map((c) => c + c).join("") : normalized, 16);
    const r = (bigint >> 16) & 255;
    const g = (bigint >> 8) & 255;
    const b = bigint & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function buildReelMeta(reels) {
    const map = {};
    (reels || []).forEach((reel) => {
      if (!reel.reelDbId) return;
      const startLen = toNumber(reel.reelStart);
      const endLen = toNumber(reel.reelEnd);
      map[reel.reelDbId] = {
        jobName: reel.jobName || "",
        reelId: reel.reelId || reel.reelCode || reel.reelDbId,
        start: reel.productionStart ? new Date(reel.productionStart) : null,
        end: reel.productionEnd ? new Date(reel.productionEnd) : null,
        feet: computeFeetFromValues(startLen, endLen),
        formatStart: startLen,
        formatEnd: endLen,
      };
    });
    return map;
  }

  function colorForJob(jobName) {
    const key = (jobName || "job_unknown").toLowerCase();
    if (jobColorMap.has(key)) {
      return jobColorMap.get(key);
    }
    const color = JOB_COLORS[jobColorMap.size % JOB_COLORS.length];
    jobColorMap.set(key, color);
    return color;
  }

  function updateCurlengthStats(points) {
    if (!elements.curlengthStats) return;
    if (!points || !points.length) {
      elements.curlengthStats.textContent = "--";
      return;
    }
    const lowerLimit = getLowerLimit();
    const upperLimit = getUpperLimit();
    if (lowerLimit === null && upperLimit === null) {
      elements.curlengthStats.textContent = "Set target & tolerances";
      return;
    }
    const sorted = [...points].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    let outsideCount = 0;
    let outsideDurationMs = 0;
    sorted.forEach((point, idx) => {
      const value = Number(point.curlength);
      if (!Number.isFinite(value)) return;
      const below = lowerLimit !== null && value < lowerLimit;
      const above = upperLimit !== null && value > upperLimit;
      if (below || above) {
        outsideCount += 1;
        if (idx < sorted.length - 1) {
          const currentTs = new Date(point.timestamp).getTime();
          const nextTs = new Date(sorted[idx + 1].timestamp).getTime();
          if (Number.isFinite(currentTs) && Number.isFinite(nextTs) && nextTs > currentTs) {
            outsideDurationMs += nextTs - currentTs;
          }
        }
      }
    });
    const durationLabel = formatDuration(outsideDurationMs);
    const rangeLabel =
      lowerLimit !== null && upperLimit !== null
        ? `${formatMm(lowerLimit, 3)} → ${formatMm(upperLimit, 3)}`
        : lowerLimit !== null
        ? `≥ ${formatMm(lowerLimit, 3)}`
        : `≤ ${formatMm(upperLimit, 3)}`;
    elements.curlengthStats.textContent = `${outsideCount} pts · ${durationLabel} outside ${rangeLabel}`;
  }

  function formatDuration(ms) {
    if (!ms || ms <= 0) return "0s";
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remSeconds = seconds % 60;
    if (minutes < 60) return `${minutes}m ${remSeconds}s`;
    const hours = Math.floor(minutes / 60);
    const remMinutes = minutes % 60;
    return `${hours}h ${remMinutes}m`;
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
    if (value === null || value === undefined) return "";
    return escapeHtml(String(value)).replace(/\n/g, "&#10;");
  }

  function buildNominalDistributionTooltip(distribution) {
    if (!distribution || !distribution.length) return "";
    return distribution
      .map((entry) => `${formatMm(entry.nominal, 3)} · ${formatNumber(entry.count)} reels`)
      .join("\n");
  }

  function determineStartDate(aggregate, meta) {
    const metaStart = meta && meta.start ? meta.start : null;
    if (metaStart instanceof Date) return metaStart;
    if (metaStart) {
      const parsed = new Date(metaStart);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    if (aggregate && Number.isFinite(aggregate.startTs)) {
      const tsDate = new Date(aggregate.startTs);
      if (!Number.isNaN(tsDate.getTime())) return tsDate;
    }
    return null;
  }

  document.addEventListener("DOMContentLoaded", init);
})();
