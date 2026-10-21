(function () {
  const BOARD_REFRESH_MS = 30000;
  const BOARD_CACHE_KEY = "status-overview-board-v2";
  const BOARD_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
  const changeViews = new Map();
  const changeDetailViews = new Map();

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
    changeModal: document.getElementById("overviewChangeModal"),
    changeModalTitle: document.getElementById("overviewChangeModalTitle"),
    changeModalSubtitle: document.getElementById("overviewChangeModalSubtitle"),
    changeModalBody: document.getElementById("overviewChangeModalBody"),
    changeModalClose: document.getElementById("overviewChangeModalClose"),
  };

  function restoreCachedBoard() {
    try {
      const cached = JSON.parse(window.localStorage.getItem(BOARD_CACHE_KEY) || "null");
      if (!cached?.savedAt || !cached?.board) return false;
      if (Date.now() - Number(cached.savedAt) > BOARD_CACHE_MAX_AGE_MS) return false;
      state.board = cached.board;
      state.boardVersion += 1;
      render();
      return true;
    } catch (error) {
      return false;
    }
  }

  function cacheBoard(board) {
    try {
      const serialized = JSON.stringify({ savedAt: Date.now(), board });
      if (serialized.length <= 2_000_000) {
        window.localStorage.setItem(BOARD_CACHE_KEY, serialized);
      }
    } catch (error) {
      // Storage can be unavailable or full; live loading still works.
    }
  }

  async function loadBoard({ syncAlerts = true } = {}) {
    const requestSeq = state.boardRequestSeq + 1;
    state.boardRequestSeq = requestSeq;
    if (state.boardAbortController) {
      state.boardAbortController.abort();
    }
    const controller = new AbortController();
    state.boardAbortController = controller;
    try {
      let res = await fetch(
        syncAlerts ? "/statusOverview/api/overview/refresh" : "/statusOverview/api/overview",
        syncAlerts ? { method: "POST", signal: controller.signal } : { signal: controller.signal }
      );
      if (!res.ok && !state.board) {
        res = await fetch("/statusOverview/api/overview", { signal: controller.signal });
      }
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const board = await res.json();
      if (requestSeq !== state.boardRequestSeq) return;
      state.board = board;
      state.boardVersion += 1;
      cacheBoard(board);
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
    const systemResolved = resolvedAlerts.filter((alert) => String(alert.alertState || "").toUpperCase() === "RESOLVED").length;

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
          <span>System: ${systemResolved}</span>
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
    changeViews.clear();
    changeDetailViews.clear();
    if (!cards.length) {
      refs.cardGrid.innerHTML = `<div class="empty-state">No machines found.</div>`;
      return;
    }
    refs.cardGrid.innerHTML = cards
      .map(
        (card) => {
          const orderNumber = card.orderNumber || orderNumberFromDisplay(card.jobNumber) || "--";
          return `
          <article id="machine-card-${slugify(card.machineKey)}" class="status-card ${escapeAttr(card.state)}" data-alert-id="${card.alertId || ""}">
            <header class="status-card-header">
              <div class="status-card-title-group">
                <h3>${escapeHtml(card.machineName || "Press")}</h3>
                <span class="status-card-header-reel">${escapeHtml(card.reelNumber || "--")}</span>
              </div>
              <span class="status-card-header-time">${escapeHtml(formatLastReelTime(card.lastUpdated))}</span>
            </header>
            <div class="status-card-body">
              <div class="status-card-job-row">
                <span class="status-card-job" title="${escapeAttr(orderNumber)}">Order ${escapeHtml(orderNumber)}</span>
                <span class="status-card-feet">${escapeHtml(card.metrics?.lastReelFeet || "--")}</span>
              </div>
              <div class="status-card-secondary">
                ${renderCardReelHistory(card.reelHistory || [])}
              </div>
            </div>
          </article>
        `;
        }
      )
      .join("");
    refs.cardGrid.querySelectorAll(".status-card[data-alert-id]").forEach((node) => {
      const alertId = Number(node.getAttribute("data-alert-id"));
      if (!alertId) return;
      node.addEventListener("click", (event) => {
        if (event.target?.closest(".status-card-reel-history")) return;
        event.preventDefault();
        event.stopPropagation();
        openAlertModal(alertId, { returnTarget: null });
      });
    });
  }

  function orderNumberFromDisplay(value) {
    const display = String(value || "").trim();
    if (!display) return "";
    const separator = display.indexOf(" - ");
    return separator >= 0 ? display.slice(0, separator).trim() : display;
  }

  function renderCardReelHistory(history) {
    if (!history.length) return "";
    const reels = history.slice(0, 7);
    return `
      <div class="status-card-reel-history">
        <div class="status-card-reel-matrix">
          ${renderReelMatrixRow("BST", reels.map((row) => renderReelMatrixChip(row, "BST", "bstState")))}
          ${renderReelMatrixRow("RLM", reels.map((row) => renderReelMatrixChip(row, "RLM", "rlmState")))}
        </div>
      </div>
    `;
  }

  function renderReelMatrixRow(label, cells) {
    return `
      <div class="status-card-reel-matrix-row status-card-reel-matrix-row--${escapeAttr(label.toLowerCase())}">
        <span class="status-card-reel-matrix-label">${escapeHtml(label)}</span>
        ${cells.join("")}
      </div>
    `;
  }

  function reelDefectsPer1000Ft(row) {
    if (!row || row.defectCount === null || row.defectCount === undefined) return null;
    const defects = Number(row.defectCount);
    const feet = Number(row.feetValue);
    if (!Number.isFinite(defects) || !Number.isFinite(feet) || feet <= 0) return null;
    return (defects / feet) * 1000;
  }

  function renderDefectRateTrend(row, previousRow) {
    const isMakeReady = Boolean(
      row?.isMakeReady
      || row?.state === "make-ready"
      || row?.bstState === "make-ready"
      || row?.rlmState === "make-ready"
    );
    if (isMakeReady) {
      return `<span class="status-reel-defect-cell is-empty" aria-label="Make-ready reel; defect trend not calculated"></span>`;
    }
    const currentRate = reelDefectsPer1000Ft(row);
    const previousRate = reelDefectsPer1000Ft(previousRow);
    if (currentRate === null || previousRate === null) {
      return `<span class="status-reel-defect-cell is-empty" aria-label="No prior defect-rate comparison">•</span>`;
    }
    const delta = currentRate - previousRate;
    if (Math.abs(delta) < 0.005) {
      return `<span class="status-reel-defect-cell flat" title="No change from prior reel" aria-label="No change in defects per 1,000 ft">—</span>`;
    }
    const direction = delta > 0 ? "up" : "down";
    const arrow = delta > 0 ? "↑" : "↓";
    const description = delta > 0 ? "higher" : "lower";
    return `
      <span class="status-reel-defect-cell ${direction}" aria-label="${escapeAttr(currentRate.toFixed(2))} defects per 1,000 ft, ${description} than prior reel">
        ${arrow}
        <span class="status-reel-defect-tooltip" role="tooltip">
          <strong>${escapeHtml(currentRate.toFixed(2))}</strong>
          <small>defects / 1,000 ft</small>
        </span>
      </span>
    `;
  }

  function renderReelMatrixChip(row, label, stateKey) {
    const reelState = row[stateKey] || row.state || "neutral";
    const changeDetails = Array.isArray(row.changeDetails) ? row.changeDetails : [];
    const rlmChangeDetails = Array.isArray(row.rlmChangeDetails) ? row.rlmChangeDetails : [];
    const showBstChangeWarning = label === "BST" && !row.isMakeReady && changeDetails.length > 0;
    const showRlmChangeWarning = label === "RLM" && !row.isMakeReady && rlmChangeDetails.length > 0;
    const showChangeWarning = showBstChangeWarning || showRlmChangeWarning;
    const changeTypeText = showRlmChangeWarning
      ? (row.rlmChangeSummary || `${rlmChangeDetails.length} RLM tolerance change${rlmChangeDetails.length === 1 ? "" : "s"}`)
      : describeChangeTypes(changeDetails);
    const changeId = showBstChangeWarning ? `overview-change-${changeViews.size + 1}` : "";
    if (showBstChangeWarning) {
      changeViews.set(changeId, {
        reelNumber: row.reelNumber || "--",
        summary: row.changeSummary || "Reference image or mask changes detected",
        details: changeDetails,
      });
    }
    const tag = showBstChangeWarning ? "button" : "span";
    const attrs = showBstChangeWarning
      ? ` type="button" data-overview-change="${escapeAttr(changeId)}" aria-label="View reference image or mask changes for reel ${escapeAttr(row.reelNumber || "--")}"`
      : ` tabindex="0"`;
    const defectRate = reelDefectsPer1000Ft(row);
    const defectRateLine = defectRate !== null
      ? `<small>Defects / 1,000 ft - ${escapeHtml(defectRate.toFixed(2))}</small>`
      : "";
    return `
      <span class="status-card-reel-matrix-cell status-card-reel-item${showChangeWarning ? " has-change-warning" : ""}">
        <${tag}
          class="status-card-reel-chip ${escapeAttr(reelState)}"
          ${attrs}
        >
          ${escapeHtml(row.reelNumber || "--")}
          <span class="status-card-reel-tooltip" role="tooltip">
            <strong>Reel ${escapeHtml(row.reelNumber || "--")}</strong>
            <small>${escapeHtml(formatTime(row.timeEnd))}</small>
            <small>Job - ${escapeHtml(row.jobNumber || "--")}</small>
            <small>Feet - ${escapeHtml(row.feet || "--")}</small>
            <small>BST - ${escapeHtml(row.bstPct || "--")}</small>
            <small>RLM - ${escapeHtml(row.rlmPoints || "--")}</small>
            ${defectRateLine}
            ${showBstChangeWarning ? `<small class="status-card-reel-tooltip__warning">${escapeHtml(changeTypeText)} - Click to view changes</small>` : ""}
            ${showRlmChangeWarning ? `<small class="status-card-reel-tooltip__warning">${escapeHtml(changeTypeText)}</small>` : ""}
          </span>
        </${tag}>
        ${showChangeWarning ? `<span class="status-reel-change-warning" aria-hidden="true">!</span>` : ""}
      </span>
    `;
  }

  function openChangeModal(changeId) {
    const view = changeViews.get(changeId);
    if (!view || !refs.changeModal || !refs.changeModalBody) return;
    if (refs.changeModalTitle) refs.changeModalTitle.textContent = `BST changes - Reel ${view.reelNumber}`;
    if (refs.changeModalSubtitle) refs.changeModalSubtitle.textContent = view.summary;
    refs.changeModalBody.innerHTML = `
      <div class="overview-change-options">
        ${buildOverviewChangeOptions(view, changeId).join("")}
      </div>
    `;
    refs.changeModal.showModal();
  }

  function describeChangeTypes(details) {
    const hasReference = details.some((detail) => Array.isArray(detail.images) && detail.images.some((image) => image && image.imageSrc));
    const hasMask = details.some((detail) => Boolean(detail && detail.maskComparison));
    if (hasReference && hasMask) return "Reference image change and mask applied";
    if (hasReference) return "Reference image change";
    if (hasMask) return "Mask applied";
    return "BST setup change";
  }

  function buildOverviewChangeOptions(view, changeId) {
    const options = [];
    view.details.forEach((detail, index) => {
      const images = Array.isArray(detail.images) ? detail.images.filter((image) => image && image.imageSrc) : [];
      if (images.length) {
        const detailId = `${changeId}-reference-${index}`;
        changeDetailViews.set(detailId, { type: "reference", view, detail, images });
        options.push(renderOverviewChangeOption("Show reference image change", detail.summary || "Reference images changed", "View images", detailId));
      }
      if (detail.maskComparison) {
        const detailId = `${changeId}-mask-${index}`;
        changeDetailViews.set(detailId, { type: "mask", view, detail, comparison: detail.maskComparison });
        options.push(renderOverviewChangeOption("Show mask application", detail.summary || "Mask applied", "View mask", detailId));
      }
    });
    return options;
  }

  function renderOverviewChangeOption(title, summary, buttonLabel, detailId) {
    return `
      <section class="overview-change-option">
        <div class="overview-change-option__copy">
          <strong>${escapeHtml(title)}</strong>
          <small>${escapeHtml(summary)}</small>
        </div>
        <button type="button" class="change-ref-link overview-change-option__button" data-overview-change-detail="${escapeAttr(detailId)}">${escapeHtml(buttonLabel)}</button>
      </section>
    `;
  }

  function openOverviewChangeDetail(detailId) {
    const item = changeDetailViews.get(detailId);
    if (!item || !refs.changeModalBody) return;
    if (refs.changeModalTitle) {
      refs.changeModalTitle.textContent = item.type === "reference"
        ? `Reference image change - Reel ${item.view.reelNumber}`
        : `Mask applied - Reel ${item.view.reelNumber}`;
    }
    if (refs.changeModalSubtitle) refs.changeModalSubtitle.textContent = item.detail.summary || "";
    refs.changeModalBody.innerHTML = item.type === "reference"
      ? item.images.map((image, index) => renderOverviewReferenceImage(image, index)).join("")
      : renderOverviewMaskComparison(item.comparison);
    if (item.type === "mask") {
      window.requestAnimationFrame(() => attachOverviewMaskHeatmaps(item.comparison));
    }
  }

  function renderOverviewReferenceImage(image, index) {
    return `
      <figure class="change-ref-image">
        <img src="${escapeAttr(urlForStatic(image.imageSrc))}" alt="${escapeAttr(image.filename || image.label || `Reference ${index + 1}`)}" loading="lazy" decoding="async">
        <figcaption>
          <strong>${escapeHtml(image.label || `Reference ${index + 1}`)}</strong>
          <span>${escapeHtml(image.filename || "")}</span>
          ${image.format ? `<small>Format ${escapeHtml(image.format)}</small>` : ""}
        </figcaption>
      </figure>
    `;
  }

  function renderOverviewMaskComparison(comparison) {
    const states = overviewMaskStates(comparison);
    return `<div class="change-mask-sequence overview-mask-comparison">${states.map(({ label, payload }, index) => renderOverviewMaskHeatmapPanel(label, payload, index)).join("")}</div>`;
  }

  function overviewMaskStates(comparison) {
    const before = comparison && comparison.before;
    const after = comparison && comparison.after;
    const states = [];
    if (before && Array.isArray(before.masks) && before.masks.length > 0) {
      states.push({ label: "Initial", payload: before });
    }
    if (after) states.push({ label: "Current", payload: after });
    return states;
  }

  function renderOverviewMaskHeatmapPanel(title, payload, index) {
    const masks = payload && Array.isArray(payload.masks) ? payload.masks : [];
    return `
      <figure class="change-mask-panel overview-mask-panel" data-overview-mask-panel="${index}">
        <div class="overview-mask-heatmap heatmap-wrapper" id="mask-heatmap-overview-change-${index}">
          <span class="badge">Loading mask footprint...</span>
        </div>
        <figcaption>
          <strong>${escapeHtml(title)} - ${escapeHtml((payload && payload.reel) || "--")}</strong>
          <span>${escapeHtml(payload && payload.image && payload.image.filename || "")}</span>
          <small>${masks.length} active mask${masks.length === 1 ? "" : "s"}</small>
        </figcaption>
      </figure>
    `;
  }

  function attachOverviewMaskHeatmaps(comparison) {
    if (!window.MaskHeatmap || typeof window.MaskHeatmap.attach !== "function" || !refs.changeModalBody) return;
    const states = overviewMaskStates(comparison);
    states.forEach(({ payload }, index) => {
      const panel = refs.changeModalBody.querySelector(`[data-overview-mask-panel="${index}"]`);
      if (!panel) return;
      const reel = {
        reel_id: `overview-change-${index}`,
        format_width: Number(payload.format_width),
        format_length: Number(payload.format_length),
      };
      const masks = (payload.masks || []).map((mask) => ({
        ...mask,
        xml_id: mask.xml_id || mask.xmlId || mask.label || mask.key || "",
        sensitivitysetid: mask.sensitivitysetid || mask.sensitivityId || "",
        coords: mask.coords || "",
        event: "applied",
        noinspection: true,
      }));
      const imageSrc = payload.image && payload.image.imageSrc ? urlForStatic(payload.image.imageSrc) : null;
      window.MaskHeatmap.attach(panel, {
        reel,
        masks,
        referenceBackground: imageSrc,
      });
    });
  }

  function urlForStatic(path) {
    const cleaned = String(path || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!cleaned) return "";
    if (/^data:image\//i.test(cleaned)) return cleaned;
    if (/^https?:\/\//i.test(cleaned) || cleaned.startsWith("static/")) return cleaned.startsWith("static/") ? `/${cleaned}` : cleaned;
    return `/static/${cleaned}`;
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
    if (state === "MAKE_READY") return `${machineName} (MAKE READY)`;
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
    refs.makeReadyBtn.disabled = closed;
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
    const resolvedSuffix = alertState === "MAKE_READY" ? " (MAKE READY)" : "";
    if (machine && title) return `${machine.toUpperCase()} - ${title}${resolvedSuffix}`;
    return `${title || "Alert"}${resolvedSuffix}`;
  }

  function isClosedAlertState(alertState) {
    return ["ACKNOWLEDGED", "MAKE_READY", "RESOLVED"].includes(String(alertState || "").toUpperCase());
  }

  function renderAlertModalBody(alert) {
    const metadata = alert.metadata || {};
    const bst = metadata.bst || {};
    const rlm = metadata.rlm || {};
    const summaryLines = buildAlertSummaryLines(alert, bst, rlm);
    const closeComment = alert.acknowledgeComment || alert.resolvedComment;
    const closeLabel = "Close Comment";
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
      applyOptimisticClosed(alertId);
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
    card.statusText = "Make Ready / Splice / Sample";
    card.workflowBadge = "Make Ready / Splice / Sample";
    card.alertId = null;
    markCurrentReelChip(card, "make-ready");
    render();
  }

  function markCurrentReelChip(card, chipState) {
    const history = card.reelHistory || [];
    const currentReel = String(card.reelNumber || "").trim().toLowerCase();
    const chip = history.find((row) => String(row.reelNumber || "").trim().toLowerCase() === currentReel) || history[0];
    if (chip) {
      chip.state = chipState;
      chip.bstState = chipState;
      chip.rlmState = chipState;
    }
  }

  function applyOptimisticClosed(alertId) {
    const cards = state.board?.cards || [];
    const card = cards.find((item) => Number(item.alertId) === Number(alertId));
    if (!card) return;
    card.state = "critical";
    card.statusText = "Inactive";
    card.workflowBadge = null;
    card.alertId = null;
    render();
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
      loadBoard({ syncAlerts: false }).catch((err) => console.error(err));
    }, BOARD_REFRESH_MS);
  }

  function bindEvents() {
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
    refs.changeModalClose?.addEventListener("click", () => refs.changeModal?.close());
    refs.changeModal?.addEventListener("click", (event) => {
      if (event.target === refs.changeModal) refs.changeModal.close();
    });
    document.addEventListener("click", (event) => {
      const detailButton = event.target.closest("[data-overview-change-detail]");
      if (detailButton) {
        event.preventDefault();
        event.stopPropagation();
        openOverviewChangeDetail(detailButton.getAttribute("data-overview-change-detail"));
        return;
      }
      const warning = event.target.closest("[data-overview-change]");
      if (!warning) return;
      event.preventDefault();
      event.stopPropagation();
      openChangeModal(warning.getAttribute("data-overview-change"));
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

  function formatLastReelTime(value) {
    if (!value) return "No recent update";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    const today = new Date();
    const isToday =
      date.getFullYear() === today.getFullYear() &&
      date.getMonth() === today.getMonth() &&
      date.getDate() === today.getDate();
    return date.toLocaleString(
      [],
      isToday
        ? { hour: "numeric", minute: "2-digit" }
        : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
    );
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
    restoreCachedBoard();
    loadBoard({ syncAlerts: true }).catch((err) => console.error(err));
  });
})();
