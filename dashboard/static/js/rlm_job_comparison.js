(function () {
  const FILTER_STORAGE_KEY = "rlm_job_comparison_filters_v1";
  const state = {
    data: null,
    loading: false,
    refreshTimer: null,
    restoringFilters: false,
  };

  const els = {};

  function init() {
    cacheDom();
    bindEvents();
    mirrorMinFeet();
    initializePage().catch((error) => setStatus(`Load failed: ${error.message}`, "error"));
  }

  async function initializePage() {
    const restored = restorePersistedFilters();
    state.restoringFilters = true;
    await Promise.all([
      loadJobOptions("job1", restored?.job1?.job || ""),
      loadJobOptions("job2", restored?.job2?.job || ""),
    ]);
    state.restoringFilters = false;
    persistFilters();
    renderFilterChips();
    if (hasSelectedJobs()) {
      await loadComparison();
      return;
    }
    renderIdleState("Select at least one job to start the comparison.");
  }

  function cacheDom() {
    els.app = document.querySelector("[data-default-start]");
    els.status = document.getElementById("rlmCompareStatus");
    els.context = document.getElementById("rlmCompareContext");
    els.verdict = document.getElementById("rlmCompareVerdict");
    els.topCards = document.getElementById("rlmCompareTopCards");
    els.differences = document.getElementById("rlmCompareDifferences");
    els.runBehavior = document.getElementById("rlmCompareRunBehavior");
    els.zoneBehavior = document.getElementById("rlmCompareZoneBehavior");
    els.supporting = document.getElementById("rlmCompareSupporting");
    els.takeaway = document.getElementById("rlmCompareTakeaway");
    ["job1", "job2"].forEach((side) => {
      els[`${side}Machine`] = document.getElementById(`${side}Machine`);
      els[`${side}Start`] = document.getElementById(`${side}Start`);
      els[`${side}End`] = document.getElementById(`${side}End`);
      els[`${side}Job`] = document.getElementById(`${side}Job`);
      els[`${side}MinFeet`] = document.getElementById(`${side}MinFeet`);
      els[`${side}FilterChips`] = document.getElementById(`${side}FilterChips`);
    });
  }

  function bindEvents() {
    ["job1", "job2"].forEach((side) => {
      [els[`${side}Machine`], els[`${side}Start`], els[`${side}End`], els[`${side}Job`]].forEach((input) => {
        if (!input) return;
        input.addEventListener("change", async () => {
          if (input === els[`${side}Machine`] || input === els[`${side}Start`] || input === els[`${side}End`]) {
            await loadJobOptions(side);
          } else if (input === els[`${side}Job`]) {
            enforceDistinctSelections(side);
          }
          persistFilters();
          renderFilterChips();
          scheduleRefresh();
        });
      });
    });
    if (els.job1MinFeet) {
      els.job1MinFeet.addEventListener("input", async () => {
        syncMinFeet("job1");
        await Promise.all([loadJobOptions("job1"), loadJobOptions("job2")]);
        persistFilters();
        renderFilterChips();
        scheduleRefresh();
      });
    }
    if (els.job2MinFeet) {
      els.job2MinFeet.addEventListener("input", async () => {
        syncMinFeet("job2");
        await Promise.all([loadJobOptions("job1"), loadJobOptions("job2")]);
        persistFilters();
        renderFilterChips();
        scheduleRefresh();
      });
    }
  }

  function mirrorMinFeet() {
    const value = els.job1MinFeet?.value || els.job2MinFeet?.value || "";
    if (els.job1MinFeet && !els.job1MinFeet.value) els.job1MinFeet.value = value;
    if (els.job2MinFeet && !els.job2MinFeet.value) els.job2MinFeet.value = value;
  }

  function syncMinFeet(sourceSide) {
    const source = els[`${sourceSide}MinFeet`];
    const target = els[sourceSide === "job1" ? "job2MinFeet" : "job1MinFeet"];
    if (!source || !target) return;
    target.value = source.value;
  }

  async function loadJobOptions(side, preferredValue) {
    const params = new URLSearchParams();
    const machine = els[`${side}Machine`]?.value || "";
    const start = els[`${side}Start`]?.value || "";
    const end = els[`${side}End`]?.value || "";
    const minFeet = els[`${side}MinFeet`]?.value || "";
    const select = els[`${side}Job`];
    const currentValue = preferredValue ?? select?.value ?? "";
    if (machine) params.set("machine_id", machine);
    if (start) params.set("start", start);
    if (end) params.set("end", end);
    if (minFeet) params.set("min_feet", minFeet);
    params.set("structured", "1");
    const response = await fetch(`/rlm/api/jobs?${params.toString()}`);
    if (!response.ok) return;
    const payload = await response.json();
    if (!select) return;
    const options = Array.isArray(payload.jobOptions)
      ? payload.jobOptions
      : (payload.jobs || []).map((job) => ({ value: job, label: job }));
    const showMachineColumn = !machine;
    const machineWidth = showMachineColumn
      ? Math.max(...options.map((option) => normalizeOptionText(option.machineName || "").length), "Press".length)
      : 0;
    const jobWidth = Math.max(...options.map((option) => normalizeOptionText(option.jobName || option.value || "").length), 3);
    const reelTextWidth = Math.max(...options.map((option) => buildReelCountText(option.reelCount).length), "0 reels".length);
    const otherSide = side === "job1" ? "job2" : "job1";
    const otherSelectedValue = els[`${otherSide}Job`]?.value || "";
    const hasCurrent = currentValue && options.some((option) => option.value === currentValue);
    select.innerHTML = ['<option value="">Choose job</option>']
      .concat(options.map((option) => {
        const machineIdAttr = option.machineId ? ` data-machine-id="${escapeAttribute(option.machineId)}"` : "";
        const machineNameAttr = option.machineName ? ` data-machine-name="${escapeAttribute(option.machineName)}"` : "";
        const reelCountAttr = Number.isFinite(Number(option.reelCount)) ? ` data-reel-count="${escapeAttribute(option.reelCount)}"` : "";
        const jobNameAttr = option.jobName ? ` data-job-name="${escapeAttribute(option.jobName)}"` : "";
        const isUsedOnOtherSide = Boolean(otherSelectedValue) && option.value === otherSelectedValue;
        const disabledAttr = isUsedOnOtherSide ? " disabled" : "";
        const suffix = isUsedOnOtherSide ? " (selected on other side)" : "";
        const optionLabel = formatJobOptionLabel(option, {
          showMachineColumn,
          machineWidth,
          jobWidth,
          reelTextWidth,
        });
        return `<option value="${escapeAttribute(option.value)}"${machineIdAttr}${machineNameAttr}${reelCountAttr}${jobNameAttr}${disabledAttr} title="${escapeAttribute(optionLabel.trim())}">${escapeHtml(optionLabel + suffix)}</option>`;
      }))
      .join("");
    select.value = hasCurrent ? currentValue : "";
    enforceDistinctSelections(side);
    if (!state.restoringFilters) persistFilters();
    renderFilterChips();
  }

  function persistFilters() {
    try {
      const payload = {};
      ["job1", "job2"].forEach((side) => {
        payload[side] = {
          machine: els[`${side}Machine`]?.value || "",
          start: els[`${side}Start`]?.value || "",
          end: els[`${side}End`]?.value || "",
          job: els[`${side}Job`]?.value || "",
          minFeet: els[`${side}MinFeet`]?.value || "",
        };
      });
      window.localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(payload));
    } catch (_error) {
      // Best-effort persistence for local testing only.
    }
  }

  function restorePersistedFilters() {
    try {
      const raw = window.localStorage.getItem(FILTER_STORAGE_KEY);
      if (!raw) return null;
      const payload = JSON.parse(raw);
      ["job1", "job2"].forEach((side) => {
        const saved = payload?.[side];
        if (!saved) return;
        if (els[`${side}Machine`] && typeof saved.machine === "string") els[`${side}Machine`].value = saved.machine;
        if (els[`${side}Start`] && typeof saved.start === "string" && saved.start) els[`${side}Start`].value = saved.start;
        if (els[`${side}End`] && typeof saved.end === "string" && saved.end) els[`${side}End`].value = saved.end;
        if (els[`${side}MinFeet`] && typeof saved.minFeet === "string") els[`${side}MinFeet`].value = saved.minFeet;
      });
      return payload;
    } catch (_error) {
      // Ignore bad storage state and continue with defaults.
      return null;
    }
  }

  function renderFilterChips() {
    ["job1", "job2"].forEach((side) => {
      const target = els[`${side}FilterChips`];
      if (!target) return;
      const selected = getSelectedJobOption(side);
      const jobName = selected?.dataset?.jobName?.trim() || "";
      const machineName = selected?.dataset?.machineName?.trim() || "";
      const scopedJob = jobName
        ? (machineName && !els[`${side}Machine`]?.value ? `${machineName} - ${jobName}` : jobName)
        : "Any";
      const minFeet = normalizeMinFeetValue(els[`${side}MinFeet`]?.value);
      target.innerHTML = `
        ${renderFilterChip("Job", scopedJob)}
        ${renderFilterChip("Min reel feet", minFeet ? `${formatNumber(minFeet, 0)} ft` : "Any")}
      `;
    });
  }

  function renderFilterChip(label, value) {
    return `
      <span class="rlm-compare-filter-chip">
        <small>${escapeHtml(label)}</small>
        <strong>${escapeHtml(value)}</strong>
      </span>
    `;
  }

  function normalizeMinFeetValue(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  function formatJobOptionLabel(option, layout) {
    const jobName = normalizeOptionText(option.jobName || option.value || "");
    const reelText = padLeft(buildReelCountText(option.reelCount), layout.reelTextWidth);
    if (!layout.showMachineColumn) {
      return `${padRight(jobName, layout.jobWidth)}\u00a0|\u00a0${reelText}`;
    }
    const machineName = normalizeOptionText(option.machineName || "");
    return `${padRight(machineName, layout.machineWidth)}\u00a0|\u00a0${padRight(jobName, layout.jobWidth)}\u00a0|\u00a0${reelText}`;
  }

  function buildReelCountText(value) {
    const count = Math.max(0, Number.parseInt(value, 10) || 0);
    return `${count} ${count === 1 ? "reel" : "reels"}`;
  }

  function normalizeOptionText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function padRight(value, width) {
    const text = String(value || "");
    if (text.length >= width) return text;
    return text + "\u00a0".repeat(width - text.length);
  }

  function padLeft(value, width) {
    const text = String(value || "");
    if (text.length >= width) return text;
    return "\u00a0".repeat(width - text.length) + text;
  }

  function enforceDistinctSelections(changedSide) {
    const otherSide = changedSide === "job1" ? "job2" : "job1";
    const changedSelect = els[`${changedSide}Job`];
    const otherSelect = els[`${otherSide}Job`];
    if (!changedSelect || !otherSelect) return;
    const selectedValue = changedSelect.value || "";
    const otherCurrent = otherSelect.value || "";
    Array.from(otherSelect.options).forEach((option) => {
      if (!option.value) {
        option.disabled = false;
        return;
      }
      const baseLabel = option.textContent.replace(/\s+\(selected on other side\)$/u, "");
      const isTaken = Boolean(selectedValue) && option.value === selectedValue;
      option.disabled = isTaken;
      option.textContent = isTaken ? `${baseLabel} (selected on other side)` : baseLabel;
    });
    if (selectedValue && otherCurrent === selectedValue) {
      otherSelect.value = "";
    }
  }

  function scheduleRefresh() {
    if (state.refreshTimer) {
      clearTimeout(state.refreshTimer);
    }
    state.refreshTimer = setTimeout(() => {
      state.refreshTimer = null;
      if (!hasSelectedJobs()) {
        renderIdleState("Select at least one job to start the comparison.");
        setStatus("Select at least one job to compare.", "info");
        return;
      }
      loadComparison().catch((error) => setStatus(`Load failed: ${error.message}`, "error"));
    }, 180);
  }

  async function loadComparison() {
    if (!hasSelectedJobs()) {
      renderIdleState("Select at least one job to start the comparison.");
      setStatus("Select at least one job to compare.", "info");
      return;
    }
    state.loading = true;
    setStatus("Comparing jobs...", "info");
    const params = buildParams();
    const response = await fetch(`/rlm/api/job-comparison?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`Request failed (${response.status})`);
    }
    state.data = await response.json();
    state.loading = false;
    renderAll();
    setStatus("Loaded.", "success");
  }

  function hasSelectedJobs() {
    return Boolean(els.job1Job?.value || els.job2Job?.value);
  }

  function renderIdleState(message) {
    const text = escapeHtml(message || "Select at least one job to start the comparison.");
    if (els.context) {
      els.context.innerHTML = "";
    }
    if (els.verdict) {
      els.verdict.innerHTML = `<div class="rlm-compare-empty">${text}</div>`;
    }
    if (els.topCards) {
      els.topCards.innerHTML = "";
    }
    if (els.differences) {
      els.differences.innerHTML = `<div class="rlm-compare-empty">${text}</div>`;
    }
    if (els.runBehavior) {
      els.runBehavior.innerHTML = `<div class="rlm-compare-empty">${text}</div>`;
    }
    if (els.zoneBehavior) {
      els.zoneBehavior.innerHTML = `<div class="rlm-compare-empty">${text}</div>`;
    }
    if (els.supporting) {
      els.supporting.innerHTML = `<div class="rlm-compare-empty">${text}</div>`;
    }
    if (els.takeaway) {
      els.takeaway.innerHTML = `<div class="rlm-compare-empty">${text}</div>`;
    }
  }

  function buildParams() {
    const params = new URLSearchParams();
    ["job1", "job2"].forEach((side) => {
      if (els[`${side}Machine`]?.value) params.set(`${side}_machine_id`, els[`${side}Machine`].value);
      if (els[`${side}Start`]?.value) params.set(`${side}_start_date`, els[`${side}Start`].value);
      if (els[`${side}End`]?.value) params.set(`${side}_end_date`, els[`${side}End`].value);
      const selected = getSelectedJobOption(side);
      const jobName = selected?.dataset?.jobName?.trim() || "";
      if (jobName) params.set(`${side}_job`, jobName);
      const jobMachineId = selected?.dataset?.machineId?.trim() || "";
      if (!els[`${side}Machine`]?.value && jobMachineId) params.set(`${side}_job_machine_id`, jobMachineId);
      if (els[`${side}MinFeet`]?.value) params.set(`${side}_min_feet`, els[`${side}MinFeet`].value);
    });
    return params;
  }

  function renderAll() {
    const data = state.data || {};
    renderContext(data);
    renderVerdict(data.comparison || {});
    renderTopCards(data.comparison?.topCards || []);
    renderDifferences(data);
    renderRunBehavior(data);
    renderZoneBehavior(data);
    renderSupporting(data);
    renderTakeaway(data.comparison || {});
  }

  function renderVerdict(comparison) {
    if (!els.verdict) return;
    const analytics = comparison.analytics || {};
    const summaryRows = (analytics.summaryRows || []).filter((row) => {
      const label = String(row?.label || "").trim().toLowerCase();
      return label === "main gap";
    }).slice(0, 1);
    els.verdict.innerHTML = `
      <article class="rlm-compare-verdict-card">
        <p class="rlm-compare-eyebrow">Overall Result</p>
        <div class="rlm-compare-verdict-head">
          <strong>${escapeHtml(analytics.overallLabel || "Comparison loaded")}</strong>
        </div>
        <div class="rlm-compare-summary-rows">
          ${summaryRows.length ? summaryRows.map(renderSummaryRow).join("") : `<p>${escapeHtml(comparison.summaryParagraph || "No comparison summary available.")}</p>`}
        </div>
      </article>
    `;
  }

  function renderTopCards(cards) {
    if (!els.topCards) return;
    if (!cards.length) {
      els.topCards.innerHTML = '<div class="rlm-compare-empty">No top-line comparison metrics available.</div>';
      return;
    }
    els.topCards.innerHTML = cards.map(renderMetricStage).join("");
  }

  function renderMetricStage(card) {
    const compareValues = formatComparisonValues(card);
    const winnerText = describeCardWinner(card);
    return `
      <section class="rlm-compare-stage rlm-compare-stage--metric">
        ${renderStageSideCard("job1", formatMetric(card.job1Value, card.unit))}
        <article class="rlm-compare-stage__center is-${card.better || "none"}">
          <p>${escapeHtml(card.label || "Metric")}</p>
          <strong>${escapeHtml(compareValues)}</strong>
          <small>${escapeHtml(winnerText)}</small>
          ${renderCompareMeter(card.job1Value, card.job2Value, card.unit, card.better)}
        </article>
        ${renderStageSideCard("job2", formatMetric(card.job2Value, card.unit))}
      </section>
    `;
  }

  function describeCardWinner(card) {
    if (!card) return "No comparison";
    const better = card.better;
    const deltaDisplay = formatAbsoluteMetricDelta(card.delta, card.unit);
    const leftNum = toNumber(card.job1Value);
    const rightNum = toNumber(card.job2Value);
    if (leftNum === null && rightNum === null) return "No comparison";
    if (better !== "job1" && better !== "job2") return "Tied";
    const subject = better === "job1" ? "Job 1" : "Job 2";
    if (deltaDisplay === "--") return `${subject} better`;
    return `Δ ${deltaDisplay} · ${subject} better`;
  }

  function formatAbsoluteMetricDelta(value, unit) {
    const num = toNumber(value);
    if (num === null) return "--";
    return formatMetric(Math.abs(num), unit);
  }

  function formatComparisonValues(card) {
    if (!card) return "--";
    return `${formatMetric(card.job1Value, card.unit)} vs ${formatMetric(card.job2Value, card.unit)}`;
  }

  function renderContext(data) {
    if (!els.context) return;
    const left = data.job1 || {};
    const right = data.job2 || {};
    const overall = formatOverallResult(data);
    const winner = data.comparison?.winner || "";
    const winnerLabel = winner === "job1" ? "Job 1" : winner === "job2" ? "Job 2" : "No winner yet";
    els.context.innerHTML = `
      <div class="rlm-compare-hero">
        ${renderContextOverview("Job 1", left, winner === "job1" ? "is-better" : winner === "job2" ? "is-worse" : "")}
        <div class="rlm-compare-context-overall rlm-compare-hero__center">
          <div class="rlm-compare-winner-badge">
            <span class="rlm-compare-winner-badge__icon">👑</span>
            <span class="rlm-compare-winner-badge__label">Winner</span>
            <strong>${escapeHtml(winnerLabel)}</strong>
          </div>
          <strong>${escapeHtml(overall)}</strong>
          <div class="rlm-compare-hero__summary">
            ${(data.comparison?.analytics?.summaryRows || [])
              .filter((row) => String(row?.label || "").trim().toLowerCase() === "main gap")
              .slice(0, 1)
              .map(renderHeroSummary)
              .join("")}
          </div>
        </div>
        ${renderContextOverview("Job 2", right, winner === "job2" ? "is-better" : winner === "job1" ? "is-worse" : "")}
      </div>
    `;
  }

  function renderContextOverview(label, side, toneClass = "") {
    const filters = side.filters || {};
    const population = side.selectedPopulation || {};
    const aggregate = side.aggregate || {};
    const displayReelCount = getDisplayReelCount(side);
    const displayFeet = getDisplayTotalFeet(side);
    const startTime = population.runStart || aggregate.runStart || filters.start;
    const endTime = population.runEnd || aggregate.runEnd || filters.end;
    const runFlag = getRunFlag(side);
    return `
      <article class="rlm-compare-overview-card ${side.isSelected ? "" : "is-empty"} ${toneClass}">
        <div class="rlm-compare-overview-card__top">
          <p>${escapeHtml(label)}</p>
          <small>${escapeHtml(formatDateTime(startTime))}</small>
        </div>
        <h3>${escapeHtml(filters.jobLabel || "Choose job")}</h3>
        <div class="rlm-compare-overview-card__sub">
          <small>${escapeHtml(filters.machineName || "All presses")}</small>
          <small>${escapeHtml(formatDateTime(endTime))}</small>
        </div>
        <div class="rlm-compare-overview-card__stats">
          ${renderOverviewStat("Reels", formatCount(displayReelCount))}
          ${renderOverviewStat("Total Feet", formatFeet(displayFeet))}
          ${renderOverviewStat("Bad Feet %", formatPercent(aggregate.badFeetPct))}
          ${renderOverviewStat("Bad Feet", formatFeet(aggregate.totalBadFeet))}
          ${renderOverviewStat("Monitoring Points", formatCount(aggregate.monitoringPointsTotal), formatMetric(aggregate.monitoringDensity, "pts/1k ft"))}
          ${renderOverviewStat("Active %", formatPercent(aggregate.activeReelPct), `${formatCount(aggregate.activeReelCount)} / ${formatCount(displayReelCount)} reels`)}
        </div>
        ${runFlag ? `<div class="rlm-compare-overview-flag">${escapeHtml(runFlag)}</div>` : ""}
      </article>
    `;
  }

  function renderOverviewStat(label, value, secondary = "") {
    return `
      <div class="rlm-compare-overview-stat">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value || "--")}</strong>
        ${secondary ? `<small>${escapeHtml(secondary)}</small>` : ""}
      </div>
    `;
  }

  function getSelectedOptionReelCount(sideKey) {
    const selected = getSelectedJobOption(sideKey);
    const count = Number(selected?.dataset?.reelCount);
    return Number.isFinite(count) ? count : null;
  }

  function getSelectedJobOption(sideKey) {
    const select = sideKey ? els[`${sideKey}Job`] : null;
    return select?.options?.[select.selectedIndex] || null;
  }

  function getDisplayReelCount(side) {
    const populationCount = Number(side?.selectedPopulation?.reelCount);
    if (Number.isFinite(populationCount) && populationCount > 0) return populationCount;
    const aggregateCount = Number(side?.aggregate?.reelCount);
    if (Number.isFinite(aggregateCount) && aggregateCount > 0) return aggregateCount;
    const selectedReelCount = getSelectedOptionReelCount(side?.sideKey);
    return Number.isFinite(selectedReelCount) ? selectedReelCount : 0;
  }

  function getDisplayTotalFeet(side) {
    const populationFeet = toNumber(side?.selectedPopulation?.totalFeet);
    if (populationFeet !== null && populationFeet > 0) return populationFeet;
    const aggregateFeet = toNumber(side?.aggregate?.totalFeet);
    if (aggregateFeet !== null && aggregateFeet > 0) return aggregateFeet;
    return null;
  }

  function getRunFlag(side) {
    const readiness = side?.comparisonReadiness || {};
    if (readiness.message) {
      return readiness.message;
    }
    const populationCount = Number(side?.selectedPopulation?.reelCount || 0);
    const aggregate = side?.aggregate || {};
    const reelCount = Number(aggregate.reelCount || 0);
    const activeReelCount = Number(aggregate.activeReelCount || 0);
    if (populationCount > 0 && reelCount === 0) {
      return `${populationCount} reels matched the selection, but none had enough usable RLM coverage for comparison.`;
    }
    if (populationCount > 0 && activeReelCount === 0) {
      return `RLM was inactive across the full selected run (${populationCount} reels).`;
    }
    return "";
  }

  function formatOverallResult(data) {
    const comparison = data.comparison || {};
    const analytics = comparison.analytics || {};
    const base = analytics.overallLabel || "Waiting for comparison";
    const winnerKey = comparison.winner;
    if (!winnerKey || !/^Clear edge to /i.test(base)) {
      return base;
    }
    const winnerSide = winnerKey === "job1" ? data.job1 || {} : data.job2 || {};
    const jobLabel = winnerSide.filters?.jobLabel || (winnerKey === "job1" ? "Job 1" : "Job 2");
    const machineName = winnerSide.filters?.machineName || "";
    return `Clear edge to ${jobLabel} (${winnerKey === "job1" ? "Job 1" : "Job 2"})${machineName ? ` on ${machineName}` : ""}`;
  }

  function renderHeroSummary(row) {
    return `
      <div class="rlm-compare-hero__summary-row">
        <span>${escapeHtml(row.label || "")}</span>
        <strong>${escapeHtml(row.value || "")}</strong>
      </div>
    `;
  }

  function renderDifferences(data) {
    if (!els.differences) return;
    const comparison = data.comparison || {};
    const left = data.job1 || {};
    const right = data.job2 || {};
    const bullets = comparison.mainDifferences || [];
    const diffRows = comparison.analytics?.diffRows || [];
    els.differences.innerHTML = `
      <section class="rlm-compare-stage">
        <article class="rlm-compare-detail-card">
          <h3>${escapeHtml(left.filters?.jobLabel || "Job 1")}</h3>
          <div class="rlm-compare-key-grid">
            ${renderKeyRow("Reels", formatCount(left.aggregate?.reelCount))}
            ${renderKeyRow("Total feet", formatFeet(left.aggregate?.totalFeet))}
            ${renderKeyRow("Active feet", formatPercent(left.aggregate?.activeFeetPct))}
            ${renderKeyRow("Active reels", formatPercent(left.aggregate?.activeReelPct))}
          </div>
        </article>
        <article class="rlm-compare-detail-card rlm-compare-detail-card--compare">
          <h3>Strongest Drivers</h3>
          <div class="rlm-compare-difference-list">
            ${diffRows.map(renderDifferenceRow).join("") || bullets.map((item) => `<div class="rlm-compare-difference-row"><p>${escapeHtml(item)}</p></div>`).join("")}
          </div>
          <div class="rlm-compare-driver-grid">
            ${renderDriverStat("Quality gap", comparison.analytics?.qualityGapDisplay)}
            ${renderDriverStat("Coverage gap", comparison.analytics?.coverageGapDisplay)}
            ${renderDriverStat("Run pattern", comparison.analytics?.patternRead)}
          </div>
        </article>
        <article class="rlm-compare-detail-card">
          <h3>${escapeHtml(right.filters?.jobLabel || "Job 2")}</h3>
          <div class="rlm-compare-key-grid">
            ${renderKeyRow("Reels", formatCount(right.aggregate?.reelCount))}
            ${renderKeyRow("Total feet", formatFeet(right.aggregate?.totalFeet))}
            ${renderKeyRow("Active feet", formatPercent(right.aggregate?.activeFeetPct))}
            ${renderKeyRow("Active reels", formatPercent(right.aggregate?.activeReelPct))}
          </div>
        </article>
      </section>
    `;
  }

  function renderRunBehavior(data) {
    if (!els.runBehavior) return;
    const left = data.job1 || {};
    const right = data.job2 || {};
    const comparison = data.comparison || {};
    els.runBehavior.innerHTML = `
      <section class="rlm-compare-stage">
        ${renderRunCard(left)}
        ${renderRunCompareCard(left, right, comparison)}
        ${renderRunCard(right)}
      </section>
    `;
  }

  function renderRunCard(side) {
    const aggregate = side.aggregate || {};
    const profile = aggregate.runProfile || {};
    const series = side.reelSeries || [];
    return `
      <article class="rlm-compare-detail-card">
        <div class="rlm-compare-card-title">
          <div>
            <p>${escapeHtml(side.filters?.jobLabel || side.sideLabel || "Job")}</p>
            <small>${escapeHtml(side.filters?.machineName || "")}</small>
          </div>
          <span class="rlm-compare-chip">${escapeHtml(profile.direction || "unclear")}</span>
        </div>
        <p class="rlm-compare-copy">${escapeHtml(profile.summary || "No run-direction summary available.")}</p>
        <div class="rlm-compare-key-grid">
          ${renderKeyRow("First-half bad feet %", formatPercent(profile.firstHalfBadFeetPct))}
          ${renderKeyRow("Second-half bad feet %", formatPercent(profile.secondHalfBadFeetPct))}
          ${renderKeyRow("Late degrade rate", formatPercent(aggregate.derivedFeatures?.lateDegradeRate))}
          ${renderKeyRow("Clustered bad rate", formatPercent(aggregate.derivedFeatures?.clusteredBadRate))}
        </div>
        <div class="rlm-compare-sparkline-wrap">
          ${renderSparkline(series.map((item) => toNumber(item.estimatedBadFeetPct)).filter((value) => value !== null))}
        </div>
        <div class="rlm-compare-reel-list">
          <div>
            <h4>Worst reels</h4>
            ${(side.worstReels || []).slice(0, 3).map(renderReelRow).join("") || '<p class="rlm-compare-muted">No reel detail.</p>'}
          </div>
          <div>
            <h4>Best reels</h4>
            ${(side.bestReels || []).slice(0, 3).map(renderReelRow).join("") || '<p class="rlm-compare-muted">No reel detail.</p>'}
          </div>
        </div>
      </article>
    `;
  }

  function renderRunCompareCard(left, right, comparison) {
    const leftValues = (left.reelSeries || []).map((item) => toNumber(item.estimatedBadFeetPct)).filter((value) => value !== null);
    const rightValues = (right.reelSeries || []).map((item) => toNumber(item.estimatedBadFeetPct)).filter((value) => value !== null);
    return `
      <article class="rlm-compare-detail-card rlm-compare-detail-card--compare">
        <h3>Run Comparison</h3>
        <p class="rlm-compare-copy">${escapeHtml(comparison.analytics?.patternRead || "No run comparison available.")}</p>
        <div class="rlm-compare-driver-grid">
          ${renderDriverStat("Job 1 direction", left.aggregate?.runProfile?.direction || "unclear")}
          ${renderDriverStat("Job 2 direction", right.aggregate?.runProfile?.direction || "unclear")}
          ${renderDriverStat("Main read", comparison.analytics?.winnerPatternChip || comparison.analytics?.loserPatternChip || "unclear")}
        </div>
        <div class="rlm-compare-dual-sparkline">
          ${renderSparkline(leftValues)}
          ${renderSparkline(rightValues)}
        </div>
      </article>
    `;
  }

  function renderZoneBehavior(data) {
    if (!els.zoneBehavior) return;
    const zoneConclusion = data.comparison?.analytics?.zoneComparisonConclusion;
    els.zoneBehavior.innerHTML = `
      <section class="rlm-compare-stage">
        ${renderZoneCard(data.job1 || {})}
        <article class="rlm-compare-detail-card rlm-compare-detail-card--compare">
          <h3>Zone Comparison</h3>
          <p class="rlm-compare-copy">${escapeHtml(zoneConclusion || "No zone comparison available.")}</p>
          <div class="rlm-compare-zone-compare">
            ${renderZoneCompareRows(data.job1 || {}, data.job2 || {})}
          </div>
        </article>
        ${renderZoneCard(data.job2 || {})}
      </section>
    `;
  }

  function renderZoneCompareRows(left, right) {
    const zones = ["early", "middle", "late"].map((key) => {
      const leftZone = (left.aggregate?.zoneSummary || []).find((item) => item.key === key) || {};
      const rightZone = (right.aggregate?.zoneSummary || []).find((item) => item.key === key) || {};
      return { key, label: leftZone.label || rightZone.label || key, left: leftZone, right: rightZone };
    });
    return zones.map((zone) => {
      const leftShare = Math.max(0, Math.min(Number(zone.left.badFeetSharePct) || 0, 100));
      const rightShare = Math.max(0, Math.min(Number(zone.right.badFeetSharePct) || 0, 100));
      return `
        <div class="rlm-compare-zone-compare-row">
          <div class="rlm-compare-zone-compare-row__head">
            <strong>${escapeHtml(zone.label)}</strong>
            <small>${formatPercent(zone.left.badPointPct)} vs ${formatPercent(zone.right.badPointPct)}</small>
          </div>
          <div class="rlm-compare-zone-compare-row__bars">
            <span class="is-job1" style="width:${leftShare}%"></span>
            <span class="is-job2" style="width:${rightShare}%"></span>
          </div>
        </div>
      `;
    }).join("");
  }

  function renderZoneCard(side) {
    const aggregate = side.aggregate || {};
    const zones = aggregate.zoneSummary || [];
    return `
      <article class="rlm-compare-detail-card">
        <div class="rlm-compare-card-title">
          <div>
            <p>${escapeHtml(side.filters?.jobLabel || side.sideLabel || "Job")}</p>
            <small>${escapeHtml(side.intraReelConclusion || side.summaryParagraph || "")}</small>
          </div>
        </div>
        <div class="rlm-compare-zone-list">
          ${zones.map(renderZoneRow).join("") || '<p class="rlm-compare-muted">No zone data.</p>'}
        </div>
      </article>
    `;
  }

  function renderZoneRow(zone) {
    const share = Math.max(0, Math.min(Number(zone.badFeetSharePct) || 0, 100));
    return `
      <div class="rlm-compare-zone-row">
        <div class="rlm-compare-zone-row__head">
          <strong>${escapeHtml(zone.label || zone.key || "Zone")}</strong>
          <span>${formatPercent(zone.badPointPct)} bad pts</span>
        </div>
        <div class="rlm-compare-zone-bar">
          <span style="width:${share}%"></span>
        </div>
        <div class="rlm-compare-zone-row__meta">
          <small>${formatFeet(zone.badFeet)} bad feet</small>
          <small>${formatPoints(zone.badMonitoringPoints, zone.matchedMonitoringPoints)}</small>
          <small>${formatMetric(zone.avgAbsDelta, "mm")}</small>
        </div>
      </div>
    `;
  }

  function renderSupporting(data) {
    if (!els.supporting) return;
    const left = data.job1 || {};
    const right = data.job2 || {};
    const metrics = left.supportingMetrics || [];
    if (!metrics.length) {
      els.supporting.innerHTML = '<div class="rlm-compare-empty">No supporting metrics available.</div>';
      return;
    }
    els.supporting.innerHTML = metrics
      .map((metric) => {
        const rightMetric = (right.supportingMetrics || []).find((item) => item.key === metric.key) || {};
        const delta =
          toNumber(metric.value) !== null && toNumber(rightMetric.value) !== null
            ? formatMetric(toNumber(metric.value) - toNumber(rightMetric.value), rightMetric.unit || metric.unit)
            : "--";
        return `
          <section class="rlm-compare-stage rlm-compare-stage--support">
            <article class="rlm-compare-detail-card">
              <h3>Job 1</h3>
              ${renderKeyRow(metric.label || metric.key, formatMetric(metric.value, metric.unit))}
            </article>
            <article class="rlm-compare-detail-card rlm-compare-detail-card--compare">
              <h3>${escapeHtml(metric.label || metric.key)}</h3>
              <div class="rlm-compare-support-center">
                <strong>${escapeHtml(delta)}</strong>
                <small>${escapeHtml(rightMetric.direction === "higher_better" || metric.direction === "higher_better" ? "Compare for advantage" : "Compare for loss")}</small>
              </div>
            </article>
            <article class="rlm-compare-detail-card">
              <h3>Job 2</h3>
              ${renderKeyRow(rightMetric.label || metric.label || metric.key, formatMetric(rightMetric.value, rightMetric.unit || metric.unit))}
            </article>
          </section>
        `;
      })
      .join("");
  }

  function renderTakeaway(comparison) {
    if (!els.takeaway) return;
    els.takeaway.innerHTML = `
      <article class="rlm-compare-verdict-card">
        <p>${escapeHtml(comparison.takeaway || "No takeaway available.")}</p>
      </article>
    `;
  }

  function renderReelRow(reel) {
    return `
      <div class="rlm-compare-reel-row">
        <span>${escapeHtml(reel.reelId || "Reel")}</span>
        <strong>${formatPercent(reel.estimatedBadFeetPct)}</strong>
        <small>${formatFeet(reel.estimatedBadFeet)} · ${escapeHtml(reel.dominantBadZone || "none")}</small>
      </div>
    `;
  }

  function renderKeyRow(label, value) {
    return `
      <div class="rlm-compare-key-row">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value || "--")}</strong>
      </div>
    `;
  }

  function renderDriverStat(label, value) {
    if (!value) return "";
    return `
      <div class="rlm-compare-driver-stat">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
      </div>
    `;
  }

  function renderSummaryRow(row) {
    return `
      <div class="rlm-compare-summary-row">
        <span>${escapeHtml(row.label || "")}</span>
        <strong>${escapeHtml(row.value || "")}</strong>
      </div>
    `;
  }

  function renderDifferenceRow(row) {
    const classes = ["rlm-compare-difference-row"];
    if (row.better === "job1") classes.push("is-job1");
    if (row.better === "job2") classes.push("is-job2");
    return `
      <div class="${classes.join(" ")}">
        <div class="rlm-compare-difference-row__head">
          <p>${escapeHtml(row.label || "Metric")}</p>
          ${row.deltaDisplay ? `<strong>${escapeHtml(row.deltaDisplay)}</strong>` : ""}
        </div>
        <div class="rlm-compare-difference-row__values">
          <span>${escapeHtml(row.job1Label || "Job 1")}</span>
          <strong>${escapeHtml(formatMetric(row.job1Value, row.unit))}</strong>
          <span>${escapeHtml(row.job2Label || "Job 2")}</span>
          <strong>${escapeHtml(formatMetric(row.job2Value, row.unit))}</strong>
        </div>
        ${row.interpretation ? `<small>${escapeHtml(row.interpretation)}</small>` : ""}
      </div>
    `;
  }

  function renderStageSideCard(sideKey, value) {
    const side = sideKey === "job1" ? state.data?.job1 : state.data?.job2;
    const filters = side?.filters || {};
    const machineName = filters.machineName || "All presses";
    const jobName = filters.jobLabel || "Choose job";
    const sideLabel = sideKey === "job1" ? "Job 1" : "Job 2";
    const title = `${machineName} · ${sideLabel} · ${jobName}`;
    return `
      <article class="rlm-compare-stage__side">
        <span>${escapeHtml(title)}</span>
        <strong>${escapeHtml(value || "--")}</strong>
      </article>
    `;
  }

  function renderCompareMeter(leftValue, rightValue, unit, better) {
    const leftNum = toNumber(leftValue);
    const rightNum = toNumber(rightValue);
    if (leftNum === null || rightNum === null) {
      return '<div class="rlm-compare-meter"><span class="is-job1" style="width:50%"></span><span class="is-job2" style="width:50%"></span></div>';
    }
    const total = Math.max(Math.abs(leftNum) + Math.abs(rightNum), 1);
    const leftShare = Math.max(10, Math.min((Math.abs(leftNum) / total) * 100, 90));
    const rightShare = Math.max(10, Math.min((Math.abs(rightNum) / total) * 100, 90));
    return `
      <div class="rlm-compare-meter ${better === "job1" ? "is-job1" : better === "job2" ? "is-job2" : ""}">
        <span class="is-job1" style="width:${leftShare}%"></span>
        <span class="is-job2" style="width:${rightShare}%"></span>
      </div>
    `;
  }

  function renderMiniTrend(label, payload) {
    if (!payload) return "";
    return `
      <div class="rlm-compare-mini-trend">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(payload.deltaDisplay || "--")}</strong>
        <small>${escapeHtml(payload.materialityLabel || "")}</small>
      </div>
    `;
  }

  function renderSparkline(values) {
    if (!values.length) return '<div class="rlm-compare-muted">No reel trend available.</div>';
    const width = 320;
    const height = 64;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const points = values.map((value, index) => {
      const x = (index / Math.max(values.length - 1, 1)) * width;
      const y = height - ((value - min) / range) * (height - 8) - 4;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return `
      <svg viewBox="0 0 ${width} ${height}" class="rlm-compare-sparkline" preserveAspectRatio="none" aria-hidden="true">
        <polyline points="${points.join(" ")}"></polyline>
      </svg>
    `;
  }

  function setStatus(message, type) {
    if (!els.status) return;
    els.status.textContent = message || "";
    els.status.dataset.status = type || "info";
  }

  function formatMetric(value, unit) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
    if (unit === "%") return formatPercent(value);
    if (unit === "ft") return formatFeet(value);
    if (unit === "mm") return `${formatNumber(value, 3)} mm`;
    if (unit === "pts/1k ft") return `${formatNumber(value, 1)} pts/1k ft`;
    return `${formatNumber(value, 2)}${unit ? ` ${unit}` : ""}`;
  }

  function formatFeet(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
    return `${formatNumber(value, 0)} ft`;
  }

  function formatPercent(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
    return `${Number(value).toFixed(1)}%`;
  }

  function formatDateTime(value) {
    if (!value) return "--";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function formatPoints(bad, total) {
    if (bad === null || bad === undefined || total === null || total === undefined) return "--";
    return `${formatCount(bad)} / ${formatCount(total)} pts`;
  }

  function formatCount(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
    return Number(value).toLocaleString();
  }

  function formatNumber(value, digits) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
    return Number(value).toLocaleString(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function toNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttribute(value) {
    return escapeHtml(value);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
