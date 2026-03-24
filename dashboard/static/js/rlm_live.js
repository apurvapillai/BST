const THRESHOLD_FIELDS = [
  { key: "enabled", label: "Enabled", column: "enabled", type: "checkbox", section: "general" },
  { key: "refreshSeconds", label: "Refresh seconds (machine override)", column: "refresh_seconds", type: "number", step: "1", section: "general" },
  { key: "staleAfterMinutes", label: "Stale after minutes", column: "stale_after_minutes", type: "number", step: "1", section: "general" },
  { key: "cyclePanelSeconds", label: "Focus cycle seconds", column: "cycle_panel_seconds", type: "number", step: "1", section: "general" },
  { key: "minQualifyingFeet", label: "Min qualifying feet", column: "min_qualifying_feet", type: "number", step: "10", section: "coverage" },
  { key: "minFeetForZeroMonitoring", label: "Min feet for zero monitoring alert", column: "min_feet_for_zero_monitoring", type: "number", step: "10", section: "coverage" },
  { key: "minPointsPer1000FtWarn", label: "Min pts / 1000ft (warn)", column: "min_points_per_1000_ft_warn", type: "number", step: "1", section: "coverage" },
  { key: "minPointsPer1000FtCritical", label: "Min pts / 1000ft (critical)", column: "min_points_per_1000_ft_critical", type: "number", step: "1", section: "coverage" },
  { key: "badReelWarnOobPct", label: "Bad reel warn OOB %", column: "bad_reel_warn_oob_pct", type: "number", step: "0.1", section: "oob" },
  { key: "badReelCriticalOobPct", label: "Bad reel critical OOB %", column: "bad_reel_critical_oob_pct", type: "number", step: "0.1", section: "oob" },
  { key: "rollingBadFeetWarnPct", label: "Rolling bad feet warn %", column: "rolling_bad_feet_warn_pct", type: "number", step: "0.1", section: "rolling" },
  { key: "rollingBadFeetCriticalPct", label: "Rolling bad feet critical %", column: "rolling_bad_feet_critical_pct", type: "number", step: "0.1", section: "rolling" },
  { key: "rollingOobWarnPct", label: "Rolling OOB warn %", column: "rolling_oob_warn_pct", type: "number", step: "0.1", section: "rolling" },
  { key: "rollingOobCriticalPct", label: "Rolling OOB critical %", column: "rolling_oob_critical_pct", type: "number", step: "0.1", section: "rolling" },
  { key: "consecutiveBadWarnCount", label: "Consecutive bad warn count", column: "consecutive_bad_warn_count", type: "number", step: "1", section: "delta" },
  { key: "consecutiveBadCriticalCount", label: "Consecutive bad critical count", column: "consecutive_bad_critical_count", type: "number", step: "1", section: "delta" },
  { key: "deltaStdWarn", label: "Delta std warn", column: "delta_std_warn", type: "number", step: "0.1", section: "delta" },
  { key: "deltaStdCritical", label: "Delta std critical", column: "delta_std_critical", type: "number", step: "0.1", section: "delta" },
  { key: "webspeedRangeWarn", label: "Webspeed range warn", column: "webspeed_range_warn", type: "number", step: "0.1", section: "delta" },
  { key: "webspeedRangeCritical", label: "Webspeed range critical", column: "webspeed_range_critical", type: "number", step: "0.1", section: "delta" },
];

const ALERT_CONFIG_DEFAULTS = [
  {
    alertType: "BAD_DELTA_REEL",
    group: "reel",
    displayName: "Bad Reel / Repeat Length",
    description: "Triggered when a reel's repeat length delta exceeds tolerances.",
  },
  {
    alertType: "ZERO_MONITORING",
    group: "monitoring",
    displayName: "Zero Monitoring",
    description: "Triggered when a qualifying reel has zero monitoring points.",
  },
  {
    alertType: "LOW_MONITORING_DENSITY",
    group: "monitoring",
    displayName: "Low Monitoring Density",
    description: "Triggered when monitoring density falls below warn/critical thresholds.",
  },
  {
    alertType: "ROLLING_BAD_FEET",
    group: "rolling",
    displayName: "Rolling Bad Feet %",
    description: "Triggered when rolling bad-feet percentage exceeds thresholds.",
  },
  {
    alertType: "ROLLING_OOB_POINTS",
    group: "rolling",
    displayName: "Rolling OOB %",
    description: "Triggered when rolling out-of-bounds percentage exceeds thresholds.",
  },
  {
    alertType: "ROLLING_DELTA_DEVIATION",
    group: "rolling",
    displayName: "Rolling Delta Deviation",
    description: "Triggered when rolling delta standard deviation is elevated.",
  },
  {
    alertType: "CONSECUTIVE_BAD_REELS",
    group: "sequence",
    displayName: "Consecutive Bad Reels",
    description: "Triggered when multiple bad reels occur consecutively on the same job.",
  },
  {
    alertType: "WEBSPEED_CONTRIBUTION",
    group: "process",
    displayName: "Webspeed Contribution",
    description: "Triggered when webspeed instability likely contributes to delta swings.",
  },
];

const WINDOW_LABELS = ["1h", "6h", "12h", "24h"];
const ALERT_DISPLAY_LIMIT = 30;
const STATE_LABELS = {
  healthy: "Healthy",
  info: "Info",
  warning: "Warning",
  critical: "Critical",
  idle: "Idle",
  stale: "Stale",
};
const ALERT_SEVERITY_ORDER = { critical: 3, warning: 2, info: 1, healthy: 0 };
const FOCUS_CHUNK_SIZE = 3;
const CENTRAL_TIMEZONE = "America/Chicago";
const ALERT_TYPE_LABELS = ALERT_CONFIG_DEFAULTS.reduce((acc, entry) => {
  acc[entry.alertType] = entry.displayName || entry.alertType.replace(/_/g, " ");
  return acc;
}, {});

const filterControls = {
  root: null,
  machine: null,
  start: null,
  end: null,
  severity: null,
  alertType: null,
  chips: null,
  applyButtons: [],
  clearButton: null,
};

const filters = {
  machineId: null,
  start: "",
  end: "",
  severity: "",
  alertType: "",
  defaults: {
    machineId: null,
    start: "",
    end: "",
  },
};

const state = {
  overview: null,
  refreshTimer: null,
  cycleTimer: null,
  focusItems: [],
  focusIndex: 0,
  focusSignature: "",
  history: [],
  windowDetails: null,
  historyMachineId: "all",
  thresholds: null,
  selectedThresholdMachine: null,
  isLoading: false,
  ackInFlight: null,
  thresholdSaving: false,
  selectedMachineId: null,
  selectedSeverity: null,
  selectedAlertType: null,
  filterStart: null,
  filterEnd: null,
  filterStartRaw: "",
  filterEndRaw: "",
  ackVisibleLoading: false,
  visibleAlertIds: [],
  refreshInProgress: false,
  alertConfig: null,
};

