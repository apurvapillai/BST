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
      modalOverlaysVisible: true,
      modalImages: [],
      modalImageIndex: 0,
      modalBaselineImage: null,
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
      elements.resultsTableSection = Utils.qs("#referenceCheckResultsTableSection");
      elements.resultsHead = Utils.qs("#referenceCheckResultsHead");
      elements.resultsBody = Utils.qs("#referenceCheckResultsBody");
      elements.chart = Utils.qs("#referenceCheckTrendChart");
      elements.insightsSection = Utils.qs("#referenceCheckInsightsSection");
      elements.insights = Utils.qs("#referenceCheckInsights");
      elements.modal = Utils.qs("#referenceCheckModal");
      elements.modalClose = Utils.qs("#referenceCheckModalClose");
      elements.modalDismiss = Utils.qs("#referenceCheckModalDismiss");
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
      elements.modalOverlayToggle = Utils.qs("#referenceCheckModalOverlayToggle");
      elements.modalPrev = Utils.qs("#referenceCheckModalPrev");
      elements.modalNext = Utils.qs("#referenceCheckModalNext");
      elements.modalImageCounter = Utils.qs("#referenceCheckModalImageCounter");
      elements.modalTitle = Utils.qs("#referenceCheckModalTitle");
      elements.modalSubtitle = Utils.qs("#referenceCheckModalSubtitle");
      elements.modalMeta = Utils.qs("#referenceCheckModalMeta");

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
      if (elements.modalOverlayToggle) {
        elements.modalOverlayToggle.addEventListener("click", () => {
          state.modalOverlaysVisible = !state.modalOverlaysVisible;
          updateOverlayVisibility();
        });
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
      if (elements.resultsTableSection) {
        elements.resultsTableSection.classList.toggle("hidden", !hasBaseline);
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
        if (elements.insights) {
          elements.insights.innerHTML = "";
        }
        renderTrendChart([]);
        return;
      }

      renderBaselineSummary();
      const comparisons = sortComparisons(payload.comparisons || []);
      const trendPoints = sortTrendPoints(payload.trend || []);
      renderResultsTable(payload.reel_comparisons || [], payload.defect_types || []);
      renderTrendChart(trendPoints);
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
            <th>Match %</th>
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
            <td colspan="${9 + defectColumns.length}" class="reference-check-table__empty">No non-baseline references were available for comparison.</td>
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
              <td>${formatPercent(item.match_pct)}</td>
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
      openModal(refImageId);
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
      renderModalComparison(item);
      if (elements.modalMeta) {
        elements.modalMeta.innerHTML = [
          metaRow("Job", item.job_name || "—"),
          metaRow("Reel", item.reel_code || "—"),
          metaRow("Timestamp", formatTime(item.captured_at, "—")),
          metaRow("Machine", item.machine_name || "—"),
          metaRow("Match", formatPercent(item.match_pct)),
        ].join("");
      }
      if (elements.modalBaseline) {
        elements.modalBaseline.disabled = Boolean(item.is_baseline);
        elements.modalBaseline.textContent = item.is_baseline ? "Active Baseline" : "Set as Baseline";
      }
      if (elements.modalPrev) {
        const hideNav = state.modalImages.length <= 1 || !comparisonMode;
        elements.modalPrev.disabled = hideNav;
        elements.modalPrev.classList.toggle("hidden", hideNav);
      }
      if (elements.modalNext) {
        const hideNav = state.modalImages.length <= 1 || !comparisonMode;
        elements.modalNext.disabled = hideNav;
        elements.modalNext.classList.toggle("hidden", hideNav);
      }
      if (elements.modalImageCounter) {
        elements.modalImageCounter.textContent =
          comparisonMode && state.modalImages.length > 1 ? `${state.modalImageIndex + 1} of ${state.modalImages.length}` : "";
      }
    }

    function cycleModalImage(direction) {
      if (!state.modalImages.length) return;
      const total = state.modalImages.length;
      state.modalImageIndex = (state.modalImageIndex + direction + total) % total;
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
        const workCtx = workCanvas.getContext("2d");
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
      const rect = image.getBoundingClientRect();
      const displayWidth = image.clientWidth || rect.width || image.naturalWidth || 1;
      const displayHeight = image.clientHeight || rect.height || image.naturalHeight || 1;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(displayWidth * dpr);
      canvas.height = Math.round(displayHeight * dpr);
      canvas.style.width = `${displayWidth}px`;
      canvas.style.height = `${displayHeight}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, displayWidth, displayHeight);
      const scaleX = displayWidth / drawBox.width;
      const scaleY = displayHeight / drawBox.height;
      regions.forEach((region, index) => {
        const x = (region.x - drawBox.x) * scaleX;
        const y = (region.y - drawBox.y) * scaleY;
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

    function clearOverlayCanvas(canvas) {
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }

    function updateOverlayVisibility() {
      const visible = state.modalOverlaysVisible;
      [elements.modalBaselineOverlay, elements.modalCompareOverlay].forEach((canvas) => {
        if (!canvas) return;
        canvas.classList.toggle("hidden", !visible);
      });
      if (elements.modalOverlayToggle) {
        elements.modalOverlayToggle.textContent = visible ? "Hide Highlights" : "Show Highlights";
      }
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
      state.modalRefImageId = null;
      clearOverlayCanvas(elements.modalBaselineOverlay);
      clearOverlayCanvas(elements.modalCompareOverlay);
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

    return {
      init,
      activate,
      deactivate,
      onFiltersUpdated,
    };
  })();
