  const OverviewTab = (() => {
    let initialized = false;
    let kpiMap = {};
    let inflightOverview = null;
    let inflightOverviewKey = "";
    let lastRenderedOverviewKey = "";
    let hasRenderedOverview = false;

    const pendingReelHydration = new Set();
    const MIN_LENGTH_STORAGE_KEY = "overview.minReelLength";
    const DEFAULT_MIN_REEL_LENGTH_FEET = 4000;
    let minReelLengthFilter = loadStoredMinLength();
    let jobLengthsToggleBound = false;
    let latestJobLengthsData = [];
    const DEFECT_CLASS_ROWS = [
      { key: "__total__", label: "Total Defects" },
      { key: "flaw", label: "Flaws", aliases: ["flas"] },
      { key: "sporadicflaw", label: "Sporadic Flaws", aliases: ["sporadicflas"] },
      { key: "streak", label: "Streak" },
      { key: "sporadicstreak", label: "Sporadic Streak" },
      { key: "colour", label: "Colour", aliases: ["color", "colur"] },
      { key: "register", label: "Register" },
    ];
    const SENSITIVITY_COLUMNS = [
      { key: "flaw", label: "Flaw (reels)" },
      { key: "sporadicflaw", label: "Sporadic Flaw (reels)" },
      { key: "streak", label: "Streak (reels)" },
      { key: "sporadicstreak", label: "Sporadic Streak (reels)" },
      { key: "colour", label: "Colour (reels)" },
      { key: "register", label: "Register (reels)" },
    ];

    function readThemeVar(name, fallback = "") {
      if (typeof window === "undefined" || !window.getComputedStyle) return fallback;
      const target = document.body || document.documentElement;
      if (!target) return fallback;
      const value = getComputedStyle(target).getPropertyValue(name).trim();
      return value || fallback;
    }

    function getChartLabelColor() {
      return readThemeVar("--text-strong", readThemeVar("--text-primary", "#f1f5f9"));
    }

    function updateDefectPieTextColor() {
      if (typeof window === "undefined" || !window.Plotly) return;
      const pieEl = document.getElementById("overviewDefectsByType");
      if (!pieEl || !pieEl.data) return;
      const color = getChartLabelColor();
      window.Plotly.restyle(pieEl, { "textfont.color": color });
    }

    if (typeof window !== "undefined" && !window.__overviewPieThemeListener) {
      window.addEventListener("bst:themechange", updateDefectPieTextColor);
      window.__overviewPieThemeListener = true;
    }

    function normalizeDefectClassName(value) {
      return (value || "").toString().trim().toLowerCase().replace(/\s+/g, "");
    }

    function getClassCountFromMap(classCounts, row) {
      if (!row) return 0;
      const keys = [normalizeDefectClassName(row.key)];
      if (Array.isArray(row.aliases)) {
        row.aliases.forEach((alias) => {
          const normalized = normalizeDefectClassName(alias);
          if (normalized && !keys.includes(normalized)) {
            keys.push(normalized);
          }
        });
      }
      for (const key of keys) {
        if (classCounts.has(key)) {
          return classCounts.get(key) || 0;
        }
      }
      return 0;
    }

    function ensureDefectColor(map, category) {
      if (!map || !category) return null;
      if (map.has(category)) return map.get(category);
      const color = DEFECT_COLOR_PALETTE[map.size % DEFECT_COLOR_PALETTE.length];
      map.set(category, color);
      return color;
    }

    function toggleJobFilter(value) {
      if (!Filters || typeof Filters.set !== "function") return;
      const targetValue = value || "";
      const currentState = Filters && typeof Filters.getState === "function" ? Filters.getState() : null;
      const currentValue = currentState && currentState.job ? currentState.job : "";
      const nextValue = currentValue === targetValue ? "" : targetValue;
      Filters.set("job", nextValue, { emit: true, updateUrl: true });
    }

    function buildDefectColorMap(defectsByType = []) {
      const colorMap = new Map();
      (defectsByType || []).forEach((entry) => {
        const key = entry && (entry.class || entry.name);
        if (!key) return;
        ensureDefectColor(colorMap, key);
      });
      return colorMap;
    }

    function addReelFromPayload(reelCode, reelId, payload = {}) {
      const nestedReel = payload && typeof payload.reel === "object" ? payload.reel : null;
      console.log("[MachineOverview] addReelFromPayload raw payload", { reelCode, reelId, payload });
      const normalizedCode =
        reelCode ||
        payload.reel_code ||
        (typeof payload.reel === "string" ? payload.reel : "") ||
        payload.code ||
        (nestedReel
          ? nestedReel.reel_code || nestedReel.code || nestedReel.value || nestedReel.label || ""
          : "");
      const normalizedReelId = reelId || payload.reel_id || payload.id || (nestedReel ? nestedReel.reel_id || nestedReel.id || "" : "");
      if (!normalizedCode && !normalizedReelId) return;
      const metaInput = {
        reel_code: normalizedCode,
        order_number:
          payload.order_number ||
          payload.order ||
          (nestedReel ? nestedReel.order_number || nestedReel.order || "" : ""),
        time:
          payload.time ||
          payload.timestamp ||
          payload.time_start ||
          payload.time_end ||
        (nestedReel
          ? nestedReel.time || nestedReel.timestamp || nestedReel.time_start || nestedReel.time_end || ""
          : ""),
      };
      console.log("[MachineOverview] addReelFromPayload metaInput", metaInput);
      const builder = typeof window.buildReelMetadata === "function" ? window.buildReelMetadata : null;
      const derived = builder ? builder(metaInput) : metaInput;
      const metadata = {
        code: derived.code || normalizedCode || "",
        label:
          derived.label ||
          formatReelLabel({
            code: normalizedCode || "",
            order: metaInput.order_number || "",
            time: metaInput.time || "",
          }),
        order: derived.order || metaInput.order_number || "",
        time: derived.time || metaInput.time || "",
      };
      console.log("[MachineOverview] addReelFromPayload metadata", metadata);
      Filters.addReel(normalizedCode, normalizedReelId, metadata);
      if (normalizedReelId) {
        Filters.registerReelMetadata({
          reel_id: normalizedReelId,
          reel_code: metadata.code,
          order_number: metadata.order,
          time: metadata.time,
          label: metadata.label,
        });
        console.log("[MachineOverview] registered metadata for reel", normalizedReelId, metadata);
        if (!metadata.code || !metadata.order || !metadata.time) {
          console.log("[MachineOverview] scheduling metadata hydration", normalizedReelId);
          ensureReelMetadata(normalizedReelId);
        }
      }
    }

    async function ensureReelMetadata(reelId) {
      const id = reelId !== undefined && reelId !== null ? String(reelId).trim() : "";
      if (!id || pendingReelHydration.has(id)) return;
      if (!Filters || typeof Filters.registerReelMetadata !== "function") return;
      if (typeof Api !== "object" || typeof Api.get !== "function") return;
      pendingReelHydration.add(id);
      console.log("[MachineOverview] ensureReelMetadata fetch start", id);
      try {
        const summary = await Api.get(`reel/${id}/summary`);
        if (summary && summary.reel) {
          const builder = typeof window.buildReelMetadata === "function" ? window.buildReelMetadata : null;
          const meta = builder ? builder(summary.reel) : {};
          console.log("[MachineOverview] ensureReelMetadata summary", summary.reel, meta);
          Filters.registerReelMetadata({
            ...summary.reel,
            code: meta.code || summary.reel.reel_code || "",
            label: meta.label || formatReelLabel({ code: summary.reel.reel_code || "", order: summary.reel.order_number || "", time: summary.reel.time || summary.reel.timestamp || summary.reel.time_end || summary.reel.time_start || "" }),
            order_number: meta.order || summary.reel.order_number || summary.reel.order || "",
            time: meta.time || summary.reel.time || summary.reel.timestamp || summary.reel.time_end || summary.reel.time_start || "",
          });
          console.log("[MachineOverview] ensureReelMetadata registered", id);
        }
      } catch (err) {
        console.warn(`Failed to hydrate reel metadata for ${id}`, err);
      } finally {
        pendingReelHydration.delete(id);
        console.log("[MachineOverview] ensureReelMetadata complete", id);
      }
    }
    let latestRequestToken = 0;

    function buildOverviewRequestKey(filtersState) {
      if (typeof Utils === "object" && typeof Utils.buildFilterRequestKey === "function") {
        return Utils.buildFilterRequestKey(filtersState || {});
      }
      try {
        return JSON.stringify(filtersState || {});
      } catch (err) {
        return "";
      }
    }

    const load = Utils.debounce(async () => {
      const requestToken = ++latestRequestToken;
      const filtersState =
        Filters && typeof Filters.getState === "function" ? Filters.getState() : {};
      const requestKey = `${buildOverviewRequestKey(filtersState)}|min=${minReelLengthFilter || 0}`;
      const reuseInFlight = inflightOverviewKey === requestKey && inflightOverview;
      const shouldBlock = !hasRenderedOverview || requestKey !== lastRenderedOverviewKey;
      const showOverlay = shouldBlock && !reuseInFlight;
      if (showOverlay) {
        LoadingOverlay.show();
      }
      try {
        const extraParams =
          minReelLengthFilter > 0 ? { min_reel_length: minReelLengthFilter } : {};
        const fetchPromise = reuseInFlight || Api.get("overview", extraParams, filtersState);
        if (!reuseInFlight) {
          inflightOverviewKey = requestKey;
          inflightOverview = fetchPromise;
          fetchPromise.finally(() => {
            if (inflightOverview === fetchPromise) {
              inflightOverview = null;
              inflightOverviewKey = "";
            }
          });
        }
        const data = await fetchPromise;
        if (requestToken !== latestRequestToken) {
          return;
        }
        renderKpis(data.kpis || {});
        renderCharts(data);
        hasRenderedOverview = true;
        lastRenderedOverviewKey = requestKey;
      } catch (err) {
        console.error("Overview load failed", err);
      } finally {
        if (showOverlay) {
          LoadingOverlay.hide();
        }
      }
    }, FETCH_DEBOUNCE_MS);

    function init() {
      kpiMap = {};
      Utils.qsa("[data-kpi]").forEach((node) => {
        const key = node.dataset.kpi;
        if (!key) return;
        let target = node;
        if (node.matches(".kpi-card")) {
          target = node.querySelector("p");
        }
        if (!target) return;
        if (!kpiMap[key]) kpiMap[key] = [];
        kpiMap[key].push(target);
      });
      Utils.qsa("[data-kpi-highlight]").forEach((node) => {
        const key = node.dataset.kpiHighlight;
        if (!key) return;
        if (!kpiMap[key]) kpiMap[key] = [];
        kpiMap[key].push(node);
      });
      setupMinReelLengthControls();
      initialized = true;
    }

    function activate() {
      if (!initialized) init();
      load.flush();
    }

    function onFiltersUpdated() {
      load();
    }

    function renderKpis(kpis) {
      Object.entries(kpiMap).forEach(([key, nodes]) => {
        const targets = Array.isArray(nodes) ? nodes : [nodes];
        const value = kpis[key];
        targets.forEach((el) => {
          if (!el) return;
          switch (key) {
            case "total_length":
            case "active_length":
            case "inactive_length":
            case "learn_length":
              el.textContent = Utils.formatMeters(value || 0);
              break;
            case "active_pct":
            case "inactive_pct":
            case "learn_pct":
              el.textContent = `${Utils.formatNumber(value || 0, 1)}%`;
              break;
            default:
              el.textContent = Utils.formatNumber(value || 0);
          }
        });
      });
    }

    function renderCharts(data) {
      const defectsByType = data.defects_by_type || [];
      renderDefectBreakdown(defectsByType);
      const defectsTrend = data.defects_trend || [];
      const jobsMeters = data.jobs_meters || [];
      const jobsTime = data.jobs_time || [];
      const jobEvents = data.job_events || [];
      const jobMetrics = data.job_metrics || [];
      const jobSensitivity = data.job_sensitivity_summary || [];

      const jobsTimePct = jobsTime.map((job) => {
        const lengthActive = Number.isFinite(job.length_active) ? job.length_active : 0;
        const lengthInactive = Number.isFinite(job.length_inactive) ? job.length_inactive : 0;
        const lengthLearn = Number.isFinite(job.length_learn) ? job.length_learn : 0;
        const lengthTotal = lengthActive + lengthInactive + lengthLearn;

        const minutesActive = Number.isFinite(job.minutes_active) ? job.minutes_active : 0;
        const minutesInactive = Number.isFinite(job.minutes_inactive) ? job.minutes_inactive : 0;
        const minutesLearn = Number.isFinite(job.minutes_learn) ? job.minutes_learn : 0;
        const minutesTotal = minutesActive + minutesInactive + minutesLearn;

        const divisor = lengthTotal || minutesTotal;
        const activeValue = lengthTotal ? lengthActive : minutesActive;
        const inactiveValue = lengthTotal ? lengthInactive : minutesInactive;
        const learnValue = lengthTotal ? lengthLearn : minutesLearn;

        return {
          job: job.job || "Unassigned",
          active_pct: divisor ? (activeValue / divisor) * 100 : 0,
          inactive_pct: divisor ? (inactiveValue / divisor) * 100 : 0,
          learn_pct: divisor ? (learnValue / divisor) * 100 : 0,
        };
      });

      const pieLabelColor = getChartLabelColor();
      Plotly.react(
        "overviewDefectsByType",
        [
          {
            type: "pie",
            labels: defectsByType.map((d) => d.class),
            values: defectsByType.map((d) => d.count),
            hole: 0.35,
            textinfo: "label+percent",
            textposition: "outside",
            insidetextorientation: "auto",
            textfont: { size: 13, color: pieLabelColor },
            hoverinfo: "label+percent+value",
            domain: { x: [0.05, 0.95], y: [0.05, 0.95] },
          },
        ],
        withResponsiveLayout({
          margin: { t: 16, l: 16, r: 16, b: 16 },
          height: 320,
          showlegend: false,
        }),
        plotlyConfig()
      ).then(updateDefectPieTextColor).catch(() => {});

      renderDefectsTrend(defectsTrend);

      renderJobLengthsByJob(jobsTime);
      renderDefectRatesTable(jobMetrics, jobsTime);
      renderSensitivityTable(jobSensitivity);

      renderMaskLeaders(data.job_mask_summary || []);
      renderReferenceLeaders(data.job_reference_summary || []);
      renderJobMetricCards(jobMetrics);
    }

    function renderDefectBreakdown(defectsByType) {
      const container = document.getElementById("defectTypeBreakdown");
      const summary = document.getElementById("defectTypeSummary");
      if (!container) return;
      const totalCard = container.querySelector('[data-kpi="total_defects"]');
      container.innerHTML = "";
      if (totalCard) {
        container.appendChild(totalCard);
      }
      if (!Array.isArray(defectsByType) || !defectsByType.length) {
        container.insertAdjacentHTML(
          "beforeend",
          '<div class="kpi-card kpi-card--inline kpi-card--empty"><h3>No defect data yet</h3><p>--</p></div>'
        );
        if (summary) summary.textContent = "No defect activity in the selected window.";
        return;
      }
      const sorted = defectsByType
        .slice()
        .sort((a, b) => (b.count || 0) - (a.count || 0))
        .slice(0, 6);
      const total = defectsByType.reduce((sum, item) => sum + (item.count || 0), 0);
      const top = sorted[0];
      if (summary) {
        const share = top && total ? ((top.count || 0) / total) * 100 : 0;
        summary.textContent =
          top && total
            ? `${top.class || "Top"} represents ${Utils.formatNumber(share, 1)}% of ${Utils.formatNumber(total)} total defects.`
            : `Tracking ${Utils.formatNumber(total)} total defects.`;
      }
      const cards = sorted
        .map((item) => {
          const label = Utils.escapeHtml(item.class || "Other");
          const formatted = Utils.formatNumber(item.count || 0);
          return `<div class="kpi-card kpi-card--inline"><h3>${label}</h3><p>${formatted}</p></div>`;
        })
        .join("");
      container.insertAdjacentHTML("beforeend", cards);
    }

    function renderLeaderJob(job) {
      const jobName = job && job.job ? job.job : "Unassigned";
      const jobValue = job && typeof job.job_value === "string" ? job.job_value : "";
      const bestList = renderLeaderColumn(job && job.best, "best", jobName, jobValue);
      const worstList = renderLeaderColumn(job && job.worst, "worst", jobName, jobValue);
      return `
        <section class="defect-leaders__job">
          <header class="defect-leaders__header">
            <h4>${Utils.escapeHtml(jobName)}</h4>
            <small>${jobValue ? `Job filter: ${Utils.escapeHtml(jobValue)}` : "Unassigned job"}</small>
          </header>
          <div class="defect-leaders__columns">
            <div class="defect-leaders__column defect-leaders__column--best">
              <div class="defect-leaders__column-title">Least defects</div>
              <div class="defect-leader-list">
                ${bestList}
              </div>
            </div>
            <div class="defect-leaders__column defect-leaders__column--worst">
              <div class="defect-leaders__column-title">Most defects</div>
              <div class="defect-leader-list">
                ${worstList}
              </div>
            </div>
          </div>
        </section>
      `;
    }

    function renderLeaderColumn(list, kind, jobDisplay, jobValue) {
      if (!Array.isArray(list) || !list.length) {
        return '<div class="defect-leader__empty">No reels in this group.</div>';
      }
      return list
        .map((entry) => {
          const reelLabel = entry.label || entry.reel_code || (entry.reel_id ? `Reel ${entry.reel_id}` : "Reel");
          const orderLabelValue = entry.order_number || jobDisplay || "";
          const orderLabel = Utils.escapeHtml(orderLabelValue || "—");
          const value = Utils.formatNumber(entry.defects || 0);
          return `
            <button
              type="button"
              class="defect-leader"
              data-defect-leader="true"
              data-kind="${kind}"
              data-job-display="${Utils.escapeHtml(jobDisplay)}"
              data-job-value="${Utils.escapeHtml(jobValue)}"
              data-reel-code="${Utils.escapeHtml(entry.reel_code || '')}"
              data-reel-id="${entry.reel_id !== undefined && entry.reel_id !== null ? entry.reel_id : ''}"
              data-order-number="${Utils.escapeHtml(entry.order_number || '')}"
            >
              <div class="defect-leader__meta">
                <strong>${Utils.escapeHtml(reelLabel)}</strong>
                <small>${orderLabel}</small>
              </div>
              <div class="defect-leader__value">
                ${value}
                <span>defects</span>
              </div>
            </button>
          `;
        })
        .join("");
    }

    function focusReelFromLeaderboard(jobValue, jobLabel, reelMeta) {
      if (!Filters) return;
      if (typeof Filters.set === "function") {
        Filters.set("job", jobValue || "", { emit: true, updateUrl: true });
      }
      if (typeof Filters.clearReels === "function") {
        Filters.clearReels({ emit: false });
      }
      if (typeof Filters.addReel === "function") {
        const metadata = window.buildReelMetadata
          ? window.buildReelMetadata({
              reel_code: reelMeta.reelCode || "",
              order_number: reelMeta.orderNumber || "",
              time: "",
            })
          : {
              code: reelMeta.reelCode || "",
              order: reelMeta.orderNumber || "",
              time: "",
              label: reelMeta.reelCode || jobLabel,
            };
        Filters.addReel(reelMeta.reelCode || "", reelMeta.reelId, metadata, { replace: true });
      }
      Router.setActive("job");
      scrollToTopSoon();
    }

    function renderMaskLeaders(rankings = []) {
      const container = document.getElementById("overviewMaskLeaders");
      if (!container) return;
      if (!Array.isArray(rankings) || !rankings.length) {
        container.innerHTML =
          "<div class=\"placeholder\">No mask activity in this window.</div>";
        return;
      }
      container.innerHTML = rankings
        .map((group) => {
          const jobValue = group.job_value || "";
          const withMasks = Number(group.with_masks) || 0;
          const withoutMasks = Number(group.without_masks) || 0;
          const totalChanges = Number(group.mask_changes) || 0;
          const totalReels = Number(group.total_reels) || 0;
          return `
            <section class="defect-leaders__job">
              <header class="defect-leaders__header">
                <h4>${Utils.escapeHtml(group.job || "Unassigned")}</h4>
                <small>${jobValue ? `Job filter: ${Utils.escapeHtml(jobValue)}` : "Unassigned job"}</small>
              </header>
              <div class="defect-leaders__column">
                <div class="defect-leaders__column-title">Mask Summary</div>
                <div class="defect-leader-list">
                  <div class="defect-leader__value-row">
                    <span>Total reels</span>
                    <strong>${Utils.formatNumber(totalReels)}</strong>
                  </div>
                  <div class="defect-leader__value-row">
                    <span>Mask changes</span>
                    <strong>${Utils.formatNumber(totalChanges)}</strong>
                  </div>
                  <div class="defect-leader__value-row">
                    <span>Reels with masks</span>
                    <strong>${Utils.formatNumber(withMasks)}</strong>
                  </div>
          <div class="defect-leader__value-row">
            <span>Reels without masks</span>
            <strong>${Utils.formatNumber(withoutMasks)}</strong>
          </div>
        </div>
      </div>
    </section>
  `;
})
        .join("");
    }

    function renderReferenceLeaders(rankings = []) {
      const container = document.getElementById("overviewReferenceLeaders");
      if (!container) return;
      if (!Array.isArray(rankings) || !rankings.length) {
        container.innerHTML = "<div class=\"placeholder\">No reference image data in this window.</div>";
        return;
      }
      container.innerHTML = rankings
        .map((group) => {
          const jobValue = group.job_value || "";
          const totalReels = Utils.formatNumber(Number(group.total_reels) || 0);
          const totalChanges = Utils.formatNumber(Number(group.reference_changes) || 0);
          const singleReels = Utils.formatNumber(Number(group.single_reference_reels) || 0);
          const multiReels = Utils.formatNumber(Number(group.multi_reference_reels) || 0);
          const rows = `
            <div class="defect-leader__value-row">
              <span>Total reels</span>
              <strong>${totalReels}</strong>
            </div>
            <div class="defect-leader__value-row">
              <span>Total reference changes</span>
              <strong>${totalChanges}</strong>
            </div>
            <div class="defect-leader__value-row">
              <span>Reels with 1 reference image</span>
              <strong>${singleReels}</strong>
            </div>
            <div class="defect-leader__value-row">
              <span>Reels with multiple images</span>
              <strong>${multiReels}</strong>
            </div>
          `;
          return renderAggregateSection(group.job, jobValue, rows, "Reference Images");
        })
        .join("");
    }

    function renderAggregateSection(jobName, jobValue, list, subtitle) {
      return `
        <section class="defect-leaders__job">
          <header class="defect-leaders__header">
            <h4>${Utils.escapeHtml(jobName || "Unassigned")}</h4>
            <small>${jobValue ? `Job filter: ${Utils.escapeHtml(jobValue)}` : "Unassigned job"}</small>
          </header>
          <div class="defect-leaders__column">
            <div class="defect-leaders__column-title">${Utils.escapeHtml(subtitle)}</div>
            <div class="defect-leader-list">${list || '<div class="defect-leader__empty">No data.</div>'}</div>
          </div>
        </section>
      `;
    }

    function getFilterTimeRange() {
      const state = Filters && typeof Filters.getState === "function" ? Filters.getState() : {};
      const start = state && state.start ? `${state.start}T00:00:00` : null;
      const end = state && state.end ? `${state.end}T23:59:59` : null;
      return start && end ? [start, end] : null;
    }

    function renderOperationsTimeline(events, reelEvents = []) {
      const containerId = "overviewOperationsTimeline";
      if (!document.getElementById(containerId)) return;

      const range = getFilterTimeRange();
      const rangeLabel =
        range && range.length === 2
          ? `${formatAsDate(range[0])} → ${formatAsDate(range[1])}`
          : "";

      const reelEventList = Array.isArray(reelEvents) ? reelEvents : [];
      const useReelEvents = reelEventList.length > 0;

      const filtered = (events || []).filter((event) =>
        TIMELINE_TYPES.includes(event.event_type)
      );

      if (useReelEvents) {
        const typesInData = Array.from(
          new Set(reelEventList.map((event) => event.event_type || "other"))
        );
        if (!typesInData.length) {
          return renderOperationsTimeline([], []);
        }
        const typeIndex = new Map(typesInData.map((type, idx) => [type, idx]));
        const traces = typesInData.map((type) => {
          const meta = getEventMeta(type);
          const points = reelEventList.filter((event) => (event.event_type || "other") === type);
          const xs = points.map((event) => event.time);
          const ys = points.map(() => typeIndex.get(type) || 0);
          const sizes = points.map((event) => Math.min(10 + (event.count || 1) * 2, 26));
          const texts = points.map((event) => {
            const lines = [];
            lines.push(`<b>${event.job || "Unassigned"}</b>`);
            if (event.reel_code) lines.push(`Reel: ${event.reel_code}`);
            if (event.time) {
              const date = new Date(event.time);
              if (!Number.isNaN(date.getTime())) {
                lines.push(date.toLocaleString());
              }
            }
            lines.push(`${meta.label} change`);
            lines.push(`Count: ${event.count || 0}`);
            return lines.join("<br>");
          });
          return {
            type: "scatter",
            mode: "markers",
            name: meta.label,
            x: xs,
            y: ys,
            text: texts,
            hoverinfo: "text",
            marker: {
              size: sizes,
              symbol: TIMELINE_SYMBOL[type] || "circle",
              color: meta.color,
              opacity: 0.9,
              line: { color: "#0f172a", width: 1 },
            },
            showlegend: false,
            customdata: points.map((event) => ({
              reel: event.reel_code || "",
              reel_id: event.reel_id || "",
              order_number: event.order_number || event.order || "",
              time: event.time || "",
            })),
          };
        });

        const yTicks = typesInData.map((type) => typeIndex.get(type) || 0);
        const yLabels = typesInData.map((type) => getEventMeta(type).label);

        const layout = {
          title: "Operational Changes Timeline",
          xaxis: {
            title: "Time",
            type: "date",
            range: range || undefined,
            autorange: range ? false : true,
          },
          yaxis: {
            title: "Change",
            tickvals: yTicks,
            ticktext: yLabels,
            range: [Math.min(...yTicks) - 0.5, Math.max(...yTicks) + 0.5],
            zeroline: false,
          },
          legend: { orientation: "h", x: 0, y: 1.1 },
          margin: { t: 70, l: 80, r: 20, b: 80 },
          shapes: [
            {
              type: "line",
              xref: "paper",
              x0: 0,
              x1: 1,
              yref: "paper",
              y0: 0,
              y1: 0,
              line: { color: "#cbd5f5", width: 1, dash: "dot" },
            },
          ],
          annotations: rangeLabel
            ? [
                {
                  text: rangeLabel,
                  showarrow: false,
                  xref: "paper",
                  yref: "paper",
                  x: 0,
                  y: 1.12,
                  align: "left",
                  font: { size: 11, color: "#475569" },
                },
              ]
            : [],
        };

        Plotly.react(containerId, traces, withResponsiveLayout(layout), plotlyConfig({ displayModeBar: false, showlegend: false }));
        bindOperationsTimelineClick(containerId);
        return;
      }

      if (!filtered.length) {
        Plotly.react(
          containerId,
          [],
          {
            title: "Operational Changes Timeline",
            annotations: [
              {
                text: "No operational changes in this window",
                showarrow: false,
                xref: "paper",
                yref: "paper",
                x: 0.5,
                y: 0.6,
                font: { color: "#94a3b8" },
              },
            ],
            xaxis: { title: "Time", type: "date", range: range || undefined },
            yaxis: {
              title: "Change",
              range: [-0.1, 1.2],
              tickvals: [0, 1],
              ticktext: ["No change", "Change"],
              zeroline: true,
            },
            margin: { t: 60, l: 60, r: 20, b: 60 },
            shapes: [
              {
                type: "line",
                xref: "paper",
                x0: 0,
                x1: 1,
                y0: 0,
                y1: 0,
                line: { color: "#cbd5f5", width: 1, dash: "dot" },
              },
            ],
          },
          { responsive: true, displayModeBar: false }
        );
        return;
      }

      const grouped = new Map();
      filtered.forEach((event) => {
        const type = event.event_type || "other";
        if (!grouped.has(type)) {
          grouped.set(type, { meta: getEventMeta(type), list: [] });
        }
        grouped.get(type).list.push(event);
      });

      const typesInData = Array.from(
        new Set(filtered.map((event) => event.event_type || "other"))
      );
      const orderedTypes = TIMELINE_TYPES.filter((type) => typesInData.includes(type));

      const traces = orderedTypes
        .map((type) => {
          const bucket = grouped.get(type);
          if (!bucket) return null;
          const xs = bucket.list.map((event) => event.time);
          const ys = bucket.list.map(() => 1);
          const texts = bucket.list.map((event) => buildOperationHover(event, bucket.meta.label));
          return {
            type: "scatter",
            mode: "markers",
            name: bucket.meta.label,
            x: xs,
            y: ys,
            marker: {
              size: 14,
              symbol: TIMELINE_SYMBOL[type] || "circle",
              color: bucket.meta.color,
              opacity: 0.85,
              line: { color: "#0f172a", width: 1 },
            },
            hoverinfo: "text",
            text: texts,
          };
        })
        .filter(Boolean);

      const layout = {
        title: "Operational Changes Timeline",
        xaxis: {
          title: "Time",
          type: "date",
          range: range || undefined,
          autorange: range ? false : true,
        },
        yaxis: {
          title: "Change",
          range: [-0.1, 1.2],
          tickvals: [0, 1],
          ticktext: ["No change", "Change"],
          zeroline: true,
        },
        legend: { orientation: "h", x: 0, y: 1.1 },
        margin: { t: 70, l: 60, r: 20, b: 80 },
        shapes: [
          {
            type: "line",
            xref: "paper",
            x0: 0,
            x1: 1,
            y0: 0,
            y1: 0,
            line: { color: "#cbd5f5", width: 1, dash: "dot" },
          },
        ],
        annotations: rangeLabel
          ? [
              {
                text: rangeLabel,
                showarrow: false,
                xref: "paper",
                yref: "paper",
                x: 0,
                y: 1.12,
                align: "left",
                font: { size: 11, color: "#475569" },
              },
            ]
          : [],
      };

      Plotly.react(containerId, traces, withResponsiveLayout(layout), plotlyConfig({ displayModeBar: false }));
      bindOperationsTimelineClick(containerId);
    }

    function renderOperationsTimeline(events, reelEvents = []) {
      const containerId = "overviewOperationsTimeline";
      if (!document.getElementById(containerId)) return;

      const range = getFilterTimeRange();
      const rangeLabel =
        range && range.length === 2
          ? `${formatAsDate(range[0])} → ${formatAsDate(range[1])}`
          : "";

      const reelEventList = Array.isArray(reelEvents) ? reelEvents : [];
      const useReelEvents = reelEventList.length > 0;

      const filtered = (events || []).filter((event) =>
        TIMELINE_TYPES.includes(event.event_type)
      );

      if (useReelEvents) {
        const typesInData = Array.from(
          new Set(reelEventList.map((event) => event.event_type || "other"))
        );
        if (!typesInData.length) {
          return renderOperationsTimeline([], []);
        }
        const typeIndex = new Map(typesInData.map((type, idx) => [type, idx]));
        const traces = typesInData.map((type) => {
          const meta = getEventMeta(type);
          const points = reelEventList.filter((event) => (event.event_type || "other") === type);
          const xs = points.map((event) => event.time);
          const ys = points.map(() => typeIndex.get(type) || 0);
          const sizes = points.map((event) => Math.min(10 + (event.count || 1) * 2, 26));
          const texts = points.map((event) => {
            const lines = [];
            lines.push(`<b>${event.job || "Unassigned"}</b>`);
            if (event.reel_code) lines.push(`Reel: ${event.reel_code}`);
            if (event.time) {
              const date = new Date(event.time);
              if (!Number.isNaN(date.getTime())) {
                lines.push(date.toLocaleString());
              }
            }
            lines.push(`${meta.label} change`);
            lines.push(`Count: ${event.count || 0}`);
            return lines.join("<br>");
          });
          return {
            type: "scatter",
            mode: "markers",
            name: meta.label,
            x: xs,
            y: ys,
            text: texts,
            hoverinfo: "text",
            marker: {
              size: sizes,
              symbol: TIMELINE_SYMBOL[type] || "circle",
              color: meta.color,
              opacity: 0.9,
              line: { color: "#0f172a", width: 1 },
            },
            showlegend: false,
            customdata: points.map((event) => ({
              reel: event.reel_code || "",
              reel_id: event.reel_id || "",
              order_number: event.order_number || event.order || "",
              time: event.time || "",
            })),
          };
        });

        const yTicks = typesInData.map((type) => typeIndex.get(type) || 0);
        const yLabels = typesInData.map((type) => getEventMeta(type).label);

        const layout = {
          title: "Operational Changes Timeline",
          xaxis: {
            title: "Time",
            type: "date",
            range: range || undefined,
            autorange: range ? false : true,
          },
          yaxis: {
            title: "Change",
            tickvals: yTicks,
            ticktext: yLabels,
            range: [Math.min(...yTicks) - 0.5, Math.max(...yTicks) + 0.5],
            zeroline: false,
          },
          legend: { orientation: "h", x: 0, y: 1.1 },
          margin: { t: 70, l: 80, r: 20, b: 80 },
          shapes: [
            {
              type: "line",
              xref: "paper",
              x0: 0,
              x1: 1,
              yref: "paper",
              y0: 0,
              y1: 0,
              line: { color: "#cbd5f5", width: 1, dash: "dot" },
            },
          ],
          annotations: rangeLabel
            ? [
                {
                  text: rangeLabel,
                  showarrow: false,
                  xref: "paper",
                  yref: "paper",
                  x: 0,
                  y: 1.12,
                  align: "left",
                  font: { size: 11, color: "#475569" },
                },
              ]
            : [],
        };

        Plotly.react(containerId, traces, withResponsiveLayout(layout), plotlyConfig({ displayModeBar: false, showlegend: false }));
        bindOperationsTimelineClick(containerId);
        return;
      }

      if (!filtered.length) {
        Plotly.react(
          containerId,
          [],
          {
            title: "Operational Changes Timeline",
            annotations: [
              {
                text: "No operational changes in this window",
                showarrow: false,
                xref: "paper",
                yref: "paper",
                x: 0.5,
                y: 0.6,
                font: { color: "#94a3b8" },
              },
            ],
            xaxis: { title: "Time", type: "date", range: range || undefined },
            yaxis: {
              title: "Change",
              range: [-0.1, 1.2],
              tickvals: [0, 1],
              ticktext: ["No change", "Change"],
              zeroline: true,
            },
            margin: { t: 60, l: 60, r: 20, b: 60 },
            shapes: [
              {
                type: "line",
                xref: "paper",
                x0: 0,
                x1: 1,
                y0: 0,
                y1: 0,
                line: { color: "#cbd5f5", width: 1, dash: "dot" },
              },
            ],
          },
          { responsive: true, displayModeBar: false }
        );
        return;
      }

      const grouped = new Map();
      filtered.forEach((event) => {
        const type = event.event_type || "other";
        if (!grouped.has(type)) {
          grouped.set(type, { meta: getEventMeta(type), list: [] });
        }
        grouped.get(type).list.push(event);
      });

      const typesInData = Array.from(
        new Set(filtered.map((event) => event.event_type || "other"))
      );
      const orderedTypes = TIMELINE_TYPES.filter((type) => typesInData.includes(type));

      const traces = orderedTypes
        .map((type) => {
          const bucket = grouped.get(type);
          if (!bucket) return null;
          const xs = bucket.list.map((event) => event.time);
          const ys = bucket.list.map(() => 1);
          const texts = bucket.list.map((event) => buildOperationHover(event, bucket.meta.label));
          return {
            type: "scatter",
            mode: "markers",
            name: bucket.meta.label,
            x: xs,
            y: ys,
            marker: {
              size: 14,
              symbol: TIMELINE_SYMBOL[type] || "circle",
              color: bucket.meta.color,
              opacity: 0.85,
              line: { color: "#0f172a", width: 1 },
            },
            hoverinfo: "text",
            text: texts,
          };
        })
        .filter(Boolean);

      const layout = {
        title: "Operational Changes Timeline",
        xaxis: {
          title: "Time",
          type: "date",
          range: range || undefined,
          autorange: range ? false : true,
        },
        yaxis: {
          title: "Change",
          range: [-0.1, 1.2],
          tickvals: [0, 1],
          ticktext: ["No change", "Change"],
          zeroline: true,
        },
        legend: { orientation: "h", x: 0, y: 1.1 },
        margin: { t: 70, l: 60, r: 20, b: 80 },
        shapes: [
          {
            type: "line",
            xref: "paper",
            x0: 0,
            x1: 1,
            y0: 0,
            y1: 0,
            line: { color: "#cbd5f5", width: 1, dash: "dot" },
          },
        ],
        annotations: rangeLabel
          ? [
              {
                text: rangeLabel,
                showarrow: false,
                xref: "paper",
                yref: "paper",
                x: 0,
                y: 1.12,
                align: "left",
                font: { size: 11, color: "#475569" },
              },
            ]
          : [],
      };

      Plotly.react(containerId, traces, withResponsiveLayout(layout), plotlyConfig({ displayModeBar: false }));
      bindOperationsTimelineClick(containerId);
    }

    function bindOperationsTimelineClick(containerId) {
      const plotEl = document.getElementById(containerId);
      if (!plotEl || typeof plotEl.on !== "function") return;
      const handler = (eventData) => {
        if (!eventData || !eventData.points || !eventData.points.length) return;
        const point = eventData.points[0];
        const payload = point && point.customdata ? point.customdata : null;
        const reelCode = payload ? payload.reel || payload.reel_code || payload.code || "" : "";
        const reelId = payload ? payload.reel_id || payload.id || "" : "";
        if (!reelCode && !reelId) return;
        addReelFromPayload(reelCode, reelId, payload || {});
        Router.setActive("job");
        scrollToTopSoon();
      };
      if (typeof plotEl.removeAllListeners === "function") {
        plotEl.removeAllListeners("plotly_click");
      } else if (plotEl.__bstTimelineClick && typeof plotEl.removeListener === "function") {
        plotEl.removeListener("plotly_click", plotEl.__bstTimelineClick);
      } else if (plotEl.__bstTimelineClick && typeof plotEl.off === "function") {
        plotEl.off("plotly_click", plotEl.__bstTimelineClick);
      }
      plotEl.__bstTimelineClick = handler;
      plotEl.on("plotly_click", handler);
      plotEl.style.cursor = "pointer";
    }

    function renderJobMetricCards(jobMetrics) {
      const configs = [
        {
          id: "overviewDefectsByJob",
          title: "",
          key: "defect_count",
          label: "Defects",
          height: 320,
          margin: { t: 20, l: 160, r: 30, b: 50 },
          custom: "defects_by_job",
          maxJobs: 6,
        },
      ];

      configs.forEach((config) => renderSingleJobMetricChart(jobMetrics, config));
    }

    function renderSingleJobMetricChart(jobMetrics, config) {
      const container = document.getElementById(config.id);
      if (!container) return;

      const source = Array.isArray(jobMetrics) ? jobMetrics : [];
      if (!source.length) {
        renderJobMetricPlaceholder(config.id, config.title);
        return;
      }

      const sorted = source
        .slice()
        .sort((a, b) => (b[config.key] || 0) - (a[config.key] || 0))
        .slice(0, 8);

      const hasValues = sorted.some((item) => (item[config.key] || 0) > 0);
      if (!hasValues) {
        renderJobMetricPlaceholder(config.id, config.title);
        return;
      }

      if (config.custom === "defects_by_job") {
        renderDefectsByJobHorizontalChart(sorted, config);
        return;
      }

      const labels = sorted.map((item) => item.job || "Unassigned");
      const totals = sorted.map((item) => item[config.key] || 0);

      if (config.breakdownKey) {
        const breakdownData = buildStackedSeries(sorted, config.breakdownKey, totals, config.palette);
        const stackedMargin = config.margin || { t: 90, l: 70, r: 30, b: 80 };
        const stackedHeight = config.height || 360;
        Plotly.react(
          config.id,
          breakdownData.traces,
          {
            title: config.title,
            margin: stackedMargin,
            height: stackedHeight,
            barmode: "stack",
            xaxis: { automargin: true },
            yaxis: { rangemode: "tozero", title: config.label },
            legend: { orientation: "h", x: 0, y: 1.15 },
          },
          { responsive: true }
        );
        return;
      }

      const customData = sorted.map((item) => [
        item.top_defect_class || "None",
        item.top_defect_count || 0,
        item.dominant_phase || "N/A",
        item.top_mask_xml || "None",
        item.top_mask_count || 0,
      ]);

      Plotly.react(
        config.id,
        [
          {
            type: "bar",
            x: labels,
            y: totals,
            marker: { color: config.color },
            customdata: customData,
            hovertemplate:
              `<b>%{x}</b><br>${config.label}: %{y}<br>` +
              "Top defect: %{customdata[0]} (%{customdata[1]})<br>" +
              "Top mask: %{customdata[3]} (%{customdata[4]})<br>" +
              "Dominant phase: %{customdata[2]}<extra></extra>",
          },
        ],
        {
          title: config.title,
          margin: config.margin || { t: 70, l: 70, r: 30, b: 80 },
          height: config.height || 360,
          yaxis: { rangemode: "tozero", title: config.label },
          xaxis: { automargin: true },
        },
        { responsive: true, displayModeBar: false }
      );
    }

    function renderDefectsByJobHorizontalChart(items, config) {
      const containerId = config.id;
      if (!document.getElementById(containerId)) return;
      const jobs = items.slice(0, config.maxJobs || 5);
      if (!jobs.length) {
        renderJobMetricPlaceholder(containerId, config.title);
        return;
      }

      const jobStats = jobs.map((job, idx) => {
        const breakdown = Array.isArray(job.defect_breakdown) ? job.defect_breakdown : [];
        const classCounts = new Map();
        breakdown.forEach((entry) => {
          const key = normalizeDefectClassName(entry && entry.name);
          if (!key) return;
          classCounts.set(key, (classCounts.get(key) || 0) + (entry.count || 0));
        });
        return {
          label: job.job || `Job ${idx + 1}`,
          total: job[config.key] || 0,
          classCounts,
        };
      });

      const rowMetrics = [];
      const totalRow = DEFECT_CLASS_ROWS.find((row) => row.key === "__total__");
      if (totalRow) {
        const totalValues = jobStats.map((job) => job.total);
        rowMetrics.push({
          row: totalRow,
          values: totalValues,
          total: totalValues.reduce((sum, value) => sum + value, 0),
        });
      }
      const remainingRows = DEFECT_CLASS_ROWS.filter((row) => row.key !== "__total__").map((row) => {
        const values = jobStats.map((job) => getClassCountFromMap(job.classCounts, row));
        return { row, values, total: values.reduce((sum, value) => sum + value, 0) };
      });
      remainingRows.sort((a, b) => (b.total || 0) - (a.total || 0));
      rowMetrics.push(...remainingRows);

      const rowLabels = rowMetrics.map((entry) => entry.row.label).reverse();

      const traces = jobStats.map((job, idx) => {
        const values = rowMetrics.map((entry) => entry.values[idx] || 0).reverse();
        return {
          type: "bar",
          orientation: "h",
          name: job.label,
          x: values,
          y: rowLabels,
          hovertemplate: `<b>${job.label}</b><br>%{y}: %{x}<extra></extra>`,
        };
      });

      const layout = withResponsiveLayout({
        title: config.title || undefined,
        barmode: "stack",
        margin: config.margin || { t: 60, l: 140, r: 30, b: 50 },
        height: config.height || 360,
        xaxis: { title: { text: "Defect Count" }, rangemode: "tozero", automargin: true },
        yaxis: {
          automargin: true,
          categoryorder: "array",
          categoryarray: rowLabels,
        },
        legend: { orientation: "h", x: 0, y: 1.1 },
      });

      Plotly.react(containerId, traces, layout, plotlyConfig({ displayModeBar: false }));
    }

    function buildStackedSeries(items, breakdownKey, totals, palette = []) {
      const maxSegments = 6;
      const accumTotals = new Map();

      items.forEach((item) => {
        (item[breakdownKey] || []).forEach(({ name, count }) => {
          if (!name || !count) return;
          accumTotals.set(name, (accumTotals.get(name) || 0) + count);
        });
      });

      const topCategories = Array.from(accumTotals.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, maxSegments)
        .map(([name]) => name);
      const topSet = new Set(topCategories);

      const traces = [];
      const colorPalette =
        palette.length >= topCategories.length
          ? palette
          : [
              "#f97316",
              "#fb923c",
              "#fde047",
              "#22c55e",
              "#2dd4bf",
              "#60a5fa",
              "#c084fc",
              "#f472b6",
            ];

      topCategories.forEach((category, idx) => {
        const color = colorPalette[idx % colorPalette.length];
        const values = items.map((item) => {
          const breakdown = item[breakdownKey] || [];
          const match = breakdown.find((entry) => entry.name === category);
          return match ? match.count || 0 : 0;
        });
        traces.push({
          type: "bar",
          name: category,
          x: items.map((item) => item.job || "Unassigned"),
          y: values,
          marker: { color },
          hovertemplate: "<b>%{x}</b><br>" + `${category}: %{y}<extra></extra>`,
        });
      });

      const otherValues = items.map((item, idx) => {
        const breakdown = item[breakdownKey] || [];
        const residual =
          (totals[idx] || 0) -
          breakdown.reduce((sum, entry) => (topSet.has(entry.name) ? sum + (entry.count || 0) : sum), 0);
        return Math.max(residual, 0);
      });

      if (otherValues.some((value) => value > 0)) {
        traces.push({
          type: "bar",
          name: "Other",
          x: items.map((item) => item.job || "Unassigned"),
          y: otherValues,
          marker: { color: "#94a3b8" },
          hovertemplate: "<b>%{x}</b><br>Other: %{y}<extra></extra>",
        });
      }

      return { traces };
    }

    function renderJobMetricPlaceholder(containerId, title) {
      Plotly.react(
        containerId,
        [],
        {
          title,
          annotations: [
            {
              text: "No data in this window",
              showarrow: false,
              xref: "paper",
              yref: "paper",
              x: 0.5,
              y: 0.5,
              font: { color: "#94a3b8" },
            },
          ],
          xaxis: { visible: false },
          yaxis: { visible: false },
          margin: { t: 50, l: 20, r: 20, b: 40 },
          height: 360,
        },
        { responsive: true, displayModeBar: false }
      );
    }

    function getEventMeta(type) {
      if (EVENT_META[type]) return EVENT_META[type];
      const label = (type || "Other")
        .split("_")
        .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
        .join(" ");
      return { label, color: "#475569" };
    }

    function buildOperationHover(event, label) {
      const lines = [];
      lines.push(`<b>${event.job || "Unassigned"}</b>`);
      if (event.time) {
        const date = new Date(event.time);
        if (!Number.isNaN(date.getTime())) {
          lines.push(date.toLocaleString());
        }
      }
      lines.push(`${label} change`);
      lines.push(`Count: ${event.count || 0}`);
      lines.push(...describeOperationEvent(event));
      return lines.filter(Boolean).join("<br>");
    }

    function describeOperationEvent(event) {
      const lines = [];
      switch (event.event_type) {
        case "defect":
          if (Array.isArray(event.class_breakdown) && event.class_breakdown.length) {
            const top = event.class_breakdown.slice(0, 4).map(
              (item) => `${item.class || "Unknown"} (${item.count})`
            );
            lines.push(`Top classes: ${top.join(", ")}`);
            if (event.class_breakdown.length > 4) {
              lines.push(`+${event.class_breakdown.length - 4} more classes`);
            }
          }
          break;
        case "reference_change":
          if (Array.isArray(event.details) && event.details.length) {
            const detail = event.details[0];
            const fromRef = detail.from || "previous";
            const toRef = detail.to || "new";
            lines.push(`Reference: ${fromRef} → ${toRef}`);
            if (detail.from_filename || detail.to_filename) {
              const fileFrom = detail.from_filename || "—";
              const fileTo = detail.to_filename || "—";
              lines.push(`File: ${fileFrom} → ${fileTo}`);
            }
          } else {
            lines.push("Reference image updated");
          }
          break;
        case "mask_applied":
          if (Array.isArray(event.details) && event.details.length) {
            const detail = event.details[0];
            const xml = detail.xml_id || "Mask";
            const sens = detail.sensitivity_id || detail.sensitivitysetid || "";
            const formatVal =
              detail.format_value !== undefined && detail.format_value !== null
                ? Utils.formatNumber(detail.format_value, 2)
                : "—";
            let maskLine = `${xml} · Format ${formatVal}`;
            if (sens) maskLine += ` · Sens ${sens}`;
            lines.push(maskLine);
          }
          break;
        case "sensitivity_change": {
          const summary = Array.isArray(event.details) ? event.details[0] : null;
          if (summary && Array.isArray(summary.changes)) {
            summary.changes.slice(0, 4).forEach((change) => {
              lines.push(formatSensitivityChange(change));
            });
            if (summary.changes.length > 4) {
              lines.push(`+${summary.changes.length - 4} more changes`);
            }
          }
          if (summary && summary.previous_settings) {
            lines.push(`Prev: ${formatSensitivitySnapshot(summary.previous_settings)}`);
          }
          if (summary && summary.current_settings) {
            lines.push(`Current: ${formatSensitivitySnapshot(summary.current_settings)}`);
          }
          break;
        }
        case "rlm_config_change": {
          const summary = Array.isArray(event.details) ? event.details[0] : null;
          if (summary && Array.isArray(summary.changes)) {
            summary.changes.slice(0, 5).forEach((change) => {
              lines.push(formatRlmChange(change));
            });
            if (summary.changes.length > 5) {
              lines.push(`+${summary.changes.length - 5} more keys`);
            }
          }
          if (summary && summary.previous_settings) {
            lines.push(`Prev: ${formatRlmSnapshot(summary.previous_settings)}`);
          }
          if (summary && summary.current_settings) {
            lines.push(`Current: ${formatRlmSnapshot(summary.current_settings)}`);
          }
          break;
        }
        default:
          break;
      }

      if (Array.isArray(event.reel_codes) && event.reel_codes.length) {
        lines.push(`Reels: ${event.reel_codes.join(", ")}`);
      }

      return lines.filter(Boolean);
    }

    function formatSensitivityChange(change) {
      if (!change || !change.class) return "";
      const prev = change.previous || {};
      const curr = change.current || {};
      const parts = [];
      parts.push(`${change.class}:`);
      parts.push(`T ${Utils.formatNumber(prev.threshold, 3)} → ${Utils.formatNumber(curr.threshold, 3)}`);
      parts.push(`W ${Utils.formatNumber(prev.warn, 3)} → ${Utils.formatNumber(curr.warn, 3)}`);
      return parts.join(" ");
    }

    function formatSensitivitySnapshot(snapshot) {
      const entries = Object.entries(snapshot || {});
      if (!entries.length) return "—";
      const maxEntries = 5;
      const rendered = entries.slice(0, maxEntries).map(([cls, values]) => {
        if (!values) return `${cls}: (n/a)`;
        return `${cls}: T ${Utils.formatNumber(values.threshold, 3)}, W ${Utils.formatNumber(values.warn, 3)}`;
      });
      const remainder = entries.length - maxEntries;
      if (remainder > 0) {
        rendered.push(`+${remainder} more classes`);
      }
      return rendered.join("; ");
    }

    function formatRlmChange(change) {
      if (!change || !change.key) return "";
      const oldVal = Utils.formatNumber(change.old, 3);
      const newVal = Utils.formatNumber(change.new, 3);
      return `${change.key}: ${oldVal} → ${newVal}`;
    }

    function formatRlmSnapshot(snapshot) {
      const entries = Object.entries(snapshot || {});
      if (!entries.length) return "—";
      const maxEntries = 6;
      const rendered = entries.slice(0, maxEntries).map(([key, value]) => `${key}: ${Utils.formatNumber(value, 3)}`);
      const remainder = entries.length - maxEntries;
      if (remainder > 0) {
        rendered.push(`+${remainder} more keys`);
      }
      return rendered.join(", ");
    }

    function buildDefectsTrendHover(job, point) {
      const lines = [`<b>${job}</b>`];
      if (point.time) {
        const date = new Date(point.time);
        if (!Number.isNaN(date.getTime())) {
          lines.push(date.toLocaleString());
        }
      }
      lines.push(`Defects: ${point.count || 0}`);
      return lines.join("<br>");
    }

    function renderJobLengthsByJob(jobsTime = []) {
      const containerId = "overviewJobLengths";
      const container = document.getElementById(containerId);
      if (!container) return;
      latestJobLengthsData = Array.isArray(jobsTime) ? jobsTime.slice() : [];
      if (!latestJobLengthsData.length) {
        container.innerHTML =
          '<div class="placeholder">No inspection mix data for this window.</div>';
        return;
      }
      if (!container.dataset.mode) {
        container.dataset.mode = "raw";
      }
      const buttons = Array.from(document.querySelectorAll(".job-lengths-toggle__btn"));
      if (!jobLengthsToggleBound && buttons.length) {
        buttons.forEach((btn) => {
          btn.addEventListener("click", () => {
            const mode = btn.dataset.lengthMode === "pct" ? "pct" : "raw";
            if (container.dataset.mode === mode) return;
            container.dataset.mode = mode;
            buttons.forEach((node) =>
              node.classList.toggle(
                "job-lengths-toggle__btn--active",
                node.dataset.lengthMode === mode
              )
            );
            renderJobLengthsTable(container, latestJobLengthsData, mode);
          });
        });
        jobLengthsToggleBound = true;
      }
      buttons.forEach((btn) => {
        const mode = container.dataset.mode || "raw";
        btn.classList.toggle(
          "job-lengths-toggle__btn--active",
          btn.dataset.lengthMode === mode
        );
      });
      const mode = container.dataset.mode === "pct" ? "pct" : "raw";
      renderJobLengthsTable(container, latestJobLengthsData, mode);
    }

    function renderDefectsTrend(defectsTrend = []) {
      const containerId = "overviewDefectsTrend";
      if (!document.getElementById(containerId)) return;
      const ONE_HOUR_MS = 60 * 60 * 1000;
      const formatLastHourLabel = (timeValue) => {
        if (!timeValue) return "Last 1 hr";
        const end = new Date(timeValue);
        if (Number.isNaN(end.getTime())) {
          return "Last 1 hr";
        }
        const start = new Date(end.getTime() - ONE_HOUR_MS);
        const format = (date) =>
          date.toLocaleString(undefined, {
            month: "short",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          });
        return `Time window: ${format(start)} → ${format(end)} (last 1 hr)`;
      };
      const map = new Map();
      (defectsTrend || []).forEach((entry) => {
        const job = entry && entry.job ? entry.job : "Unassigned";
        if (!map.has(job)) map.set(job, []);
        map.get(job).push(entry);
      });
      const traces = Array.from(map.entries()).map(([job, points]) => {
        const sorted = points
          .slice()
          .filter((point) => point && point.time)
          .sort((a, b) => new Date(a.time) - new Date(b.time));
        const customdata = sorted.map((point) => [
          job,
          formatLastHourLabel(point.time),
        ]);
        return {
          type: "scatter",
          mode: "lines+markers",
          name: job,
          x: sorted.map((point) => point.time),
          y: sorted.map((point) => point.count),
          customdata,
          hovertemplate:
            "<b>%{customdata[0]}</b><br>%{customdata[1]}<br>%{y} defects<extra></extra>",
        };
      });
      if (!traces.length) {
        Plotly.react(
          containerId,
          [],
          withResponsiveLayout({
            annotations: [
              {
                text: "No defect trend data for this window",
                showarrow: false,
                x: 0.5,
                y: 0.5,
                xref: "paper",
                yref: "paper",
                font: { color: "#94a3b8" },
              },
            ],
            margin: { t: 20, l: 40, r: 20, b: 40 },
          }),
          plotlyConfig({ displayModeBar: false })
        );
        return;
      }
      Plotly.react(
        containerId,
        traces,
        withResponsiveLayout({
          hovermode: "closest",
          xaxis: {
            type: "date",
            title: { text: "Time" },
            tickformat: "%b %d %H:%M",
            ticklabelmode: "period",
          },
          yaxis: { title: { text: "Defect Count" }, rangemode: "tozero" },
          margin: { t: 20, l: 50, r: 20, b: 60 },
          legend: { orientation: "h", x: 0, y: 1.15 },
        }),
        plotlyConfig()
      );
    }

    function renderJobLengthsTable(container, jobsTime = [], mode = "raw") {
      const jobs = jobsTime
        .map((job) => ({
          label: job.job || "Unassigned",
          value: job.job || "",
          active: Number.isFinite(job.length_active) ? job.length_active : 0,
          inactive: Number.isFinite(job.length_inactive) ? job.length_inactive : 0,
          learn: Number.isFinite(job.length_learn) ? job.length_learn : 0,
        }))
        .sort((a, b) => {
          const totalA = a.active + a.inactive + a.learn;
          const totalB = b.active + b.inactive + b.learn;
          return totalB - totalA;
        })
        .slice(0, 12);
      const rows = jobs
        .map((job) => {
          const total = job.active + job.inactive + job.learn;
          if (mode === "pct" && total > 0) {
            return `
              <tr data-job-value="${Utils.escapeHtml(job.value)}">
                <td><button type="button" class="job-lengths-link">${Utils.escapeHtml(
                  job.label
                )}</button></td>
                <td>${Utils.formatNumber(100, 1)}%</td>
                <td>${Utils.formatNumber((job.active / total) * 100, 1)}%</td>
                <td>${Utils.formatNumber((job.inactive / total) * 100, 1)}%</td>
                <td>${Utils.formatNumber((job.learn / total) * 100, 1)}%</td>
              </tr>
            `;
          }
          return `
            <tr data-job-value="${Utils.escapeHtml(job.value)}">
              <td><button type="button" class="job-lengths-link">${Utils.escapeHtml(
                job.label
              )}</button></td>
              <td>${Utils.formatMeters(total)}</td>
              <td>${Utils.formatMeters(job.active)}</td>
              <td>${Utils.formatMeters(job.inactive)}</td>
              <td>${Utils.formatMeters(job.learn)}</td>
            </tr>
          `;
        })
        .join("");
      container.innerHTML = `
        <div class="job-lengths-table-wrapper">
          <table class="job-lengths-table">
            <thead>
              <tr>
                <th>Job</th>
                <th>${mode === "pct" ? "Total %" : "Total Length (ft)"}</th>
                <th>${mode === "pct" ? "Active %" : "Active (ft)"}</th>
                <th>${mode === "pct" ? "Inactive %" : "Inactive (ft)"}</th>
                <th>${mode === "pct" ? "Learn %" : "Learn (ft)"}</th>
              </tr>
            </thead>
            <tbody>
              ${rows}
            </tbody>
          </table>
        </div>
      `;

      container.querySelectorAll("tr[data-job-value]").forEach((row) => {
        row.addEventListener("click", (event) => {
          event.stopPropagation();
          const value = row.dataset.jobValue || "";
          toggleJobFilter(value);
        });
      });
    }

    function setupMinReelLengthControls() {
      const input = document.getElementById("defectMinReelLengthInput");
      const applyBtn = document.getElementById("defectMinReelLengthApply");
      const clearBtn = document.getElementById("defectMinLengthClear");
      if (input) {
        input.value = minReelLengthFilter ? Math.round(minReelLengthFilter) : "";
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            applyMinReelLength(input.value);
          }
        });
      }
      if (applyBtn) {
        applyBtn.addEventListener("click", () =>
          applyMinReelLength(input ? input.value : "")
        );
      }
      if (clearBtn) {
        clearBtn.addEventListener("click", () => applyMinReelLength(""));
      }
      updateMinLengthChip();
    }

    function applyMinReelLength(rawValue) {
      const parsed = Number(rawValue);
      const nextValue = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
      if (nextValue === minReelLengthFilter) {
        updateMinLengthChip();
        return;
      }
      minReelLengthFilter = nextValue;
      persistMinReelLength(minReelLengthFilter);
      const input = document.getElementById("defectMinReelLengthInput");
      if (input) {
        input.value = minReelLengthFilter ? Math.round(minReelLengthFilter) : "";
      }
      updateMinLengthChip();
      load.flush();
    }

    function updateMinLengthChip() {
      const chip = document.getElementById("defectMinLengthChip");
      const text = chip ? chip.querySelector("span") : null;
      if (!chip) return;
      if (minReelLengthFilter > 0) {
        chip.classList.remove("hidden");
        if (text) {
          text.textContent = `Min reel feet ≥ ${Utils.formatNumber(minReelLengthFilter, 0)} ft`;
        }
      } else {
        chip.classList.add("hidden");
        if (text) text.textContent = "";
      }
    }

    function loadStoredMinLength() {
      if (typeof sessionStorage === "undefined") return DEFAULT_MIN_REEL_LENGTH_FEET;
      try {
        const raw = sessionStorage.getItem(MIN_LENGTH_STORAGE_KEY);
        if (raw === null || raw === undefined) {
          return DEFAULT_MIN_REEL_LENGTH_FEET;
        }
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) {
          return DEFAULT_MIN_REEL_LENGTH_FEET;
        }
        if (parsed <= 0) {
          return 0;
        }
        return parsed;
      } catch (err) {
        return DEFAULT_MIN_REEL_LENGTH_FEET;
      }
    }

    function persistMinReelLength(value) {
      if (typeof sessionStorage === "undefined") return;
      try {
        if (!Number.isFinite(value) || value <= 0) {
          sessionStorage.setItem(MIN_LENGTH_STORAGE_KEY, "0");
        } else {
          sessionStorage.setItem(MIN_LENGTH_STORAGE_KEY, String(value));
        }
      } catch (err) {
        // ignore storage failures
      }
    }

    function renderDefectRatesTable(jobMetrics = [], jobsTime = []) {
      const container = document.getElementById("overviewDefectRates");
      if (!container) return;
      if (!Array.isArray(jobMetrics) || !jobMetrics.length) {
        container.innerHTML = '<div class="placeholder">No defect rate data for this window.</div>';
        return;
      }
      const lengthMap = new Map();
      (jobsTime || []).forEach((entry) => {
        const label = entry && entry.job ? entry.job : "Unassigned";
        const activeMeters = Number(entry.length_active) || 0;
        lengthMap.set(label, activeMeters * METERS_TO_FEET);
      });
      const rows = [];
      jobMetrics.forEach((job) => {
        const label = job && job.job_display ? job.job_display : job && job.job ? job.job : "Unassigned";
        const lengthFt = lengthMap.get(job.job || job.job_display) || 0;
        const totalDefects = Number(job.defect_count) || 0;
        const breakdownList = Array.isArray(job.defect_breakdown) ? job.defect_breakdown : [];
        const rates = new Map();
        breakdownList.forEach((entry) => {
          const key = normalizeDefectClassName(entry && entry.name);
          if (!key) return;
          rates.set(key, (rates.get(key) || 0) + (entry.count || 0));
        });
        const row = {
          label,
          value: job.job || "",
          total: lengthFt > 0 ? (totalDefects / lengthFt) * 1000 : 0,
          counts: rates,
          length: lengthFt,
        };
        rows.push(row);
      });
      if (!rows.length) {
        container.innerHTML = '<div class="placeholder">No defect rate data for this window.</div>';
        return;
      }
      rows.sort((a, b) => b.total - a.total);
      const topRows = rows.slice(0, 10);
      const columns = [
        { key: "__total__", label: "Total defects per 1k" },
        { key: "flaw", label: "Flaw defects per 1k" },
        { key: "sporadicflaw", label: "Sporadic flaw defects per 1k" },
        { key: "streak", label: "Streak defects per 1k" },
        { key: "sporadicstreak", label: "Sporadic streak defects per 1k" },
        { key: "colour", label: "Colour defects per 1k" },
        { key: "register", label: "Register defects per 1k" },
      ];
      const body = topRows
        .map((row) => {
          const totalRate = row.total;
          const classCells = columns
            .map((col) => {
              if (col.key === "__total__") {
                return `<td>${Utils.formatNumber(totalRate, 2)}</td>`;
              }
              const count = row.counts.get(col.key) || row.counts.get(normalizeDefectClassName(col.label)) || 0;
              const rate = row.length > 0 ? (count / row.length) * 1000 : 0;
              return `<td>${Utils.formatNumber(rate, 2)}</td>`;
            })
            .join("");
          return `
            <tr data-job-value="${Utils.escapeHtml(row.value)}">
              <td><button type="button" class="job-lengths-link">${Utils.escapeHtml(row.label)}</button></td>
              <td>${Utils.formatNumber(row.length, 0)}</td>
              ${classCells}
            </tr>
          `;
        })
        .join("");
      const header = [
        "<th>Active ft</th>",
        ...columns.map((col) => `<th>${Utils.escapeHtml(col.label)}</th>`),
      ].join("");
      container.innerHTML = `
        <div class="defect-rates-table-wrapper">
          <table class="defect-rates-table">
            <thead>
              <tr>
                <th>Job</th>
                ${header}
              </tr>
            </thead>
            <tbody>
              ${body}
            </tbody>
          </table>
        </div>
      `;
      container.querySelectorAll("tr[data-job-value]").forEach((row) => {
        row.addEventListener("click", (event) => {
          event.stopPropagation();
          const value = row.dataset.jobValue || "";
          toggleJobFilter(value);
        });
      });
    }

    function renderSensitivityTable(summary = []) {
      const container = document.getElementById("overviewSensitivityTable");
      if (!container) return;
      if (!Array.isArray(summary) || !summary.length) {
        container.innerHTML =
          '<div class="placeholder">No sensitivity data for this window.</div>';
        return;
      }
      const rows = summary
        .slice(0, 10)
        .map((entry) => {
          const label = entry && entry.job ? entry.job : "Unassigned";
          const jobValue = entry && entry.job_value ? entry.job_value : "";
          const classes = entry && entry.classes ? entry.classes : {};
          const cells = SENSITIVITY_COLUMNS.map((col) => {
            const list = Array.isArray(classes[col.key]) ? classes[col.key] : [];
            if (!list.length) return "<td>—</td>";
            const text = list
              .slice(0, 3)
              .map(
                (item) =>
                  `${Utils.formatNumber(item.value, 3)} (${Utils.formatNumber(item.count, 0)})`
              )
              .join("<br>");
            const remainder = list.length - 3;
            const extra = remainder > 0 ? `<br>+${remainder} more` : "";
            return `<td>${text}${extra}</td>`;
          }).join("");
          return `
            <tr data-job-value="${Utils.escapeHtml(jobValue)}">
              <td><button type="button" class="job-lengths-link">${Utils.escapeHtml(
                label
              )}</button></td>
              ${cells}
            </tr>
          `;
        })
        .join("");
      const header = SENSITIVITY_COLUMNS.map(
        (col) => `<th>${Utils.escapeHtml(col.label)}</th>`
      );
      container.innerHTML = `
        <div class="defect-rates-table-wrapper">
          <table class="defect-rates-table">
            <thead>
              <tr>
                <th>Job</th>
                ${header.join("")}
              </tr>
            </thead>
            <tbody>
              ${rows}
            </tbody>
          </table>
        </div>
      `;
      container.querySelectorAll("tr[data-job-value]").forEach((row) => {
        row.addEventListener("click", (event) => {
          event.stopPropagation();
          const value = row.dataset.jobValue || "";
          toggleJobFilter(value);
        });
      });
    }

    return { init, activate, onFiltersUpdated };
  })();
