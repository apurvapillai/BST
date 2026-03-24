  const OverviewTab = (() => {
    let initialized = false;
    let kpiMap = {};
    let heatmapContainer;
    let rlmRange = null;
    const heatmapState = {
      jobs: [],
      selectedJob: "",
    };

    const pendingReelHydration = new Set();

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

    const load = Utils.debounce(async () => {
      const requestToken = ++latestRequestToken;
      if (!heatmapContainer) {
        heatmapContainer = Utils.qs("#overviewHeatmapCanvas");
      }
      if (heatmapContainer) {
        const { job = "", order = "" } = Filters.getState();
        const jobValue = typeof job === "string" ? job.trim() : "";
        const orderValue = typeof order === "string" ? order.trim() : "";
        const hasSelection = Boolean(jobValue) || Boolean(orderValue);
        if (hasSelection) {
          heatmapState.jobs = [];
          heatmapState.selectedJob = "";
          heatmapContainer.innerHTML =
            `<div class="heatmap-wrapper heatmap-empty heatmap-notice"><span class='badge'>Loading heatmap…</span></div>`;
        } else if (!heatmapState.jobs.length) {
          heatmapContainer.innerHTML =
            `<div class="heatmap-wrapper heatmap-empty heatmap-notice"><span class='badge'>Select a job or order to view the heatmap.</span></div>`;
        }
      }
      LoadingOverlay.show();
      try {
        const data = await Api.get("overview");
        if (requestToken !== latestRequestToken) {
          return;
        }
        renderKpis(data.kpis || {});
        renderCharts(data);
      } catch (err) {
        console.error("Overview load failed", err);
      } finally {
        LoadingOverlay.hide();
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
      heatmapContainer = Utils.qs("#overviewHeatmapCanvas");
      initialized = true;
    }

    function activate() {
      if (!initialized) init();
      load.flush();
    }

    function onFiltersUpdated() {
      if (!heatmapContainer) {
        heatmapContainer = Utils.qs("#overviewHeatmapCanvas");
      }
      if (heatmapContainer) {
        const { job = "", order = "" } = Filters.getState();
        const jobValue = typeof job === "string" ? job.trim() : "";
        const orderValue =
          typeof order === "string"
            ? order.trim()
            : "";
        const hasSelection = Boolean(jobValue) || Boolean(orderValue);
        heatmapState.jobs = [];
        heatmapState.selectedJob = "";
        heatmapContainer.innerHTML = hasSelection
          ? `<div class="heatmap-wrapper heatmap-empty heatmap-notice"><span class='badge'>Loading heatmap…</span></div>`
          : `<div class="heatmap-wrapper heatmap-empty heatmap-notice"><span class='badge'>Select a job or order to view the heatmap.</span></div>`;
      }
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
      const jobsDefects = data.jobs_defects || [];
      const jobEvents = data.job_events || [];
      const jobsDefectsTrend = data.jobs_defects_timeline || [];
      const jobMetrics = data.job_metrics || [];
      const jobHeatmaps = data.job_heatmaps || [];

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

      Plotly.react(
        "overviewDefectsByType",
        [
          {
            type: "pie",
            labels: defectsByType.map((d) => d.class),
            values: defectsByType.map((d) => d.count),
            hole: 0.35,
            textinfo: "label+percent",
            hoverinfo: "label+percent+value",
          },
        ],
        withResponsiveLayout({
          title: "Defects by Type",
          margin: { t: 50, l: 20, r: 20, b: 20 },
        }),
        plotlyConfig()
      );

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

      Plotly.react(
        "overviewJobsMeters",
        [
          {
            type: "bar",
            x: jobsMeters.map((d) => d.job),
            y: jobsMeters.map((d) => d.meters),
            marker: { color: "#10b981" },
          },
        ],
        {
          title: "Meters Run by Job",
          margin: { t: 40, l: 40, r: 20, b: 80 },
        },
        { responsive: true }
      );

      Plotly.react(
        "overviewJobsTime",
        [
          {
            type: "bar",
            name: "Active",
            x: jobsTimePct.map((d) => d.job),
            y: jobsTimePct.map((d) => d.active_pct),
            marker: { color: "#22c55e" },
          },
          {
            type: "bar",
            name: "Inactive",
            x: jobsTimePct.map((d) => d.job),
            y: jobsTimePct.map((d) => d.inactive_pct),
            marker: { color: "#ef4444" },
          },
          {
            type: "bar",
            name: "Learn",
            x: jobsTimePct.map((d) => d.job),
            y: jobsTimePct.map((d) => d.learn_pct),
            marker: { color: "#f59e0b" },
          },
        ],
        {
          barmode: "stack",
          title: "Inspection Mix by Job (%)",
          yaxis: { title: "Percent", ticksuffix: "%" },
          margin: { t: 50, l: 60, r: 20, b: 80 },
        },
        { responsive: true }
      );

      const rlmTrend = data.rlm_trend || {};
      updateRlmRange(rlmTrend);

      // Render in order so all time-series use the same reel-based window
      renderOverviewRlmTrend(rlmTrend);
      const reelDefectsTrend = data.job_reel_defects_timeline || [];
      const defectsTimelineSource = reelDefectsTrend.length ? reelDefectsTrend : jobsDefectsTrend;
      renderJobsDefectsTrend(defectsTimelineSource, jobsDefects);
      renderJobMetricCards(jobMetrics);
      const reelOpsTimeline = data.job_reel_operations_timeline || [];
      renderOperationsTimeline(jobEvents, reelOpsTimeline);
      renderJobHeatmap(jobHeatmaps);
    }

    function renderDefectBreakdown(defectsByType) {
      const container = document.getElementById("defectTypeBreakdown");
      const summary = document.getElementById("defectTypeSummary");
      if (!container) return;
      const totalCard = container.querySelector('[data-kpi="total_defects"]');
      const baseMarkup = totalCard ? totalCard.outerHTML : "";
      container.innerHTML = baseMarkup;
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

    let rlmRangeMs = null;

    function updateRlmRange(trendData) {
      const spans = Array.isArray(trendData.reel_spans) ? trendData.reel_spans : [];
      const tableRows = Array.isArray(trendData.table) ? trendData.table : [];
      let minTs = null;
      let maxTs = null;

      function consider(ts) {
        const date = ts ? new Date(ts) : null;
        if (!(date instanceof Date) || Number.isNaN(date.getTime())) return;
        const ms = date.getTime();
        if (minTs === null || ms < minTs) minTs = ms;
        if (maxTs === null || ms > maxTs) maxTs = ms;
      }

      spans.forEach((span) => {
        consider(span.start);
        consider(span.end);
      });
      tableRows.forEach((row) => {
        consider(row.start);
        consider(row.end);
      });

      if (minTs !== null && maxTs !== null && minTs < maxTs) {
        const paddedStart = minTs - 60 * 60 * 1000;
        const paddedEnd = maxTs + 60 * 60 * 1000;

        const roundedStart = new Date(paddedStart);
        roundedStart.setMinutes(0, 0, 0);

        const roundedEnd = new Date(paddedEnd);
        roundedEnd.setMinutes(0, 0, 0);
        if (roundedEnd.getTime() <= paddedEnd) {
          roundedEnd.setHours(roundedEnd.getHours() + 1);
        }

        rlmRangeMs = [roundedStart.getTime(), roundedEnd.getTime()];
      } else {
        rlmRangeMs = null;
      }
    }

    function toLocalIso(msValue) {
      const d = new Date(msValue);
      if (Number.isNaN(d.getTime())) return null;
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      const hours = String(d.getHours()).padStart(2, "0");
      const minutes = String(d.getMinutes()).padStart(2, "0");
      const seconds = String(d.getSeconds()).padStart(2, "0");
      return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
    }

    function getTimeRange(trendData) {
      if (trendData) {
        updateRlmRange(trendData);
      }
      if (rlmRangeMs) {
        const startIso = toLocalIso(rlmRangeMs[0]);
        const endIso = toLocalIso(rlmRangeMs[1]);
        if (startIso && endIso) {
          return [startIso, endIso];
        }
      }
      // Fallback to the current filter window if no reel-derived window exists
      const { start, end } = Filters.getState();
      const startDate = start ? new Date(start) : null;
      const endDate = end ? new Date(end) : null;
      if (
        startDate instanceof Date &&
        endDate instanceof Date &&
        !Number.isNaN(startDate.getTime()) &&
        !Number.isNaN(endDate.getTime()) &&
        startDate.getTime() < endDate.getTime()
      ) {
        const startIso = toLocalIso(startDate.getTime());
        const endIso = toLocalIso(endDate.getTime());
        if (startIso && endIso) {
          return [startIso, endIso];
        }
      }
      return null;
    }

    function renderJobsDefectsTrend(trend, totals) {
      const containerId = "overviewJobsDefects";
      if (!document.getElementById(containerId)) return;

      const range = getTimeRange();
      const rangeLabel =
        range && range.length === 2
          ? `${formatAsDate(range[0])} → ${formatAsDate(range[1])}`
          : "";

      if (!trend.length) {
        if (!totals.length) {
          Plotly.react(
            containerId,
            [],
            {
              title: "Defects per Job (Trend)",
              annotations: [
                {
                  text: "No defect activity in this window",
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
              margin: { t: 60, l: 40, r: 20, b: 40 },
            },
            plotlyConfig({ displayModeBar: false })
          );
        } else {
          Plotly.react(
            containerId,
            [
              {
                type: "bar",
                x: totals.map((item) => item.job),
                y: totals.map((item) => item.count),
                marker: { color: "#8b5cf6" },
              },
            ],
            {
              title: "Defects per Job",
              margin: { t: 60, l: 50, r: 20, b: 80 },
            },
            plotlyConfig()
          );
        }
        return;
      }

      const grouped = new Map();
      trend.forEach((point) => {
        const job = point.job || "Unassigned";
        const reelCode = point.reel_code || "";
        const reelId = point.reel_id !== undefined && point.reel_id !== null ? point.reel_id : null;
        const seriesLabel = reelCode ? `${reelCode}${job ? ` · ${job}` : ""}` : job;
        const entry = {
          time: point.time,
          count: point.count || 0,
          reel: reelCode,
          reel_id: reelId,
          job,
          order_number: point.order_number || point.order || "",
        };
        if (!grouped.has(seriesLabel)) grouped.set(seriesLabel, []);
        grouped.get(seriesLabel).push(entry);
      });

      const traces = Array.from(grouped.entries()).map(([job, points]) => {
        const sortedPoints = points
          .slice()
          .sort((a, b) => new Date(a.time || 0).getTime() - new Date(b.time || 0).getTime());
        const xs = sortedPoints.map((item) => item.time);
        const ys = sortedPoints.map((item) => item.count || 0);
        const texts = sortedPoints.map((item) => {
          const base = buildDefectsTrendHover(item.reel || job, item);
          const timeLabel = item.time ? new Date(item.time).toLocaleString() : "";
          return timeLabel ? `${base}<br>${timeLabel}` : base;
        });
        const sizes = ys.map((value) => Math.min(6 + value * 2, 20));
        return {
          type: "scatter",
          mode: "lines+markers",
          name: job,
          x: xs,
          y: ys,
          text: texts,
          hoverinfo: "text",
          line: { shape: "linear" },
          marker: {
            size: sizes,
            sizemode: "diameter",
            line: { color: "#0f172a", width: 1 },
          },
          customdata: sortedPoints.map((item) => ({
            reel: item.reel,
            reel_id: item.reel_id,
            job: item.job,
            time: item.time,
            order_number: item.order_number || "",
          })),
        };
      });

      const layout = withResponsiveLayout({
        title: "Defects per Job (Trend)",
        xaxis: {
          type: "date",
          title: "Time",
          range: range || undefined,
          autorange: range ? false : true,
        },
        yaxis: { title: "Defects" },
        showlegend: false,
        margin: { t: 70, l: 60, r: 20, b: 90 },
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
      });

      Plotly.react(containerId, traces, layout, plotlyConfig());

      const plotEl = document.getElementById(containerId);
      if (plotEl) {
        plotEl.on("plotly_click", (eventData) => {
          if (!eventData || !eventData.points || !eventData.points.length) return;
          const point = eventData.points[0];
        const payload = point && point.customdata ? point.customdata : null;
        const reelCode = payload ? (payload.reel || payload.reel_code || payload.code || "") : "";
        const reelId = payload ? (payload.reel_id || payload.id || "") : "";
        if (!reelCode && !reelId) return;
        addReelFromPayload(reelCode, reelId, payload || {});
          Router.setActive("job");
          scrollToTopSoon();
        });
        plotEl.style.cursor = "pointer";
      }
    }

    function renderOperationsTimeline(events, reelEvents = []) {
      const containerId = "overviewOperationsTimeline";
      if (!document.getElementById(containerId)) return;

      const range = getTimeRange();
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
        const plotEl = document.getElementById(containerId);
        if (plotEl) {
        plotEl.on("plotly_click", (eventData) => {
          if (!eventData || !eventData.points || !eventData.points.length) return;
          const point = eventData.points[0];
        const payload = point && point.customdata ? point.customdata : null;
        const reelCode = payload ? (payload.reel || payload.reel_code || payload.code || "") : "";
        const reelId = payload ? (payload.reel_id || payload.id || "") : "";
        if (!reelCode && !reelId) return;
        addReelFromPayload(reelCode, reelId, payload || {});
          Router.setActive("job");
          scrollToTopSoon();
        });
          plotEl.style.cursor = "pointer";
        }
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
    }

    function renderOverviewRlmTrend(trendData) {
      const containerId = "overviewRlmTrendChart";
      const missingId = "overviewRlmMissing";
      const containerEl = document.getElementById(containerId);
      const missingEl = document.getElementById(missingId);
      if (!containerEl) return;
      updateRlmRange(trendData);

      const points = Array.isArray(trendData.points) ? trendData.points : [];
      const spans = Array.isArray(trendData.reel_spans) ? trendData.reel_spans : [];
      const tableRows = Array.isArray(trendData.table) ? trendData.table : [];
      const xRange = getTimeRange();
      const rangeLabel =
        xRange && xRange.length === 2
          ? `${formatAsDate(xRange[0])} → ${formatAsDate(xRange[1])}`
          : "";

      function renderMissingList(missingSpans) {
        if (!missingEl) return;
        if (!tableRows.length) {
          missingEl.innerHTML = "<div class=\"placeholder\">No reels in this window.</div>";
          return;
        }
        const pointStatsCache = new Map();
        const FEET_PER_METER = 3.28084;
        function formatRepeatDual(valueInInches) {
          if (valueInInches === null || valueInInches === undefined || Number.isNaN(valueInInches)) return "—";
          const mm = valueInInches * MM_TO_IN;
          return `${Utils.formatNumber(valueInInches, 2)} in (${Utils.formatNumber(mm, 2)} mm)`;
        }
        function getPointStats(row) {
          const label = labelFor(row);
          const cacheKey = `${label}-${row.start || ""}-${row.end || ""}`;
          if (pointStatsCache.has(cacheKey)) return pointStatsCache.get(cacheKey);
          const startTs = row.start ? new Date(row.start).getTime() : null;
          const endTs = row.end ? new Date(row.end).getTime() : null;
          const stats = { count: 0, min: null, max: null, sum: 0, hasRepeat: false };
          points.forEach((p) => {
            if (labelFor(p) !== label) return;
            const ts = p.time ? new Date(p.time).getTime() : null;
            if (ts === null || Number.isNaN(ts)) return;
            if (startTs !== null && !Number.isNaN(startTs) && ts < startTs) return;
            if (endTs !== null && !Number.isNaN(endTs) && ts > endTs) return;
            const repeat = Utils.toInches(p.repeat_length);
            stats.count += 1;
            if (repeat !== null && Number.isFinite(repeat)) {
              stats.hasRepeat = true;
              stats.min = stats.min === null ? repeat : Math.min(stats.min, repeat);
              stats.max = stats.max === null ? repeat : Math.max(stats.max, repeat);
              stats.sum += repeat;
            }
          });
          if (stats.hasRepeat && stats.count) {
            stats.avg = stats.sum / stats.count;
          } else {
            stats.avg = null;
          }
          pointStatsCache.set(cacheKey, stats);
          return stats;
        }
        const rows = tableRows
          .map((row) => {
            const label = labelFor(row);
            const windowLabel = `${formatAsDate(row.start)} → ${formatAsDate(row.end)}`;
            const metersLabel =
              row.meters !== undefined && row.meters !== null
                ? `${Utils.formatNumber(row.meters * FEET_PER_METER, 2)} ft (${Utils.formatNumber(row.meters, 2)} m)`
                : "N/A";
            const stats = getPointStats(row);
            const rlmCount = stats.count;
            const hasPoints = rlmCount > 0 ? "On" : "Off";
            const minRepeat = stats.min !== null ? formatRepeatDual(stats.min) : "—";
            const maxRepeat = stats.max !== null ? formatRepeatDual(stats.max) : "—";
            const avgRepeat = stats.avg !== null ? formatRepeatDual(stats.avg) : "—";
            return `
              <tr>
                <td>${Utils.escapeHtml(label)}</td>
                <td>${Utils.escapeHtml(windowLabel)}</td>
                <td>${Utils.escapeHtml(metersLabel)}</td>
                <td>${hasPoints}</td>
                <td>${rlmCount}</td>
                <td>${minRepeat}</td>
                <td>${maxRepeat}</td>
                <td>${avgRepeat}</td>
              </tr>
            `;
          })
          .join("");
        missingEl.innerHTML = `
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Reel</th>
                  <th>Window</th>
                  <th>Length (ft / m)</th>
                  <th>Repeat Length</th>
                  <th>RLM Points</th>
                  <th>Min Repeat (in / mm)</th>
                  <th>Max Repeat (in / mm)</th>
                  <th>Avg Repeat (in / mm)</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        `;
      }

      function formatAsDate(value) {
        if (!value) return "N/A";
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return "N/A";
        return date.toLocaleString();
      }

      if (!points.length) {
        renderMissingList(spans);
        Plotly.react(
          containerId,
          [],
          {
            title: "Repeat Length (RLM)",
            annotations: [
              {
                text: "No monitoring data in this window",
                showarrow: false,
                xref: "paper",
                yref: "paper",
                x: 0.5,
                y: 0.5,
                font: { color: "#94a3b8" },
              },
            ],
            xaxis: {
              title: "Time",
              type: "date",
              range: xRange || undefined,
              autorange: xRange ? false : true,
            },
        yaxis: { title: "Repeat Length (in)" },
            margin: { t: 60, l: 60, r: 60, b: 60 },
            showlegend: false,
            annotations: rangeLabel
              ? [
                  {
                    text: rangeLabel,
                    showarrow: false,
                    xref: "paper",
                    yref: "paper",
                    x: 0,
                    y: 1.15,
                    align: "left",
                    font: { size: 11, color: "#475569" },
                  },
                ]
              : [],
          },
          plotlyConfig({ displayModeBar: false })
        );
        return;
      }

      const palette = ["#0ea5e9", "#22c55e", "#f59e0b", "#ef4444", "#8b5cf6", "#14b8a6", "#ec4899", "#e11d48"];
      const colorMap = new Map();
      function colorForLabel(label) {
        const key = label || "Reel";
        if (!colorMap.has(key)) {
          const nextColor = palette[colorMap.size % palette.length];
          colorMap.set(key, nextColor);
        }
        return colorMap.get(key);
      }

      function labelFor(entry) {
        return entry.reel_code || entry.order_number || (Number.isFinite(entry.reel_id) ? `Reel ${entry.reel_id}` : "Reel");
      }

      function toRgba(hex, alpha) {
        if (typeof hex !== "string" || !hex.startsWith("#") || (hex.length !== 7 && hex.length !== 4)) {
          return `rgba(15, 23, 42, ${alpha})`;
        }
        let r;
        let g;
        let b;
        if (hex.length === 4) {
          r = parseInt(hex[1] + hex[1], 16);
          g = parseInt(hex[2] + hex[2], 16);
          b = parseInt(hex[3] + hex[3], 16);
        } else {
          r = parseInt(hex.slice(1, 3), 16);
          g = parseInt(hex.slice(3, 5), 16);
          b = parseInt(hex.slice(5, 7), 16);
        }
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
      }

      const normalizedPoints = points
        .map((entry) => {
          const time = entry.time;
          if (!time) return null;
          const webspeed = Number.isFinite(entry.webspeed) ? Number(entry.webspeed) : null;
          const repeatLength = Utils.toInches(entry.repeat_length);
          return {
            time,
            webspeed,
            repeatLength,
            label: labelFor(entry),
            reel_code: entry.reel_code || "",
            reel_id: entry.reel_id !== undefined ? entry.reel_id : null,
          };
        })
        .filter(Boolean)
        .sort((a, b) => new Date(a.time || 0).getTime() - new Date(b.time || 0).getTime());

      const labelsWithData = new Set(normalizedPoints.map((p) => p.label));
      const spansWithData = spans.filter((span) => labelsWithData.has(labelFor(span)));
      const spansMissing = spans.filter((span) => !labelsWithData.has(labelFor(span)));
      renderMissingList(spansMissing);

      function paddedRange(values) {
        const nums = values.filter((val) => Number.isFinite(val));
        if (!nums.length) return null;
        const minVal = Math.min(...nums);
        const maxVal = Math.max(...nums);
        const pad = 10;
        const lower = minVal - pad;
        const upper = maxVal + pad;
        return [lower, upper];
      }

      if (!normalizedPoints.length) {
        Plotly.react(
          containerId,
          [],
          {
            title: "Repeat Length & Web Speed (RLM)",
            annotations: [
              {
                text: "No monitoring data in this window",
                showarrow: false,
                xref: "paper",
                yref: "paper",
                x: 0.5,
                y: 0.5,
                font: { color: "#94a3b8" },
              },
            ],
            xaxis: { title: "Time", type: "date" },
            yaxis: { title: "Web Speed" },
            yaxis2: { title: "Repeat Length", overlaying: "y", side: "right" },
            margin: { t: 60, l: 60, r: 60, b: 60 },
          },
          plotlyConfig({ displayModeBar: false })
        );
        return;
      }

      const groupedRepeat = new Map();
      normalizedPoints.forEach((point) => {
        const label = point.label;
        if (!groupedRepeat.has(label)) groupedRepeat.set(label, []);
        groupedRepeat.get(label).push(point);
      });

      const repeatRanges = paddedRange(
        normalizedPoints
          .map((p) => (Number.isFinite(p.repeatLength) ? Number(p.repeatLength) : null))
          .filter((v) => v !== null)
      );

      function bucketByDate(series) {
        const buckets = new Map();
        series.forEach((item) => {
          const day = item.time ? item.time.split("T")[0] : "unknown";
          if (!buckets.has(day)) buckets.set(day, []);
          buckets.get(day).push(item);
        });
        return buckets;
      }

      const repeatTraces = Array.from(groupedRepeat.entries()).flatMap(([label, series]) => {
        const color = colorForLabel(label);
        const buckets = bucketByDate(series);
        return Array.from(buckets.entries()).map(([day, bucketSeries], idx) => ({
          type: "scatter",
          mode: "lines+markers",
          name: `Repeat Length (${label})`,
          x: bucketSeries.map((item) => item.time),
          y: bucketSeries.map((item) => item.repeatLength),
          line: { color },
          marker: { size: 6, color },
          hovertemplate: `Reel: ${label}<br>Date: ${day}<br>Time: %{x}<br>Repeat Length: %{y}<extra></extra>`,
          legendgroup: label,
          showlegend: false,
          customdata: bucketSeries.map((item) => ({
            reel: item.reel_code || label,
            reel_id: item.reel_id,
            time: item.time,
            order_number: item.order_number || item.order || "",
          })),
        }));
      });

      const shapes = spans
        .filter((span) => span && span.start && span.end)
        .map((span) => {
          const label = labelFor(span);
          const hasData = labelsWithData.has(label);
          const base = colorForLabel(label);
          const color = hasData ? toRgba(base, 0.08) : toRgba(base, 0.04);
          return {
            type: "rect",
            xref: "x",
            yref: "paper",
            x0: span.start,
            x1: span.end,
            y0: 0,
            y1: 1,
            fillcolor: color,
            line: { width: 0 },
          };
        });

      const layout = withResponsiveLayout({
        title: "Repeat Length (RLM)",
        xaxis: {
          title: "Time",
          type: "date",
          range: xRange || undefined,
          autorange: xRange ? false : true,
        },
        yaxis: { title: "Repeat Length (in)", range: repeatRanges || undefined },
        showlegend: false,
        margin: { t: 70, l: 70, r: 70, b: 80 },
        shapes,
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
      });

      Plotly.react(containerId, repeatTraces, layout, plotlyConfig({ displayModeBar: false, showlegend: false }));

      const plotEl = document.getElementById(containerId);
      if (plotEl) {
        plotEl.on("plotly_click", (eventData) => {
          if (!eventData || !eventData.points || !eventData.points.length) return;
          const point = eventData.points[0];
        const payload = point && point.customdata ? point.customdata : null;
        const reelCode = payload ? (payload.reel || payload.reel_code || payload.code || "") : "";
        const reelId = payload ? (payload.reel_id || payload.id || "") : "";
        if (!reelCode && !reelId) return;
        addReelFromPayload(reelCode, reelId, payload || {});
          Router.setActive("job");
          scrollToTopSoon();
        });
        plotEl.style.cursor = "pointer";
      }

      renderAvgTrend(normalizedPoints);

      function renderAvgTrend(pointsList) {
        const avgContainer = document.getElementById("overviewRlmAvgTrend");
        if (!avgContainer) return;
        if (!pointsList.length) {
          Plotly.react(
            avgContainer,
            [],
            {
              title: "Average Repeat Length by Reel",
              annotations: [
                {
                  text: "No monitoring data in this window",
                  showarrow: false,
                  xref: "paper",
                  yref: "paper",
                  x: 0.5,
                  y: 0.5,
                  font: { color: "#94a3b8" },
                },
              ],
              xaxis: { visible: false },
              yaxis: { title: "Repeat Length (in)" },
              margin: { t: 50, l: 60, r: 20, b: 40 },
              showlegend: false,
            },
            plotlyConfig({ displayModeBar: false })
          );
          return;
        }

        const byLabel = new Map();
        pointsList.forEach((p) => {
          const label = p.label;
          if (!byLabel.has(label)) byLabel.set(label, []);
          byLabel.get(label).push(p);
        });

        const avgTraces = Array.from(byLabel.entries()).flatMap(([label, series]) => {
          const color = colorForLabel(label);
          const buckets = bucketByDate(series);
          return Array.from(buckets.entries()).map(([day, bucketSeries]) => {
            const repeatValues = bucketSeries
              .map((item) => (Number.isFinite(item.repeatLength) ? Number(item.repeatLength) : null))
              .filter((val) => val !== null);
            const avg =
              repeatValues.length > 0
                ? repeatValues.reduce((sum, val) => sum + val, 0) / repeatValues.length
                : null;
            const tsMid = bucketSeries[Math.floor(bucketSeries.length / 2)].time;
          return {
            type: "scatter",
            mode: "markers",
            name: `${label} (${day})`,
            x: [tsMid],
            y: [avg],
            marker: { size: 10, color },
            hovertemplate: `Reel: ${label}<br>Date: ${day}<br>Avg Repeat Length: %{y}<extra></extra>`,
            showlegend: false,
            customdata: [
              {
                reel: label,
                reel_id: series && series.length ? series[0].reel_id : null,
                time: tsMid,
                order_number:
                  (series &&
                    series.length &&
                    (series[0].order_number || series[0].order)) ||
                  "",
              },
            ],
          };
        });
        });

        const avgValues = avgTraces
          .map((trace) => (trace && Array.isArray(trace.y) ? trace.y[0] : null))
          .filter((val) => Number.isFinite(val));
        const avgRange = paddedRange(avgValues);

        const avgPlotEl = document.getElementById("overviewRlmAvgTrend");

        Plotly.react(
          avgContainer,
          avgTraces,
          withResponsiveLayout({
            title: "Average Repeat Length by Reel",
            xaxis: {
              title: "Time",
              type: "date",
              range: xRange || undefined,
              autorange: xRange ? false : true,
            },
            yaxis: { title: "Repeat Length (in)", range: avgRange || undefined },
            showlegend: false,
            margin: { t: 60, l: 70, r: 20, b: 60 },
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
          }),
          plotlyConfig({ displayModeBar: false, showlegend: false })
        );

        if (avgPlotEl) {
          avgPlotEl.on("plotly_click", (eventData) => {
            if (!eventData || !eventData.points || !eventData.points.length) return;
            const point = eventData.points[0];
            const raw = point && point.customdata;
            const payload = Array.isArray(raw) ? raw[0] : raw || null;
            const reelCode = payload ? (payload.reel || payload.reel_code || payload.code || "") : "";
            const reelId = payload ? (payload.reel_id || payload.id || "") : "";
            if (!reelCode && !reelId) return;
            addReelFromPayload(reelCode, reelId, payload || {});
            Router.setActive("job");
            scrollToTopSoon();
          });
          avgPlotEl.style.cursor = "pointer";
        }
      }
    }

    function renderJobMetricCards(jobMetrics) {
      const configs = [
        {
          id: "overviewRefChangesByJob",
          title: "Reference Changes by Job",
          key: "reference_changes",
          color: "#6366f1",
          label: "Reference changes",
        },
        {
          id: "overviewRlmMonitorsByJob",
          title: "RLM Monitor Points by Job",
          key: "rlm_monitor_count",
          color: "#0ea5e9",
          label: "RLM monitors",
        },
        {
          id: "overviewDefectsByJob",
          title: "Defects by Job",
          key: "defect_count",
          label: "Defects",
          breakdownKey: "defect_breakdown",
          palette: ["#f97316", "#fb923c", "#fdba74", "#facc15", "#fde047", "#bef264"],
        },
        {
          id: "overviewMasksByJob",
          title: "Masks Applied by Job",
          key: "mask_count",
          label: "Masks applied",
          breakdownKey: "mask_breakdown",
          palette: ["#ec4899", "#f472b6", "#f9a8d4", "#d946ef", "#a855f7", "#c4b5fd"],
        },
      ];

      configs.forEach((config) => renderSingleJobMetricChart(jobMetrics, config));
    }

    function renderJobHeatmap(jobHeatmaps) {
      if (!heatmapContainer) return;

      const filters = Filters.getState();
      const activeJobRaw = (filters.job || "").trim();
      const activeOrderRaw = (filters.order || "").trim();
      if (!activeJobRaw && !activeOrderRaw) {
        heatmapState.jobs = [];
        heatmapState.selectedJob = "";
        heatmapContainer.innerHTML =
          `<div class="heatmap-wrapper heatmap-empty heatmap-notice"><span class='badge'>Select a job or order to view the heatmap.</span></div>`;
        return;


      }

      heatmapState.jobs = [];
      heatmapState.selectedJob = "";
      heatmapContainer.innerHTML =
        `<div class="heatmap-wrapper heatmap-empty heatmap-notice"><span class='badge'>Loading heatmap…</span></div>`;

      const activeDisplayJob = activeJobRaw || "Unassigned";
      const activeDisplayOrder = activeOrderRaw || null;
      const normalized = (jobHeatmaps || []).map((job) => ({
        job: job.job || "Unassigned",
        order: job.order || ORDER_NONE,
        format_width: job.format_width,
        format_length: job.format_length,
        defects: job.defects || [],
        reference_images: job.reference_images || [],
        reference_background: job.reference_background || null,
      }));

      const matches = normalized.filter((job) => {
        const jobMatch = job.job === activeDisplayJob || job.job.toLowerCase() === activeDisplayJob.toLowerCase();
        const orderMatch = activeDisplayOrder
          ? activeDisplayOrder === ORDER_NONE
            ? job.order === ORDER_NONE
            : (job.order || ORDER_NONE) === activeDisplayOrder
          : true;
        return jobMatch && orderMatch;
      });

      if (!matches.length) {
        heatmapState.jobs = [];
        heatmapState.selectedJob = activeDisplayJob;
        heatmapContainer.innerHTML =
          `<div class="heatmap-wrapper heatmap-empty heatmap-notice"><span class='badge'>No defect coordinates for ${activeDisplayJob}${activeDisplayOrder ? ` / ${activeDisplayOrder}` : ""} in this window.</span></div>`;
        return;
      }

      const selectedEntry = matches[0];

      heatmapState.jobs = matches;
      heatmapState.selectedJob = selectedEntry.job;

      const slug = slugifyJob(selectedEntry.job);
      heatmapContainer.innerHTML = `
        <div class="heatmap-flex">
          <div class="heatmap-gallery" id="heatmap-gallery-${slug}"></div>
          <div class="heatmap-stack">
            <div class="heatmap-wrapper heatmap-empty" id="heatmap-overview-${slug}"></div>
            <div class="heatmap-legend heatmap-legend-overview" id="heatmap-overview-${slug}-legend"></div>
          </div>
        </div>
      `;

      const references = Array.isArray(selectedEntry.reference_images) ? selectedEntry.reference_images : [];
      const localFirstRef = references.find((ref) => ref && ref.image_src);
      const backgroundSrc = selectedEntry.reference_background || (localFirstRef ? localFirstRef.image_src : null);
      const referenceBackground = backgroundSrc ? urlForStatic(backgroundSrc) : null;
      const jobDefects = Array.isArray(selectedEntry.defects) ? selectedEntry.defects : [];

      JobHeatmap.attach(heatmapContainer, {
        reel: {
          reel_id: `overview-${slug}`,
          format_width: selectedEntry.format_width,
          format_length: selectedEntry.format_length,
        },
        defects: jobDefects.map((defect, idx) => ({
          defect_id: defect.defect_id ?? null,
          reel_id: defect.reel_id ?? `overview-${slug}`,
          coords: defect.coords,
          magnitude_value: Number(defect.magnitude_value ?? 0),
          severity_value: Number(defect.severity_value ?? 0),
          defect_key: defect.defect_key || `${defect.reel_id ?? "overview"}-${defect.defect_id ?? idx}`,
        })),
        referenceBackground,
      });

      renderReferenceGallery(heatmapContainer.querySelector(`#heatmap-gallery-${slug}`), references || []);
    }

    function renderReferenceGallery(container, references) {
      if (!container) return;
      if (!references || !references.length) {
        container.innerHTML = "<div class=\"heatmap-reference-empty\">No reference images for this job.</div>";
        return;
      }
      container.innerHTML = references
        .slice(0, 6)
        .map((ref, idx) => {
          const src = urlForStatic(ref.image_src);
          const alt = (ref.filename || `Reference ${idx + 1}`).replace(/"/g, "&quot;");
          return `<img src="${src}" alt="${alt}" loading="lazy" decoding="async" onclick="showImageModal('${src}')">`;
        })
        .join("");
    }

    function slugifyJob(name) {
      return String(name || "unassigned")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "unassigned";
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

      const labels = sorted.map((item) => item.job || "Unassigned");
      const totals = sorted.map((item) => item[config.key] || 0);

      if (config.breakdownKey) {
        const breakdownData = buildStackedSeries(sorted, config.breakdownKey, totals, config.palette);
        Plotly.react(
          config.id,
          breakdownData.traces,
          {
            title: config.title,
            margin: { t: 90, l: 70, r: 30, b: 80 },
            height: 360,
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
          margin: { t: 70, l: 70, r: 30, b: 80 },
          height: 360,
          yaxis: { rangemode: "tozero", title: config.label },
          xaxis: { automargin: true },
        },
        { responsive: true, displayModeBar: false }
      );
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