async function fetchJSON(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Request failed (${res.status})`);
  }
  if (res.status === 204) return {};
  return res.json();
}

function setLiveStatus(message, type = "info") {
  const el = document.getElementById("liveStatus");
  if (!el) return;
  el.textContent = message || "";
  el.className = `live-status ${type === "error" ? "error" : type === "success" ? "success" : ""}`;
}

async function loadOverview() {
  try {
    state.isLoading = true;
    if (!state.refreshInProgress) {
      setLiveStatus("Refreshing…", "info");
    }
    if (state.refreshTimer) {
      clearTimeout(state.refreshTimer);
      state.refreshTimer = null;
    }
    const data = await fetchJSON("/rlm/live/api/overview");
    state.overview = data;
    state.focusItems = data.focusPanel?.items || [];
    state.isLoading = false;
    renderAll();
    const refreshed = data.plantSummary?.lastUpdatedUtc
      ? new Date(data.plantSummary.lastUpdatedUtc).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : new Date().toLocaleTimeString();
    if (!state.refreshInProgress) {
      setLiveStatus(`Refreshed ${refreshed}`, "success");
    }
    scheduleRefresh();
    return data;
  } catch (err) {
    state.isLoading = false;
    setLiveStatus(`Refresh failed: ${err.message}`, "error");
    if (!state.refreshTimer) {
      state.refreshTimer = setTimeout(() => {
        state.refreshTimer = null;
        loadOverview().catch(() => {});
      }, 15000);
    }
    throw err;
  }
}

function scheduleRefresh() {
  if (state.refreshTimer) {
    clearTimeout(state.refreshTimer);
  }
  const seconds = state.overview?.systemConfig?.refreshSeconds || 30;
  state.refreshTimer = setTimeout(() => {
    state.refreshTimer = null;
    loadOverview().catch(() => {});
  }, Math.max(seconds, 5) * 1000);
}

function renderAll() {
  renderPlantSummary();
  renderMachineGrid();
  renderTrendSignals();
  renderActiveAlerts();
  renderWindowSummary();
  renderFocusPanel();
  renderAlertFilterStatus();
  startFocusCycle(state.overview?.focusPanel?.cycleSeconds || state.overview?.systemConfig?.cyclePanelSeconds || 8);
}

function renderPlantSummary() {
  const container = document.getElementById("plantSummary");
  const label = document.getElementById("lastUpdatedLabel");
  const summary = state.overview?.plantSummary;
  if (!summary) {
    container.innerHTML = state.isLoading
      ? '<div class="empty-state">Loading plant summary…</div>'
      : '<div class="empty-state">No plant summary available.</div>';
    if (label) label.textContent = "";
    return;
  }
  const lastUpdated = parseDate(summary.lastUpdatedUtc);
  const tiles = [
    { label: "Total presses", value: summary.totalPresses },
    { label: "Critical", value: summary.criticalPresses },
    { label: "Warning", value: summary.warningPresses },
    { label: "Healthy", value: summary.healthyPresses },
    { label: "Idle/Stale", value: summary.idleOrStalePresses },
    {
      label: "Last refresh",
      value: lastUpdated ? `${lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "—",
      subtext: lastUpdated ? formatRelativeAge(lastUpdated) : "",
    },
  ];
  container.innerHTML = tiles
    .map(tile => {
      const sub = tile.subtext ? `<small>${tile.subtext}</small>` : "";
      return `
        <div class="summary-card">
          <span>${tile.label}</span>
          <strong>${tile.value ?? 0}</strong>
          ${sub}
        </div>
      `;
    })
    .join("");
  if (label && lastUpdated) {
    label.textContent = `Refreshed ${lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  }
}

function renderMachineGrid() {
  const grid = document.getElementById("machineGrid");
  const cards = state.overview?.machineCards || [];
  const filteredCards = state.selectedMachineId ? cards.filter(card => card.machineId === state.selectedMachineId) : cards;
  if (!filteredCards.length) {
    const message = state.selectedMachineId
      ? "No machines match the current filters."
      : state.isLoading
        ? "Loading machines…"
        : "No machines found.";
    grid.innerHTML = `<div class="empty-state">${message}</div>`;
    return;
  }
  grid.innerHTML = filteredCards.map(card => renderMachineCard(card)).join("");
}

function renderMachineCard(card) {
  const latest = card.latestReel || {};
  const metrics = card.metrics || {};
  const counts = card.severityCounts || { info: 0, warning: 0, critical: 0 };
  const stateClass = card.status || "healthy";
  const stateLabel = card.stateLabel || formatStateLabel(stateClass);
  const webspeedSummary = formatWebspeed(metrics.avgWebspeed, metrics.webspeedRange);
  const nominalSummary = formatNominal(metrics.nominalValue, metrics.errShrink, metrics.errExpand);
  const isSelected = state.selectedMachineId === card.machineId;
  return `
    <div class="machine-card ${stateClass} ${isSelected ? "selected" : ""}" data-machine-id="${card.machineId}">
      <div class="machine-head">
        <div>
          <h3>${card.machineName}</h3>
          <p>${card.statusMessage || "Idle"}</p>
        </div>
        <div class="machine-meta">
          <span class="state-chip ${stateClass}">${stateLabel}</span>
          <div class="severity-badges">
            <span class="badge info" data-machine-id="${card.machineId}" data-machine-severity="info">i ${counts.info ?? 0}</span>
            <span class="badge warning" data-machine-id="${card.machineId}" data-machine-severity="warning">⚠ ${counts.warning ?? 0}</span>
            <span class="badge critical" data-machine-id="${card.machineId}" data-machine-severity="critical">✖ ${counts.critical ?? 0}</span>
          </div>
        </div>
      </div>
      <div class="machine-body">
        ${machineMetric("Job", latest.jobName || "—")}
        ${machineMetric("Reel", latest.reelId || "—")}
        ${machineMetric("Reel start", formatReelStart(latest))}
        ${machineMetric("Feet (bad/total)", formatFeet(metrics.feetBad, metrics.feetTotal))}
        ${machineMetric("Bad points / total", formatPoints(metrics.monitoringPointsBad, metrics.monitoringPointsTotal))}
        ${machineMetric("Bad feet %", formatPercent(metrics.badFeetPct))}
        ${machineMetric("Avg Δ", formatNumber(metrics.avgDelta, 3))}
        ${machineMetric("Δ std dev", formatNumber(metrics.deltaStd, 3))}
        ${machineMetric("Webspeed", webspeedSummary)}
        ${machineMetric("Nominal & err", nominalSummary)}
      </div>
    </div>
  `;
}

function machineMetric(label, value) {
  return `
    <div>
      <label>${label}</label>
      <strong>${value ?? "—"}</strong>
    </div>
  `;
}

function getAllAlerts() {
  return state.overview?.activeAlerts || [];
}

function getAlertTimestamp(alert) {
  if (!alert) return null;
  if (alert.triggeredAt) {
    const date = parseDate(alert.triggeredAt);
    if (date) return date;
  }
  if (alert.triggeredAtLocal) {
    const date = parseDate(alert.triggeredAtLocal);
    if (date) return date;
  }
  return null;
}

function alertMatchesFilters(alert) {
  if (!alert) return false;
  if (state.selectedMachineId && alert.machineId !== state.selectedMachineId) {
    return false;
  }
  if (state.selectedSeverity && alert.severity !== state.selectedSeverity) {
    return false;
  }
  if (state.selectedAlertType && alert.alertType !== state.selectedAlertType) {
    return false;
  }
  const ts = getAlertTimestamp(alert);
  if (state.filterStart && (!ts || ts < state.filterStart)) {
    return false;
  }
  if (state.filterEnd && (!ts || ts > state.filterEnd)) {
    return false;
  }
  return true;
}

function getFilteredAlertsList() {
  const alerts = getAllAlerts();
  if (!alerts.length) return [];
  return alerts.filter(alert => alertMatchesFilters(alert));
}

function renderActiveAlerts() {
  const container = document.getElementById("alertRail");
  const countLabel = document.getElementById("activeAlertCount");
  const allAlerts = getAllAlerts();
  const filtered = getFilteredAlertsList();
  const limit = ALERT_DISPLAY_LIMIT;
  const shouldLimit = filtered.length > limit;
  const visible = shouldLimit ? filtered.slice(0, limit) : filtered;
  state.visibleAlertIds = [];
  visible.forEach(alert => {
    (alert.alertIds || []).forEach(id => state.visibleAlertIds.push(id));
  });
  const filterSummary = getFilterSummaryText();
  const filterActive = Boolean(filterSummary);
  const total = allAlerts.length;
  const filteredCount = filtered.length;
  const visibleCount = visible.length;
  let header = "";
  if (!total) {
    header = "No active alerts";
  } else if (filterActive) {
    if (!filteredCount) {
      header = `No matching alerts (${total} total)`;
    } else if (shouldLimit) {
      header = `Showing ${visibleCount} of ${filteredCount} matching alerts (${total} total)`;
    } else {
      header = `Showing all ${filteredCount} matching alerts (${total} total)`;
    }
  } else if (shouldLimit) {
    header = `Showing ${visibleCount} of ${total} active alerts`;
  } else {
    header = `Showing all ${total} active alerts`;
  }
  if (countLabel) countLabel.textContent = header;
  const ackBtn = document.getElementById("ackVisibleBtn");
  if (!filteredCount) {
    const suffix = filterSummary ? `No active alerts match ${filterSummary}.` : "No active alerts.";
    container.innerHTML = `<div class="empty-state">${suffix}</div>`;
    if (ackBtn) ackBtn.disabled = true;
    return;
  }
  const busyTarget = state.ackInFlight ? Number(state.ackInFlight) : null;
  container.innerHTML = visible
    .map(alert => {
      const busy = busyTarget !== null && (alert.alertIds || []).includes(busyTarget);
      const severityLabel = formatStateLabel(alert.severity);
      const payload = alert.payload || {};
      const webspeedSummary = formatWebspeed(payload.avgWebspeed, payload.webspeedRange);
      const repeatNote = alert.repeatCount > 1 ? ` (+${alert.repeatCount - 1} related)` : "";
      const isRolling = ROLLING_ALERT_TYPES.has(alert.alertType);
      const alertTitle = `${isRolling ? "Rolling · " : ""}${(alert.alertType || "Alert").replace(/_/g, " ")}${repeatNote}`;
      const triggeredLabel = alert.triggeredAtLocal || formatTimeCentral(alert.triggeredAt);
      const triggeredDetail = alert.triggeredAtLocal || formatDateTimeCentral(alert.triggeredAt);
      return `
        <div class="alert-card ${alert.severity}">
          <div class="alert-card-head">
            <div>
              <strong>${alert.machineName}</strong>
              <p>${alertTitle}</p>
            </div>
            <div class="machine-meta">
              <span class="state-chip ${alert.severity}">${severityLabel}</span>
              <span>${triggeredLabel}</span>
            </div>
          </div>
          <div class="alert-message">${alert.message}</div>
          <div class="alert-meta-grid">
            <div><label>Job</label><strong>${alert.jobName || "—"}</strong></div>
            <div><label>Reel</label><strong>${alert.reelId || "—"}</strong></div>
            <div><label>Triggered</label><strong>${triggeredDetail}</strong></div>
          </div>
          ${isRolling ? renderRollingAlertMetrics(payload) : renderStandardAlertMetrics(payload, webspeedSummary)}
          ${isRolling ? '<p class="rolling-note">Warning based on recent reels, not current reel.</p>' : ""}
          <button class="ack-btn ${busy ? "loading" : ""}" data-alert-ids="${(alert.alertIds || []).join(",")}" ${busy ? "disabled" : ""}>
            ${busy ? "Acknowledging…" : "Acknowledge"}
          </button>
        </div>
      `;
    })
    .join("");
  if (ackBtn) ackBtn.disabled = state.ackVisibleLoading || visibleCount === 0;
}

function renderAlertFilterStatus() {
  const el = document.getElementById("alertFilterStatus");
  if (!el) return;
  const summary = getFilterSummaryText();
  if (!summary) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = `
    <span class="alert-filter-chip">
      Filtered: ${summary}
      <button type="button" id="clearFilterBtn">×</button>
    </span>
  `;
}

function renderWindowSummary() {
  const summary = state.overview?.windowSummary || [];
  const machineFilter = state.selectedMachineId;
  const rowsForView = machineFilter ? summary.filter(machine => machine.machineId === machineFilter) : summary;
  const container = document.getElementById("windowSummary");
  if (!rowsForView.length) {
    container.innerHTML = '<div class="empty-state">No qualifying reels in the last 24 hours.</div>';
    return;
  }
  const header = `
    <thead>
      <tr>
        <th>Machine</th>
        <th>Current Job</th>
        ${WINDOW_LABELS.map(label => `<th>${label}</th>`).join("")}
      </tr>
    </thead>
  `;
  const rows = rowsForView
    .map(machine => {
      const cells = WINDOW_LABELS.map(label => {
        const win = machine.windows?.[label] || {};
        if (!win.open) {
          return `
            <td class="window-cell idle" data-machine-id="${machine.machineId}" data-window-label="${label}">
              <strong>No activity</strong>
              <div>${label} window</div>
            </td>
          `;
        }
        const trendClass = trendStateForWindow(win);
        const details = `${win.reelsRun ?? 0} run · ${win.qualifyingReels ?? 0} qual · ${win.monitoredReels ?? 0} monitored · ${win.badReels ?? 0} bad`;
        return `
          <td class="window-cell trend-${trendClass}" data-machine-id="${machine.machineId}" data-window-label="${label}">
            <div class="trend-primary">
              <strong>${formatPercent(win.badFeetPct)}</strong>
              <span>${trendLabel(win)}</span>
            </div>
            <div class="trend-details">${details}</div>
          </td>
        `;
      }).join("");
      return `
        <tr>
          <td>${machine.machineName}</td>
          <td>${machine.currentJob || "—"}</td>
          ${cells}
        </tr>
      `;
    })
    .join("");
  container.innerHTML = `<table>${header}<tbody>${rows}</tbody></table>`;
}

async function openWindowModal(machineId, windowLabel) {
  try {
    setLiveStatus("Loading window details…", "info");
    const data = await fetchJSON(`/rlm/live/api/windows/${machineId}/${windowLabel}`);
    state.windowDetails = data;
    renderWindowModal();
    document.getElementById("windowDialog").showModal();
    setLiveStatus("Window details loaded.", "success");
  } catch (err) {
    setLiveStatus(`Failed to load window details: ${err.message}`, "error");
  }
}

function renderWindowModal() {
  const details = state.windowDetails;
  const titleEl = document.getElementById("windowDialogTitle");
  const summaryEl = document.getElementById("windowDialogSummary");
  const bodyEl = document.getElementById("windowDialogBody");
  if (!details || !titleEl || !summaryEl || !bodyEl) return;
  titleEl.textContent = `${details.machineName ?? "Press"} — ${details.windowLabel}`;
  const summary = details.summary || {};
  summaryEl.innerHTML = `
    <strong>${formatPercent(summary.badFeetPct)}</strong> ·
    ${summary.reelsRun ?? 0} reels ·
    ${summary.qualifyingReels ?? 0} qualifying ·
    ${summary.monitoredReels ?? 0} monitored ·
    ${summary.badReels ?? 0} bad
    <div>${summary.statusLabel || ""}</div>
  `;
  if (!details.reels?.length) {
    bodyEl.innerHTML = '<div class="empty-state">No reels in this window.</div>';
    return;
  }
  const rows = details.reels
    .map(reel => {
      return `
        <tr>
          <td>${reel.jobName || "—"}</td>
          <td>${reel.reelId}</td>
          <td>${reel.productionStartLocal || formatDateTimeCentral(reel.productionStart)}</td>
          <td>${formatNumber(reel.feetTotal, 0)} ft</td>
          <td>${formatYesNo(reel.qualifying)}</td>
          <td>${formatYesNo(reel.monitored)}</td>
          <td>${formatPercent(reel.badFeetPct)}</td>
          <td>${formatPoints(reel.monitoringPointsBad, reel.monitoringPointsTotal)}</td>
          <td>${formatNumber(reel.avgDelta, 3)}</td>
          <td>${formatNumber(reel.deltaStd, 3)}</td>
        </tr>
      `;
    })
    .join("");
  bodyEl.innerHTML = `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Job</th>
            <th>Reel</th>
            <th>Start</th>
            <th>Feet</th>
            <th>Qual?</th>
            <th>Monitored?</th>
            <th>Bad feet %</th>
            <th>Bad pts</th>
            <th>Avg Δ</th>
            <th>Δ std</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function trendStateForWindow(win) {
  if (!win.open) return "idle";
  if (win.status === "unknown") return "unknown";
  if (win.status === "partial") return "partial";
  if (win.status) return win.status;
  const value = Number(win.badFeetPct) || 0;
  if (value >= 10) return "critical";
  if (value >= 5) return "warning";
  if (value >= 2) return "caution";
  return "healthy";
}

function trendLabel(win) {
  if (!win.open) return "No activity";
  if (win.statusLabel) return win.statusLabel;
  return trendLabelFromState(trendStateForWindow(win));
}

function trendLabelFromState(state) {
  if (state === "critical") return "Degrading";
  if (state === "warning") return "Needs attention";
  if (state === "caution") return "Watch";
  if (state === "partial") return "Low coverage";
  if (state === "unknown") return "No monitoring";
  return "Improving";
}

function renderTrendSignals() {
  const machineFilter = state.selectedMachineId;
  const summary = (state.overview?.trendSignals || []).filter(row => !machineFilter || row.machineId === machineFilter);
  const container = document.getElementById("trendSignals");
  if (!container) return;
  if (!summary.length) {
    container.innerHTML = '<div class="empty-state">No trend signals right now.</div>';
    return;
  }
  const cards = summary
    .map(row => `
      <div class="attention-card">
        <div class="attention-head">
          <strong>${row.machineName}</strong>
          <span>${signalLabel(row.signal)}</span>
        </div>
        <p>${row.detail}</p>
        <small>${row.context || ""}</small>
      </div>
    `)
    .join("");
  container.innerHTML = cards;
}

function renderFocusPanel() {
  const panel = document.getElementById("focusPanel");
  const cycleLabel = document.getElementById("cycleStatus");
  const items = state.focusItems || [];
  const machineFilter = state.selectedMachineId;
  const filteredItems = machineFilter ? items.filter(item => !item.machineId || item.machineId === machineFilter) : items;
  const signature = JSON.stringify(filteredItems.map(item => `${item.type}-${item.title}-${item.timestamp || ""}-${item.severity || ""}`));
  if (signature !== state.focusSignature) {
    state.focusIndex = 0;
    state.focusSignature = signature;
  }
  let visibleItems;
  if (filteredItems.length <= FOCUS_CHUNK_SIZE) {
    visibleItems = filteredItems;
  } else {
    visibleItems = [];
    for (let i = 0; i < FOCUS_CHUNK_SIZE; i += 1) {
      visibleItems.push(filteredItems[(state.focusIndex + i) % filteredItems.length]);
    }
  }
  if (!visibleItems.length) {
    panel.innerHTML = '<div class="empty-state">Nothing demanding attention.</div>';
    if (cycleLabel) cycleLabel.textContent = "";
    return;
  }
  panel.innerHTML = `
    <div class="focus-cards">
      ${visibleItems
        .map(item => {
          const severityClass = item.severity || "info";
          const timestampLabel = item.timestampDisplay || formatTimeCentral(item.timestamp);
          return `
            <div class="focus-card ${severityClass}">
              <div class="focus-card-head">
                <span>${timestampLabel || "—"}</span>
                <span class="state-chip ${severityClass}">${formatStateLabel(item.severity || "info")}</span>
              </div>
              <h3>${item.title}</h3>
              <p class="focus-callout">${item.subtitle || ""}</p>
              <p>${item.body || ""}</p>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
  if (cycleLabel) {
    cycleLabel.textContent = filteredItems.length > FOCUS_CHUNK_SIZE ? `Cycling ${state.overview?.focusPanel?.cycleSeconds || 8}s` : "Stable";
  }
}

function startFocusCycle(seconds) {
  if (state.cycleTimer) {
    clearInterval(state.cycleTimer);
    state.cycleTimer = null;
  }
  if (!state.focusItems || state.focusItems.length <= FOCUS_CHUNK_SIZE) {
    return;
  }
  state.cycleTimer = setInterval(() => {
    state.focusIndex = (state.focusIndex + FOCUS_CHUNK_SIZE) % state.focusItems.length;
    renderFocusPanel();
  }, Math.max(seconds, 3) * 1000);
}

async function acknowledgeAlertGroup(alertIds) {
  if (!alertIds?.length) return;
  try {
    state.ackInFlight = String(alertIds[0]);
    renderActiveAlerts();
    await fetchJSON("/rlm/live/api/alerts/bulk_acknowledge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alert_ids: alertIds, acknowledged_by: "control-room" }),
    });
    state.ackInFlight = null;
    removeAckedAlerts(alertIds);
    refreshAfterAcknowledge(`Acknowledged ${alertIds.length} alert${alertIds.length === 1 ? "" : "s"}.`);
  } catch (err) {
    state.ackInFlight = null;
    setLiveStatus(`Failed to acknowledge: ${err.message}`, "error");
  }
}

