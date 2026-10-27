(function () {
  const BOARD_REFRESH_MS = 30000;
  const BOARD_CACHE_KEY = "status-overview-board-v17";
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
    boardCounts: document.getElementById("statusBoardCounts"),
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
    settingsOpenBtn: document.getElementById("overviewSettingsOpenBtn"),
    settingsModal: document.getElementById("overviewSettingsModal"),
    settingsForm: document.getElementById("overviewSettingsForm"),
    settingsMessage: document.getElementById("overviewSettingsMessage"),
    settingsResetBtn: document.getElementById("overviewSettingsResetBtn"),
    settingsSaveBtn: document.getElementById("overviewSettingsSaveBtn"),
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
      if (refs.bannerTrack) refs.bannerTrack.innerHTML = `<span class="so-alert-pill alert">Unable to load status board.</span>`;
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
      refs.bannerTrack.innerHTML = `<span class="so-alert-pill ok">All clear - no active critical alerts</span>`;
      return;
    }
    if (state.bannerIndex >= alerts.length) state.bannerIndex = 0;
    const alert = alerts[state.bannerIndex];
    const sideMeta = `${alert.reelNumber ? `Reel ${escapeHtml(alert.reelNumber)}` : ""}${alert.jobNumber ? `${alert.reelNumber ? " · " : ""}Job ${escapeHtml(alert.jobNumber)}` : ""}`;
    const counter = alerts.length > 1 ? `<span class="so-alert-count">${state.bannerIndex + 1}/${alerts.length}</span>` : "";
    refs.bannerTrack.innerHTML = `
      <button type="button" class="so-alert-pill alert" data-alert-id="${alert.id}" title="Open alert">
        <strong>${escapeHtml(alert.machineName || "")}</strong>
        <span>${escapeHtml(alert.alertTitle || "")}</span>
        ${sideMeta ? `<span class="so-alert-meta">${sideMeta} · ${escapeHtml(formatTime(alert.createdAt))}</span>` : ""}
        ${counter}
      </button>
    `;
    bindGuardedClick(refs.bannerTrack.querySelector("[data-alert-id]"), () => openAlertModal(alert.id, { returnTarget: null }));
    state.bannerTimer = window.setTimeout(() => stepBanner(1), 5000);
  }

  // ---------- Card state ----------
  function cardView(card) {
    const st = String(card.state || "");
    if (st === "make-ready") return { cls: "make-ready", label: "Make ready" };
    if (st === "stale") return { cls: "standby", label: "No recent activity" };
    if (st === "critical") {
      // Say what is off and since when, e.g. "BST and RLM off · since 3:11 AM".
      const bstOff = card.bstBox?.state === "off";
      const rlmOff = card.rlmBox?.state === "off";
      let label = "Inspection off";
      if (bstOff && rlmOff) label = "BST and RLM off";
      else if (bstOff) label = "BST off";
      else if (rlmOff) label = "RLM off";
      const since = offStreakStart(card);
      if (since) label += ` · since ${formatLastReelTime(since)}`;
      return { cls: "off", label, bothOff: true };
    }
    return { cls: "running", label: "In production" };
  }

  function idleText(card) {
    const stoppedAt = card.statusSince || card.lastUpdated;
    if (String(card.state) !== "stale" || !stoppedAt) return "";
    const minutes = Math.floor((Date.now() - new Date(stoppedAt).getTime()) / 60000);
    if (!Number.isFinite(minutes) || minutes < 0) return "";
    const h = Math.floor(minutes / 60);
    return h ? `${h}h ${minutes % 60}m` : `${minutes}m`;
  }

  function renderCounts(cards) {
    if (!refs.boardCounts) return;
    const counts = { running: 0, "make-ready": 0, off: 0, standby: 0 };
    (cards || []).forEach((card) => { counts[cardView(card).cls] += 1; });
    refs.boardCounts.innerHTML = `
      <span><b>${counts.running}</b>In production</span>
      <span><b>${counts["make-ready"]}</b>Make ready</span>
      <span><b>${counts.off}</b>Inspection off</span>
      <span><b>${counts.standby}</b>No recent activity</span>
    `;
  }

  // Start time of the first reel in the current "off" run, newest reel first.
  // Make-ready reels are skipped (they neither break nor start the run).
  // e.g. r4 off, r3 make ready, r2 off, r1 off, r0 on  ->  start of r1.
  function offStreakStart(card) {
    const bstOff = card.bstBox?.state === "off";
    const rlmOff = card.rlmBox?.state === "off";
    if (!bstOff && !rlmOff) return null;
    const isOff = (row) => (!bstOff || row.bstState === "alert") && (!rlmOff || row.rlmState === "alert");
    let start = null;
    for (const row of card.reelHistory || []) {
      if (isMakeReadyRow(row)) continue;
      if (!isOff(row)) break;
      start = row.timeStart || row.timeEnd || start;
    }
    return start;
  }

  function renderCardAlert(card) {
    if (!card.alertId) return "";
    const alert = findAlertInBoard(card.alertId) || {};
    const title = alert.alertTitle || "Active alert";
    const offSince = offStreakStart(card);
    const sinceValue = offSince || alert.createdAt;
    const since = sinceValue ? ` · since ${formatLastReelTime(sinceValue)}` : "";
    return `<button type="button" class="so-card-alert" data-card-alert="${escapeAttr(card.alertId)}">
      <span>${escapeHtml(title)}${escapeHtml(since)}</span><span aria-hidden="true">&rarr;</span>
    </button>`;
  }

  function renderCards(cards) {
    if (!refs.cardGrid) return;
    changeViews.clear();
    jobBars.clear();
    changeDetailViews.clear();
    renderCounts(cards);
    if (!cards.length) {
      refs.cardGrid.innerHTML = `<div class="empty-state">No machines found.</div>`;
      return;
    }
    refs.cardGrid.innerHTML = cards
      .map((card) => {
        const orderNumber = card.orderNumber || orderNumberFromDisplay(card.jobNumber) || "--";
        const view = cardView(card);
        const idle = idleText(card);
        return `
          <article id="machine-card-${slugify(card.machineKey)}" class="so-card ${view.cls}${view.bothOff ? " both-off" : ""}">
            <header class="so-head no-alert">
              <div class="so-head-main">
                <h3>${escapeHtml(card.machineName || "Press")}</h3>
                ${card.alertId
                  ? `<small class="so-status-link" role="button" tabindex="0" title="Open alert" data-card-alert="${escapeAttr(card.alertId)}">${escapeHtml(view.label)} &rarr;</small>`
                  : `<small>${escapeHtml(view.cls === "standby" && idle ? `No recent activity for ${idle}` : `${view.label}${idle ? ` · ${idle}` : ""}`)}</small>`}
              </div>
              <div class="so-head-meta">
                <span>${escapeHtml(formatLastReelTime(card.lastUpdated))}</span>
                <span>Job ${escapeHtml(orderNumber)} - ${escapeHtml(String(card.reelNumber || "--").toUpperCase())}</span>
              </div>
            </header>
            <div class="so-body">
              ${renderReelHealth(card.reelHistory || [], card.jobSummary)}
              ${renderReelStrip(card.reelHistory || [])}
              ${renderJobSummary(card.jobSummary)}
            </div>
          </article>
        `;
      })
      .join("");
    refs.cardGrid.querySelectorAll("[data-card-alert]").forEach((node) => {
      bindGuardedClick(node, () => openAlertModal(Number(node.getAttribute("data-card-alert")), { returnTarget: null }));
    });
  }

  function orderNumberFromDisplay(value) {
    const display = String(value || "").trim();
    if (!display) return "";
    const separator = display.indexOf(" - ");
    return separator >= 0 ? display.slice(0, separator).trim() : display;
  }

  // ---------- Last 7 reels: joined strip + M/R/T badge ----------
  const CHANGE_TAG_NAMES = {
    M: "Mask applied",
    R: "Reference image changed",
    T: "RLM tolerance changed",
  };
  const CHANGE_TAG_ORDER = ["M", "R", "T"];

  function isMakeReadyRow(row) {
    return Boolean(
      row?.isMakeReady
      || row?.state === "make-ready"
      || row?.bstState === "make-ready"
      || row?.rlmState === "make-ready"
    );
  }

  function reelView(row) {
    // Splice / sample = a make-ready reel between two good reels of the same job (striped blue).
    if (isMakeReadyRow(row) && row.isSplice) return { cls: "mr", splice: true, sub: "", bstOff: false, rlmOff: false, status: "Splice / sample" };
    if (isMakeReadyRow(row)) return { cls: "mr", sub: "", bstOff: false, rlmOff: false, status: "Make ready" };
    const bst = row.bstState || row.state || "neutral";
    const rlm = row.rlmState || row.state || "neutral";
    const bstOff = bst === "alert";
    const rlmOff = rlm === "alert";
    const label = (state) => (state === "healthy" ? "on" : state === "alert" ? "off" : "no data");
    const status = `BST ${label(bst)} · RLM ${label(rlm)}`;
    // BST or RLM off (one or both): red reel. The hover says which one.
    if (bstOff || rlmOff) return { cls: "off", sub: "", bstOff, rlmOff, status };
    if (bst === "healthy" || rlm === "healthy") return { cls: "ok", sub: "", bstOff, rlmOff, status };
    return { cls: "nodata", sub: "", bstOff, rlmOff, status };
  }

  // M = mask, R = reference image, T = RLM tolerance. BST off reels cannot have
  // M/R and RLM off reels cannot have T; make-ready reels never get a badge.
  function changeTagsForRow(row, view) {
    if (view.cls === "mr" || (view.bstOff && view.rlmOff)) return [];
    const tags = new Set();
    if (Array.isArray(row.changeTags)) {
      row.changeTags.forEach((tag) => tags.add(tag));
    } else {
      (Array.isArray(row.changeDetails) ? row.changeDetails : []).forEach((detail) => {
        if (detail?.maskComparison) tags.add("M");
        if (detail?.label === "Reference images" || (Array.isArray(detail?.images) && detail.images.some((image) => image && image.imageSrc))) tags.add("R");
      });
      if (Array.isArray(row.rlmChangeDetails) && row.rlmChangeDetails.length) tags.add("T");
    }
    if (view.bstOff) { tags.delete("M"); tags.delete("R"); }
    if (view.rlmOff) tags.delete("T");
    return CHANGE_TAG_ORDER.filter((tag) => tags.has(tag));
  }

  function renderReelStrip(history) {
    if (!history.length) return `<div class="so-strip-wrap"><div class="so-empty">No recent reels</div></div>`;
    const rows = history.slice(0, 7).map((row) => ({ row, view: reelView(row) }));
    return `
      <div class="so-strip-wrap">
        <div class="so-strip" aria-label="Last 7 reels, newest first">
          ${rows.map(({ row, view }, index) => renderReelSegment(row, view, index === 0)).join("")}
        </div>
      </div>
    `;
  }

  function renderReelSegment(row, view, isCurrent) {
    const tags = changeTagsForRow(row, view);
    const changeDetails = Array.isArray(row.changeDetails) ? row.changeDetails : [];
    const viewable = changeDetails.filter((detail) =>
      (tags.includes("R") && Array.isArray(detail?.images) && detail.images.some((image) => image && image.imageSrc))
      || (tags.includes("M") && detail?.maskComparison)
    );
    const rlmChanges = tags.includes("T") && Array.isArray(row.rlmChangeDetails)
      ? row.rlmChangeDetails.filter((detail) => detail && detail.rlmTolerance)
      : [];
    const clickable = viewable.length > 0 || rlmChanges.length > 0;
    const changeId = clickable ? `overview-change-${changeViews.size + 1}` : "";
    const viewNames = [
      viewable.some((d) => Array.isArray(d?.images) && d.images.some((image) => image && image.imageSrc)) ? "reference image" : "",
      viewable.some((d) => d?.maskComparison) ? "mask" : "",
      rlmChanges.length ? "RLM tolerance" : "",
    ].filter(Boolean);
    if (clickable) {
      changeViews.set(changeId, {
        reelNumber: row.reelNumber || "--",
        summary: [
          viewable.length ? describeChangeTypes(viewable) : "",
          rlmChanges.length ? `${rlmChanges.length} RLM nominal change${rlmChanges.length === 1 ? "" : "s"}` : "",
        ].filter(Boolean).join(" · "),
        details: viewable,
        rlmChanges,
      });
    }

    const defectRate = reelDefectsPer1000Ft(row);
    const changeLines = tags.map((tag) => {
      let text = CHANGE_TAG_NAMES[tag];
      if (tag === "R") {
        const detail = changeDetails.find((d) => d?.label === "Reference images");
        if (detail?.summary) text = `Reference image: ${detail.summary}`;
      } else if (tag === "M") {
        const detail = changeDetails.find((d) => d?.maskComparison);
        if (detail?.summary) text = detail.summary;
      } else if (tag === "T" && row.rlmChangeSummary) {
        text = `RLM ${row.rlmChangeSummary}`;
      }
      return `<small class="so-tip-warn">${escapeHtml(text)}</small>`;
    }).join("");

    const tooltip = `
      <span class="so-tip" role="tooltip">
        <strong>Reel ${escapeHtml(row.reelNumber || "--")}</strong>
        <small class="so-tip-status">${escapeHtml(view.status)}</small>
        <small>${escapeHtml(formatTime(row.timeEnd || row.lastUpdated))}</small>
        <small>Order - ${escapeHtml(row.orderNumber || "--")}</small>
        <small>Job - ${escapeHtml(row.jobNumber || "--")}</small>
        <small>Feet - ${escapeHtml(row.feet || "--")}</small>
        <small>BST inspection - ${escapeHtml(row.bstPct || "--")}</small>
        <small>RLM - ${escapeHtml(row.rlmPoints || "--")}${row.rlmDensity && row.rlmDensity !== "--" ? ` (${escapeHtml(row.rlmDensity)})` : ""}</small>
        ${defectRate !== null ? `<small>Defects / 1,000 ft - ${escapeHtml(defectRate.toFixed(2))}</small>` : ""}
        ${changeLines}
        ${row.makeReadyMaskNote ? `<small class="so-tip-note">${escapeHtml(row.makeReadyMaskNote)}</small>` : ""}
        ${clickable ? `<small class="so-tip-hint">Click to view ${escapeHtml(viewNames.length > 1 ? `${viewNames.slice(0, -1).join(", ")} and ${viewNames[viewNames.length - 1]}` : viewNames[0])} changes</small>` : ""}
      </span>
    `;
    const tag = clickable ? "button" : "span";
    const attrs = clickable
      ? ` type="button" data-overview-change="${escapeAttr(changeId)}" aria-label="View changes for reel ${escapeAttr(row.reelNumber || "--")}"`
      : ` tabindex="0"`;
    return `
      <${tag} class="so-seg ${view.cls}${view.splice ? " sp" : ""}${tags.length && view.cls !== "mr" && view.cls !== "off" ? " chg" : ""}${isCurrent ? " current" : ""}${clickable ? " clickable" : ""}"${attrs}>
        <span class="so-seg-label">${escapeHtml(row.reelNumber || "--")}</span>
        ${tags.length ? `<i class="so-badge" aria-label="${escapeAttr(tags.map((t) => CHANGE_TAG_NAMES[t]).join(", "))}">${tags.join("+")}</i>` : ""}
        ${tooltip}
      </${tag}>
    `;
  }

  function reelDefectsPer1000Ft(row) {
    if (!row || row.defectCount === null || row.defectCount === undefined) return null;
    const defects = Number(row.defectCount);
    const feet = Number(row.feetValue);
    if (!Number.isFinite(defects) || !Number.isFinite(feet) || feet <= 0) return null;
    return (defects / feet) * 1000;
  }

  // Only reels at least this long, with inspection on, count for health and job numbers.
  const QUALIFYING_REEL_FEET = 4000;

  function formatNumber(value, digits = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "--";
    return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  // ---------- Reel health: latest reel >= 4,000 ft with BST inspection on ----------
  // Defects / 1k ft for the whole job (make-ready and BST-off reels left out).
  // Job health: both numbers cover the whole current job (reels >= 4,000 ft).
  //   BST inspection = active footage / total footage (BST-off reels included)
  //   Defects / 1k ft = total defects / total feet x 1000 (BST-off reels left out)
  function renderJobHealthStat(value, digits, suffix, label, note, title) {
    const n = value === null || value === undefined ? null : Number(value);
    const shown = n !== null && Number.isFinite(n) ? `${n.toFixed(digits)}${suffix}` : "--";
    return `<div title="${escapeHtml(title)}"><b>${escapeHtml(shown)}</b><span>${label}</span>${note ? `<em>${escapeHtml(note)}</em>` : ""}</div>`;
  }

  function renderReelHealth(history, job) {
    if (!job) {
      return `
        <div class="so-section">
          <div class="so-section-title"><span>Job health</span></div>
          <div class="so-empty">No job data yet</div>
        </div>
      `;
    }
    const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
    const prod = Number(job.productionReels || 0);
    const off = Number(job.skippedInspectionOffReels || 0);
    const minFeet = formatNumber(job.minFeet || QUALIFYING_REEL_FEET);
    const bst = renderJobHealthStat(
      job.bstInspectionPct, 1, "%", "BST inspection", `${formatNumber(job.bstInspectionFeet)} ft`,
      `Active footage / total footage over ${plural(prod + off, "reel")} ≥ ${minFeet} ft (BST-off reels included)`
    );
    const defects = renderJobHealthStat(
      job.defectsPer1kFt, 2, "", "Defects / 1k ft", "",
      `${formatNumber(job.defectCount)} defects over ${formatNumber(job.defectFeet)} ft (reels ≥ ${minFeet} ft; BST-off reels left out)`
    );
    return `
      <div class="so-section">
        <div class="so-section-title">
          <span>Job health</span>
          <span class="so-job-length" title="Total length of the current job (all reels)">${formatNumber(job.totalFeet)} ft</span>
        </div>
        <div class="so-stats so-stats-2">${bst}${defects}</div>
      </div>
    `;
  }

  // ---------- Job summary (shown when the backend sends card.jobSummary) ----------
  // ---------- Whole-job barcode: one thin bar per reel, oldest on the left ----------
  // job.reels = [{n: reel, k: "ok"|"off"|"mr"|"sp", ft, bst, start, end}, ...]
  const jobBars = new Map();
  const JOB_BAR_KIND = { ok: "Production", off: "BST or RLM off", mr: "Make ready", sp: "Splice / sample" };
  let jobTip = null;

  function renderJobBar(job) {
    const reels = Array.isArray(job?.reels) ? job.reels : [];
    if (!reels.length) return "";
    const id = `jobbar-${jobBars.size + 1}`;
    jobBars.set(id, reels);
    return `
      <div class="so-jobbar" data-jobbar="${id}">
        <div class="so-jobbar-track" aria-label="All ${reels.length} reels of this job, oldest first">${reels
          .map((reel) => `<i class="jb-${escapeAttr(JOB_BAR_KIND[reel.k] ? reel.k : "ok")}"></i>`)
          .join("")}</div>
        <span class="so-jobbar-pop" hidden></span>
      </div>
    `;
  }

  function jobBarTip() {
    if (!jobTip) {
      jobTip = document.createElement("div");
      jobTip.className = "so-jobtip";
      jobTip.hidden = true;
      document.body.appendChild(jobTip);
    }
    return jobTip;
  }

  function hideJobBarHover() {
    if (jobTip) jobTip.hidden = true;
    document.querySelectorAll(".so-jobbar-pop:not([hidden])").forEach((node) => { node.hidden = true; });
  }

  function handleJobBarMove(event) {
    const track = event.target.closest?.(".so-jobbar-track");
    if (!track) { hideJobBarHover(); return; }
    const bar = track.parentElement;
    const reels = jobBars.get(bar.getAttribute("data-jobbar")) || [];
    if (!reels.length) return;
    const rect = track.getBoundingClientRect();
    // The reel under the mouse: the block itself, or (in a gap between blocks)
    // the one at that position.
    const cells = track.children;
    let index = event.target.parentElement === track ? Array.prototype.indexOf.call(cells, event.target) : -1;
    if (index < 0) {
      index = Math.min(reels.length - 1, Math.max(0, Math.floor(((event.clientX - rect.left) / rect.width) * reels.length)));
    }
    const reel = reels[index];
    const kind = JOB_BAR_KIND[reel.k] ? reel.k : "ok";
    // Only the reel under the mouse grows: a slightly bigger copy of its block
    // pops up over the bar (at least 12 px wide, so thin reels are visible too).
    const cellRect = cells[index].getBoundingClientRect();
    const pop = bar.querySelector(".so-jobbar-pop");
    pop.className = `so-jobbar-pop jb-${kind}`;
    pop.style.width = `${Math.max(12, cellRect.width + 6)}px`;
    pop.style.left = `${cellRect.left + cellRect.width / 2 - bar.getBoundingClientRect().left}px`;
    pop.hidden = false;
    const tip = jobBarTip();
    const when = [reel.start ? formatLastReelTime(reel.start) : "", reel.end ? formatLastReelTime(reel.end) : ""].filter(Boolean).join(" – ");
    const facts = [
      reel.ft !== null && reel.ft !== undefined ? `${formatNumber(reel.ft)} ft` : "",
      reel.bst !== null && reel.bst !== undefined ? `BST ${Number(reel.bst).toFixed(1)}%` : "",
    ].filter(Boolean).join(" · ");
    tip.innerHTML = `<strong>Reel ${escapeHtml(reel.n || "--")}</strong> · ${escapeHtml(JOB_BAR_KIND[kind])}`
      + `${when ? `<br>${escapeHtml(when)}` : ""}${facts ? `<br>${escapeHtml(facts)}` : ""}`
      + `<br><small>Reel ${index + 1} of ${reels.length} in this job</small>`;
    tip.hidden = false;
    const width = tip.offsetWidth;
    tip.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, event.clientX - width / 2))}px`;
    tip.style.top = `${rect.bottom + 10}px`;
  }

  function renderJobSummary(job) {
    if (!job) return `<div class="so-section so-section-job"></div>`;
    const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
    const prod = Number(job.productionReels || 0);
    const skippedShort = Number(job.skippedShortReels || 0);
    // Short reels split into make ready and splice / sample (between two good reels).
    const spliceReels = Number(job.spliceReels || 0);
    const makeReadyReels = Number(job.makeReadyReels ?? (skippedShort - spliceReels));
    // Production reels: every reel of minFeet or more, whatever the BST %.
    const good = Number(job.goodReels ?? (prod + Number(job.skippedInspectionOffReels || 0)));
    const skippedOff = Number(job.skippedInspectionOffReels || 0);
    const refs = Number(job.referenceImages || 0);
    const switches = Number(job.refSwitches || 0);
    const multi = Number(job.reelsWithMultipleRefs || 0);
    // Number of masks actually applied or removed during the job.
    const masksApplied = Number(job.masksApplied || 0);
    const masksRemoved = Number(job.masksRemoved || 0);
    const masks = masksApplied + masksRemoved;
    const tol = Number(job.rlmToleranceChangeReels || 0);
    const excluded = [
      skippedShort ? `${skippedShort} make ready` : "",
      skippedOff ? `${skippedOff} BST off` : "",
    ].filter(Boolean);
    const minFeet = formatNumber(job.minFeet || QUALIFYING_REEL_FEET);
    const reelsTitle = `${good} production reel${good === 1 ? "" : "s"} (${minFeet} ft or more, any BST %); `
      + `${makeReadyReels} make ready and ${spliceReels} splice / sample (under ${minFeet} ft; splice / sample = between two good reels). `
      + `Total footage includes all reels.${skippedOff ? ` Defects / 1k ft leaves out ${skippedOff} BST-off reel${skippedOff === 1 ? "" : "s"}.` : ""}`;
    const refTitle = `${switches} reference image change${switches === 1 ? "" : "s"} over ${plural(prod, "reel")}; `
      + `${plural(refs, "reference image")} used; ${plural(multi, "reel")} changed reference partway through.`;
    const zero = (n) => (n ? "" : " zero");
    return `
      <div class="so-section so-section-job">
        <div class="so-stats">
          <div class="${zero(switches)}" title="${escapeHtml(refTitle)}"><b>${switches}</b><span>Ref changes</span></div>
          <div class="${zero(masks)}" title="${masksApplied} mask${masksApplied === 1 ? "" : "s"} applied, ${masksRemoved} removed during this job"><b>${masks}</b><span>Mask changes</span></div>
          <div class="${zero(tol)}"><b>${tol}</b><span>RLM tol changes</span></div>
        </div>
        <div class="so-section-title so-job-count">
          <span title="${escapeHtml(reelsTitle)}">${good + makeReadyReels + spliceReels} reels</span>
          <span class="so-job-reels" title="${escapeHtml(reelsTitle)}">${good} production · ${makeReadyReels} make ready · ${spliceReels} splice/sample</span>
        </div>
        ${renderJobBar(job)}
      </div>
    `;
  }

  function openChangeModal(changeId) {
    const view = changeViews.get(changeId);
    if (!view || !refs.changeModal || !refs.changeModalBody) return;
    if (refs.changeModalTitle) refs.changeModalTitle.textContent = `Changes - Reel ${view.reelNumber}`;
    if (refs.changeModalSubtitle) refs.changeModalSubtitle.textContent = view.summary;
    const options = buildOverviewChangeOptions(view, changeId);
    refs.changeModalBody.innerHTML = `
      <div class="overview-change-options">
        ${options.join("")}
      </div>
    `;
    refs.changeModal.showModal();
    // Only one thing to show (just a reference change or just a mask): open it directly.
    if (changeDetailViews.size && options.length === 1) {
      const onlyId = refs.changeModalBody.querySelector("[data-overview-change-detail]")?.getAttribute("data-overview-change-detail");
      if (onlyId) openOverviewChangeDetail(onlyId);
    }
  }

  function describeChangeTypes(details) {
    const hasReference = details.some((detail) => Array.isArray(detail.images) && detail.images.some((image) => image && image.imageSrc));
    const hasMask = details.some((detail) => Boolean(detail && detail.maskComparison));
    if (hasReference && hasMask) return "Reference image and mask changes";
    if (hasReference) return "Reference image change";
    if (hasMask) return "Mask change";
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
        options.push(renderOverviewChangeOption(`Show ${String(detail.label || "Mask applied").toLowerCase()}`, detail.summary || "Mask applied", "View mask", detailId));
      }
    });
    const rlmChanges = Array.isArray(view.rlmChanges) ? view.rlmChanges : [];
    if (rlmChanges.length) {
      const detailId = `${changeId}-rlm`;
      const times = rlmChanges.map((change) => (change.time ? formatTime(change.time) : "")).filter(Boolean);
      changeDetailViews.set(detailId, {
        type: "rlm",
        view,
        detail: {
          summary: `${rlmChanges.length} nominal length change${rlmChanges.length === 1 ? "" : "s"} during this reel`
            + (rlmChanges[0]?.reelStart?.values?.nomLength != null
              ? ` · started at ${formatTolerance(rlmChanges[0].reelStart.values.nomLength)}`
              : ""),
        },
        changes: rlmChanges,
      });
      options.push(renderOverviewChangeOption(
        "Show RLM tolerance changes",
        `${rlmChanges.length} nominal change${rlmChanges.length === 1 ? "" : "s"} during the reel${times.length ? ` (${times.join(", ")})` : ""}`,
        "View tolerances",
        detailId
      ));
    }
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
        : item.type === "rlm"
          ? `RLM tolerance changes - Reel ${item.view.reelNumber}`
          : `${item.detail.label || "Mask applied"} - Reel ${item.view.reelNumber}`;
    }
    if (refs.changeModalSubtitle) refs.changeModalSubtitle.textContent = item.detail.summary || "";
    refs.changeModalBody.innerHTML = item.type === "reference"
      ? item.images.map((image, index) => renderOverviewReferenceImage(image, index)).join("")
      : item.type === "rlm"
        ? renderRlmToleranceChanges(item.changes)
        : renderOverviewMaskComparison(item.comparison);
    if (item.type === "mask") {
      window.requestAnimationFrame(() => attachOverviewMaskHeatmaps(item.comparison));
    }
  }

  // ---------- RLM tolerance changes (nominal length changes during one reel) ----------
  function formatTolerance(value) {
    const n = Number(value);
    return value === null || value === undefined || !Number.isFinite(n) ? "--" : n.toFixed(3);
  }

  // How much the nominal length moved, in mm (the RLM XML length unit), e.g. " (−11.552 mm)".
  function rlmDeltaText(field) {
    const before = Number(field?.before);
    const after = Number(field?.after);
    if (field?.before === null || field?.before === undefined || field?.after === null || field?.after === undefined) return "";
    if (!Number.isFinite(before) || !Number.isFinite(after)) return "";
    const delta = after - before;
    const sign = delta > 0 ? "+" : delta < 0 ? "\u2212" : "";
    return ` <span class="so-rlm-delta">(${sign}${Math.abs(delta).toFixed(3)} mm)</span>`;
  }

  function renderRlmToleranceChanges(changes) {
    const list = Array.isArray(changes) ? changes : [];
    const rows = list.map((change, index) => {
      const field = (Array.isArray(change.fields) ? change.fields : []).find((f) => f.key === "nomLength") || {};
      const when = [
        change.time ? formatTime(change.time) : "",
        change.feetIntoReel !== null && change.feetIntoReel !== undefined ? `${formatNumber(change.feetIntoReel)} ft` : "",
      ].filter(Boolean).join(" · ");
      return `
        <li class="so-rlm-line">
          <span class="so-rlm-num">${index + 1}</span>
          <span class="so-rlm-when">${escapeHtml(when || "--")}</span>
          <span class="so-rlm-what">Nominal <span class="so-rlm-old">${escapeHtml(formatTolerance(field.before))}</span> &rarr; <b>${escapeHtml(formatTolerance(field.after))}</b>${rlmDeltaText(field)}</span>
        </li>
      `;
    }).join("");
    return `
      <div class="so-rlm-changes">
        <ol class="so-rlm-list">${rows}</ol>
      </div>
    `;
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

  // ---------- Overview settings (gear button) ----------
  const SETTING_KEYS = ["makeReadyFeet", "refChangesMin", "maskChangesMin", "rlmNominalDeltaMm"];
  let settingsDefaults = null;
  let settingsCurrent = null;

  // ---------- Apply a new make-ready length on the page straight away ----------
  // Re-colours the reel strip, card status, Current job counts and barcode from
  // data the page already has, so the change shows the moment Save is pressed.
  // The server's rebuild (which also refreshes badges and job numbers like
  // BST % and defects) replaces this when it arrives.
  const BST_OFF_PCT = 40;

  function sameJob(a, b) {
    for (const field of ["orderNumber", "jobNumber"]) {
      const x = String(a?.[field] ?? "").trim().toLowerCase();
      const y = String(b?.[field] ?? "").trim().toLowerCase();
      if (x && y && x !== y) return false;
    }
    return true;
  }

  // Newest-first strip rows: a single red reel with make-ready reels right
  // before and after it (same job) is make ready too.
  function markRedBetweenMakeReadyRows(rows) {
    for (let index = 1; index < rows.length - 1; index += 1) {
      const row = rows[index];
      const newer = rows[index - 1];
      const older = rows[index + 1];
      if (row.state !== "alert" || isMakeReadyRow(row)) continue;
      if (!isMakeReadyRow(newer) || !isMakeReadyRow(older)) continue;
      if (newer.jobStart || !sameJob(row, newer) || !sameJob(row, older)) continue;
      row.mrReason = "betweenMR";
      row.isMakeReady = true;
      row.state = row.bstState = row.rlmState = "make-ready";
      row.changeTags = [];
    }
  }

  // Newest-first strip rows: a make-ready run between two good reels of the
  // same job (and not a job's first reel) is splice / sample.
  function markSpliceRows(rows) {
    rows.forEach((row) => { row.isSplice = false; });
    const good = (row) => row && !isMakeReadyRow(row) && row.state === "healthy";
    let index = 0;
    while (index < rows.length) {
      if (!isMakeReadyRow(rows[index])) { index += 1; continue; }
      let end = index;
      while (end + 1 < rows.length && isMakeReadyRow(rows[end + 1])) end += 1;
      const newer = rows[index - 1];
      const older = rows[end + 1];
      const run = rows.slice(index, end + 1);
      if (good(newer) && good(older) && sameJob(older, newer)
        && run.every((row) => !row.jobStart && sameJob(row, newer))) {
        run.forEach((row) => { row.isSplice = true; });
      }
      index = end + 1;
    }
  }

  // Oldest-first job barcode reels + the counts above it.
  function reclassifyJobReels(job, newFeet) {
    const reels = Array.isArray(job?.reels) ? job.reels : [];
    if (!reels.length) return;
    const kinds = reels.map((reel) => {
      if (reel.js) return "start";
      if (Number.isFinite(Number(reel.ft)) && Number(reel.ft) < newFeet) return "short";
      return (Number(reel.bst) < BST_OFF_PCT || reel.rlmOff) ? "off" : "ok";
    });
    // A single red reel between make-ready reels is make ready too.
    for (let pos = 1; pos < kinds.length - 1; pos += 1) {
      if (kinds[pos] === "off" && (kinds[pos - 1] === "start" || kinds[pos - 1] === "short") && kinds[pos + 1] === "short") kinds[pos] = "short";
    }
    let index = 0;
    while (index < reels.length) {
      if (kinds[index] !== "start" && kinds[index] !== "short") { reels[index].k = kinds[index]; index += 1; continue; }
      if (kinds[index] === "start") { reels[index].k = "mr"; index += 1; continue; }
      let end = index;
      while (end + 1 < reels.length && kinds[end + 1] === "short") end += 1;
      const splice = index > 0 && kinds[index - 1] === "ok" && end + 1 < reels.length && kinds[end + 1] === "ok";
      for (let pos = index; pos <= end; pos += 1) reels[pos].k = splice ? "sp" : "mr";
      index = end + 1;
    }
    const count = (kind) => reels.filter((reel) => reel.k === kind).length;
    job.spliceReels = count("sp");
    job.makeReadyReels = count("mr");
    job.skippedShortReels = job.spliceReels + job.makeReadyReels;
    job.goodReels = count("ok") + count("off");
    job.minFeet = newFeet;
  }

  function applyMakeReadyLengthNow(newFeet) {
    if (!state.board || !Number.isFinite(newFeet)) return;
    (state.board.cards || []).forEach((card) => {
      const rows = card.reelHistory || [];
      rows.forEach((row) => {
        if (row.mrReason === "jobStart" || row.mrReason === "marked") return;
        const feet = Number(row.feetValue);
        if (Number.isFinite(feet) && feet < newFeet) {
          row.mrReason = "short";
          row.isMakeReady = true;
          row.state = row.bstState = row.rlmState = "make-ready";
          row.changeTags = [];
        } else if (row.mrReason === "short" || row.mrReason === "betweenMR") {
          // Was make ready only because it was short (or a red reel between
          // make-ready reels): back to its own colour, re-checked below.
          row.mrReason = null;
          row.isMakeReady = false;
          row.bstState = row.bstOffRaw ? "alert" : (row.bstPct === "--" ? "neutral" : "healthy");
          row.rlmState = row.rlmOffRaw ? "alert" : (row.rlmPoints === "--" ? "neutral" : "healthy");
          row.state = row.bstState === "alert" || row.rlmState === "alert" ? "alert" : "healthy";
        }
      });
      markRedBetweenMakeReadyRows(rows);
      markSpliceRows(rows);
      const newest = rows[0];
      if (card.state !== "stale" && newest) {
        if (isMakeReadyRow(newest)) {
          card.state = "make-ready";
          card.alertId = null;
        } else if (card.state === "make-ready") {
          card.bstBox = { ...(card.bstBox || {}), state: newest.bstState === "alert" ? "off" : "healthy" };
          card.rlmBox = { ...(card.rlmBox || {}), state: newest.rlmState === "alert" ? "off" : "healthy" };
          card.state = newest.state === "alert" ? "critical" : "healthy";
        }
      }
      reclassifyJobReels(card.jobSummary, newFeet);
    });
    state.boardVersion += 1;
    renderCards(state.board.cards || []);
  }

  function fillSettingsForm(values) {
    SETTING_KEYS.forEach((key) => {
      const input = refs.settingsForm?.elements.namedItem(key);
      if (input && values && values[key] !== undefined && values[key] !== null) input.value = values[key];
    });
  }

  // Read a JSON reply; if the server sent an HTML error page instead (e.g. 404
  // because the app was not restarted, or 500), say so with the status code.
  async function readSettingsReply(res) {
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch (error) {
      const hint = res.status === 404
        ? "settings address not found (restart the app with the new routes file)"
        : `server error ${res.status} (see the app log)`;
      return { ok: false, message: hint };
    }
  }

  async function openSettings() {
    if (!refs.settingsModal) return;
    setMessage(refs.settingsMessage, "Loading...");
    refs.settingsModal.showModal();
    try {
      const res = await fetch("/statusOverview/api/settings");
      const data = await readSettingsReply(res);
      if (!res.ok || !data.ok) throw new Error(data.message || `Request failed (${res.status})`);
      settingsDefaults = data.defaults || null;
      settingsCurrent = data.settings || null;
      fillSettingsForm(data.settings);
      setMessage(refs.settingsMessage, "");
    } catch (err) {
      setMessage(refs.settingsMessage, `Could not load settings: ${err.message || err}`);
    }
  }

  async function saveSettings() {
    const settings = {};
    for (const key of SETTING_KEYS) {
      const input = refs.settingsForm?.elements.namedItem(key);
      const value = Number(input?.value);
      if (!input || input.value === "" || !Number.isFinite(value) || value < Number(input.min || 0)) {
        setMessage(refs.settingsMessage, "Please enter a valid number in every field.");
        input?.focus();
        return;
      }
      settings[key] = value;
    }
    if (refs.settingsSaveBtn) refs.settingsSaveBtn.disabled = true;
    setMessage(refs.settingsMessage, "Saving...");
    try {
      const res = await fetch("/statusOverview/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings }),
      });
      const data = await readSettingsReply(res);
      if (!res.ok || !data.ok) throw new Error(data.message || `Request failed (${res.status})`);
      setMessage(refs.settingsMessage, "");
      refs.settingsModal?.close();
      if (Number(settingsCurrent?.makeReadyFeet) !== Number(settings.makeReadyFeet)) {
        applyMakeReadyLengthNow(Number(settings.makeReadyFeet));
      }
      settingsCurrent = data.settings || settings;
      // Saved. The server now rebuilds the board with the new settings; the
      // current board stays on screen until the new one arrives.
      if (refs.lastRefresh) refs.lastRefresh.textContent = "Applying new settings...";
      loadBoard({ syncAlerts: false }).catch((err) => console.error(err));
    } catch (err) {
      setMessage(refs.settingsMessage, `Could not save: ${err.message || err}`);
    } finally {
      if (refs.settingsSaveBtn) refs.settingsSaveBtn.disabled = false;
    }
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
    document.addEventListener("mousemove", handleJobBarMove);
    window.addEventListener("scroll", hideJobBarHover, { passive: true });
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
    bindGuardedClick(refs.settingsOpenBtn, () => openSettings());
    refs.settingsForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      saveSettings();
    });
    bindGuardedClick(refs.settingsResetBtn, () => {
      if (settingsDefaults) fillSettingsForm(settingsDefaults);
      setMessage(refs.settingsMessage, settingsDefaults ? "Defaults filled in. Press Save to apply." : "");
    });
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
    // Use the server's cached board: it is rebuilt (and alerts synced) in the
    // background every ~45 s, so the page does not wait for a full rebuild.
    loadBoard({ syncAlerts: false }).catch((err) => console.error(err));
  });
})();