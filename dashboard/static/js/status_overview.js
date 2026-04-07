(function () {
  const state = {
    board: null,
    refreshTimer: null,
    bannerTimer: null,
    bannerIndex: 0,
    selectedAlertId: null,
    alertModalReturnTarget: null,
    historyMachineFilter: "all",
    boardRequestSeq: 0,
    boardAbortController: null,
    boardVersion: 0,
    historyRenderedVersion: -1,
  };

  const refs = {
    overviewShell: document.getElementById("statusOverviewShell"),
    overviewLoading: document.getElementById("statusOverviewLoading"),
    lastRefresh: document.getElementById("statusLastRefresh"),
    bannerTrack: document.getElementById("statusBannerTrack"),
    historyOpenBtn: document.getElementById("statusHistoryOpenBtn"),
    historyMachineFilter: document.getElementById("statusHistoryMachineFilter"),
    historyTodayCounts: document.getElementById("statusHistoryTodayCounts"),
    historySummary: document.getElementById("statusHistorySummary"),
    cardGrid: document.getElementById("statusCardGrid"),
    newAlerts: document.getElementById("statusAlertsNew"),
    resolvedAlerts: document.getElementById("statusAlertsResolved"),
    historyModal: document.getElementById("statusHistoryModal"),
    alertModal: document.getElementById("statusAlertModal"),
    alertModalTitle: document.getElementById("statusAlertModalTitle"),
    alertModalBody: document.getElementById("statusAlertModalBody"),
    alertModalMessage: document.getElementById("statusAlertModalMessage"),
    alertFooter: document.getElementById("statusAlertFooter"),
    alertComment: document.getElementById("statusAlertComment"),
    makeReadyBtn: document.getElementById("statusAlertMakeReadyBtn"),
    resolveBtn: document.getElementById("statusAlertResolveBtn"),
  };

  async function loadBoard() {
    const requestSeq = state.boardRequestSeq + 1;
    state.boardRequestSeq = requestSeq;
    if (state.boardAbortController) {
      state.boardAbortController.abort();
    }
    const controller = new AbortController();
    state.boardAbortController = controller;
    try {
      let res = await fetch("/statusOverview/api/overview/refresh", {
        method: "POST",
        signal: controller.signal,
      });
      if (!res.ok && !state.board) {
        res = await fetch("/statusOverview/api/overview", { signal: controller.signal });
      }
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const board = await res.json();
      if (requestSeq !== state.boardRequestSeq) return;
      state.board = board;
      state.boardVersion += 1;
      render();
    } catch (err) {
      if (err?.name === "AbortError") return;
      if (requestSeq === state.boardRequestSeq) {
        renderLoadError(err);
      }
      throw err;
    } finally {
      if (state.boardAbortController === controller) {
        state.boardAbortController = null;
      }
    }
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
    if (refs.historyModal?.open) {
      renderHistory(data);
    }
    renderLastRefresh(data.generatedAt);
    scheduleRefresh();
  }

  function renderLoadError(err) {
    refs.overviewShell?.classList.remove("is-loading");
    if (refs.overviewLoading) {
      refs.overviewLoading.hidden = true;
      refs.overviewLoading.style.display = "none";
    }
    if (!state.board) {
      if (refs.bannerTrack) refs.bannerTrack.innerHTML = `<button type="button" class="status-banner-item healthy">Unable to load status board.</button>`;
      if (refs.cardGrid) refs.cardGrid.innerHTML = `<div class="empty-state">Status board refresh failed. ${escapeHtml(err?.message || "Please retry.")}</div>`;
    }
    if (refs.lastRefresh) refs.lastRefresh.textContent = `Refresh failed ${formatTime(new Date().toISOString())}`;
  }

  function renderLastRefresh(value) {
    if (!refs.lastRefresh) return;
    refs.lastRefresh.textContent = `Last refresh ${formatTime(value || new Date().toISOString())}`;
  }

  function renderHistory(data) {
    if (state.historyRenderedVersion === state.boardVersion) return;
    renderHistoryMachineFilter(data.cards || []);
    renderHistoryTodayCounts(data.cards || [], data.alerts || {});
    const filteredAlerts = filterAlertGroups(data.alerts || {});
    renderHistorySummary(filteredAlerts);
    renderAlertSection(refs.newAlerts, filteredAlerts.new || [], "No active alerts");
    renderAlertSection(refs.resolvedAlerts, filteredAlerts.resolved || [], "No recently closed alerts");
    state.historyRenderedVersion = state.boardVersion;
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
        const nextValue = node.getAttribute("data-history-machine") || "all";
        state.historyMachineFilter = state.historyMachineFilter === nextValue ? "all" : nextValue;
        state.historyRenderedVersion = -1;
        renderHistory(state.board || {});
      });
    });
  }

  function renderHistoryMachineButton(label, value) {
    const activeClass = state.historyMachineFilter === value ? " is-active" : "";
    return `<button type="button" class="status-history-machine-chip${activeClass}" data-history-machine="${escapeAttr(value)}">${escapeHtml(label)}</button>`;
  }

  function renderHistoryTodayCounts(cards, alertGroups) {
    if (!refs.historyTodayCounts) return;
    const totals = buildTodayAlertCounts(cards, alertGroups);
    refs.historyTodayCounts.innerHTML = totals
      .map(
        ({ machineName, count }) => `
          <div class="status-history-count-box">
            <span class="status-history-count-box-label">${escapeHtml(machineName)}</span>
            <strong class="status-history-count-box-value">${count}</strong>
          </div>
        `
      )
      .join("");
  }

  function buildTodayAlertCounts(cards, alertGroups) {
    const counts = new Map(
      (cards || []).map((card) => [String(card.machineName || "").trim(), 0]).filter(([machineName]) => Boolean(machineName))
    );
    const seen = new Set();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    [alertGroups.new || [], alertGroups.resolved || []].forEach((group) => {
      group.forEach((alert) => {
        if (!alert?.id || seen.has(alert.id) || !isAlertFromToday(alert, todayStart)) return;
        seen.add(alert.id);
        const machineName = String(alert.machineName || "").trim() || "Unknown";
        counts.set(machineName, (counts.get(machineName) || 0) + 1);
      });
    });

    return Array.from(counts.entries())
      .map(([machineName, count]) => ({ machineName, count }))
      .sort((left, right) => left.machineName.localeCompare(right.machineName, undefined, { numeric: true }));
  }

  function isAlertFromToday(alert, todayStart) {
    return [alert.createdAt, alert.acknowledgedAt, alert.resolvedAt].some((value) => {
      if (!value) return false;
      const date = new Date(value);
      return !Number.isNaN(date.getTime()) && date >= todayStart;
    });
  }

  function filterAlertGroups(alertGroups) {
    if (state.historyMachineFilter === "all") {
      return {
        new: (alertGroups.new || []).slice(),
        resolved: (alertGroups.resolved || []).slice(),
      };
    }
    return {
      new: (alertGroups.new || []).filter((alert) => String(alert.machineName || "").trim() === state.historyMachineFilter),
      resolved: (alertGroups.resolved || []).filter((alert) => String(alert.machineName || "").trim() === state.historyMachineFilter),
    };
  }

  function renderHistorySummary(alertGroups) {
    if (!refs.historySummary) return;
    const newAlerts = alertGroups.new || [];
    const resolvedAlerts = alertGroups.resolved || [];
    const addressedResolved = resolvedAlerts.filter((alert) => {
      const alertState = String(alert.alertState || "").toUpperCase();
      return alertState === "ACKNOWLEDGED" || alertState === "MAKE_READY";
    }).length;
    const autoCleared = resolvedAlerts.filter((alert) => String(alert.alertState || "").toUpperCase() === "SUPERSEDED").length;

    refs.historySummary.innerHTML = `
      <article class="status-history-summary-card status-history-summary-card--active">
        <span class="status-history-summary-label">Active Alerts</span>
        <strong>${newAlerts.length}</strong>
        <small>${newAlerts.length === 1 ? "Requires attention now" : "Require attention now"}</small>
      </article>
      <article class="status-history-summary-card status-history-summary-card--resolved">
        <span class="status-history-summary-label">Closed Recently</span>
        <strong>${resolvedAlerts.length}</strong>
        <div class="status-history-summary-meta">
          <span>Manual: ${addressedResolved}</span>
          <span>Superseded: ${autoCleared}</span>
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
      <button type="button" class="status-banner-item new" data-alert-id="${alert.id}">
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
            <div class="status-card-content">
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
                ${renderCardReelHistory(card.reelHistory || [])}
              </div>
            </div>
          </article>
        `
      )
      .join("");
    refs.cardGrid.querySelectorAll(".status-card[data-alert-id]").forEach((node) => {
      const alertId = Number(node.getAttribute("data-alert-id"));
      if (!alertId) return;
      node.addEventListener("click", (event) => {
        if (event.target?.closest(".status-card-reel-strip")) return;
        event.preventDefault();
        event.stopPropagation();
        openAlertModal(alertId, { returnTarget: null });
      });
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

  function renderCardReelHistory(history) {
    if (!history.length) return "";
    return `
      <div class="status-card-reel-strip">
        ${history
          .map((row) => {
            return `
              <span
                class="status-card-reel-chip ${escapeAttr(row.state || "healthy")}"
                tabindex="0"
              >
                ${escapeHtml(row.reelNumber || "--")}
                <span class="status-card-reel-tooltip" role="tooltip">
                  <strong>Reel ${escapeHtml(row.reelNumber || "--")}</strong>
                  <small>Job ${escapeHtml(row.jobNumber || "--")}</small>
                  <small>Feet ${escapeHtml(row.feet || "--")}</small>
                  <small>BST ${escapeHtml(row.bstPct || "--")}</small>
                  <small>RLM ${escapeHtml(row.rlmPoints || "--")}</small>
                </span>
              </span>
            `;
          })
          .join("")}
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
              <span class="status-alert-item-title">${escapeHtml(formatHistoryAlertHeading(alert))}</span>
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

  function formatHistoryAlertHeading(alert) {
    const machineName = String(alert.machineName || "").trim() || "Unknown";
    const state = String(alert.alertState || "").toUpperCase();
    if (state === "RESOLVED") return `${machineName} (RESOLVED)`;
    if (state === "ACKNOWLEDGED") return `${machineName} (Acked)`;
    if (state === "MAKE_READY") return `${machineName} (MAKE READY)`;
    if (state === "SUPERSEDED") return `${machineName} (SUPERSEDED)`;
    return machineName;
  }

  async function openAlertModal(alertId, options = {}) {
    const cachedAlert = findAlertInBoard(alertId);
    if (cachedAlert) {
      showAlertModal(cachedAlert, alertId, options);
      return;
    }
    const res = await fetch(`/statusOverview/api/alerts/${alertId}`);
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setMessage(refs.alertModalMessage, data.message || "Unable to load alert.");
      return;
    }
    showAlertModal(data.alert, alertId, options);
  }

  function findAlertInBoard(alertId) {
    const groups = state.board?.alerts || {};
    return [groups.new || [], groups.resolved || []].flat().find((alert) => Number(alert.id) === Number(alertId)) || null;
  }

  function showAlertModal(alert, alertId, options = {}) {
    state.selectedAlertId = alertId;
    state.alertModalReturnTarget = options.returnTarget || null;
    const closed = isClosedAlertState(alert.alertState);
    refs.alertModalTitle.textContent = buildAlertModalTitle(alert);
    refs.alertModal.dataset.alertState = String(alert.alertState || "").toLowerCase();
    refs.alertModalBody.innerHTML = renderAlertModalBody(alert);
    refs.alertComment.value = "";
    setMessage(refs.alertModalMessage, "");
    refs.makeReadyBtn.hidden = closed;
    refs.resolveBtn.hidden = closed;
    refs.makeReadyBtn.disabled = closed;
    refs.resolveBtn.disabled = closed;
    refs.alertFooter.hidden = closed;
    refs.alertFooter.style.display = closed ? "none" : "";
    if (state.alertModalReturnTarget === "history") {
      refs.historyModal?.close();
    }
    refs.alertModal.showModal();
  }

  function buildAlertModalTitle(alert) {
    const machine = String(alert.machineName || "").trim();
    const title = String(alert.alertTitle || "Alert").trim();
    const alertState = String(alert.alertState || "").toUpperCase();
    const resolvedSuffix = alertState === "RESOLVED" ? " (RESOLVED)" : alertState === "MAKE_READY" ? " (MAKE READY)" : alertState === "ACKNOWLEDGED" ? " (Acked)" : alertState === "SUPERSEDED" ? " (SUPERSEDED)" : "";
    if (machine && title) return `${machine.toUpperCase()} - ${title}${resolvedSuffix}`;
    return `${title || "Alert"}${resolvedSuffix}`;
  }

  function isClosedAlertState(alertState) {
    return ["ACKNOWLEDGED", "MAKE_READY", "RESOLVED", "SUPERSEDED"].includes(String(alertState || "").toUpperCase());
  }

  function renderAlertModalBody(alert) {
    const metadata = alert.metadata || {};
    const bst = metadata.bst || {};
    const rlm = metadata.rlm || {};
    const summaryLines = buildAlertSummaryLines(alert, bst, rlm);
    const closeComment = alert.acknowledgeComment || alert.resolvedComment;
    const closeLabel = String(alert.alertState || "").toUpperCase() === "ACKNOWLEDGED" ? "Acknowledged Comment" : "Close Comment";
    const noteMarkup = [
      closeComment ? `<div class="status-alert-note status-alert-note--resolved"><label>${escapeHtml(closeLabel)}</label><strong>${escapeHtml(closeComment)}</strong></div>` : "",
    ]
      .filter(Boolean)
      .join("");
    return `
      <section class="status-alert-meta-grid">
        ${renderMetaCard("Created", formatTime(alert.createdAt))}
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
    const source = String(alert.alertSource || "").toUpperCase();
    const lines = [];
    if (source === "BST" || source === "BOTH" || title.includes("BST")) {
      const count = bst.consecutiveOffReels || 0;
      lines.push(`BST OFF for ${count} consecutive reels`);
    }
    if (
      source === "RLM"
      || source === "BOTH"
      || title.includes("RLM")
      || title.includes("REPEAT LENGTH")
    ) {
      const count = rlm.consecutiveOffReels || 0;
      lines.push(`Repeat length Monitoring OFF for ${count} consecutive reels`);
    }
    if (!lines.length) {
      lines.push("Critical machine alert is active.");
    }
    return lines;
  }

  async function submitAlertAction(action) {
    if (!state.selectedAlertId) return;
    const alertId = state.selectedAlertId;
    const comment = (refs.alertComment.value || "").trim();
    const res = await fetch(`/statusOverview/api/alerts/${alertId}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comment }),
    });
    const data = await res.json();
    setMessage(refs.alertModalMessage, data.message || "");
    if (!res.ok || !data.ok) return;
    if (action === "make-ready") {
      applyOptimisticMakeReady(alertId);
    } else if (action === "acknowledge") {
      applyOptimisticAcknowledged(alertId);
    }
    refs.alertModal.close();
    state.alertModalReturnTarget = null;
    loadBoard().catch((err) => console.error(err));
  }

  function applyOptimisticMakeReady(alertId) {
    const cards = state.board?.cards || [];
    const card = cards.find((item) => Number(item.alertId) === Number(alertId));
    if (!card) return;
    card.state = "make-ready";
    card.statusText = "Make Ready";
    card.workflowBadge = "Make Ready";
    card.alertId = null;
    markCurrentReelChip(card, "make-ready");
    render();
  }

  function markCurrentReelChip(card, chipState) {
    const history = card.reelHistory || [];
    const currentReel = String(card.reelNumber || "").trim().toLowerCase();
    const chip = history.find((row) => String(row.reelNumber || "").trim().toLowerCase() === currentReel) || history[0];
    if (chip) chip.state = chipState;
  }

  function applyOptimisticAcknowledged(alertId) {
    const cards = state.board?.cards || [];
    const card = cards.find((item) => Number(item.alertId) === Number(alertId));
    if (!card) return;
    card.state = "critical";
    card.statusText = appendStatusSuffix(card.statusText || "Alert", "Acked");
    card.workflowBadge = "Acknowledged";
    card.alertId = null;
    render();
  }

  function appendStatusSuffix(value, suffix) {
    const text = String(value || "").replace(/\s+\((ACKNOWLEDGED|ACKED|RESOLVED|SUPERSEDED|MAKE READY)\)$/i, "");
    return `${text} (${suffix})`;
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
      loadBoard().catch((err) => console.error(err));
    }, 300000);
  }

  function bindEvents() {
    bindGuardedClick(refs.resolveBtn, () => submitAlertAction("acknowledge").catch((err) => console.error(err)));
    bindGuardedClick(refs.makeReadyBtn, () => submitAlertAction("make-ready").catch((err) => console.error(err)));
    bindGuardedClick(refs.historyOpenBtn, () => {
      refs.historyModal?.showModal();
      renderHistory(state.board || {});
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
    return escapeHtml(value);
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
    loadBoard().catch((err) => console.error(err));
  });
})();
