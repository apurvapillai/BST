  const JobExplorerTab = (() => {
    let listEl;
    let detailEl;
    let paginationEl;
    let sortSelect;
    let statusFilterRoot;
    const statusCheckboxes = {};
    let statusUpdating = false;
    const REVIEW_STATUS_VALUES = ["pass", "fail", "uninspected"];
    const CLASSIFICATION_OPTIONS = [
      { value: "active", label: "Active" },
      { value: "inspection_deactivated", label: "Inspection Deactivated" },
      { value: "make_ready", label: "Make Ready" },
      { value: "splice", label: "Splice" },
      { value: "scrap", label: "Scrap" },
    ];
    const COVERAGE_DEFAULT_MIN_FEET = 4000;
    const COVERAGE_MIN_STORAGE_KEY = "job.coverageMinReelLength";
    const FEET_TO_METERS = 0.3048;
    const METERS_TO_FEET = 3.28084;

    let coverageMinLengthFilter = loadCoverageMinLength();

    let state = {
      page: 1,
      selectedReelId: null,
      sort: "time",
      cachedItems: [],
      pageInfo: null,
      insights: null,
      reviewStatus: null,
    };
    const summaryCache = new Map();
    const reviewPanel = Utils.qs("#defectReviewPanel");
    const reviewPanelStatusEl = reviewPanel ? reviewPanel.querySelector("[data-review-status]") : null;
    const reviewPanelMetaEl = reviewPanel ? reviewPanel.querySelector("[data-review-meta]") : null;
    const reviewPanelHost = reviewPanel ? reviewPanel.querySelector("[data-review-form-host]") : null;
    const reviewPanelControls = reviewPanel ? reviewPanel.querySelector("[data-review-controls]") : null;
    const reviewPanelButtons = reviewPanelControls
      ? Array.from(reviewPanelControls.querySelectorAll("[data-review-action]"))
      : [];
    const reviewPanelNewBtn = reviewPanel ? reviewPanel.querySelector("[data-review-new]") : null;
    let reviewPanelReady = false;
    let reviewPanelListenerAttached = false;
    let reviewPanelActiveId = null;
    const reviewSummaryFetches = new Map();
    function normalizeClassification(value, fallback = "active") {
      if (value === null || value === undefined) return fallback;
      const normalized = String(value).trim().toLowerCase().replace(/\s+/g, "_");
      return CLASSIFICATION_OPTIONS.some((opt) => opt.value === normalized) ? normalized : fallback;
    }
    function classificationLabel(value) {
      const normalized = normalizeClassification(value);
      const match = CLASSIFICATION_OPTIONS.find((opt) => opt.value === normalized);
      return match ? match.label : normalized;
    }

    let latestLoadToken = 0;
    const load = Utils.debounce(async () => {
      const requestToken = ++latestLoadToken;
      LoadingOverlay.show();
      try {
        const params = { page: state.page };
        if (state.reviewStatus) {
          params.review_status = state.reviewStatus;
        }
        if (coverageMinLengthFilter > 0) {
          params.min_reel_length = coverageMinLengthFilter;
        }
        const data = await Api.get("job-explorer", params);
        if (requestToken !== latestLoadToken) {
          return;
        }
        state.cachedItems = applySort(data.items || []);
        registerReelMetadataFromItems(state.cachedItems);
        state.pageInfo = data.page_info || null;
        state.insights = data.insights || null;
        renderJobInsights();
        renderList();
        renderPagination();
        ensureSelection();
      } catch (err) {
        console.error("Job explorer load failed", err);
      } finally {
        LoadingOverlay.hide();
      }
    }, FETCH_DEBOUNCE_MS);

    function init() {
      listEl = Utils.qs("#jobReelList");
      detailEl = Utils.qs("#jobDetail");
      paginationEl = Utils.qs("#jobPagination");
      sortSelect = Utils.qs("#jobSort");
      statusFilterRoot = Utils.qs("#jobReviewFilters");
      setupCoverageMinLengthControls();

      if (sortSelect) {
        sortSelect.addEventListener("change", () => {
          state.sort = sortSelect.value;
          state.page = 1;
          load.flush();
        });
      }

      if (statusFilterRoot) {
        statusCheckboxes.all = Utils.qs("#jobStatusAll");
        statusCheckboxes.pass = Utils.qs("#jobStatusPass");
        statusCheckboxes.fail = Utils.qs("#jobStatusFail");
        statusCheckboxes.uninspected = Utils.qs("#jobStatusUninspected");

        Object.entries(statusCheckboxes).forEach(([key, input]) => {
          if (!input) return;
          input.addEventListener("change", () => {
            if (statusUpdating) return;
            handleStatusChange(key);
          });
        });
        updateStatusFilterUI();
      }

      setupReviewPanel();
    }

    function activate() {
      load.flush();
    }

    function onFiltersUpdated() {
      state.page = 1;
      load();
    }

    function handleStatusChange(key) {
      if (key === "all") {
        state.reviewStatus = null;
      } else {
        const input = statusCheckboxes[key];
        if (!input) return;
        state.reviewStatus = input.checked ? key : null;
      }
      updateStatusFilterUI();
      state.page = 1;
      load.flush();
    }

    function setupReviewPanel() {
      if (!reviewPanel || reviewPanelReady) return;
      reviewPanelReady = true;
      reviewPanelButtons.forEach((button) => {
        button.addEventListener("click", () => {
          if (button.disabled) return;
          const decision = (button.dataset.reviewAction || "").toLowerCase();
          if (!decision) return;
          openReviewForm(decision);
        });
      });
      if (reviewPanelNewBtn) {
        reviewPanelNewBtn.addEventListener("click", () => {
          if (reviewPanelNewBtn.disabled) return;
          const ids = Filters.getReelIds();
          if (ids.length) {
            Filters.removeReel(ids[ids.length - 1], { emit: true });
          } else {
            Filters.removeReel("", { emit: true });
          }
          Router.setActive("job");
          window.requestAnimationFrame(() => {
            window.scrollTo({ top: 0, behavior: "smooth" });
          });
        });
      }
      if (!reviewPanelListenerAttached) {
        Filters.onChange(() => {
          updateReviewPanel();
        });
        reviewPanelListenerAttached = true;
      }
      updateReviewPanel(summaryCache.get(state.selectedReelId) || null);
    }

    function getPrimaryFilterReelId() {
      const ids = Filters.getReelIds();
      if (!ids || !ids.length) return null;
      const candidate = ids[ids.length - 1] || ids[0];
      const numeric = Number(candidate);
      return Number.isFinite(numeric) ? numeric : null;
    }

    function getPrimaryFilterCode() {
      const codes = Filters.getReelCodes();
      if (!codes || !codes.length) return "";
      return codes[codes.length - 1] || codes[0] || "";
    }

    function setReviewButtonsDisabled(disabled) {
      reviewPanelButtons.forEach((button) => {
        if (disabled) {
          button.setAttribute("disabled", "disabled");
        } else {
          button.removeAttribute("disabled");
        }
      });
    }

    function toggleReviewControlsVisible(visible) {
      if (!reviewPanelControls) return;
      reviewPanelControls.classList.toggle("is-hidden", !visible);
    }

    function syncReviewButtonState(summaryOrReview) {
      let decision = "";
      if (summaryOrReview) {
        if (summaryOrReview.review && summaryOrReview.review.decision) {
          decision = String(summaryOrReview.review.decision).toLowerCase();
        } else if (summaryOrReview.decision) {
          decision = String(summaryOrReview.decision).toLowerCase();
        }
      }
      reviewPanelButtons.forEach((button) => {
        const action = (button.dataset.reviewAction || "").toLowerCase();
        button.classList.toggle("is-active", Boolean(decision) && action === decision);
      });
    }

    function updateReviewPanel(summary) {
      if (!reviewPanel) return;
      const filterIds = Filters.getReelIds();
      const filterCodes = Filters.getReelCodes();
      const hasFilterSelection = (filterIds && filterIds.length) || (filterCodes && filterCodes.length);

      let targetSummary = summary || null;
      let targetId = null;

      const summaryReelId =
        targetSummary && targetSummary.reel && targetSummary.reel.reel_id !== undefined
          ? Number(targetSummary.reel.reel_id)
          : null;
      if (Number.isFinite(summaryReelId)) {
        targetId = summaryReelId;
      }

      if ((targetId === null || targetId === undefined) && hasFilterSelection) {
        const preferred = getPrimaryFilterReelId();
        if (preferred !== null && preferred !== undefined) {
          targetId = preferred;
        }
      }

      if ((targetId === null || targetId === undefined) && reviewPanel.dataset.reelId) {
        const datasetId = Number(reviewPanel.dataset.reelId);
        if (Number.isFinite(datasetId)) {
          targetId = datasetId;
        }
      }

      if (targetId !== null && targetId !== undefined && !Number.isFinite(targetId)) {
        targetId = null;
      }

      if (targetId !== null && targetId !== undefined && !targetSummary) {
        targetSummary = summaryCache.get(Number(targetId)) || null;
      }

      const candidateCode =
        (targetSummary && targetSummary.reel && targetSummary.reel.reel_code) || getPrimaryFilterCode();
      const inReview =
        hasFilterSelection &&
        targetId !== null &&
        targetId !== undefined &&
        Filters.hasReelSelection(targetId, candidateCode || null);

      if (!inReview) {
        state.selectedReelId = null;
        reviewPanelActiveId = null;
        reviewPanel.classList.remove("is-active");
        reviewPanel.dataset.reelId = "";
        reviewPanel.dataset.reelCode = "";
        if (reviewPanelStatusEl) {
          reviewPanelStatusEl.textContent = "Select a reel from Job Explorer to start a review.";
        }
        if (reviewPanelMetaEl) {
          reviewPanelMetaEl.textContent = "";
        }
        setReviewButtonsDisabled(true);
        if (reviewPanelNewBtn) {
          reviewPanelNewBtn.disabled = true;
        }
        toggleReviewControlsVisible(true);
        syncReviewButtonState(null);
        closeReviewForm();
        return;
      }

      const normalizedId = Number(targetId);
      if (Number.isFinite(normalizedId)) {
        state.selectedReelId = normalizedId;
      }
      const previousId = reviewPanelActiveId;
      reviewPanelActiveId = Number.isFinite(normalizedId) ? normalizedId : previousId;
      if (previousId !== reviewPanelActiveId) {
        closeReviewForm();
      }
      if (reviewPanelNewBtn) {
        reviewPanelNewBtn.disabled = false;
      }

      reviewPanel.classList.add("is-active");
      if (Number.isFinite(reviewPanelActiveId)) {
        reviewPanel.dataset.reelId = String(reviewPanelActiveId);
      } else {
        reviewPanel.dataset.reelId = "";
      }
      const summaryReel = targetSummary && targetSummary.reel ? targetSummary.reel : null;
      const displayCode =
        (summaryReel && summaryReel.reel_code) || reviewPanel.dataset.reelCode || candidateCode || "";
      reviewPanel.dataset.reelCode = displayCode;

      const reviewData = targetSummary && targetSummary.review ? targetSummary.review : null;
      const hasDecision = Boolean(reviewData && reviewData.decision);
      reviewPanel.classList.toggle("review-pass", hasDecision && String(reviewData.decision).toLowerCase() === "pass");
      reviewPanel.classList.toggle("review-fail", hasDecision && String(reviewData.decision).toLowerCase() === "fail");

      if (reviewPanelStatusEl) {
        if (hasDecision) {
          const label = String(reviewData.decision).toLowerCase() === "fail" ? "Review status: Failed" : "Review status: Passed";
          reviewPanelStatusEl.textContent = label;
        } else {
          const label = displayCode || (Number.isFinite(reviewPanelActiveId) ? `Reel ${reviewPanelActiveId}` : "Selected reel");
          const jobLabel = summaryReel && summaryReel.job_name ? ` - ${summaryReel.job_name}` : "";
          const suffix = targetSummary ? jobLabel : jobLabel || " (loading details…)";
          reviewPanelStatusEl.textContent = `Reviewing ${label}${suffix}`;
        }
      }

      if (reviewPanelMetaEl) {
        if (hasDecision) {
          const reviewer = reviewData.reviewer_name || reviewData.reviewer_id || "";
          const timestamp = reviewData.created_at ? formatTime(reviewData.created_at) : "";
          const bits = [];
          if (reviewer) bits.push(`By ${reviewer}`);
          if (timestamp) bits.push(timestamp);
          reviewPanelMetaEl.textContent = bits.join(" • ");
        } else {
          reviewPanelMetaEl.textContent = "";
        }
      }

      if (hasDecision) {
        setReviewButtonsDisabled(true);
        toggleReviewControlsVisible(false);
        if (reviewPanelNewBtn) {
          reviewPanelNewBtn.disabled = false;
        }
        syncReviewButtonState(reviewData);
        closeReviewForm();
        return;
      }

      toggleReviewControlsVisible(true);
      setReviewButtonsDisabled(false);
      if (reviewPanelNewBtn) {
        reviewPanelNewBtn.disabled = false;
      }
      syncReviewButtonState(targetSummary);
      if (!targetSummary && Number.isFinite(reviewPanelActiveId)) {
        ensureReviewSummary(reviewPanelActiveId);
      }
    }

    async function ensureReviewSummary(reelId) {
      if (!Number.isFinite(reelId)) return;
      if (summaryCache.has(reelId)) return;
      const key = String(reelId);
      if (reviewSummaryFetches.has(key)) return;
      reviewSummaryFetches.set(key, true);
      try {
        const summary = await Api.get(`reel/${reelId}/summary`);
        if (summary) {
          summaryCache.set(reelId, summary);
          updateReviewPanel(summary);
        }
      } catch (err) {
        console.error(`Failed to load review summary for reel ${reelId}`, err);
      } finally {
        reviewSummaryFetches.delete(key);
      }
    }

    function updateStatusFilterUI() {
      statusUpdating = true;
      const active = state.reviewStatus;
      if (statusCheckboxes.all) {
        statusCheckboxes.all.checked = !active;
      }
      REVIEW_STATUS_VALUES.forEach((value) => {
        const input = statusCheckboxes[value];
        if (!input) return;
        input.checked = active === value;
      });
      statusUpdating = false;
    }

    function applySort(items) {
      const sorted = [...items];
      switch (state.sort) {
        case "ref_changes":
          sorted.sort((a, b) => (b.ref_change_count || 0) - (a.ref_change_count || 0));
          break;
        case "masks":
          sorted.sort((a, b) => (b.mask_count || 0) - (a.mask_count || 0));
          break;
        case "defects":
          sorted.sort((a, b) => (b.defect_count || 0) - (a.defect_count || 0));
          break;
        case "defects_least":
          sorted.sort((a, b) => (a.defect_count || 0) - (b.defect_count || 0));
          break;
        case "rlm_points_desc":
          sorted.sort((a, b) => (b.rlm_monitor_count || 0) - (a.rlm_monitor_count || 0));
          break;
        case "rlm_points_asc":
          sorted.sort((a, b) => (a.rlm_monitor_count || 0) - (b.rlm_monitor_count || 0));
          break;
        case "active_pct_desc":
          sorted.sort((a, b) => (b.active_inspection_pct || 0) - (a.active_inspection_pct || 0));
          break;
        case "active_pct_asc":
          sorted.sort((a, b) => (a.active_inspection_pct || 0) - (b.active_inspection_pct || 0));
          break;
        default:
          sorted.sort((a, b) => {
            const at = new Date(a.time_start || 0).getTime();
            const bt = new Date(b.time_start || 0).getTime();
            return bt - at;
          });
      }
      return sorted;
    }

    function registerReelMetadataFromItems(items = []) {
      if (!Filters || typeof Filters.registerReelMetadata !== "function") return;
      items.forEach((item) => {
        if (!item) return;
        const meta = buildReelMetadata(item);
        Filters.registerReelMetadata({
          reel_id: item.reel_id,
          reel_code: item.reel_code,
          code: meta.code || item.reel_code || "",
          label: meta.label,
          order_number: meta.order,
          time: meta.time,
        });
      });
    }

    function renderList() {
      if (!listEl) return;
      listEl.innerHTML = "";
      const selectedIds = Filters.getReelIds().map((id) => `${id}`);
      const selectedCodes = Filters.getReelCodes();
      const selectionOrder = selectedIds.map((id, index) => ({
        id,
        code: selectedCodes[index] || "",
        index,
      }));
      const idOrderMap = new Map(selectionOrder.map((entry) => [entry.id, entry.index]));
      const codeOrderMap = new Map(selectionOrder.filter((entry) => entry.code).map((entry) => [entry.code, entry.index]));
      const selectedIdSet = new Set(selectedIds);
      const selectedCodeSet = new Set(selectedCodes);
      const pinned = [];
      const others = [];
      state.cachedItems.forEach((item) => {
        const itemId = item.reel_id !== undefined && item.reel_id !== null ? String(item.reel_id) : "";
        const itemCode = item.reel_code || "";
        const isSelected =
          (itemId && selectedIdSet.has(itemId)) || (!itemId && itemCode && selectedCodeSet.has(itemCode));
        if (isSelected) {
          pinned.push(item);
        } else {
          others.push(item);
        }
      });
      pinned.sort((a, b) => {
        const aId = a.reel_id !== undefined && a.reel_id !== null ? String(a.reel_id) : "";
        const bId = b.reel_id !== undefined && b.reel_id !== null ? String(b.reel_id) : "";
        const aIndex = aId && idOrderMap.has(aId) ? idOrderMap.get(aId) : codeOrderMap.get(a.reel_code) ?? Number.MAX_SAFE_INTEGER;
        const bIndex = bId && idOrderMap.has(bId) ? idOrderMap.get(bId) : codeOrderMap.get(b.reel_code) ?? Number.MAX_SAFE_INTEGER;
        return (aIndex ?? 0) - (bIndex ?? 0);
      });
      const items = pinned.concat(others);

      if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "placeholder";
        empty.textContent = "No reels found for this window.";
        listEl.appendChild(empty);
        if (detailEl) {
          detailEl.innerHTML = '<div class="placeholder">Select a reel to view details.</div>';
        }
        return;
      }

      items.forEach((item) => {
        const card = document.createElement("div");
        card.className = "reel-card";
        card.dataset.reelId = item.reel_id || "";
        if (state.selectedReelId === item.reel_id) {
          card.classList.add("active");
        }
        const isReviewSelected =
          (item.reel_id !== undefined && item.reel_id !== null && selectedIdSet.has(String(item.reel_id))) ||
          (!item.reel_id && item.reel_code && selectedCodeSet.has(item.reel_code));
        if (isReviewSelected) {
          card.classList.add("reviewed");
        }
        const reviewDecision =
          item.review && item.review.decision
            ? String(item.review.decision).toLowerCase()
            : "";
        if (reviewDecision === "pass") {
          card.classList.add("pass");
        } else if (reviewDecision === "fail") {
          card.classList.add("alert");
        }
        const reviewBadge = renderReviewBadge(item.review);

        card.innerHTML = `
          <div class="reel-header">
            <div class="reel-meta">
              <strong>${item.reel_code || "—"}</strong>
              <span>${item.job_name || "No Job"} · ${item.order_number || "No Order"}</span>
              <span>${formatRange(item.time_start, item.time_end)}</span>
            </div>
            <span class="badge-pill">${Utils.formatMeters(item.meters || 0)}</span>
          </div>
          <div class="thumb-strip">
            ${renderThumbs(item.ref_images || [])}
          </div>
          <div class="metrics-row">
            <span class="badge">Defects: ${item.defect_count || 0}</span>
            <span class="badge">Masks: ${item.mask_count || 0}</span>
            <span class="badge${(item.ref_change_count || 0) > 1 ? " danger" : ""}">Ref changes: ${item.ref_change_count || 0}</span>
            <span class="badge">RLM pts: ${item.rlm_monitor_count || 0}</span>
          </div>
          <div class="metrics-row">
            ${renderPhaseChips(item.phase_mix_pct || {})}
            ${item.sens_standard_changed ? '<span class="badge warn">Sensitivity drift</span>' : ""}
            ${item.rlm_enabled ? '<span class="badge success">RLM enabled</span>' : '<span class="badge danger">RLM disabled</span>'}
            ${isReviewSelected ? '<span class="badge review">In review</span>' : ""}
            ${reviewBadge}
          </div>
        `;

        card.addEventListener("click", () => selectReel(item));
        listEl.appendChild(card);
      });

      if (state.selectedReelId) {
        const current = items.find((item) => item.reel_id === state.selectedReelId);
        if (current) {
          renderDetail(state.selectedReelId, true);
        }
      }
    }

    function setupCoverageMinLengthControls() {
      const input = document.getElementById("coverageMinReelLengthInput");
      const applyBtn = document.getElementById("coverageMinReelLengthApply");
      const clearBtn = document.getElementById("coverageMinLengthClear");
      if (input) {
        const feetValue = coverageMinLengthFilter ? coverageMinLengthFilter * METERS_TO_FEET : 0;
        input.value = feetValue ? Math.round(feetValue) : "";
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            applyCoverageMinLength(input.value);
          }
        });
      }
      if (applyBtn) {
        applyBtn.addEventListener("click", () => applyCoverageMinLength(input ? input.value : ""));
      }
      if (clearBtn) {
        clearBtn.addEventListener("click", () => applyCoverageMinLength(""));
      }
      updateCoverageMinChip();
    }

    function applyCoverageMinLength(rawValue) {
      const parsed = Number(rawValue);
      const nextValue = Number.isFinite(parsed) && parsed > 0 ? parsed * FEET_TO_METERS : 0;
      if (nextValue === coverageMinLengthFilter) {
        updateCoverageMinChip();
        return;
      }
      coverageMinLengthFilter = nextValue;
      persistCoverageMinLength(coverageMinLengthFilter);
      const input = document.getElementById("coverageMinReelLengthInput");
      if (input) {
        const feetValue = coverageMinLengthFilter ? coverageMinLengthFilter * METERS_TO_FEET : 0;
        input.value = feetValue ? Math.round(feetValue) : "";
      }
      updateCoverageMinChip();
      state.page = 1;
      load.flush();
    }

    function updateCoverageMinChip() {
      const chip = document.getElementById("coverageMinLengthChip");
      const text = chip ? chip.querySelector("span") : null;
      if (!chip) return;
      if (coverageMinLengthFilter > 0) {
        chip.classList.remove("hidden");
        if (text) {
          text.textContent = `Min reel length ≥ ${Utils.formatMeters(coverageMinLengthFilter)}`;
        }
      } else {
        chip.classList.add("hidden");
        if (text) {
          text.textContent = "";
        }
      }
    }

    function loadCoverageMinLength() {
      const defaultMeters = COVERAGE_DEFAULT_MIN_FEET * FEET_TO_METERS;
      if (typeof sessionStorage === "undefined") return defaultMeters;
      try {
        const raw = sessionStorage.getItem(COVERAGE_MIN_STORAGE_KEY);
        if (raw === null || raw === undefined) {
          return defaultMeters;
        }
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) {
          return defaultMeters;
        }
        if (parsed <= 0) {
          return 0;
        }
        return parsed;
      } catch (err) {
        return defaultMeters;
      }
    }

    function persistCoverageMinLength(value) {
      if (typeof sessionStorage === "undefined") return;
      try {
        sessionStorage.setItem(COVERAGE_MIN_STORAGE_KEY, String(value || 0));
      } catch (err) {
        // ignore
      }
    }

    function renderJobInsights() {
      const insights = state.insights || {};
      const qualifyingCount = Number(insights.qualifying_reel_count) || 0;
      const totalNode = document.querySelector("[data-insights-total]");
      if (totalNode) {
        totalNode.textContent = Utils.formatNumber(qualifyingCount, 0);
      }
      renderCoverageInsightCard("jobBstCoverageCard", insights.bst_coverage || {}, "BST fully active");
      renderCoverageInsightCard("jobRlmCoverageCard", insights.rlm_coverage || {}, "RLM active");
      renderReferenceSummaryCard("jobReferenceSummaryCard", insights.reference_summary || {});
      renderSensitivitySummaryCard("jobSensitivitySummaryCard", insights.sensitivity_summary || {});
    }

    function renderCoverageInsightCard(cardId, payload = {}, label) {
      const card = document.getElementById(cardId);
      if (!card) return;
      const body = card.querySelector(".job-insight-card__body");
      if (!body) return;
      const activeCount = Number(payload.active_count) || 0;
      const inactiveCount = Number(payload.inactive_count) || 0;
      const activePct = Number(payload.active_pct) || 0;
      body.innerHTML = `
        <div class="job-insight-kpi">
          <strong>${Utils.formatNumber(activePct, 1)}%</strong>
          <span>${Utils.escapeHtml(label || "Active")}</span>
        </div>
        <div class="job-insight-breakdown">
          <div>
            <strong>${Utils.formatNumber(activeCount, 0)}</strong>
            <span>Active reels</span>
          </div>
          <div>
            <strong>${Utils.formatNumber(inactiveCount, 0)}</strong>
            <span>Needs attention</span>
          </div>
        </div>
      `;
    }

    function renderReferenceSummaryCard(cardId, payload = {}) {
      const card = document.getElementById(cardId);
      if (!card) return;
      const body = card.querySelector(".job-insight-card__body");
      if (!body) return;
      const withChanges = Number(payload.reels_with_reference_changes) || 0;
      const withoutChanges = Number(payload.reels_without_reference_changes) || 0;
      const pctWithChanges = Number(payload.pct_with_changes) || 0;
      body.innerHTML = `
        <div class="job-insight-kpi">
          <strong>${Utils.formatNumber(pctWithChanges, 1)}%</strong>
          <span>With reference changes</span>
        </div>
        <div class="job-insight-breakdown">
          <div>
            <strong>${Utils.formatNumber(withChanges, 0)}</strong>
            <span>With changes</span>
          </div>
          <div>
            <strong>${Utils.formatNumber(withoutChanges, 0)}</strong>
            <span>Without changes</span>
          </div>
        </div>
      `;
    }

    function renderSensitivitySummaryCard(cardId, payload = {}) {
      const card = document.getElementById(cardId);
      if (!card) return;
      const body = card.querySelector(".job-insight-card__body");
      if (!body) return;
      const withChanges = Number(payload.reels_with_sensitivity_changes) || 0;
      const withoutChanges = Number(payload.reels_with_same_sensitivity) || 0;
      const pctChanged = Number(payload.pct_changed) || 0;
      body.innerHTML = `
        <div class="job-insight-kpi">
          <strong>${Utils.formatNumber(pctChanged, 1)}%</strong>
          <span>With sensitivity drift</span>
        </div>
        <div class="job-insight-breakdown">
          <div>
            <strong>${Utils.formatNumber(withChanges, 0)}</strong>
            <span>Changed reels</span>
          </div>
          <div>
            <strong>${Utils.formatNumber(withoutChanges, 0)}</strong>
            <span>Same sensitivity</span>
          </div>
        </div>
      `;
    }

    function renderPhaseChips(mix) {
      return Object.entries(mix)
        .map(
          ([phase, pct]) =>
            `<span class="phase-chip ${phase}">${phase}: ${Utils.formatNumber(pct || 0, 1)}%</span>`
        )
        .join("");
    }

    function renderReviewBadge(review) {
      if (!review || !review.decision) return "";
      const decision = String(review.decision).toLowerCase();
      const isPass = decision === "pass";
      const label = isPass ? "Passed" : "Failed";
      const badgeClass = isPass ? "success" : "danger";
      const details = [];
      const reviewerLabel = review.reviewer_name || review.reviewer_id;
      if (reviewerLabel) {
        details.push(`Reviewer: ${reviewerLabel}`);
      }
      if (review.created_at) {
        details.push(`At: ${formatTime(review.created_at)}`);
      }
      const title = details.length ? ` title="${Utils.escapeHtml(details.join(" | "))}"` : "";
      return `<span class="badge ${badgeClass} review-pill"${title}>${label}</span>`;
    }

    function renderThumbs(images) {
      if (!images.length) return '<div class="badge">No reference images</div>';
      return images
        .slice(0, 5)
        .map(
          (img) =>
            `<img src="${urlForStatic(img.image_src)}" alt="${img.filename || ""}" loading="lazy" decoding="async" onclick="showImageModal('${urlForStatic(
              img.image_src
            )}')">`
        )
        .join("");
    }

    function renderPagination() {
      if (!paginationEl) return;
      Utils.renderPagination(paginationEl, state.pageInfo, (page) => {
        state.page = page;
        load.flush();
      });
    }

    function ensureSelection() {
      if (!state.cachedItems.length) {
        state.selectedReelId = null;
        return;
      }
      if (state.selectedReelId) {
        const existing = state.cachedItems.find((item) => item.reel_id === state.selectedReelId);
        if (existing) {
          return;
        }
      }
      const selectedIds = Filters.getReelIds();
      if (selectedIds.length) {
        const match = state.cachedItems.find((item) => item.reel_id && selectedIds.includes(String(item.reel_id)));
        if (match) {
          selectReel(match, { updateFilter: false, immediate: true });
          return;
        }
      }
      const selectedCodes = Filters.getReelCodes();
      if (selectedCodes.length) {
        const match = state.cachedItems.find((item) => item.reel_code && selectedCodes.includes(item.reel_code));
        if (match) {
          selectReel(match, { updateFilter: false, immediate: true });
          return;
        }
      }
      const initial = state.cachedItems[0];
      selectReel(initial, { updateFilter: false, immediate: true });
    }

    async function selectReel(item, { updateFilter = false, immediate = false } = {}) {
      state.selectedReelId = item.reel_id;
      if (updateFilter) {
        const meta = buildReelMetadata(item);
        Filters.addReel(item.reel_code || "", item.reel_id, {
          code: meta.code || item.reel_code || "",
          label: meta.label,
          order: meta.order,
          time: meta.time,
        });
      }
      renderList();
      await renderDetail(item.reel_id, immediate);
    }

    async function renderDetail(reelId, immediate) {
      if (!detailEl) return;
      const cached = summaryCache.get(reelId);
      if (cached) {
        registerSummaryReelMetadata(cached);
        ensureReferenceBackground(cached);
        detailEl.innerHTML = buildSummary(cached);
        attachGalleryListeners(detailEl);
        attachSummaryActions(detailEl, cached);
        JobHeatmap.attach(detailEl, cached);
        MaskHeatmap.attach(detailEl, cached);
        renderRlmTrend(detailEl, cached);
        if (immediate) {
          return;
        }
      } else {
        detailEl.innerHTML = "<div class=\"placeholder\">Loading reel summary…</div>";
      }

      LoadingOverlay.show();
      try {
        const summary = await Api.get(`reel/${reelId}/summary`);
        registerSummaryReelMetadata(summary);
        ensureReferenceBackground(summary);
        summaryCache.set(reelId, summary);
        if (state.selectedReelId !== reelId) return;
        detailEl.innerHTML = buildSummary(summary);
        attachGalleryListeners(detailEl);
        attachSummaryActions(detailEl, summary);
        JobHeatmap.attach(detailEl, summary);
        MaskHeatmap.attach(detailEl, summary);
        renderRlmTrend(detailEl, summary);
      } catch (err) {
        console.error("Failed to load reel summary", err);
        if (!cached) {
          detailEl.innerHTML = `<div class="placeholder">Failed to load reel summary: ${err.message}</div>`;
        }
      } finally {
        LoadingOverlay.hide();
      }
    }

    function registerSummaryReelMetadata(summary) {
      if (!summary || !summary.reel) return;
      if (Filters && typeof Filters.registerReelMetadata === "function") {
        const meta = buildReelMetadata(summary.reel);
        Filters.registerReelMetadata({
          ...summary.reel,
          code: meta.code || summary.reel.reel_code || "",
          label: meta.label,
          order_number: meta.order,
          time: meta.time,
        });
      }
    }

    function ensureReferenceBackground(summary) {
      if (!summary || summary.reference_background || summary.referenceBackground) return;
      const images = Array.isArray(summary.reference_images) ? summary.reference_images : [];
      const first = images.find((img) => img && img.image_src);
      if (!first) return;
      const url = urlForStatic(first.image_src);
      summary.reference_background = url;
      summary.referenceBackground = url;
    }

    function buildSummary(data) {
      const reel = data.reel || {};
      const refImages = data.reference_images || [];
      const sensitivities = data.sensitivities || [];
      const masks = data.masks || [];
      const phases = data.inspection_phases || [];
      const rlm = data.rlm || {};
      const defects = data.defects || [];
      const defectsWithCoords = defects.filter((defect) => Array.isArray(defect.coords) && defect.coords.length);
      const defectsSummary = data.defects_summary || { total: 0, types: 0 };
      const review = data.review || null;
      const classificationValue = normalizeClassification(reel.classification);
      const reelMeters =
        typeof reel.reel_start === "number" && typeof reel.reel_end === "number"
          ? reel.reel_end - reel.reel_start
          : null;
      const inReview = Filters.hasReelSelection(reel.reel_id, reel.reel_code);
      const hasReviewed = Boolean(review && review.decision);
      const addButton =
        reel.reel_code && !hasReviewed
          ? `<button class="add-reel-button" data-add-reel="${reel.reel_code}" data-add-reel-id="${reel.reel_id ?? ""}" ${inReview ? "disabled" : ""}>${
              inReview ? "In review" : "Review"
            }</button>`
          : "";
      const reviewBadge = renderReviewBadge(review);
      const reviewSummaryBlock = (() => {
        if (!review) {
          return "<span class='badge'>No review decision recorded.</span>";
        }
        const decision = String(review.decision).toLowerCase();
        const decisionLabel = decision === "pass" ? "Passed" : "Failed";
        const metaPieces = [];
        const reviewerLabel = review.reviewer_name || review.reviewer_id;
        if (reviewerLabel) {
          metaPieces.push(`by ${Utils.escapeHtml(reviewerLabel)}`);
        }
        if (review.created_at) {
          metaPieces.push(`on ${Utils.escapeHtml(formatTime(review.created_at))}`);
        }
        const metaHtml = metaPieces.length ? `<span class="review-summary-meta">${metaPieces.join(" &middot; ")}</span>` : "";
        const commentsHtml = review.comments
          ? `<div class="review-summary-comments">"${Utils.escapeHtml(review.comments)}"</div>`
          : "";
        const lineClass = decision === "pass" ? "review-summary-line pass" : "review-summary-line fail";
        return `
          <div class="review-summary">
            <div class="${lineClass}">
              <span class="review-summary-decision">${decisionLabel}</span>
              ${metaHtml}
            </div>
            ${commentsHtml}
          </div>
        `;
      })();

      const phaseTimeline = renderTimeline(phases, "Inspection timeline");
      const rlmPhaseTimeline =
        rlm.phases && rlm.phases.length
          ? renderTimeline(rlm.phases, "RLM timeline")
          : "<span class='badge'>No RLM phases</span>";

      const rlmPoints = rlm.points || [];
      const rlmTrendId = `rlm-trend-${reel.reel_id || reel.reel_code || "reel"}`;
      const rlmPointsTable = rlmPoints.length
        ? `<div class="data-table-scroll rlm-table-scroll">
             <table class="data-table">
               <thead>
                 <tr>
                   <th>ID</th>
                   <th>Timestamp</th>
                   <th>Format</th>
                   <th>Web Speed</th>
                   <th>Cur Length</th>
                 </tr>
               </thead>
               <tbody>
                 ${rlmPoints
                   .map((point) =>
                     `<tr>
                        <td>${point.id || "—"}</td>
                        <td>${formatTime(point.timestamp)}</td>
                        <td>${formatMetricCell(point.format)}</td>
                        <td>${formatMetricCell(point.webspeed)}</td>
                        <td>${formatMetricCell(Utils.toInches(point.curlength))} in (${formatMetricCell(point.curlength)} mm)</td>
                      </tr>`
                   )
                   .join("")}
                 </tbody>
               </table>
           </div>`
        : "<span class='badge'>No RLM monitoring points</span>";

      const sensitivityTable = sensitivities.length
        ? `<table class="data-table">
             <thead><tr><th>Class</th><th>Threshold</th><th>Warn</th></tr></thead>
             <tbody>
               ${sensitivities
                 .map(
                   (row) =>
                     `<tr><td>${row.defect_class || ""}</td><td>${Utils.formatNumber(
                       row.threshold_value,
                       3
                     )}</td><td>${Utils.formatNumber(row.warn_threshold, 3)}</td></tr>`
                 )
                 .join("")}
             </tbody>
           </table>`
        : "<span class='badge'>No standard sensitivities</span>";

      const masksTable = masks.length
        ? `<table class="data-table">
             <thead><tr><th>Timestamp</th><th>XML ID</th><th>Sensitivity</th><th>Coords</th><th>Format</th></tr></thead>
             <tbody>
               ${masks
                 .map(
                   (mask) =>
                     `<tr>
                        <td>${formatTime(mask.timestamp)}</td>
                        <td>${mask.xml_id || ""}</td>
                        <td>${mask.sensitivitysetid || ""}</td>
                        <td>${truncateCoords(mask.coords)}</td>
                        <td>${Utils.formatNumber(mask.format_value, 2)}</td>
                      </tr>`
                 )
                 .join("")}
             </tbody>
           </table>`
        : "<span class='badge'>No masks</span>";

      const formatWidth = Number(reel.format_width);
      const formatLength = Number(reel.format_length);
      const heatmapId = JobHeatmap.domId(reel);
      const hasDimensions =
        Number.isFinite(formatWidth) && Number.isFinite(formatLength) && formatWidth > 0 && formatLength > 0;
      const canRenderHeatmap = hasDimensions && defectsWithCoords.length > 0;
      const wrapperHtml = canRenderHeatmap
        ? `<div class="heatmap-wrapper" id="${heatmapId}"></div>`
        : `<div class="heatmap-wrapper heatmap-empty" id="${heatmapId}">
             <span class='badge'>${hasDimensions ? "No defect coordinates" : "Format dimensions unavailable"}</span>
           </div>`;
      const heatmapSection = `
        <div class="summary-section">
          <h4>Defect Heatmap</h4>
          ${wrapperHtml}
          <div class="heatmap-legend heatmap-legend-job" id="${heatmapId}-legend"></div>
        </div>
      `;
      const maskHeatmapId = MaskHeatmap.domId(reel);
      const maskPlaceholder = hasDimensions ? "Loading mask footprints…" : "Format dimensions unavailable";
      const maskSection = `
        <div class="summary-section">
          <h4>Mask Footprints</h4>
          <div class="heatmap-wrapper heatmap-empty" id="${maskHeatmapId}">
            <span class='badge'>${maskPlaceholder}</span>
          </div>
        </div>
      `;

      const classCards = Array.isArray(defectsSummary.by_class)
        ? defectsSummary.by_class
            .map((entry) => {
              const label = entry && entry.class ? entry.class : "Unknown";
              const count = entry && Number.isFinite(entry.count) ? entry.count : 0;
              return `
                <div class="defect-class-card">
                  <span class="defect-class-name">${label}</span>
                  <span class="defect-class-count">${Utils.formatNumber(count, 0)}</span>
                </div>
              `;
            })
            .join("")
        : "";
      const classificationRadios = CLASSIFICATION_OPTIONS.map(
        (opt) =>
          `<label class="inline-radio">
            <input type="radio" name="reel-classification-${reel.reel_id || reel.reel_code || "reel"}" value="${opt.value}" data-classification-radio ${classificationValue === opt.value ? "checked" : ""}>
            <span>${opt.label}</span>
          </label>`
      ).join("");
      const classificationSection = `
        <div class="summary-section summary-section--classification">
          <h4>Reel Classification</h4>
          <div class="classification-controls" data-classification-group>
            ${classificationRadios}
            <span class="classification-status" data-classification-status></span>
          </div>
        </div>
      `;

      return `
        <div class="summary-header">
          <div>
            <div class="summary-title-row">
              <div class="summary-title">
                ${reel.reel_code || "Reel"}
                ${reviewBadge || ""}
              </div>
            </div>
            <div class="summary-metadata">
              <span>${reel.job_name || "No Job"}</span>
              <span>${reel.order_number || "No Order"}</span>
              <span>${formatRange(reel.time_start, reel.time_end)}</span>
            </div>
          </div>
          <div class="summary-metadata">
            <span>Machine: ${reel.machine || "N/A"}</span>
            <span>Length: ${Utils.formatMeters(reelMeters)}</span>
            <span>Format: ${Utils.formatNumber(reel.format_length, 2)} × ${Utils.formatNumber(reel.format_width, 2)}</span>
            <span data-classification-label>Classification: ${classificationLabel(classificationValue)}</span>
            ${addButton}
          </div>
        </div>
        ${classificationSection}
        <div class="summary-section summary-section--review">
          <h4>Review</h4>
          ${reviewSummaryBlock}
        </div>

        <div class="summary-section summary-section--defects">
          <h4>Defects Summary</h4>
          <div class="summary-metadata summary-stats">
            <div class="stat-pill">
              <span class="stat-label">Total defects</span>
              <span class="stat-value">${Utils.formatNumber(defectsSummary.total || 0, 0)}</span>
            </div>
            <div class="stat-pill">
              <span class="stat-label">Categories</span>
              <span class="stat-value">${Utils.formatNumber(defectsSummary.types || 0, 0)}</span>
            </div>
          </div>
          ${
            classCards
              ? `<div class="defect-class-grid">${classCards}</div>`
              : "<span class='badge'>No defect categories</span>"
          }
        </div>

        <div class="summary-section">
          <h4>Reference Images</h4>
          <div class="gallery">
            ${
              refImages.length
                ? refImages
                    .map(
                      (img) =>
                        `<img src="${urlForStatic(img.image_src)}" alt="${img.filename || ""}" data-img="${urlForStatic(
                          img.image_src
                        )}" loading="lazy" decoding="async">`
                    )
                    .join("")
                : "<span class='badge'>No reference images</span>"
            }
          </div>
        </div>

        <div class="summary-section">
          <h4>Inspection Phases</h4>
          ${phaseTimeline}
        </div>
        ${heatmapSection}

        <div class="summary-section">
          <h4>Sensitivity (Standard)</h4>
          ${sensitivityTable}
        </div>

        <div class="summary-section">
          <h4>Masks</h4>
          ${masksTable}
        </div>
        ${maskSection}

        <div class="summary-section">
          <h4>RLM</h4>
          <div class="summary-metadata">
            <span>Monitor points: ${rlm.monitor_count || 0}</span>
            <span>Config: ${rlm.config ? "Loaded" : "Not available"}</span>
          </div>
          ${rlmPointsTable}
          ${rlmPhaseTimeline}
          <div class="summary-section-chart" data-rlm-trend="${rlmTrendId}"></div>
          <div class="summary-rlm-legend" data-rlm-legend="${rlmTrendId}-legend"></div>
        </div>

      `;

      function truncateCoords(coords = "") {
        if (!coords) return "";
        return coords.length > 48 ? `${coords.slice(0, 48)}…` : coords;
      }

function extractRlmMetrics(config) {
        const groups = new Map();

        function recordMetric(path, key, rawValue) {
          if (rawValue === null || rawValue === undefined || rawValue === "") return;
          const groupKey = path || "Config";
          const row = groups.get(groupKey) || { label: prettifyLabel(groupKey) };
          const label = RLM_METRIC_LABELS[key];
          const numeric = Number(rawValue);
          row[label] = Number.isFinite(numeric) ? Number(numeric.toFixed(3)) : rawValue;
          groups.set(groupKey, row);
        }

        function walk(node, path = "") {
          if (!node || typeof node !== "object") return;
          if (Array.isArray(node)) {
            node.forEach((child, idx) => {
              const nextPath = path ? `${path}[${idx}]` : `[${idx}]`;
              walk(child, nextPath);
            });
            return;
          }

          Object.keys(RLM_METRIC_LABELS).forEach((key) => {
            const value = getMetricValue(node, key);
            if (value !== undefined) {
              recordMetric(path, key, value);
            }
          });

          Object.entries(node).forEach(([key, value]) => {
            if (key === "_attrs" || key === "_children") return;
            if (value && typeof value === "object") {
              const nextPath = path ? `${path}.${key}` : key;
              walk(value, nextPath);
            }
          });

          if (node._attrs && typeof node._attrs === "object") {
            walk(node._attrs, path ? `${path}._attrs` : "_attrs");
          }
          if (Array.isArray(node._children)) {
            node._children.forEach((child, idx) => {
              walk(child, path ? `${path}._children[${idx}]` : `_children[${idx}]`);
            });
          }
        }

        function getMetricValue(node, key) {
          if (Object.prototype.hasOwnProperty.call(node, key)) {
            return node[key];
          }
          if (node._attrs && Object.prototype.hasOwnProperty.call(node._attrs, key)) {
            return node._attrs[key];
          }
          return undefined;
        }

        function prettifyLabel(rawPath) {
          if (!rawPath) return "Config";
          return rawPath
            .replace(/_children\[\d+\]/g, "")
            .replace(/_attrs/g, "attrs")
            .replace(/^\./, "")
            .replace(/\.+/g, ".")
            || "Config";
        }

        walk(config);

        const columns = Array.from(new Set(Object.values(RLM_METRIC_LABELS)));
        return Array.from(groups.values()).map((row) => {
          columns.forEach((col) => {
            if (!Object.prototype.hasOwnProperty.call(row, col)) {
              row[col] = null;
            }
          });
          return row;
        });
      }

      function findMetricValue(node, target) {
        if (node === null || node === undefined) return null;
        if (typeof node !== "object") return null;
        if (Object.prototype.hasOwnProperty.call(node, target)) {
          return node[target];
        }
        if (node._attrs && Object.prototype.hasOwnProperty.call(node._attrs, target)) {
          return node._attrs[target];
        }
        if (Array.isArray(node)) {
          for (const child of node) {
            const result = findMetricValue(child, target);
            if (result !== null && result !== undefined && result !== "") return result;
          }
          return null;
        }
        if (node._children && Array.isArray(node._children)) {
          const result = findMetricValue(node._children, target);
          if (result !== null && result !== undefined && result !== "") return result;
        }
        for (const value of Object.values(node)) {
          if (value && typeof value === "object") {
            const result = findMetricValue(value, target);
            if (result !== null && result !== undefined && result !== "") return result;
          }
        }
        return null;
      }
    }

    function formatMetricCell(value) {
      if (value === null || value === undefined || value === "") return "—";
      if (typeof value === "number") return Utils.formatNumber(value, 3);
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return Utils.formatNumber(numeric, 3);
      return value;
    }

    function renderTimeline(phases, ariaLabel) {
      if (!phases || !phases.length) return "<span class='badge'>No phase data</span>";
      const validPhases = phases
        .map((phase) => ({
          ...phase,
          start: phase.start_time ? new Date(phase.start_time).getTime() : null,
          end: phase.end_time ? new Date(phase.end_time).getTime() : null,
        }))
        .filter(
          (p) =>
            p.start !== null &&
            p.end !== null &&
            p.end > p.start &&
            (p.phase || "").toLowerCase() !== "inactive"
        );
      if (!validPhases.length) return "<span class='badge'>No phase data</span>";
      const minStart = Math.min(...validPhases.map((p) => p.start));
      const maxEnd = Math.max(...validPhases.map((p) => p.end));
      const total = maxEnd - minStart || 1;

      const bands = validPhases
        .map((phase) => {
          const width = ((phase.end - phase.start) / total) * 100;
          const left = ((phase.start - minStart) / total) * 100;
          const cls = `timeline-band ${phase.phase || "unknown"}`;
          return `<div class="${cls}" style="left:${left}%;width:${width}%" title="${phase.phase || ""}"></div>`;
        })
        .join("");

      return `<div class="timeline" ${ariaLabel ? `aria-label="${ariaLabel}"` : ""}>${bands}</div>`;
    }

    function attachGalleryListeners(scope) {
      if (!scope) return;
      scope.querySelectorAll(".gallery img").forEach((img) => {
        const src = img.dataset.img || img.src;
        img.addEventListener("click", () => showImageModal(src));
      });
    }

    function attachSummaryActions(scope, summaryData) {
      if (!scope) return;
      const summary = summaryData || summaryCache.get(state.selectedReelId) || null;
      const addButton = scope.querySelector("[data-add-reel]");
      if (addButton) {
        const reelCode = addButton.dataset.addReel || "";
        const reelIdAttr = addButton.dataset.addReelId || "";
        const isAlreadySelected = Filters.hasReelSelection(reelIdAttr, reelCode);
        if (isAlreadySelected) {
          addButton.disabled = true;
          addButton.textContent = "In review";
        }
        addButton.addEventListener("click", () => {
          if (!reelCode) return;
          const currentSummary = summaryCache.get(state.selectedReelId) || summary;
          if (currentSummary && currentSummary.reel) {
            const { job_name: jobName, order_number: orderNumber } = currentSummary.reel;
            const { job: currentJob, order: currentOrder } = Filters.getState();
            const updates = {};
            if (!currentOrder || currentOrder === ORDER_NONE) {
              if (orderNumber) {
                updates.order = orderNumber;
              } else if (!currentOrder) {
                updates.order = ORDER_NONE;
              }
              if (!currentJob && jobName) {
                updates.job = jobName;
              }
            } else if (!currentJob && jobName && orderNumber) {
              updates.job = jobName;
            }
            if (Object.keys(updates).length) {
              Filters.setMany(updates, { emit: true });
            }
          }
          const reelMeta = currentSummary && currentSummary.reel ? currentSummary.reel : null;
          const derivedMeta = reelMeta ? buildReelMetadata(reelMeta) : null;
          const targetMeta = derivedMeta
            ? {
                code: derivedMeta.code || reelCode,
                label: derivedMeta.label,
                order: derivedMeta.order,
                time: derivedMeta.time,
              }
            : {
                code: reelCode,
                label: formatReelLabel({ code: reelCode, order: "", time: "" }),
                order: "",
                time: "",
              };
          Filters.addReel(reelCode, reelIdAttr || (reelMeta ? reelMeta.reel_id : ""), targetMeta);
          addButton.disabled = true;
          addButton.textContent = "In review";
          updateReviewPanel(currentSummary);
          Router.setActive("defects");
        });
      }
      const classificationGroup = scope.querySelector("[data-classification-group]");
      if (classificationGroup && summary && summary.reel && summary.reel.reel_id) {
        const statusEl = classificationGroup.querySelector("[data-classification-status]");
        const radios = Array.from(classificationGroup.querySelectorAll("[data-classification-radio]"));
        const reelId = summary.reel.reel_id;
        const classificationLabelEl = scope.querySelector("[data-classification-label]");
        let saving = false;
        const setStatus = (text, isError = false) => {
          if (!statusEl) return;
          statusEl.textContent = text || "";
          statusEl.classList.toggle("error", Boolean(isError));
        };
        const setChecked = (value) => {
          radios.forEach((radio) => {
            radio.checked = radio.value === value;
          });
        };
        radios.forEach((radio) => {
          radio.addEventListener("change", async (event) => {
            if (saving) return;
            const nextValue = normalizeClassification(event.target.value, null);
            if (!nextValue) return;
            const currentValue = normalizeClassification(summary.reel.classification);
            if (nextValue === currentValue) return;
            saving = true;
            setStatus("Saving…");
            try {
              const result = await Api.post(`reel/${reelId}/classification`, { classification: nextValue });
              const savedValue = normalizeClassification(result && result.classification, nextValue);
              summary.reel.classification = savedValue;
              const cached = summaryCache.get(reelId);
              if (cached && cached.reel) {
                cached.reel.classification = savedValue;
              }
              const cachedItem = state.cachedItems.find((it) => it.reel_id === reelId);
              if (cachedItem) {
                cachedItem.classification = savedValue;
              }
              setChecked(savedValue);
              if (classificationLabelEl) {
                classificationLabelEl.textContent = `Classification: ${classificationLabel(savedValue)}`;
              }
              setStatus("Saved");
            } catch (err) {
              console.error("Failed to update reel classification", err);
              setChecked(currentValue);
              setStatus(err && err.message ? err.message : "Failed to save", true);
            } finally {
              saving = false;
            }
          });
        });
      }
      updateReviewPanel(summary);
    }

    function renderRlmTrend(scope, summary) {
      if (!scope || !summary) return;
      const host = scope.querySelector("[data-rlm-trend]");
      const legendTarget = (() => {
        if (!host) return null;
        const id = host.getAttribute("data-rlm-trend");
        if (!id) return null;
        return scope.querySelector(`[data-rlm-legend="${id}-legend"]`);
      })();
      if (!host) return;
      const points = Array.isArray(summary.rlm && summary.rlm.points) ? summary.rlm.points : [];
      const tolerances = summary.rlm && summary.rlm.tolerances ? summary.rlm.tolerances : null;
      if (!points.length) {
        host.innerHTML = "<span class='badge'>No monitoring trend data</span>";
        if (legendTarget) {
          legendTarget.innerHTML = "<span class='badge'>No monitoring trend data</span>";
        }
        return;
      }

      const times = [];
      const webspeeds = [];
      const repeatLengths = [];
      points.forEach((point) => {
        const ts = point && point.timestamp ? new Date(point.timestamp) : null;
        if (!(ts instanceof Date) || Number.isNaN(ts.getTime())) return;
        const repeatLength = Utils.toInches(point.curlength);
        const webspeed = Number(point.webspeed);
        if (!Number.isFinite(repeatLength) || !Number.isFinite(webspeed)) return;
        times.push(ts);
        webspeeds.push(webspeed);
        repeatLengths.push(repeatLength);
      });

      if (!times.length) {
        host.innerHTML = "<span class='badge'>No monitoring trend data</span>";
        return;
      }

      const traces = [
        {
          x: times,
          y: repeatLengths,
          mode: "lines+markers",
          name: "Repeat Length",
          line: { color: "#2563eb", shape: "linear" },
          marker: { size: 6, color: "#2563eb" },
        },
        {
          x: times,
          y: webspeeds,
          mode: "lines+markers",
          name: "Web Speed",
          line: { color: "#16a34a", shape: "linear" },
          marker: { size: 6 },
          visible: "legendonly",
          yaxis: "y2",
        },
      ];

      const repStats = (() => {
        const values = repeatLengths.filter((v) => Number.isFinite(v));
        if (!values.length) return null;
        const min = Math.min(...values);
        const max = Math.max(...values);
        const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
        return { min, max, avg };
      })();

      let repeatRanges = paddedRange(
        repeatLengths.filter((v) => Number.isFinite(v))
      );

      const shapes = [];
      if (tolerances && tolerances.nomlength !== undefined) {
        const start = times[0];
        const end = times[times.length - 1];
        const nom = Utils.toInches(tolerances.nomlength);
        const expand = Utils.toInches(tolerances.errexpand);
        const shrink = Utils.toInches(tolerances.errshrink);
        const upper = Number.isFinite(expand) && nom !== null ? nom + expand : null;
        const lower = Number.isFinite(shrink) && nom !== null ? nom - shrink : null;

        shapes.push({
          type: "line",
          xref: "x",
          yref: "y",
          x0: start,
          x1: end,
          y0: nom,
          y1: nom,
          line: { color: "#22c55e", width: 2 },
        });
        if (upper !== null) {
          shapes.push({
            type: "line",
            xref: "x",
            yref: "y",
            x0: start,
            x1: end,
            y0: upper,
            y1: upper,
            line: { color: "#ef4444", width: 2, dash: "dash" },
          });
          if (repeatRanges) {
            repeatRanges[1] = Math.max(repeatRanges[1], upper + 5);
          } else {
            repeatRanges = [upper - 5, upper + 5];
          }
        }
        if (lower !== null) {
          shapes.push({
            type: "line",
            xref: "x",
            yref: "y",
            x0: start,
            x1: end,
            y0: lower,
            y1: lower,
            line: { color: "#ef4444", width: 2, dash: "dash" },
          });
          if (repeatRanges) {
            repeatRanges[0] = Math.min(repeatRanges[0], lower - 5);
          } else {
            repeatRanges = [lower - 5, lower + 5];
          }
        }
      }

      const layout = {
        title: "RLM Monitoring Trend",
        margin: { t: 40, r: 60, l: 60, b: 40 },
        legend: { orientation: "h", x: 0, y: 1.2 },
        xaxis: { title: "Timestamp" },
        yaxis: { title: "Repeat Length (in)" },
        yaxis2: {
          title: "Web Speed",
          overlaying: "y",
          side: "right",
          showgrid: false,
        },
        shapes,
      };

      Plotly.react(host, traces, layout, plotlyConfig());

      if (legendTarget) {
        const nom = tolerances && tolerances.nomlength !== undefined ? Utils.toInches(tolerances.nomlength) : null;
        const expand = tolerances && tolerances.errexpand !== undefined ? Utils.toInches(tolerances.errexpand) : null;
        const shrink = tolerances && tolerances.errshrink !== undefined ? Utils.toInches(tolerances.errshrink) : null;
        const upper = nom !== null && expand !== null ? nom + expand : null;
        const lower = nom !== null && shrink !== null ? nom - shrink : null;
        const stats = repStats || { min: null, max: null, avg: null };

        const formatVal = (value, digits = 3) =>
          Number.isFinite(value) ? Utils.formatNumber(value, digits) : "—";
        const formatDual = (inVal) => {
          if (!Number.isFinite(inVal)) return "—";
          const mmVal = inVal * MM_TO_IN;
          return `${formatVal(inVal)} in (${formatVal(mmVal)} mm)`;
        };

        legendTarget.innerHTML = `
          <div class="rlm-legend-grid">
            <table class="rlm-legend-table">
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><span class="rlm-swatch rlm-swatch--nom"></span>Reference Length</td>
                  <td>${formatDual(nom)}</td>
                </tr>
                <tr>
                  <td><span class="rlm-swatch rlm-swatch--limit"></span>Shrink Tolerance</td>
                  <td>${formatDual(shrink)} ${lower !== null ? `(limit: ${formatDual(lower)})` : ""}</td>
                </tr>
                <tr>
                  <td><span class="rlm-swatch rlm-swatch--limit"></span>Expand Tolerance</td>
                  <td>${formatDual(expand)} ${upper !== null ? `(limit: ${formatDual(upper)})` : ""}</td>
                </tr>
              </tbody>
            </table>
            <table class="rlm-legend-table">
              <thead>
                <tr>
                  <th>Repeat Metric</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><span class="rlm-swatch rlm-swatch--repeat"></span>Repeat Length Min</td>
                  <td>${formatDual(stats.min)}</td>
                </tr>
                <tr>
                  <td><span class="rlm-swatch rlm-swatch--repeat"></span>Repeat Length Max</td>
                  <td>${formatDual(stats.max)}</td>
                </tr>
                <tr>
                  <td><span class="rlm-swatch rlm-swatch--repeat"></span>Repeat Length Avg</td>
                  <td>${formatDual(stats.avg)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        `;
      }
    }

    function openReviewForm(decision) {
      if (!reviewPanel || !reviewPanelHost) return;
      if (reviewPanelControls && reviewPanelControls.classList.contains("is-hidden")) {
        return;
      }
      const normalizedDecision = decision === "fail" ? "fail" : "pass";
      const decisionLabel = normalizedDecision === "pass" ? "Pass" : "Fail";
      let summary = summaryCache.get(state.selectedReelId) || null;
      if (!summary && reviewPanel && reviewPanel.dataset.reelId) {
        const fallbackId = Number(reviewPanel.dataset.reelId);
        if (Number.isFinite(fallbackId)) {
          summary = summaryCache.get(fallbackId) || null;
        }
      }
      let reel = summary && summary.reel ? summary.reel : null;
      if (!reel && reviewPanel) {
        const fallbackId = Number(reviewPanel.dataset.reelId);
        if (Number.isFinite(fallbackId)) {
          reel = {
            reel_id: fallbackId,
            reel_code: reviewPanel.dataset.reelCode || "",
          };
        }
      }
      if (!reel || !Filters.hasReelSelection(reel.reel_id, reel.reel_code || reviewPanel.dataset.reelCode || "")) {
        return;
      }
      const existingReview = summary && summary.review ? summary.review : null;
      const reviewerPrefill =
        existingReview && (existingReview.reviewer_name || existingReview.reviewer_id)
          ? Utils.escapeHtml(existingReview.reviewer_name || existingReview.reviewer_id)
          : "";
      const suffix = state.selectedReelId || "reel";
      reviewPanelHost.innerHTML = `
        <div class="review-form">
          <div class="review-form-header">
            <h5>${decisionLabel} Roll</h5>
            <button type="button" class="review-form-close" data-review-cancel aria-label="Close review form">&times;</button>
          </div>
          <form data-review-form>
            <div class="form-field">
              <label for="reviewer-${suffix}">Reviewer Name</label>
              <input type="text" id="reviewer-${suffix}" name="reviewer_name" value="${reviewerPrefill}" required>
            </div>
            <div class="form-field">
              <label for="comments-${suffix}">Comments</label>
              <textarea id="comments-${suffix}" name="comments" rows="3" placeholder="Optional"></textarea>
            </div>
            <div class="review-form-extra" data-review-extra></div>
            <div class="review-form-error" data-review-error></div>
            <div class="review-form-actions">
              <button type="button" class="review-form-secondary" data-review-cancel>Cancel</button>
              <button type="submit" class="review-form-primary">Submit ${decisionLabel}</button>
            </div>
          </form>
        </div>
      `;
      const form = reviewPanelHost.querySelector("[data-review-form]");
      if (!form) return;
      const cancelButtons = reviewPanelHost.querySelectorAll("[data-review-cancel]");
      cancelButtons.forEach((btn) =>
        btn.addEventListener("click", () => {
          closeReviewForm();
        })
      );
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        submitReviewDecision(normalizedDecision, form, reviewPanelHost);
      });
      const reviewerInput = form.querySelector("[name='reviewer_name']");
      if (reviewerInput) {
        try {
          reviewerInput.focus({ preventScroll: true });
        } catch (err) {
          reviewerInput.focus();
        }
        const len = reviewerInput.value.length;
        reviewerInput.setSelectionRange(len, len);
      }
      const container = reviewPanel;
      if (container) {
        container.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    }

    function closeReviewForm(host = reviewPanelHost) {
      if (!host) return;
      host.innerHTML = "";
    }

    function setReviewError(host = reviewPanelHost, message) {
      if (!host) return;
      const errorEl = host.querySelector("[data-review-error]");
      if (!errorEl) return;
      errorEl.textContent = message || "";
      errorEl.classList.toggle("visible", Boolean(message));
    }

    function setReviewFormLoading(form, isLoading) {
      if (!form) return;
      const wrapper = form.closest(".review-form");
      if (wrapper) {
        wrapper.classList.toggle("is-submitting", Boolean(isLoading));
      }
      const elements = form.querySelectorAll("input, textarea, button");
      elements.forEach((el) => {
        if (isLoading) {
          el.setAttribute("disabled", "disabled");
        } else {
          el.removeAttribute("disabled");
        }
      });
    }

    async function submitReviewDecision(decision, form, host = reviewPanelHost) {
      let targetId = state.selectedReelId;
      if (targetId === null || targetId === undefined) {
        const panelId =
          reviewPanel && reviewPanel.dataset.reelId
            ? Number(reviewPanel.dataset.reelId)
            : null;
        if (Number.isFinite(panelId)) {
          targetId = panelId;
          state.selectedReelId = panelId;
        }
      }
      if (targetId === null || targetId === undefined) {
        setReviewError(host, "No reel selected.");
        return;
      }
      const normalizedTargetId = Number(targetId);
      if (!Number.isFinite(normalizedTargetId)) {
        setReviewError(host, "Invalid reel selected.");
        return;
      }
      const normalizedDecision = decision === "fail" ? "fail" : decision === "pass" ? "pass" : "";
      if (!normalizedDecision) {
        setReviewError(host, "Unsupported decision.");
        return;
      }
      const reviewerField = form.querySelector("[name='reviewer_name']");
      const commentsField = form.querySelector("[name='comments']");
      const reviewer = reviewerField ? reviewerField.value.trim() : "";
      if (!reviewer) {
        setReviewError(host, "Reviewer name is required.");
        if (reviewerField) {
          reviewerField.focus();
        }
        return;
      }
      const comments = commentsField ? commentsField.value.trim() : "";
      setReviewError(host, "");
      setReviewFormLoading(form, true);
      let shouldClose = false;
      try {
        const payload = {
          decision: normalizedDecision,
          reviewer_name: reviewer,
          comments,
        };
        const response = await Api.post(`reel/${normalizedTargetId}/review`, payload);
        const latestReview = response && response.review ? response.review : null;
        if (latestReview) {
          const summary = summaryCache.get(normalizedTargetId);
          if (summary) {
            summary.review = latestReview;
            summaryCache.set(normalizedTargetId, summary);
          }
          const index = state.cachedItems.findIndex((item) => item.reel_id === normalizedTargetId);
          if (index !== -1) {
            const reviewStatusValue = latestReview && latestReview.decision
              ? (String(latestReview.decision).toLowerCase() === "pass" ? "pass" : "fail")
              : "uninspected";
            state.cachedItems[index] = {
              ...state.cachedItems[index],
              review: latestReview,
              review_status: reviewStatusValue,
            };
          }
        }
        shouldClose = true;
      } catch (err) {
        console.error("Failed to submit review decision", err);
        setReviewError(host, err && err.message ? err.message : "Failed to save review decision.");
      } finally {
        setReviewFormLoading(form, false);
        if (shouldClose) {
          closeReviewForm(host);
          updateReviewPanel(summaryCache.get(normalizedTargetId) || null);
          renderList();
          load.flush();
        }
      }
    }

    function formatRange(start, end) {
      if (!start && !end) return "N/A";
      const startStr = formatTime(start, "N/A");
      const endStr = formatTime(end, "N/A");
      return `${startStr} → ${endStr}`;
    }

    return { init, activate, onFiltersUpdated };
  })();