async function acknowledgeVisibleAlerts() {
  const password = prompt("Enter admin password to acknowledge all alerts:");
  if (!password) return;
  try {
    state.ackVisibleLoading = true;
    const btn = document.getElementById("ackVisibleBtn");
    if (btn) btn.textContent = "Acknowledging…";
    const body = {
      password,
      acknowledged_by: "control-room",
    };
    const response = await fetchJSON("/rlm/live/api/alerts/acknowledge_all", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.acknowledged) {
      throw new Error(response.message || "No alerts were acknowledged.");
    }
    if (state.overview) {
      state.overview.activeAlerts = [];
      state.visibleAlertIds = [];
      renderActiveAlerts();
      renderAlertFilterStatus();
    }
    refreshAfterAcknowledge(`Acknowledged ${response.acknowledged} alert${response.acknowledged === 1 ? "" : "s"} (full sweep).`);
    state.ackVisibleLoading = false;
    if (btn) btn.textContent = "Acknowledge all";
  } catch (err) {
    state.ackVisibleLoading = false;
    const btn = document.getElementById("ackVisibleBtn");
    if (btn) btn.textContent = "Acknowledge visible";
    setLiveStatus(`Failed to acknowledge visible alerts: ${err.message}`, "error");
  }
}

async function refreshAfterAcknowledge(baseMessage) {
  state.refreshInProgress = true;
  setLiveStatus(`${baseMessage} Refreshing…`, "success");
  loadOverview()
    .then(() => {
      setLiveStatus(`${baseMessage} Next batch loaded.`, "success");
    })
    .catch(err => {
      setLiveStatus(`${baseMessage} Refresh failed: ${err.message}`, "error");
    })
    .finally(() => {
      state.refreshInProgress = false;
    });
}

