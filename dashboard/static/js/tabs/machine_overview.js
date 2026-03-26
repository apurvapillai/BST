  const OverviewTab = (() => {
    let initialized = false;
    let kpiMap = {};
    let inflightOverview = null;
    let inflightOverviewKey = "";
    let lastRenderedOverviewKey = "";
    let hasRenderedOverview = false;

    const pendingReelHydration = new Set();
    const DEFECT_CLASS_ROWS = [
      { key: "__total__", label: "Total Defects" },
      { key: "flaw", label: "Flaws", aliases: ["flas"] },
      { key: "sporadicflaw", label: "Sporadic Flaws", aliases: ["sporadicflas"] },
      { key: "streak", label: "Streak" },
      { key: "sporadicstreak", label: "Sporadic Streak" },
      { key: "colour", label: "Colour", aliases: ["color", "colur"] },
      { key: "register", label: "Register" },
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
    const EVENT_ORDER = [
      "defect",
      "reference_change",
      "mask_applied",
      "sensitivity_change",
      "rlm_config_change",
    ];
    const EVENT_META = {
      defect: { label: "Defects", color: "#ef4444" },
      reference_change: { label: "Reference Changes", color: "#2563eb" },
      mask_applied: { label: "Masks Applied", color: "#f97316" },
      sensitivity_change: { label: "Sensitivity Changes", color: "#0ea5e9" },
      rlm_config_change: { label: "RLM Config Changes", color: "#14b8a6" },
    };
    const TIMELINE_TYPES = [
      "sensitivity_change",
      "mask_applied",
      "rlm_config_change",
      "reference_change",
    ];
    const TIMELINE_SYMBOL = {
      sensitivity_change: "circle",
      mask_applied: "square",
      rlm_config_change: "diamond",
      reference_change: "triangle-up",
    };

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
      const filtersState = Filters && typeof Filters.getState === "function" ? Filters.getState() : {};
      const requestKey = buildOverviewRequestKey(filtersState);
      const reuseInFlight = inflightOverviewKey === requestKey && inflightOverview;
      const shouldBlock = !hasRenderedOverview || requestKey !== lastRenderedOverviewKey;
      const showOverlay = shouldBlock && !reuseInFlight;
      if (showOverlay) {
        LoadingOverlay.show();
      }
      try {
        const fetchPromise = reuseInFlight || Api.get("overview", {}, filtersState);
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
      Utils.qsa(".kpi-card[data-kpi]").forEach((card) => {
        const key = card.dataset.kpi;
        const target = card.querySelector("p");
        if (!key || !target) return;
        if (!kpiMap[key]) kpiMap[key] = [];
        kpiMap[key].push(target);
      });
      Utils.qsa("[data-kpi-highlight]").forEach((node) => {
        const key = node.dataset.kpiHighlight;
        if (!key) return;
        if (!kpiMap[key]) kpiMap[key] = [];
        kpiMap[key].push(node);
      });
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
      const defectRankings = data.job_reel_defect_rankings || [];
      const jobMetrics = data.job_metrics || [];

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
            automargin: true,
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

      Plotly.react(
        "overviewDefectsTrend",
        [
          {
            type: "scatter",
            mode: "lines+markers",
            x: defectsTrend.map((d) => d.time),
            y: defectsTrend.map((d) => d.count),
            line: { color: "#0f172a" },
          },
        ],
        withResponsiveLayout({
          title: "Defects Trend",
          xaxis: { type: "date" },
          margin: { t: 40, l: 40, r: 20, b: 60 },
        }),
        plotlyConfig()
      );

      renderJobLengthsByJob(jobsTime);

      renderJobsDefectRankings(defectRankings);
      renderMaskLeaders(data.job_mask_rankings || []);
      renderReferenceLeaders(data.job_reference_rankings || []);
      renderJobMetricCards(jobMetrics);
      const reelOpsTimeline = data.job_reel_operations_timeline || [];
      renderOperationsTimeline(jobEvents, reelOpsTimeline);
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

    function renderJobsDefectRankings(rankings = []) {
      const container = document.getElementById("overviewJobsDefects");
      if (!container) return;
      if (!Array.isArray(rankings) || !rankings.length) {
        container.innerHTML = "<div class=\"placeholder\">No defect data for this window.</div>";
        return;
      }
      container.innerHTML = rankings.map(renderLeaderJob).join("");
      if (!container.dataset.leaderbound) {
        container.addEventListener("click", (event) => {
          const target = event.target.closest("[data-defect-leader]");
          if (!target) return;
          const jobValue = target.dataset.jobValue || "";
          const jobLabel = target.dataset.jobDisplay || jobValue || "Unassigned";
          const reelCode = target.dataset.reelCode || "";
          const reelId = target.dataset.reelId ? Number(target.dataset.reelId) : null;
          const orderNumber = target.dataset.orderNumber || "";
          focusReelFromLeaderboard(jobValue, jobLabel, { reelCode, reelId, orderNumber });
        });
        container.dataset.leaderbound = "true";
      }
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
        container.innerHTML = "<div class=\"placeholder\">No mask changes in this window.</div>";
        return;
      }
      container.innerHTML = rankings
        .map((group) => {
          const items = (group.items || []).slice(0, 5);
          if (!items.length) return "";
          const jobValue = group.job_value || "";
          const list = items
            .map((entry) => {
              const orderLabel = entry.order || "All orders";
              const value = Utils.formatNumber(entry.mask_count || 0);
              return `
                <button type="button" class="defect-leader" data-defect-leader="true"
                  data-kind="mask" data-job-display="${Utils.escapeHtml(entry.job || group.job)}"
                  data-job-value="${Utils.escapeHtml(jobValue)}" data-reel-code=""
                  data-reel-id="" data-order-number="${Utils.escapeHtml(orderLabel)}">
                  <div class="defect-leader__meta">
                    <strong>${Utils.escapeHtml(orderLabel)}</strong>
                    <small>${Utils.escapeHtml(entry.label || orderLabel)}</small>
                  </div>
                  <div class="defect-leader__value">${value}<span>masks</span></div>
                </button>
              `;
            })
            .join("");
          return renderAggregateSection(group.job, jobValue, list, "Mask Activity");
        })
        .join("");
    }

    function renderReferenceLeaders(rankings = []) {
      const container = document.getElementById("overviewReferenceLeaders");
      if (!container) return;
      if (!Array.isArray(rankings) || !rankings.length) {
        container.innerHTML = "<div class=\"placeholder\">No reference changes in this window.</div>";
        return;
      }
      container.innerHTML = rankings
        .map((group) => {
          const items = (group.items || []).slice(0, 5);
          if (!items.length) return "";
          const jobValue = group.job_value || "";
          const list = items
            .map((entry) => {
              const orderLabel = entry.order || "All orders";
              const value = Utils.formatNumber(entry.reference_changes || 0);
              return `
                <button type="button" class="defect-leader" data-defect-leader="true"
                  data-kind="reference" data-job-display="${Utils.escapeHtml(entry.job || group.job)}"
                  data-job-value="${Utils.escapeHtml(jobValue)}" data-reel-code=""
                  data-reel-id="" data-order-number="${Utils.escapeHtml(orderLabel)}">
                  <div class="defect-leader__meta">
                    <strong>${Utils.escapeHtml(orderLabel)}</strong>
                    <small>${Utils.escapeHtml(entry.label || orderLabel)}</small>
                  </div>
                  <div class="defect-leader__value">${value}<span>ref changes</span></div>
                </button>
              `;
            })
            .join("");
          return renderAggregateSection(group.job, jobValue, list, "Reference Changes");
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

    return { init, activate, onFiltersUpdated };
  })();
    function renderJobLengthsByJob(jobsTime = []) {
      const containerId = "overviewJobLengths";
      const container = document.getElementById(containerId);
      if (!container) return;
      if (!Array.isArray(jobsTime) || !jobsTime.length) {
        container.innerHTML =
          '<div class="placeholder">No inspection mix data for this window.</div>';
        return;
      }
      const toggle = document.querySelectorAll(".job-lengths-toggle__btn");
      toggle.forEach((btn) => {
        btn.addEventListener("click", () => {
          const mode = btn.dataset.lengthMode === "pct" ? "pct" : "raw";
          toggle.forEach((node) =>
            node.classList.toggle("job-lengths-toggle__btn--active", node === btn)
          );
          container.dataset.mode = mode;
          renderJobLengthsTable(container, jobsTime, mode);
        });
      });
      const mode =
        container.dataset.mode === "pct" ||
        document.querySelector('.job-lengths-toggle__btn[data-length-mode="pct"]')?.classList.contains("job-lengths-toggle__btn--active")
          ? "pct"
          : "raw";
      renderJobLengthsTable(container, jobsTime, mode);
    }

    function renderJobLengthsTable(container, jobsTime = [], mode = "raw") {
      const jobs = jobsTime
        .map((job) => ({
          label: job.job || "Unassigned",
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
              <tr>
                <td>${Utils.escapeHtml(job.label)}</td>
                <td>${Utils.formatNumber(100, 1)}%</td>
                <td>${Utils.formatNumber((job.active / total) * 100, 1)}%</td>
                <td>${Utils.formatNumber((job.inactive / total) * 100, 1)}%</td>
                <td>${Utils.formatNumber((job.learn / total) * 100, 1)}%</td>
              </tr>
            `;
          }
          return `
            <tr>
              <td>${Utils.escapeHtml(job.label)}</td>
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
                <th>${mode === "pct" ? "Total %" : "Total Length"}</th>
                <th>${mode === "pct" ? "Active %" : "Active"}</th>
                <th>${mode === "pct" ? "Inactive %" : "Inactive"}</th>
                <th>${mode === "pct" ? "Learn %" : "Learn"}</th>
              </tr>
            </thead>
            <tbody>
              ${rows}
            </tbody>
          </table>
        </div>
      `;
    }
