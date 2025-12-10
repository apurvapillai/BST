(function () {
  const defaultState = () => ({
    start: null,
    end: null,
    mode: "job",
    primary: "",
    secondary: "",
    options: { jobs: [] },
  });

  const InsightsPage = (() => {
    let state = defaultState();
    let elements = {};
    let optionsInitialized = false;
    let topOrder = [];

    function init() {
      cacheDom();
      if (!elements.root) return;
      if (elements.mode) {
        elements.mode.value = "job";
      }
      setDefaultDates();
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
      elements.apply = document.getElementById("insightsApply");
      elements.rangeLabel = document.getElementById("insightsRangeLabel");
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
        elements.apply.addEventListener("click", () => {
          readState();
          fetchFilters().then(() => {
            hydrateSelectors();
            refresh();
          });
        });
      }
    }

    function setDefaultDates() {
      const now = new Date();
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const toLocalInput = (dt) => {
        const pad = (n) => String(n).padStart(2, "0");
        return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(
          dt.getMinutes()
        )}`;
      };
      if (elements.start) elements.start.value = toLocalInput(weekAgo);
      if (elements.end) elements.end.value = toLocalInput(now);
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
    }

    async function fetchFilters() {
      if (!elements.start || !elements.end) return;
      const params = new URLSearchParams();
      if (elements.start.value) params.append("start", elements.start.value);
      if (elements.end.value) params.append("end", elements.end.value);
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