function removeAckedAlerts(alertIds) {
  if (!state.overview?.activeAlerts?.length) return;
  const toRemove = new Set(alertIds);
  state.overview.activeAlerts = state.overview.activeAlerts.filter(alert => {
    const ids = alert.alertIds || [];
    return !ids.some(id => toRemove.has(id));
  });
  state.visibleAlertIds = state.visibleAlertIds.filter(id => !toRemove.has(id));
  renderActiveAlerts();
  renderAlertFilterStatus();
}

async function openHistoryModal() {
  try {
    setLiveStatus("Loading alert history…", "info");
    await loadHistory(state.historyMachineId);
    renderHistory();
    document.getElementById("historyDialog").showModal();
    setLiveStatus("Alert history loaded.", "success");
  } catch (err) {
    setLiveStatus(`Failed to load history: ${err.message}`, "error");
  }
}

async function loadHistory(machineId = "all") {
  const params = machineId && machineId !== "all" ? `?machine_id=${machineId}` : "";
  const data = await fetchJSON(`/rlm/live/api/alerts/history${params}`);
  state.history = data.alerts || [];
  state.historyMachineId = machineId;
  populateHistorySelect();
}

function renderHistory() {
  const container = document.getElementById("historyBody");
  const rows = state.history.filter(alert => alertMatchesFilters(alert));
  if (!rows.length) {
    container.innerHTML = '<div class="empty-state">No alert history for this filter set.</div>';
    return;
  }
  container.innerHTML = rows
    .map(row => {
      const ack = row.acknowledgedAt ? ` · Ack ${formatDateTimeCentral(row.acknowledgedAt)}` : "";
      return `
        <div class="history-row ${row.severity}">
          <div class="alert-card-head">
            <strong>${row.machineName}</strong>
            <span>${formatDateTimeCentral(row.triggeredAt)}</span>
          </div>
          <p>${row.alertType} · Reel ${row.reelId || "—"} · Job ${row.jobName || "—"}</p>
          <p>${row.message}</p>
          <small>Status: ${row.status}${ack}</small>
        </div>
      `;
    })
    .join("");
}

