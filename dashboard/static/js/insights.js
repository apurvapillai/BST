(function () {
  const defaultState = () => ({
    machineId: "",
    start: null,
    end: null,
    mode: "job",
    primary: "",
    secondary: "",
    options: { jobs: [] },
  });

  function readCssVar(name) {
    return getComputedStyle(document.body).getPropertyValue(name).trim();
  }

  function getPlotlyTheme() {
    return {
      paper: readCssVar("--chart-paper-bg") || "#ffffff",
      plot: readCssVar("--chart-plot-bg") || "#f8fafc",
      font: readCssVar("--text-primary") || "#1f2937",
      grid: readCssVar("--chart-grid-color") || "rgba(148,163,184,0.4)",
      axis: readCssVar("--chart-axis-color") || "#94a3b8",
    };
  }

  function applyPlotlyTheme(layout = {}) {
    const theme = getPlotlyTheme();
    const themed = {
      ...layout,
      paper_bgcolor: theme.paper,
      plot_bgcolor: theme.plot,
      font: { ...(layout.font || {}), color: theme.font },
      hoverlabel: {
        ...(layout.hoverlabel || {}),
        bgcolor: theme.plot,
        font: { ...(layout.hoverlabel?.font || {}), color: theme.font },
      },
      legend: {
        ...(layout.legend || {}),
        font: { ...(layout.legend?.font || {}), color: theme.font },
      },
    };
    Object.keys(themed).forEach((key) => {
      if (/^[xy]axis\d*/.test(key)) {
        themed[key] = {
          ...themed[key],
          gridcolor: themed[key].gridcolor || theme.grid,
          zerolinecolor: themed[key].zerolinecolor || theme.grid,
          linecolor: themed[key].linecolor || theme.axis,
          tickfont: { ...(themed[key].tickfont || {}), color: theme.font },
        };
        if (themed[key].title) {
          themed[key] = {
            ...themed[key],
            title: {
              ...themed[key].title,
              font: { ...(themed[key].title.font || {}), color: theme.font },
            },
          };
        }
      }
    });
    return themed;
  }

  function refreshPlotlyTheme() {
    if (!window.Plotly) return;
    const theme = getPlotlyTheme();
    document.querySelectorAll(".js-plotly-plot").forEach((node) => {
      const layout = node.layout || {};
      const update = {
        paper_bgcolor: theme.paper,
        plot_bgcolor: theme.plot,
        "legend.font.color": theme.font,
        "hoverlabel.bgcolor": theme.plot,
        "hoverlabel.font.color": theme.font,
      };
      Object.keys(layout).forEach((key) => {
        if (/^[xy]axis\d*/.test(key)) {
          update[`${key}.gridcolor`] = theme.grid;
          update[`${key}.zerolinecolor`] = theme.grid;
          update[`${key}.linecolor`] = theme.axis;
          update[`${key}.tickfont.color`] = theme.font;
          if (layout[key]?.title) {
            update[`${key}.title.font.color`] = theme.font;
          }
        }
      });
      window.Plotly.relayout(node, update);
    });
  }

  window.addEventListener("bst:themechange", refreshPlotlyTheme);

  function ensurePlotlyPatched() {
    if (!window.Plotly || window.Plotly.__bstThemed) return;
    const originalReact = window.Plotly.react;
    const originalNewPlot = window.Plotly.newPlot;
    window.Plotly.react = function patchedReact(gd, data, layout, config) {
      return originalReact.call(this, gd, data, layout ? applyPlotlyTheme(layout) : layout, config);
    };
    window.Plotly.newPlot = function patchedNewPlot(gd, data, layout, config) {
      return originalNewPlot.call(this, gd, data, layout ? applyPlotlyTheme(layout) : layout, config);
    };
    window.Plotly.__bstThemed = true;
  }

  if (window.Plotly) {
    ensurePlotlyPatched();
  } else {
    window.addEventListener("load", ensurePlotlyPatched, { once: true });
  }

  const InsightsPage = (() => {
    let state = defaultState();
    let elements = {};
    let optionsInitialized = false;
    let topOrder = [];

    function init() {
      cacheDom();
      if (!elements.root) return;
      hydrateFromGlobalFilters();
      hydrateSelectors();
      bindEvents();
      fetchFilters().then(() => {
        hydrateSelectors();
      });
    }

    function cacheDom() {
      elements.root = document.getElementById("insightsApp");
      if (!elements.root) return;
      elements.start = document.getElementById("insightsStart");
      elements.end = document.getElementById("insightsEnd");
      elements.primary = document.getElementById("insightsPrimary");
      elements.secondary = document.getElementById("insightsSecondary");
      elements.machine = document.getElementById("insightsMachine");
      elements.apply = document.getElementById("insightsApply");
      elements.clear = document.getElementById("insightsClear");
      elements.rangeLabel = document.getElementById("insightsRangeLabel");
      elements.chips = document.getElementById("insightsFilterChips");
      elements.summary = document.getElementById("insightsSummary");
      elements.topDefects = document.getElementById("insightsTopDefects");
      elements.trendChart = document.getElementById("insightsTrendChart");
      elements.mixChart = document.getElementById("insightsMixChart");
      elements.typeBars = document.getElementById("insightsTypeBars");
      elements.overlayTrend = document.getElementById("insightsOverlayTrend");
      elements.severityCompare = document.getElementById("insightsSeverityCompare");
      elements.positionHist = document.getElementById("insightsPositionHist");
      elements.cumulativeChart = document.getElementById("insightsCumulativeChart");
      elements.cumulativeByType = document.getElementById("insightsCumulativeByType");
    }

    function bindEvents() {
      if (elements.apply) {
        elements.apply.addEventListener("click", handleApply);
      }
      if (elements.clear) {
        elements.clear.addEventListener("click", handleApply);
      }
      if (elements.machine) {
        elements.machine.addEventListener("change", () => {
          state.machineId = elements.machine.value || "";
          persistGlobalFilters();
          renderFilterChips();
        });
      }
    }

    function hydrateFromGlobalFilters() {
      const pad = (n) => String(n).padStart(2, "0");
      const toLocalInput = (dt) => {
        if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) return "";
        return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(
          dt.getMinutes()
        )}`;
      };
      const filters = window.FilterState && typeof window.FilterState.getFilters === "function" ? window.FilterState.getFilters() : {};
      const defaultEnd = new Date();
      const defaultStart = new Date(defaultEnd.getTime() - 7 * 24 * 60 * 60 * 1000);
      state.machineId = filters.machine_id ? String(filters.machine_id) : (elements.machine ? elements.machine.value : "");
      if (elements.machine && state.machineId) {
        elements.machine.value = state.machineId;
      }
      const startValue = filters.start ? filters.start : toLocalInput(defaultStart);
      const endValue = filters.end ? filters.end : toLocalInput(defaultEnd);
      state.start = startValue;
      state.end = endValue;
      if (elements.start) elements.start.value = startValue;
      if (elements.end) elements.end.value = endValue;
      renderFilterChips();
    }

    function hydrateSelectors() {
      const options = state.options.jobs || [];
      const prevPrimary = state.primary || (elements.primary ? elements.primary.value : "");
      const prevSecondary = state.secondary || (elements.secondary ? elements.secondary.value : "");
      [elements.primary, elements.secondary].forEach((select) => {
        if (!select) return;
        select.innerHTML = options.map((opt) => `<option value="${opt}">${opt}</option>`).join("");
        if (prevPrimary && select === elements.primary && options.includes(prevPrimary)) {
          select.value = prevPrimary;
        } else if (prevSecondary && select === elements.secondary && options.includes(prevSecondary)) {
          select.value = prevSecondary;
        } else if (!select.value && options.length) {
          select.value = select === elements.primary ? options[0] : options[1] || options[0];
        }
      });
      if (!optionsInitialized && options.length) {
        if (elements.primary) elements.primary.value = options[0];
        if (elements.secondary && options.length > 1) elements.secondary.value = options[1];
        optionsInitialized = true;
      }
    }

    function readState() {
      state.start = elements.start ? elements.start.value : null;
      state.end = elements.end ? elements.end.value : null;
      state.primary = elements.primary ? elements.primary.value : "";
      state.secondary = elements.secondary ? elements.secondary.value : "";
      state.machineId = elements.machine ? elements.machine.value : "";
      persistGlobalFilters();
      renderFilterChips();
    }

    async function fetchFilters() {
      if (!elements.start || !elements.end) return;
      const params = new URLSearchParams();
      if (elements.start.value) params.append("start", elements.start.value);
      if (elements.end.value) params.append("end", elements.end.value);
      if (state.machineId) params.append("machine_id", state.machineId);
      try {
        const data = await apiGet(`/api/insights/filters?${params.toString()}`);
        state.options = {
          jobs: data.jobs || [],
        };
        hydrateSelectors();
      } catch (err) {
        console.error("Failed to load insights filters", err);
      }
    }

    async function refresh() {
      if (!elements.root) return;
      readState();
      const params = {
        start: state.start,
        end: state.end,
        machine_id: state.machineId,
        mode: "job",
        primary: state.primary,
        secondary: state.secondary,
      };
      const query = new URLSearchParams();
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== "") query.append(k, v);
      });

      try {
        showLoading();
        const [summary, trend, comparison, maps] = await Promise.all([
          apiGet(`/api/insights/summary?${query.toString()}`),
          apiGet(`/api/insights/trend?${query.toString()}`),
          apiGet(`/api/insights/comparison?${query.toString()}`),
          apiGet(`/api/insights/maps?${query.toString()}`),
        ]);
        renderSummary(summary);
        renderTrend(trend);
        renderCumulative(trend);
        renderCumulativeByType(trend);
        renderComparison(comparison);
        renderSeverityPosition(maps);
        renderRangeLabel();
      } catch (err) {
        console.error("Insights fetch failed", err);
      } finally {
        hideLoading();
      }
    }

    function handleApply() {
      readState();
      fetchFilters().then(() => {
        hydrateSelectors();
        refresh();
      });
    }

    function persistGlobalFilters() {
      if (!window.FilterState || typeof window.FilterState.update !== "function") return;
      window.FilterState.update({
        machine_id: state.machineId || "",
        start: state.start || "",
        end: state.end || "",
      });
    }

    function renderFilterChips() {
      if (!elements.chips) return;
      const chips = [];
      if (elements.machine && elements.machine.options && elements.machine.selectedIndex >= 0) {
        const option = elements.machine.options[elements.machine.selectedIndex];
        const machineLabel = option ? option.textContent.trim() : "Machine";
        chips.push(`<span class="filter-chip machine"><span>Machine: ${machineLabel}</span></span>`);
      }
      if (state.start) {
        chips.push(`<span class="filter-chip"><span>Start: ${new Date(state.start).toLocaleString()}</span></span>`);
      }
      if (state.end) {
        chips.push(`<span class="filter-chip"><span>End: ${new Date(state.end).toLocaleString()}</span></span>`);
      }
      if (!chips.length) {
        elements.chips.classList.add("hidden");
        elements.chips.innerHTML = "";
        return;
      }
      elements.chips.classList.remove("hidden");
      elements.chips.innerHTML = chips.join("");
    }

    function renderRangeLabel() {
      if (!elements.rangeLabel) return;
      const start = state.start ? new Date(state.start) : null;
      const end = state.end ? new Date(state.end) : null;
      const label = start && end ? `${start.toLocaleString()} -> ${end.toLocaleString()}` : "Custom range";
      elements.rangeLabel.textContent = label;
    }

    function renderSummary(data) {
      if (!elements.summary) return;
      const cards = [
        {
          label: "Total Defects",
          value: data.totalDefects,
          delta: data.defectDelta,
          secondary: data.secondary ? data.secondary.totalDefects : null,
          deltaValue:
            data.secondary && data.secondary.totalDefects !== undefined && data.secondary.totalDefects !== null
              ? data.totalDefects - data.secondary.totalDefects
              : null,
        },
        {
          label: "Total Meters",
          value: data.totalMeters,
          delta: data.meterDelta,
          suffix: "m",
          secondary: data.secondary ? data.secondary.totalMeters : null,
          deltaValue:
            data.secondary && data.secondary.totalMeters !== undefined && data.secondary.totalMeters !== null
              ? data.totalMeters - data.secondary.totalMeters
              : null,
        },
        {
          label: "Defects / 1000m",
          value: data.defectsPerKm,
          delta: data.rateDelta,
          secondary: data.secondary ? data.secondary.defectsPerKm : null,
          deltaValue:
            data.secondary && data.secondary.defectsPerKm !== undefined && data.secondary.defectsPerKm !== null
              ? data.defectsPerKm - data.secondary.defectsPerKm
              : null,
        },
      ];
      elements.summary.innerHTML = cards
        .map(
          (card) => `
          <div class="insights-kpi-card">
            <h4>${card.label}</h4>
            <strong>${formatNumber(card.value)}</strong>
            <div class="delta ${card.delta >= 0 ? "up" : "down"}">${formatDelta(card.delta)}</div>
            ${
              card.secondary !== null && card.secondary !== undefined
                ? `<div class="secondary-note">Comparison: ${formatNumber(card.secondary)}${
                    card.suffix ? " " + card.suffix : ""
                  }${
                    card.deltaValue !== null && card.deltaValue !== undefined
                      ? `<span class="delta-amount"> (Δ ${formatNumber(card.deltaValue)})</span>`
                      : ""
                  }</div>`
                : ""
            }
          </div>
        `
        )
        .join("");

      if (elements.topDefects) {
        topOrder = [];
        const secondaryMap = {};
        (data.secondaryTopDefects || []).forEach((entry) => {
          secondaryMap[entry.type] = entry.count;
        });
        elements.topDefects.innerHTML = (data.topDefects || [])
          .map((entry) => {
            topOrder.push(entry.type);
            const secondaryVal = secondaryMap[entry.type];
            const deltaVal =
              secondaryVal !== undefined && secondaryVal !== null ? entry.count - secondaryVal : null;
            const deltaPct =
              secondaryVal !== undefined && secondaryVal !== null && secondaryVal !== 0
                ? ((entry.count - secondaryVal) / secondaryVal) * 100
                : null;
            const deltaClass = deltaPct !== null && deltaPct < 0 ? "down" : "up";
            return `
              <div class="insights-kpi-card">
                <h4>${entry.type || "Defect"}</h4>
                <strong>${formatNumber(entry.count)}</strong>
                ${
                  deltaPct !== null
                    ? `<div class="delta ${deltaClass}">${formatDelta(deltaPct)}</div>
                       <div class="secondary-note">Comparison: ${formatNumber(secondaryVal)}${
                        deltaVal !== null ? `<span class="delta-amount"> (Δ ${formatNumber(deltaVal)})</span>` : ""
                      }</div>`
                    : ""
                }
              </div>
            `;
          })
          .join("");
      }
    }

    function renderTrend(data) {
      if (!elements.trendChart || !window.Plotly) return;
      const traces = data.series.map((series) => ({
        x: series.points.map((p) => p.meter),
        y: series.points.map((p) => p.count),
        type: "scatter",
        mode: "lines+markers",
        name: series.label,
        line: { shape: "spline" },
      }));
      const layout = {
        margin: { t: 20, r: 10, l: 40, b: 30 },
        legend: { orientation: "h" },
        xaxis: { title: "Meters" },
        yaxis: { title: "Defects" },
        shapes: [],
      };
      Plotly.react(elements.trendChart, traces, layout, { displayModeBar: false, responsive: true });
    }

    function renderCumulative(trendData) {
      if (!elements.cumulativeChart || !window.Plotly || !trendData || !trendData.series) return;
      const traces = trendData.series.map((series) => {
        const cumulative = Array.isArray(series.cumulative) ? series.cumulative : [];
        const xs = cumulative.map((p) => p.meter);
        const ys = cumulative.map((p) => p.total);
        return {
          x: xs,
          y: ys,
          type: "scatter",
          mode: "lines+markers",
          name: `${series.label} (cumulative)`,
        };
      });
      Plotly.react(
        elements.cumulativeChart,
        traces,
        {
          margin: { t: 20, r: 10, l: 40, b: 30 },
          xaxis: { title: "Meters" },
          yaxis: { title: "Cumulative Defects" },
          legend: { orientation: "h" },
        },
        { displayModeBar: false, responsive: true }
      );
    }

    function renderCumulativeByType(trendData) {
      if (!elements.cumulativeByType || !window.Plotly || !trendData || !trendData.series) return;
      const container = elements.cumulativeByType;
      container.innerHTML = "";

      const primaryTypes = [];
      const comparisonTypes = [];

      trendData.series.forEach((series) => {
        const cumulativeTypes = Array.isArray(series.cumulative_by_type) ? series.cumulative_by_type : [];
        cumulativeTypes.forEach((entry) => {
          const spec = {
            type: entry.type || "",
            x: (entry.points || []).map((p) => p.meter),
            y: (entry.points || []).map((p) => p.total),
            label: series.label,
          };
          if ((series.label || "").toLowerCase().includes("primary")) {
            primaryTypes.push(spec);
          } else {
            comparisonTypes.push(spec);
          }
        });
      });

      if (!primaryTypes.length && !comparisonTypes.length) {
        container.innerHTML = "<span class='badge'>No defect type data</span>";
        return;
      }

      const order = topOrder.length
        ? topOrder
        : Array.from(new Set([...primaryTypes, ...comparisonTypes].map((s) => s.type)));

      order.forEach((type, idx) => {
        const primarySpec = primaryTypes.find((s) => s.type === type);
        const comparisonSpec = comparisonTypes.find((s) => s.type === type);

        if (!primarySpec && !comparisonSpec) return;

        const wrapper = document.createElement("div");
        wrapper.className = "chart-with-title chart-card";
        const title = document.createElement("h4");
        title.textContent = type || `Type ${idx + 1}`;
        wrapper.appendChild(title);
        const chartDiv = document.createElement("div");
        chartDiv.className = "insights-chart";
        chartDiv.id = `cumulative-type-${idx}`;
        wrapper.appendChild(chartDiv);
        container.appendChild(wrapper);

        const traces = [];
        if (primarySpec) {
          traces.push({
            x: primarySpec.x,
            y: primarySpec.y,
            type: "scatter",
            mode: "lines",
            name: "Primary",
          });
        }
        if (comparisonSpec) {
          traces.push({
            x: comparisonSpec.x,
            y: comparisonSpec.y,
            type: "scatter",
            mode: "lines",
            name: "Comparison",
          });
        }

        Plotly.react(
          chartDiv,
          traces,
          {
            margin: { t: 16, r: 6, l: 46, b: 30 },
            xaxis: {
              title: "Meters",
              automargin: false,
              tickfont: { size: 10 },
              titlefont: { size: 11 },
            },
            yaxis: {
              title: "Cumulative Defects",
              automargin: false,
              tickfont: { size: 10 },
              titlefont: { size: 11 },
            },
            legend: { orientation: "h", y: -0.25 },
          },
          { displayModeBar: false, responsive: true }
        );
      });
    }

    function renderComparison(data) {
      if (elements.mixChart && window.Plotly) {
        Plotly.react(
          elements.mixChart,
          [
            {
              labels: data.mix.labels,
              values: data.mix.primary,
              type: "pie",
              hole: 0.35,
              name: "Primary",
            },
            {
              labels: data.mix.labels,
              values: data.mix.secondary,
              type: "pie",
              hole: 0.35,
              name: "Comparison",
              domain: { x: [0.5, 1.0] },
            },
          ],
          {
            margin: { t: 10, b: 10, l: 10, r: 10 },
            grid: { rows: 1, columns: 2 },
            showlegend: false,
          },
          { displayModeBar: false, responsive: true }
        );
      }

      if (elements.typeBars && window.Plotly) {
        Plotly.react(
          elements.typeBars,
          [
            { x: data.types.labels, y: data.types.primary, type: "bar", name: "Primary" },
            { x: data.types.labels, y: data.types.secondary, type: "bar", name: "Comparison" },
          ],
          { barmode: "group", margin: { t: 10, l: 40, r: 10, b: 40 } },
          { displayModeBar: false, responsive: true }
        );
      }

      if (elements.overlayTrend && window.Plotly) {
        const traces = data.overlay.map((series) => ({
          x: series.points.map((p) => p.time),
          y: series.points.map((p) => p.count),
          mode: "lines+markers",
          type: "scatter",
          name: series.label,
        }));
        Plotly.react(
          elements.overlayTrend,
          traces,
          { margin: { t: 10, l: 40, r: 10, b: 30 }, legend: { orientation: "h" } },
          { displayModeBar: false, responsive: true }
        );
      }
    }

    function renderSeverityPosition(data) {
      if (elements.severityCompare && window.Plotly) {
        Plotly.react(
          elements.severityCompare,
          [
            { x: data.severity.bins, y: data.severity.primary, type: "bar", name: "Primary" },
            { x: data.severity.bins, y: data.severity.secondary, type: "bar", name: "Comparison" },
          ],
          { barmode: "group", margin: { t: 10, l: 40, r: 10, b: 40 }, legend: { orientation: "h" } },
          { displayModeBar: false, responsive: true }
        );
      }
      if (elements.positionHist && window.Plotly) {
        Plotly.react(
          elements.positionHist,
          [
            { x: data.positions.primary || [], type: "histogram", name: "Primary", opacity: 0.6 },
            { x: data.positions.secondary || [], type: "histogram", name: "Comparison", opacity: 0.6 },
          ],
          {
            barmode: "overlay",
            margin: { t: 10, l: 40, r: 10, b: 40 },
            xaxis: { title: "Format Position" },
            yaxis: { title: "Defects" },
            legend: { orientation: "h" },
          },
          { displayModeBar: false, responsive: true }
        );
      }
    }

    async function apiGet(url) {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || res.statusText);
      }
      return res.json();
    }

    function formatNumber(value, digits = 1) {
      if (value === null || value === undefined) return "--";
      return Number(value).toLocaleString(undefined, {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
    }

    function formatDelta(delta) {
      const num = Number(delta);
      if (!Number.isFinite(num)) return "--";
      const arrow = num > 0 ? "↑" : num < 0 ? "↓" : "→";
      return `${arrow} ${Math.abs(num).toFixed(1)}%`;
    }

    function showLoading() {
      const el = document.getElementById("insightsLoading");
      if (el) el.classList.remove("hidden");
    }
    function hideLoading() {
      const el = document.getElementById("insightsLoading");
      if (el) el.classList.add("hidden");
    }

    return { init };
  })();

  document.addEventListener("DOMContentLoaded", () => {
    InsightsPage.init();
  });
})();
