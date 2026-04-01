  const ReferenceCheckTab = (() => {
    const FEET_TO_METERS = 0.3048;
    const METERS_TO_FEET = 3.28084;
    const DEFAULT_MIN_REEL_LENGTH_FEET = 4000;
    const MIN_LENGTH_STORAGE_KEY = "referenceCheck.minReelLength";
    let initialized = false;
    let active = false;
    let requestToken = 0;
    let payload = null;
    let errorMessage = "";
    let currentResolvedJob = "";
    let pendingAutoSelectedJob = "";
    let minReelLengthFilter = loadMinReelLength();
    const baselineByJob = new Map();

    const state = {
      sort: "captured_at_desc",
      modalRefImageId: null,
      modalDiffRenderId: 0,
      modalOverlaysVisible: true,
      modalImages: [],
      modalImageIndex: 0,
      modalBaselineImage: null,
      modalReelGroups: [],
      modalReelIndex: -1,
      lastLoggedDebugRefImageId: null,
    };

    const elements = {};

    function init() {
      if (initialized) return;
      initialized = true;
      elements.page = Utils.qs("#referenceCheckPage");
      elements.loading = Utils.qs("#referenceCheckLoading");
      elements.error = Utils.qs("#referenceCheckError");
      elements.empty = Utils.qs("#referenceCheckEmpty");
      elements.content = Utils.qs("#referenceCheckContent");
      elements.jobMeta = Utils.qs("#referenceCheckJobMeta");
      elements.minLengthInput = Utils.qs("#referenceCheckMinReelLengthInput");
      elements.minLengthApply = Utils.qs("#referenceCheckMinReelLengthApply");
      elements.minLengthChip = Utils.qs("#referenceCheckMinLengthChip");
      elements.minLengthClear = Utils.qs("#referenceCheckMinLengthClear");
      elements.galleryMeta = Utils.qs("#referenceCheckGalleryMeta");
      elements.gallery = Utils.qs("#referenceCheckGallery");
      elements.baselineSection = Utils.qs("#referenceCheckBaselineSection");
      elements.baselineSummary = Utils.qs("#referenceCheckBaselineSummary");
      elements.resultsSection = Utils.qs("#referenceCheckResultsSection");
      elements.resultsTableSection = Utils.qs("#referenceCheckResultsTableSection");
      elements.resultsHead = Utils.qs("#referenceCheckResultsHead");
      elements.resultsBody = Utils.qs("#referenceCheckResultsBody");
      elements.chart = Utils.qs("#referenceCheckTrendChart");
      elements.modal = Utils.qs("#referenceCheckModal");
      elements.modalClose = Utils.qs("#referenceCheckModalClose");
      elements.modalDismiss = Utils.qs("#referenceCheckModalDismiss");
      elements.modalNextReel = Utils.qs("#referenceCheckModalNextReel");
      elements.modalBaseline = Utils.qs("#referenceCheckModalBaseline");
      elements.modalComparison = Utils.qs("#referenceCheckModalComparison");
      elements.modalBaselinePanel = Utils.qs("#referenceCheckModalBaselinePanel");
      elements.modalComparePanel = Utils.qs("#referenceCheckModalComparePanel");
      elements.modalCompareLabel = Utils.qs("#referenceCheckModalCompareLabel");
      elements.modalBaselineImage = Utils.qs("#referenceCheckModalBaselineImage");
      elements.modalCompareImage = Utils.qs("#referenceCheckModalCompareImage");
      elements.modalBaselineOverlay = Utils.qs("#referenceCheckModalBaselineOverlay");
      elements.modalCompareOverlay = Utils.qs("#referenceCheckModalCompareOverlay");
      elements.modalDiffCanvas = Utils.qs("#referenceCheckModalDiffCanvas");
      elements.modalDiffEmpty = Utils.qs("#referenceCheckModalDiffEmpty");
      elements.modalAnalysis = Utils.qs("#referenceCheckModalAnalysis");
      elements.modalSummaryText = Utils.qs("#referenceCheckModalSummaryText");
      elements.modalSummaryList = Utils.qs("#referenceCheckModalSummaryList");
      elements.modalPrev = Utils.qs("#referenceCheckModalPrev");
      elements.modalNext = Utils.qs("#referenceCheckModalNext");
      elements.modalImageCounter = Utils.qs("#referenceCheckModalImageCounter");
      elements.modalTitle = Utils.qs("#referenceCheckModalTitle");
      elements.modalSubtitle = Utils.qs("#referenceCheckModalSubtitle");
      elements.modalMeta = Utils.qs("#referenceCheckModalMeta");
      elements.modalScores = Utils.qs("#referenceCheckModalScores");
      elements.modalExplanation = Utils.qs("#referenceCheckModalExplanation");

      if (elements.gallery) {
        elements.gallery.addEventListener("click", handleGalleryClick);
      }
      setupMinReelLengthControls();

      if (elements.resultsBody) {
        elements.resultsBody.addEventListener("click", handleResultsClick);
      }

      if (elements.modalClose) {
        elements.modalClose.addEventListener("click", closeModal);
      }
      if (elements.modalDismiss) {
        elements.modalDismiss.addEventListener("click", closeModal);
      }
      if (elements.modalBaseline) {
        elements.modalBaseline.addEventListener("click", () => {
          if (state.modalRefImageId != null) {
            applyBaseline(state.modalRefImageId);
          }
        });
      }
      if (elements.modalNextReel) {
        elements.modalNextReel.addEventListener("click", openNextReelInModal);
      }
      if (elements.modalPrev) {
        elements.modalPrev.addEventListener("click", () => cycleModalImage(-1));
      }
      if (elements.modalNext) {
        elements.modalNext.addEventListener("click", () => cycleModalImage(1));
      }
      if (elements.modal) {
        elements.modal.addEventListener("click", (event) => {
          if (event.target === elements.modal) {
            closeModal();
          }
        });
      }
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && elements.modal && !elements.modal.classList.contains("hidden")) {
          closeModal();
        }
      });
      window.addEventListener("resize", () => {
        if (!active) return;
        resizeTrendChart();
        if (elements.modal && !elements.modal.classList.contains("hidden") && state.modalRefImageId != null) {
          const currentItem = state.modalImages[state.modalImageIndex] || findReference(state.modalRefImageId);
          if (currentItem) {
            renderModalComparison(currentItem);
          }
        }
      });
    }

    function activate() {
      active = true;
      load();
      window.requestAnimationFrame(() => {
        resizeTrendChart();
      });
    }

    function deactivate() {
      active = false;
      closeModal();
    }

    function onFiltersUpdated() {
      load();
    }

    async function load() {
      if (!active) return;
      const currentRequest = ++requestToken;
      errorMessage = "";
      setViewState("loading");
      LoadingOverlay.show();
      try {
        const filters = Filters.getState ? Filters.getState() : {};
        const requestedJob = (filters.job || "").trim();
        if (requestedJob) {
          pendingAutoSelectedJob = "";
        }
        const extra = {};
        if (minReelLengthFilter > 0) {
          extra.min_reel_length = minReelLengthFilter;
        }
        if (requestedJob && baselineByJob.has(requestedJob)) {
          extra.baseline_ref_image_id = baselineByJob.get(requestedJob);
        }
        const data = await Api.get("reference-check", extra, filters);
        if (currentRequest !== requestToken) return;
        payload = data || null;
        currentResolvedJob = (data && data.resolved_job) || "";
        reconcileBaselineState(currentResolvedJob, payload);
        maybeAutoSelectResolvedJob(requestedJob, currentResolvedJob);
        render();
      } catch (err) {
        if (currentRequest !== requestToken) return;
        payload = null;
        errorMessage = err && err.message ? err.message : "Failed to load Reference Check.";
        setViewState("error");
      } finally {
        LoadingOverlay.hide();
      }
    }

    function reconcileBaselineState(jobName, data) {
      if (!jobName || !data || !Array.isArray(data.gallery)) return;
      const validIds = new Set(
        data.gallery
          .map((item) => Number(item && item.ref_image_id))
          .filter((value) => Number.isFinite(value))
      );
      const existing = baselineByJob.get(jobName);
      if (existing && !validIds.has(Number(existing))) {
        baselineByJob.delete(jobName);
      }
      if (data.baseline && Number.isFinite(Number(data.baseline.ref_image_id))) {
        baselineByJob.set(jobName, Number(data.baseline.ref_image_id));
      }
    }

    function maybeAutoSelectResolvedJob(requestedJob, resolvedJob) {
      if (!resolvedJob || requestedJob || pendingAutoSelectedJob === resolvedJob) {
        return;
      }
      pendingAutoSelectedJob = resolvedJob;
      if (Filters && typeof Filters.set === "function") {
        Filters.set("job", resolvedJob, { emit: true, updateUrl: true });
      }
    }

    function loadMinReelLength() {
      const defaultMeters = DEFAULT_MIN_REEL_LENGTH_FEET * FEET_TO_METERS;
      if (typeof sessionStorage === "undefined") return defaultMeters;
      try {
        const raw = sessionStorage.getItem(MIN_LENGTH_STORAGE_KEY);
        if (raw === null || raw === undefined) return defaultMeters;
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) return defaultMeters;
        if (parsed <= 0) return 0;
        return parsed;
      } catch (err) {
        return defaultMeters;
      }
    }

    function persistMinReelLength(value) {
      if (typeof sessionStorage === "undefined") return;
      try {
        sessionStorage.setItem(MIN_LENGTH_STORAGE_KEY, String(value || 0));
      } catch (err) {
        // ignore storage failures
      }
    }

    function setupMinReelLengthControls() {
      if (elements.minLengthInput) {
        const feetValue = minReelLengthFilter ? minReelLengthFilter * METERS_TO_FEET : 0;
        elements.minLengthInput.value = feetValue ? Math.round(feetValue) : "";
        elements.minLengthInput.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            applyMinReelLength(elements.minLengthInput.value);
          }
        });
      }
      if (elements.minLengthApply) {
        elements.minLengthApply.addEventListener("click", () =>
          applyMinReelLength(elements.minLengthInput ? elements.minLengthInput.value : "")
        );
      }
      if (elements.minLengthClear) {
        elements.minLengthClear.addEventListener("click", () => applyMinReelLength(""));
      }
      updateMinLengthChip();
    }

    function applyMinReelLength(rawValue) {
      const parsed = Number(rawValue);
      const nextValue = Number.isFinite(parsed) && parsed > 0 ? parsed * FEET_TO_METERS : 0;
      if (nextValue === minReelLengthFilter) {
        updateMinLengthChip();
        return;
      }
      minReelLengthFilter = nextValue;
      persistMinReelLength(minReelLengthFilter);
      if (elements.minLengthInput) {
        const feetValue = minReelLengthFilter ? minReelLengthFilter * METERS_TO_FEET : 0;
        elements.minLengthInput.value = feetValue ? Math.round(feetValue) : "";
      }
      updateMinLengthChip();
      load();
    }

    function updateMinLengthChip() {
      const chip = elements.minLengthChip;
      const text = chip ? chip.querySelector("span") : null;
      if (!chip) return;
      if (minReelLengthFilter > 0) {
        chip.classList.remove("hidden");
        if (text) {
          text.textContent = `Min reel length ≥ ${Utils.formatMeters(minReelLengthFilter)}`;
        }
      } else {
        chip.classList.add("hidden");
        if (text) text.textContent = "";
      }
    }

    function setViewState(mode) {
      const isLoading = mode === "loading";
      const isError = mode === "error";
      const hasContent = mode === "content";
      const isEmpty = mode === "empty";

      if (elements.loading) elements.loading.classList.toggle("hidden", !isLoading);
      if (elements.error) {
        elements.error.classList.toggle("hidden", !isError);
        elements.error.textContent = isError ? errorMessage : "";
      }
      if (elements.empty) elements.empty.classList.toggle("hidden", !isEmpty);
      if (elements.content) elements.content.classList.toggle("hidden", !hasContent);
    }

    function render() {
      if (!payload) {
        setViewState("error");
        return;
      }
      const gallery = Array.isArray(payload.gallery) ? payload.gallery : [];
      if (!gallery.length) {
        renderJobMeta();
        setViewState("empty");
        return;
      }
      renderJobMeta();
      renderGallery();
      renderResults();
      setViewState("content");
    }

    function renderJobMeta() {
      if (!elements.jobMeta || !payload) return;
      const context = payload.job_context || {};
      const pills = [];
      if (context.job_name) {
        pills.push(`<span class="reference-check-pill">Job: ${Utils.escapeHtml(context.job_name)}</span>`);
      }
      if (context.total_reels !== undefined) {
        pills.push(`<span class="reference-check-pill">${Utils.formatNumber(context.total_reels)} reels</span>`);
      }
      if (context.total_references !== undefined) {
        pills.push(`<span class="reference-check-pill">${Utils.formatNumber(context.total_references)} refs</span>`);
      }
      if (payload.auto_selected_job) {
        pills.push('<span class="reference-check-pill reference-check-pill--accent">Auto-selected latest job</span>');
      }
      elements.jobMeta.innerHTML = pills.join("");

      if (elements.galleryMeta) {
        const baseline = payload.baseline;
        elements.galleryMeta.innerHTML = baseline
          ? `<span class="reference-check-pill reference-check-pill--success">Baseline: ${Utils.escapeHtml(baseline.reel_code || baseline.filename || "Reference")}</span>`
          : '<span class="reference-check-pill">Choose a baseline to unlock comparisons</span>';
      }
    }

    function renderGallery() {
      if (!elements.gallery || !payload) return;
      const gallery = Array.isArray(payload.gallery) ? payload.gallery : [];
      const grouped = [];
      const byReel = new Map();
      gallery.forEach((item) => {
        const key = Number(item.reel_id) || `ref-${Number(item.ref_image_id) || Math.random()}`;
        if (!byReel.has(key)) {
          byReel.set(key, []);
          grouped.push(byReel.get(key));
        }
        byReel.get(key).push(item);
      });
      elements.gallery.innerHTML = grouped
        .map((items) => renderGalleryGroupCard(items))
        .join("");
    }

    function renderGalleryGroupCard(items) {
      const group = Array.isArray(items) ? items.slice() : [];
      if (!group.length) return "";
      group.sort((a, b) => compareNumber(a.reference_index, b.reference_index) || compareNumber(a.ref_image_id, b.ref_image_id));
      const primary = group[0];
      const isBaselineGroup = group.some((item) => item.is_baseline);
      const baselineItem = group.find((item) => item.is_baseline) || null;
      const hero = baselineItem || primary;
      const baselineBadge = isBaselineGroup ? '<span class="reference-check-badge">Baseline Reel</span>' : "";
      const reasonSummary = summarizeDifferenceTypes(group);
      const overallValues = group
        .map((item) => Number(item.overall_match_pct))
        .filter((value) => Number.isFinite(value));
      const thumbs = group
        .map((item) => {
          const matchHtml =
            item.overall_match_pct !== undefined && item.overall_match_pct !== null
              ? `<span class="reference-check-gallery-thumb__match">${formatPercent(item.overall_match_pct)}</span>`
              : "";
          const baselineThumbBadge = item.is_baseline
            ? '<span class="reference-check-gallery-thumb__badge">Baseline</span>'
            : "";
          return `
            <button
              type="button"
              class="reference-check-gallery-thumb${item.is_baseline ? " is-baseline" : ""}"
              data-ref-image-id="${Number(item.ref_image_id) || ""}"
              title="${Utils.escapeHtml(`Ref ${item.reference_index || 1} · ${formatTime(item.captured_at, "Timestamp unavailable")}`)}"
            >
              <span class="reference-check-gallery-thumb__media">
                ${buildThumbnail(item, "reference-check-gallery-thumb__image")}
                ${baselineThumbBadge}
              </span>
              <span class="reference-check-gallery-thumb__meta">
                <span>Ref ${Utils.formatNumber(item.reference_index || 1)}</span>
                ${matchHtml}
              </span>
            </button>
          `;
        })
        .join("");

      return `
        <article class="reference-check-card${isBaselineGroup ? " is-baseline" : ""}">
          <div class="reference-check-card__media reference-check-card__media--grouped">
            ${buildThumbnail(hero, "reference-check-card__thumb")}
          </div>
          <div class="reference-check-card__body">
            <div class="reference-check-card__title-row">
              <div>
                <strong>${Utils.escapeHtml(primary.reel_code || primary.filename || "Reference")}</strong>
                <p>${Utils.escapeHtml(formatTime(primary.captured_at, "Timestamp unavailable"))}</p>
              </div>
              ${baselineBadge}
            </div>
            <div class="reference-check-card__meta">
              <span>${Utils.escapeHtml(primary.machine_name || "Machine unavailable")}</span>
              <span>${formatFeet(primary.total_feet)}</span>
            </div>
            <div class="reference-check-card__footer">
              <div class="reference-check-card__metric-group">
                <div class="reference-check-card__metric">${overallValues.length ? formatPercent(Math.min(...overallValues)) : "—"}</div>
                <span class="reference-check-muted">Overall</span>
              </div>
              <span class="reference-check-status reference-check-status--${Utils.escapeHtml(reasonSummary.key)}">${Utils.escapeHtml(reasonSummary.label)}</span>
            </div>
            <div class="reference-check-gallery-group">
              ${thumbs}
            </div>
          </div>
        </article>
      `;
    }

    function renderResults() {
      if (!payload) return;
      const hasBaseline = Boolean(payload.baseline);
      if (elements.baselineSection) {
        elements.baselineSection.classList.toggle("hidden", !hasBaseline);
      }
      if (elements.resultsSection) {
        elements.resultsSection.classList.toggle("hidden", !hasBaseline);
      }
      if (elements.resultsTableSection) {
        elements.resultsTableSection.classList.toggle("hidden", !hasBaseline);
      }
      if (!hasBaseline) {
        if (elements.baselineSummary) {
          elements.baselineSummary.innerHTML = `
            <div class="reference-check-empty-inline">
              Select a reference image from the gallery to set the job baseline.
            </div>
          `;
        }
        if (elements.resultsHead) {
          elements.resultsHead.innerHTML = "";
        }
        if (elements.resultsBody) {
          elements.resultsBody.innerHTML = `
            <tr>
              <td class="reference-check-table__empty">Choose a baseline reference image to compute comparisons.</td>
            </tr>
          `;
        }
        renderTrendChart([]);
        return;
      }

      renderBaselineSummary();
      const comparisons = sortComparisons(payload.comparisons || []);
      const trendPoints = sortTrendPoints(payload.trend || []);
      renderResultsTable(payload.reel_comparisons || [], payload.defect_types || []);
      renderTrendChart(trendPoints);
    }

    function renderBaselineSummary() {
      if (!elements.baselineSummary || !payload || !payload.baseline) return;
      const baseline = payload.baseline;
      const summary = payload.summary || {};
      const thumb = buildThumbnail(baseline, "reference-check-baseline__image");
      const dominantDifference = summary.difference_type_summary && summary.difference_type_summary.dominant
        ? summary.difference_type_summary.dominant.label
        : "Strong match";
      elements.baselineSummary.innerHTML = `
        <div class="reference-check-baseline__media">
          ${thumb}
        </div>
        <div class="reference-check-baseline__details">
          <div class="reference-check-baseline__header">
            <div>
              <strong>${Utils.escapeHtml(baseline.reel_code || baseline.filename || "Baseline reference")}</strong>
              <p>${Utils.escapeHtml(formatTime(baseline.captured_at, "Timestamp unavailable"))}</p>
            </div>
          </div>
          <div class="reference-check-baseline__meta">
            <span>Machine: ${Utils.escapeHtml(baseline.machine_name || "—")}</span>
            <span>Order: ${Utils.escapeHtml(baseline.order_number || "—")}</span>
            <span>Dominant Drift: ${Utils.escapeHtml(dominantDifference)}</span>
          </div>
          <div class="reference-check-kpis">
            ${renderKpi("Compared", Utils.formatNumber(summary.compared_references || 0))}
            ${renderKpi("Avg Overall", formatPercent(summary.average_match_pct))}
            ${renderKpi("Avg Content", formatPercent(summary.average_content_match_pct))}
            ${renderKpi("Avg Color", formatPercent(summary.average_color_match_pct))}
            ${renderKpi("Avg Align", formatPercent(summary.average_alignment_match_pct))}
            ${renderKpi("Color Shifts", Utils.formatNumber(summary.color_shift_count || 0))}
            ${renderKpi("Content Changes", Utils.formatNumber(summary.content_change_count || 0))}
            ${renderKpi("Alignment Shifts", Utils.formatNumber(summary.alignment_shift_count || 0))}
            ${renderKpi("Change Groups", Utils.formatNumber(summary.likely_change_event_count || 0))}
          </div>
        </div>
      `;
    }

    function renderResultsTable(rows, defectTypes) {
      if (!elements.resultsBody) return;
      const reelRows = Array.isArray(rows) ? rows.slice() : [];
      const defectColumns = Array.isArray(defectTypes) ? defectTypes : [];
      reelRows.sort((a, b) => compareDate(b.captured_at, a.captured_at));
      if (elements.resultsHead) {
        const defectHeaders = defectColumns
          .map((entry) => `<th>${Utils.escapeHtml(entry.label || entry.key || "Defect")}</th>`)
          .join("");
        elements.resultsHead.innerHTML = `
          <tr>
            <th>Reel</th>
            <th>Timestamp</th>
            <th>Images</th>
            <th>Overall %</th>
            <th>Content %</th>
            <th>Color %</th>
            <th>Align %</th>
            <th>Likely Difference</th>
            <th>BST Active %</th>
            <th>Total Feet</th>
            <th>Defects</th>
            <th>Defects / 1k ft</th>
            <th>Adj Defects / 1k ft</th>
            ${defectHeaders}
          </tr>
        `;
      }
      if (!reelRows.length) {
        elements.resultsBody.innerHTML = `
          <tr>
            <td colspan="${13 + defectColumns.length}" class="reference-check-table__empty">No non-baseline references were available for comparison.</td>
          </tr>
        `;
        return;
      }
      elements.resultsBody.innerHTML = reelRows
        .map((item) => {
          const iconMarkup = renderResultsImageCell(item);
          const defectCells = defectColumns
            .map((entry) => {
              const breakdown = item.defect_breakdown || {};
              return `<td>${Utils.formatNumber(breakdown[entry.key] || 0)}</td>`;
            })
            .join("");
          return `
            <tr>
              <td>${Utils.escapeHtml(item.reel_code || "—")}</td>
              <td>${Utils.escapeHtml(formatTime(item.captured_at, "—"))}</td>
              <td>${iconMarkup}</td>
              <td>${formatPercent(item.overall_match_pct)}</td>
              <td>${formatPercent(item.content_match_pct)}</td>
              <td>${formatPercent(item.color_match_pct)}</td>
              <td>${formatPercent(item.alignment_match_pct)}</td>
              <td><span class="reference-check-status reference-check-status--${Utils.escapeHtml(item.difference_reason_key || "unscored")}">${Utils.escapeHtml(item.likely_difference_type || "—")}</span></td>
              <td>${formatPercent(item.bst_active_pct)}</td>
              <td>${formatFeet(item.total_feet)}</td>
              <td>${Utils.formatNumber(item.defect_count || 0)}</td>
              <td>${formatRate(item.defects_per_1000ft)}</td>
              <td>${formatRate(item.adjusted_defects_per_1000ft)}</td>
              ${defectCells}
            </tr>
          `;
        })
        .join("");
    }

    function renderResultsImageCell(row) {
      const reelId = Number(row.reel_id) || "";
      const baselineButton = row.baseline_image
        ? `
          <button
            type="button"
            class="reference-check-icon-btn reference-check-icon-btn--baseline"
            data-reel-preview="${reelId}"
            data-image-index="0"
            title="Open baseline vs selected reference comparison"
            aria-label="Open baseline comparison for ${Utils.escapeHtml(row.reel_code || "reel")}"
          >
            ${buildThumbnail(row.baseline_image, "reference-check-icon-btn__image")}
          </button>
        `
        : '<span class="reference-check-icon-btn reference-check-icon-btn--placeholder">—</span>';
      const actualImages = Array.isArray(row.actual_images) ? row.actual_images : [];
      const actualButtons = actualImages.length
        ? actualImages
            .map((image, index) => {
              const label = image.reference_index ? `Ref ${image.reference_index}` : `Ref ${index + 1}`;
              const timestamp = formatTime(image.captured_at, "");
              return `
                <button
                  type="button"
                  class="reference-check-icon-btn"
                  data-reel-preview="${reelId}"
                  data-image-index="${index}"
                  title="${Utils.escapeHtml([label, timestamp].filter(Boolean).join(" · "))}"
                  aria-label="Open ${Utils.escapeHtml(label)} for ${Utils.escapeHtml(row.reel_code || "reel")}"
                >
                  ${buildThumbnail(image, "reference-check-icon-btn__image")}
                </button>
              `;
            })
            .join("")
        : '<span class="reference-check-icon-btn reference-check-icon-btn--placeholder">—</span>';

      return `
        <div class="reference-check-image-cell" data-reel-preview="${reelId}" data-image-index="0">
          <div class="reference-check-image-lane">
            <span class="reference-check-image-lane__label">Base</span>
            <div class="reference-check-icon-stack">${baselineButton}</div>
          </div>
          <div class="reference-check-image-lane">
            <span class="reference-check-image-lane__label">Actual</span>
            <div class="reference-check-icon-stack">${actualButtons}</div>
          </div>
        </div>
      `;
    }

    function renderTrendChart(points) {
      if (!elements.chart) return;
      if (!points.length || !window.Plotly) {
        elements.chart.innerHTML = "";
        return;
      }
      const x = points.map((item) => item.captured_at);
      const y = points.map((item) => item.match_pct);
      const markerColors = points.map((item) => {
        if (item.likely_changed) return "#dc2626";
        if ((item.match_pct || 0) >= 95) return "#059669";
        if ((item.match_pct || 0) >= 90) return "#0284c7";
        return "#d97706";
      });
      const layout = typeof withResponsiveLayout === "function"
        ? withResponsiveLayout({
            autosize: true,
            margin: { l: 44, r: 18, t: 20, b: 96 },
            hovermode: "closest",
            xaxis: {
              title: "Timestamp",
              type: "date",
              tickangle: -45,
              automargin: true,
              nticks: 10,
            },
            yaxis: {
              title: "Match %",
              range: [0, 100],
              automargin: true,
            },
          })
        : {
            autosize: true,
            margin: { l: 44, r: 18, t: 20, b: 96 },
            hovermode: "closest",
            xaxis: {
              title: "Timestamp",
              type: "date",
              tickangle: -45,
              automargin: true,
              nticks: 10,
            },
            yaxis: {
              title: "Match %",
              range: [0, 100],
              automargin: true,
            },
          };
      const config = typeof plotlyConfig === "function"
        ? plotlyConfig({ responsive: true, displayModeBar: false })
        : { responsive: true, displayModeBar: false };
      Plotly.react(
        elements.chart,
        [
          {
            type: "scatter",
            mode: "lines+markers",
            x,
            y,
            line: { color: "#1d4ed8", width: 2 },
            marker: { size: 10, color: markerColors, line: { color: "#ffffff", width: 1 } },
            customdata: points.map((item) => [
              formatTime(item.captured_at, "—"),
              item.reel_code || "—",
            ]),
            hovertemplate:
              "Time: %{customdata[0]}<br>Reel: %{customdata[1]}<br>Match: %{y:.1f}%<extra></extra>",
          },
        ],
        layout,
        config
      );
      window.requestAnimationFrame(() => {
        resizeTrendChart();
      });
    }

    function resizeTrendChart() {
      if (!elements.chart || !window.Plotly) return;
      if (!elements.chart.offsetWidth) return;
      try {
        window.Plotly.Plots.resize(elements.chart);
      } catch (err) {
        // ignore transient resize errors while the tab is mounting
      }
    }

    function sortComparisons(rows) {
      const items = Array.isArray(rows) ? rows.slice() : [];
      const comparators = {
        captured_at_desc: (a, b) => compareDate(b.captured_at, a.captured_at),
        captured_at_asc: (a, b) => compareDate(a.captured_at, b.captured_at),
        match_pct_asc: (a, b) => compareNumber(a.match_pct, b.match_pct),
        match_pct_desc: (a, b) => compareNumber(b.match_pct, a.match_pct),
        defect_count_desc: (a, b) => compareNumber(b.defect_count, a.defect_count),
      };
      const compare = comparators[state.sort] || comparators.captured_at_desc;
      items.sort((a, b) => {
        const primary = compare(a, b);
        if (primary !== 0) return primary;
        return compareDate(a.captured_at, b.captured_at);
      });
      return items;
    }

    function compareDate(a, b) {
      const aTime = a ? new Date(a).getTime() : 0;
      const bTime = b ? new Date(b).getTime() : 0;
      return aTime - bTime;
    }

    function compareNumber(a, b) {
      const aNum = Number.isFinite(Number(a)) ? Number(a) : -Infinity;
      const bNum = Number.isFinite(Number(b)) ? Number(b) : -Infinity;
      return aNum - bNum;
    }

    function sortTrendPoints(rows) {
      const items = Array.isArray(rows) ? rows.slice() : [];
      items.sort((a, b) => {
        const timeCompare = compareDate(a && a.captured_at, b && b.captured_at);
        if (timeCompare !== 0) return timeCompare;
        const reelCompare = String((a && a.reel_code) || "").localeCompare(String((b && b.reel_code) || ""));
        if (reelCompare !== 0) return reelCompare;
        return compareNumber(a && a.ref_image_id, b && b.ref_image_id);
      });
      return items;
    }

    function handleGalleryClick(event) {
      const card = event.target.closest("[data-ref-image-id]");
      if (!card) return;
      const refImageId = Number(card.dataset.refImageId);
      if (!Number.isFinite(refImageId)) return;
      openGalleryModal(refImageId);
    }

    function handleResultsClick(event) {
      const previewButton = event.target.closest("[data-reel-preview]");
      if (!previewButton) return;
      const reelId = Number(previewButton.dataset.reelPreview);
      const imageIndex = Number(previewButton.dataset.imageIndex || 0);
      if (!Number.isFinite(reelId)) return;
      openReelModal(reelId, imageIndex);
    }

    function openModal(refImageId) {
      const item = findReference(refImageId);
      if (!item || !elements.modal) return;
      const baseline = payload && payload.baseline ? payload.baseline : null;
      state.modalImages = [item];
      state.modalImageIndex = 0;
      state.modalBaselineImage = baseline;
      state.modalReelGroups = [];
      state.modalReelIndex = -1;
      state.modalRefImageId = refImageId;
      state.modalOverlaysVisible = true;
      updateModalState();
      document.body.classList.add("reference-check-modal-open");
      elements.modal.classList.remove("hidden");
    }

    function openGalleryModal(refImageId) {
      const item = findReference(refImageId);
      if (!item || !elements.modal) return;
      const groups = getGalleryReelGroups();
      const reelId = Number(item.reel_id);
      const reelIndex = groups.findIndex((group) =>
        group.some((entry) => Number(entry.ref_image_id) === refImageId)
      );
      const images = reelIndex >= 0 ? groups[reelIndex] : [item];
      const imageIndex = Math.max(
        0,
        images.findIndex((entry) => Number(entry.ref_image_id) === refImageId)
      );
      const baseline = payload && payload.baseline ? payload.baseline : null;
      state.modalImages = images;
      state.modalImageIndex = imageIndex >= 0 ? imageIndex : 0;
      state.modalBaselineImage = baseline;
      state.modalReelGroups = groups;
      state.modalReelIndex = reelIndex >= 0 ? reelIndex : (Number.isFinite(reelId) ? 0 : -1);
      state.modalRefImageId = refImageId;
      state.modalOverlaysVisible = true;
      updateModalState();
      document.body.classList.add("reference-check-modal-open");
      elements.modal.classList.remove("hidden");
    }

    function openReelModal(reelId, imageIndex = 0) {
      if (!payload || !Array.isArray(payload.reel_comparisons) || !elements.modal) return;
      const row = payload.reel_comparisons.find((entry) => Number(entry.reel_id) === Number(reelId));
      if (!row) return;
      const actualImages = Array.isArray(row.actual_images) ? row.actual_images : [];
      if (!actualImages.length) return;
      state.modalImages = actualImages;
      state.modalImageIndex = Math.max(0, Math.min(actualImages.length - 1, Number(imageIndex) || 0));
      state.modalBaselineImage = row.baseline_image || (payload && payload.baseline) || null;
      state.modalReelGroups = [];
      state.modalReelIndex = -1;
      state.modalRefImageId = Number(actualImages[state.modalImageIndex].ref_image_id) || null;
      state.modalOverlaysVisible = true;
      updateModalState();
      document.body.classList.add("reference-check-modal-open");
      elements.modal.classList.remove("hidden");
    }

    function updateModalState() {
      const item = state.modalImages[state.modalImageIndex];
      if (!item || !elements.modal) return;
      const comparisonMode = isComparisonMode(item);
      state.modalRefImageId = Number(item.ref_image_id) || state.modalRefImageId;
      if (elements.modalTitle) {
        elements.modalTitle.textContent = comparisonMode
          ? (item.reel_code || item.filename || "Reference Comparison")
          : (item.reel_code || item.filename || "Reference Preview");
      }
      if (elements.modalSubtitle) {
        const subtitleParts = [formatTime(item.captured_at, "Timestamp unavailable")];
        if (comparisonMode) {
          subtitleParts.unshift("Baseline vs selected reference");
        } else {
          subtitleParts.unshift("Candidate reference preview");
        }
        if (state.modalImages.length > 1) {
          subtitleParts.push(`Reference ${state.modalImageIndex + 1} of ${state.modalImages.length}`);
        }
        elements.modalSubtitle.textContent = subtitleParts.join(" · ");
      }
      if (elements.modalComparison) {
        elements.modalComparison.classList.toggle("is-preview-mode", !comparisonMode);
      }
      if (elements.modalCompareLabel) {
        elements.modalCompareLabel.textContent = comparisonMode ? "Selected" : "Preview";
      }
      logComparisonDebug(item, comparisonMode);
      renderModalComparison(item);
      if (elements.modalMeta) {
        elements.modalMeta.innerHTML = [
          metaRow("Job", item.job_name || "—"),
          metaRow("Reel", item.reel_code || "—"),
          metaRow("Timestamp", formatTime(item.captured_at, "—")),
          metaRow("Machine", item.machine_name || "—"),
          metaRow("Likely Difference", item.likely_difference_type || "—"),
        ].join("");
      }
      if (elements.modalScores) {
        elements.modalScores.innerHTML = comparisonMode
          ? [
              renderScoreTile("Overall", item.overall_match_pct),
              renderScoreTile("Content", item.content_match_pct),
              renderScoreTile("Color", item.color_match_pct),
              renderScoreTile("Alignment", item.alignment_match_pct),
            ].join("")
          : "";
      }
      if (elements.modalExplanation) {
        elements.modalExplanation.textContent = comparisonMode
          ? (item.difference_explanation || "")
          : "Preview this reference image, then set it as the baseline to unlock content, color, and alignment scoring.";
      }
      if (elements.modalBaseline) {
        elements.modalBaseline.disabled = Boolean(item.is_baseline);
        elements.modalBaseline.textContent = item.is_baseline ? "Active Baseline" : "Set as Baseline";
      }
      if (elements.modalPrev) {
        const hideNav = state.modalImages.length <= 1;
        elements.modalPrev.disabled = hideNav;
        elements.modalPrev.classList.toggle("hidden", hideNav);
      }
      if (elements.modalNext) {
        const hideNav = state.modalImages.length <= 1;
        elements.modalNext.disabled = hideNav;
        elements.modalNext.classList.toggle("hidden", hideNav);
      }
      if (elements.modalImageCounter) {
        elements.modalImageCounter.textContent =
          state.modalImages.length > 1 ? `${state.modalImageIndex + 1} of ${state.modalImages.length}` : "";
      }
      if (elements.modalNextReel) {
        const hasNextReel =
          Array.isArray(state.modalReelGroups) &&
          state.modalReelIndex >= 0 &&
          state.modalReelIndex < state.modalReelGroups.length - 1;
        elements.modalNextReel.classList.toggle("hidden", !hasNextReel);
        elements.modalNextReel.disabled = !hasNextReel;
      }
    }

    function cycleModalImage(direction) {
      if (!state.modalImages.length) return;
      const total = state.modalImages.length;
      state.modalImageIndex = (state.modalImageIndex + direction + total) % total;
      updateModalState();
    }

    function openNextReelInModal() {
      if (!Array.isArray(state.modalReelGroups) || state.modalReelIndex < 0) return;
      const nextIndex = state.modalReelIndex + 1;
      if (nextIndex >= state.modalReelGroups.length) return;
      const nextImages = state.modalReelGroups[nextIndex] || [];
      if (!nextImages.length) return;
      state.modalReelIndex = nextIndex;
      state.modalImages = nextImages;
      state.modalImageIndex = 0;
      state.modalRefImageId = Number(nextImages[0].ref_image_id) || null;
      updateModalState();
    }

    function renderModalComparison(item) {
      const baseline = state.modalBaselineImage || (payload && payload.baseline ? payload.baseline : null);
      const comparisonMode =
        Boolean(baseline && baseline.image_src) &&
        Number(baseline.ref_image_id) !== Number(item.ref_image_id);
      if (!elements.modalBaselineImage || !elements.modalCompareImage) return;
      if (elements.modalAnalysis) {
        elements.modalAnalysis.classList.add("hidden");
      }
      if (!item.image_src) {
        elements.modalCompareImage.removeAttribute("src");
        elements.modalCompareImage.alt = "Reference preview unavailable";
        elements.modalBaselineImage.removeAttribute("src");
        clearOverlayCanvas(elements.modalBaselineOverlay);
        clearOverlayCanvas(elements.modalCompareOverlay);
        return;
      }
      const compareSrc = urlForStatic(item.image_src);
      elements.modalCompareImage.src = compareSrc;
      elements.modalCompareImage.alt = item.reel_code || "Selected preview";
      if (!comparisonMode) {
        elements.modalBaselineImage.removeAttribute("src");
        clearOverlayCanvas(elements.modalBaselineOverlay);
        clearOverlayCanvas(elements.modalCompareOverlay);
        if (elements.modalDiffEmpty) {
          elements.modalDiffEmpty.classList.add("hidden");
        }
        if (elements.modalDiffCanvas) {
          const ctx = elements.modalDiffCanvas.getContext("2d");
          if (ctx) {
            ctx.clearRect(0, 0, elements.modalDiffCanvas.width, elements.modalDiffCanvas.height);
          }
        }
        if (elements.modalSummaryText) {
          elements.modalSummaryText.textContent = "Select this reference as the baseline to unlock comparison analysis across the job.";
        }
        if (elements.modalSummaryList) {
          elements.modalSummaryList.innerHTML = "";
        }
        updateOverlayVisibility();
        return;
      }
      const baselineSrc = urlForStatic(baseline.image_src);
      elements.modalBaselineImage.src = baselineSrc;
      elements.modalBaselineImage.alt = baseline.reel_code || "Baseline preview";
      if (elements.modalAnalysis) {
        elements.modalAnalysis.classList.remove("hidden");
      }
      drawDiffHeatmap(baselineSrc, compareSrc);
      updateOverlayVisibility();
    }

    async function drawDiffHeatmap(baselineSrc, compareSrc) {
      const canvas = elements.modalDiffCanvas;
      if (!canvas) return;
      const renderId = ++state.modalDiffRenderId;
      try {
        const [baselineImage, comparisonImage] = await Promise.all([
          loadImage(baselineSrc),
          loadImage(compareSrc),
        ]);
        if (renderId !== state.modalDiffRenderId) return;
        const size = 256;
        const workCanvas = document.createElement("canvas");
        workCanvas.width = size;
        workCanvas.height = size;
        const workCtx = workCanvas.getContext("2d", { willReadFrequently: true });
        if (!workCtx) {
          showDiffHeatmapUnavailable();
          return;
        }
        const baselineSample = sampleImageToData(workCtx, baselineImage, size);
        const comparisonSample = sampleImageToData(workCtx, comparisonImage, size);
        if (!baselineSample || !comparisonSample) {
          showDiffHeatmapUnavailable();
          return;
        }
        const baselineData = baselineSample.data;
        const comparisonData = comparisonSample.data;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          showDiffHeatmapUnavailable();
          return;
        }
        canvas.width = size;
        canvas.height = size;
        canvas.style.width = "100%";
        canvas.style.height = "auto";
        const imageData = ctx.createImageData(size, size);
        const diffStrength = new Float32Array(size * size);
        for (let i = 0; i < baselineData.length; i += 4) {
          const baseGray = normalizeGray(baselineData[i], baselineData[i + 1], baselineData[i + 2]);
          const compGray = normalizeGray(comparisonData[i], comparisonData[i + 1], comparisonData[i + 2]);
          const diff = Math.min(255, Math.abs(baseGray - compGray) * 3.2);
          diffStrength[i / 4] = diff;
          imageData.data[i] = diff;
          imageData.data[i + 1] = Math.max(0, 210 - diff * 0.45);
          imageData.data[i + 2] = Math.max(0, 120 - diff * 0.7);
          imageData.data[i + 3] = 255;
        }
        ctx.putImageData(imageData, 0, 0);
        const regions = detectChangeRegions(diffStrength, size, size);
        renderChangeRegionSummary(regions, size, size);
        renderOverlayRegions(
          elements.modalBaselineOverlay,
          baselineImage,
          baselineSample.drawBox,
          regions,
          size,
          size
        );
        renderOverlayRegions(
          elements.modalCompareOverlay,
          comparisonImage,
          comparisonSample.drawBox,
          regions,
          size,
          size
        );
        updateOverlayVisibility();
        if (elements.modalDiffEmpty) {
          elements.modalDiffEmpty.classList.add("hidden");
        }
      } catch (err) {
        if (renderId !== state.modalDiffRenderId) return;
        showDiffHeatmapUnavailable();
      }
    }

    function sampleImageToData(ctx, image, size) {
      ctx.clearRect(0, 0, size, size);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, size, size);
      const ratio = Math.min(size / image.naturalWidth, size / image.naturalHeight);
      const drawWidth = image.naturalWidth * ratio;
      const drawHeight = image.naturalHeight * ratio;
      const offsetX = (size - drawWidth) / 2;
      const offsetY = (size - drawHeight) / 2;
      ctx.drawImage(image, offsetX, offsetY, drawWidth, drawHeight);
      return {
        data: ctx.getImageData(0, 0, size, size).data,
        drawBox: { x: offsetX, y: offsetY, width: drawWidth, height: drawHeight },
      };
    }

    function normalizeGray(r, g, b) {
      return Math.round(r * 0.299 + g * 0.587 + b * 0.114);
    }

    function showDiffHeatmapUnavailable() {
      if (elements.modalDiffEmpty) {
        elements.modalDiffEmpty.classList.remove("hidden");
      }
      clearOverlayCanvas(elements.modalBaselineOverlay);
      clearOverlayCanvas(elements.modalCompareOverlay);
      if (elements.modalSummaryText) {
        elements.modalSummaryText.textContent = "Grouped change analysis is unavailable for this comparison.";
      }
      if (elements.modalSummaryList) {
        elements.modalSummaryList.innerHTML = "";
      }
      if (elements.modalDiffCanvas) {
        const ctx = elements.modalDiffCanvas.getContext("2d");
        if (ctx) {
          ctx.clearRect(0, 0, elements.modalDiffCanvas.width, elements.modalDiffCanvas.height);
        }
      }
    }

    function detectChangeRegions(diffStrength, width, height) {
      const threshold = 52;
      const minArea = 120;
      const mask = new Uint8Array(width * height);
      for (let i = 0; i < diffStrength.length; i += 1) {
        if (diffStrength[i] >= threshold) {
          mask[i] = 1;
        }
      }
      const cleaned = suppressNoise(mask, width, height);
      const components = connectedComponents(cleaned, diffStrength, width, height, minArea);
      return mergeNearbyRegions(components, width, height)
        .sort((a, b) => (b.area || 0) - (a.area || 0))
        .slice(0, 6)
        .map((region, index) => ({
          ...region,
          label: describeRegion(region, width, height),
          rank: index + 1,
        }));
    }

    function suppressNoise(mask, width, height) {
      const cleaned = new Uint8Array(mask.length);
      for (let y = 1; y < height - 1; y += 1) {
        for (let x = 1; x < width - 1; x += 1) {
          const index = y * width + x;
          if (!mask[index]) continue;
          let neighbors = 0;
          for (let yy = -1; yy <= 1; yy += 1) {
            for (let xx = -1; xx <= 1; xx += 1) {
              if (mask[(y + yy) * width + (x + xx)]) {
                neighbors += 1;
              }
            }
          }
          if (neighbors >= 4) {
            cleaned[index] = 1;
          }
        }
      }
      return cleaned;
    }

    function connectedComponents(mask, diffStrength, width, height, minArea) {
      const visited = new Uint8Array(mask.length);
      const regions = [];
      const queueX = [];
      const queueY = [];
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const startIndex = y * width + x;
          if (!mask[startIndex] || visited[startIndex]) continue;
          let minX = x;
          let maxX = x;
          let minY = y;
          let maxY = y;
          let area = 0;
          let intensitySum = 0;
          queueX.length = 0;
          queueY.length = 0;
          queueX.push(x);
          queueY.push(y);
          visited[startIndex] = 1;
          for (let cursor = 0; cursor < queueX.length; cursor += 1) {
            const currentX = queueX[cursor];
            const currentY = queueY[cursor];
            const currentIndex = currentY * width + currentX;
            area += 1;
            intensitySum += diffStrength[currentIndex] || 0;
            if (currentX < minX) minX = currentX;
            if (currentX > maxX) maxX = currentX;
            if (currentY < minY) minY = currentY;
            if (currentY > maxY) maxY = currentY;
            const neighbors = [
              [currentX - 1, currentY],
              [currentX + 1, currentY],
              [currentX, currentY - 1],
              [currentX, currentY + 1],
            ];
            neighbors.forEach(([nextX, nextY]) => {
              if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) return;
              const nextIndex = nextY * width + nextX;
              if (!mask[nextIndex] || visited[nextIndex]) return;
              visited[nextIndex] = 1;
              queueX.push(nextX);
              queueY.push(nextY);
            });
          }
          if (area < minArea) continue;
          regions.push({
            x: minX,
            y: minY,
            width: maxX - minX + 1,
            height: maxY - minY + 1,
            area,
            avgIntensity: area ? intensitySum / area : 0,
          });
        }
      }
      return regions;
    }

    function mergeNearbyRegions(regions, width, height) {
      const merged = [];
      const padding = Math.max(10, Math.round(Math.min(width, height) * 0.03));
      regions.forEach((region) => {
        let target = null;
        for (let index = 0; index < merged.length; index += 1) {
          const existing = merged[index];
          const overlapsX = region.x <= existing.x + existing.width + padding && region.x + region.width >= existing.x - padding;
          const overlapsY = region.y <= existing.y + existing.height + padding && region.y + region.height >= existing.y - padding;
          if (overlapsX && overlapsY) {
            target = existing;
            break;
          }
        }
        if (!target) {
          merged.push({ ...region });
          return;
        }
        const minX = Math.min(target.x, region.x);
        const minY = Math.min(target.y, region.y);
        const maxX = Math.max(target.x + target.width, region.x + region.width);
        const maxY = Math.max(target.y + target.height, region.y + region.height);
        target.x = minX;
        target.y = minY;
        target.width = maxX - minX;
        target.height = maxY - minY;
        target.area += region.area;
        target.avgIntensity = Math.max(target.avgIntensity, region.avgIntensity);
      });
      return merged;
    }

    function describeRegion(region, width, height) {
      const centerX = region.x + region.width / 2;
      const centerY = region.y + region.height / 2;
      const horizontal = centerX < width / 3 ? "left" : centerX > (width * 2) / 3 ? "right" : "center";
      const vertical = centerY < height / 3 ? "upper" : centerY > (height * 2) / 3 ? "lower" : "middle";
      return `${vertical} ${horizontal} area`;
    }

    function renderChangeRegionSummary(regions, width, height) {
      if (!elements.modalSummaryText || !elements.modalSummaryList) return;
      if (!regions.length) {
        elements.modalSummaryText.textContent = "No major grouped change regions were detected. Minor background noise was suppressed.";
        elements.modalSummaryList.innerHTML = "";
        return;
      }
      const topLabels = regions.slice(0, 3).map((region) => region.label);
      elements.modalSummaryText.textContent = `Detected ${regions.length} major changed region${regions.length === 1 ? "" : "s"}. Largest changes appear in ${topLabels.join(", ")}. Minor background noise was suppressed.`;
      elements.modalSummaryList.innerHTML = regions
        .map((region) => {
          const areaPct = ((region.area / (width * height)) * 100).toFixed(1);
          return `
            <div class="reference-check-modal__summary-item">
              <span class="reference-check-modal__summary-chip">Region ${region.rank}</span>
              <div>
                <strong>${Utils.escapeHtml(region.label)}</strong>
                <p>${areaPct}% of normalized frame · strength ${Utils.formatNumber(region.avgIntensity || 0, 0)}</p>
              </div>
            </div>
          `;
        })
        .join("");
    }

    function renderOverlayRegions(canvas, image, drawBox, regions, width, height) {
      if (!canvas || !image) return;
      const stage = image.closest(".reference-check-modal__stage");
      const frame = getContainedImageFrame(stage, image);
      if (!frame) {
        clearOverlayCanvas(canvas);
        return;
      }
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(frame.stageWidth * dpr);
      canvas.height = Math.round(frame.stageHeight * dpr);
      canvas.style.width = `${frame.stageWidth}px`;
      canvas.style.height = `${frame.stageHeight}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, frame.stageWidth, frame.stageHeight);
      const scaleX = frame.displayWidth / drawBox.width;
      const scaleY = frame.displayHeight / drawBox.height;
      regions.forEach((region, index) => {
        const x = frame.offsetX + (region.x - drawBox.x) * scaleX;
        const y = frame.offsetY + (region.y - drawBox.y) * scaleY;
        const boxWidth = region.width * scaleX;
        const boxHeight = region.height * scaleY;
        ctx.fillStyle = "rgba(239, 68, 68, 0.18)";
        ctx.strokeStyle = "rgba(220, 38, 38, 0.95)";
        ctx.lineWidth = 2;
        ctx.fillRect(x, y, boxWidth, boxHeight);
        ctx.strokeRect(x, y, boxWidth, boxHeight);
        ctx.fillStyle = "rgba(15, 23, 42, 0.82)";
        ctx.fillRect(x, Math.max(0, y - 24), 34, 20);
        ctx.fillStyle = "#ffffff";
        ctx.font = "12px sans-serif";
        ctx.fillText(String(index + 1), x + 12, Math.max(14, y - 10));
      });
    }

    function getContainedImageFrame(stage, image) {
      if (!stage || !image) return null;
      const stageWidth = stage.clientWidth || stage.getBoundingClientRect().width || 0;
      const stageHeight = stage.clientHeight || stage.getBoundingClientRect().height || 0;
      const naturalWidth = image.naturalWidth || 0;
      const naturalHeight = image.naturalHeight || 0;
      if (!stageWidth || !stageHeight || !naturalWidth || !naturalHeight) return null;
      const ratio = Math.min(stageWidth / naturalWidth, stageHeight / naturalHeight);
      const displayWidth = naturalWidth * ratio;
      const displayHeight = naturalHeight * ratio;
      return {
        stageWidth,
        stageHeight,
        displayWidth,
        displayHeight,
        offsetX: (stageWidth - displayWidth) / 2,
        offsetY: (stageHeight - displayHeight) / 2,
      };
    }

    function clearOverlayCanvas(canvas) {
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }

    function updateOverlayVisibility() {
      [elements.modalBaselineOverlay, elements.modalCompareOverlay].forEach((canvas) => {
        if (!canvas) return;
        canvas.classList.remove("hidden");
      });
    }

    function isComparisonMode(item) {
      const baseline = state.modalBaselineImage || (payload && payload.baseline ? payload.baseline : null);
      if (!baseline || !baseline.image_src || !item) return false;
      return Number(baseline.ref_image_id) !== Number(item.ref_image_id);
    }

    function loadImage(src) {
      return new Promise((resolve, reject) => {
        if (!src) {
          reject(new Error("Missing image source"));
          return;
        }
        const image = new Image();
        image.decoding = "async";
        image.crossOrigin = "anonymous";
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("Failed to load image"));
        image.src = src;
      });
    }

    function closeModal() {
      if (!elements.modal) return;
      elements.modal.classList.add("hidden");
      document.body.classList.remove("reference-check-modal-open");
      state.modalDiffRenderId += 1;
      state.modalImages = [];
      state.modalImageIndex = 0;
      state.modalBaselineImage = null;
      state.modalReelGroups = [];
      state.modalReelIndex = -1;
      state.modalRefImageId = null;
      state.lastLoggedDebugRefImageId = null;
      clearOverlayCanvas(elements.modalBaselineOverlay);
      clearOverlayCanvas(elements.modalCompareOverlay);
    }

    function logComparisonDebug(item, comparisonMode) {
      if (!comparisonMode || !item) return;
      const refImageId = Number(item.ref_image_id);
      if (!Number.isFinite(refImageId)) return;
      if (state.lastLoggedDebugRefImageId === refImageId) return;
      state.lastLoggedDebugRefImageId = refImageId;
      const debug = item.debug_metrics || {};
      console.groupCollapsed(
        `[Reference Check Debug] ${item.reel_code || "Reference"} · ref_image_id=${refImageId}`
      );
      console.log({
        baseline_ref_image_id:
          state.modalBaselineImage && Number.isFinite(Number(state.modalBaselineImage.ref_image_id))
            ? Number(state.modalBaselineImage.ref_image_id)
            : null,
        comparison_ref_image_id: refImageId,
        reel_code: item.reel_code || null,
        captured_at: item.captured_at || null,
        content_match_pct: item.content_match_pct ?? null,
        color_match_pct: item.color_match_pct ?? null,
        alignment_match_pct: item.alignment_match_pct ?? null,
        overall_match_pct: item.overall_match_pct ?? null,
        debug_metrics: {
          gradient_ssim_pct: debug.gradient_ssim_pct ?? null,
          edge_overlap_pct: debug.edge_overlap_pct ?? null,
          normalized_gray_corr_pct: debug.normalized_gray_corr_pct ?? null,
          normalized_gray_ssim_pct: debug.normalized_gray_ssim_pct ?? null,
          masked_lab_delta: debug.masked_lab_delta ?? null,
          global_lab_delta: debug.global_lab_delta ?? null,
          lab_lightness_delta: debug.lab_lightness_delta ?? null,
          lab_chroma_similarity_pct: debug.lab_chroma_similarity_pct ?? null,
          brightness_delta_pct: debug.brightness_delta_pct ?? null,
          alignment_offset: debug.alignment_offset ?? null,
          content_inputs: debug.content_inputs ?? null,
          color_inputs: debug.color_inputs ?? null,
          rule_inputs: debug.rule_inputs ?? null,
        },
      });
      console.groupEnd();
    }

    function applyBaseline(refImageId) {
      const targetJob = currentResolvedJob || (payload && payload.resolved_job) || "";
      if (!targetJob) return;
      baselineByJob.set(targetJob, Number(refImageId));
      pendingAutoSelectedJob = targetJob;
      closeModal();
      load();
    }

    function findReference(refImageId) {
      if (!payload || !Array.isArray(payload.gallery)) return null;
      return payload.gallery.find((item) => Number(item.ref_image_id) === Number(refImageId)) || null;
    }

    function getGalleryReelGroups() {
      const gallery = payload && Array.isArray(payload.gallery) ? payload.gallery : [];
      const grouped = [];
      const byReel = new Map();
      gallery.forEach((item) => {
        const key = Number(item.reel_id) || `ref-${Number(item.ref_image_id) || Math.random()}`;
        if (!byReel.has(key)) {
          byReel.set(key, []);
          grouped.push(byReel.get(key));
        }
        byReel.get(key).push(item);
      });
      grouped.forEach((group) =>
        group.sort((a, b) => compareNumber(a.reference_index, b.reference_index) || compareNumber(a.ref_image_id, b.ref_image_id))
      );
      return grouped;
    }

    function buildThumbnail(item, className) {
      const src = item && item.image_src ? urlForStatic(item.image_src) : "";
      if (!src) {
        return `<div class="${className} reference-check-thumb reference-check-thumb--empty">No preview</div>`;
      }
      return `<img class="${className} reference-check-thumb" src="${src}" alt="${Utils.escapeHtml(item.reel_code || item.filename || "Reference")}" loading="lazy" decoding="async">`;
    }

    function renderKpi(label, value) {
      return `
        <div class="reference-check-kpi">
          <span>${Utils.escapeHtml(label)}</span>
          <strong>${Utils.escapeHtml(value)}</strong>
        </div>
      `;
    }

    function renderScoreTile(label, value) {
      return `
        <div class="reference-check-kpi reference-check-kpi--compact">
          <span>${Utils.escapeHtml(label)}</span>
          <strong>${Utils.escapeHtml(formatPercent(value))}</strong>
        </div>
      `;
    }

    function metaRow(label, value) {
      return `
        <div>
          <dt>${Utils.escapeHtml(label)}</dt>
          <dd>${Utils.escapeHtml(value)}</dd>
        </div>
      `;
    }

    function formatPercent(value) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
      return `${Utils.formatNumber(value, 1)}%`;
    }

    function formatFeet(value) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
      return `${Utils.formatNumber(value, 1)} ft`;
    }

    function formatRate(value) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
      return Utils.formatNumber(value, 2);
    }

    function formatNumberOrDash(value) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
      return Utils.formatNumber(value, 1);
    }

    function summarizeDifferenceTypes(rows) {
      const counts = new Map();
      const labels = new Map();
      (Array.isArray(rows) ? rows : []).forEach((row) => {
        const key = String(row.difference_reason_key || "unscored");
        counts.set(key, (counts.get(key) || 0) + 1);
        labels.set(key, row.likely_difference_type || "Unscored");
      });
      let bestKey = "unscored";
      let bestCount = -1;
      counts.forEach((count, key) => {
        if (count > bestCount) {
          bestKey = key;
          bestCount = count;
        }
      });
      return { key: bestKey, label: labels.get(bestKey) || "Unscored" };
    }

    return {
      init,
      activate,
      deactivate,
      onFiltersUpdated,
    };
  })();