function initFilters() {
  filterControls.root = document.getElementById("rlmFilters");
  if (!filterControls.root) {
    state.selectedMachineId = null;
    state.selectedSeverity = null;
    state.selectedAlertType = null;
    state.filterStartRaw = "";
    state.filterEndRaw = "";
    renderAll();
    return;
  }
  filterControls.machine = document.getElementById("rlmFilterMachine");
  filterControls.start = document.getElementById("rlmFilterStart");
  filterControls.end = document.getElementById("rlmFilterEnd");
  filterControls.severity = document.getElementById("rlmFilterSeverity");
  filterControls.alertType = document.getElementById("rlmFilterAlertType");
  filters.defaults.machineId = parseMachineId(filterControls.root.dataset.defaultMachine || "");
  filters.defaults.start = normalizeDateTimeInput(filterControls.root.dataset.defaultStart || "");
  filters.defaults.end = normalizeDateTimeInput(filterControls.root.dataset.defaultEnd || "", "23:59");
  hydrateFilterStateFromStore();
  syncFilterInputs();
  applyFilters({ skipInputRead: true, skipRender: true });
}

function parseMachineId(value) {
  if (value === undefined || value === null || value === "") return null;
  const num = Number(value);
  return Number.isNaN(num) ? null : num;
}

function normalizeDateTimeInput(value, fallback = "00:00") {
  if (!value) return "";
  const trimmed = String(value).trim();
  if (!trimmed) return "";
  if (trimmed.includes("T")) return trimmed.slice(0, 16);
  return `${trimmed}T${fallback}`;
}

function hydrateFilterStateFromStore() {
  const stored = window.FilterState && typeof window.FilterState.getFilters === "function" ? window.FilterState.getFilters() || {} : {};
  const hasRlmMachine = Object.prototype.hasOwnProperty.call(stored, "rlm_machine_id");
  let machinePref = hasRlmMachine ? stored.rlm_machine_id : stored.machine_id;
  if (machinePref === undefined || machinePref === null || machinePref === "") {
    filters.machineId = hasRlmMachine ? null : filters.defaults.machineId;
  } else {
    filters.machineId = parseMachineId(machinePref);
  }
  filters.start = stored.rlm_start || normalizeDateTimeInput(stored.start || filters.defaults.start || "");
  filters.end = stored.rlm_end || normalizeDateTimeInput(stored.end || filters.defaults.end || "", "23:59");
  filters.severity = stored.rlm_severity || "";
  filters.alertType = stored.rlm_alert_type || "";
  const updates = {};
  if (!stored.rlm_start && filters.start) {
    updates.rlm_start = filters.start;
  }
  if (!stored.rlm_end && filters.end) {
    updates.rlm_end = filters.end;
  }
  if (stored.machine_id === undefined && filters.machineId) {
    updates.machine_id = String(filters.machineId);
  }
  if (!hasRlmMachine && filters.machineId) {
    updates.rlm_machine_id = String(filters.machineId);
  }
  if (!stored.start && filters.start) {
    updates.start = filters.start.split("T")[0];
  }
  if (!stored.end && filters.end) {
    updates.end = filters.end.split("T")[0];
  }
  if (Object.keys(updates).length && window.FilterState && typeof window.FilterState.update === "function") {
    window.FilterState.update(updates);
  }
}

function syncFilterInputs() {
  if (filterControls.machine) {
    filterControls.machine.value = filters.machineId !== null && filters.machineId !== undefined ? String(filters.machineId) : "";
  }
  if (filterControls.start) {
    filterControls.start.value = filters.start || "";
  }
  if (filterControls.end) {
    filterControls.end.value = filters.end || "";
  }
  if (filterControls.severity) {
    filterControls.severity.value = filters.severity || "";
  }
  if (filterControls.alertType) {
    filterControls.alertType.value = filters.alertType || "";
  }
}

function readFiltersFromInputs() {
  if (filterControls.machine) {
    filters.machineId = parseMachineId(filterControls.machine.value || "");
  }
  if (filterControls.start) {
    filters.start = normalizeDateTimeInput(filterControls.start.value || "");
  }
  if (filterControls.end) {
    filters.end = normalizeDateTimeInput(filterControls.end.value || "", "23:59");
  }
  if (filterControls.severity) {
    filters.severity = filterControls.severity.value || "";
  }
  if (filterControls.alertType) {
    filters.alertType = filterControls.alertType.value || "";
  }
}

function applyFilters(options = {}) {
  const { skipInputRead = false, skipRender = false } = options || {};
  if (!skipInputRead) {
    readFiltersFromInputs();
  }
  state.selectedMachineId = filters.machineId || null;
  state.selectedSeverity = filters.severity ? filters.severity : null;
  state.selectedAlertType = filters.alertType ? filters.alertType : null;
  state.filterStartRaw = filters.start || "";
  state.filterEndRaw = filters.end || "";
  state.filterStart = filters.start ? parseDate(filters.start) : null;
  state.filterEnd = filters.end ? parseDate(filters.end) : null;
  if (state.historyMachineId === "all" && state.selectedMachineId) {
    state.historyMachineId = String(state.selectedMachineId);
  } else if (!state.selectedMachineId) {
    state.historyMachineId = "all";
  }
  persistFilterState();
  renderFilterChips();
  if (skipRender) {
    renderAlertFilterStatus();
    return;
  }
  renderAll();
}

function persistFilterState() {
  if (!window.FilterState || typeof window.FilterState.update !== "function") return;
  const payload = {
    start: filters.start ? filters.start.split("T")[0] : "",
    end: filters.end ? filters.end.split("T")[0] : "",
    rlm_start: filters.start || "",
    rlm_end: filters.end || "",
    rlm_severity: filters.severity || "",
    rlm_alert_type: filters.alertType || "",
    rlm_machine_id: filters.machineId ? String(filters.machineId) : "",
  };
  if (filters.machineId) {
    payload.machine_id = String(filters.machineId);
  }
  window.FilterState.update(payload);
}

