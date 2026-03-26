  const QcReviewTab = (() => {
    const FIELD_KEYS = [
      "defect_id",
      "machine_name",
      "reel_code",
      "job_name",
      "order_number",
      "class_name",
      "phase",
      "format_position",
      "magnitude_value",
      "severity_value",
    ];
    const REFERENCE_CANVAS_PADDING = 32;
    const IMAGE_ROTATION_STORAGE_KEY = "qcReviewImageRotation";
    const REFERENCE_MIRROR_STORAGE_KEY = "qcReferenceMirror";
    const REFERENCE_ZOOM_MIN = 0.5;
    const REFERENCE_ZOOM_MAX = 8;
    const REFERENCE_ZOOM_DEFAULT = 1;
    const REFERENCE_FOCUS_PADDING = 1.4;
    const REFERENCE_FOCUS_DURATION = 2000;
    const REFERENCE_INTERACTION_HINT = "Use Focus to zoom to the defect. Click Reset to return to 100%.";
    const POSITION_TIMELINE_MIN_WIDTH = 320;
    const POSITION_TIMELINE_HEIGHT = 44;
    let panel;
    let loadingEl;
    let emptyEl;
    let errorEl;
    let errorTextEl;
    let contentEl;
    let imageEl;
    let imagePlaceholderEl;
    let rotateImageBtn;
    let imagePendingCounterEl;
    let imagePendingValueEl;
    let labelEl;
    let timeEl;
    let headerJobEl;
    let headerReelEl;
    let headerTimeEl;
    let headerMachineEl;
    let stageEl;
    let summaryEl;
    let summaryNoticeEl;
    let summaryHistoryEl;
    let summaryTableBody;
    let summaryByTypeEl;
    let summaryCountTotalEl;
    let summaryCountPassEl;
    let summaryCountFailEl;
    let summaryCountPendingEl;
    let summaryCountNoImageEl;
    let noImageNoteEl;
    let noReelNoticeEl;
    let noReelNoticeTextEl;
    let nextReelBtn;
    let jobsToggleBtn;
    let jobsTableWrapper;
    let severityButtons = [];
    let severityValue = null;
    let confidenceButtons = [];
    let confidenceValue = null;
    let uncertainToggle;
    let retryBtn;
    let defectActionsEl;
    let reelActionsEl;
    let reelPassBtn;
    let reelFailBtn;
    let reviewerInput;
    let commentsInput;
    let referenceMirror = loadStoredReferenceMirror();
    let referenceZoom = REFERENCE_ZOOM_DEFAULT;
    const fieldEls = {};
    const COMPLETION_FIELDS = ["job_name", "order_number", "reel_code"];
    let initialized = false;
    let loading = false;
    let saving = false;
    let savingReel = false;
    let needsRefresh = true;
    let currentDefect = null;
    let currentReel = null;
    let summaryData = null;
    let lastNoReelAlert = "";
    let filtersListenerAttached = false;
    let lastReviewEl;
    let lastReviewStatusEl;
    const lastReviewFields = {};
    let defectCategorySelect;
    let categoryButtons = [];
    let jobsTableBody;
    let imageRotation = loadStoredRotation();
    let jobSwitchModal;
    let jobSwitchModalMessage;
    let jobSwitchModalConfirm;
    let jobSwitchModalCancel;
    let pendingJobSwitchTarget = null;
    let jobOverviewCache = [];
    let lastJobAlerted = "";
    let shouldRefreshJobOverview = true;
    let jobOverviewRequestId = 0;
    let jobOverviewLoading = false;
    let reviewSummaryToggleBtn;
    let reviewSummaryWrapper;
    let reviewSummaryHistoryTableBody;
    let reviewSummaryHistoryImagesEl;
    let reviewSummaryHistoryReelsEl;
    let reviewSummaryHistoryReviewersEl;
    let historyWindowControls;
    let historyWindowButtons = [];
    let historySummaryData = null;
    let historyActiveWindow = "all";
    let reviewSummaryHistoryLoading = false;
    let reviewSummaryHistoryRequestId = 0;
    let shouldRefreshReviewSummaryHistory = true;
    let lastFilterSnapshot = { start: "", end: "", machine_id: "", job: "" };
    let referencePanelEl;
    let referenceCanvasEl;
    let referencePlaceholderEl;
    let referenceStageEl;
    let referenceStatusEl;
    let referenceInnerEl;
    let referenceMirrorBtn;
    let referenceZoomDisplayEl;
    let referenceFocusBtn;
    let referenceResetBtn;
    let referenceRenderToken = 0;
    let referencePanX = 0;
    let referencePanY = 0;
    let referenceFootprintBounds = null;
    let referenceTransformAnimation = null;
    let positionTrackEl;
    let positionTrackMetaEl;
    let positionTrackStartEl;
    let positionTrackEndEl;
    let positionTrackSquaresEl;
    let positionTrackSegments = [];
    let positionTrackHoverIndex = null;

    function ensureReelChip(reel) {
      if (
        !reel ||
        !Filters ||
        typeof Filters.addReel !== "function"
      ) {
        return;
      }
      const hasSelection =
        typeof Filters.hasReelSelection === "function" &&
        Filters.hasReelSelection(reel.reel_id, reel.reel_code || "");
      if (hasSelection) return;
      const builder = typeof window !== "undefined" && typeof window.buildReelMetadata === "function"
        ? window.buildReelMetadata
        : null;
      const derived = builder
        ? builder({
            reel_code: reel.reel_code || "",
            order_number: reel.order_number || "",
            time: reel.time || reel.time_end || reel.time_start || reel.timestamp || "",
          })
        : null;
      const buildLabel = () => {
        if (derived && derived.label) return derived.label;
        if (typeof formatReelLabel === "function") {
          return formatReelLabel({
            code: reel.reel_code || "",
            order: reel.order_number || "",
            time: reel.time || reel.time_end || reel.time_start || reel.timestamp || "",
          });
        }
        return reel.reel_code || `Reel ${reel.reel_id || ""}`;
      };
      const label = buildLabel();
      Filters.addReel(reel.reel_code || "", reel.reel_id, {
        code: (derived && derived.code) || reel.reel_code || "",
        order: (derived && derived.order) || reel.order_number || "",
        time: (derived && derived.time) || reel.time || reel.time_end || reel.time_start || reel.timestamp || "",
        label,
      });
    }

    function init() {
      if (initialized) return;
      panel = Utils.qs("#qcReviewPanel");
      if (!panel) return;
      loadingEl = Utils.qs("#qcReviewLoading");
      emptyEl = Utils.qs("#qcReviewEmpty");
      errorEl = Utils.qs("#qcReviewError");
      errorTextEl = errorEl ? errorEl.querySelector("p") : null;
      contentEl = Utils.qs("#qcReviewContent");
      imageEl = Utils.qs("#qcReviewImage");
      imagePlaceholderEl = Utils.qs("#qcReviewImagePlaceholder");
      rotateImageBtn = Utils.qs("#qcImageRotateBtn");
      imagePendingCounterEl = Utils.qs("#qcImagePendingCounter");
      imagePendingValueEl = Utils.qs("#qcImagePendingValue");
      labelEl = Utils.qs("#qcReviewLabel");
      timeEl = Utils.qs("#qcReviewTime");
      headerJobEl = Utils.qs("#qcReviewJob");
      headerReelEl = Utils.qs("#qcReviewReel");
      headerTimeEl = Utils.qs("#qcReviewDefectTime");
      headerMachineEl = Utils.qs("#qcReviewMachine");
      stageEl = Utils.qs("#qcReviewStage");
      summaryEl = Utils.qs("#qcReviewSummary");
      summaryNoticeEl = Utils.qs("#qcSummaryNotice");
      summaryHistoryEl = Utils.qs("#qcReelReviewStatus");
      summaryTableBody = Utils.qs("#qcSummaryTableBody");
      summaryByTypeEl = Utils.qs("#qcSummaryByType");
      summaryCountTotalEl = Utils.qs("#qcSummaryTotal");
      summaryCountPassEl = Utils.qs("#qcSummaryPass");
      summaryCountFailEl = Utils.qs("#qcSummaryFail");
      summaryCountPendingEl = Utils.qs("#qcSummaryPending");
      summaryCountNoImageEl = Utils.qs("#qcSummaryNoImage");
      noImageNoteEl = Utils.qs("#qcNoImageNote");
      noReelNoticeEl = Utils.qs("#qcNoReelNotice");
      noReelNoticeTextEl = Utils.qs("#qcNoReelNoticeText");
      nextReelBtn = Utils.qs("#qcReviewNextReel");
      jobsTableBody = Utils.qs("#qcJobsTableBody");
      jobsToggleBtn = Utils.qs("#qcJobsToggleBtn");
      jobsTableWrapper = Utils.qs("#qcJobsTableWrapper");
      reviewSummaryToggleBtn = Utils.qs("#qcReviewSummaryToggleBtn");
      reviewSummaryWrapper = Utils.qs("#qcReviewSummaryWrapper");
      reviewSummaryHistoryTableBody = Utils.qs("#qcReviewSummaryHistoryTableBody");
      reviewSummaryHistoryImagesEl = Utils.qs("#qcSummaryHistoryImagesReviewed");
      reviewSummaryHistoryReelsEl = Utils.qs("#qcSummaryHistoryReelsReviewed");
      reviewSummaryHistoryReviewersEl = Utils.qs("#qcSummaryHistoryReviewers");
      historyWindowControls = Utils.qs("#qcHistoryWindowControls");
      jobSwitchModal = Utils.qs("#jobSwitchModal");
      jobSwitchModalMessage = Utils.qs("#jobSwitchModalMessage");
      jobSwitchModalConfirm = Utils.qs("#jobSwitchModalConfirm");
      jobSwitchModalCancel = Utils.qs("#jobSwitchModalCancel");
      defectActionsEl = Utils.qs("#qcDefectActions");
      reelActionsEl = Utils.qs("#qcReelActions");
      reelPassBtn = Utils.qs("#qcReelPass");
      reelFailBtn = Utils.qs("#qcReelFail");
      reviewerInput = Utils.qs("#qcReelReviewer");
      commentsInput = Utils.qs("#qcReelComments");
      severityButtons = Array.from(document.querySelectorAll("#qcSeverityScale [data-severity-value]"));
      confidenceButtons = Array.from(document.querySelectorAll("#qcConfidenceOptions [data-confidence-value]"));
      uncertainToggle = Utils.qs("#qcUncertainToggle");
      retryBtn = Utils.qs("[data-qc-review-retry]");
      defectCategorySelect = Utils.qs("#qcDefectCategory");
      referencePanelEl = Utils.qs("#qcReferencePanel");
      referenceCanvasEl = Utils.qs("#qcReferenceCanvas");
      referencePlaceholderEl = Utils.qs("#qcReferencePlaceholder");
      referenceStageEl = Utils.qs("#qcReferenceStage");
      referenceStatusEl = Utils.qs("#qcReferenceStatus");
      referenceInnerEl = Utils.qs("#qcReferenceStageInner");
      referenceMirrorBtn = Utils.qs("#qcReferenceMirrorBtn");
      referenceZoomDisplayEl = Utils.qs("#qcReferenceZoomDisplay");
      referenceFocusBtn = Utils.qs("#qcReferenceFocusBtn");
      referenceResetBtn = Utils.qs("#qcReferenceResetBtn");
      if (referenceMirrorBtn) {
        referenceMirrorBtn.addEventListener("click", () => {
          referenceMirror = !referenceMirror;
          persistReferenceMirror(referenceMirror);
          updateReferenceControls();
          applyReferenceTransform();
        });
      }
      if (referenceResetBtn) {
        referenceResetBtn.addEventListener("click", () => handleReferenceReset());
      }
      if (referenceFocusBtn) {
        referenceFocusBtn.addEventListener("click", () => focusReferenceOnFootprint());
      }
      positionTrackEl = Utils.qs("#qcPositionTrack");
      positionTrackMetaEl = Utils.qs("#qcPositionTrackMeta");
      positionTrackStartEl = Utils.qs("#qcPositionTrackStart");
      positionTrackEndEl = Utils.qs("#qcPositionTrackEnd");
      positionTrackSquaresEl = Utils.qs("#qcPositionTrackSquares");
      if (positionTrackSquaresEl) {
        positionTrackSquaresEl.addEventListener("click", handlePositionTrackClick);
        positionTrackSquaresEl.addEventListener("mousemove", handlePositionTrackHover);
        positionTrackSquaresEl.addEventListener("mouseleave", clearPositionTrackHover);
      }
      updateReferenceControls();
      applyReferenceTransform();
      syncReferenceFocusButton();
      setReferenceResetVisible(false);
      const initialFilters = Filters && typeof Filters.getState === "function" ? Filters.getState() : {};
      lastFilterSnapshot = {
        start: (initialFilters.start || ""),
        end: (initialFilters.end || ""),
        machine_id: (initialFilters.machine_id || ""),
        job: (initialFilters.job || ""),
      };
      categoryButtons = Array.from(document.querySelectorAll("#qcCategoryOptions [data-category-value]"));
      FIELD_KEYS.forEach((key) => {
        fieldEls[key] = Utils.qs(`[data-qc-field='${key}']`);
      });
      if (retryBtn) {
        retryBtn.addEventListener("click", () => fetchNext(true));
      }
      if (severityButtons.length) {
        severityButtons.forEach((button) => {
          button.addEventListener("click", () => {
            if (button.disabled) return;
            const value = Number(button.dataset.severityValue);
            setSeverityValue(Number.isFinite(value) ? value : null);
          });
        });
      }
      if (confidenceButtons.length) {
        confidenceButtons.forEach((button) => {
          button.addEventListener("click", async () => {
            if (button.disabled) return;
            const value = Number(button.dataset.confidenceValue);
            setConfidenceValue(Number.isFinite(value) ? value : null);
            await handleSeveritySave();
          });
        });
      }
      if (uncertainToggle) {
        uncertainToggle.addEventListener("change", async () => {
          if (uncertainToggle.checked) {
            setSeverityValue(null);
            setConfidenceValue(null);
            await handleSeveritySave();
          } else {
            syncSeverityControlState();
          }
        });
      }
      if (reelPassBtn) {
        reelPassBtn.addEventListener("click", () => handleReelDecision("pass"));
      }
      if (reelFailBtn) {
        reelFailBtn.addEventListener("click", () => handleReelDecision("fail"));
      }
      if (reviewerInput) {
        reviewerInput.addEventListener("input", syncReelActionState);
      }
      if (rotateImageBtn) {
        rotateImageBtn.disabled = true;
        rotateImageBtn.addEventListener("click", () => {
          if (rotateImageBtn.disabled) return;
          imageRotation = normalizeRotation(imageRotation + 90);
          persistImageRotation(imageRotation);
          applyImageRotation();
        });
      }
      if (jobSwitchModalConfirm) {
        jobSwitchModalConfirm.addEventListener("click", () => {
          const target = pendingJobSwitchTarget;
          hideJobSwitchModal();
          if (target) {
            Filters.set("job", target, { emit: true, updateUrl: true });
          }
        });
      }
      if (jobSwitchModalCancel) {
        jobSwitchModalCancel.addEventListener("click", hideJobSwitchModal);
      }
      if (categoryButtons.length) {
        categoryButtons.forEach((button) => {
          button.addEventListener("click", () => {
            if (button.disabled) return;
            const value = button.dataset.categoryValue || "";
            setDefectCategoryValue(value);
          });
        });
      }
      if (historyWindowControls) {
        historyWindowButtons = Array.from(historyWindowControls.querySelectorAll("[data-history-window]"));
        historyWindowButtons.forEach((button) => {
          button.addEventListener("click", () => {
            const windowKey = button.dataset.historyWindow || "all";
            setHistoryWindow(windowKey);
          });
        });
      }
      if (reviewSummaryToggleBtn && reviewSummaryWrapper) {
        reviewSummaryToggleBtn.addEventListener("click", () => {
          const isExpanded = reviewSummaryToggleBtn.getAttribute("aria-expanded") === "true";
          reviewSummaryToggleBtn.setAttribute("aria-expanded", String(!isExpanded));
          reviewSummaryToggleBtn.textContent = !isExpanded ? "Hide" : "Show";
          reviewSummaryWrapper.classList.toggle("hidden", isExpanded);
        });
      }
      if (jobsToggleBtn && jobsTableWrapper) {
        jobsToggleBtn.addEventListener("click", () => {
          const isExpanded = jobsToggleBtn.getAttribute("aria-expanded") === "true";
          jobsToggleBtn.setAttribute("aria-expanded", String(!isExpanded));
          jobsToggleBtn.textContent = !isExpanded ? "Hide" : "Show";
          jobsTableWrapper.classList.toggle("hidden", isExpanded);
        });
      }
      if (defectCategorySelect) {
        defectCategorySelect.addEventListener("change", () => {
          if (currentDefect) {
            currentDefect.defect_category = getDefectCategoryValue();
          }
        });
      }
      if (!filtersListenerAttached && Filters && typeof Filters.onChange === "function") {
        Filters.onChange(() => {
          const nextState = Filters && typeof Filters.getState === "function" ? Filters.getState() : {};
          const nextSnapshot = {
            start: nextState.start || "",
            end: nextState.end || "",
            machine_id: nextState.machine_id || "",
            job: nextState.job || "",
          };
          if (nextSnapshot.job !== lastFilterSnapshot.job) {
            lastJobAlerted = "";
          }
          lastFilterSnapshot = nextSnapshot;
          needsRefresh = true;
          shouldRefreshJobOverview = true;
          if (!isQcReviewActive()) {
            return;
          }
          fetchNext(true, { suppressLoader: true }).catch(() => {});
          fetchJobOverview(true).catch(() => {});
        });
        filtersListenerAttached = true;
      }
      if (nextReelBtn) {
        nextReelBtn.addEventListener("click", () => {
          hideNoReelNotice();
          fetchNext(true);
        });
      }
      initialized = true;
      setDefectCategoryValue("");
      resetSeverityControls();
    }

    function updateHeaderInfo(reel, defect) {
      const jobParts = [];
      if (reel && reel.job_name) jobParts.push(reel.job_name);
      if (reel && reel.order_number) jobParts.push(reel.order_number);
      if (headerJobEl) headerJobEl.textContent = jobParts.length ? jobParts.join(" · ") : "Job not selected";
      if (headerReelEl) {
        const reelLabel = reel && reel.reel_code ? `Reel ${reel.reel_code}` : reel && reel.reel_id ? `Reel #${reel.reel_id}` : "Reel";
        const machine = reel && reel.machine_name ? ` · ${reel.machine_name}` : "";
        headerReelEl.textContent = `${reelLabel}${machine}`;
      }
      const timeSource = defect && defect.defect_time ? defect.defect_time : reel && (reel.time_end || reel.time_start);
      if (headerTimeEl) headerTimeEl.textContent = formatTime(timeSource);
      if (headerMachineEl) headerMachineEl.textContent = (reel && reel.machine_name) || "—";
    }

    async function fetchNext(force = false, options = {}) {
      const { lockToReel = false, suppressLoader = false, focusDefectId = null, forceReelId = null } = options;
      if (!panel || loading) return;
      hideNoReelNotice();
      loading = true;
      setSeverityControlsDisabled(true);
      setReelActionsDisabled(true);
      if (!suppressLoader || force) {
        setViewState(force ? "loading" : "content");
      }
      try {
        const params = {};
        if (focusDefectId) {
          params.focus_defect_id = focusDefectId;
        }
        const reelTarget =
          forceReelId || (lockToReel && currentReel && currentReel.reel_id ? currentReel.reel_id : null);
        if (reelTarget) {
          params.focus_reel_id = reelTarget;
        }
        const data = await Api.get("qc-review", params);
        applyPayload(data || {});
        needsRefresh = false;
      } catch (error) {
        const message = error && error.message ? error.message : "Failed to load pending defects.";
        showErrorState(message);
      } finally {
        loading = false;
        if (!currentDefect) {
          setSeverityControlsDisabled(true);
        }
        syncReelActionState();
      }
    }

    function applyPayload(payload) {
      currentReel = payload.reel || null;
      currentDefect = payload.next_defect || null;
      summaryData = payload.reel_summary || null;
      const hasPending = Boolean(payload && payload.has_pending);
      if (currentReel) {
        ensureReelChip(currentReel);
      }
      updateImagePendingCounter(summaryData);
      renderPositionTrack(currentReel, summaryData);
      if (!currentDefect) {
        setDefectCategoryValue("");
        resetSeverityControls();
        resetReferencePreview("No pending defect selected.");
      }
      if (!currentReel) {
        setViewState("empty");
        syncCompletionHighlights(false);
        updateImagePendingCounter(null);
        if (hasPending) {
          showNoReelNotice("This reel has no pending defects. Click Next Reel to continue.", true);
          if (lastNoReelAlert !== "pending") {
            window.alert("This reel has no defects. Click the Next Reel button to continue.");
            lastNoReelAlert = "pending";
          }
        } else {
          showNoReelNotice("No reels require review right now.", false);
          lastNoReelAlert = "";
        }
        setRotateButtonState(false);
        resetImageRotation();
        resetSeverityControls();
        resetReferencePreview("No reel selected.");
        renderPositionTrack(null, null);
        return;
      }
      hideNoReelNotice();
      lastNoReelAlert = "";
      updateHeaderInfo(currentReel, currentDefect);
      syncCompletionHighlights(!currentDefect);
      if (currentDefect) {
        renderDefect(currentDefect);
        toggleMode("defect");
        setViewState("content");
        setSeverityControlsDisabled(false);
        return;
      }
      renderSummary(summaryData);
      setRotateButtonState(false);
      resetImageRotation();
      updateImagePendingCounter(summaryData);
      toggleMode("summary");
      setViewState("content");
      resetSeverityControls();
      resetReferencePreview("No pending defect selected.");
    }

    function showErrorState(message) {
      currentDefect = null;
      currentReel = null;
      summaryData = null;
      syncCompletionHighlights(false);
      setDefectCategoryValue("");
      resetSeverityControls();
      setViewState("error", message);
      hideNoReelNotice();
      setRotateButtonState(false);
      resetImageRotation();
      updateImagePendingCounter(null);
      resetReferencePreview("Unable to load reference preview.");
      renderPositionTrack(null, null);
    }

    function showNoReelNotice(message, showButton) {
      if (!noReelNoticeEl) return;
      noReelNoticeEl.classList.remove("hidden");
      if (noReelNoticeTextEl) {
        noReelNoticeTextEl.textContent = message;
      }
      if (nextReelBtn) {
        nextReelBtn.classList.toggle("hidden", !showButton);
        nextReelBtn.disabled = !showButton;
      }
    }

    function hideNoReelNotice() {
      if (!noReelNoticeEl) return;
      noReelNoticeEl.classList.add("hidden");
    }

    function setSeverityControlsDisabled(disabled) {
      if (disabled || !currentDefect) {
        severityButtons.forEach((button) => {
          button.disabled = true;
          button.classList.remove("active");
        });
        confidenceButtons.forEach((button) => {
          button.disabled = true;
          button.classList.remove("active");
        });
        if (uncertainToggle) uncertainToggle.disabled = true;
        return;
      }
      syncSeverityControlState();
    }

    function setReelActionsDisabled(disabled) {
      if (!reelActionsEl) return;
      Array.from(reelActionsEl.querySelectorAll("button")).forEach((button) => {
        button.disabled = disabled;
      });
    }

    function getDefectCategoryValue() {
      if (categoryButtons.length) {
        const active = categoryButtons.find((button) => button.classList.contains("active"));
        return active ? active.dataset.categoryValue || "" : "";
      }
      if (defectCategorySelect) {
        return defectCategorySelect.value || "";
      }
      return "";
    }

    function setDefectCategoryValue(value) {
      const normalized = value || "";
      if (categoryButtons.length) {
        categoryButtons.forEach((button) => {
          button.classList.toggle("active", button.dataset.categoryValue === normalized);
        });
      } else if (defectCategorySelect) {
        defectCategorySelect.value = normalized;
      }
    }

    function setCategoryControlDisabled(disabled) {
      if (categoryButtons.length) {
        categoryButtons.forEach((button) => {
          button.disabled = disabled;
        });
        return;
      }
      if (defectCategorySelect) {
        defectCategorySelect.disabled = disabled;
      }
    }

    function resetImageRotation() {
      imageRotation = loadStoredRotation();
      applyImageRotation();
    }

    function applyImageRotation() {
      if (!imageEl) return;
      imageEl.style.transform = `rotate(${imageRotation}deg)`;
    }

    function normalizeRotation(value) {
      const num = Number(value);
      if (!Number.isFinite(num)) return 0;
      const normalized = num % 360;
      return normalized < 0 ? normalized + 360 : normalized;
    }

    function loadStoredRotation() {
      try {
        const stored = window.localStorage.getItem(IMAGE_ROTATION_STORAGE_KEY);
        return normalizeRotation(stored);
      } catch (error) {
        return 0;
      }
    }

    function persistImageRotation(value) {
      try {
        window.localStorage.setItem(IMAGE_ROTATION_STORAGE_KEY, String(normalizeRotation(value)));
      } catch (error) {
        // ignore
      }
    }

    function loadStoredReferenceMirror() {
      try {
        const stored = window.localStorage.getItem(REFERENCE_MIRROR_STORAGE_KEY);
        if (stored === null) return false;
        return stored === "1";
      } catch (error) {
        return false;
      }
    }

    function persistReferenceMirror(value) {
      try {
        window.localStorage.setItem(REFERENCE_MIRROR_STORAGE_KEY, value ? "1" : "0");
      } catch (error) {
        // ignore
      }
    }

    function setRotateButtonState(enabled) {
      if (!rotateImageBtn) return;
      rotateImageBtn.disabled = !enabled;
    }

    function showJobSwitchModal(selectedJob, nextJob) {
      if (!jobSwitchModal || !jobSwitchModalMessage || !jobSwitchModalConfirm) return;
      pendingJobSwitchTarget = nextJob || null;
      const hasNext = Boolean(nextJob);
      jobSwitchModalMessage.textContent = hasNext
        ? `Job "${selectedJob}" has no reels to review. Switch to next available "${nextJob}"?`
        : `Job "${selectedJob}" has no reels to review. All jobs in this time range look complete—try adjusting the start/end date.`;
      jobSwitchModal.classList.remove("hidden");
      if (jobSwitchModalCancel) {
        jobSwitchModalCancel.classList.toggle("hidden", !hasNext);
      }
      jobSwitchModalConfirm.textContent = hasNext ? "Switch Job" : "OK";
    }

    function hideJobSwitchModal() {
      if (jobSwitchModal) {
        jobSwitchModal.classList.add("hidden");
      }
      pendingJobSwitchTarget = null;
    }

    function resetSeverityControls() {
      severityValue = null;
      confidenceValue = null;
      if (uncertainToggle) uncertainToggle.checked = false;
      severityButtons.forEach((button) => {
        button.classList.remove("active");
      });
      confidenceButtons.forEach((button) => button.classList.remove("active"));
      setCategoryControlDisabled(true);
      syncSeverityControlState();
    }

    function setSeverityValue(value) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) {
        severityValue = null;
      } else {
        severityValue = Number(value);
      }
      severityButtons.forEach((button) => {
        const btnValue = Number(button.dataset.severityValue);
        button.classList.toggle("active", severityValue === btnValue);
      });
      syncSeverityControlState();
    }

    function setConfidenceValue(value) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) {
        confidenceValue = null;
      } else {
        confidenceValue = Number(value);
      }
      confidenceButtons.forEach((button) => {
        const btnValue = Number(button.dataset.confidenceValue);
        button.classList.toggle("active", confidenceValue === btnValue);
      });
      syncSeverityControlState();
    }

    function getConfidenceValue() {
      return Number.isFinite(confidenceValue) ? confidenceValue : null;
    }

    function syncSeverityControlState() {
      const hasDefect = Boolean(currentDefect);
      const uncertain = uncertainToggle ? uncertainToggle.checked : false;
      const hasSeverity = severityValue !== null && Number.isFinite(severityValue);
      const hasConfidence = confidenceValue !== null && Number.isFinite(confidenceValue);
      const enableSave = hasDefect && !saving && (uncertain || (hasSeverity && hasConfidence));
      severityButtons.forEach((button) => {
        button.disabled = !hasDefect || saving || uncertain;
      });
      confidenceButtons.forEach((button) => {
        button.disabled = !hasDefect || saving || uncertain || !hasSeverity;
      });
      if (uncertain && (severityValue !== null || confidenceValue !== null)) {
        severityValue = null;
        confidenceValue = null;
        severityButtons.forEach((button) => button.classList.remove("active"));
        confidenceButtons.forEach((button) => button.classList.remove("active"));
      }
      if (uncertainToggle) {
        uncertainToggle.disabled = !hasDefect || saving;
      }
    }

    function isQcReviewActive() {
      return Router && typeof Router.current === "function" && Router.current() === "qc-review";
    }

    function setHistoryWindow(windowKey) {
      if (!historySummaryData || !historySummaryData.windows) return;
      if (!historySummaryData.windows[windowKey]) return;
      if (historyActiveWindow === windowKey) return;
      historyActiveWindow = windowKey;
      updateHistoryWindowControls();
      renderReviewSummaryHistory();
    }

    function updateHistoryWindowControls() {
      if (!historyWindowButtons.length) return;
      historyWindowButtons.forEach((button) => {
        const isActive = button.dataset.historyWindow === historyActiveWindow;
        button.classList.toggle("qc-history-btn-active", isActive);
      });
    }

    function getHistoryWindowData() {
      if (!historySummaryData || !historySummaryData.windows) return null;
      const windows = historySummaryData.windows;
      if (!windows[historyActiveWindow]) {
        const fallback = historySummaryData.default_window || "all";
        historyActiveWindow = windows[fallback] ? fallback : Object.keys(windows)[0] || "all";
      }
      updateHistoryWindowControls();
      return windows[historyActiveWindow] || null;
    }

    function renderReviewSummaryHistoryPlaceholder(message) {
      if (!reviewSummaryHistoryTableBody) return;
      const text = message || "No historical review activity.";
      reviewSummaryHistoryTableBody.innerHTML = `<tr><td colspan="4" class="qc-jobs-empty">${Utils.escapeHtml(text)}</td></tr>`;
    }

    function renderReviewSummaryHistoryTotals(totals) {
      if (reviewSummaryHistoryImagesEl) {
        reviewSummaryHistoryImagesEl.textContent = Utils.formatNumber(totals ? totals.images_reviewed : null);
      }
      if (reviewSummaryHistoryReelsEl) {
        reviewSummaryHistoryReelsEl.textContent = Utils.formatNumber(totals ? totals.reels_reviewed : null);
      }
      if (reviewSummaryHistoryReviewersEl) {
        reviewSummaryHistoryReviewersEl.textContent = Utils.formatNumber(totals ? totals.reviewers : null);
      }
    }

    function renderReviewSummaryHistory() {
      if (!reviewSummaryHistoryTableBody) return;
      const windowData = getHistoryWindowData();
      const rows = windowData && Array.isArray(windowData.rows) ? windowData.rows : [];
      renderReviewSummaryHistoryTotals(windowData ? windowData.totals : null);
      const label = windowData && windowData.label ? windowData.label.toLowerCase() : "";
      if (!rows.length) {
        const message = label ? `No review activity during ${label}.` : "No historical review activity.";
        renderReviewSummaryHistoryPlaceholder(message);
        return;
      }
      const html = rows
        .map((row) => {
          const reviewer = row.reviewer || "—";
          const images = Utils.formatNumber(row.images_reviewed || 0);
          const reels = Utils.formatNumber(row.reels_reviewed || 0);
          const reviewedAt = formatTime(row.last_reviewed_at, "—");
          return `
            <tr>
              <td>${Utils.escapeHtml(reviewer)}</td>
              <td>${images}</td>
              <td>${reels}</td>
              <td>${Utils.escapeHtml(reviewedAt)}</td>
            </tr>
          `;
        })
        .join("");
      reviewSummaryHistoryTableBody.innerHTML = html;
    }

    async function fetchReviewSummaryHistory(force = false) {
      if (!reviewSummaryHistoryTableBody) return;
      if (reviewSummaryHistoryLoading) return;
      if (!force && !shouldRefreshReviewSummaryHistory) return;
      shouldRefreshReviewSummaryHistory = false;
      reviewSummaryHistoryLoading = true;
      const requestId = ++reviewSummaryHistoryRequestId;
      renderReviewSummaryHistoryPlaceholder("Loading historical summary…");
      try {
        const data = await Api.get("qc-review/review-summary/history");
        if (requestId !== reviewSummaryHistoryRequestId) return;
        const history = (data && data.history) || null;
        historySummaryData = history && history.windows ? history : null;
        historyActiveWindow = (historySummaryData && historySummaryData.default_window) || "all";
        updateHistoryWindowControls();
        if (!historySummaryData) {
          renderReviewSummaryHistoryTotals(null);
          renderReviewSummaryHistoryPlaceholder("No historical review activity.");
        } else {
          renderReviewSummaryHistory();
        }
      } catch (error) {
        if (requestId !== reviewSummaryHistoryRequestId) return;
        historySummaryData = null;
        renderReviewSummaryHistoryTotals(null);
        renderReviewSummaryHistoryPlaceholder("Failed to load historical summary.");
        shouldRefreshReviewSummaryHistory = true;
      } finally {
        if (requestId === reviewSummaryHistoryRequestId) {
          reviewSummaryHistoryLoading = false;
        }
      }
    }

    function renderJobTablePlaceholder(message) {
      if (!jobsTableBody) return;
      const text = message || "No job data. Adjust the filters above.";
      jobsTableBody.innerHTML = `<tr><td colspan="3" class="qc-jobs-empty">${Utils.escapeHtml(text)}</td></tr>`;
    }

    function normalizeJobLabel(row) {
      return (row && (row.job_name || row.label || row.value)) || "";
    }

    function getPendingCount(row) {
      if (!row) return 0;
      const total = Number(row.total_reels || 0);
      const reviewed = Number(row.reviewed_reels || 0);
      const pendingCalculated = Math.max(total - reviewed, 0);
      const pending = row.pending_reels !== undefined ? Number(row.pending_reels) : pendingCalculated;
      return Number.isFinite(pending) ? Math.max(pending, 0) : pendingCalculated;
    }

    function renderJobTable(rows) {
      if (!jobsTableBody) return;
      const list = Array.isArray(rows) ? rows : [];
      if (!list.length) {
        renderJobTablePlaceholder("No job data. Adjust the filters above.");
        return;
      }
      const html = list
        .map((row) => {
          const jobName = normalizeJobLabel(row);
          const pending = getPendingCount(row);
          const status = pending > 0 ? "pending" : "complete";
          const pillClass = status === "pending" ? "qc-job-status-pill--pending" : "qc-job-status-pill--complete";
          const pillLabel = status === "pending" ? "Needs attention" : "Complete";
          return `
            <tr>
              <td>${Utils.escapeHtml(jobName || "Unassigned Job")}</td>
              <td>${Utils.formatNumber(pending)}</td>
              <td><span class="qc-job-status-pill ${pillClass}">${pillLabel}</span></td>
            </tr>
          `;
        })
        .join("");
      jobsTableBody.innerHTML = html;
    }

    function maybePromptForJobSwitch(rows) {
      if (!isQcReviewActive()) return;
      if (!Filters || typeof Filters.getState !== "function") return;
      const state = Filters.getState();
      const selectedJob = (state.job || "").trim();
      if (!selectedJob) {
        lastJobAlerted = "";
        return;
      }
      const list = Array.isArray(rows) ? rows : [];
      if (!list.length) {
        lastJobAlerted = "";
        return;
      }
      const normalizedSelection = selectedJob.toLowerCase();
      const selectedRow = list.find((row) => normalizeJobLabel(row).toLowerCase() === normalizedSelection);
      if (!selectedRow) {
        lastJobAlerted = "";
        return;
      }
      const pending = getPendingCount(selectedRow);
      if (pending > 0) {
        lastJobAlerted = "";
        return;
      }
      if (lastJobAlerted.toLowerCase && lastJobAlerted.toLowerCase() === normalizedSelection) {
        return;
      }
      const nextRow = list.find((row) => {
        const label = normalizeJobLabel(row);
        if (!label) return false;
        if (label.toLowerCase() === normalizedSelection) return false;
        return getPendingCount(row) > 0;
      });
      if (!nextRow) {
        showJobSwitchModal(selectedJob, null);
        lastJobAlerted = selectedJob;
        return;
      }
      const nextLabel = normalizeJobLabel(nextRow) || "Next job";
      showJobSwitchModal(selectedJob, nextLabel);
      lastJobAlerted = selectedJob;
    }

    async function fetchJobOverview(force = false) {
      if (!jobsTableBody) return;
      if (jobOverviewLoading) return;
      if (!force && !shouldRefreshJobOverview) return;
      shouldRefreshJobOverview = false;
      jobOverviewLoading = true;
      const requestId = ++jobOverviewRequestId;
      renderJobTablePlaceholder("Loading job summary…");
      try {
        const data = await Api.get("qc-review/jobs-overview");
        if (requestId !== jobOverviewRequestId) return;
        const jobs = data?.overview?.jobs || [];
        jobOverviewCache = jobs;
        if (jobs.length) {
          renderJobTable(jobOverviewCache);
          maybePromptForJobSwitch(jobOverviewCache);
        } else {
          renderJobTablePlaceholder("No job data. Adjust the filters above.");
          maybePromptForJobSwitch([]);
        }
      } catch (error) {
        if (requestId !== jobOverviewRequestId) return;
        jobOverviewCache = [];
        renderJobTablePlaceholder("Failed to load job overview.");
        maybePromptForJobSwitch([]);
      } finally {
        if (requestId === jobOverviewRequestId) {
          jobOverviewLoading = false;
        }
      }
    }

    function formatOverviewWindow(range) {
      if (!range) return "";
      const start = range.start ? formatTime(range.start) : null;
      const end = range.end ? formatTime(range.end) : null;
      if (start && end) return `${start} → ${end}`;
      if (start) return `Starts ${start}`;
      if (end) return `Ends ${end}`;
      return "";
    }

    function toggleMode(mode) {
      const isSummary = mode === "summary";
      if (stageEl) stageEl.classList.toggle("hidden", isSummary);
      if (positionTrackEl) positionTrackEl.classList.toggle("hidden", isSummary);
      if (defectActionsEl) defectActionsEl.classList.toggle("hidden", isSummary);
      if (summaryEl) summaryEl.classList.toggle("hidden", !isSummary);
      if (isSummary) {
        setSeverityControlsDisabled(true);
        syncReelActionState();
      } else {
        setReelActionsDisabled(true);
      }
    }

    function setViewState(state, message = "") {
      if (loadingEl) loadingEl.classList.toggle("hidden", state !== "loading");
      if (emptyEl) emptyEl.classList.toggle("hidden", state !== "empty");
      if (errorEl) {
        const isError = state === "error";
        errorEl.classList.toggle("hidden", !isError);
        if (errorTextEl && isError) {
          errorTextEl.textContent = message;
        }
      }
      if (contentEl) contentEl.classList.toggle("hidden", state !== "content");
    }

    function formatFieldValue(key, value) {
      if (value === null || value === undefined || value === "") {
        return "—";
      }
      switch (key) {
        case "defect_id":
          return `#${value}`;
        case "format_position":
          return `${Utils.formatNumber(value, 1)} mm`;
        case "magnitude_value":
          return Utils.formatNumber(value, 3);
        case "severity_value":
          return Utils.formatNumber(value, 2);
        case "phase": {
          const normalized = String(value).replace(/_/g, " ");
          return normalized
            .split(" ")
            .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
            .join(" ");
        }
        default:
          return String(value);
      }
    }

    function renderDefect(defect) {
      currentDefect = defect;
      const labelParts = [];
      if (defect.job_name) labelParts.push(defect.job_name);
      if (defect.order_number) labelParts.push(defect.order_number);
      if (!labelParts.length && defect.reel_code) labelParts.push(defect.reel_code);
      const label = labelParts.length ? labelParts.join(" · ") : `Defect #${defect.defect_id}`;
      if (labelEl) labelEl.textContent = label;
      if (timeEl) timeEl.textContent = formatTime(defect.defect_time);

      if (defect.image_src) {
        const src = urlForStatic(defect.image_src);
        if (imageEl) {
          imageEl.src = src;
          imageEl.classList.remove("hidden");
        }
        if (imagePlaceholderEl) {
          imagePlaceholderEl.classList.add("hidden");
        }
        setRotateButtonState(true);
        applyImageRotation();
      } else {
        if (imageEl) {
          imageEl.removeAttribute("src");
          imageEl.classList.add("hidden");
          resetImageRotation();
        }
        if (imagePlaceholderEl) {
          imagePlaceholderEl.classList.remove("hidden");
        }
        setRotateButtonState(false);
      }

      FIELD_KEYS.forEach((key) => {
        const el = fieldEls[key];
        if (!el) return;
        el.textContent = formatFieldValue(key, defect[key]);
      });
      setDefectCategoryValue(defect.defect_category || "");
      setCategoryControlDisabled(false);
      const isUncertain = Boolean(defect.severity_uncertain);
      if (uncertainToggle) {
        uncertainToggle.checked = isUncertain;
      }
      if (isUncertain) {
        setSeverityValue(null);
        setConfidenceValue(null);
      } else {
        setSeverityValue(
          defect.severity_score !== null && defect.severity_score !== undefined
            ? Number(defect.severity_score)
            : null
        );
        setConfidenceValue(
          defect.severity_confidence !== null && defect.severity_confidence !== undefined
            ? Number(defect.severity_confidence)
            : null
        );
      }
      if (currentDefect) {
        currentDefect.defect_category = defect.defect_category || "";
      }
      renderReferencePreview(defect).catch(() => {
        resetReferencePreview("Unable to render the footprint preview.");
      });
    }

    function getReferenceImageUrl(defect) {
      const direct = defect && defect.reference_image && defect.reference_image.image_src;
      const fallback = currentReel && currentReel.reference_image && currentReel.reference_image.image_src;
      const source = direct || fallback || "";
      return source ? urlForStatic(source) : "";
    }

    function normalizeReferenceShapes(defect) {
      if (!defect || !Array.isArray(defect.coords)) return [];
      return defect.coords
        .map((shape) => {
          if (!shape || typeof shape !== "object") return null;
          const xs = Array.isArray(shape.x) ? shape.x.map((value) => Number(value)).filter((value) => Number.isFinite(value)) : [];
          const ys = Array.isArray(shape.y) ? shape.y.map((value) => Number(value)).filter((value) => Number.isFinite(value)) : [];
          const count = Math.min(xs.length, ys.length);
          if (count < 3) return null;
          return {
            xs: xs.slice(0, count),
            ys: ys.slice(0, count),
          };
        })
        .filter(Boolean);
    }

    function computeReferenceGeometry(defect, shapes) {
      if (!Array.isArray(shapes) || !shapes.length) return null;
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      shapes.forEach((shape) => {
        shape.xs.forEach((value) => {
          minX = Math.min(minX, value);
          maxX = Math.max(maxX, value);
        });
        shape.ys.forEach((value) => {
          minY = Math.min(minY, value);
          maxY = Math.max(maxY, value);
        });
      });
      const widthHint = Number(defect?.format_width);
      const lengthHint = Number(defect?.format_length);
      const hasDimensions =
        Number.isFinite(widthHint) && Number.isFinite(lengthHint) && Math.abs(widthHint) > 0 && Math.abs(lengthHint) > 0;
      const fallbackWidth = Number.isFinite(maxX - minX) && maxX - minX > 0 ? maxX - minX : 1;
      const fallbackLength = Number.isFinite(maxY - minY) && maxY - minY > 0 ? maxY - minY : 1;
      const centerX = hasDimensions ? 0 : (minX + maxX) / 2 || 0;
      const centerY = hasDimensions ? 0 : (minY + maxY) / 2 || 0;
      return {
        width: hasDimensions ? Math.abs(widthHint) : fallbackWidth,
        length: hasDimensions ? Math.abs(lengthHint) : fallbackLength,
        centerX,
        centerY,
      };
    }

    function setReferenceStatus(message) {
      if (referenceStatusEl) {
        referenceStatusEl.textContent = message || "Select a defect to visualize the footprint.";
      }
    }

    function setReferenceStatusWithHint(message) {
      const trimmed = (message || "").trim();
      const fullMessage = trimmed ? `${trimmed} ${REFERENCE_INTERACTION_HINT}` : REFERENCE_INTERACTION_HINT;
      setReferenceStatus(fullMessage);
    }

    function showReferencePlaceholder(message) {
      if (referencePlaceholderEl) {
        referencePlaceholderEl.textContent = message || "Reference preview unavailable.";
        referencePlaceholderEl.classList.remove("hidden");
      }
      if (referenceCanvasEl) {
        referenceCanvasEl.classList.add("hidden");
      }
    }

    function hideReferencePlaceholder() {
      if (referencePlaceholderEl) {
        referencePlaceholderEl.classList.add("hidden");
      }
      if (referenceCanvasEl) {
        referenceCanvasEl.classList.remove("hidden");
      }
    }

    function resetReferencePreview(message) {
      referenceRenderToken += 1;
      showReferencePlaceholder(message || "Select a defect to visualize the footprint.");
      setReferenceStatus("Select a defect to visualize the footprint.");
      if (referenceCanvasEl) {
        referenceCanvasEl.width = 0;
        referenceCanvasEl.height = 0;
        referenceCanvasEl.removeAttribute("style");
      }
      referenceFootprintBounds = null;
      syncReferenceFocusButton();
      resetReferenceTransformDefaults();
    }

    function resetReferenceTransformDefaults() {
      cancelReferenceTransformAnimation();
      referenceZoom = REFERENCE_ZOOM_DEFAULT;
      referencePanX = 0;
      referencePanY = 0;
      updateReferenceControls();
      applyReferenceTransform();
      setReferenceResetVisible(false);
    }

    function cancelReferenceTransformAnimation() {
      if (referenceTransformAnimation && referenceTransformAnimation.frameId) {
        cancelAnimationFrame(referenceTransformAnimation.frameId);
      }
      referenceTransformAnimation = null;
    }

    function syncReferenceFocusButton() {
      if (referenceFocusBtn) {
        referenceFocusBtn.disabled = !referenceFootprintBounds;
      }
      if (!referenceFootprintBounds) {
        setReferenceResetVisible(false);
      }
    }

    function setReferenceResetVisible(visible) {
      if (!referenceResetBtn) return;
      referenceResetBtn.classList.toggle("hidden", !visible);
      referenceResetBtn.disabled = !visible;
    }

    function getReferenceCanvasSize() {
      if (referenceStageEl && referenceStageEl.clientWidth) {
        return Math.max(260, referenceStageEl.clientWidth);
      }
      if (referencePanelEl && referencePanelEl.clientWidth) {
        return Math.max(260, referencePanelEl.clientWidth);
      }
      return 320;
    }

    function drawReferenceCanvas(shapes, geometry, image) {
      if (!referenceCanvasEl) return;
      const size = getReferenceCanvasSize();
      const dpr = window.devicePixelRatio || 1;
      referenceCanvasEl.width = size * dpr;
      referenceCanvasEl.height = size * dpr;
      referenceCanvasEl.style.width = `${size}px`;
      referenceCanvasEl.style.height = `${size}px`;
      const ctx = referenceCanvasEl.getContext("2d");
      if (!ctx) {
        showReferencePlaceholder("Unable to access the preview canvas.");
        return;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, referenceCanvasEl.width, referenceCanvasEl.height);
      ctx.scale(dpr, dpr);
      ctx.fillStyle = "#020617";
      ctx.fillRect(0, 0, size, size);
      ctx.save();
      ctx.translate(size / 2, size / 2);
      const span = Math.max(geometry.width, geometry.length);
      const scale = span ? (size - REFERENCE_CANVAS_PADDING * 2) / span : 1;
      const drawWidth = geometry.width * scale;
      const drawLength = geometry.length * scale;
      ctx.fillStyle = "#0f172a";
      ctx.fillRect(-drawWidth / 2, -drawLength / 2, drawWidth, drawLength);
      if (image) {
        ctx.save();
        ctx.scale(1, -1);
        ctx.drawImage(image, -drawWidth / 2, -drawLength / 2, drawWidth, drawLength);
        ctx.restore();
      } else {
        ctx.fillStyle = "rgba(15, 23, 42, 0.8)";
        ctx.fillRect(-drawWidth / 2, -drawLength / 2, drawWidth, drawLength);
      }
      ctx.strokeStyle = "rgba(226, 232, 240, 0.4)";
      ctx.lineWidth = 1;
      ctx.strokeRect(-drawWidth / 2, -drawLength / 2, drawWidth, drawLength);
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = "rgba(148, 163, 184, 0.35)";
      ctx.beginPath();
      ctx.moveTo(-drawWidth / 2, 0);
      ctx.lineTo(drawWidth / 2, 0);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, -drawLength / 2);
      ctx.lineTo(0, drawLength / 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineJoin = "round";
      let footprintMinX = Infinity;
      let footprintMaxX = -Infinity;
      let footprintMinY = Infinity;
      let footprintMaxY = -Infinity;
      function recordFootprintPoint(px, py) {
        footprintMinX = Math.min(footprintMinX, px);
        footprintMaxX = Math.max(footprintMaxX, px);
        footprintMinY = Math.min(footprintMinY, py);
        footprintMaxY = Math.max(footprintMaxY, py);
      }
      shapes.forEach((shape) => {
        ctx.beginPath();
        const startX = (shape.xs[0] - geometry.centerX) * scale;
        const startY = -(shape.ys[0] - geometry.centerY) * scale;
        ctx.moveTo(startX, startY);
        recordFootprintPoint(startX, startY);
        for (let idx = 1; idx < shape.xs.length; idx += 1) {
          const pointX = (shape.xs[idx] - geometry.centerX) * scale;
          const pointY = -(shape.ys[idx] - geometry.centerY) * scale;
          ctx.lineTo(pointX, pointY);
          recordFootprintPoint(pointX, pointY);
        }
        ctx.closePath();
        ctx.fillStyle = "rgba(248, 113, 113, 0.45)";
        ctx.strokeStyle = "rgba(248, 113, 113, 0.95)";
        ctx.lineWidth = 2;
        ctx.fill();
        ctx.stroke();
      });
      ctx.restore();
      if (
        Number.isFinite(footprintMinX) &&
        Number.isFinite(footprintMaxX) &&
        Number.isFinite(footprintMinY) &&
        Number.isFinite(footprintMaxY)
      ) {
        const boundsWidth = Math.max(1, footprintMaxX - footprintMinX);
        const boundsHeight = Math.max(1, footprintMaxY - footprintMinY);
        const centerX = (footprintMinX + footprintMaxX) / 2;
        const centerY = (footprintMinY + footprintMaxY) / 2;
        referenceFootprintBounds = {
          centerOffsetXRatio: centerX / size,
          centerOffsetYRatio: centerY / size,
          widthRatio: boundsWidth / size,
          heightRatio: boundsHeight / size,
        };
      } else {
        referenceFootprintBounds = null;
      }
      syncReferenceFocusButton();
      hideReferencePlaceholder();
    }

    function loadReferenceImage(src) {
      if (!src) return Promise.resolve(null);
      return new Promise((resolve) => {
        const img = new Image();
        img.decoding = "async";
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = src;
      });
    }

    async function renderReferencePreview(defect) {
      if (!referencePanelEl || !referenceCanvasEl) return;
      if (!defect) {
        resetReferencePreview();
        return;
      }
      const shapes = normalizeReferenceShapes(defect);
      if (!shapes.length) {
        resetReferencePreview("This defect does not include footprint coordinates.");
        return;
      }
      const geometry = computeReferenceGeometry(defect, shapes);
      if (!geometry) {
        resetReferencePreview("Unable to determine footprint bounds.");
        return;
      }
      const referenceUrl = getReferenceImageUrl(defect);
      const renderId = ++referenceRenderToken;
      referenceFootprintBounds = null;
      syncReferenceFocusButton();
      resetReferenceTransformDefaults();
      setReferenceStatus(
        referenceUrl
          ? "Overlaying the defect footprint on the reference image."
          : "Reference image unavailable. Showing footprint in reel space."
      );
      showReferencePlaceholder(referenceUrl ? "Loading reference preview…" : "Drawing footprint…");
      const image = await loadReferenceImage(referenceUrl);
      if (renderId !== referenceRenderToken) return;
      if (!image && referenceUrl) {
        setReferenceStatusWithHint("Failed to load reference image. Showing footprint in reel space.");
      } else if (image) {
        setReferenceStatusWithHint("Defect footprint aligned to the reference image.");
      } else {
        setReferenceStatusWithHint("Reference image unavailable. Showing footprint in reel space.");
      }
      drawReferenceCanvas(shapes, geometry, image);
      applyReferenceTransform();
    }


    function clampReferenceZoom(value) {
      if (!Number.isFinite(value)) return REFERENCE_ZOOM_DEFAULT;
      return Math.min(REFERENCE_ZOOM_MAX, Math.max(REFERENCE_ZOOM_MIN, value));
    }

    function updateReferenceControls() {
      if (referenceMirrorBtn) {
        referenceMirrorBtn.classList.toggle("active", Boolean(referenceMirror));
        referenceMirrorBtn.setAttribute("aria-pressed", referenceMirror ? "true" : "false");
      }
      if (referenceZoomDisplayEl) {
        referenceZoomDisplayEl.textContent = `${Math.round(referenceZoom * 100)}%`;
      }
    }

    function applyReferenceTransform() {
      if (!referenceInnerEl) return;
      const zoom = referenceZoom;
      const scaleX = referenceMirror ? -zoom : zoom;
      const pan = clampReferencePan(referencePanX, referencePanY);
      referencePanX = pan.x;
      referencePanY = pan.y;
      referenceInnerEl.style.transform = `translate(${referencePanX}px, ${referencePanY}px) scale(${scaleX}, ${zoom})`;
    }

    function clampReferencePan(x, y) {
      return clampReferencePanForZoom(x, y, referenceZoom);
    }

    function clampReferencePanForZoom(x, y, zoomValue) {
      if (zoomValue <= 1) return { x: 0, y: 0 };
      if (!referenceStageEl) return { x, y };
      const rect = referenceStageEl.getBoundingClientRect();
      const limitX = Math.max(0, ((zoomValue - 1) * rect.width) / 2);
      const limitY = Math.max(0, ((zoomValue - 1) * rect.height) / 2);
      return {
        x: Math.min(limitX, Math.max(-limitX, x)),
        y: Math.min(limitY, Math.max(-limitY, y)),
      };
    }

    function normalizeTrackValue(value) {
      if (value === null || value === undefined) return null;
      const num = Number(value);
      return Number.isFinite(num) ? num : null;
    }

    function renderPositionTrack(reel, summary) {
      if (!positionTrackEl) return;
      const start = normalizeTrackValue(
        reel && (reel.reel_start_position ?? reel.reel_start ?? reel.reel_start_position_mm ?? reel.reel_start_mm)
      );
      const end = normalizeTrackValue(
        reel && (reel.reel_end_position ?? reel.reel_end ?? reel.reel_end_position_mm ?? reel.reel_end_mm)
      );
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        positionTrackEl.classList.add("hidden");
        positionTrackSegments = [];
        clearPositionTrackHover();
        if (positionTrackSquaresEl) positionTrackSquaresEl.innerHTML = "";
        if (positionTrackMetaEl) positionTrackMetaEl.textContent = "Position data unavailable.";
        if (positionTrackStartEl) positionTrackStartEl.textContent = "—";
        if (positionTrackEndEl) positionTrackEndEl.textContent = "—";
        return;
      }
      positionTrackEl.classList.remove("hidden");
      const span = end - start;
      if (positionTrackMetaEl) {
        positionTrackMetaEl.textContent = `Span ${Utils.formatNumber(span, 0)} units`;
      }
      if (positionTrackStartEl) positionTrackStartEl.textContent = Utils.formatNumber(start, 0);
      if (positionTrackEndEl) positionTrackEndEl.textContent = Utils.formatNumber(end, 0);
      if (positionTrackSquaresEl) {
        positionTrackSegments = [];
        const fragment = document.createDocumentFragment();
        const measuredWidth =
          positionTrackSquaresEl.getBoundingClientRect().width ||
          positionTrackEl?.getBoundingClientRect().width ||
          referenceStageEl?.getBoundingClientRect().width ||
          positionTrackEl?.parentElement?.getBoundingClientRect?.().width ||
          positionTrackSquaresEl.clientWidth ||
          positionTrackEl?.clientWidth ||
          referenceStageEl?.clientWidth ||
          positionTrackEl?.parentElement?.clientWidth ||
          0;
        if (!measuredWidth || measuredWidth <= 0) {
          window.requestAnimationFrame(() => renderPositionTrack(reel, summary));
          return;
        }
        const maxSegments = Math.max(25, Math.floor(measuredWidth));
        const idealSegments = Math.max(1, Math.round(span));
        const segments = Math.min(idealSegments, maxSegments);
        const step = span / segments;
        const defectEntries = Array.isArray(summary?.defects)
          ? summary.defects
              .map((row) => ({
                position: normalizeTrackValue(row && row.format_position),
                id: row && row.defect_id,
              }))
              .filter((entry) => Number.isFinite(entry.position) && entry.id)
              .sort((a, b) => a.position - b.position)
          : [];
        let defectIdx = 0;
        for (let idx = 0; idx < segments; idx += 1) {
          const square = document.createElement("div");
          const rangeStart = start + idx * step;
          const rangeEnd = idx === segments - 1 ? end : rangeStart + step;
          while (defectIdx < defectEntries.length && defectEntries[defectIdx].position < rangeStart) {
            defectIdx += 1;
          }
          let chosenDefect = null;
          let scanIdx = defectIdx;
          while (scanIdx < defectEntries.length && defectEntries[scanIdx].position < rangeEnd) {
            chosenDefect = defectEntries[scanIdx];
            break;
          }
          square.className = chosenDefect
            ? "qc-position-track__square qc-position-track__square--defect"
            : "qc-position-track__square";
          square.dataset.segmentIndex = String(idx);
          square.title = chosenDefect
            ? `Defect #${chosenDefect.id} · position ${Utils.formatNumber(chosenDefect.position, 0)}`
            : `Positions ${Utils.formatNumber(rangeStart, 0)} – ${Utils.formatNumber(rangeEnd, 0)}`;
          positionTrackSegments[idx] = {
            start: rangeStart,
            end: rangeEnd,
            defectId: chosenDefect ? chosenDefect.id : null,
            element: square,
          };
          fragment.appendChild(square);
        }
        positionTrackSquaresEl.innerHTML = "";
        positionTrackSquaresEl.appendChild(fragment);
        clearPositionTrackHover();
      }
    }

    function handlePositionTrackClick(event) {
      const target = event.target.closest(".qc-position-track__square");
      if (!target || !positionTrackSquaresEl || !positionTrackSquaresEl.contains(target)) return;
      const index = Number(target.dataset.segmentIndex);
      if (!Number.isInteger(index)) return;
      const nearest = getNearestDefectSegment(index);
      if (!nearest || !nearest.segment || !nearest.segment.defectId) return;
      focusDefectFromTrack(nearest.segment.defectId);
    }

    function handlePositionTrackHover(event) {
      const target = event.target.closest(".qc-position-track__square");
      if (!target || !positionTrackSquaresEl || !positionTrackSquaresEl.contains(target)) {
        clearPositionTrackHover();
        return;
      }
      const index = Number(target.dataset.segmentIndex);
      if (!Number.isInteger(index)) {
        clearPositionTrackHover();
        return;
      }
      const nearest = getNearestDefectSegment(index);
      if (!nearest || !nearest.segment || !nearest.segment.defectId) {
        clearPositionTrackHover();
        return;
      }
      setPositionTrackHover(nearest.index);
    }

    function setPositionTrackHover(index) {
      if (positionTrackHoverIndex === index) return;
      if (positionTrackHoverIndex !== null) {
        const previous = positionTrackSegments[positionTrackHoverIndex];
        if (previous && previous.element) {
          previous.element.classList.remove("qc-position-track__square--defect-active");
        }
      }
      positionTrackHoverIndex = index;
      if (index === null) return;
      const current = positionTrackSegments[index];
      if (current && current.defectId && current.element) {
        current.element.classList.add("qc-position-track__square--defect-active");
      }
    }

    function clearPositionTrackHover() {
      if (positionTrackHoverIndex === null) return;
      const current = positionTrackSegments[positionTrackHoverIndex];
      if (current && current.element) {
        current.element.classList.remove("qc-position-track__square--defect-active");
      }
      positionTrackHoverIndex = null;
    }

    function getNearestDefectSegment(index) {
      if (!Array.isArray(positionTrackSegments) || !positionTrackSegments.length) return null;
      const total = positionTrackSegments.length;
      const maxOffset = Math.min(15, Math.max(1, Math.floor(total * 0.05)));
      const current = positionTrackSegments[index];
      if (current && current.defectId) {
        return { segment: current, index };
      }
      for (let offset = 1; offset <= maxOffset; offset += 1) {
        const leftIdx = index - offset;
        if (leftIdx >= 0) {
          const leftSegment = positionTrackSegments[leftIdx];
          if (leftSegment && leftSegment.defectId) {
            return { segment: leftSegment, index: leftIdx };
          }
        }
        const rightIdx = index + offset;
        if (rightIdx < total) {
          const rightSegment = positionTrackSegments[rightIdx];
          if (rightSegment && rightSegment.defectId) {
            return { segment: rightSegment, index: rightIdx };
          }
        }
      }
      return null;
    }


    function focusReferenceOnFootprint() {
      if (!referenceFootprintBounds || !referenceStageEl) return;
      const rect = referenceStageEl.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const centerRatioX = Number(referenceFootprintBounds.centerOffsetXRatio) || 0;
      const centerRatioY = Number(referenceFootprintBounds.centerOffsetYRatio) || 0;
      const centerOffsetX = centerRatioX * rect.width;
      const centerOffsetY = centerRatioY * rect.height;
      const baseWidth = Math.max(8, (referenceFootprintBounds.widthRatio || 0) * rect.width);
      const baseHeight = Math.max(8, (referenceFootprintBounds.heightRatio || 0) * rect.height);
      const paddedWidth = baseWidth * REFERENCE_FOCUS_PADDING;
      const paddedHeight = baseHeight * REFERENCE_FOCUS_PADDING;
      const targetZoom = clampReferenceZoom(Math.min(rect.width / paddedWidth, rect.height / paddedHeight));
      const targetScaleX = referenceMirror ? -targetZoom : targetZoom;
      let targetPanX = -targetScaleX * centerOffsetX;
      let targetPanY = -targetZoom * centerOffsetY;
      const clamped = clampReferencePanForZoom(targetPanX, targetPanY, targetZoom);
      targetPanX = clamped.x;
      targetPanY = clamped.y;
      animateReferenceTransform(targetZoom, targetPanX, targetPanY, REFERENCE_FOCUS_DURATION, {
        centerLock: { offsetXRatio: centerRatioX, offsetYRatio: centerRatioY },
      });
      setReferenceResetVisible(true);
    }

    function handleReferenceReset() {
      resetReferenceTransformDefaults();
      setReferenceResetVisible(false);
    }

    function animateReferenceTransform(targetZoom, targetPanX, targetPanY, durationMs, options = {}) {
      const limitedTargetZoom = clampReferenceZoom(targetZoom);
      const duration = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 500;
      cancelReferenceTransformAnimation();
      const startZoom = referenceZoom;
      const startPanX = referencePanX;
      const startPanY = referencePanY;
      const centerLock =
        options &&
        options.centerLock &&
        referenceStageEl &&
        referenceStageEl.getBoundingClientRect
          ? (() => {
              const rect = referenceStageEl.getBoundingClientRect();
              if (!rect.width || !rect.height) return null;
              const ratioX = Number(options.centerLock.offsetXRatio);
              const ratioY = Number(options.centerLock.offsetYRatio);
              return {
                offsetX: (Number.isFinite(ratioX) ? ratioX : 0) * rect.width,
                offsetY: (Number.isFinite(ratioY) ? ratioY : 0) * rect.height,
              };
            })()
          : null;
      const startTime = performance.now();
      function step(now) {
        const elapsed = now - startTime;
        const progress = Math.min(1, elapsed / duration);
        const eased = easeInOutCubic(progress);
        const desiredZoom = startZoom + (limitedTargetZoom - startZoom) * eased;
        const nextZoom = clampReferenceZoom(desiredZoom);
        let desiredPanX;
        let desiredPanY;
        if (centerLock) {
          const scaleX = referenceMirror ? -nextZoom : nextZoom;
          desiredPanX = -scaleX * centerLock.offsetX;
          desiredPanY = -nextZoom * centerLock.offsetY;
        } else {
          desiredPanX = startPanX + (targetPanX - startPanX) * eased;
          desiredPanY = startPanY + (targetPanY - startPanY) * eased;
        }
        referenceZoom = nextZoom;
        const clampedPan = clampReferencePanForZoom(desiredPanX, desiredPanY, nextZoom);
        referencePanX = clampedPan.x;
        referencePanY = clampedPan.y;
        updateReferenceControls();
        applyReferenceTransform();
        if (progress < 1) {
          referenceTransformAnimation = { frameId: requestAnimationFrame(step) };
        } else {
          referenceTransformAnimation = null;
        }
      }
      referenceTransformAnimation = { frameId: requestAnimationFrame(step) };
    }

    function easeInOutCubic(value) {
      if (value <= 0) return 0;
      if (value >= 1) return 1;
      if (value < 0.5) {
        return 4 * value * value * value;
      }
      const adjusted = 2 * value - 2;
      return 1 - (adjusted * adjusted * adjusted) / 2;
    }

    async function focusDefectFromTrack(defectId) {
      if (!defectId) return;
      try {
        await fetchNext(false, { focusDefectId: defectId });
      } catch (error) {
        console.error("Failed to load defect", defectId, error);
      }
    }

    function normalizeDecision(value) {
      const normalized = (value || "").toString().trim().toLowerCase();
      if (normalized === "pass" || normalized === "fail") return normalized;
      if (normalized === "uncertain") return "uncertain";
      return "pending";
    }
    function countPendingImageDefects(summary) {
      if (!summary || !Array.isArray(summary.defects)) return 0;
      return summary.defects.filter((row) => {
        if (row.has_image === false) return false;
        const decision = (row.qc_decision || "").toLowerCase();
        if (decision === "pass" || decision === "fail" || decision === "uncertain") return false;
        return true;
      }).length;
    }

    function updateImagePendingCounter(summary) {
      if (!imagePendingCounterEl || !imagePendingValueEl) return;
      if (!summary || !Array.isArray(summary.defects)) {
        imagePendingCounterEl.classList.add("hidden");
        imagePendingValueEl.textContent = "0";
        return;
      }
      const count = countPendingImageDefects(summary);
      imagePendingValueEl.textContent = Utils.formatNumber(count);
      imagePendingCounterEl.classList.toggle("hidden", false);
    }

    function renderSummary(summary) {
      summaryData = summary || null;
      if (!summaryEl) return;
      if (!summary || !Array.isArray(summary.defects) || !summary.defects.length) {
        if (summaryTableBody) {
          summaryTableBody.innerHTML = `<tr><td colspan="6">No defect records available for this reel.</td></tr>`;
        }
      } else if (summaryTableBody) {
        summaryTableBody.innerHTML = summary.defects
          .map((row) => {
            const decisionBadge = buildDecisionBadge(row.qc_decision);
            const position = Number.isFinite(Number(row.format_position))
              ? `${Utils.formatNumber(row.format_position, 1)} mm`
              : "--";
            const hasImage = row.has_image !== false;
            const decisionCell = hasImage
              ? decisionBadge || '<span class="defect-decision-badge defect-decision-badge-pending">Pending</span>'
              : '<span class="defect-decision-badge defect-decision-badge-info">No Image</span>';
            return `
              <tr>
                <td>#${row.defect_id}</td>
                <td>${Utils.escapeHtml(row.class_name || "—")}</td>
                <td>${Utils.formatNumber(row.magnitude_value, 3)}</td>
                <td>${Utils.formatNumber(row.severity_value, 2)}</td>
                <td>${position}</td>
                <td>${decisionCell}</td>
              </tr>
            `;
          })
          .join("");
      }
      if (summaryCountTotalEl) summaryCountTotalEl.textContent = Utils.formatNumber(summary?.counts?.total || 0);
      if (summaryCountPassEl) summaryCountPassEl.textContent = Utils.formatNumber(summary?.counts?.pass || 0);
      if (summaryCountFailEl) summaryCountFailEl.textContent = Utils.formatNumber(summary?.counts?.fail || 0);
      if (summaryCountPendingEl) summaryCountPendingEl.textContent = Utils.formatNumber(summary?.counts?.pending || 0);
      if (summaryCountNoImageEl) summaryCountNoImageEl.textContent = Utils.formatNumber(summary?.no_image_total || 0);
      updateImagePendingCounter(summary);

      if (summaryByTypeEl) {
        const entries = Array.isArray(summary?.by_type) ? summary.by_type : [];
        if (!entries.length) {
          summaryByTypeEl.innerHTML = "<span class='badge'>No type breakdown available.</span>";
        } else {
          summaryByTypeEl.innerHTML = entries
            .map(
              (entry) => `
                <span class="badge">${Utils.escapeHtml(entry.class_name || "Unknown")} · Pass: ${entry.pass} · Fail: ${entry.fail} · Pending: ${entry.pending}</span>
              `
            )
            .join("");
        }
      }
      if (summaryNoticeEl) {
        summaryNoticeEl.textContent = "All photo-backed defects are reviewed. Submit a reel decision to continue.";
      }
      if (noImageNoteEl) {
        const pendingNoImage = Number(summary?.no_image_pending || 0);
        const totalNoImage = Number(summary?.no_image_total || 0);
        if (totalNoImage > 0) {
          if (pendingNoImage > 0) {
            noImageNoteEl.textContent = `${pendingNoImage} of ${totalNoImage} defects lack preview images. Use the inline buttons to label them.`;
          } else {
            noImageNoteEl.textContent = `${totalNoImage} defects had no preview images.`;
          }
        } else {
          noImageNoteEl.textContent = "";
        }
      }
      if (summaryHistoryEl) {
        const latest = summary && summary.latest_review ? summary.latest_review : null;
        if (latest && latest.decision) {
          const decisionLabel = latest.decision === "pass" ? "PASS" : "FAIL";
          const timestamp = formatTime(latest.created_at, "");
          summaryHistoryEl.textContent = `Latest decision: ${decisionLabel} by ${latest.reviewer_name || latest.reviewer_id || "Reviewer"}${timestamp ? ` on ${timestamp}` : ""}`;
        } else {
          summaryHistoryEl.textContent = "";
        }
      }
    }

    function syncCompletionHighlights(isComplete) {
      COMPLETION_FIELDS.forEach((key) => {
        const el = fieldEls[key];
        if (!el) return;
        el.classList.toggle("qc-field-complete", Boolean(isComplete));
      });
    }

    function applySummaryDecisionLocal(defectId, decision) {
      if (!summaryData || !Array.isArray(summaryData.defects)) return;
      const target = summaryData.defects.find((row) => Number(row.defect_id) === Number(defectId));
      if (!target) return;
      const prev = (target.qc_decision || "").toLowerCase();
      const next = decision === "fail" ? "fail" : "pass";
      if (prev === next) {
        renderSummary(summaryData);
        syncReelActionState();
        return;
      }
      const counts = summaryData.counts || { total: 0, pass: 0, fail: 0, pending: 0 };
      if (prev === "pass") {
        counts.pass = Math.max(0, (counts.pass || 0) - 1);
      } else if (prev === "fail") {
        counts.fail = Math.max(0, (counts.fail || 0) - 1);
      } else {
        counts.pending = Math.max(0, (counts.pending || 0) - 1);
      }
      if (next === "pass") {
        counts.pass = (counts.pass || 0) + 1;
      } else {
        counts.fail = (counts.fail || 0) + 1;
      }
      counts.total = Math.max(0, (counts.pass || 0) + (counts.fail || 0) + (counts.pending || 0));
      summaryData.counts = counts;
      if (target.has_image === false) {
        summaryData.no_image_pending = Math.max(0, (summaryData.no_image_pending || 0) - 1);
      }
      target.qc_decision = next;
      renderSummary(summaryData);
      syncReelActionState();
      updateImagePendingCounter(summaryData);
    }

    async function handleSeveritySave() {
      if (!currentDefect || saving) return;
      const uncertain = uncertainToggle ? Boolean(uncertainToggle.checked) : false;
      const hasSeverity = severityValue !== null && Number.isFinite(severityValue);
      if (!uncertain && !hasSeverity) {
        window.alert("Select a severity value or mark the defect as uncertain.");
        return;
      }
      const confidence = hasSeverity ? getConfidenceValue() : null;
      if (hasSeverity && !confidence) {
        window.alert("Choose a confidence level before saving.");
        return;
      }
      saving = true;
      setSeverityControlsDisabled(true);
      try {
        await saveDefectLabel(currentDefect.defect_id, {
          severity: hasSeverity ? severityValue : null,
          confidence: hasSeverity ? confidence : null,
          uncertain,
          category: getDefectCategoryValue(),
        });
        needsRefresh = true;
        await fetchNext(false, { lockToReel: true, suppressLoader: true });
      } catch (error) {
        const message = error && error.message ? error.message : "Failed to save the label.";
        window.alert(message);
        setSeverityControlsDisabled(false);
      } finally {
        saving = false;
        syncSeverityControlState();
      }
    }

    function syncReelActionState() {
      if (!summaryData || !currentReel) {
        setReelActionsDisabled(true);
        return;
      }
      const reviewer = reviewerInput ? reviewerInput.value.trim() : "";
      const shouldEnable = Boolean(reviewer) && !savingReel;
      setReelActionsDisabled(!shouldEnable);
    }

    async function handleReelDecision(decision) {
      if (!summaryData || savingReel || !currentReel) return;
      const reviewer = reviewerInput ? reviewerInput.value.trim() : "";
      if (!reviewer) {
        window.alert("Enter your name before submitting a reel decision.");
        return;
      }
      const comments = commentsInput ? commentsInput.value.trim() : "";
      savingReel = true;
      setReelActionsDisabled(true);
      try {
        await Api.post(`reel/${currentReel.reel_id}/review`, {
          decision,
          reviewer_name: reviewer,
          comments,
        });
        if (Filters && typeof Filters.updateReelStatus === "function") {
          Filters.updateReelStatus(currentReel.reel_id, decision, currentReel.reel_code || "");
        }
        if (commentsInput) commentsInput.value = "";
        if (Filters && typeof Filters.hasReelSelection === "function" && typeof Filters.removeReel === "function") {
          const isSelected = Filters.hasReelSelection(currentReel.reel_id, currentReel.reel_code || "");
          if (isSelected) {
            Filters.removeReel(currentReel.reel_id, { emit: true });
          }
        }
        needsRefresh = true;
        await fetchNext(true);
        refreshLastReview();
        shouldRefreshJobOverview = true;
        fetchJobOverview(true).catch(() => {});
        shouldRefreshReviewSummaryHistory = true;
        fetchReviewSummaryHistory(true).catch(() => {});
      } catch (error) {
        const message = error && error.message ? error.message : "Failed to submit reel decision.";
        window.alert(message);
        setReelActionsDisabled(false);
      } finally {
        savingReel = false;
      }
    }

    function activate() {
      if (!initialized) init();
      if (!panel) return;
      refreshLastReview();
      if (needsRefresh || !currentDefect) {
        fetchNext(true);
      }
      if (shouldRefreshJobOverview) {
        renderJobTablePlaceholder("Loading job summary…");
        fetchJobOverview(true).catch(() => {});
      }
      if (shouldRefreshReviewSummaryHistory) {
        renderReviewSummaryHistoryPlaceholder("Loading historical summary…");
        fetchReviewSummaryHistory(true).catch(() => {});
      }
    }

    function deactivate() {
      // no-op
    }

    function onFiltersUpdated() {
      needsRefresh = true;
      fetchNext(true);
      shouldRefreshJobOverview = true;
      fetchJobOverview(true).catch(() => {});
    }

    async function refreshLastReview() {
      if (!lastReviewEl) return;
      try {
        const response = await Api.get("last-review", {}, {});
        renderLastReview((response && response.review) || null);
      } catch (error) {
        renderLastReview(null);
      }
    }

    function renderLastReview(review) {
      if (!lastReviewEl) return;
      if (!review) {
        lastReviewEl.classList.add("last-review--empty");
        updateLastReviewField("title", "No reviews submitted yet");
        updateLastReviewField("timestamp", "—");
        updateLastReviewField("reel-time", "—");
        ["machine", "job", "order", "reviewer"].forEach((key) => updateLastReviewField(key, "—"));
        ["pass-count", "fail-count", "total-count"].forEach((key) => updateLastReviewField(key, "0"));
        if (lastReviewStatusEl) {
          lastReviewStatusEl.textContent = "--";
          lastReviewStatusEl.classList.remove("badge-pass", "badge-fail");
        }
        if (lastReviewFields.types) {
          lastReviewFields.types.innerHTML = '<span class="badge">No defect details.</span>';
        }
        return;
      }
      lastReviewEl.classList.remove("last-review--empty");
      const code = review.reel_code || "";
      const label = code ? `Reel ${code}` : review.reel_id ? `Reel #${review.reel_id}` : "Latest review";
      const reviewerLabel = review.reviewer || review.reviewer_name || review.reviewer_id || "—";
      updateLastReviewField("title", label);
      updateLastReviewField("timestamp", review.reviewed_at ? `Reviewed ${formatTime(review.reviewed_at)}` : "—");
      updateLastReviewField("reel-time", formatLastReviewWindow(review.reel_time_start, review.reel_time_end));
      updateLastReviewField("machine", review.machine_name || "—");
      updateLastReviewField("job", review.job_name || "—");
      updateLastReviewField("order", review.order_number || "—");
      updateLastReviewField("reviewer", reviewerLabel);
      const counts = review.defect_counts || {};
      updateLastReviewField("pass-count", Utils.formatNumber(counts.pass || 0));
      updateLastReviewField("fail-count", Utils.formatNumber(counts.fail || 0));
      updateLastReviewField("total-count", Utils.formatNumber(counts.total || 0));
      if (lastReviewStatusEl) {
        const decision = (review.decision || "").toLowerCase();
        const labelText = decision === "pass" ? "PASS" : decision === "fail" ? "FAIL" : "--";
        lastReviewStatusEl.textContent = labelText;
        lastReviewStatusEl.classList.toggle("badge-pass", decision === "pass");
        lastReviewStatusEl.classList.toggle("badge-fail", decision === "fail");
      }
      if (lastReviewFields.types) {
        const entries = Array.isArray(review.defect_types) ? review.defect_types : [];
        if (!entries.length) {
          lastReviewFields.types.innerHTML = '<span class="badge">No defect details.</span>';
        } else {
          lastReviewFields.types.innerHTML = entries
            .map(
              (entry) =>
                `<span class="badge">${Utils.escapeHtml(entry.class_name || "Unclassified")} · ${Utils.formatNumber(
                  entry.count || 0
                )}</span>`
            )
            .join("");
        }
      }
    }

    function updateLastReviewField(key, value) {
      if (!lastReviewFields[key]) return;
      lastReviewFields[key].textContent = value;
    }

    function formatLastReviewWindow(start, end) {
      if (!start && !end) return "Reel time unavailable";
      if (start && end) {
        return `${formatTime(start)} → ${formatTime(end)}`;
      }
      if (start) {
        return `Started ${formatTime(start)}`;
      }
      return `Ended ${formatTime(end)}`;
    }

    return { init, activate, deactivate, onFiltersUpdated };
  })();
