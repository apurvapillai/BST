  const ReferenceCheckTab = (() => {
    let initialized = false;
    let active = false;
    let requestToken = 0;
    let payload = null;
    let errorMessage = "";
    let currentResolvedJob = "";
    let pendingAutoSelectedJob = "";
    const baselineByJob = new Map();

    const state = {
      sort: "captured_at_desc",
      modalRefImageId: null,
      modalDiffRenderId: 0,
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
      elements.galleryMeta = Utils.qs("#referenceCheckGalleryMeta");
      elements.gallery = Utils.qs("#referenceCheckGallery");
      elements.baselineSection = Utils.qs("#referenceCheckBaselineSection");
      elements.baselineSummary = Utils.qs("#referenceCheckBaselineSummary");
      elements.resultsSection = Utils.qs("#referenceCheckResultsSection");
      elements.resultsBody = Utils.qs("#referenceCheckResultsBody");
      elements.sortSelect = Utils.qs("#referenceCheckSortSelect");
      elements.chart = Utils.qs("#referenceCheckTrendChart");
      elements.insightsSection = Utils.qs("#referenceCheckInsightsSection");
      elements.insights = Utils.qs("#referenceCheckInsights");
      elements.modal = Utils.qs("#referenceCheckModal");
      elements.modalClose = Utils.qs("#referenceCheckModalClose");
      elements.modalDismiss = Utils.qs("#referenceCheckModalDismiss");
      elements.modalBaseline = Utils.qs("#referenceCheckModalBaseline");
      elements.modalImage = Utils.qs("#referenceCheckModalImage");
      elements.modalCompare = Utils.qs("#referenceCheckModalCompare");
      elements.modalBaselineImage = Utils.qs("#referenceCheckModalBaselineImage");
      elements.modalCompareImage = Utils.qs("#referenceCheckModalCompareImage");
      elements.modalDiffCanvas = Utils.qs("#referenceCheckModalDiffCanvas");
      elements.modalDiffEmpty = Utils.qs("#referenceCheckModalDiffEmpty");
      elements.modalTitle = Utils.qs("#referenceCheckModalTitle");
      elements.modalSubtitle = Utils.qs("#referenceCheckModalSubtitle");
      elements.modalMeta = Utils.qs("#referenceCheckModalMeta");

      if (elements.sortSelect) {
        elements.sortSelect.addEventListener("change", () => {
          state.sort = elements.sortSelect.value || "captured_at_desc";
          renderResults();
        });
      }

      if (elements.gallery) {
        elements.gallery.addEventListener("click", handleGalleryClick);
      }

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
    }

    function activate() {
      active = true;
      load();
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
      elements.gallery.innerHTML = gallery
        .map((item) => {
          const thumbnail = buildThumbnail(item, "reference-check-card__thumb");
          const matchHtml =
            item.match_pct !== undefined && item.match_pct !== null
              ? `<div class="reference-check-card__metric">${formatPercent(item.match_pct)}</div>`
              : "";
          const statusHtml = item.status_band
            ? `<span class="reference-check-status reference-check-status--${Utils.escapeHtml(item.status_key || "unscored")}">${Utils.escapeHtml(item.status_band)}</span>`
            : "";
          const baselineHtml = item.is_baseline
            ? '<span class="reference-check-badge">Baseline</span>'
            : "";
          return `
            <article class="reference-check-card${item.is_baseline ? " is-baseline" : ""}" data-ref-image-id="${Number(item.ref_image_id) || ""}">
              <div class="reference-check-card__media">
                ${thumbnail}
              </div>
              <div class="reference-check-card__body">
                <div class="reference-check-card__title-row">
                  <div>
                    <strong>${Utils.escapeHtml(item.reel_code || item.filename || "Reference")}</strong>
                    <p>${Utils.escapeHtml(formatTime(item.captured_at, "Timestamp unavailable"))}</p>
                  </div>
                  ${baselineHtml}
                </div>
                <div class="reference-check-card__meta">
                  <span>${Utils.escapeHtml(item.machine_name || "Machine unavailable")}</span>
                  <span>${Utils.escapeHtml(item.order_number || "Order unavailable")}</span>
                </div>
                <div class="reference-check-card__footer">
                  ${matchHtml}
                  ${statusHtml}
                </div>
              </div>
            </article>
          `;
        })
        .join("");
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
      if (elements.insightsSection) {
        elements.insightsSection.classList.toggle("hidden", !hasBaseline);
      }
      if (!hasBaseline) {
        if (elements.baselineSummary) {
          elements.baselineSummary.innerHTML = `
            <div class="reference-check-empty-inline">
              Select a reference image from the gallery to set the job baseline.
            </div>
          `;
        }
        if (elements.resultsBody) {
          elements.resultsBody.innerHTML = `
            <tr>
              <td colspan="8" class="reference-check-table__empty">Choose a baseline reference image to compute comparisons.</td>
            </tr>
          `;
        }
        if (elements.insights) {
          elements.insights.innerHTML = "";
        }
        renderTrendChart([]);
        return;
      }

      renderBaselineSummary();
      const comparisons = sortComparisons(payload.comparisons || []);
      renderResultsTable(comparisons);
      renderTrendChart(comparisons);
      renderInsights();
    }

    function renderBaselineSummary() {
      if (!elements.baselineSummary || !payload || !payload.baseline) return;
      const baseline = payload.baseline;
      const summary = payload.summary || {};
      const thumb = buildThumbnail(baseline, "reference-check-baseline__image");
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
            <button type="button" class="button-secondary" data-ref-image-id="${Number(baseline.ref_image_id) || ""}" data-ref-action="preview">Open Preview</button>
          </div>
          <div class="reference-check-baseline__meta">
            <span>Machine: ${Utils.escapeHtml(baseline.machine_name || "—")}</span>
            <span>Order: ${Utils.escapeHtml(baseline.order_number || "—")}</span>
          </div>
          <div class="reference-check-kpis">
            ${renderKpi("Compared", Utils.formatNumber(summary.compared_references || 0))}
            ${renderKpi("Average Match", formatPercent(summary.average_match_pct))}
            ${renderKpi("Min Match", formatPercent(summary.min_match_pct))}
            ${renderKpi("Max Match", formatPercent(summary.max_match_pct))}
            ${renderKpi("Below Threshold", Utils.formatNumber(summary.below_threshold_count || 0))}
            ${renderKpi("Likely Change Groups", Utils.formatNumber(summary.likely_change_event_count || 0))}
          </div>
        </div>
      `;
      const previewButton = elements.baselineSummary.querySelector('[data-ref-action="preview"]');
      if (previewButton) {
        previewButton.addEventListener("click", () => openModal(Number(baseline.ref_image_id)));
      }
    }

    function renderResultsTable(comparisons) {
      if (!elements.resultsBody) return;
      if (!comparisons.length) {
        elements.resultsBody.innerHTML = `
          <tr>
            <td colspan="8" class="reference-check-table__empty">No non-baseline references were available for comparison.</td>
          </tr>
        `;
        return;
      }
      elements.resultsBody.innerHTML = comparisons
        .map((item) => {
          return `
            <tr>
              <td>${Utils.escapeHtml(item.reel_code || "—")}</td>
              <td>${Utils.escapeHtml(formatTime(item.captured_at, "—"))}</td>
              <td>
                <button type="button" class="reference-check-thumb-btn" data-ref-preview="${Number(item.ref_image_id) || ""}">
                  ${buildThumbnail(item, "reference-check-thumb-btn__image")}
                </button>
              </td>
              <td>${formatPercent(item.match_pct)}</td>
              <td><span class="reference-check-status reference-check-status--${Utils.escapeHtml(item.status_key || "unscored")}">${Utils.escapeHtml(item.status_band || "Not compared")}</span></td>
              <td>${item.likely_changed ? `<span class="reference-check-flag">Group ${Utils.formatNumber(item.change_group || 0)}</span>` : '<span class="reference-check-muted">Stable</span>'}</td>
              <td>${Utils.formatNumber(item.defect_count || 0)}</td>
              <td>${Utils.escapeHtml(item.top_defect_type || "—")}</td>
            </tr>
          `;
        })
        .join("");
    }

    function renderTrendChart(comparisons) {
      if (!elements.chart) return;
      if (!comparisons.length || !window.Plotly) {
        elements.chart.innerHTML = '<div class="reference-check-empty-inline">Select a baseline to plot the reference trend.</div>';
        return;
      }
      const x = comparisons.map((item) => formatTime(item.captured_at, item.reel_code || "Reference"));
      const y = comparisons.map((item) => item.match_pct);
      const markerColors = comparisons.map((item) => {
        if (item.likely_changed) return "#dc2626";
        if ((item.match_pct || 0) >= 95) return "#059669";
        if ((item.match_pct || 0) >= 90) return "#0284c7";
        return "#d97706";
      });
      const layout = typeof withResponsiveLayout === "function"
        ? withResponsiveLayout({
            margin: { l: 44, r: 18, t: 16, b: 64 },
            xaxis: { title: "Reference sequence", tickangle: -30 },
            yaxis: { title: "Match %", range: [0, 100] },
          })
        : {
            margin: { l: 44, r: 18, t: 16, b: 64 },
            xaxis: { title: "Reference sequence", tickangle: -30 },
            yaxis: { title: "Match %", range: [0, 100] },
          };
      const config = typeof plotlyConfig === "function"
        ? plotlyConfig({ displayModeBar: false })
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
            customdata: comparisons.map((item) => [item.reel_code || "—", item.status_band || "—"]),
            hovertemplate:
              "<b>%{customdata[0]}</b><br>Match: %{y:.1f}%<br>Status: %{customdata[1]}<extra></extra>",
          },
        ],
        layout,
        config
      );
    }

    function renderInsights() {
      if (!elements.insights || !payload) return;
      const insights = payload.insights || {};
      const firstChange = insights.first_major_change_point;
      const lowestRows = Array.isArray(insights.lowest_match_references) ? insights.lowest_match_references : [];
      const stable = insights.stable_streaks || {};
      const unstablePeriods = Array.isArray(insights.unstable_periods) ? insights.unstable_periods : [];
      const defectAssociation = insights.defect_association || {};
      const clusterSummary = insights.cluster_summary || {};
      const clusters = Array.isArray(clusterSummary.clusters) ? clusterSummary.clusters : [];
      const dominantCluster = clusterSummary.dominant_cluster || null;
      const changeWindows = Array.isArray(insights.change_windows) ? insights.change_windows : [];
      const largestDrop = insights.largest_match_drop || null;

      const lowestMarkup = lowestRows.length
        ? lowestRows
            .map(
              (row) =>
                `<li>${Utils.escapeHtml(row.reel_code || "Reference")} · ${formatPercent(row.match_pct)} · ${Utils.escapeHtml(formatTime(row.captured_at, "—"))}</li>`
            )
            .join("")
        : "<li>No low-match references identified yet.</li>";

      const unstableMarkup = unstablePeriods.length
        ? unstablePeriods
            .map(
              (period) =>
                `<li>${Utils.escapeHtml(period.start_reel_code || "Reference")} · ${Utils.escapeHtml(formatTime(period.start_timestamp, "—"))} · ${Utils.formatNumber(period.count || 0)} refs</li>`
            )
            .join("")
        : "<li>No unstable periods crossed the likely-change threshold.</li>";

      const clusterMarkup = clusters.length
        ? clusters
            .map(
              (cluster) =>
                `<li>${Utils.escapeHtml(cluster.label || "Cluster")} · ${Utils.formatNumber(cluster.count || 0)} refs</li>`
            )
            .join("")
        : "<li>No cluster data available.</li>";

      const changeWindowMarkup = changeWindows.length
        ? changeWindows
            .slice(0, 4)
            .map(
              (window) =>
                `<li>Window ${Utils.formatNumber(window.window_id || 0)} · ${Utils.escapeHtml(window.start_reel_code || "—")} to ${Utils.escapeHtml(window.end_reel_code || "—")} · avg ${formatPercent(window.avg_match_pct)}</li>`
            )
            .join("")
        : "<li>No sustained low-match windows detected.</li>";

      elements.insights.innerHTML = `
        <article class="reference-check-insight-card">
          <h4>First Likely Major Change</h4>
          <p>${firstChange ? `${Utils.escapeHtml(firstChange.reel_code || "Reference")} at ${Utils.escapeHtml(formatTime(firstChange.captured_at, "—"))}` : "No major change point detected."}</p>
        </article>
        <article class="reference-check-insight-card">
          <h4>Similarity Clusters</h4>
          <p>${dominantCluster ? `Dominant cluster: ${Utils.escapeHtml(dominantCluster.label || "—")} (${Utils.formatNumber(dominantCluster.count || 0)} refs)` : "No dominant cluster yet."}</p>
          <ul class="reference-check-insight-list">${clusterMarkup}</ul>
        </article>
        <article class="reference-check-insight-card">
          <h4>Lowest-Match References</h4>
          <ul class="reference-check-insight-list">${lowestMarkup}</ul>
        </article>
        <article class="reference-check-insight-card">
          <h4>Stable vs Unstable</h4>
          <p>Longest strong-match streak: <strong>${Utils.formatNumber(stable.longest_strong_match_streak || 0)}</strong></p>
          <ul class="reference-check-insight-list">${unstableMarkup}</ul>
        </article>
        <article class="reference-check-insight-card">
          <h4>Change Windows</h4>
          <p>${largestDrop ? `Largest match drop: ${Utils.escapeHtml(largestDrop.from_reel_code || "—")} to ${Utils.escapeHtml(largestDrop.to_reel_code || "—")} (${formatPercent(largestDrop.delta_match_pct)})` : "No major drop between adjacent references."}</p>
          <ul class="reference-check-insight-list">${changeWindowMarkup}</ul>
        </article>
        <article class="reference-check-insight-card">
          <h4>Defect Association</h4>
          <p>${Utils.escapeHtml(defectAssociation.interpretation || "No association data available.")}</p>
          <div class="reference-check-insight-metrics">
            <span>Low-match avg defects: ${formatNumberOrDash(defectAssociation.avg_defects_low_match)}</span>
            <span>Strong-match avg defects: ${formatNumberOrDash(defectAssociation.avg_defects_strong_match)}</span>
          </div>
        </article>
      `;
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

    function handleGalleryClick(event) {
      const card = event.target.closest("[data-ref-image-id]");
      if (!card) return;
      const refImageId = Number(card.dataset.refImageId);
      if (!Number.isFinite(refImageId)) return;
      openModal(refImageId);
    }

    function handleResultsClick(event) {
      const previewButton = event.target.closest("[data-ref-preview]");
      if (!previewButton) return;
      const refImageId = Number(previewButton.dataset.refPreview);
      if (!Number.isFinite(refImageId)) return;
      openModal(refImageId);
    }

    function openModal(refImageId) {
      const item = findReference(refImageId);
      if (!item || !elements.modal) return;
      state.modalRefImageId = refImageId;
      if (elements.modalTitle) {
        elements.modalTitle.textContent = item.reel_code || item.filename || "Reference Preview";
      }
      if (elements.modalSubtitle) {
        elements.modalSubtitle.textContent = formatTime(item.captured_at, "Timestamp unavailable");
      }
      if (elements.modalImage) {
        const src = item.image_src ? urlForStatic(item.image_src) : "";
        elements.modalImage.src = src;
        elements.modalImage.alt = item.reel_code || item.filename || "Reference preview";
      }
      renderModalComparison(item);
      if (elements.modalMeta) {
        elements.modalMeta.innerHTML = [
          metaRow("Job", item.job_name || "—"),
          metaRow("Order", item.order_number || "—"),
          metaRow("Machine", item.machine_name || "—"),
          metaRow("Match", formatPercent(item.match_pct)),
          metaRow("Status", item.status_band || "Not compared"),
          metaRow("Defects", Utils.formatNumber(item.defect_count || 0)),
          metaRow("Top Defect", item.top_defect_type || "—"),
        ].join("");
      }
      if (elements.modalBaseline) {
        elements.modalBaseline.disabled = Boolean(item.is_baseline);
        elements.modalBaseline.textContent = item.is_baseline ? "Active Baseline" : "Set as Baseline";
      }
      elements.modal.classList.remove("hidden");
    }

    function renderModalComparison(item) {
      const baseline = payload && payload.baseline ? payload.baseline : null;
      if (!elements.modalCompare || !elements.modalBaselineImage || !elements.modalCompareImage) return;
      if (!baseline || !baseline.image_src || !item.image_src || Number(baseline.ref_image_id) === Number(item.ref_image_id)) {
        elements.modalCompare.classList.add("hidden");
        if (elements.modalDiffEmpty) {
          elements.modalDiffEmpty.classList.add("hidden");
        }
        return;
      }
      elements.modalCompare.classList.remove("hidden");
      const baselineSrc = urlForStatic(baseline.image_src);
      const compareSrc = urlForStatic(item.image_src);
      elements.modalBaselineImage.src = baselineSrc;
      elements.modalBaselineImage.alt = baseline.reel_code || "Baseline preview";
      elements.modalCompareImage.src = compareSrc;
      elements.modalCompareImage.alt = item.reel_code || "Selected preview";
      drawDiffHeatmap(baselineSrc, compareSrc);
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
        const workCtx = workCanvas.getContext("2d");
        if (!workCtx) {
          showDiffHeatmapUnavailable();
          return;
        }
        const baselineData = sampleImageToData(workCtx, baselineImage, size);
        const comparisonData = sampleImageToData(workCtx, comparisonImage, size);
        if (!baselineData || !comparisonData) {
          showDiffHeatmapUnavailable();
          return;
        }
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
        for (let i = 0; i < baselineData.length; i += 4) {
          const baseGray = normalizeGray(baselineData[i], baselineData[i + 1], baselineData[i + 2]);
          const compGray = normalizeGray(comparisonData[i], comparisonData[i + 1], comparisonData[i + 2]);
          const diff = Math.min(255, Math.abs(baseGray - compGray) * 3.2);
          imageData.data[i] = diff;
          imageData.data[i + 1] = Math.max(0, 210 - diff * 0.45);
          imageData.data[i + 2] = Math.max(0, 120 - diff * 0.7);
          imageData.data[i + 3] = 255;
        }
        ctx.putImageData(imageData, 0, 0);
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
      return ctx.getImageData(0, 0, size, size).data;
    }

    function normalizeGray(r, g, b) {
      return Math.round(r * 0.299 + g * 0.587 + b * 0.114);
    }

    function showDiffHeatmapUnavailable() {
      if (elements.modalDiffEmpty) {
        elements.modalDiffEmpty.classList.remove("hidden");
      }
      if (elements.modalDiffCanvas) {
        const ctx = elements.modalDiffCanvas.getContext("2d");
        if (ctx) {
          ctx.clearRect(0, 0, elements.modalDiffCanvas.width, elements.modalDiffCanvas.height);
        }
      }
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
      state.modalDiffRenderId += 1;
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

    function formatNumberOrDash(value) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
      return Utils.formatNumber(value, 1);
    }

    return {
      init,
      activate,
      deactivate,
      onFiltersUpdated,
    };
  })();