function renderFilterChips() {
  if (!filterControls.chips) return;
  const chips = [];
  if (state.selectedMachineId) {
    const name = getMachineName(state.selectedMachineId) || `Press ${state.selectedMachineId}`;
    chips.push({ key: "machine", label: `Machine: ${name}` });
  }
  if (state.selectedSeverity) {
    chips.push({ key: "severity", label: `Severity: ${formatStateLabel(state.selectedSeverity)}` });
  }
  if (state.selectedAlertType) {
    chips.push({
      key: "alertType",
      label: `Alert: ${ALERT_TYPE_LABELS[state.selectedAlertType] || state.selectedAlertType.replace(/_/g, " ")}`,
    });
  }
  if (state.filterStartRaw) {
    chips.push({ key: "start", label: `Start: ${formatFilterDateLabel(state.filterStartRaw)}` });
  }
  if (state.filterEndRaw) {
    chips.push({ key: "end", label: `End: ${formatFilterDateLabel(state.filterEndRaw)}` });
  }
  if (!chips.length) {
    filterControls.chips.innerHTML = "";
    filterControls.chips.classList.add("hidden");
    return;
  }
  filterControls.chips.innerHTML = chips
    .map(
      chip => `
        <span class="filter-chip">
          ${chip.label}
          <button type="button" data-filter-chip="${chip.key}" aria-label="Clear ${chip.label}">×</button>
        </span>
      `
    )
    .join("");
  filterControls.chips.classList.remove("hidden");
}

function formatFilterDateLabel(value) {
  const date = parseDate(value);
  if (!date) return value || "";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function handleFilterChipClick(event) {
  const btn = event.target.closest("button[data-filter-chip]");
  if (!btn) return;
  const key = btn.dataset.filterChip;
  if (key === "machine") {
    filters.machineId = null;
  } else if (key === "severity") {
    filters.severity = "";
  } else if (key === "alertType") {
    filters.alertType = "";
  } else if (key === "start") {
    filters.start = "";
  } else if (key === "end") {
    filters.end = "";
  }
  syncFilterInputs();
  applyFilters({ skipInputRead: true });
}

function resetFilters() {
  filters.machineId = filters.defaults.machineId;
  filters.start = filters.defaults.start || "";
  filters.end = filters.defaults.end || "";
  filters.severity = "";
  filters.alertType = "";
  syncFilterInputs();
  applyFilters({ skipInputRead: true });
}

function getFilterSummaryText() {
  const parts = [];
  if (state.selectedMachineId) {
    parts.push(getMachineName(state.selectedMachineId) || `Press ${state.selectedMachineId}`);
  }
  if (state.selectedSeverity) {
    parts.push(formatStateLabel(state.selectedSeverity));
  }
  if (state.selectedAlertType) {
    parts.push(ALERT_TYPE_LABELS[state.selectedAlertType] || state.selectedAlertType.replace(/_/g, " "));
  }
  const rangeLabel = (() => {
    const start = state.filterStartRaw ? formatFilterDateLabel(state.filterStartRaw) : "";
    const end = state.filterEndRaw ? formatFilterDateLabel(state.filterEndRaw) : "";
    if (start && end) return `${start} – ${end}`;
    if (start) return `After ${start}`;
    if (end) return `Before ${end}`;
    return "";
  })();
  if (rangeLabel) {
    parts.push(rangeLabel);
  }
  return parts.join(" · ");
}

function populateHistorySelect() {
  const select = document.getElementById("historyMachineSelect");
  if (!select) return;
  const machines = state.overview?.machineCards || [];
  const options = [
    `<option value="all"${state.historyMachineId === "all" ? " selected" : ""}>All machines</option>`,
    ...machines.map(machine => `<option value="${machine.machineId}"${String(machine.machineId) === String(state.historyMachineId) ? " selected" : ""}>${machine.machineName}</option>`),
  ];
  select.innerHTML = options.join("");
}

async function openThresholdModal() {
  try {
    if (!state.thresholds) {
      setLiveStatus("Loading thresholds…", "info");
      state.thresholds = await fetchJSON("/rlm/live/api/thresholds");
    }
    populateThresholdSelect();
    renderThresholdForm();
    document.getElementById("thresholdDialog").showModal();
    setThresholdMessage("");
    setLiveStatus("Thresholds ready.", "success");
  } catch (err) {
    setLiveStatus(`Failed to load thresholds: ${err.message}`, "error");
  }
}

function populateThresholdSelect() {
  const select = document.getElementById("thresholdMachineSelect");
  if (!select || !state.thresholds?.machines) return;
  if (!state.selectedThresholdMachine && state.thresholds.machines.length) {
    state.selectedThresholdMachine = String(state.thresholds.machines[0].machineId);
  }
  const selectedValue = String(state.selectedThresholdMachine || "");
  const bulkOption = `
    <option value="all" ${selectedValue === "all" ? "selected" : ""}>
      All machines (bulk update)
    </option>
  `;
  const machineOptions = state.thresholds.machines
    .map(machine => {
      const value = String(machine.machineId);
      return `
        <option value="${value}" ${value === selectedValue ? "selected" : ""}>
          ${machine.machineName}
        </option>
      `;
    })
    .join("");
  select.innerHTML = bulkOption + machineOptions;
}

function renderThresholdForm() {
  const form = document.getElementById("thresholdForm");
  const select = document.getElementById("thresholdMachineSelect");
  if (!form || !select) return;
  const selectedValue = select.value || "";
  state.selectedThresholdMachine = selectedValue;
  const isBulk = selectedValue === "all";
  const machine = isBulk
    ? state.thresholds?.machines?.[0]
    : state.thresholds?.machines?.find(m => String(m.machineId) === selectedValue);
  if (!machine) {
    form.innerHTML = '<div class="empty-state">No machine selected.</div>';
    const note = document.getElementById("thresholdBulkNote");
    if (note) note.style.display = "none";
    return;
  }
  const note = document.getElementById("thresholdBulkNote");
  if (note) {
    if (isBulk) {
      note.textContent = "Bulk edit: Saving will update every press. Leave a field blank to keep existing values.";
      note.style.display = "block";
    } else {
      note.textContent = "";
      note.style.display = "none";
    }
  }
  const grids = {};
  document.querySelectorAll(".threshold-section-grid").forEach(grid => {
    grids[grid.dataset.section || "general"] = grid;
    grid.innerHTML = "";
  });
  let rendered = 0;
  THRESHOLD_FIELDS.forEach(field => {
    const section = field.section || "general";
    const target = grids[section] || grids.general;
    if (!target) {
      console.warn(`[Thresholds] Missing section container for ${section}, field ${field.key}`);
      return;
    }
    if (field.type === "checkbox") {
      target.insertAdjacentHTML("beforeend", `
        <label>
          ${field.label}
          <input type="checkbox" data-field="${field.key}" ${machine[field.key] ? "checked" : ""}>
        </label>
      `);
    } else {
      target.insertAdjacentHTML("beforeend", `
        <label>
          ${field.label}
          <input type="number" step="${field.step}" data-field="${field.key}" value="${machine[field.key] ?? ""}">
        </label>
      `);
    }
    rendered += 1;
  });
  if (!rendered) {
    form.innerHTML = '<div class="empty-state">No threshold fields available.</div>';
  }
  setThresholdMessage("");
}

async function openAlertConfigModal() {
  try {
    await loadAlertConfig();
    renderAlertConfig();
    document.getElementById("alertConfigDialog").showModal();
    setAlertConfigMessage("");
  } catch (err) {
    setAlertConfigMessage(`Failed to load alert controls: ${err.message}`, "error");
  }
}

async function loadAlertConfig(force = false) {
  if (state.alertConfig && !force) return;
  const data = await fetchJSON("/rlm/live/api/alert-config");
  state.alertConfig = data.alerts || [];
}

function mergedAlertConfig() {
  const map = {};
  (state.alertConfig || []).forEach(row => {
    map[row.alertType] = row;
  });
  return ALERT_CONFIG_DEFAULTS.map(def => {
    const existing = map[def.alertType] || {};
    return {
      alertType: def.alertType,
      group: def.group,
      displayName: existing.displayName || def.displayName,
      description: existing.description || def.description,
      enabled: typeof existing.enabled === "boolean" ? existing.enabled : true,
    };
  });
}

function renderAlertConfig() {
  const dialog = document.getElementById("alertConfigDialog");
  if (!dialog) return;
  const sections = {};
  dialog.querySelectorAll(".threshold-section-grid[data-alert-section]").forEach(grid => {
    sections[grid.dataset.alertSection] = grid;
    grid.innerHTML = "";
  });
  const configs = mergedAlertConfig();
  configs.forEach(item => {
    const target = sections[item.group] || sections.reel;
    if (!target) return;
    target.insertAdjacentHTML("beforeend", `
      <label class="alert-toggle">
        <div>
          <strong>${item.displayName}</strong>
          <span>${item.alertType}</span>
          <p>${item.description || ""}</p>
        </div>
        <input type="checkbox" data-alert-type="${item.alertType}" ${item.enabled ? "checked" : ""}>
      </label>
    `);
  });
}

async function saveAlertConfig() {
  const password = document.getElementById("alertConfigPassword").value;
  if (!password) {
    setAlertConfigMessage("Password is required.", "error");
    return;
  }
  const dialog = document.getElementById("alertConfigDialog");
  const toggles = Array.from(dialog.querySelectorAll("[data-alert-type]")).map(input => ({
    alertType: input.dataset.alertType,
    enabled: input.checked,
  }));
  try {
    const res = await fetchJSON("/rlm/live/api/alert-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        password,
        updated_by: "control-room",
        alerts: toggles,
      }),
    });
    setAlertConfigMessage(res.message || "Alert settings saved.", "success");
    await loadAlertConfig(true);
    renderAlertConfig();
  } catch (err) {
    setAlertConfigMessage(`Save failed: ${err.message}`, "error");
  }
}

