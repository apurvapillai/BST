(function () {
  const state = {
    lookback: 8,
    severityFilter: "all",
    search: "",
    data: null,
    refreshTimer: null,
    refreshSeconds: 60,
    isLoading: false,
    alertStatusFilter: "open",
    alertFeed: [],
    selectedMachineId: null,
    selectedSeverity: null,
  };

  const refs = {
    kpiStrip: document.getElementById("kpiStrip"),
    machineGrid: document.getElementById("machineGrid"),
    alertRail: document.getElementById("alertRail"),
    reviewSummary: document.getElementById("reviewSummaryBody"),
    reviewSummaryLabel: document.getElementById("reviewSummaryLabel"),
    alertCountLabel: document.getElementById("alertCountLabel"),
    eventsTable: document.getElementById("recentEventsTable"),
    statusNode: document.getElementById("liveStatus"),
    lastUpdated: document.getElementById("lastUpdatedLabel"),
    lookbackSelect: document.getElementById("lookbackSelect"),
    severitySelect: document.getElementById("machineSeverityFilter"),
    searchInput: document.getElementById("machineSearchInput"),
    refreshBtn: document.getElementById("refreshNowBtn"),
    openHistoryBtn: document.getElementById("openAlertHistoryBtn"),
    historyDialog: document.getElementById("alertHistoryDialog"),
    historyStatusSelect: document.getElementById("historyStatusFilter"),
    historyMachineSelect: document.getElementById("historyMachineFilter"),
    historyLookbackSelect: document.getElementById("historyLookbackFilter"),
    historyBody: document.getElementById("alertHistoryBody"),
    historyRefreshBtn: document.getElementById("reloadHistoryBtn"),
    alertStatusSelect: null,
    filterChips: document.getElementById("liveFilterChips"),
    ackAllBtn: document.getElementById("ackAllAlertsBtn"),
  };

  const severityLabels = {
    critical_alert: "Critical",
    warning: "Warning",
    attention: "Attention",
    healthy: "Healthy",
    idle: "Idle",
  };

  function setStatus(message, type = "info") {
    if (!refs.statusNode) return;
    refs.statusNode.textContent = message || "";
    refs.statusNode.className = `live-status ${type}`;
  }

  function scheduleRefresh() {
    if (state.refreshTimer) clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(() => {
      state.refreshTimer = null;
      loadData();
    }, state.refreshSeconds * 1000);
  }

  function buildUrl() {
    const params = new URLSearchParams();
    params.set("lookback_hours", state.lookback);
    return `/dashboard/live/api/overview?${params.toString()}`;
  }

  async function loadData() {
    try {
      state.isLoading = true;
      setStatus("Refreshing…", "info");
      if (state.refreshTimer) {
        clearTimeout(state.refreshTimer);
        state.refreshTimer = null;
      }
      const res = await fetch(buildUrl());
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Request failed (${res.status})`);
      }
      const data = await res.json();
      state.data = data;
      renderAll();
      if (data.generated_at && refs.lastUpdated) {
        refs.lastUpdated.textContent = `Updated ${formatTime(data.generated_at)}`;
      }
      setStatus("Updated", "success");
      scheduleRefresh();
      loadPanelAlerts().catch((err) => console.error(err));
    } catch (err) {
      console.error(err);
      setStatus(`Refresh failed: ${err.message}`, "error");
      if (!state.refreshTimer) {
        state.refreshTimer = setTimeout(() => {
          state.refreshTimer = null;
          loadData();
        }, 15000);
      }
    } finally {
      state.isLoading = false;
    }
  }

  function renderAll() {
    if (!state.data) return;
    renderKpis(state.data.kpis || {});
    renderMachines(state.data.machines || []);
    renderReviewSummary(state.data.review_summary || {});
    renderFilterChips();
  }

  function renderKpis(kpis) {
    if (!refs.kpiStrip) return;
    const items = [
      { label: "Total machines", value: kpis.total_machines },
      { label: "Machines active", value: kpis.machines_active },
      { label: "Machines needing attention", value: kpis.machines_attention },
      { label: "Defects (60m)", value: kpis.defects_last_60m },
      { label: "Failed reels today", value: kpis.failed_reels_today },
      { label: "Pending review reels", value: kpis.pending_review_reels },
      { label: "Inspection off", value: kpis.inspection_off },
      { label: "No recent activity", value: kpis.machines_no_recent },
    ];
    refs.kpiStrip.innerHTML = items
      .map(
        (item) => `
        <div class="kpi-card">
          <small>${item.label}</small>
          <strong>${formatNumber(item.value)}</strong>
        </div>`
      )
      .join("");
  }

  function filteredMachines(machines) {
    return machines.filter((machine) => {
      if (state.selectedMachineId && Number(machine.machine_id) !== Number(state.selectedMachineId)) return false;
      if (state.severityFilter !== "all" && machine.status !== state.severityFilter) return false;
      if (state.search) {
        const haystack = `${machine.machine_name || ""} ${machine.job_name || ""} ${machine.order_number || ""}`
          .toLowerCase();
        if (!haystack.includes(state.search)) return false;
      }
      return true;
    });
  }

  function renderMachines(machines) {
    if (!refs.machineGrid) return;
        const list = filteredMachines(machines);
        if (!list.length) {
      refs.machineGrid.innerHTML = `<div class="empty-state">No machines match the selected filters.</div>`;
      return;
    }
    refs.machineGrid.innerHTML = list
      .map((machine) => {
        const mix = machine.phase_mix || {};
        const latestReview = machine.latest_review
          ? `<div>Last review · ${machine.latest_review.decision || "—"} (${formatTime(machine.latest_review.timestamp)})</div>`
          : "<div>No review data</div>";
        const criticalCount = countAlertsForMachine(machine.machine_id, "critical");
        const warningCount = countAlertsForMachine(machine.machine_id, "warning");
        const infoCount = countAlertsForMachine(machine.machine_id, "info");
        const allZero = !criticalCount && !warningCount && !infoCount;
        const topAlert = getTopAlertForMachine(machine.machine_id);
        let chipSeverity = mapSeverity(machine.status);
        if (!machine.last_reel_time) {
          chipSeverity = "idle";
        } else if (allZero) {
          chipSeverity = "healthy";
        } else if (topAlert) {
          chipSeverity = mapSeverity(topAlert.severity);
        }
        const isSelected = state.selectedMachineId && Number(state.selectedMachineId) === Number(machine.machine_id);
        const cardClasses = ["machine-card", chipSeverity];
        if (isSelected) cardClasses.push("selected");
        return `
        <article class="${cardClasses.join(" ")}" data-machine-id="${machine.machine_id}">
          <div class="machine-head">
            <div>
              <p class="eyebrow">${machine.reel_code || "Current reel"}</p>
              <h3>${machine.machine_name}</h3>
            </div>
            <div class="machine-head-meta">
              <span class="state-chip ${chipSeverity}">
                ${formatSeverityLabel(chipSeverity)}
              </span>
              <div class="${allZero ? "severity-badges severity-badges--clear" : "severity-badges"}">
                <span class="badge info">i ${infoCount}</span>
                <span class="badge warning">⚠ ${warningCount}</span>
                <span class="badge critical">✖ ${criticalCount}</span>
              </div>
            </div>
          </div>
          ${
            topAlert
              ? `<div class="machine-alert-note ${mapSeverity(topAlert.severity)}">${severityIcon(topAlert.severity)} ${topAlert.title || ""}${topAlert.message ? ` · ${topAlert.message}` : ""}</div>`
              : ""
          }
          <div class="machine-meta">
            <strong>${machine.job_name || "Unassigned"}</strong>
            ${machine.order_number ? `<span>· Order ${machine.order_number}</span>` : ""}
          </div>
          <div class="machine-body">
            <div>
              <label>Defects 15m</label>
              <strong>${formatNumber(machine.defects_15m)}</strong>
            </div>
            <div>
              <label>Defects 60m</label>
              <strong>${formatNumber(machine.defects_60m)}</strong>
            </div>
            <div>
              <label>Pending review</label>
              <strong>${formatNumber(machine.pending_reviews)}</strong>
            </div>
            <div>
              <label>Inspection state</label>
              <strong>${(machine.inspection_state || "").toUpperCase()}</strong>
            </div>
            <div>
              <label>Last reel</label>
              <strong>${formatTime(machine.last_reel_time)}</strong>
            </div>
            <div>
              <label>Last defect</label>
              <strong>${formatTime(machine.last_defect_time)}</strong>
            </div>
          </div>
          <div class="machine-footer">
            <div>Status · ${machine.status_note || "—"}</div>
            <div>Phase mix · Active ${formatPercent(mix.active_pct)} · Inactive ${formatPercent(mix.inactive_pct)} · Learn ${formatPercent(mix.learn_pct)}</div>
            ${latestReview}
          </div>
        </article>`;
      })
      .join("");
  }

  function renderAlerts(alerts) {
    if (!refs.alertRail) return;
    if (refs.alertCountLabel) {
      refs.alertCountLabel.textContent = alerts.length ? `${alerts.length} alerts` : "";
    }
    if (!alerts.length) {
      refs.alertRail.innerHTML = `<div class="empty-state empty-state--healthy">All clear · No active alerts</div>`;
      return;
    }
    refs.alertRail.innerHTML = alerts
      .map(
        (alert) => `
        <article class="alert-card ${alert.severity} ${alert.status}">
          <div class="alert-card-head">
            <div>
              <p class="eyebrow">${alert.machine_name || ""}</p>
              <h3>${alert.title || ""}</h3>
            </div>
            <span class="state-chip ${mapSeverity(alert.severity)}">${formatSeverityLabel(alert.severity)}</span>
          </div>
          <p class="alert-message">${alert.message || ""}</p>
          <div class="alert-metrics">
            <label>Type<strong>${alert.alert_type || ""}</strong></label>
            <label>Status<strong>${(alert.status || "").toUpperCase()}</strong></label>
            <label>Last<strong>${formatTime(alert.last_seen_at)}</strong></label>
          </div>
          ${alert.status === "acknowledged" && alert.acknowledged_by ? `<div class="alert-meta">Ack by ${alert.acknowledged_by} (${formatTime(alert.acknowledged_at)})</div>` : ""}
          ${renderAlertActions(alert)}
        </article>`
      )
      .join("");
  }

  function renderAlertActions(alert) {
    if (alert.status === "resolved") return "";
    if (alert.status === "acknowledged") {
      return `<button type="button" class="ack-btn" data-alert-action="unack" data-alert-id="${alert.alert_event_id}">Unacknowledge</button>`;
    }
    return `<button type="button" class="ack-btn" data-alert-action="ack" data-alert-id="${alert.alert_event_id}">Acknowledge</button>`;
  }

  function renderFilterChips() {
    if (!refs.filterChips) return;
    const chips = [];
    if (state.selectedMachineId) {
      const label = getMachineName(state.selectedMachineId) || `Machine ${state.selectedMachineId}`;
      chips.push({ key: "machine", label: `Machine: ${label}` });
    }
    if (state.selectedSeverity) {
      chips.push({ key: "severity", label: `Status: ${severityLabels[state.selectedSeverity] || state.selectedSeverity}` });
    }
    if (!chips.length) {
      refs.filterChips.innerHTML = "";
      refs.filterChips.classList.add("hidden");
      return;
    }
    refs.filterChips.innerHTML = chips
      .map(
        (chip) => `
        <span class="filter-chip">
          ${chip.label}
          <button type="button" data-filter-chip="${chip.key}" aria-label="Clear ${chip.label}">×</button>
        </span>`
      )
      .join("");
    refs.filterChips.classList.remove("hidden");
  }

  async function loadPanelAlerts() {
    if (refs.alertRail) {
      refs.alertRail.innerHTML = `<div class="empty-state">Loading alerts…</div>`;
    }
    const params = new URLSearchParams();
    params.set("status", "active");
    if (state.selectedMachineId) {
      params.set("machine_id", state.selectedMachineId);
    }
    const res = await fetch(`/dashboard/live/api/alerts?${params.toString()}`);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `Failed to load alerts (${res.status})`);
    }
    const data = await res.json();
    state.alertFeed = data.alerts || [];
    renderAlerts(state.alertFeed);
    if (state.data) {
      renderMachines(state.data.machines || []);
    }
  }

  async function loadAlertHistory() {
    if (!refs.historyBody) return;
    refs.historyBody.innerHTML = `<div class="empty-state">Loading…</div>`;
    const status = refs.historyStatusSelect ? refs.historyStatusSelect.value : "all";
    const machine = refs.historyMachineSelect ? refs.historyMachineSelect.value : "all";
    const lookback = refs.historyLookbackSelect ? Number(refs.historyLookbackSelect.value) || 24 : 24;
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (lookback) params.set("lookback_hours", lookback);
    if (machine && machine !== "all") params.set("machine_id", machine);
    const res = await fetch(`/dashboard/live/api/alerts?${params.toString()}`);
    if (!res.ok) {
      const text = await res.text();
      refs.historyBody.innerHTML = `<div class="empty-state">Failed to load alerts: ${text || res.status}</div>`;
      return;
    }
    const data = await res.json();
    refs.historyBody.innerHTML = renderAlertHistory(data.alerts || []);
  }

  function renderAlertHistory(alerts) {
    if (!alerts.length) {
      return `<div class="empty-state">No alerts found for the selected filters.</div>`;
    }
    return alerts
      .map(
        (alert) => `
        <div class="history-row ${alert.severity}">
          <div class="history-row-head">
            <strong>${alert.title || alert.alert_type}</strong>
            <span>${formatTime(alert.last_seen_at)}</span>
          </div>
          <div class="history-row-meta">
            <span>${alert.machine_name || ""}</span>
            <span>${(alert.status || "").toUpperCase()}</span>
            <span>Severity: ${(alert.severity || "").toUpperCase()}</span>
          </div>
          <p>${alert.message || ""}</p>
        </div>`
      )
      .join("");
  }

  async function handleAlertAction(alertId, action) {
    if (!alertId) return;
    const url =
      action === "unack"
        ? `/dashboard/live/api/alerts/${alertId}/unacknowledge`
        : `/dashboard/live/api/alerts/${alertId}/acknowledge`;
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" } });
    if (!res.ok) {
      const text = await res.text();
      setStatus(`Alert update failed: ${text || res.status}`, "error");
      return;
    }
    await loadPanelAlerts();
  }

  async function handleAckAllAlerts() {
    const scopeLabel = state.selectedMachineId ? getMachineName(state.selectedMachineId) || `Machine ${state.selectedMachineId}` : "all machines";
    const confirmed = window.confirm(`Acknowledge all open alerts for ${scopeLabel}?`);
    if (!confirmed) return;
    const payload = {
      status: "active",
      acknowledged_by: "control-room",
    };
    if (state.selectedMachineId) {
      payload.machine_id = state.selectedMachineId;
    }
    const res = await fetch("/dashboard/live/api/alerts/acknowledge_all", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || "Failed to acknowledge alerts");
    }
    const data = await res.json();
    await loadPanelAlerts();
    setStatus(`Acknowledged ${data.acknowledged || 0} alert(s).`, "success");
  }

  function countAlertsForMachine(machineId, severity) {
    if (!machineId || !Array.isArray(state.alertFeed)) return 0;
    return state.alertFeed.filter((alert) => {
      const sameMachine = Number(alert.machine_id) === Number(machineId);
      if (!sameMachine) return false;
      if (severity === "critical") {
        return alert.severity === "critical" || alert.severity === "critical_alert";
      }
      return alert.severity === severity;
    }).length;
  }

  function getTopAlertForMachine(machineId) {
    if (!machineId || !Array.isArray(state.alertFeed)) return null;
    const severityOrder = { critical: 3, critical_alert: 3, warning: 2, attention: 2, info: 1 };
    const alerts = state.alertFeed
      .filter((alert) => Number(alert.machine_id) === Number(machineId))
      .sort((a, b) => (severityOrder[b.severity] || 0) - (severityOrder[a.severity] || 0));
    return alerts[0] || null;
  }

  function mapSeverity(severity = "") {
    if (!severity) return "info";
    if (severity === "critical_alert") return "critical";
    if (severity === "attention") return "warning";
    return severity;
  }

  function formatSeverityLabel(severity = "") {
    const mapped = mapSeverity(severity);
    return (severityLabels[mapped] || mapped || "info").toUpperCase();
  }

  function severityIcon(severity = "") {
    const mapped = mapSeverity(severity);
    if (mapped === "critical") return "✖";
    if (mapped === "warning") return "⚠";
    return "i";
  }

  function renderReviewSummary(summary) {
    if (!refs.reviewSummary) return;
    const pending = formatNumber(summary.pending_reels);
    if (refs.reviewSummaryLabel) {
      refs.reviewSummaryLabel.textContent = `Pending: ${pending}`;
    }
    const today = summary.decisions_today || {};
    const byMachine = summary.decisions_by_machine || [];
    const recent = (summary.recent_reviews || [])
      .map(
        (row) => `
        <li>
          <span>${row.machine_name || "Unknown press"} · ${row.reel_code || ""}</span>
          <strong>${formatDateTime(row.timestamp)}</strong>
          <small>${(row.decision || "").toUpperCase()}</small>
        </li>`
      )
      .join("");
    refs.reviewSummary.innerHTML = `
      <div class="review-summary-grid">
        <div>
          <h4>Decisions today</h4>
          <ul>
            <li><span>Pass</span><strong>${formatNumber(today.pass)}</strong></li>
            <li><span>Fail</span><strong>${formatNumber(today.fail)}</strong></li>
          </ul>
        </div>
        <div>
          <h4>Per-machine decisions</h4>
          <ul>
            ${
              byMachine.length
                ? byMachine
                    .map(
                      (row) =>
                        `<li><span>${row.machine_name || "Unknown"}</span><strong>Pass ${formatNumber(row.pass)} / Fail ${formatNumber(row.fail)}</strong></li>`
                    )
                    .join("")
                : "<li>No machine-level decisions</li>"
            }
          </ul>
        </div>
        <div>
          <h4>Recent reviews</h4>
          <ul>${recent || "<li>No recent reviews</li>"}</ul>
        </div>
      </div>`;
  }


  function renderEvents(events) {
    if (!refs.eventsTable) return;
    if (!events.length) {
      refs.eventsTable.innerHTML = `<div class="empty-state">No recent events.</div>`;
      return;
    }
    const rows = events
      .map(
        (event) => `
        <tr>
          <td>${formatTime(event.timestamp)}</td>
          <td>${event.machine_name || ""}</td>
          <td>${event.type || ""}</td>
          <td>${event.title || ""}</td>
          <td>${event.description || ""}</td>
        </tr>`
      )
      .join("");
    refs.eventsTable.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Machine</th>
            <th>Type</th>
            <th>Title</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  function bindEvents() {
    if (refs.lookbackSelect) {
      refs.lookbackSelect.addEventListener("change", () => {
        state.lookback = Number(refs.lookbackSelect.value) || 8;
        loadData();
      });
    }
    if (refs.severitySelect) {
      refs.severitySelect.addEventListener("change", () => {
        state.severityFilter = refs.severitySelect.value || "all";
        state.selectedSeverity = state.severityFilter !== "all" ? state.severityFilter : null;
        renderFilterChips();
        renderMachines(state.data?.machines || []);
      });
    }
    if (refs.searchInput) {
      refs.searchInput.addEventListener("input", (event) => {
        state.search = (event.target.value || "").trim().toLowerCase();
        renderMachines(state.data?.machines || []);
      });
    }
    if (refs.refreshBtn) {
      refs.refreshBtn.addEventListener("click", () => loadData());
    }
    if (refs.alertRail) {
      refs.alertRail.addEventListener("click", (event) => {
        const button = event.target.closest("[data-alert-action]");
        if (!button) return;
        const alertId = Number(button.dataset.alertId);
        const action = button.dataset.alertAction;
        handleAlertAction(alertId, action).catch((err) => setStatus(err.message, "error"));
      });
    }
    if (refs.filterChips) {
      refs.filterChips.addEventListener("click", handleFilterChipClick);
    }
    if (refs.ackAllBtn) {
      refs.ackAllBtn.addEventListener("click", () => {
        handleAckAllAlerts().catch((err) => setStatus(err.message, "error"));
      });
    }
    if (refs.machineGrid) {
      refs.machineGrid.addEventListener("click", handleMachineCardClick);
    }
    if (refs.openHistoryBtn && refs.historyDialog) {
      refs.openHistoryBtn.addEventListener("click", () => {
        if (refs.historyStatusSelect) {
          refs.historyStatusSelect.value = state.alertStatusFilter || "all";
        }
        if (refs.historyMachineSelect) {
          refs.historyMachineSelect.value = state.selectedMachineId ? String(state.selectedMachineId) : "all";
        }
        refs.historyDialog.showModal();
        loadAlertHistory().catch((err) => setStatus(`Alert history failed: ${err.message}`, "error"));
      });
    }
    document.addEventListener("click", (event) => {
      const closeBtn = event.target.closest("[data-close='alertHistoryDialog']");
      if (closeBtn && refs.historyDialog && refs.historyDialog.open) {
        refs.historyDialog.close();
      }
    });
    if (refs.historyRefreshBtn) {
      refs.historyRefreshBtn.addEventListener("click", () => {
        loadAlertHistory().catch((err) => setStatus(`Alert history failed: ${err.message}`, "error"));
      });
    }
    if (refs.historyStatusSelect) {
      refs.historyStatusSelect.addEventListener("change", () => {
        state.alertStatusFilter = refs.historyStatusSelect.value || "all";
        loadAlertHistory().catch((err) => setStatus(`Alert history failed: ${err.message}`, "error"));
      });
    }
    if (refs.historyMachineSelect) {
      refs.historyMachineSelect.addEventListener("change", () => {
        loadAlertHistory().catch((err) => setStatus(`Alert history failed: ${err.message}`, "error"));
      });
    }
    if (refs.historyLookbackSelect) {
      refs.historyLookbackSelect.addEventListener("change", () => {
        loadAlertHistory().catch((err) => setStatus(`Alert history failed: ${err.message}`, "error"));
      });
    }
  }

  function formatNumber(value) {
    if (value === null || value === undefined || Number.isNaN(value)) return "0";
    return Number(value).toLocaleString();
  }

  function formatPercent(value) {
    if (value === null || value === undefined || Number.isNaN(value)) return "0%";
    return `${Number(value).toFixed(1)}%`;
  }

  function formatTime(iso) {
    if (!iso) return "—";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleString([], { hour: "2-digit", minute: "2-digit", timeZone: "America/Chicago" });
  }

  function formatDateTime(iso) {
    if (!iso) return "—";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "America/Chicago" });
  }

  function handleFilterChipClick(event) {
    const btn = event.target.closest("button[data-filter-chip]");
    if (!btn) return;
    const key = btn.dataset.filterChip;
    if (key === "machine") {
      state.selectedMachineId = null;
      renderFilterChips();
      renderMachines(state.data?.machines || []);
      loadPanelAlerts().catch((err) => setStatus(err.message, "error"));
      return;
    }
    if (key === "severity") {
      state.severityFilter = "all";
      state.selectedSeverity = null;
      if (refs.severitySelect) refs.severitySelect.value = "all";
      renderFilterChips();
      renderMachines(state.data?.machines || []);
    }
  }

  function getMachineName(id) {
    const machines = (window.BSTLiveConfig && Array.isArray(window.BSTLiveConfig.machines) ? window.BSTLiveConfig.machines : []) || [];
    const match = machines.find((m) => Number(m.id) === Number(id));
    return match ? match.name : null;
  }

  function handleMachineCardClick(event) {
    const card = event.target.closest("[data-machine-id]");
    if (!card) return;
    const machineId = Number(card.dataset.machineId);
    if (!machineId) return;
    state.selectedMachineId = state.selectedMachineId === machineId ? null : machineId;
    renderFilterChips();
    renderMachines(state.data?.machines || []);
    loadPanelAlerts().catch((err) => setStatus(err.message, "error"));
  }

  document.addEventListener("DOMContentLoaded", () => {
    if (refs.lookbackSelect) {
      state.lookback = Number(refs.lookbackSelect.value) || state.lookback;
    }
    if (refs.severitySelect && refs.severitySelect.value && refs.severitySelect.value !== "all") {
      state.severityFilter = refs.severitySelect.value;
      state.selectedSeverity = refs.severitySelect.value;
    }
    bindEvents();
    renderFilterChips();
    loadData();
  });
})();
