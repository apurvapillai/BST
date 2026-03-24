  const DefectExplorerTab = (() => {
    let typeSelect;
    let phaseSelect;
    let magnitudeMin;
    let magnitudeMax;
    let severityMin;
    let severityMax;
    let positionMin;
    let positionMax;
    let sizeMinInput;
    let sizeMaxInput;
    let tableBody;
    let paginationEl;
    let summaryTotalEl;
    let summaryTypesEl;
    let decisionTotalEl;
    let decisionPassEl;
    let decisionFailEl;
    let decisionUnidentifiedEl;
    let tabScope;
    let chipsEl;
    let updating = false;
    let typeOptionCache = new Set();
    const defaultBucketKeys = HEATMAP_BUCKETS.map((bucket) => bucket.key);
    let decisionSummary = null;
    let lastReelAlertSignature = "";

    const state = {
      page: 1,
      class_names: [],
      phase: "",
      magnitude_min: "",
      magnitude_max: "",
      severity_min: "",
      severity_max: "",
      position_min: "",
      position_max: "",
      pageInfo: null,
      size_min: "",
      size_max: "",
      size_buckets: new Set(defaultBucketKeys),
    };

    function parseSizeInput(value) {
      if (value === undefined || value === null) return null;
      const str = `${value}`.trim();
      if (!str) return null;
      const num = Number(str);
      return Number.isFinite(num) ? num : null;
    }

    function computeSizeRanges() {
      const ranges = [];
      const minValue = parseSizeInput(state.size_min);
      const maxValue = parseSizeInput(state.size_max);

      let enabledKeys = defaultBucketKeys;
      if (state.size_buckets instanceof Set) {
        if (state.size_buckets.size === 0) {
          return [];
        }
        if (state.size_buckets.size < defaultBucketKeys.length) {
          enabledKeys = Array.from(state.size_buckets);
        }
      }

      const baseRanges = enabledKeys
        .map((key) => HEATMAP_BUCKETS.find((bucket) => bucket.key === key))
        .filter(Boolean)
        .map((bucket) => [bucket.min, bucket.max]);

      const workingRanges = baseRanges.length ? baseRanges : [[0, Infinity]];

      workingRanges.forEach(([low, high]) => {
        let min = low;
        let max = high;
        if (minValue !== null) min = Math.max(min, minValue);
        if (maxValue !== null) max = Math.min(max, maxValue);
        if (max > min) ranges.push([min, max]);
      });

      if (!ranges.length && (minValue !== null || maxValue !== null)) {
        const fallbackMin = minValue !== null ? minValue : 0;
        const fallbackMax = maxValue !== null ? maxValue : Infinity;
        if (fallbackMax > fallbackMin) {
          ranges.push([fallbackMin, fallbackMax]);
        }
      }

      return ranges;
    }

    function polygonAreaXY(xs, ys) {
      const len = Math.min(xs.length, ys.length);
      if (len < 3) return 0;
      let area = 0;
      for (let i = 0, j = len - 1; i < len; j = i, i += 1) {
        area += (xs[j] + xs[i]) * (ys[j] - ys[i]);
      }
      return Math.abs(area) / 2;
    }

    function normalizeShape(shape) {
      if (!shape || typeof shape !== "object") return null;
      const xs = Array.isArray(shape.x)
        ? shape.x
            .map((value) => {
              const num = Number(value);
              return Number.isFinite(num) ? num : null;
            })
            .filter((value) => value !== null)
        : [];
      const ys = Array.isArray(shape.y)
        ? shape.y
            .map((value) => {
              const num = Number(value);
              return Number.isFinite(num) ? num : null;
            })
            .filter((value) => value !== null)
        : [];
      if (xs.length < 3 || ys.length < 3) return null;
      const count = Math.min(xs.length, ys.length);
      const trimmedX = xs.slice(0, count);
      const trimmedY = ys.slice(0, count);
      const area = polygonAreaXY(trimmedX, trimmedY);
      if (area <= 0) return null;
      return { x: trimmedX, y: trimmedY, area };
    }

    function shapeMatchesRanges(area, ranges) {
      return ranges.some(([min, max]) => {
        if (area < min) return false;
        if (!Number.isFinite(max)) return true;
        return area < max;
      });
    }

    function filterFootprints(defects) {
      const ranges = computeSizeRanges();
      if (!ranges.length) return [];
      const filtered = [];
      defects.forEach((defect) => {
        if (!defect || typeof defect !== "object") return;
        const shapes = Array.isArray(defect.coords) ? defect.coords : [];
        const filteredShapes = [];
        shapes.forEach((shape) => {
          const normalized = normalizeShape(shape);
          if (!normalized) return;
          if (!shapeMatchesRanges(normalized.area, ranges)) return;
          filteredShapes.push({
            x: normalized.x,
            y: normalized.y,
          });
        });
        if (!filteredShapes.length) return;
        filtered.push({
          ...defect,
          coords: filteredShapes,
        });
      });
      return filtered;
    }

    const load = Utils.debounce(async () => {
      LoadingOverlay.show();
      try {
        const params = {
          page: state.page,
        };
        if (state.class_names && state.class_names.length) params.class_name = [...state.class_names];
        if (state.phase) params.phase = state.phase;
        if (state.magnitude_min) params.magnitude_min = state.magnitude_min;
        if (state.magnitude_max) params.magnitude_max = state.magnitude_max;
        if (state.severity_min) params.severity_min = state.severity_min;
        if (state.severity_max) params.severity_max = state.severity_max;
        if (state.position_min) params.position_min = state.position_min;
        if (state.position_max) params.position_max = state.position_max;
        if (state.size_min) params.size_min = state.size_min;
        if (state.size_max) params.size_max = state.size_max;
        if (state.size_buckets instanceof Set) {
          const bucketSelection = Array.from(state.size_buckets);
          if (bucketSelection.length === 0) {
            params.size_bucket = ["__none__"];
          } else if (bucketSelection.length < HEATMAP_BUCKETS.length) {
            params.size_bucket = bucketSelection;
          }
        }

        const data = await Api.get("defects", params);
        state.pageInfo = data.page_info || null;
        const byType = data.by_type || [];
        updateTypeOptions(byType);
        renderSummary(data.page_info, byType);
        renderCharts(data, byType);
        renderFootprints(data);
        renderDecisionSummary(data.decision_summary);
        const rows = data.rows || [];
        renderTable(rows);
        maybeAlertForSelectedReel(rows);
        renderPagination();
      } catch (err) {
        console.error("Defect explorer load failed", err);
        if (tableBody) {
          tableBody.innerHTML = `<tr><td colspan="10">Failed to load defects: ${err.message}</td></tr>`;
        }
      } finally {
        LoadingOverlay.hide();
      }
    }, FETCH_DEBOUNCE_MS);

    function init() {
      typeSelect = Utils.qs("#defectTypeFilter");
      phaseSelect = Utils.qs("#defectPhaseFilter");
      magnitudeMin = Utils.qs("#magnitudeMin");
      magnitudeMax = Utils.qs("#magnitudeMax");
      severityMin = Utils.qs("#severityMin");
      severityMax = Utils.qs("#severityMax");
      positionMin = Utils.qs("#positionMin");
      positionMax = Utils.qs("#positionMax");
      sizeMinInput = Utils.qs("#sizeMin");
      sizeMaxInput = Utils.qs("#sizeMax");
      tableBody = Utils.qs("#defectTable tbody");
      paginationEl = Utils.qs("#defectPagination");
      summaryTotalEl = Utils.qs("[data-defect-total]");
      summaryTypesEl = Utils.qs("#defectSummaryTypes");
      decisionTotalEl = Utils.qs("[data-decision-total]");
      decisionPassEl = Utils.qs("[data-decision-pass]");
      decisionFailEl = Utils.qs("[data-decision-fail]");
      decisionUnidentifiedEl = Utils.qs("[data-decision-unidentified]");
      tabScope = Utils.qs("#tab-defects");
      chipsEl = Utils.qs("#defectLocalChips");

      if (typeSelect) {
        typeSelect.addEventListener("change", () => {
          const value = typeSelect.value;
          if (!value) return;
          addTypeFilter(value);
          typeSelect.value = "";
        });
      }

      [
        [phaseSelect, "phase"],
        [magnitudeMin, "magnitude_min"],
        [magnitudeMax, "magnitude_max"],
        [severityMin, "severity_min"],
        [severityMax, "severity_max"],
        [positionMin, "position_min"],
        [positionMax, "position_max"],
        [sizeMinInput, "size_min"],
        [sizeMaxInput, "size_max"],
      ].forEach(([el, key]) => {
        if (!el) return;
        el.addEventListener("input", () => handleLocalFilterChange(key, el.value));
        el.addEventListener("change", () => handleLocalFilterChange(key, el.value));
      });

      if (chipsEl) {
        chipsEl.addEventListener("click", (event) => {
          const button = event.target.closest(".chip-remove");
          if (!button) return;
          const chipEl = button.closest(".filter-chip");
          if (!chipEl) return;
          const key = chipEl.dataset.key;
          const value = chipEl.dataset.value || "";
          clearLocalFilter(key, value);
        });
      }
    }

    function activate() {
      if (chipsEl) {
        chipsEl.classList.add("hidden");
      }
      load.flush();
    }

    function deactivate() {
      resetLocalFilters();
      if (chipsEl) {
        chipsEl.innerHTML = "";
        chipsEl.classList.add("hidden");
      }
    }

    function onFiltersUpdated() {
      state.page = 1;
      load();
    }

    function handleLocalFilterChange(key, value) {
      if (updating) return;
      state[key] = value || "";
      state.page = 1;
      renderDefectChips();
      load();
    }

    function addTypeFilter(rawValue) {
      const value = (rawValue || "").trim();
      if (!value) return;
      if (state.class_names.includes(value)) return;
      state.class_names.push(value);
      state.page = 1;
      renderDefectChips();
      load();
    }

    function clearLocalFilter(key, value) {
      updating = true;
      switch (key) {
        case "class_name":
          state.class_names = state.class_names.filter((item) => item !== value);
          break;
        case "phase":
          state.phase = "";
          if (phaseSelect) phaseSelect.value = "";
          break;
        case "magnitude":
          state.magnitude_min = "";
          state.magnitude_max = "";
          if (magnitudeMin) magnitudeMin.value = "";
          if (magnitudeMax) magnitudeMax.value = "";
          break;
        case "severity":
          state.severity_min = "";
          state.severity_max = "";
          if (severityMin) severityMin.value = "";
          if (severityMax) severityMax.value = "";
          break;
        case "position":
          state.position_min = "";
          state.position_max = "";
          if (positionMin) positionMin.value = "";
          if (positionMax) positionMax.value = "";
          break;
        case "size_range":
          state.size_min = "";
          state.size_max = "";
          if (sizeMinInput) sizeMinInput.value = "";
          if (sizeMaxInput) sizeMaxInput.value = "";
          break;
        case "size_buckets":
          state.size_buckets = new Set(defaultBucketKeys);
          break;
        default:
          break;
      }
      updating = false;
      state.page = 1;
      renderDefectChips();
      load();
    }

    function updateTypeOptions(byType) {
      if (!typeSelect) return;
      const entries = Array.isArray(byType)
        ? byType
            .map((item) => (item && item.class ? String(item.class).trim() : ""))
            .filter(Boolean)
        : [];

      if (!state.class_names.length) {
        typeOptionCache = new Set(entries);
      } else {
        entries.forEach((cls) => {
          if (cls) typeOptionCache.add(cls);
        });
      }

      const sorted = Array.from(typeOptionCache).sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base" })
      );
      const frag = document.createDocumentFragment();
      const defaultOption = document.createElement("option");
      defaultOption.value = "";
      defaultOption.textContent = "Add type filter";
      frag.appendChild(defaultOption);
      sorted.forEach((cls) => {
        const option = document.createElement("option");
        option.value = cls;
        option.textContent = cls;
        frag.appendChild(option);
      });
      typeSelect.innerHTML = "";
      typeSelect.appendChild(frag);
      typeSelect.value = "";
    }

    function resetLocalFilters() {
      updating = true;
      state.class_names = [];
      typeOptionCache = new Set();
      state.phase = "";
      state.magnitude_min = "";
      state.magnitude_max = "";
      state.severity_min = "";
      state.severity_max = "";
      state.position_min = "";
      state.position_max = "";
      state.size_min = "";
      state.size_max = "";
      state.size_buckets = new Set(defaultBucketKeys);
      state.page = 1;
      state.pageInfo = null;
      if (typeSelect) typeSelect.value = "";
      if (phaseSelect) phaseSelect.value = "";
      if (magnitudeMin) magnitudeMin.value = "";
      if (magnitudeMax) magnitudeMax.value = "";
      if (severityMin) severityMin.value = "";
      if (severityMax) severityMax.value = "";
      if (positionMin) positionMin.value = "";
      if (positionMax) positionMax.value = "";
      if (sizeMinInput) sizeMinInput.value = "";
      if (sizeMaxInput) sizeMaxInput.value = "";
      updating = false;
      renderDefectChips();
    }

    function renderDefectChips() {
      if (!chipsEl) return;
      const isActive = Router.current && Router.current() === "defects";
      const chips = [];

      state.class_names.forEach((name) => {
        chips.push({ key: "class_name", value: name, label: `Type: ${name}` });
      });

      if (state.phase) {
        chips.push({ key: "phase", label: `Phase: ${state.phase}` });
      }

      const magnitudeLabel = buildRangeLabel("Magnitude", state.magnitude_min, state.magnitude_max);
      if (magnitudeLabel) {
        chips.push({ key: "magnitude", label: magnitudeLabel });
      }

      const severityLabel = buildRangeLabel("Severity", state.severity_min, state.severity_max);
      if (severityLabel) {
        chips.push({ key: "severity", label: severityLabel });
      }

      const positionLabel = buildRangeLabel("Position", state.position_min, state.position_max);
      if (positionLabel) {
        chips.push({ key: "position", label: positionLabel });
      }

      const sizeRangeLabel = buildRangeLabel("Size", state.size_min, state.size_max);
      if (sizeRangeLabel) {
        chips.push({ key: "size_range", label: sizeRangeLabel });
      }

      const bucketLabel = buildBucketChipLabel();
      if (bucketLabel) {
        chips.push({ key: "size_buckets", label: bucketLabel });
      }

      if (!chips.length || !isActive) {
        chipsEl.innerHTML = "";
        chipsEl.classList.add("hidden");
        return;
      }

      const html = chips
        .map((chip) => {
          const attrs = [`data-key=\"${chip.key}\"`];
          if (chip.value) attrs.push(`data-value=\"${chip.value}\"`);
          return `
            <span class="filter-chip" ${attrs.join(" ")}>
              <span>${chip.label}</span>
              <button type="button" class="chip-remove" aria-label="Clear ${chip.label}">&times;</button>
            </span>
          `;
        })
        .join("");

      chipsEl.innerHTML = html;
      chipsEl.classList.remove("hidden");
    }

    function buildRangeLabel(prefix, minValue, maxValue) {
      const hasMin = minValue !== undefined && minValue !== null && `${minValue}`.trim() !== "";
      const hasMax = maxValue !== undefined && maxValue !== null && `${maxValue}`.trim() !== "";
      if (!hasMin && !hasMax) return "";
      if (hasMin && hasMax) return `${prefix}: ${minValue} – ${maxValue}`;
      if (hasMin) return `${prefix} ≥ ${minValue}`;
      return `${prefix} ≤ ${maxValue}`;
    }

    function buildBucketChipLabel() {
      if (!(state.size_buckets instanceof Set)) return "";
      if (state.size_buckets.size === 0) return "Size buckets: None";
      if (state.size_buckets.size === defaultBucketKeys.length) return "";
      const labels = HEATMAP_BUCKETS.filter((bucket) => state.size_buckets.has(bucket.key)).map(
        (bucket) => bucket.label
      );
      if (!labels.length) return "Size buckets: None";
      const preview = labels.slice(0, 4).join(", ");
      const remainder = labels.length > 4 ? ` +${labels.length - 4}` : "";
      return `Size buckets: ${preview}${remainder}`;
    }

    function handleLegendBucketChange(disabledBuckets) {
      const nextEnabled = new Set(defaultBucketKeys);
      if (disabledBuckets instanceof Set) {
        disabledBuckets.forEach((key) => nextEnabled.delete(key));
      } else if (Array.isArray(disabledBuckets)) {
        disabledBuckets.forEach((key) => nextEnabled.delete(key));
      }
      if (setsEqual(nextEnabled, state.size_buckets)) return;
      state.size_buckets = nextEnabled;
      state.page = 1;
      renderDefectChips();
      load();
    }

    function setsEqual(a, b) {
      if (!(a instanceof Set) || !(b instanceof Set)) return false;
      if (a.size !== b.size) return false;
      for (const value of a) {
        if (!b.has(value)) return false;
      }
      return true;
    }

    function renderCharts(data, byTypeOverride) {
      const byType = byTypeOverride || data.by_type || [];
      const magnitude = data.magnitude_hist || [];
      const severity = data.severity_hist || [];
      const position = data.position_hist || [];

      Plotly.react(
        "defectTypeChart",
        [
          {
            type: "bar",
            x: byType.map((item) => item.class),
            y: byType.map((item) => item.count),
            marker: { color: "#ea580c" },
          },
        ],
        { title: "Defects by Type", margin: { t: 40, l: 40, r: 20, b: 80 } },
        { responsive: true }
      );

      Plotly.react(
        "defectMagnitudeChart",
        [
          {
            type: "bar",
            x: magnitude.map((item) => item.bin),
            y: magnitude.map((item) => item.count),
            marker: { color: "#10b981" },
          },
        ],
        { title: "Magnitude Distribution", margin: { t: 40, l: 40, r: 20, b: 60 } },
        { responsive: true }
      );

      Plotly.react(
        "defectSeverityChart",
        [
          {
            type: "bar",
            x: severity.map((item) => item.bin),
            y: severity.map((item) => item.count),
            marker: { color: "#8b5cf6" },
          },
        ],
        { title: "Severity Distribution", margin: { t: 40, l: 40, r: 20, b: 60 } },
        { responsive: true }
      );

      Plotly.react(
        "defectPositionChart",
        [
          {
            type: "bar",
            x: position.map((item) => item.bin),
            y: position.map((item) => item.count),
            marker: { color: "#facc15" },
          },
        ],
        { title: "Position Distribution", margin: { t: 40, l: 40, r: 20, b: 80 } },
        { responsive: true }
      );
    }

    function renderSummary(pageInfo, byType) {
      if (summaryTotalEl) {
        const total = pageInfo && typeof pageInfo.total === "number" ? pageInfo.total : null;
        summaryTotalEl.textContent = total === null ? "--" : Utils.formatNumber(total);
      }

      if (summaryTypesEl) {
        if (!byType.length) {
          summaryTypesEl.innerHTML = "<span class='badge'>No defect types</span>";
          return;
        }
        const items = byType.map(
          (entry) =>
            `<span class="badge">${entry.class || "Unknown"}: ${Utils.formatNumber(entry.count)}</span>`
        );
        summaryTypesEl.innerHTML = items.join("");
      }
    }

    function renderDecisionSummary(summary) {
      decisionSummary = sanitizeDecisionSummary(summary);
      updateDecisionSummaryDisplay();
    }

    function sanitizeDecisionSummary(summary) {
      if (!summary || typeof summary !== "object") {
        return { total: 0, pass: 0, fail: 0, unidentified: 0 };
      }
      const ensure = (value) => (Number.isFinite(value) ? Number(value) : 0);
      const sanitized = {
        total: ensure(summary.total),
        pass: ensure(summary.pass),
        fail: ensure(summary.fail),
        unidentified: ensure(summary.unidentified),
      };
      if (!Number.isFinite(summary.total)) {
        sanitized.total = sanitized.pass + sanitized.fail + sanitized.unidentified;
      }
      return sanitized;
    }

    function updateDecisionSummaryDisplay() {
      if (!decisionTotalEl && !decisionPassEl && !decisionFailEl && !decisionUnidentifiedEl) return;
      if (!decisionSummary) {
        if (decisionTotalEl) decisionTotalEl.textContent = "--";
        if (decisionPassEl) decisionPassEl.textContent = "--";
        if (decisionFailEl) decisionFailEl.textContent = "--";
        if (decisionUnidentifiedEl) decisionUnidentifiedEl.textContent = "--";
        return;
      }
      if (decisionTotalEl) decisionTotalEl.textContent = Utils.formatNumber(decisionSummary.total || 0);
      if (decisionPassEl) decisionPassEl.textContent = Utils.formatNumber(decisionSummary.pass || 0);
      if (decisionFailEl) decisionFailEl.textContent = Utils.formatNumber(decisionSummary.fail || 0);
      if (decisionUnidentifiedEl) {
        decisionUnidentifiedEl.textContent = Utils.formatNumber(decisionSummary.unidentified || 0);
      }
    }

    function renderTable(rows) {
      if (!tableBody) return;
      if (!rows.length) {
        tableBody.innerHTML = "<tr><td colspan='10'>No defects match the current filters.</td></tr>";
        return;
      }
      tableBody.innerHTML = rows
        .map(
          (row) => `
            <tr>
              <td>${row.reel_code || ""}</td>
              <td>${formatTime(row.defect_time)}</td>
              <td>${row.order_number || ""}</td>
              <td>${row.job_name || ""}</td>
              <td>${row.class_name || ""}</td>
              <td>${Utils.formatNumber(row.magnitude_value, 3)}</td>
              <td>${Utils.formatNumber(row.severity_value, 2)}</td>
              <td>${Utils.formatNumber(row.format_position, 1)}</td>
              <td>
                ${
                  row.image_src
                    ? `<img src="${urlForStatic(row.image_src)}" alt="defect" data-label="${[row.job_name, row.order_number, row.defect_time]
                        .filter(Boolean)
                        .join(" · ")}" data-index="${row.defect_id || ""}" data-defect-id="${row.defect_id || ""}" data-decision="${(row.qc_decision || "").toLowerCase()}"
                        onclick="showImageModal('${urlForStatic(
                        row.image_src
                      )}', this)" loading="lazy" decoding="async">`
                    : ""
                }
              </td>
              <td class="defect-decision-cell" data-defect-id="${row.defect_id || ""}" data-decision="${(row.qc_decision || "").toLowerCase()}">
                ${buildDecisionCellContent(row.qc_decision)}
              </td>
            </tr>
          `
        )
        .join("");
    }

    function maybeAlertForSelectedReel(rows) {
      if (!Filters || typeof Filters.getReelIds !== "function") return;
      const reelIds = Filters.getReelIds();
      const reelCodes = typeof Filters.getReelCodes === "function" ? Filters.getReelCodes() : [];
      if ((!reelIds || !reelIds.length) && (!reelCodes || !reelCodes.length)) {
        lastReelAlertSignature = "";
        return;
      }
      const normalizedSelection = (reelIds && reelIds.length ? reelIds : reelCodes)
        .map((value) => String(value || "").trim())
        .filter(Boolean)
        .sort()
        .join(",");
      const rowsArray = Array.isArray(rows) ? rows : [];
      if (!rowsArray.length) {
        const signature = `empty:${normalizedSelection}`;
        if (signature !== lastReelAlertSignature) {
          window.alert("The selected reel has no defects in the current filters.");
          lastReelAlertSignature = signature;
        }
        return;
      }
      const hasPending = rowsArray.some((row) => !row.qc_decision);
      if (!hasPending) {
        const signature = `complete:${normalizedSelection}`;
        if (signature !== lastReelAlertSignature) {
          window.alert("The selected reel has already been fully labeled.");
          lastReelAlertSignature = signature;
        }
        return;
      }
      lastReelAlertSignature = "";
    }

    function renderPagination() {
      if (!paginationEl) return;
      Utils.renderPagination(paginationEl, state.pageInfo, (page) => {
        state.page = page;
        load.flush();
      });
    }

    function renderFootprints(data) {
      if (!tabScope) return;
      const heatmapEl = Utils.qs("#heatmap-defect-explorer");
      const maskEl = Utils.qs("#mask-heatmap-defect-explorer");
      const coordsEl = Utils.qs("#mask-heatmap-defect-explorer-coords");
      if (!heatmapEl || !maskEl) return;

      const reel = buildFootprintReel(data);
      const heatmapRows = Array.isArray(data.heatmap_rows) && data.heatmap_rows.length
        ? data.heatmap_rows
        : data.rows || [];
      const defects = extractDefectFootprints(heatmapRows);
      const masks = Array.isArray(data.masks) ? data.masks : [];
      const referenceImages = Array.isArray(data.reference_images) ? data.reference_images : [];
      const latestReference = referenceImages.length ? referenceImages[0] : null;
      const referenceBackground =
        latestReference && latestReference.image_src ? urlForStatic(latestReference.image_src) : null;
      const filteredDefects = filterFootprints(defects);

      const filterEnabled =
        state.size_buckets instanceof Set ? Array.from(state.size_buckets) : defaultBucketKeys.slice();
      JobHeatmap.attach(tabScope, {
        reel,
        defects: filteredDefects,
        referenceBackground,
        bucketState: { enabledBuckets: filterEnabled },
        onLegendChange: handleLegendBucketChange,
      });
      MaskHeatmap.attach(tabScope, { reel, masks, referenceBackground });

      renderMaskCoords(coordsEl, masks);
    }

    function buildFootprintReel(data) {
      const lengths = [];
      const widths = [];
      const rows = Array.isArray(data.rows) ? data.rows : [];

      const lengthHint = Number(data.format_length);
      if (Number.isFinite(lengthHint)) lengths.push(lengthHint);
      const widthHint = Number(data.format_width);
      if (Number.isFinite(widthHint)) widths.push(widthHint);

      rows.forEach((row) => {
        const rowLength = Number(row.format_length);
        const rowWidth = Number(row.format_width);
        if (Number.isFinite(rowLength)) lengths.push(rowLength);
        if (Number.isFinite(rowWidth)) widths.push(rowWidth);
      });

      const reelLength = lengths.find((val) => Number.isFinite(val));
      const reelWidth = widths.find((val) => Number.isFinite(val));

      return {
        reel_id: "defect-explorer",
        format_length: Number.isFinite(reelLength) ? reelLength : null,
        format_width: Number.isFinite(reelWidth) ? reelWidth : null,
      };
    }

    function extractDefectFootprints(rows) {
      return rows
        .filter((row) => Array.isArray(row.coords) && row.coords.length)
        .map((row) => ({
          defect_id: row.defect_id,
          reel_id: row.reel_id,
          magnitude_value: row.magnitude_value,
          severity_value: row.severity_value,
          coords: row.coords,
        }));
    }

    function renderMaskCoords(container, masks) {
      if (!container) return;
      if (!masks.length) {
        container.innerHTML = "<span class='badge'>No mask coordinates yet.</span>";
        return;
      }
      const sorted = [...masks].sort((a, b) => {
        const at = a && a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const bt = b && b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return bt - at;
      });
      const html = sorted
        .map((mask, index) => {
          const labelParts = [];
          if (mask.xml_id) labelParts.push(mask.xml_id);
          if (mask.sensitivitysetid) labelParts.push(mask.sensitivitysetid);
          if (mask.timestamp) labelParts.push(formatTime(mask.timestamp));
          const label = labelParts.length ? labelParts.join(" · ") : `Mask ${index + 1}`;
          const coordsText = formatMaskCoords(mask.coords);
          const display = coordsText ? Utils.escapeHtml(coordsText) : "—";
          return `
            <div class="mask-coords-row">
              <span class="mask-coords-label">${Utils.escapeHtml(label)}</span>
              <code>${display}</code>
            </div>
          `;
        })
        .join("");
      container.innerHTML = html;
    }

    function formatMaskCoords(raw) {
      if (raw === null || raw === undefined) return "";
      if (typeof raw === "string") return raw.trim();
      try {
        return JSON.stringify(raw);
      } catch (err) {
        return String(raw);
      }
    }

    return { init, activate, deactivate, onFiltersUpdated };
  })();