function setAlertConfigMessage(message, type = "") {
  const el = document.getElementById("alertConfigMessage");
  if (!el) return;
  el.textContent = message;
  if (type === "success") {
    el.style.color = "#4ade80";
  } else if (type === "error") {
    el.style.color = "#f87171";
  } else {
    el.style.color = "#fbbf24";
  }
}

async function saveThresholds() {
  if (!state.thresholds) return;
  const form = document.getElementById("thresholdForm");
  const select = document.getElementById("thresholdMachineSelect");
  const passwordInput = document.getElementById("adminPassword");
  if (!form || !select || !passwordInput) return;
  const selectedValue = select.value || "";
  const password = passwordInput.value;
  if (!password) {
    setThresholdMessage("Password required to save.", "error");
    return;
  }
  if (selectedValue === "all") {
    const confirmed = window.confirm("This will update the thresholds for all machines. Continue?");
    if (!confirmed) return;
  }
  const values = {};
  THRESHOLD_FIELDS.forEach(field => {
    const input = form.querySelector(`[data-field="${field.key}"]`);
    if (!input) return;
    if (field.type === "checkbox") {
      values[field.column] = input.checked;
      return;
    }
    const val = input.value;
    if (val === "" || val === null || val === undefined) return;
    const numberVal = Number(val);
    if (!Number.isNaN(numberVal)) {
      values[field.column] = numberVal;
    }
  });
  try {
    setThresholdSaving(true);
    const targetId = selectedValue === "all" ? "all" : Number(selectedValue);
    await fetchJSON(`/rlm/live/api/thresholds/${targetId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password, updated_by: "control-room", values }),
    });
    state.thresholds = await fetchJSON("/rlm/live/api/thresholds");
    populateThresholdSelect();
    renderThresholdForm();
    setThresholdMessage("Saved.", "success");
    setLiveStatus("Thresholds updated.", "success");
    loadOverview().catch(() => {});
  } catch (err) {
    setThresholdMessage(`Failed to save: ${err.message}`, "error");
    setLiveStatus(`Failed to save thresholds: ${err.message}`, "error");
  } finally {
    setThresholdSaving(false);
  }
}

function setThresholdSaving(isSaving) {
  state.thresholdSaving = isSaving;
  const btn = document.getElementById("saveThresholdBtn");
  if (!btn) return;
  btn.textContent = isSaving ? "Saving…" : "Save";
  btn.disabled = isSaving;
}

function setThresholdMessage(message, type = "") {
  const el = document.getElementById("thresholdMessage");
  if (!el) return;
  el.textContent = message;
  el.style.color = type === "success" ? "#4ade80" : type === "error" ? "#f87171" : "#fbbf24";
}

function handleAlertRailClick(event) {
  const btn = event.target.closest(".ack-btn");
  if (!btn) return;
  const idString = btn.dataset.alertIds || "";
  const ids = idString
    .split(",")
    .map(id => Number(id.trim()))
    .filter(id => !Number.isNaN(id));
  acknowledgeAlertGroup(ids);
}

function handleMachineGridClick(event) {
  const severityBadge = event.target.closest("[data-machine-severity]");
  if (severityBadge) {
    const machineId = Number(severityBadge.dataset.machineId);
    const severity = severityBadge.dataset.machineSeverity;
    applyMachineFilter(machineId, severity);
    return;
  }
  const card = event.target.closest(".machine-card");
  if (card?.dataset.machineId) {
    const machineId = Number(card.dataset.machineId);
    if (state.selectedMachineId === machineId && !state.selectedSeverity) {
      clearMachineFilter();
    } else {
      applyMachineFilter(machineId, null);
    }
  }
}

function applyMachineFilter(machineId, severity) {
  filters.machineId = machineId || null;
  filters.severity = severity || "";
  if (filterControls.machine) {
    filterControls.machine.value = filters.machineId ? String(filters.machineId) : "";
  }
  if (filterControls.severity) {
    filterControls.severity.value = filters.severity;
  }
  applyFilters({ skipInputRead: true });
}

function clearMachineFilter() {
  filters.machineId = null;
  filters.severity = "";
  if (filterControls.machine) {
    filterControls.machine.value = "";
  }
  if (filterControls.severity) {
    filterControls.severity.value = "";
  }
  applyFilters({ skipInputRead: true });
}

function getMachineName(machineId) {
  return state.overview?.machineCards?.find(c => c.machineId === machineId)?.machineName;
}

function formatReelStart(latest) {
  if (!latest) return "—";
  if (latest.productionStartLocal) return latest.productionStartLocal;
  return formatDateTimeCentral(latest.productionStart);
}

function formatNumber(value, digits = 1) {
  if (value === undefined || value === null) return "—";
  const num = Number(value);
  if (Number.isNaN(num)) return "—";
  return num.toFixed(digits);
}

function formatPercent(value) {
  if (value === undefined || value === null) return "—";
  const num = Number(value);
  if (Number.isNaN(num)) return "—";
  return `${num.toFixed(1)}%`;
}

function formatFeet(bad, total) {
  if (bad === undefined || total === undefined || bad === null || total === null) return "—";
  return `${Number(bad).toFixed(0)} / ${Number(total).toFixed(0)} ft`;
}

function formatPoints(bad, total) {
  if (bad === undefined || total === undefined || bad === null || total === null) return "—";
  return `${bad} / ${total} pts`;
}

function formatStateLabel(status) {
  if (!status) return "Status";
  return STATE_LABELS[status] || status.charAt(0).toUpperCase() + status.slice(1);
}

function formatWebspeed(avg, range) {
  const avgPart = avg === undefined || avg === null ? null : `${Number(avg).toFixed(1)} fpm`;
  const rangePart = range === undefined || range === null ? null : `range ${Number(range).toFixed(1)}`;
  if (!avgPart && !rangePart) return "—";
  if (avgPart && rangePart) return `${avgPart} · ${rangePart}`;
  return avgPart || rangePart || "—";
}

function formatNominal(nominal, shrink, expand) {
  if (nominal === undefined || nominal === null) return "—";
  const shrinkPart = shrink === undefined || shrink === null ? null : `-${Number(shrink).toFixed(3)}`;
  const expandPart = expand === undefined || expand === null ? null : `+${Number(expand).toFixed(3)}`;
  if (shrinkPart || expandPart) {
    return `${Number(nominal).toFixed(3)} (${shrinkPart || "-0.000"}/${expandPart || "+0.000"})`;
  }
  return `${Number(nominal).toFixed(3)}`;
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function formatTimeCentral(iso) {
  const date = parseDate(iso);
  if (!date) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: CENTRAL_TIMEZONE,
      hour12: true,
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  } catch (err) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: true });
  }
}

function formatDateTimeCentral(iso) {
  const date = parseDate(iso);
  if (!date) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: CENTRAL_TIMEZONE,
      hour12: true,
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  } catch (err) {
    return date.toLocaleString("en-US", {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
  }
}

function formatRelativeAge(date) {
  if (!date) return "";
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function wireEvents() {
  document.getElementById("refreshNowBtn")?.addEventListener("click", () => {
    if (state.refreshTimer) clearTimeout(state.refreshTimer);
    loadOverview().catch(() => {});
  });
  document.getElementById("showHistoryBtn")?.addEventListener("click", openHistoryModal);
  document.getElementById("showThresholdBtn")?.addEventListener("click", openThresholdModal);
  document.getElementById("showAlertConfigBtn")?.addEventListener("click", openAlertConfigModal);
  document.getElementById("alertRail")?.addEventListener("click", handleAlertRailClick);
  document.getElementById("machineGrid")?.addEventListener("click", handleMachineGridClick);
  document.getElementById("ackVisibleBtn")?.addEventListener("click", acknowledgeVisibleAlerts);
  document.body.addEventListener("click", event => {
    if (event.target.closest("#clearFilterBtn")) {
      clearMachineFilter();
    }
    const closeTarget = event.target.closest("[data-close]");
    if (closeTarget) {
      const id = closeTarget.dataset.close;
      document.getElementById(id)?.close();
    }
  });
  document.getElementById("thresholdMachineSelect")?.addEventListener("change", renderThresholdForm);
  document.getElementById("saveThresholdBtn")?.addEventListener("click", saveThresholds);
  document.getElementById("saveAlertConfigBtn")?.addEventListener("click", saveAlertConfig);
  document.getElementById("historyMachineSelect")?.addEventListener("change", event => {
    const value = event.target.value || "all";
    loadHistory(value)
      .then(renderHistory)
      .catch(err => setLiveStatus(`Failed to load history: ${err.message}`, "error"));
  });
  document.getElementById("windowSummary")?.addEventListener("click", event => {
    const cell = event.target.closest("[data-machine-id][data-window-label]");
    if (!cell) return;
    const machineId = Number(cell.dataset.machineId);
    const label = cell.dataset.windowLabel;
    if (!Number.isNaN(machineId) && label) {
      openWindowModal(machineId, label);
    }
  });
}

function init() {
  initFilters();
  wireEvents();
  loadOverview().catch(() => {});
}

window.addEventListener("load", init);

function formatYesNo(value) {
  return value ? "Yes" : "No";
}

function signalLabel(type) {
  if (type === "recentSpike") return "Recent Spike";
  if (type === "degrading") return "Degrading Trend";
  if (type === "unstable") return "Unstable";
  if (type === "lowMonitoring") return "No Monitoring";
  if (type === "lowCoverage") return "Low Coverage";
  if (type === "recovering") return "Recovering";
  return "Signal";
}
const ROLLING_ALERT_TYPES = new Set(["ROLLING_BAD_FEET", "ROLLING_OOB_POINTS", "ROLLING_DELTA_DEVIATION"]);
function renderStandardAlertMetrics(payload, webspeedSummary) {
  return `
    <div class="alert-metrics">
      <div><label>Feet (bad/total)</label><strong>${formatFeet(payload.feetBad, payload.feetTotal)}</strong></div>
      <div><label>Bad feet %</label><strong>${formatPercent(payload.badFeetPct)}</strong></div>
      <div><label>Bad pts</label><strong>${formatPoints(payload.monitoringPointsBad, payload.monitoringPointsTotal)}</strong></div>
      <div><label>Avg Δ</label><strong>${formatNumber(payload.avgDelta, 3)}</strong></div>
      <div><label>Δ std dev</label><strong>${formatNumber(payload.deltaStd, 3)}</strong></div>
      <div><label>Webspeed</label><strong>${webspeedSummary}</strong></div>
    </div>
  `;
}

function renderRollingAlertMetrics(payload) {
  const rollingFeetPct = formatPercent(payload.badFeetPct);
  const rollingOob = formatPercent(payload.oobPointPct);
  const reels = payload.reelCount ? `${payload.reelCount} recent reels` : "Recent reels";
  const currentStatus = getCurrentReelStatus(payload);
  return `
    <div class="alert-metrics rolling">
      <div><label>Rolling window</label><strong>${reels}</strong></div>
      <div><label>Rolling bad feet %</label><strong>${rollingFeetPct}</strong></div>
      <div><label>Rolling OOB %</label><strong>${rollingOob}</strong></div>
    </div>
    <div class="current-reel-card">
      <div class="current-reel-header">${currentStatus.label}</div>
      <div class="current-reel-body">
        <div><label>Reel</label><strong>${payload.reelId || "—"}</strong></div>
        <div><label>Bad feet %</label><strong>${formatPercent(payload.badFeetPctCurrent ?? payload.badFeetPct)}</strong></div>
        <div><label>Bad pts</label><strong>${formatPoints(payload.monitoringPointsBad, payload.monitoringPointsTotal)}</strong></div>
        <div><label>Δ std dev</label><strong>${formatNumber(payload.deltaStd, 3)}</strong></div>
        <div class="current-reel-detail">${currentStatus.detail}</div>
      </div>
    </div>
  `;
}

function getCurrentReelStatus(payload) {
  if (payload.monitoringValid === false) {
    const expected = Number(payload.thresholds?.minPointsPer1000FtWarn || 0);
    const feet = Number(payload.feetTotal || 0);
    const density = payload.pointsPer1000Ft !== undefined && payload.pointsPer1000Ft !== null ? Number(payload.pointsPer1000Ft).toFixed(1) : "0.0";
    return {
      label: "Current reel – low monitoring",
      detail: `${payload.monitoringPointsTotal || 0} pts over ${feet.toFixed ? feet.toFixed(0) : feet} ft (needs ≥ ${expected} pts/1000ft)`,
    };
  }
  const totalPoints = Number(payload.monitoringPointsTotal) || 0;
  const badPoints = Number(payload.monitoringPointsBad) || 0;
  const badFeetPct = Number(payload.badFeetPctCurrent ?? payload.badFeetPct ?? 0);
  if (!payload.reelId) {
    return { label: "Current reel status", detail: "No current reel data available." };
  }
  if (totalPoints === 0) {
    return { label: "Current reel – no monitoring", detail: "No monitoring points yet on this reel." };
  }
  if (badPoints > 0 || badFeetPct >= 5) {
    return {
      label: "Current reel warning",
      detail: `${badPoints}/${totalPoints} bad points · ${formatPercent(badFeetPct)} bad feet`,
    };
  }
  return { label: "Current reel OK", detail: "Within tolerance so far." };
}
