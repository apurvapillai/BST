(function () {
  const state = {
    data: null,
    loading: false,
    selectedTrendMachine: "all",
  };

  const els = {};

  function init() {
    cacheDom();
    bindEvents();
    loadPressIntelligence().catch((error) => {
      setStatus(`Load failed: ${error.message}`, "error");
    });
  }

  function cacheDom() {
    els.app = document.querySelector("[data-default-start]");
    els.start = document.getElementById("rlmIntelStart");
    els.end = document.getElementById("rlmIntelEnd");
    els.job = document.getElementById("rlmIntelJob");
    els.minFeet = document.getElementById("rlmIntelMinFeet");
    els.apply = document.getElementById("rlmIntelApply");
    els.status = document.getElementById("rlmIntelStatus");
    els.chips = document.getElementById("rlmIntelFilterChips");
    els.overviewRankings = document.getElementById("rlmIntelOverviewRankings");
    els.leaderboardsPanel = document.getElementById("rlmIntelLeaderboardsPanel");
    els.leaderboardsToggle = document.getElementById("rlmIntelLeaderboardsToggle");
    els.leaderboards = document.getElementById("rlmIntelLeaderboards");
    els.heatmap = document.getElementById("rlmIntelHeatmap");
    els.trendSelector = document.getElementById("rlmIntelTrendSelector");
    els.categoryTrends = document.getElementById("rlmIntelCategoryTrends");
  }

  function bindEvents() {
    if (els.apply) {
      els.apply.addEventListener("click", () => {
        reloadPressIntelligence();
      });
    }
    [els.start, els.end].forEach((input) => {
      if (!input) return;
      input.addEventListener("change", reloadPressIntelligence);
    });
    if (els.chips) {
      els.chips.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-chip]");
        if (!button) return;
        resetFilter(button.dataset.chip);
        renderFilterChips();
        reloadPressIntelligence();
      });
    }
    if (els.leaderboardsToggle) {
      els.leaderboardsToggle.addEventListener("click", toggleLeaderboards);
    }
    if (els.trendSelector) {
      els.trendSelector.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-trend-machine]");
        if (!button) return;
        state.selectedTrendMachine = button.dataset.trendMachine || "all";
        renderCategoryTrends(state.data?.categoryTrends || {});
      });
    }
  }

  function toggleLeaderboards() {
    if (!els.leaderboardsPanel || !els.leaderboardsToggle) return;
    const isCollapsed = els.leaderboardsPanel.classList.toggle("is-collapsed");
    els.leaderboardsToggle.textContent = isCollapsed ? "Expand" : "Collapse";
    els.leaderboardsToggle.setAttribute("aria-expanded", String(!isCollapsed));
  }

  function reloadPressIntelligence() {
    loadPressIntelligence().catch((error) => {
      setStatus(`Load failed: ${error.message}`, "error");
    });
  }

  async function loadPressIntelligence() {
    state.loading = true;
    setStatus("Loading press intelligence...", "info");
    const params = buildParams();
    const response = await fetch(`/rlm/api/press-intelligence?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`Request failed (${response.status})`);
    }
    state.data = await response.json();
    state.loading = false;
    renderAll();
    renderFilterChips();
    setStatus("Loaded.", "success");
  }

  function buildParams() {
    const params = new URLSearchParams();
    if (els.start && els.start.value) params.set("start_date", els.start.value);
    if (els.end && els.end.value) params.set("end_date", els.end.value);
    if (els.job && els.job.value.trim()) params.set("job", els.job.value.trim());
    if (els.minFeet && els.minFeet.value) params.set("min_feet", els.minFeet.value);
    return params;
  }

  function resetFilter(key) {
    if (key === "start" && els.start) {
      els.start.value = els.app?.dataset.defaultStart || "";
    } else if (key === "end" && els.end) {
      els.end.value = els.app?.dataset.defaultEnd || "";
    } else if (key === "job" && els.job) {
      els.job.value = "";
    } else if (key === "minFeet" && els.minFeet) {
      els.minFeet.value = "";
    }
  }

  function renderFilterChips() {
    if (!els.chips) return;
    const chips = [];
    const defaultStart = els.app?.dataset.defaultStart || "";
    const defaultEnd = els.app?.dataset.defaultEnd || "";
    const startValue = els.start?.value || "";
    const endValue = els.end?.value || "";
    const jobValue = (els.job?.value || "").trim();
    const minFeetValue = els.minFeet?.value || "";

    if (startValue && startValue !== defaultStart) {
      chips.push({ key: "start", label: `Start: ${formatDateLabel(startValue)}` });
    }
    if (endValue && endValue !== defaultEnd) {
      chips.push({ key: "end", label: `End: ${formatDateLabel(endValue)}` });
    }
    if (jobValue) {
      chips.push({ key: "job", label: `Job: ${jobValue}` });
    }
    if (minFeetValue) {
      chips.push({ key: "minFeet", label: `Min feet: ${formatNumber(minFeetValue, 0)}` });
    }

    if (!chips.length) {
      els.chips.innerHTML = "";
      els.chips.classList.add("hidden");
      return;
    }
    els.chips.innerHTML = chips
      .map(
        (chip) => `
          <span class="filter-chip">
            <span>${escapeHtml(chip.label)}</span>
            <button type="button" data-chip="${escapeAttribute(chip.key)}" aria-label="Clear ${escapeHtml(chip.label)}">&times;</button>
          </span>
        `
      )
      .join("");
    els.chips.classList.remove("hidden");
  }

  function renderAll() {
    const data = state.data || {};
    renderOverviewRankings(data.overviewRankings || []);
    renderLeaderboards(data.categoryLeaderboards || []);
    renderHeatmap(data.heatmap || {});
    renderCategoryTrends(data.categoryTrends || {});
  }

  function renderOverviewRankings(rows) {
    if (!els.overviewRankings) return;
    if (!rows.length) {
      els.overviewRankings.innerHTML = '<div class="rlm-intel-empty">No overall ranking data for this window.</div>';
      return;
    }
    const totalRows = rows.length;
    els.overviewRankings.innerHTML = rows
      .map(
        (row) => {
          const rank = Number(row.rank) || 0;
          const rankClass = rank === 1 ? " rlm-intel-overview-card--best" : rank === totalRows ? " rlm-intel-overview-card--worst" : "";
          const edgeClass = rank <= 2 ? " rlm-intel-overview-card--tooltip-left" : rank > totalRows - 2 ? " rlm-intel-overview-card--tooltip-right" : "";
          return `
          <article class="rlm-intel-overview-card${rankClass}${edgeClass}" tabindex="0">
            <span class="rlm-intel-overview-rank">${formatCount(row.rank)}</span>
            <strong>${escapeHtml(row.machineName || "Press")}</strong>
            <small>Avg category position ${formatNumber(row.averageCategoryPosition, 1)}</small>
            <div class="rlm-intel-overview-tooltip">
              <b>Category ranks</b>
              ${renderOverviewTooltipRows(row.categoryRanks || [])}
            </div>
          </article>
        `;
        }
      )
      .join("");
  }

  function renderOverviewTooltipRows(categoryRanks) {
    if (!categoryRanks.length) return '<span>No category rank details.</span>';
    return categoryRanks
      .map(
        (item) => `
          <span>
            <em>${escapeHtml(item.title || item.key || "Category")}</em>
            <strong>#${formatCount(item.bestOrientedRank || item.rank)}</strong>
          </span>
        `
      )
      .join("");
  }

  function renderLeaderboards(leaderboards) {
    if (!els.leaderboards) return;
    if (!leaderboards.length) {
      els.leaderboards.innerHTML = '<div class="rlm-intel-empty">No leaderboard data for this window.</div>';
      return;
    }
    els.leaderboards.innerHTML = leaderboards.map(renderLeaderboardCard).join("");
  }

  function renderLeaderboardCard(board) {
    const items = board.items || [];
    return `
      <article class="rlm-intel-leaderboard-card">
        <div class="rlm-intel-leaderboard-card__header">
          <div>
            <h3>${escapeHtml(board.title || "Leaderboard")}</h3>
          </div>
          <div class="rlm-intel-leaderboard-tools">
            <span class="rlm-intel-leaderboard-average">Avg ${escapeHtml(board.averageDisplay || "--")}</span>
            <span class="rlm-intel-info" tabindex="0" aria-label="${escapeAttribute(board.helpText || board.sortMeaning || "Leaderboard info")}" data-tooltip="${escapeAttribute(board.helpText || board.sortMeaning || "")}">i</span>
          </div>
        </div>
        <ol class="rlm-intel-leaderboard-list">
          ${items.map((item) => renderLeaderboardItem(item, items.length)).join("")}
        </ol>
      </article>
    `;
  }

  function renderLeaderboardItem(item, totalItems) {
    const rank = Number(item.rank) || 0;
    const rankClass = rank <= 3 ? ` rlm-intel-leaderboard-item--top-${rank}` : "";
    const bottomClass = rank > Math.max(totalItems - 3, 3) ? " rlm-intel-leaderboard-item--bottom" : "";
    const averageClass = item.averagePosition ? ` rlm-intel-leaderboard-item--${escapeAttr(item.averagePosition)}` : "";
    return `
      <li class="rlm-intel-leaderboard-item${rankClass}${bottomClass}${averageClass}">
        <span class="rlm-intel-leaderboard-rank">${formatCount(rank)}</span>
        <span class="rlm-intel-leaderboard-press">${escapeHtml(item.machineName || "Press")}</span>
        <strong>${escapeHtml(item.valueDisplay || "--")}</strong>
        <em>${escapeHtml(item.contextLabel || "")}</em>
      </li>
    `;
  }

  function renderHeatmap(heatmap) {
    if (!els.heatmap) return;
    const columns = heatmap.columns || [];
    const rows = heatmap.rows || [];
    if (!columns.length || !rows.length) {
      els.heatmap.innerHTML = '<div class="rlm-intel-empty">No heatmap data for this window.</div>';
      return;
    }
    const header = ['<div class="rlm-intel-heatmap-label rlm-intel-heatmap-label--corner">Press</div>']
      .concat(columns.map((column) => `<div class="rlm-intel-heatmap-label">${escapeHtml(column.label || column.key)}</div>`))
      .join("");
    const body = rows
      .map((row) => {
        const values = row.values || {};
        return [`<div class="rlm-intel-heatmap-label rlm-intel-heatmap-label--press">${escapeHtml(row.machineName)}</div>`]
          .concat(
            columns.map((column) => {
              const key = column.key || column;
              const value = Math.max(0, Math.min(Number(values[key]) || 0, 1));
              const risk = riskLabel(value).toLowerCase();
              return `<div class="rlm-intel-heatmap-tile rlm-intel-heatmap-tile--${risk}" title="${escapeAttribute(`${row.machineName} ${column.label || key}: ${riskLabel(value)}`)}"></div>`;
            })
          )
          .join("");
      })
      .join("");
    els.heatmap.innerHTML = `<div class="rlm-intel-heatmap-grid" style="--columns:${columns.length + 1}">${header}${body}</div>`;
  }

  function renderCategoryTrends(trends) {
    if (!els.categoryTrends || !els.trendSelector) return;
    const categories = trends.categories || [];
    const presses = trends.presses || [];
    if (!categories.length) {
      els.trendSelector.innerHTML = "";
      els.categoryTrends.innerHTML = '<div class="rlm-intel-empty">No trend data for this window.</div>';
      return;
    }
    const selectedExists = state.selectedTrendMachine === "all" || presses.some((press) => String(press.machineId) === String(state.selectedTrendMachine));
    if (!selectedExists) state.selectedTrendMachine = "all";
    els.trendSelector.innerHTML = `
      <div class="rlm-intel-trend-selector__label">Press view</div>
      <div class="rlm-intel-trend-buttons">
        <button type="button" data-trend-machine="all" class="${state.selectedTrendMachine === "all" ? "is-active" : ""}">All</button>
        ${presses
          .map(
            (press) => `
              <button type="button" data-trend-machine="${escapeAttribute(press.machineId)}" class="${String(state.selectedTrendMachine) === String(press.machineId) ? "is-active" : ""}">
                ${escapeHtml(press.machineName || "Press")}
              </button>
            `
          )
          .join("")}
      </div>
    `;

    const selectedData =
      state.selectedTrendMachine === "all"
        ? trends.all || {}
        : trends.byPress?.[String(state.selectedTrendMachine)] || {};
    const mode = state.selectedTrendMachine === "all" ? "all" : "press";
    els.categoryTrends.innerHTML = categories.map((category) => renderTrendCard(category, selectedData, mode)).join("");
  }

  function renderTrendCard(category, selectedData, mode) {
    const series = selectedData.series?.[category.key] || [];
    const summary = selectedData.summary?.[category.key] || {};
    const chart = renderTrendLine(series);
    return `
      <article class="rlm-intel-trend-card">
        <div class="rlm-intel-trend-card__chart">
          <div class="rlm-intel-trend-card__header">
            <div>
              <h3>${escapeHtml(category.title || "Trend")}</h3>
              <p>${escapeHtml(category.description || "")}</p>
            </div>
            <span>${escapeHtml(category.unit || "")}</span>
          </div>
          ${chart}
        </div>
        <aside class="rlm-intel-trend-card__note">
          <small>What it saw</small>
          <strong>${escapeHtml(summary.headline || "No trend summary")}</strong>
          <p>${escapeHtml(summary.detail || category.description || "")}</p>
        </aside>
      </article>
    `;
  }

  function renderTrendLine(series) {
    const clean = buildLastTenDailySeries(series || []);
    const plotted = clean.filter((point) => point.value !== null && point.value !== undefined);
    if (!plotted.length) return '<div class="rlm-intel-empty">No daily values.</div>';
    const values = plotted.map((point) => Number(point.value) || 0);
    const minValue = Math.min(...values, 0);
    const maxValue = Math.max(...values, 0.001);
    const avgValue = values.reduce((sum, value) => sum + value, 0) / values.length;
    const range = Math.max(maxValue - minValue, 0.001);
    const width = 1000;
    const height = 216;
    const padX = 28;
    const padTop = 20;
    const padBottom = 54;
    const plotHeight = height - padTop - padBottom;
    const step = clean.length > 1 ? (width - padX * 2) / (clean.length - 1) : 0;
    const coords = clean.map((point, index) => {
      const hasValue = point.value !== null && point.value !== undefined;
      const value = hasValue ? Number(point.value) || 0 : null;
      const x = clean.length > 1 ? padX + step * index : width / 2;
      const y = hasValue ? padTop + (1 - (value - minValue) / range) * plotHeight : null;
      return { point, value, x, y };
    });
    const path = buildTrendPath(coords);
    const hasMissing = coords.some((coord) => coord.value === null);
    const areaPath =
      !hasMissing && coords.length > 1
        ? `${path} L ${coords[coords.length - 1].x.toFixed(2)} ${height - padBottom} L ${coords[0].x.toFixed(2)} ${height - padBottom} Z`
        : "";
    const last = plotted[plotted.length - 1];
    const first = plotted[0];
    const delta = last.value - first.value;
    const deltaClass = Math.abs(delta) < 0.0001 ? "is-flat" : delta > 0 ? "is-up" : "is-down";
    const deltaLabel = Math.abs(delta) < 0.0001 ? "Flat" : delta > 0 ? "Higher" : "Lower";
    const firstLabel = formatShortDateLabel(first.date);
    const lastLabel = formatShortDateLabel(last.date);
    const latest = plotted[plotted.length - 1];
    const avgDisplay = formatCompactValue(avgValue, latest.valueDisplay);
    return `
      <div class="rlm-intel-trend-line">
        <div class="rlm-intel-trend-line__meta">
          <div>
            <span>Latest</span>
            <strong>${escapeHtml(latest.valueDisplay || "--")}</strong>
          </div>
          <div>
            <span>${plotted.length}/10 day avg</span>
            <strong>${escapeHtml(avgDisplay)}</strong>
          </div>
          <div>
            <span>${escapeHtml(firstLabel)} to ${escapeHtml(lastLabel)}</span>
            <strong class="${deltaClass}">${escapeHtml(deltaLabel)}</strong>
          </div>
        </div>
        <div class="rlm-intel-trend-line__viewport">
          <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Last ${clean.length} days trend">
            <text class="rlm-intel-trend-line__scale" x="${padX}" y="${padTop - 8}">${escapeHtml(formatCompactNumber(maxValue))}</text>
            <text class="rlm-intel-trend-line__scale" x="${padX}" y="${height - padBottom + 18}">${escapeHtml(formatCompactNumber(minValue))}</text>
            <line class="rlm-intel-trend-line__grid" x1="${padX}" y1="${padTop}" x2="${width - padX}" y2="${padTop}"></line>
            <line class="rlm-intel-trend-line__grid" x1="${padX}" y1="${padTop + plotHeight / 2}" x2="${width - padX}" y2="${padTop + plotHeight / 2}"></line>
            <line class="rlm-intel-trend-line__grid" x1="${padX}" y1="${height - padBottom}" x2="${width - padX}" y2="${height - padBottom}"></line>
            ${areaPath ? `<path class="rlm-intel-trend-line__area" d="${areaPath}"></path>` : ""}
            <path class="rlm-intel-trend-line__stroke" d="${path}"></path>
            ${coords
              .filter((coord) => coord.value !== null)
              .map(
                (coord) => `
                  <g class="rlm-intel-trend-line__point">
                    <circle cx="${coord.x.toFixed(2)}" cy="${coord.y.toFixed(2)}" r="4"></circle>
                    <title>${escapeHtml(`${formatDateLabel(coord.point.date)}: ${coord.point.valueDisplay || "--"}`)}</title>
                  </g>
                `
              )
              .join("")}
            ${coords
              .map((coord, index) => {
                const anchor = index === 0 ? "start" : index === coords.length - 1 ? "end" : "middle";
                return `
                  <text class="rlm-intel-trend-line__axis-date ${coord.value === null ? "is-missing" : ""}" x="${coord.x.toFixed(2)}" y="${height - 30}" text-anchor="${anchor}">
                    ${escapeHtml(formatShortDateLabel(coord.point.date))}
                  </text>
                  <text class="rlm-intel-trend-line__axis-value ${coord.value === null ? "is-missing" : ""}" x="${coord.x.toFixed(2)}" y="${height - 14}" text-anchor="${anchor}">
                    ${escapeHtml(coord.point.valueDisplay || "--")}
                  </text>
                `;
              })
              .join("")}
          </svg>
        </div>
      </div>
    `;
  }

  function buildLastTenDailySeries(series) {
    const dated = series
      .filter((point) => point.date && point.value !== null && point.value !== undefined)
      .slice()
      .sort((a, b) => dateKey(a.date).localeCompare(dateKey(b.date)));
    return dated.slice(-10);
  }

  function buildTrendPath(coords) {
    let isOpen = false;
    return coords
      .map((coord) => {
        if (coord.value === null || coord.y === null) {
          isOpen = false;
          return "";
        }
        const command = isOpen ? "L" : "M";
        isOpen = true;
        return `${command} ${coord.x.toFixed(2)} ${coord.y.toFixed(2)}`;
      })
      .filter(Boolean)
      .join(" ");
  }

  function dateKey(value) {
    return String(value || "").slice(0, 10);
  }

  function formatCompactValue(value, sampleDisplay) {
    const display = String(sampleDisplay || "");
    if (display.includes("%")) return `${formatNumber(value, 1)}%`;
    if (display.toLowerCase().includes("ft")) return `${formatCount(Math.round(value))} ft`;
    if (display.toLowerCase().includes("mm")) return `${formatNumber(value, 3)} mm`;
    return formatNumber(value, 1);
  }

  function formatCompactNumber(value) {
    const number = Number(value) || 0;
    if (Math.abs(number) >= 1000) return formatCount(Math.round(number));
    if (Math.abs(number) >= 10) return formatNumber(number, 1);
    return formatNumber(number, 2);
  }

  function setStatus(message, type) {
    if (!els.status) return;
    els.status.textContent = message || "";
    els.status.dataset.status = type || "info";
  }

  function formatNumber(value, digits = 1) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
    return Number(value).toLocaleString(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function formatCount(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "0";
    return Number(value).toLocaleString(undefined, { maximumFractionDigits: 0 });
  }

  function formatPct(value, digits = 1) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
    return `${formatNumber(value, digits)}%`;
  }

  function formatMm(value, digits = 3) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
    return `${formatNumber(value, digits)} mm`;
  }

  function formatCoverage(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
    return `${formatNumber(value, 1)} pts/1k ft`;
  }

  function formatDateLabel(value) {
    if (!value) return "--";
    const parts = String(value).split("-");
    if (parts.length === 3) return `${Number(parts[1])}/${Number(parts[2])}/${parts[0]}`;
    return String(value);
  }

  function formatShortDateLabel(value) {
    if (!value) return "--";
    const parts = String(value).split("-");
    if (parts.length === 3) return `${Number(parts[1])}/${Number(parts[2])}`;
    return String(value);
  }

  function riskLabel(value) {
    if (value >= 0.67) return "High";
    if (value >= 0.34) return "Medium";
    if (value > 0) return "Low";
    return "None";
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
    return escapeHtml(value).replace(/\s+/g, "-").toLowerCase();
  }

  function escapeAttribute(value) {
    return escapeHtml(value);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
