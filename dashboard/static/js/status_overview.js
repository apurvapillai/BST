(function () {
  const state = {
    board: null,
    settings: null,
    refreshTimer: null,
    bannerTimer: null,
    bannerIndex: 0,
    selectedAlertId: null,
    alertModalReturnTarget: null,
    historyMachineFilter: "all",
  };

  const refs = {
    overviewShell: document.getElementById("statusOverviewShell"),
    overviewLoading: document.getElementById("statusOverviewLoading"),
    bannerTrack: document.getElementById("statusBannerTrack"),
    historyOpenBtn: document.getElementById("statusHistoryOpenBtn"),
    historyMachineFilter: document.getElementById("statusHistoryMachineFilter"),
    historySummary: document.getElementById("statusHistorySummary"),
    cardGrid: document.getElementById("statusCardGrid"),
    newAlerts: document.getElementById("statusAlertsNew"),
    acknowledgedAlerts: document.getElementById("statusAlertsAcknowledged"),
    resolvedAlerts: document.getElementById("statusAlertsResolved"),
    historyModal: document.getElementById("statusHistoryModal"),
    alertModal: document.getElementById("statusAlertModal"),
    alertModalTitle: document.getElementById("statusAlertModalTitle"),
    alertModalBody: document.getElementById("statusAlertModalBody"),
    alertModalMessage: document.getElementById("statusAlertModalMessage"),
    alertFooter: document.getElementById("statusAlertFooter"),
    alertComment: document.getElementById("statusAlertComment"),
    acknowledgeBtn: document.getElementById("statusAlertAcknowledgeBtn"),
    resolveBtn: document.getElementById("statusAlertResolveBtn"),
    settingsOpenBtn: document.getElementById("statusSettingsOpenBtn"),
    settingsModal: document.getElementById("statusSettingsModal"),
    settingsMachineSelect: document.getElementById("statusSettingsMachineSelect"),
    settingsBstGreen: document.getElementById("settingsBstGreen"),
    settingsBstYellow: document.getElementById("settingsBstYellow"),
    settingsRlmFeet: document.getElementById("settingsRlmFeet"),
    settingsRlmGreen: document.getElementById("settingsRlmGreen"),
    settingsRlmYellow: document.getElementById("settingsRlmYellow"),
    settingsApplyAllBtn: document.getElementById("statusSettingsApplyAllBtn"),
    settingsMessage: document.getElementById("statusSettingsMessage"),
  };

  async function loadBoard() {
    const res = await fetch("/statusOverview/api/overview");
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    state.board = await res.json();
    render();
  }

  async function loadSettings() {
    const currentMachineId = refs.settingsMachineSelect?.value || "all";
    const res = await fetch("/statusOverview/api/settings");
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    state.settings = await res.json();
    renderSettingsModal(currentMachineId);
  }

  function render() {
    const data = state.board || {};
    if (refs.historyOpenBtn) refs.historyOpenBtn.hidden = false;
    refs.overviewShell?.classList.remove("is-loading");
    if (refs.overviewLoading) {
      refs.overviewLoading.hidden = true;
      refs.overviewLoading.style.display = "none";
    }
    renderBanner(data.bannerAlerts || []);
    renderCards(data.cards || []);
    renderHistory(data);
    scheduleRefresh();
  }

  function renderHistory(data) {
    renderHistoryMachineFilter(data.cards || []);
    const filteredAlerts = filterAlertGroups(data.alerts || {});
    renderHistorySummary(filteredAlerts);
    renderAlertSection(refs.newAlerts, filteredAlerts.new || [], "No active alerts");
    renderAlertSection(refs.acknowledgedAlerts, filteredAlerts.acknowledged || [], "No acknowledged alerts");
    renderAlertSection(refs.resolvedAlerts, filteredAlerts.resolved || [], "No recently resolved alerts");
  }

  function renderHistoryMachineFilter(cards) {
    if (!refs.historyMachineFilter) return;
    const machines = Array.from(
      new Set(
        (cards || [])
          .map((card) => String(card.machineName || "").trim())
          .filter(Boolean)
      )
    ).sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
    const available = new Set(["all"].concat(machines));
    if (!available.has(state.historyMachineFilter)) {
      state.historyMachineFilter = "all";
    }
    refs.historyMachineFilter.innerHTML = [
      renderHistoryMachineButton("All Machines", "all"),
      ...machines.map((machine) => renderHistoryMachineButton(machine, machine)),
    ].join("");
    refs.historyMachineFilter.querySelectorAll("[data-history-machine]").forEach((node) => {
      bindGuardedClick(node, () => {
        state.historyMachineFilter = node.getAttribute("data-history-machine") || "all";
        renderHistory(state.board || {});
      });
    });
  }

  function renderHistoryMachineButton(label, value) {
    const activeClass = state.historyMachineFilter === value ? " is-active" : "";
    return `<button type="button" class="status-history-machine-chip${activeClass}" data-history-machine="${escapeAttr(value)}">${escapeHtml(label)}</button>`;
  }

  function filterAlertGroups(alertGroups) {
    if (state.historyMachineFilter === "all") {
      return {
        new: (alertGroups.new || []).slice(),
        acknowledged: (alertGroups.acknowledged || []).slice(),
        resolved: (alertGroups.resolved || []).slice(),
      };
    }
    return {
      new: (alertGroups.new || []).filter((alert) => String(alert.machineName || "").trim() === state.historyMachineFilter),
      acknowledged: (alertGroups.acknowledged || []).filter((alert) => String(alert.machineName || "").trim() === state.historyMachineFilter),
      resolved: (alertGroups.resolved || []).filter((alert) => String(alert.machineName || "").trim() === state.historyMachineFilter),
    };
  }

  function renderHistorySummary(alertGroups) {
    if (!refs.historySummary) return;
    const newAlerts = alertGroups.new || [];
    const acknowledgedAlerts = alertGroups.acknowledged || [];
    const resolvedAlerts = alertGroups.resolved || [];
    const addressedResolved = resolvedAlerts.filter((alert) => {
      const resolvedBy = String(alert.resolvedBy || "").toLowerCase();
      return Boolean(alert.acknowledgedAt) || (resolvedBy && resolvedBy !== "system");
    }).length;
    const autoCleared = resolvedAlerts.filter((alert) => !alert.resolvedBy || String(alert.resolvedBy).toLowerCase() === "system").length;

    refs.historySummary.innerHTML = `
      <article class="status-history-summary-card status-history-summary-card--active">
        <span class="status-history-summary-label">Active Alerts</span>
        <strong>${newAlerts.length}</strong>
        <small>${newAlerts.length === 1 ? "Requires attention now" : "Require attention now"}</small>
      </article>
      <article class="status-history-summary-card status-history-summary-card--addressed">
        <span class="status-history-summary-label">Being Addressed</span>
        <strong>${acknowledgedAlerts.length}</strong>
        <small>${acknowledgedAlerts.length === 1 ? "Alert is being worked" : "Alerts are being worked"}</small>
      </article>
      <article class="status-history-summary-card status-history-summary-card--resolved">
        <span class="status-history-summary-label">Resolved Recently</span>
        <strong>${resolvedAlerts.length}</strong>
        <div class="status-history-summary-meta">
          <span>Addressed: ${addressedResolved}</span>
          <span>Auto Cleared: ${autoCleared}</span>
        </div>
      </article>
    `;
  }

  function renderBanner(alerts) {
    if (!refs.bannerTrack) return;
    if (state.bannerTimer) clearTimeout(state.bannerTimer);
    if (!alerts.length) {
      refs.bannerTrack.innerHTML = `<button type="button" class="status-banner-item healthy">All clear. No active critical alerts.</button>`;
      return;
    }
    if (state.bannerIndex >= alerts.length) state.bannerIndex = 0;
    const alert = alerts[state.bannerIndex];
    const sideMeta = `${alert.reelNumber ? `Reel ${escapeHtml(alert.reelNumber)}` : ""}${alert.jobNumber ? `${alert.reelNumber ? " - " : ""}Job ${escapeHtml(alert.jobNumber)}` : ""}`;
    refs.bannerTrack.innerHTML = `
      <button type="button" class="status-banner-item ${alert.alertState === "ACKNOWLEDGED" ? "acknowledged" : "new"}" data-alert-id="${alert.id}">
        <span class="status-banner-main">
          <span class="status-banner-title">${escapeHtml(alert.alertTitle || "")}</span>
          <span class="status-banner-machine">${escapeHtml(alert.machineName || "")}</span>
        </span>
        <span class="status-banner-side">
          <span class="status-banner-side-main">${sideMeta || "--"}</span>
          <span class="status-banner-time">${escapeHtml(formatTime(alert.createdAt))}</span>
        </span>
      </button>
    `;
    bindGuardedClick(refs.bannerTrack.querySelector("[data-alert-id]"), () => openAlertModal(alert.id, { returnTarget: null }));
    state.bannerTimer = window.setTimeout(() => stepBanner(1), 5000);
  }

  function renderCards(cards) {
    if (!refs.cardGrid) return;
    if (!cards.length) {
      refs.cardGrid.innerHTML = `<div class="empty-state">No machines found.</div>`;
      return;
    }
    refs.cardGrid.innerHTML = cards
      .map(
        (card) => `
          <article id="machine-card-${slugify(card.machineKey)}" class="status-card ${escapeAttr(card.state)}" data-alert-id="${card.alertId || ""}">
            <div class="status-card-header">
              <div class="status-card-title-group">
                <h3>${escapeHtml(card.machineName || "")}</h3>
              </div>
              <span class="status-card-header-time">Last Reel - ${escapeHtml(formatTime(card.lastUpdated))}</span>
            </div>
            <div class="status-card-status-band">
              <div class="status-card-status">${escapeHtml(card.statusText || "")}</div>
            </div>
            <div class="status-card-secondary">
              <div class="status-card-info-panel">
                <div class="status-card-meta-row">
                  <span class="status-card-meta-label">Job</span>
                  <span class="status-card-meta-value">${escapeHtml(card.jobNumber || "No job")}</span>
                </div>
                <div class="status-card-meta-row">
                  <span class="status-card-meta-label">Reel</span>
                  <span class="status-card-meta-value">${escapeHtml(card.reelNumber || "No reel")}</span>
                </div>
                <div class="status-card-meta-row">
                  <span class="status-card-meta-label">Feet</span>
                  <span class="status-card-meta-value">${escapeHtml(card.metrics?.lastReelFeet || "--")}</span>
                </div>
              </div>
              <div class="status-substatus-row">
                ${renderBox(card.bstBox)}
                ${renderBox(card.rlmBox)}
              </div>
            </div>
          </article>
        `
      )
      .join("");
    refs.cardGrid.querySelectorAll(".status-card[data-alert-id]").forEach((node) => {
      const alertId = Number(node.getAttribute("data-alert-id"));
      if (!alertId) return;
      bindGuardedClick(node, () => openAlertModal(alertId, { returnTarget: null }));
    });
  }

  function renderBox(box) {
    return `
      <div class="status-substatus ${escapeAttr(box.state || "neutral")}">
        <span class="status-substatus-label">${escapeHtml(box.label || "")}</span>
        <strong>${escapeHtml(box.detail || "")}</strong>
        ${box.subdetail ? `<small>${escapeHtml(box.subdetail)}</small>` : ""}
      </div>
    `;
  }

  function renderAlertSection(target, alerts, emptyMessage) {
    if (!target) return;
    if (!alerts.length) {
      target.innerHTML = `<div class="empty-state">${escapeHtml(emptyMessage)}</div>`;
      return;
    }
    target.innerHTML = alerts
      .map(
        (alert) => `
          <button type="button" class="status-alert-item ${escapeAttr((alert.alertState || "").toLowerCase())}" data-alert-id="${alert.id}">
            <span class="status-alert-item-header">
              <span class="status-alert-item-title">${escapeHtml(alert.machineName || "")}</span>
              <span class="status-alert-item-created">${escapeHtml(formatTime(alert.createdAt))}</span>
            </span>
            <span class="status-alert-item-meta">${escapeHtml(alert.alertTitle || "")}</span>
            <span class="status-alert-item-meta">${alert.reelNumber ? `Reel ${escapeHtml(alert.reelNumber)}` : ""}${alert.jobNumber ? `${alert.reelNumber ? " - " : ""}Job ${escapeHtml(alert.jobNumber)}` : ""}</span>
            <span class="status-alert-item-time">${escapeHtml(formatAgo(alert.resolvedAt || alert.acknowledgedAt || alert.createdAt))}</span>
          </button>
        `
      )
      .join("");
    target.querySelectorAll("[data-alert-id]").forEach((node) => {
      bindGuardedClick(node, () => openAlertModal(Number(node.getAttribute("data-alert-id")), { returnTarget: "history" }));
    });
  }

  async function openAlertModal(alertId, options = {}) {
    const res = await fetch(`/statusOverview/api/alerts/${alertId}`);
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setMessage(refs.alertModalMessage, data.message || "Unable to load alert.");
      return;
    }
    state.selectedAlertId = alertId;
    state.alertModalReturnTarget = options.returnTarget || null;
    const alert = data.alert;
    refs.alertModalTitle.textContent = buildAlertModalTitle(alert);
    refs.alertModal.dataset.alertState = String(alert.alertState || "").toLowerCase();
    refs.alertModalBody.innerHTML = renderAlertModalBody(alert);
    refs.alertComment.value = "";
    setMessage(refs.alertModalMessage, "");
    refs.acknowledgeBtn.hidden = alert.alertState !== "NEW";
    refs.resolveBtn.hidden = alert.alertState === "RESOLVED";
    refs.acknowledgeBtn.disabled = alert.alertState !== "NEW";
    refs.resolveBtn.disabled = alert.alertState === "RESOLVED";
    refs.alertFooter.hidden = alert.alertState === "RESOLVED";
    refs.alertFooter.style.display = alert.alertState === "RESOLVED" ? "none" : "";
    if (state.alertModalReturnTarget === "history") {
      refs.historyModal?.close();
    }
    refs.alertModal.showModal();
  }

  function buildAlertModalTitle(alert) {
    const machine = String(alert.machineName || "").trim();
    const title = String(alert.alertTitle || "Alert").trim();
    const resolvedSuffix = String(alert.alertState || "").toUpperCase() === "RESOLVED" ? " (RESOLVED)" : "";
    if (machine && title) return `${machine.toUpperCase()} - ${title}${resolvedSuffix}`;
    return `${title || "Alert"}${resolvedSuffix}`;
  }

  function renderAlertModalBody(alert) {
    const metadata = alert.metadata || {};
    const bst = metadata.bst || {};
    const rlm = metadata.rlm || {};
    const summaryLines = buildAlertSummaryLines(alert, bst, rlm);
    const noteMarkup = [
      alert.acknowledgeComment ? `<div class="status-alert-note status-alert-note--acknowledged"><label>Acknowledge Comment</label><strong>${escapeHtml(alert.acknowledgeComment)}</strong></div>` : "",
      alert.resolvedComment ? `<div class="status-alert-note status-alert-note--resolved"><label>Resolved Comment</label><strong>${escapeHtml(alert.resolvedComment)}</strong></div>` : "",
    ]
      .filter(Boolean)
      .join("");
    return `
      <section class="status-alert-meta-grid">
        ${renderMetaCard("Created", formatTime(alert.createdAt))}
        ${renderMetaCard("Resolved", alert.resolvedAt ? formatTime(alert.resolvedAt) : "")}
      </section>
      <section class="status-alert-summary-card">
        <h4>Alert Summary</h4>
        ${renderSummaryLines(summaryLines)}
      </section>
      ${noteMarkup ? `<section class="status-alert-note-stack">${noteMarkup}</section>` : ""}
    `;
  }

  function renderMetaCard(label, value) {
    return `
      <div class="status-alert-meta-card">
        <label>${escapeHtml(label)}</label>
        <strong>${escapeHtml(String(value ?? "--"))}</strong>
      </div>
    `;
  }

  function renderSummaryLines(lines) {
    if (!lines.length) {
      return `<div class="status-alert-summary-list"><div class="status-alert-summary-line">Critical machine alert is active.</div></div>`;
    }
    return `
      <div class="status-alert-summary-list">
        ${lines
          .map(
            (line) => `
              <div class="status-alert-summary-line">${escapeHtml(line)}</div>
            `
          )
          .join("")}
      </div>
    `;
  }

  function buildAlertSummaryLines(alert, bst, rlm) {
    const title = String(alert.alertTitle || "").toUpperCase();
    const lines = [];
    if (title.includes("BST")) {
      const count = bst.consecutiveOffReels || 0;
      lines.push(`BST OFF for ${count} consecutive reels`);
    }
    if (title.includes("RLM")) {
      const count = rlm.consecutiveOffReels || 0;
      lines.push(`RLM OFF for ${count} consecutive reels`);
    }
    if (!lines.length) {
      lines.push("Critical machine alert is active.");
    }
    return lines;
  }

  async function submitAlertAction(action) {
    if (!state.selectedAlertId) return;
    const comment = (refs.alertComment.value || "").trim();
    if (!comment) {
      setMessage(refs.alertModalMessage, "Comment is required.");
      return;
    }
    const res = await fetch(`/statusOverview/api/alerts/${state.selectedAlertId}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comment }),
    });
    const data = await res.json();
    setMessage(refs.alertModalMessage, data.message || "");
    if (!res.ok || !data.ok) return;
    refs.alertModal.close();
    state.alertModalReturnTarget = null;
    await loadBoard();
  }

  function renderSettingsModal(selectedMachineId = "all") {
    if (!state.settings || !refs.settingsMachineSelect) return;
    const machineOptions = [{ id: "all", name: "All Machines" }].concat(state.settings.machines || []);
    refs.settingsMachineSelect.innerHTML = machineOptions
      .map((machine) => `<option value="${escapeAttr(machine.id)}">${escapeHtml(machine.name)}</option>`)
      .join("");
    const optionValues = new Set(machineOptions.map((machine) => String(machine.id)));
    const nextSelection = optionValues.has(String(selectedMachineId)) ? String(selectedMachineId) : "all";
    refs.settingsMachineSelect.value = nextSelection;
    applySettingsForm(nextSelection);
  }

  function applySettingsForm(machineId) {
    if (!state.settings) return;
    const values = machineId === "all"
      ? state.settings.global
      : state.settings.overrides?.[String(machineId)] || state.settings.global;
    refs.settingsBstGreen.value = values.bst_green_pct;
    refs.settingsBstYellow.value = values.bst_yellow_pct;
    refs.settingsRlmFeet.value = values.rlm_min_qualifying_feet;
    refs.settingsRlmGreen.value = values.rlm_green_pts_per_1000_ft;
    refs.settingsRlmYellow.value = values.rlm_yellow_pts_per_1000_ft;
    setMessage(refs.settingsMessage, "");
  }

  function collectSettingsFormValues() {
    return {
      bst_green_pct: Number(refs.settingsBstGreen.value),
      bst_yellow_pct: Number(refs.settingsBstYellow.value),
      bst_critical_active_pct: Number(refs.settingsBstYellow.value) / 2 || 5,
      rlm_min_qualifying_feet: Number(refs.settingsRlmFeet.value),
      rlm_green_pts_per_1000_ft: Number(refs.settingsRlmGreen.value),
      rlm_yellow_pts_per_1000_ft: Number(refs.settingsRlmYellow.value),
      rlm_min_points_per_1000_ft: Number(refs.settingsRlmYellow.value) / 1.5 || 8,
    };
  }

  async function saveSettings(action) {
    const machineId = refs.settingsMachineSelect.value;
    const url =
      action === "apply-all"
        ? "/statusOverview/api/settings/apply-all"
        : action === "reset"
          ? "/statusOverview/api/settings/reset"
          : "/statusOverview/api/settings/save";
    const payload = action === "reset"
      ? { machineId }
      : action === "apply-all"
        ? { values: collectSettingsFormValues() }
        : { machineId, values: collectSettingsFormValues() };
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    setMessage(refs.settingsMessage, data.message || "");
    if (!res.ok || !data.ok) return;
    await loadSettings();
    await loadBoard();
    applySettingsForm(refs.settingsMachineSelect.value);
  }

  async function focusAlert(alertId) {
    const machineKey = (state.board?.cards || []).find((card) => Number(card.alertId) === Number(alertId))?.machineKey;
    if (machineKey) {
      document.getElementById(`machine-card-${slugify(machineKey)}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    await openAlertModal(alertId, { returnTarget: null });
  }

  function stepBanner(direction) {
    const alerts = state.board?.bannerAlerts || [];
    if (!alerts.length) return;
    state.bannerIndex = (state.bannerIndex + direction + alerts.length) % alerts.length;
    renderBanner(alerts);
  }

  function scheduleRefresh() {
    if (state.refreshTimer) clearTimeout(state.refreshTimer);
    state.refreshTimer = window.setTimeout(() => {
      Promise.all([loadBoard(), loadSettings()]).catch((err) => console.error(err));
    }, 300000);
  }

  function bindEvents() {
    bindGuardedClick(refs.acknowledgeBtn, () => submitAlertAction("acknowledge").catch((err) => console.error(err)));
    bindGuardedClick(refs.resolveBtn, () => submitAlertAction("resolve").catch((err) => console.error(err)));
    bindGuardedClick(refs.historyOpenBtn, () => refs.historyModal?.showModal());
    bindGuardedClick(refs.settingsOpenBtn, () => refs.settingsModal?.showModal());
    refs.settingsMachineSelect?.addEventListener("change", (event) => applySettingsForm(event.target.value));
    bindGuardedClick(refs.settingsApplyAllBtn, () => {
      const action = refs.settingsMachineSelect?.value === "all" ? "apply-all" : "save";
      saveSettings(action).catch((err) => console.error(err));
    });
    document.querySelectorAll("[data-close]").forEach((node) => {
      bindGuardedClick(node, () => {
        const target = document.getElementById(node.getAttribute("data-close"));
        target?.close();
      });
    });
    refs.alertModal?.addEventListener("close", handleAlertModalClosed);
    refs.alertModal?.addEventListener("cancel", () => {
      window.setTimeout(handleAlertModalClosed, 0);
    });
  }

  function handleAlertModalClosed() {
    if (state.alertModalReturnTarget === "history") {
      refs.historyModal?.showModal();
    }
    state.alertModalReturnTarget = null;
  }

  function bindGuardedClick(node, handler) {
    if (!node || typeof handler !== "function") return;
    node.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      handler(event);
    });
  }

  function formatTime(value) {
    if (!value) return "No recent update";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function formatAgo(value) {
    if (!value) return "";
    const seconds = Math.max(Math.floor((Date.now() - new Date(value).getTime()) / 1000), 0);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  function setMessage(node, message) {
    if (node) node.textContent = message || "";
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttr(value) {
    return String(value ?? "");
  }

  function slugify(value) {
    return String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
  }

  document.addEventListener("DOMContentLoaded", () => {
    bindEvents();
    Promise.all([loadBoard(), loadSettings()]).catch((err) => console.error(err));
  });
})();
