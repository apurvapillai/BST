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
    const chart = mode === "all" ? renderStackedTrend(series) : renderSingleTrend(series);
    return `
      <article class="rlm-intel-trend-card">
        <div class="rlm-intel-trend-card__chart">
          <div class="rlm-intel-trend-card__header">
            <h3>${escapeHtml(category.title || "Trend")}</h3>
            <span>${escapeHtml(category.unit || "")}</span>
          </div>
          ${chart}
        </div>
        <aside class="rlm-intel-trend-card__note">
          <strong>${escapeHtml(summary.headline || "No trend summary")}</strong>
          <p>${escapeHtml(summary.detail || category.description || "")}</p>
        </aside>
      </article>
    `;
  }

  function renderSingleTrend(series) {
    const clean = series.filter((point) => point.value !== null && point.value !== undefined);
    if (!clean.length) return '<div class="rlm-intel-empty">No daily values.</div>';
    const maxValue = Math.max(...clean.map((point) => Math.abs(Number(point.value) || 0)), 0.001);
    return `
      <div class="rlm-intel-mini-bars" style="--points:${clean.length}">
        ${clean
          .map((point) => {
            const height = Math.max((Math.abs(Number(point.value) || 0) / maxValue) * 100, 3);
            return `
              <div class="rlm-intel-mini-bar-point" title="${escapeAttribute(`${formatDateLabel(point.date)}: ${point.valueDisplay || "--"}`)}">
                <span class="rlm-intel-mini-bar" style="height:${height}%"></span>
                <small>${escapeHtml(formatDateLabel(point.date))}</small>
                <strong>${escapeHtml(point.valueDisplay || "--")}</strong>
              </div>
            `;
          })
          .join("")}
      </div>
    `;
  }

  function renderStackedTrend(series) {
    const clean = series.filter((point) => point.value !== null && point.value !== undefined);
    if (!clean.length) return '<div class="rlm-intel-empty">No daily values.</div>';
    const maxTotal = Math.max(...clean.map((point) => Math.abs(Number(point.value) || 0)), 0.001);
    return `
      <div class="rlm-intel-mini-bars rlm-intel-mini-bars--stacked" style="--points:${clean.length}">
        ${clean
          .map((point) => {
            const totalHeight = Math.max((Math.abs(Number(point.value) || 0) / maxTotal) * 100, 3);
            const segments = point.segments || [];
            const segmentTotal = segments.reduce((sum, item) => sum + Math.abs(Number(item.value) || 0), 0) || 1;
            return `
              <div class="rlm-intel-mini-bar-point" title="${escapeAttribute(`${formatDateLabel(point.date)}: ${point.valueDisplay || "--"}`)}">
                <span class="rlm-intel-mini-bar rlm-intel-mini-bar--stack" style="height:${totalHeight}%">
                  ${segments
                    .map((segment, index) => {
                      const segmentHeight = Math.max((Math.abs(Number(segment.value) || 0) / segmentTotal) * 100, 2);
                      return `<i style="height:${segmentHeight}%; --segment:${index % 10}" title="${escapeAttribute(`${segment.machineName}: ${segment.valueDisplay}`)}"></i>`;
                    })
                    .join("")}
                </span>
                <small>${escapeHtml(formatDateLabel(point.date))}</small>
                <strong>${escapeHtml(point.valueDisplay || "--")}</strong>
              </div>
            `;
          })
          .join("")}
      </div>
    `;
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
