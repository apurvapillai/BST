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
            <span class="badge-pill">${Utils.formatMeters(listReelMeters(item))}</span>
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
        input.value = coverageMinLengthFilter ? Math.round(coverageMinLengthFilter) : "";
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
      const nextValue = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
      if (nextValue === coverageMinLengthFilter) {
        updateCoverageMinChip();
        return;
      }
      coverageMinLengthFilter = nextValue;
      persistCoverageMinLength(coverageMinLengthFilter);
      const input = document.getElementById("coverageMinReelLengthInput");
      if (input) {
        input.value = coverageMinLengthFilter ? Math.round(coverageMinLengthFilter) : "";
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
          text.textContent = `Min reel feet ≥ ${Utils.formatNumber(coverageMinLengthFilter, 0)} ft`;
        }
      } else {
        chip.classList.add("hidden");
        if (text) {
          text.textContent = "";
        }
      }
    }

    function loadCoverageMinLength() {
      if (typeof sessionStorage === "undefined") return COVERAGE_DEFAULT_MIN_FEET;
      try {
        const raw = sessionStorage.getItem(COVERAGE_MIN_STORAGE_KEY);
        if (raw === null || raw === undefined) {
          return COVERAGE_DEFAULT_MIN_FEET;
        }
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) {
          return COVERAGE_DEFAULT_MIN_FEET;
        }
        if (parsed <= 0) {
          return 0;
        }
        return parsed;
      } catch (err) {
        return COVERAGE_DEFAULT_MIN_FEET;
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
      renderDefectSummaryCard("jobDefectSummaryCard", insights.defect_summary || {});
      renderCoverageInsightCard("jobBstCoverageCard", insights.bst_coverage || {}, "BST >1% active");
      renderCoverageInsightCard("jobRlmCoverageCard", insights.rlm_coverage || {}, "RLM active");
      renderReferenceSummaryCard("jobReferenceSummaryCard", insights.reference_summary || {});
      renderSensitivitySummaryCard("jobSensitivitySummaryCard", insights.sensitivity_summary || {});
    }

    function renderDefectSummaryCard(cardId, payload = {}) {
      const card = document.getElementById(cardId);
      if (!card) return;
      const body = card.querySelector(".job-insight-card__body");
      if (!body) return;
      const total = Number(payload.total_defects) || 0;
      const average = Number(payload.average_per_reel) || 0;
      const belowAverage = Number(payload.reels_below_average) || 0;
      const aboveAverage = Number(payload.reels_above_average) || 0;
      body.innerHTML = `
        <div class="job-insight-kpi">
          <strong>${Utils.formatNumber(average, 2)}</strong>
          <span>Average defects per reel</span>
        </div>
        <div class="job-insight-breakdown job-insight-breakdown--total">
          <div>
            <strong>${Utils.formatNumber(total, 0)}</strong>
            <span>Total defects</span>
          </div>
        </div>
        <div class="job-insight-breakdown">
          <div>
            <strong>${Utils.formatNumber(belowAverage, 0)}</strong>
            <span>Reels below average</span>
          </div>
          <div>
            <strong>${Utils.formatNumber(aboveAverage, 0)}</strong>
            <span>Reels above average</span>
          </div>
        </div>
        
      `;
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
      // Reference images arrive in capture order, so the last one is the latest in use.
      const usable = images.filter((img) => img && img.image_src);
      const latest = usable[usable.length - 1];
      if (!latest) return;
      const url = urlForStatic(latest.image_src);
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
      const reelFeetValue = reelLengthFeet(reel);
      const reelMeters =
        reelFeetValue !== null
          ? reelFeetValue / 3.28084
          : typeof reel.reel_start === "number" && typeof reel.reel_end === "number"
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

      const reelRange = { start: reel.time_start, end: reel.time_end };
      const reelListItem = state.cachedItems.find((item) => item.reel_id === reel.reel_id);
      const inactivePct = reelListItem?.phase_mix_pct?.inactive;
      const defectPositionBar = renderDefectPositionBar(reel, defects, phases, inactivePct);
      const rlmPhaseTimeline =
        rlm.phases && rlm.phases.length
          ? renderTimeline(rlm.phases, "RLM timeline", reelRange)
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

      const sortedMaskEvents = masks
        .map((mask, index) => ({ mask, index }))
        .sort((left, right) => {
          const leftTime = String(left.mask.timestamp || "");
          const rightTime = String(right.mask.timestamp || "");
          if (leftTime !== rightTime) return leftTime.localeCompare(rightTime);
          const leftFormat = Number(left.mask.format_value);
          const rightFormat = Number(right.mask.format_value);
          if (Number.isFinite(leftFormat) && Number.isFinite(rightFormat) && leftFormat !== rightFormat) {
            return leftFormat - rightFormat;
          }
          return left.index - right.index;
        });
      const pendingMaskApplications = new Map();
      const maskApplications = new Map();
      sortedMaskEvents.forEach(({ mask }) => {
        const signature = JSON.stringify([
          mask.xml_id || "",
          mask.sensitivitysetid || "",
          mask.coords || "",
        ]);
        const event = mask.event || (mask.noinspection === false ? "removed" : "applied");
        if (event === "applied") {
          pendingMaskApplications.set(signature, mask);
        } else {
          const application = pendingMaskApplications.get(signature);
          if (application) {
            maskApplications.set(mask, application);
            pendingMaskApplications.delete(signature);
          }
        }
      });
      pendingMaskApplications.forEach((application) => {
        maskApplications.set(application, application);
      });

      const masksTable = masks.length
        ? `<table class="data-table">
             <thead><tr><th>Event</th><th>Timestamp</th><th>XML ID</th><th>Sensitivity</th><th>Coords</th><th>Applied for</th><th>Format</th><th>Removed at</th></tr></thead>
             <tbody>
               ${masks
                 .map(
                   (mask) => {
                     const event = mask.event || (mask.noinspection === false ? "removed" : "applied");
                     const eventLabel = event === "removed" ? "Removed" : "Applied";
                     const sameMask = (candidate) =>
                       candidate.xml_id === mask.xml_id &&
                       candidate.sensitivitysetid === mask.sensitivitysetid &&
                       candidate.coords === mask.coords;
                     const application =
                       event === "applied" ? mask : maskApplications.get(mask);
                     const removal =
                       event === "removed"
                         ? mask
                         : sortedMaskEvents
                             .map(({ mask: candidate }) => candidate)
                             .find(
                               (candidate) =>
                                 candidate.event === "removed" &&
                                 sameMask(candidate) &&
                                 maskApplications.get(candidate) === mask
                             );
                     const appliedForFeet = application
                       ? maskFeetBetweenFormats(
                           reel,
                           application.format_value,
                           removal ? removal.format_value : reel.reel_end
                         )
                       : null;
                     const removedAtFeet = removal
                       ? maskFeetFromFormat(reel, removal.format_value)
                       : null;
                     return `
                       <tr>
                         <td>${eventLabel}</td>
                         <td>${formatTime(mask.timestamp)}</td>
                         <td>${mask.xml_id || ""}</td>
                         <td>${mask.sensitivitysetid || ""}</td>
                         <td>${truncateCoords(mask.coords)}</td>
                         <td>${appliedForFeet === null ? "—" : `${Utils.formatNumber(appliedForFeet, 1)} ft`}</td>
                         <td>${Utils.formatNumber(mask.format_value, 2)}</td>
                         <td>${removedAtFeet === null ? "—" : `${Utils.formatNumber(removedAtFeet, 1)} ft`}</td>
                       </tr>`;
                   }
                 )
                 .join("")}
             </tbody>
           </table>`
        : "<span class='badge'>No masks</span>";
      const hasRemovedMasks = masks.some(
        (mask) => mask.event === "removed" || mask.noinspection === false
      );
      const maskSnapshots = Array.isArray(data.mask_snapshots) ? data.mask_snapshots : [];
      const maskSnapshotCards = maskSnapshots.length
        ? [...maskSnapshots]
            .map((snapshot, index) => ({ snapshot, index }))
            .reverse()
            .map(({ snapshot, index }, reverseIndex) => {
              const heatmapIdForSnapshot = `${MaskHeatmap.domId(reel)}-${index}`;
              const marker = reverseIndex === 0 ? "Latest" : `State ${index + 1}`;
              const timeLabel = snapshot.timestamp ? formatTime(snapshot.timestamp) : "Time unavailable";
              const feet = snapshot.feet_from_reel_start;
              const positionLabel =
                feet === null || feet === undefined
                  ? ""
                  : ` · ${Utils.formatNumber(feet, 1)} ft`;
              const count = Number(snapshot.active_mask_count) || 0;
              const maskDetails = (snapshot.mask_history || snapshot.masks || [])
                .map((mask) => {
                  const label = Utils.escapeHtml(mask.xml_id || mask.sensitivitysetid || "Mask");
                  const coords = Utils.escapeHtml(truncateCoords(mask.coords));
                  const appliedFor =
                    mask.applied_for_feet === null || mask.applied_for_feet === undefined
                      ? "duration unavailable"
                      : `applied for ${Utils.formatNumber(mask.applied_for_feet, 1)} ft`;
                  const removedAt =
                    mask.removed_at_feet === null || mask.removed_at_feet === undefined
                      ? ""
                      : ` · removed at ${Utils.formatNumber(mask.removed_at_feet, 1)} ft`;
                  return `
                    <div class="mask-snapshot-card__mask">
                      <strong>${label}</strong>
                      <span>${coords} · ${appliedFor}${removedAt}</span>
                    </div>
                  `;
                })
                .join("");
              return `
                <article class="mask-snapshot-card">
                  <div class="mask-snapshot-card__header">
                    <strong>${marker}</strong>
                    <span>${count} active mask${count === 1 ? "" : "s"}</span>
                  </div>
                  <div class="summary-metadata">
                    <span>${timeLabel}${positionLabel}</span>
                  </div>
                  <div class="mask-snapshot-footprint heatmap-wrapper" id="${heatmapIdForSnapshot}" data-mask-snapshot-index="${index}"></div>
                  ${maskDetails ? `<div class="mask-snapshot-card__mask-list">${maskDetails}</div>` : ""}
                </article>
              `;
            })
            .join("")
        : "";
           const maskPlaceholder =
     Number(reel.format_width) > 0 && Number(reel.format_length) > 0
       ? "Loading mask footprints…"
       : "Format dimensions unavailable";
      const maskFootprintsMarkup = maskSnapshotCards
        ? `<div class="mask-snapshot-gallery">${maskSnapshotCards}</div>`
        : `<div class="mask-snapshot-footprint heatmap-wrapper heatmap-empty" id="${MaskHeatmap.domId(reel)}">
             <span class='badge'>${maskPlaceholder}</span>
           </div>`;

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
       const maskSection = `
        <div class="summary-section">
          <h4>Mask Footprints</h4>
          ${maskFootprintsMarkup}
          ${hasRemovedMasks ? "<div class='summary-metadata'><span>Red fill shows masks active in each snapshot; the details below include masks later removed.</span></div>" : ""}
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
            <span>Feet: ${Utils.formatMeters(reelMeters)}</span>
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
          <h4>Defect Positions</h4>
          ${defectPositionBar || "<span class='badge'>No position data</span>"}
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

    // <reel-overview>
    const MM_PER_FOOT = 304.8;
    const DEFECT_BAR_COLUMNS = 2000;

    function reelRepeatCount(reel) {
      const start = Number(reel && reel.reel_start);
      const end = Number(reel && reel.reel_end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
      return end - start;
    }

    // reel_start / reel_end are repeat (format) counts, so length = repeats x repeat length.
    function reelLengthFeet(reel) {
      const repeats = reelRepeatCount(reel);
      const formatLength = Number(reel && reel.format_length);
      if (repeats === null || !Number.isFinite(formatLength) || formatLength <= 0) return null;
      return (repeats * formatLength) / MM_PER_FOOT;
    }

    function listReelMeters(item) {
      const repeats = Number(item && item.meters) || 0;
      const formatLength = Number(item && item.format_length);
      if (Number.isFinite(formatLength) && formatLength > 0) {
        return (repeats * formatLength) / 1000;
      }
      return repeats;
    }

    function maskFeetFromFormat(reel, rawFormat) {
      const reelStart = Number(reel && reel.reel_start);
      const reelEnd = Number(reel && reel.reel_end);
      const formatLength = Number(reel && reel.format_length);
      const format = Number(rawFormat);
      if (
        !Number.isFinite(reelStart) ||
        !Number.isFinite(reelEnd) ||
        reelEnd <= reelStart ||
        !Number.isFinite(formatLength) ||
        formatLength <= 0 ||
        !Number.isFinite(format)
      ) {
        return null;
      }
      const feet = ((format - reelStart) * formatLength) / MM_PER_FOOT;
      const totalFeet = ((reelEnd - reelStart) * formatLength) / MM_PER_FOOT;
      return Math.min(Math.max(feet, 0), totalFeet);
    }

    function maskFeetBetweenFormats(reel, startFormat, endFormat) {
      const formatLength = Number(reel && reel.format_length);
      const start = Number(startFormat);
      const end = Number(endFormat);
      if (
        !Number.isFinite(formatLength) ||
        formatLength <= 0 ||
        !Number.isFinite(start) ||
        !Number.isFinite(end)
      ) {
        return null;
      }
      return Math.max(((end - start) * formatLength) / MM_PER_FOOT, 0);
    }

    function niceFeetStep(totalFeet) {
      const steps = [50, 100, 250, 500, 1000, 2000, 5000, 10000, 20000];
      return steps.find((step) => totalFeet / step <= 10) || 50000;
    }

    // One green bar for the whole reel with a black line at every detection in the XML.
    // Repeated detections sit next to each other and merge into a solid black block.
    function renderDefectPositionBar(reel, defects, phases, inactivePct) {
      const repeats = reelRepeatCount(reel);
      const totalFeet = reelLengthFeet(reel);
      if (repeats === null || totalFeet === null) return "";
      const reelStart = Number(reel.reel_start);
      const formatLength = Number(reel.format_length);

      const columns = new Map();
      let counted = 0;
      (defects || []).forEach((defect) => {
        const format = Number(defect.format_position);
        if (!Number.isFinite(format)) return;
        const fraction = Math.min(Math.max((format - reelStart) / repeats, 0), 1);
        const column = Math.min(Math.floor(fraction * DEFECT_BAR_COLUMNS), DEFECT_BAR_COLUMNS - 1);
        const entry = columns.get(column) || { count: 0, firstFormat: format };
        entry.count += 1;
        entry.firstFormat = Math.min(entry.firstFormat, format);
        columns.set(column, entry);
        counted += 1;
      });

      const feetAt = (format) => ((format - reelStart) * formatLength) / MM_PER_FOOT;
      const sortedColumns = Array.from(columns.keys()).sort((x, y) => x - y);
      const runs = [];
      sortedColumns.forEach((column) => {
        const last = runs[runs.length - 1];
        if (last && column === last.to + 1) {
          last.to = column;
          last.count += columns.get(column).count;
        } else {
          runs.push({
            from: column,
            to: column,
            count: columns.get(column).count,
            firstFormat: columns.get(column).firstFormat,
          });
        }
      });

      // Stretches where the XML says inspection was inactive (make ready, splice, ...).
      const timeStart = reel.time_start ? new Date(reel.time_start).getTime() : NaN;
      const timeEnd = reel.time_end ? new Date(reel.time_end).getTime() : NaN;
      const fractionFromTime = (iso) => {
        const t = iso ? new Date(iso).getTime() : NaN;
        if (!Number.isFinite(t) || !Number.isFinite(timeStart) || !Number.isFinite(timeEnd) || timeEnd <= timeStart) {
          return null;
        }
        return (t - timeStart) / (timeEnd - timeStart);
      };
      const fractionFromFormat = (format) => {
        if (format === null || format === undefined || format === "") return null;
        const n = Number(format);
        return Number.isFinite(n) ? (n - reelStart) / repeats : null;
      };
      const inactiveBands = (phases || [])
        .filter((phase) => String(phase.phase || "").toLowerCase() === "inactive")
        .map((phase) => {
          let a = fractionFromFormat(phase.start_format);
          let b = fractionFromFormat(phase.end_format);
          if (a === null) a = fractionFromTime(phase.start_time);
          if (b === null) b = fractionFromTime(phase.end_time);
          if (a === null || b === null) return "";
          a = Math.max(a, 0);
          b = Math.min(b, 1);
          if (b <= a) return "";
          const title = `Inspection inactive: ${Utils.formatNumber(a * totalFeet, 0)} – ${Utils.formatNumber(b * totalFeet, 0)} ft`;
          return `<div title="${title}" style="position:absolute;top:0;bottom:0;left:${(a * 100).toFixed(3)}%;width:${((b - a) * 100).toFixed(3)}%;background:#ef4444;"></div>`;
        })
        .join("");

      const lines = runs
        .map((run) => {
          const left = (run.from / DEFECT_BAR_COLUMNS) * 100;
          const width = ((run.to - run.from + 1) / DEFECT_BAR_COLUMNS) * 100;
          const title = `${Utils.formatNumber(Math.max(feetAt(run.firstFormat), 0), 0)} ft — ${run.count} detection${run.count === 1 ? "" : "s"}`;
          return `<div title="${title}" style="position:absolute;top:0;bottom:0;left:${left.toFixed(3)}%;width:${width.toFixed(3)}%;min-width:2px;background:#111827;"></div>`;
        })
        .join("");

      const step = niceFeetStep(totalFeet);
      let ticks = "";
      for (let ft = 0; ft <= totalFeet; ft += step) {
        if (ft > 0 && (totalFeet - ft) / totalFeet < 0.12) continue;
        ticks += `<span style="position:absolute;top:0;left:${((ft / totalFeet) * 100).toFixed(3)}%;padding:2px 0 0 3px;border-left:1px solid #94a3b8;">${Utils.formatNumber(ft, 0)}</span>`;
      }
      ticks += `<span style="position:absolute;right:0;top:0;padding-top:2px;font-weight:600;">${Utils.formatNumber(totalFeet, 0)} ft</span>`;

      const inactiveSummary = Number.isFinite(inactivePct)
        ? ` · inspection inactive by time: ${Utils.formatNumber(inactivePct, 1)}%`
        : "";
      return `
        <div aria-label="Defect positions along the reel" style="position:relative;height:36px;background:#4ade80;border-radius:6px;overflow:hidden;">${inactiveBands}${lines}</div>
        <div style="position:relative;height:20px;margin-top:4px;font-size:11px;color:#64748b;">${ticks}</div>
        <div style="font-size:12px;color:#64748b;margin-top:2px;">${counted} detection${counted === 1 ? "" : "s"} along ${Utils.formatNumber(totalFeet, 0)} ft${inactiveSummary}</div>
        ${inactiveBands ? `<div style="font-size:12px;color:#64748b;margin-top:4px;"><span style="display:inline-block;width:10px;height:10px;background:#4ade80;border-radius:2px;margin-right:5px;"></span>inspecting <span style="display:inline-block;width:10px;height:10px;background:#ef4444;border-radius:2px;margin:0 5px 0 14px;"></span>inspection inactive</div>` : ""}`;
    }
    // </reel-overview>

    function renderTimeline(phases, ariaLabel, range) {
      if (!phases || !phases.length) return "<span class='badge'>No phase data</span>";
      const rangeStart = range && range.start ? new Date(range.start).getTime() : null;
      const rangeEnd = range && range.end ? new Date(range.end).getTime() : null;
      const hasRange =
        Number.isFinite(rangeStart) && Number.isFinite(rangeEnd) && rangeEnd > rangeStart;

      const validPhases = phases
        .map((phase) => {
          let start = phase.start_time ? new Date(phase.start_time).getTime() : null;
          let end = phase.end_time ? new Date(phase.end_time).getTime() : null;
          if (hasRange && start !== null && end !== null) {
            start = Math.max(start, rangeStart);
            end = Math.min(end, rangeEnd);
          }
          return { ...phase, start, end };
        })
        .filter((p) => p.start !== null && p.end !== null && p.end > p.start);
      if (!validPhases.length) return "<span class='badge'>No phase data</span>";

      const minStart = hasRange ? rangeStart : Math.min(...validPhases.map((p) => p.start));
      const maxEnd = hasRange ? rangeEnd : Math.max(...validPhases.map((p) => p.end));
      const total = maxEnd - minStart || 1;

      const bands = validPhases
        .map((phase) => {
          const width = ((phase.end - phase.start) / total) * 100;
          const left = ((phase.start - minStart) / total) * 100;
          const name = phase.phase || "unknown";
          const cls = `timeline-band ${name}`;
          return `<div class="${cls}" style="left:${left}%;width:${width}%" title="${name}"></div>`;
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
          Router.setActive("qc-review");
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

    function formatRange(start, end) {
      if (!start && !end) return "N/A";
      const startStr = formatTime(start, "N/A");
      const endStr = formatTime(end, "N/A");
      return `${startStr} → ${endStr}`;
    }

    return { init, activate, onFiltersUpdated };
  })();