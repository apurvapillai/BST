(function () {
  const FETCH_DEBOUNCE_MS = 400;

  const MM_TO_IN = 25.4;

  const Utils = {
    qs(selector, scope = document) {
      return scope.querySelector(selector);
    },
    qsa(selector, scope = document) {
      return Array.from(scope.querySelectorAll(selector));
    },
    debounce(fn, wait = 200) {
      let timer;
      const debounced = function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), wait);
      };
      debounced.flush = function (...args) {
        clearTimeout(timer);
        fn.apply(this, args);
      };
      return debounced;
    },
    formatNumber(value, digits = 0) {
      if (value === null || value === undefined || Number.isNaN(value)) return "--";
      return Number(value).toLocaleString(undefined, {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
    },
    formatMeters(value) {
      if (value === null || value === undefined) return "--";
      return `${Utils.formatNumber(value, 2)} m`;
    },
    toInches(value) {
      const num = Number(value);
      return Number.isFinite(num) ? num / MM_TO_IN : null;
    },
    normalizeDateInput(value) {
      if (!value) return "";
      return value.length === 16 ? `${value}:00` : value;
    },
    updateUrlQuery(params) {
      const url = new URL(window.location.href);
      url.search = "";
      Object.entries(params).forEach(([key, value]) => {
        if (value === undefined || value === null) return;
        if (Array.isArray(value)) {
          value
            .filter((item) => item !== undefined && item !== null && item !== "")
            .forEach((item) => url.searchParams.append(key, item));
          return;
        }
        if (value !== "") {
          url.searchParams.set(key, value);
        }
      });
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    },
    renderPagination(container, pageInfo, onPageChange) {
      container.innerHTML = "";
      if (!pageInfo || pageInfo.total_pages <= 1) {
        if (pageInfo && pageInfo.total !== undefined) {
          const span = document.createElement("span");
          span.textContent = `${pageInfo.total} results`;
          container.appendChild(span);
        }
        return;
      }

      const info = document.createElement("span");
      info.textContent = `Page ${pageInfo.page} / ${pageInfo.total_pages}`;
      container.appendChild(info);

      const prev = document.createElement("button");
      prev.textContent = "Prev";
      prev.disabled = pageInfo.page <= 1;
      prev.addEventListener("click", () => onPageChange(pageInfo.page - 1));
      container.appendChild(prev);

      const next = document.createElement("button");
      next.textContent = "Next";
      next.disabled = pageInfo.page >= pageInfo.total_pages;
      next.addEventListener("click", () => onPageChange(pageInfo.page + 1));
      container.appendChild(next);

      const total = document.createElement("span");
      total.textContent = `${pageInfo.total} results`;
      container.appendChild(total);
    },
    escapeHtml(value) {
      if (value === null || value === undefined) return "";
      return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    },
  };

  const ORDER_NONE = "__NONE__";
  const MODAL_SCALE_STEP = 0.12;
  const MODAL_MIN_SCALE = 0.5;
  const MODAL_MAX_SCALE = 4;
  const FOOTPRINT_SCALE_STEP = 0.12;
  const FOOTPRINT_MIN_SCALE = 0.4;
  const FOOTPRINT_MAX_SCALE = 3;
  let modalImageScale = 1;
  let footprintModalScale = 1;
  const footprintModalState = {
    source: null,
    placeholder: null,
    stage: null,
  };
  const SEVERITY_DESCRIPTIONS = {
    0: "Perfect",
    1: "Tiny cosmetic · ship",
    2: "Noticeable · ship",
    3: "Borderline / spec dependent",
    4: "Reject",
    5: "Severe reject",
  };
  const CONFIDENCE_DESCRIPTIONS = {
    1: "Low",
    2: "Medium",
    3: "High",
  };

  function isMobileViewport() {
    return window.matchMedia("(max-width: 1024px)").matches;
  }

  function withResponsiveLayout(layout) {
    if (isMobileViewport()) {
      return { ...layout, dragmode: "pan" };
    }
    return layout;
  }

  function plotlyConfig(overrides = {}) {
    const mobile = isMobileViewport();
    return {
      responsive: true,
      scrollZoom: !mobile,
      doubleClick: mobile ? false : "reset+autosize",
      staticPlot: mobile,
      displayModeBar: mobile ? false : undefined,
      ...overrides,
    };
  }

  function scrollToTopSoon() {
    window.requestAnimationFrame(() => {
      setTimeout(() => {
        window.scrollTo({ top: 0, behavior: "smooth" });
      }, 30);
    });
  }

  function paddedRange(values, pad = 10) {
    const nums = (values || []).filter((val) => Number.isFinite(val));
    if (!nums.length) return null;
    const minVal = Math.min(...nums);
    const maxVal = Math.max(...nums);
    const lower = minVal - pad;
    const upper = maxVal + pad;
    return [lower, upper];
  }

  function formatTime(value, fallback = "—") {
    if (!value) return fallback;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return fallback;
    return date.toLocaleString();
  }
  function buildDecisionBadge(decision) {
    const normalized = (decision || "").toLowerCase();
    if (normalized === "pass" || normalized === "fail") {
      const label = normalized === "pass" ? "Pass" : "Fail";
      return `<span class="defect-decision-badge defect-decision-badge-${normalized}">${label}</span>`;
    }
    if (normalized === "uncertain") {
      return '<span class="defect-decision-badge defect-decision-badge-uncertain">Uncertain</span>';
    }
    return "";
  }

  function buildDecisionCellContent(decision) {
    const normalized = (decision || "").toLowerCase();
    if (normalized === "pass" || normalized === "fail") {
      return buildDecisionBadge(normalized);
    }
    if (normalized === "uncertain") {
      return '<span class="defect-decision-badge defect-decision-badge-uncertain">Uncertain</span>';
    }
    return '<span class="defect-decision-badge defect-decision-badge-pending">Pending</span>';
  }

  const backgroundImageCache = new Map();

  function requestBackgroundImage(url, callback) {
    if (!url || typeof callback !== "function") return;
    let entry = backgroundImageCache.get(url);
    if (entry) {
      if (entry.status === "loaded") {
        callback(entry.image);
        return;
      }
      if (entry.status === "loading") {
        entry.callbacks.push(callback);
        return;
      }
      if (entry.status === "error") {
        callback(null);
        return;
      }
    } else {
      const img = new Image();
      entry = { image: img, status: "loading", callbacks: [callback] };
      backgroundImageCache.set(url, entry);
      img.decoding = "async";
      img.crossOrigin = "anonymous";
      img.onload = () => {
        entry.status = "loaded";
        entry.callbacks.forEach((cb) => cb(img));
        entry.callbacks = [];
      };
      img.onerror = () => {
        entry.status = "error";
        entry.callbacks.forEach((cb) => cb(null));
        entry.callbacks = [];
      };
      img.src = url;
      return;
    }
  }

  const HEATMAP_BUCKETS = [
    { key: "A1", min: 0, max: 100, label: "<100", fill: "rgba(30, 64, 175, 0.5)", stroke: "rgba(30, 58, 138, 0.95)", legend: "#1d4ed8" },
    { key: "A2", min: 100, max: 500, label: "100-500", fill: "rgba(37, 99, 235, 0.5)", stroke: "rgba(29, 78, 216, 0.95)", legend: "#2563eb" },
    { key: "A3", min: 500, max: 1000, label: "500-1000", fill: "rgba(59, 130, 246, 0.5)", stroke: "rgba(37, 99, 235, 0.95)", legend: "#3b82f6" },
    { key: "A4", min: 1000, max: 10000, label: "1000-10000", fill: "rgba(14, 165, 233, 0.2)", stroke: "rgba(2, 132, 199, 0.95)", legend: "#0ea5e9" },
    { key: "A5", min: 10000, max: 50000, label: "10000-50000", fill: "rgba(6, 182, 212, 0.2)", stroke: "rgba(8, 145, 178, 0.95)", legend: "#06b6d4" },
    { key: "A6", min: 50000, max: 100000, label: "50000-100000", fill: "rgba(16, 185, 129, 0.2)", stroke: "rgba(5, 150, 105, 0.95)", legend: "#10b981" },
    { key: "A7", min: 100000, max: 250000, label: "100000-250000", fill: "rgba(34, 197, 94, 0.2)", stroke: "rgba(22, 163, 74, 0.95)", legend: "#22c55e" },
    { key: "A8", min: 250000, max: 500000, label: "250000-500000", fill: "rgba(250, 204, 21, 0.2)", stroke: "rgba(234, 179, 8, 0.95)", legend: "#facc15" },
    { key: "A9", min: 500000, max: 1000000, label: "500000-1000000", fill: "rgba(249, 115, 22, 0.01)", stroke: "rgba(234, 88, 12, 0.95)", legend: "#f97316" },
    { key: "A10", min: 1000000, max: Infinity, label: ">1000000", fill: "rgba(220, 38, 38, 0.01)", stroke: "rgba(185, 28, 28, 0.95)", legend: "#dc2626" },
  ];


  const JobHeatmap = (() => {
    const PADDING = 24;
    const FALLBACK_SIZE = 360;
    const reelState = new Map();

    function polygonArea(xs, ys) {
      const len = Math.min(xs.length, ys.length);
      if (len < 3) return 0;
      let area = 0;
      for (let i = 0, j = len - 1; i < len; j = i, i += 1) {
        area += (xs[j] + xs[i]) * (ys[j] - ys[i]);
      }
      return Math.abs(area) / 2;
    }

    function domId(reel) {
      const id = reel && reel.reel_id !== undefined && reel.reel_id !== null ? reel.reel_id : "unknown";
      return `heatmap-${id}`;
    }

    function buildDefectKey(defect, fallbackIndex, reel) {
      if (!defect) {
        return `reel-${reel?.reel_id ?? "unknown"}-anon-${fallbackIndex}`;
      }
      if (defect.defect_key) {
        return String(defect.defect_key);
      }
      const reelId = defect.reel_id ?? reel?.reel_id ?? "unknown";
      if (defect.defect_id !== undefined && defect.defect_id !== null) {
        return `reel-${reelId}-defect-${defect.defect_id}`;
      }
      return `reel-${reelId}-anon-${fallbackIndex}`;
    }

    function attach(scope, summary) {
      if (!scope || !summary) return;
      const reel = summary.reel || {};
      const container = scope.querySelector(`#${domId(reel)}`);
      if (!container) return;
      const defects = Array.isArray(summary.defects) ? summary.defects : [];
      const key = reel.reel_id ?? domId(reel);
      let state = reelState.get(key);
      if (!state) {
        state = {
          disabledBuckets: new Set(),
          backgroundImage: null,
          backgroundImageUrl: null,
          backgroundImageLoading: false,
          referenceBackground: null,
          onLegendChange: null,
        };
        reelState.set(key, state);
      }
      const bucketState = summary.bucketState;
      if (bucketState) {
        if (Array.isArray(bucketState.enabledBuckets) && bucketState.enabledBuckets.length) {
          const enabledSet = new Set(bucketState.enabledBuckets);
          state.disabledBuckets = new Set(
            HEATMAP_BUCKETS.filter((bucket) => !enabledSet.has(bucket.key)).map((bucket) => bucket.key)
          );
        } else if (Array.isArray(bucketState.disabledBuckets)) {
          state.disabledBuckets = new Set(bucketState.disabledBuckets);
        }
      }
      state.onLegendChange = typeof summary.onLegendChange === "function" ? summary.onLegendChange : null;
      const referenceBackground = summary.referenceBackground || summary.reference_background || null;
      const normalizedBackground = referenceBackground || null;
      if (state.referenceBackground !== normalizedBackground) {
        state.referenceBackground = normalizedBackground;
        if (state.backgroundImageUrl !== normalizedBackground) {
          state.backgroundImageUrl = normalizedBackground;
          state.backgroundImage = null;
        }
        state.backgroundImageLoading = false;
      }
      window.requestAnimationFrame(() => render(container, reel, defects, state));
    }

    function render(container, reel, defects, state) {
      state.disabledBuckets = state.disabledBuckets || new Set();
      const rawWidth = Number(reel?.format_width);
      const rawLength = Number(reel?.format_length);
      const hasDimensionsOriginal =
        Number.isFinite(rawWidth) && Number.isFinite(rawLength) && rawWidth > 0 && rawLength > 0;
      let workingWidth = rawWidth;
      let workingLength = rawLength;
      const referenceBackground = state.referenceBackground;
      if (!referenceBackground) {
        state.backgroundImage = null;
        state.backgroundImageUrl = null;
        state.backgroundImageLoading = false;
      } else if (state.backgroundImageUrl !== referenceBackground) {
        state.backgroundImageUrl = referenceBackground;
        state.backgroundImage = null;
        state.backgroundImageLoading = false;
      }

      const aggregatesMap = new Map();
      const defectBestBuckets = new Map();
      let globalMinX = Infinity;
      let globalMaxX = -Infinity;
      let globalMinY = Infinity;
      let globalMaxY = -Infinity;

      defects.forEach((defect, defectIndex) => {
        if (!Array.isArray(defect.coords)) return;
        const magnitude = Number(defect.magnitude_value) || 0;
        const severity = Number(defect.severity_value) || 0;
        const defectKey = buildDefectKey(defect, defectIndex, reel);
        defect.coords.forEach((shape) => {
          const xs = Array.isArray(shape.x) ? shape.x.map(Number).filter((n) => Number.isFinite(n)) : [];
          const ys = Array.isArray(shape.y) ? shape.y.map(Number).filter((n) => Number.isFinite(n)) : [];
          const count = Math.min(xs.length, ys.length);
          if (count < 3) return;
          const area = polygonArea(xs, ys);
          const key =
            xs.slice(0, count).map((val) => val.toFixed(1)).join("|") +
            "::" +
            ys.slice(0, count).map((val) => val.toFixed(1)).join("|");
          let entry = aggregatesMap.get(key);
          if (!entry) {
            entry = {
              xs: xs.slice(0, count),
              ys: ys.slice(0, count),
              count: 0,
              magnitudeSum: 0,
              severitySum: 0,
              minX: Infinity,
              maxX: -Infinity,
              minY: Infinity,
              maxY: -Infinity,
              area: 0,
            };
            aggregatesMap.set(key, entry);
          }
          entry.count += 1;
          entry.magnitudeSum += magnitude;
          entry.severitySum += severity;
          entry.minX = Math.min(entry.minX, ...xs);
          entry.maxX = Math.max(entry.maxX, ...xs);
          entry.minY = Math.min(entry.minY, ...ys);
          entry.maxY = Math.max(entry.maxY, ...ys);
          entry.area = area;
          const currentBest = defectBestBuckets.get(defectKey);
          if (!currentBest || area > currentBest.area) {
            defectBestBuckets.set(defectKey, { area, bucketKey: bucketForArea(area).key });
          }
          globalMinX = Math.min(globalMinX, entry.minX);
          globalMaxX = Math.max(globalMaxX, entry.maxX);
          globalMinY = Math.min(globalMinY, entry.minY);
          globalMaxY = Math.max(globalMaxY, entry.maxY);
        });
      });

      const aggregates = Array.from(aggregatesMap.values());
      if (!aggregates.length) {
        container.classList.add("heatmap-empty");
        container.innerHTML = "<span class='badge'>No defect coordinates</span>";
        renderLegend(container, reel, [], state, () => {});
        return;
      }

      if (!hasDimensionsOriginal) {
        const widthSpan = globalMaxX - globalMinX;
        const lengthSpan = globalMaxY - globalMinY;
        workingWidth = widthSpan > 0 ? widthSpan : FALLBACK_SIZE / 4;
        workingLength = lengthSpan > 0 ? lengthSpan : FALLBACK_SIZE / 4;
      }

      container.classList.remove("heatmap-empty");
      container.innerHTML = "";

      const dpr = window.devicePixelRatio || 1;
      const availableWidth = container.clientWidth || FALLBACK_SIZE;
      const size = Math.max(PADDING * 4, availableWidth);
      const canvas = document.createElement("canvas");
      canvas.width = size * dpr;
      canvas.height = size * dpr;
      canvas.style.width = `${size}px`;
      canvas.style.height = `${size}px`;

      const ctx = canvas.getContext("2d");
      ctx.scale(dpr, dpr);

      ctx.fillStyle = "#f0f4fb";
      ctx.fillRect(0, 0, size, size);

      ctx.save();
      ctx.translate(size / 2, size / 2);

      const scale = Math.max(workingWidth, workingLength)
        ? (size - PADDING * 2) / Math.max(workingWidth, workingLength)
        : 1;
      const drawWidth = workingWidth * scale;
      const drawLength = workingLength * scale;
      const centerX = hasDimensionsOriginal ? 0 : (globalMinX + globalMaxX) / 2;
      const centerY = hasDimensionsOriginal ? 0 : (globalMinY + globalMaxY) / 2;

      let backgroundImage = null;
      if (referenceBackground) {
        if (state.backgroundImage) {
          backgroundImage = state.backgroundImage;
        } else if (!state.backgroundImageLoading) {
          state.backgroundImageLoading = true;
          requestBackgroundImage(referenceBackground, (img) => {
            state.backgroundImageLoading = false;
            if (!img) {
              if (state.backgroundImageUrl === referenceBackground) {
                state.backgroundImage = null;
              }
              return;
            }
            if (state.referenceBackground !== referenceBackground || !container.isConnected) {
              return;
            }
            state.backgroundImage = img;
            window.requestAnimationFrame(() => {
              if (!container.isConnected) return;
              render(container, reel, defects, state);
            });
          });
        }
      }

      if (backgroundImage) {
        ctx.save();
        ctx.scale(1, -1);
        ctx.drawImage(backgroundImage, -drawWidth / 2, -drawLength / 2, drawWidth, drawLength);
        ctx.restore();
        ctx.fillStyle = "rgba(15, 23, 42, 0.03)";
        ctx.fillRect(-drawWidth / 2, -drawLength / 2, drawWidth, drawLength);
      } else {
        ctx.fillStyle = "#e1e7f5";
        ctx.fillRect(-drawWidth / 2, -drawLength / 2, drawWidth, drawLength);
      }

      ctx.strokeStyle = "#4a5a7a";
      ctx.lineWidth = 1;
      ctx.strokeRect(-drawWidth / 2, -drawLength / 2, drawWidth, drawLength);

      ctx.strokeStyle = "rgba(74, 90, 122, 0.18)";
      ctx.beginPath();
      ctx.moveTo(-drawWidth / 2, 0);
      ctx.lineTo(drawWidth / 2, 0);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, -drawLength / 2);
      ctx.lineTo(0, drawLength / 2);
      ctx.stroke();

      ctx.lineJoin = "round";
      const bucketStats = new Map(
        HEATMAP_BUCKETS.map((bucket) => [
          bucket.key,
          {
            bucket,
            defectTotal: 0,
            polygonCount: 0,
            magnitudeSum: 0,
            severitySum: 0,
            minX: Infinity,
            maxX: -Infinity,
            minY: Infinity,
            maxY: -Infinity,
            areaSum: 0,
          },
        ])
      );

      aggregates.forEach((agg) => {
        const bucket = bucketForArea(agg.area || 0);
        agg.bucketKey = bucket.key;
        const stats = bucketStats.get(bucket.key);
        if (!stats) return;
        stats.polygonCount += 1;
        stats.magnitudeSum += agg.magnitudeSum;
        stats.severitySum += agg.severitySum;
        stats.minX = Math.min(stats.minX, agg.minX);
        stats.maxX = Math.max(stats.maxX, agg.maxX);
        stats.minY = Math.min(stats.minY, agg.minY);
        stats.maxY = Math.max(stats.maxY, agg.maxY);
        stats.areaSum += (agg.area || 0) * agg.count;
      });

      const bucketDefectSets = new Map(HEATMAP_BUCKETS.map((bucket) => [bucket.key, new Set()]));
      defectBestBuckets.forEach((info, defectKey) => {
        if (!info || !info.bucketKey) return;
        const set = bucketDefectSets.get(info.bucketKey);
        if (set) set.add(defectKey);
      });
      bucketDefectSets.forEach((set, key) => {
        const stats = bucketStats.get(key);
        if (stats) {
          stats.defectTotal = set.size;
        }
      });

      aggregates.forEach((agg) => {
        const bucket = bucketForArea(agg.area || 0);
        if (state.disabledBuckets.has(bucket.key)) return;
        ctx.beginPath();
        ctx.moveTo((agg.xs[0] - centerX) * scale, -(agg.ys[0] - centerY) * scale);
        for (let i = 1; i < agg.xs.length; i += 1) {
          ctx.lineTo((agg.xs[i] - centerX) * scale, -(agg.ys[i] - centerY) * scale);
        }
        ctx.closePath();
        ctx.fillStyle = bucket.fill;
        ctx.fill();
        ctx.strokeStyle = bucket.stroke;
        ctx.lineWidth = 0.9;
        ctx.stroke();
      });

      ctx.restore();
      ctx.fillStyle = "#4a5a7a";
      ctx.font = "12px sans-serif";
      ctx.textBaseline = "bottom";
      ctx.textAlign = "left";
      ctx.fillText(`X: ±${Utils.formatNumber(workingWidth / 2, 1)}`, 8, size - 8);
      ctx.textBaseline = "top";
      ctx.textAlign = "right";
      ctx.fillText(`Y: ±${Utils.formatNumber(workingLength / 2, 1)}`, size - 8, 8);

      container.appendChild(canvas);
      renderLegend(
        container,
        reel,
        Array.from(bucketStats.values()),
        state,
        () => render(container, reel, defects, state)
      );
    }

    function bucketForArea(area) {
      const areaValue = Number.isFinite(area) && area > 0 ? area : 0;
      for (let idx = 0; idx < HEATMAP_BUCKETS.length; idx += 1) {
        const bucket = HEATMAP_BUCKETS[idx];
        if (bucket.max === Infinity) return bucket;
        if (areaValue < bucket.max) return bucket;
      }
      return HEATMAP_BUCKETS[HEATMAP_BUCKETS.length - 1];
    }

    function renderLegend(container, reel, bucketStatsArray, state, rerender) {
      const legendEl = document.getElementById(`${domId(reel)}-legend`);
      if (!legendEl) return;
      const statsMap = new Map((bucketStatsArray || []).map((entry) => [entry.bucket.key, entry]));
      const html = HEATMAP_BUCKETS.map((bucket) => {
        const stats = statsMap.get(bucket.key);
        const defectTotal = stats ? stats.defectTotal || 0 : 0;
        const hasData = defectTotal > 0;
        const toggledOff = state.disabledBuckets.has(bucket.key);
        const checkedAttr = toggledOff ? "" : "checked";
        const itemClass = hasData
          ? toggledOff
            ? "disabled"
            : ""
          : "no-data";
        const avgMag = hasData && stats ? stats.magnitudeSum / defectTotal : 0;
        const avgSev = hasData && stats ? stats.severitySum / defectTotal : 0;
        const countLabel = `${defectTotal} defect${defectTotal === 1 ? "" : "s"}`;
        return `
          <label class="heatmap-legend-item ${itemClass}">
            <input type="checkbox" data-bucket="${bucket.key}" ${checkedAttr}>
            <span class="swatch" style="background:${bucket.legend}"></span>
            <span class="legend-label">${bucket.label}</span>
            <span class="legend-count">${countLabel}</span>
            <span class="legend-meta">Mag ${Utils.formatNumber(avgMag, 2)} · Sev ${Utils.formatNumber(avgSev, 2)}</span>
          </label>
        `;
      }).join(" ");

      legendEl.innerHTML = html;
      legendEl.querySelectorAll('input[type="checkbox"]').forEach((input) => {
        input.addEventListener("change", (event) => {
          const bucketKey = event.target.dataset.bucket;
          if (!bucketKey) return;
          if (event.target.checked) {
            state.disabledBuckets.delete(bucketKey);
          } else {
            state.disabledBuckets.add(bucketKey);
          }
          window.requestAnimationFrame(() => rerender());
          if (typeof state.onLegendChange === "function") {
            state.onLegendChange(new Set(state.disabledBuckets));
          }
        });
      });
    }

    return { domId, attach };
  })();

  const MaskHeatmap = (() => {
    const PADDING = 24;
    const FALLBACK_SIZE = 360;
    const MASK_COLOR = {
      fill: "rgba(239, 68, 68, 0.35)",
      stroke: "rgba(185, 28, 28, 0.85)",
    };
    const heatmapState = new Map();

    function domId(reel) {
      const id = reel && reel.reel_id !== undefined && reel.reel_id !== null ? reel.reel_id : "unknown";
      return `mask-heatmap-${id}`;
    }

    function attach(scope, summary) {
      if (!scope || !summary) return;
      const reel = summary.reel || {};
      const container = scope.querySelector(`#${domId(reel)}`);
      if (!container) return;
      const masks = Array.isArray(summary.masks) ? summary.masks : [];
      const key = container.id || domId(reel);
      let state = heatmapState.get(key);
      if (!state) {
        state = {
          backgroundImage: null,
          backgroundImageUrl: null,
          backgroundImageLoading: false,
          referenceBackground: null,
        };
        heatmapState.set(key, state);
      }
      const referenceBackground = summary.referenceBackground || summary.reference_background || null;
      const normalizedBackground = referenceBackground || null;
      if (state.referenceBackground !== normalizedBackground) {
        state.referenceBackground = normalizedBackground;
        if (state.backgroundImageUrl !== normalizedBackground) {
          state.backgroundImageUrl = normalizedBackground;
          state.backgroundImage = null;
        }
        state.backgroundImageLoading = false;
      }
      window.requestAnimationFrame(() => render(container, reel, masks, state));
    }

    function render(container, reel, masks, state) {
      const parsed = collectMasks(masks);
      const rawWidth = Number(reel?.format_width);
      const rawLength = Number(reel?.format_length);
      const hasDimensionsOriginal =
        Number.isFinite(rawWidth) && Number.isFinite(rawLength) && rawWidth > 0 && rawLength > 0;

      let workingWidth = rawWidth;
      let workingLength = rawLength;
      const referenceBackground = state.referenceBackground;
      if (!referenceBackground) {
        state.backgroundImage = null;
        state.backgroundImageUrl = null;
        state.backgroundImageLoading = false;
      } else if (state.backgroundImageUrl !== referenceBackground) {
        state.backgroundImageUrl = referenceBackground;
        state.backgroundImage = null;
        state.backgroundImageLoading = false;
      }

      if (!parsed.shapes.length) {
        const message = hasDimensionsOriginal ? "No mask coordinates" : "Format dimensions unavailable";
        container.classList.add("heatmap-empty");
        container.innerHTML = `<span class='badge'>${message}</span>`;
        return;
      }

      if (!hasDimensionsOriginal) {
        const spanWidth = parsed.bounds.maxX - parsed.bounds.minX;
        const spanLength = parsed.bounds.maxY - parsed.bounds.minY;
        workingWidth = spanWidth > 0 ? spanWidth : FALLBACK_SIZE / 4;
        workingLength = spanLength > 0 ? spanLength : FALLBACK_SIZE / 4;
      }

      container.classList.remove("heatmap-empty");
      container.innerHTML = "";

      const dpr = window.devicePixelRatio || 1;
      const availableWidth = container.clientWidth || FALLBACK_SIZE;
      const size = Math.max(PADDING * 4, availableWidth);
      const canvas = document.createElement("canvas");
      canvas.width = size * dpr;
      canvas.height = size * dpr;
      canvas.style.width = `${size}px`;
      canvas.style.height = `${size}px`;

      const ctx = canvas.getContext("2d");
      ctx.scale(dpr, dpr);

      ctx.fillStyle = "#f0f4fb";
      ctx.fillRect(0, 0, size, size);

      ctx.save();
      ctx.translate(size / 2, size / 2);

      const scale = Math.max(workingWidth, workingLength)
        ? (size - PADDING * 2) / Math.max(workingWidth, workingLength)
        : 1;
      const drawWidth = workingWidth * scale;
      const drawLength = workingLength * scale;
      const bounds = parsed.bounds;
      const centerX = hasDimensionsOriginal ? 0 : (bounds.minX + bounds.maxX) / 2 || 0;
      const centerY = hasDimensionsOriginal ? 0 : (bounds.minY + bounds.maxY) / 2 || 0;

      let backgroundImage = null;
      if (referenceBackground) {
        if (state.backgroundImage) {
          backgroundImage = state.backgroundImage;
        } else if (!state.backgroundImageLoading) {
          state.backgroundImageLoading = true;
          requestBackgroundImage(referenceBackground, (img) => {
            state.backgroundImageLoading = false;
            if (!img) {
              if (state.backgroundImageUrl === referenceBackground) {
                state.backgroundImage = null;
              }
              return;
            }
            if (state.referenceBackground !== referenceBackground || !container.isConnected) {
              return;
            }
            state.backgroundImage = img;
            window.requestAnimationFrame(() => {
              if (!container.isConnected) return;
              render(container, reel, masks, state);
            });
          });
        }
      }

      if (backgroundImage) {
        ctx.save();
        ctx.scale(1, -1);
        ctx.drawImage(backgroundImage, -drawWidth / 2, -drawLength / 2, drawWidth, drawLength);
        ctx.restore();
        ctx.fillStyle = "rgba(15, 23, 42, 0.03)";
        ctx.fillRect(-drawWidth / 2, -drawLength / 2, drawWidth, drawLength);
      } else {
        ctx.fillStyle = "#e1e7f5";
        ctx.fillRect(-drawWidth / 2, -drawLength / 2, drawWidth, drawLength);
      }

      ctx.strokeStyle = "#4a5a7a";
      ctx.lineWidth = 1;
      ctx.strokeRect(-drawWidth / 2, -drawLength / 2, drawWidth, drawLength);

      ctx.strokeStyle = "rgba(74, 90, 122, 0.18)";
      ctx.beginPath();
      ctx.moveTo(-drawWidth / 2, 0);
      ctx.lineTo(drawWidth / 2, 0);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, -drawLength / 2);
      ctx.lineTo(0, drawLength / 2);
      ctx.stroke();

      parsed.shapes.forEach((shape) => {
        if (!shape.points.length) return;
        ctx.beginPath();
        const first = shape.points[0];
        ctx.moveTo((first.x - centerX) * scale, -(first.y - centerY) * scale);
        for (let i = 1; i < shape.points.length; i += 1) {
          const point = shape.points[i];
          ctx.lineTo((point.x - centerX) * scale, -(point.y - centerY) * scale);
        }
        ctx.closePath();
        ctx.fillStyle = MASK_COLOR.fill;
        ctx.fill();
        ctx.strokeStyle = MASK_COLOR.stroke;
        ctx.lineWidth = 0.9;
        ctx.stroke();
      });

      ctx.restore();
      ctx.fillStyle = "#4a5a7a";
      ctx.font = "12px sans-serif";
      ctx.textBaseline = "bottom";
      ctx.textAlign = "left";
      ctx.fillText(`X: ±${Utils.formatNumber(workingWidth / 2, 1)}`, 8, size - 8);
      ctx.textBaseline = "top";
      ctx.textAlign = "right";
      ctx.fillText(`Y: ±${Utils.formatNumber(workingLength / 2, 1)}`, size - 8, 8);

      container.appendChild(canvas);
    }

    function collectMasks(masks) {
      const shapes = [];
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;

      masks.forEach((mask) => {
        const polygons = parseMaskCoords(mask?.coords);
        if (!polygons.length) return;
        polygons.forEach((points) => {
          const normalized = points.filter((pt) => Number.isFinite(pt.x) && Number.isFinite(pt.y));
          if (normalized.length < 3) return;
          normalized.forEach((pt) => {
            minX = Math.min(minX, pt.x);
            maxX = Math.max(maxX, pt.x);
            minY = Math.min(minY, pt.y);
            maxY = Math.max(maxY, pt.y);
          });
          shapes.push({ points: normalized });
        });
      });

      if (!shapes.length) {
        return { shapes: [], bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 } };
      }

      return {
        shapes,
        bounds: {
          minX,
          maxX,
          minY,
          maxY,
        },
      };
    }

    function parseMaskCoords(raw) {
      if (!raw) return [];
      if (Array.isArray(raw)) {
        return normalizeArrayCoords(raw);
      }
      const text = String(raw || "").trim();
      if (!text) return [];

      if (/^\s*[\[{]/.test(text)) {
        try {
          const parsed = JSON.parse(text);
          const normalized = normalizeArrayCoords(parsed);
          if (normalized.length) return normalized;
        } catch (err) {
          // ignore JSON parse failures
        }
      }

      const segments = text
        .split(/\|+/)
        .map((segment) => segment.trim())
        .filter(Boolean);
      if (!segments.length) {
        segments.push(text);
      }

      const polygons = [];
      segments.forEach((segment) => {
        const pairs = [];
        const pairRegex = /(-?\d+(?:\.\d+)?)\s*(?:,|:|;|\s)\s*(-?\d+(?:\.\d+)?)/g;
        let match;
        while ((match = pairRegex.exec(segment)) !== null) {
          const x = Number(match[1]);
          const y = Number(match[2]);
          if (Number.isFinite(x) && Number.isFinite(y)) {
            pairs.push({ x, y });
          }
        }

        if (pairs.length >= 3) {
          polygons.push(pairs);
          return;
        }
        if (pairs.length === 2) {
          const [p1, p2] = pairs;
          polygons.push([
            { x: p1.x, y: p1.y },
            { x: p2.x, y: p1.y },
            { x: p2.x, y: p2.y },
            { x: p1.x, y: p2.y },
          ]);
          return;
        }

        const tokens = segment.match(/-?\d+(?:\.\d+)?/g);
        if (!tokens) return;
        const points = [];
        for (let i = 0; i + 1 < tokens.length; i += 2) {
          const x = Number(tokens[i]);
          const y = Number(tokens[i + 1]);
          if (Number.isFinite(x) && Number.isFinite(y)) {
            points.push({ x, y });
          }
        }
        if (points.length >= 3) {
          polygons.push(points);
        } else if (points.length === 2) {
          const [p1, p2] = points;
          polygons.push([
            { x: p1.x, y: p1.y },
            { x: p2.x, y: p1.y },
            { x: p2.x, y: p2.y },
            { x: p1.x, y: p2.y },
          ]);
        }
      });

      return polygons;
    }

    function normalizeArrayCoords(value) {
      if (!value) return [];
      if (!Array.isArray(value) && value && typeof value === "object") {
        if (Array.isArray(value.x) && Array.isArray(value.y)) {
          const pts = [];
          const len = Math.min(value.x.length, value.y.length);
          for (let i = 0; i < len; i += 1) {
            const x = Number(value.x[i]);
            const y = Number(value.y[i]);
            if (Number.isFinite(x) && Number.isFinite(y)) {
              pts.push({ x, y });
            }
          }
          return pts.length >= 3 ? [pts] : [];
        }
        return [];
      }
      if (Array.isArray(value) && value.length && value.every((item) => typeof item === "object" && !Array.isArray(item))) {
        const polygons = [];
        value.forEach((entry) => {
          if (entry && Array.isArray(entry.x) && Array.isArray(entry.y)) {
            const pts = [];
            const len = Math.min(entry.x.length, entry.y.length);
            for (let i = 0; i < len; i += 1) {
              const x = Number(entry.x[i]);
              const y = Number(entry.y[i]);
              if (Number.isFinite(x) && Number.isFinite(y)) {
                pts.push({ x, y });
              }
            }
            if (pts.length >= 3) {
              polygons.push(pts);
            }
          }
        });
        return polygons;
      }

      if (Array.isArray(value) && value.length && Array.isArray(value[0])) {
        const pts = value
          .map((point) => {
            if (!Array.isArray(point) || point.length < 2) return null;
            const x = Number(point[0]);
            const y = Number(point[1]);
            return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
          })
          .filter(Boolean);
        return pts.length >= 3 ? [pts] : [];
      }

      return [];
    }

    return { domId, attach };
  })();


  const LoadingOverlay = (() => {
    let overlay = null;

    function ensure() {
      if (!overlay) {
        overlay = document.getElementById("globalLoading");
      }
      return overlay;
    }

    function show() {
      const el = ensure();
      if (el) {
        el.classList.remove("hidden");
      }
    }

    function hide() {
      const el = ensure();
      if (el) {
        el.classList.add("hidden");
      }
    }

    function reset() {
      const el = ensure();
      if (el) {
        el.classList.add("hidden");
      }
    }

    return { show, hide, reset };
  })();


  const Filters = (() => {
    const root = document.getElementById("globalFilters");
    const elements = {
      machine: Utils.qs("#filterMachine"),
      start: Utils.qs("#filterStart"),
      end: Utils.qs("#filterEnd"),
      job: Utils.qs("#filterJob"),
      order: Utils.qs("#filterOrder"),
      reel: Utils.qs("#filterReel"),
      chips: Utils.qs("#activeFilterChips"),
    };

    const reelOptionCache = new Map(); // reel_id -> { value, code, label }
    const reelIdsByCode = new Map(); // reel_code -> [reel_id]
    const forcedDisabled = new Map();
    const AUTO_RANGE_DAYS = 3; // how many days the end date should trail the start date by default
    let pendingReelCodes = [];
    const STATUS_STYLES = {
      pass: { bg: "rgba(34, 197, 94, 0.35)", color: "#065f46" },
      fail: { bg: "rgba(248, 113, 113, 0.4)", color: "#7f1d1d" },
      pending: { bg: "", color: "" },
      no_defects: { bg: "rgba(191, 219, 254, 0.7)", color: "#1d4ed8" },
      complete: { bg: "rgba(191, 219, 254, 0.6)", color: "#1e3a8a" },
    };

    function rememberReelOption(entry) {
      if (!entry || !entry.value) return;
      const id = String(entry.value);
      const normalized = {
        value: id,
        code: entry.code || entry.reel_code || "",
        label: entry.label || entry.reel_code || entry.code || `Reel ${id}`,
        status: entry.status || "",
      };
      reelOptionCache.set(id, normalized);
      if (normalized.code) {
        const list = reelIdsByCode.get(normalized.code) || [];
        if (!list.includes(id)) {
          list.push(id);
          reelIdsByCode.set(normalized.code, list);
        }
      }
    }
    function updateReelStatus(reelId, status, reelCode = "") {
      const normalizedStatus = status || "";
      const idValue = reelId !== undefined && reelId !== null ? String(reelId) : "";
      const cached = idValue ? reelOptionCache.get(idValue) : null;
      if (cached) {
        cached.status = normalizedStatus;
        reelOptionCache.set(idValue, cached);
      }
      const targetCode = reelCode || (cached && cached.code) || "";
      if (elements.reel) {
        Array.from(elements.reel.options).forEach((option) => {
          const matchesId = idValue && option.value === idValue;
          const matchesCode = !matchesId && targetCode && option.dataset.reelCode === targetCode;
          if (matchesId || matchesCode) {
            applyOptionStatusStyles(option, normalizedStatus);
          }
        });
      }
    }

    function getSelectedReelEntries() {
      return state.reel_ids.map((id) => {
        const entry = reelOptionCache.get(id);
        return {
          id,
          code: entry && entry.code ? entry.code : "",
          label: entry && entry.label ? entry.label : entry && entry.code ? entry.code : `Reel ${id}`,
          status: entry && entry.status ? entry.status : "",
        };
      });
    }

    function hydratePendingReelIds() {
      if (!pendingReelCodes.length || state.reel_ids.length) return;
      const resolved = [];
      pendingReelCodes.forEach((code) => {
        const ids = reelIdsByCode.get(code) || [];
        if (ids.length) {
          resolved.push(ids[0]);
        }
      });
      if (resolved.length) {
        state.reel_ids = resolved;
        pendingReelCodes = [];
        syncReelSelect();
        renderChips();
      }
    }

    const listeners = new Set();
    const optionListeners = new Set();
    const defaults = {
      machine_id:
        (root && root.dataset.defaultMachine) ||
        (elements.machine ? elements.machine.value : ""),
      start:
        (root && root.dataset.defaultStartDate) ||
        (elements.start ? elements.start.value : ""),
      end:
        (root && root.dataset.defaultEndDate) ||
        (elements.end ? elements.end.value : ""),
      job:
        (root && root.dataset.defaultJob) ||
        (elements.job ? elements.job.value : ""),
      order: "",
      reel_ids: [],
    };
    let state = {
      machine_id: defaults.machine_id,
      start: defaults.start,
      end: defaults.end,
      job: defaults.job,
      order: defaults.order,
      reel_ids: [],
    };
    let updating = false;
    let initialized = false;
    let refreshOptionsQueued = false;
    let readyResolve = null;
    const readyPromise = new Promise((resolve) => {
      readyResolve = resolve;
    });

    function markReady() {
      if (readyResolve) {
        readyResolve();
        readyResolve = null;
      }
    }

    const scheduleEmit = Utils.debounce(() => emit(false), FETCH_DEBOUNCE_MS);
    let firstEmit = true;
    const scheduleOptionsRefresh = Utils.debounce(() => refreshOptions(), 200);

    function hasJobSelection() {
      return Boolean((state.job || "").trim());
    }

    function setDisabledState(el, disabled, fieldName) {
      if (!el) return;
      const override = fieldName ? forcedDisabled.get(fieldName) : undefined;
      const finalDisabled = override !== undefined ? override : disabled;
      el.disabled = finalDisabled;
      const card = el.closest(".filter-card");
      if (card) {
        card.classList.toggle("filter-card--disabled", finalDisabled);
      }
    }

    function updateDependentFilters() {
      const disableSecondary = !hasJobSelection();
      setDisabledState(elements.order, disableSecondary, "order");
      setDisabledState(elements.reel, disableSecondary, "reel");
    }

    function init() {
      if (!elements.machine) return;
      applySearchParams();
      if (elements.job && state.job) {
        elements.job.value = state.job;
      }
      updateDependentFilters();
      renderChips();
      attachListeners();
      refreshOptions(true).then(() => {
        updateDependentFilters();
        emit(true);
        initialized = true;
        markReady();
      });
    }

    function applySearchParams() {
      const params = new URLSearchParams(window.location.search);
      ["machine_id", "start", "end", "job", "order"].forEach((key) => {
        if (params.has(key)) {
          let value = params.get(key) || "";
          if ((key === "start" || key === "end") && value.includes("T")) {
            value = value.split("T")[0];
          }
          state[key] = value;
        }
      });
      const reelIdParams = params.getAll("reel_id").map((value) => `${value}`.trim()).filter((value) => value);
      state.reel_ids = reelIdParams;
      const reelParams = params.getAll("reel_code");
      const normalized = Array.from(
        new Set(
          reelParams
            .flatMap((entry) =>
              entry && entry.includes(",")
                ? entry.split(",").map((value) => value.trim())
                : [entry]
            )
            .filter((value) => value)
        )
      );
      pendingReelCodes = state.reel_ids.length ? [] : normalized;

  updating = true;
  if (elements.machine) elements.machine.value = state.machine_id || elements.machine.value;
  if (elements.start) elements.start.value = state.start || "";
  if (elements.end) elements.end.value = state.end || "";
  if (elements.job) elements.job.value = state.job || "";
  if (!hasJobSelection()) {
    state.order = "";
  }
  if (state.order === ORDER_NONE) {
    ensureOrderOption(ORDER_NONE, "None");
    if (elements.order) elements.order.value = ORDER_NONE;
  } else if (elements.order) {
    elements.order.value = state.order || "";
  }
      syncReelSelect();
      updating = false;
      updateDependentFilters();
    }

    function attachListeners() {
      Object.entries(elements).forEach(([name, el]) => {
        if (!el || name === "chips") return;
        el.addEventListener("change", (evt) => {
          if (name === "reel") {
            handleInputChange(name, getSelectedReelsFromSelect());
          } else if (name === "start" || name === "end") {
            const value = evt.target.value || "";
            if (value.length === 10) {
              return;
            }
            handleInputChange(name, value);
          } else {
            handleInputChange(name, evt.target.value || "");
          }
        });
        if (name === "start" || name === "end") {
          el.addEventListener("input", () => {
            const value = el.value || "";
            if (value.length === 10) {
              handleInputChange(name, value);
            }
          });
        }
      });
      if (elements.chips) {
        elements.chips.addEventListener("click", (evt) => {
          const button = evt.target.closest(".chip-remove");
          if (!button) return;
          const chipEl = button.closest(".filter-chip");
          if (!chipEl) return;
          const key = chipEl.dataset.key;
          if (!key) return;
          const value = chipEl.dataset.value || undefined;
          clearKey(key, value).catch((error) => console.error("Failed to clear filter chip", error));
        });
      }
    }

    function getSelectedReelsFromSelect() {
      if (!elements.reel) return [];
      return Array.from(elements.reel.selectedOptions)
        .map((option) => option.value)
        .filter((value) => value);
    }

    function autoAdjustEndDateFromStart(startValue) {
      if (!startValue || startValue.length !== 10) return;
      const segments = startValue.split("-").map((part) => Number.parseInt(part, 10));
      if (segments.length !== 3 || segments.some((part) => Number.isNaN(part))) return;
      const [year, month, day] = segments;
      const utcDate = new Date(Date.UTC(year, month - 1, day));
      utcDate.setUTCDate(utcDate.getUTCDate() + AUTO_RANGE_DAYS);
      const newEnd = utcDate.toISOString().slice(0, 10);
      if (!newEnd) return;
      state.end = newEnd;
      if (elements.end) {
        elements.end.value = newEnd;
      }
    }

    function maybeClearJobSelectionForOverview() {
      const routerAvailable = typeof Router !== "undefined" && Router && typeof Router.current === "function";
      if (!routerAvailable) return;
      if (Router.current() !== "overview") return;
      const hasAnySelection = state.job || state.order || state.reel_ids.length;
      if (!hasAnySelection) return;
      state.job = "";
      if (elements.job) elements.job.value = "";
      state.order = "";
      if (elements.order) elements.order.value = "";
      state.reel_ids = [];
      pendingReelCodes = [];
      syncReelSelect();
    }

    function applyOptionStatusStyles(option, status) {
      if (!option) return;
      const normalized = status || "";
      option.dataset.status = normalized;
      const styles = STATUS_STYLES[normalized];
      if (styles && styles.bg) {
        option.style.backgroundColor = styles.bg;
        option.style.color = styles.color || "";
        option.style.fontWeight = "600";
      } else {
        option.style.backgroundColor = "";
        option.style.color = "";
        option.style.fontWeight = "";
      }
    }

    function syncReelSelect() {
      if (!elements.reel) return;
      const selectedSet = new Set(state.reel_ids.map((id) => `${id}`));
      const options = Array.from(elements.reel.options);
      selectedSet.forEach((id) => {
      if (!options.some((option) => option.value === id)) {
        const cached = reelOptionCache.get(id);
        const option = document.createElement("option");
        option.value = id;
        option.textContent = cached && cached.label ? cached.label : cached && cached.code ? cached.code : `Reel ${id}`;
        if (cached && cached.code) {
          option.dataset.reelCode = cached.code;
        }
        applyOptionStatusStyles(option, cached && cached.status);
        option.selected = true;
        elements.reel.appendChild(option);
      }
    });
      Array.from(elements.reel.options).forEach((option) => {
        if (option.value === "") {
          option.selected = !selectedSet.size;
        } else {
          option.selected = selectedSet.has(option.value);
        }
      });
    }

    function handleInputChange(field, value) {
      if (updating) return;
      switch (field) {
        case "machine":
          state.machine_id = value || "";
          state.job = "";
          if (elements.job) elements.job.value = "";
          state.order = "";
          if (elements.order) elements.order.value = "";
          state.reel_ids = [];
          pendingReelCodes = [];
          syncReelSelect();
          scheduleOptionsRefresh();
          break;
        case "start": {
          const normalizedStart = value || "";
          if (state.start === normalizedStart) return;
          state.start = normalizedStart;
          autoAdjustEndDateFromStart(normalizedStart);
          maybeClearJobSelectionForOverview();
          scheduleOptionsRefresh();
          break;
        }
        case "end": {
          const normalizedEnd = value || "";
          if (state.end === normalizedEnd) return;
          state.end = normalizedEnd;
          maybeClearJobSelectionForOverview();
          scheduleOptionsRefresh();
          break;
        }
        case "job":
          state.job = value || "";
          if (elements.job) elements.job.value = state.job;
          state.order = "";
          if (elements.order) elements.order.value = "";
          state.reel_ids = [];
          pendingReelCodes = [];
          syncReelSelect();
          scheduleOptionsRefresh();
          break;
        case "order":
          state.order = value || "";
          state.reel_ids = [];
          pendingReelCodes = [];
          syncReelSelect();
          scheduleOptionsRefresh();
          break;
        case "reel":
          if (Array.isArray(value)) {
            state.reel_ids = value.map((entry) => `${entry}`.trim()).filter((entry) => entry);
          } else {
            state.reel_ids = value ? [`${value}`.trim()] : [];
          }
          syncReelSelect();
          break;
        default:
          break;
      }
      updateDependentFilters();
      if (firstEmit) {
        firstEmit = false;
        emit(false);
      } else {
        scheduleEmit();
      }
    }

    async function refreshOptions(initial = false) {
      if (refreshOptionsQueued && !initial) return;
      refreshOptionsQueued = true;
      LoadingOverlay.show();
      try {
        const data = await Api.get("filters", {}, getState());
        updating = true;
        updateSelect(elements.job, data.jobs || [], state.job ? [state.job] : []);
        updateSelect(elements.order, data.orders || [], state.order ? [state.order] : []);
        updateSelect(elements.reel, data.reel_codes || [], state.reel_ids);
        hydratePendingReelIds();
        updating = false;
        updateDependentFilters();
        optionListeners.forEach((cb) => {
          try {
            cb(data);
          } catch (err) {
            console.error('Filters.onOptionsUpdated listener failed', err);
          }
        });
      } catch (err) {
        console.error("Failed to refresh filter options", err);
      } finally {
        refreshOptionsQueued = false;
        LoadingOverlay.hide();
      }
    }

    function updateSelect(selectEl, values, currentValues) {
      if (!selectEl) return;
      const isReelSelect = selectEl === elements.reel;
      const isMultiple = !!selectEl.multiple;
      const selectedSet = new Set((currentValues || []).map((value) => `${value}`));
      const frag = document.createDocumentFragment();

      if (!isMultiple) {
        const defaultOption = document.createElement("option");
        defaultOption.value = "";
        defaultOption.textContent = "All";
        defaultOption.selected = !selectedSet.size;
        applyOptionStatusStyles(defaultOption, "");
        frag.appendChild(defaultOption);
      } else if (!Array.from(selectedSet).length) {
        const defaultOption = document.createElement("option");
        defaultOption.value = "";
        defaultOption.textContent = "All";
        defaultOption.selected = true;
        applyOptionStatusStyles(defaultOption, "");
        frag.appendChild(defaultOption);
      }

      const entryMap = new Map();

      (values || []).forEach((raw) => {
        let entry = null;
        if (raw && typeof raw === "object") {
          const rawValue = raw.value ?? raw.reel_id ?? raw.id ?? raw.reel_code ?? raw.code;
          if (rawValue) {
            const statusValue = isReelSelect ? raw.status || "" : "";
            entry = {
              value: String(rawValue),
              label: raw.label || raw.reel_code || raw.code || String(rawValue),
              code: raw.reel_code || raw.code || "",
              status: statusValue,
            };
          }
        } else if (raw !== undefined && raw !== null && raw !== "") {
          const value = String(raw);
          entry = {
            value,
            label: selectEl === elements.order && value === ORDER_NONE ? "None" : value,
            code: "",
            status: "",
          };
        }
        if (entry && entry.value) {
          if (selectEl === elements.reel) {
            rememberReelOption(entry);
          }
          entryMap.set(entry.value, entry);
        }
      });

      (currentValues || []).forEach((raw) => {
        if (raw === undefined || raw === null || raw === "") return;
        const value = String(raw);
        if (entryMap.has(value)) return;
        let entry = null;
        if (selectEl === elements.reel) {
          const cached = reelOptionCache.get(value);
          if (cached) {
            entry = cached;
          } else {
            entry = { value, label: `Reel ${value}`, code: "", status: "" };
            rememberReelOption(entry);
          }
        } else {
          entry = {
            value,
            label: selectEl === elements.order && value === ORDER_NONE ? "None" : value,
            code: "",
            status: "",
          };
        }
        entryMap.set(value, entry);
      });

      entryMap.forEach((entry) => {
        if (!entry || !entry.value) return;
        const option = document.createElement("option");
        option.value = entry.value;
        option.textContent = entry.label || entry.value;
        if (entry.code) {
          option.dataset.reelCode = entry.code;
        }
        applyOptionStatusStyles(option, isReelSelect ? entry.status : "");
        option.selected = selectedSet.has(entry.value);
        frag.appendChild(option);
      });

      selectEl.innerHTML = "";
      selectEl.appendChild(frag);
      if (isMultiple) {
        Array.from(selectEl.options).forEach((option) => {
          if (option.value === "") {
            option.selected = !selectedSet.size;
          }
        });
      } else {
        selectEl.value = selectedSet.size ? Array.from(selectedSet)[0] : "";
      }
    }

    function emit(force) {
      if (!initialized && !force) return;
      renderChips();
      const payload = getState();
      Utils.updateUrlQuery(payload);
      listeners.forEach((listener) => listener(payload));
    }

    function getState() {
      const entries = getSelectedReelEntries();
      return {
        machine_id: state.machine_id,
        start: state.start,
        end: state.end,
        job: state.job,
        order: state.order,
        reel_id: [...state.reel_ids],
        reel_code: entries.map((entry) => entry.code).filter((code) => code),
      };
    }

  function getReelCodes() {
    return getSelectedReelEntries()
      .map((entry) => entry.code)
      .filter((code) => code);
    }

    function getReelIds() {
      return [...state.reel_ids];
    }

    function hasReelSelection(reelId, reelCode) {
      const idValue = reelId !== undefined && reelId !== null ? String(reelId) : "";
      if (idValue && state.reel_ids.includes(idValue)) {
        return true;
      }
      if (reelCode) {
        const ids = reelIdsByCode.get(reelCode) || [];
        return ids.some((id) => state.reel_ids.includes(id));
      }
      return false;
    }

    function onChange(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    }

    async function clearKey(key, value) {
      switch (key) {
        case "machine_id":
          if (elements.machine) {
            state.machine_id = defaults.machine_id || (elements.machine.options[0]?.value || "");
            elements.machine.value = state.machine_id;
          }
          state.job = "";
          if (elements.job) elements.job.value = "";
          state.order = "";
          if (elements.order) elements.order.value = "";
          state.reel_ids = [];
          pendingReelCodes = [];
          syncReelSelect();
          updateDependentFilters();
          await refreshOptions(true);
          emit(true);
          break;
        case "start":
          state.start = defaults.start || "";
          if (elements.start) elements.start.value = state.start || "";
          await refreshOptions(true);
          emit(true);
          break;
        case "end":
          state.end = defaults.end || "";
          if (elements.end) elements.end.value = state.end || "";
          await refreshOptions(true);
          emit(true);
          break;
        case "job":
          state.job = "";
          if (elements.job) elements.job.value = "";
          state.order = "";
          if (elements.order) elements.order.value = "";
          state.reel_ids = [];
          pendingReelCodes = [];
          syncReelSelect();
          updateDependentFilters();
          await refreshOptions(true);
          emit(true);
          break;
        case "order":
          state.order = "";
          if (elements.order) elements.order.value = "";
          state.reel_ids = [];
          pendingReelCodes = [];
          syncReelSelect();
          updateDependentFilters();
          await refreshOptions(true);
          emit(true);
          break;
        case "reel_id":
          if (value) {
            removeReel(value, { emit: true });
          } else {
            state.reel_ids = [];
            pendingReelCodes = [];
            syncReelSelect();
            emit(true);
          }
          break;
        case "reel_code":
          if (value) {
            removeReel(value, { emit: true });
          } else {
            state.reel_ids = [];
            pendingReelCodes = [];
            syncReelSelect();
            emit(true);
          }
          break;
        default:
          break;
      }
    }

    function selectedOptionText(selectEl) {
      if (!selectEl) return "";
      const option = selectEl.options[selectEl.selectedIndex];
      return option ? option.textContent.trim() : "";
    }

    function formatChipDate(value) {
      if (!value) return "";
      const date = new Date(`${value}T00:00:00`);
      if (Number.isNaN(date.getTime())) return value;
      return date.toLocaleDateString();
    }

    function renderChips() {
      if (!elements.chips) return;
      const chips = [];
      const machineText = selectedOptionText(elements.machine) || state.machine_id;
      if (machineText) {
        chips.push({ key: "machine_id", label: `Machine: ${machineText}`, removable: false, className: "machine" });
      }
      if (state.start && state.start !== defaults.start) {
        chips.push({ key: "start", label: `Start: ${formatChipDate(state.start)}`, removable: true });
      }
      if (state.end && state.end !== defaults.end) {
        chips.push({ key: "end", label: `End: ${formatChipDate(state.end)}`, removable: true });
      }
      if (state.job) {
        chips.push({ key: "job", label: `Job: ${state.job}`, removable: true });
      }
      if (state.order) {
        const orderLabel = state.order === ORDER_NONE ? "None" : state.order;
        chips.push({ key: "order", label: `Order: ${orderLabel}`, removable: true });
      }
      getSelectedReelEntries().forEach((entry) => {
        if (!entry.id) return;
        chips.push({
          key: "reel_id",
          label: `Reel: ${entry.label}`,
          removable: true,
          value: entry.id,
        });
      });

      if (!chips.length) {
        elements.chips.innerHTML = "";
        elements.chips.classList.add("hidden");
        return;
      }

      const html = chips
        .map((chip) => {
          const classes = ["filter-chip"];
          if (chip.className) classes.push(chip.className);
          const removeButton = chip.removable
            ? `<button type="button" class="chip-remove" aria-label="Clear ${chip.label}">&times;</button>`
            : "";
          const attrs = [`data-key="${chip.key}"`];
          if (chip.value) attrs.push(`data-value="${chip.value}"`);
          return `<span class="${classes.join(" ")}" ${attrs.join(" ")}"><span>${chip.label}</span>${removeButton}</span>`;
        })
        .join("");

      elements.chips.innerHTML = html;
      elements.chips.classList.remove("hidden");
    }

    function set(field, value, { emit: shouldEmit = true, updateUrl = true } = {}) {
      updating = true;
      let needsOptionsRefresh = false;
      switch (field) {
        case "job":
          state.job = value || "";
          if (elements.job) elements.job.value = state.job;
          state.order = "";
          if (elements.order) elements.order.value = "";
          state.reel_ids = [];
          pendingReelCodes = [];
          syncReelSelect();
          needsOptionsRefresh = true;
          break;
        case "order":
          state.order = value || "";
          if (state.order === ORDER_NONE) {
            ensureOrderOption(ORDER_NONE, "None");
          }
          if (elements.order) elements.order.value = state.order;
          break;
        case "start":
          state.start = value || "";
          if (elements.start) elements.start.value = state.start || "";
          break;
        case "end":
          state.end = value || "";
          if (elements.end) elements.end.value = state.end || "";
          break;
        case "machine_id":
          state.machine_id = value || "";
          if (elements.machine) elements.machine.value = state.machine_id || "";
          break;
        case "reel_ids":
          state.reel_ids = Array.isArray(value)
            ? value.map((entry) => `${entry}`.trim()).filter((entry) => entry)
            : [];
          pendingReelCodes = [];
          syncReelSelect();
          break;
        case "reel_id":
          state.reel_ids = value ? [`${value}`.trim()] : [];
          pendingReelCodes = [];
          syncReelSelect();
          break;
        case "reel_codes": {
          const codes = Array.isArray(value) ? value.filter((entry) => entry) : [];
          pendingReelCodes = codes;
          if (!codes.length) {
            state.reel_ids = [];
          }
          syncReelSelect();
          break;
        }
        case "reel_code":
          if (value) {
            pendingReelCodes = [value];
            state.reel_ids = [];
          } else {
            pendingReelCodes = [];
            state.reel_ids = [];
          }
          syncReelSelect();
          break;
        default:
          break;
      }
      updateDependentFilters();
      updating = false;
      if (needsOptionsRefresh) {
        scheduleOptionsRefresh();
      }
      if (shouldEmit) emit(false);
      if (updateUrl && !shouldEmit) {
        Utils.updateUrlQuery(getState());
      }
    }

    function addReel(code, reelId) {
      const normalizedId =
        reelId !== undefined && reelId !== null ? String(reelId).trim() : "";
      let targetId = normalizedId;
      if (!targetId && code) {
        const ids = reelIdsByCode.get(code) || [];
        targetId = ids[0] || "";
      }
      if (!targetId) return;
      if (!state.reel_ids.includes(targetId)) {
        state.reel_ids = [...state.reel_ids, targetId];
        rememberReelOption({ value: targetId, code: code || "", label: code || `Reel ${targetId}` });
        syncReelSelect();
        emit(true);
      }
    }

    function setMany(updates = {}, options = {}) {
      const { emit: shouldEmit = true, updateUrl = true } = options;
      const entries = Object.entries(updates || {});
      if (!entries.length) {
        if (shouldEmit) emit(false);
        return;
      }
      updating = true;
      entries.forEach(([field, value]) => {
        switch (field) {
          case "job":
          case "order":
          case "start":
          case "end":
          case "machine_id":
            if (field === "order" && value === ORDER_NONE) {
              ensureOrderOption(ORDER_NONE, "None");
            }
            set(field, value, { emit: false, updateUrl: false });
            break;
          default:
            break;
        }
      });
      updateDependentFilters();
      updating = false;
      if (shouldEmit) emit(false);
      if (updateUrl) {
        Utils.updateUrlQuery(getState());
      }
    }

    function removeReel(identifier, { emit: shouldEmit = false } = {}) {
      const normalized = identifier !== undefined && identifier !== null ? String(identifier).trim() : "";
      let targetId = normalized;
      if (!targetId) {
        targetId = state.reel_ids[state.reel_ids.length - 1] || "";
      }
      if (!targetId) return;
      if (!state.reel_ids.includes(targetId)) {
        const candidates = reelIdsByCode.get(targetId) || [];
        targetId = candidates.find((id) => state.reel_ids.includes(id)) || "";
        if (!targetId) return;
      }
      const next = state.reel_ids.filter((entry) => entry !== targetId);
      if (next.length === state.reel_ids.length) return;
      state.reel_ids = next;
      syncReelSelect();
      if (shouldEmit) emit(true);
      else renderChips();
    }

    function clearReels({ emit: shouldEmit = true } = {}) {
      if (!state.reel_ids.length && !pendingReelCodes.length) return;
      state.reel_ids = [];
      pendingReelCodes = [];
      syncReelSelect();
      if (shouldEmit) emit(true);
      else renderChips();
    }

    function ensureOrderOption(value, label) {
      if (!elements.order) return;
      const exists = Array.from(elements.order.options).some((opt) => opt.value === value);
      if (!exists) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        elements.order.appendChild(option);
      }
    }

    function promptJobSelection(targetTab) {
      const jobCard = elements.job ? elements.job.closest(".filter-card") : null;
      if (!jobCard) {
        window.alert("Select a job before opening the Job Explorer or Defect Explorer.");
        return;
      }
      const message =
        targetTab === "defects"
          ? "Select a job to access the Defect Explorer."
          : "Select a job to access the Job Explorer.";
      let hint = jobCard.querySelector(".job-required-hint");
      if (!hint) {
        hint = document.createElement("div");
        hint.className = "job-required-hint";
        jobCard.appendChild(hint);
      }
      hint.textContent = message;
      hint.classList.add("visible");
      jobCard.classList.add("filter-card--attention");
      if (elements.job) {
        elements.job.focus();
      }
      window.requestAnimationFrame(() => {
        setTimeout(() => {
          hint.classList.remove("visible");
          jobCard.classList.remove("filter-card--attention");
        }, 2600);
      });
    }

    function setFieldDisabled(field, disabled, { lock = false } = {}) {
      if (!elements[field]) return;
      if (lock) {
        forcedDisabled.set(field, Boolean(disabled));
      } else if (forcedDisabled.has(field)) {
        forcedDisabled.delete(field);
      }
      setDisabledState(elements[field], disabled, field);
    }

    function clearFieldOverride(field) {
      if (!forcedDisabled.has(field)) return;
      forcedDisabled.delete(field);
      if (elements[field]) {
        if (field === "order" || field === "reel") {
          const disableSecondary = !hasJobSelection();
          setDisabledState(elements[field], disableSecondary, field);
        } else {
          setDisabledState(elements[field], false, field);
        }
      }
    }

    return {
      init,
      getState,
      ready: () => readyPromise,
      onChange,
      onOptionsUpdated: (cb) => {
        optionListeners.add(cb);
        return () => optionListeners.delete(cb);
      },
      set,
      setMany,
      addReel,
      removeReel,
      getReelCodes,
      getReelIds,
      hasReelSelection,
      hasJobSelection: () => hasJobSelection(),
      promptJobSelection,
      clearReels,
      updateReelStatus,
      setFieldDisabled,
      clearFieldOverride,
    };
  })();

  const RLM_METRIC_LABELS = {
    format: "Format",
    errexpand: "Err Expand",
    errshrink: "Err Shrink",
    wrnexpand: "Warn Expand",
    wrnshrink: "Warn Shrink",
    nomlength: "Nominal Length",
    nomlenght: "Nominal Length",
  };

  const Api = {
    async get(endpoint, extraParams = {}, baseFilters) {
      const params = { ...(baseFilters || Filters.getState()) };
      Object.entries(extraParams || {}).forEach(([key, value]) => {
        if (value !== undefined) {
          params[key] = value;
        }
      });

      const url = new URL(`/dashboard/api/${endpoint}`, window.location.origin);
      Object.entries(params).forEach(([key, value]) => {
        if (value === undefined || value === null || value === "") return;
        if (Array.isArray(value)) {
          value
            .filter((item) => item !== undefined && item !== null && item !== "")
            .forEach((item) => {
              if (key === "start" || key === "end") {
                const normalized = normalizeDateFilterValue(key, item);
                if (normalized) {
                  url.searchParams.append(key, normalized);
                }
              } else {
                url.searchParams.append(key, item);
              }
            });
          return;
        }
        if (key === "start" || key === "end") {
          const normalized = normalizeDateFilterValue(key, value);
          if (normalized) {
            url.searchParams.append(key, normalized);
          }
        } else {
          url.searchParams.append(key, value);
        }
      });

      const response = await fetch(url.toString(), {
        headers: { Accept: "application/json" },
      });
      const data = await response.json();
      if (!response.ok) {
        const message = data && data.error ? data.error : response.statusText;
        throw new Error(message);
      }
      if (data && typeof data.error === "string") {
        throw new Error(data.error);
      }
      return data;
    },
    async post(endpoint, body = {}) {
      const url = new URL(`/dashboard/api/${endpoint}`, window.location.origin);
      const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body || {}),
      });
      let data = null;
      try {
        data = await response.json();
      } catch (err) {
        // ignore parse error for empty responses
      }
      if (!response.ok) {
        let message = response.statusText || `Request failed (${response.status})`;
        if (data && typeof data.error === "string") {
          message = data.error;
        }
        throw new Error(message);
      }
      if (data && typeof data.error === "string") {
        throw new Error(data.error);
      }
      return data;
    },
  };

  function formatAsDate(value) {
    if (value === null || value === undefined) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleString();
  }

  function normalizeDateFilterValue(key, rawValue) {
    if (!rawValue) return "";
    const datePart = String(rawValue).split("T")[0];
    if (!datePart) return "";
    if (key === "start") {
      return `${datePart}T00:00:00`;
    }
    if (key === "end") {
      return `${datePart}T23:59:59`;
    }
    return rawValue;
  }

  const Router = (() => {
    const tabs = {};
    let active = "overview";

    function register(name, module) {
      tabs[name] = module;
    }

    function init() {
      handleHashChange();
      window.addEventListener("hashchange", handleHashChange);
    }

    function handleHashChange() {
      const hash = window.location.hash.replace("#", "") || "overview";
      setActive(hash);
    }

    function setActive(name) {
      if (!tabs[name]) name = "overview";
      if (name === "overview" && Filters && typeof Filters.clearReels === "function") {
        Filters.clearReels({ emit: true });
      }
      const requiresJob = name === "job" || name === "defects";
      if (
        requiresJob &&
        (!Filters.hasJobSelection || !Filters.hasJobSelection())
      ) {
        if (typeof Filters.promptJobSelection === "function") {
          Filters.promptJobSelection(name);
        }
        revertHash();
        return;
      }
      if (active === name) {
        if (tabs[active] && typeof tabs[active].activate === "function") {
          tabs[active].activate();
        }
        return;
      }

      const previous = active;
      active = name;
      if (tabs[previous] && typeof tabs[previous].deactivate === "function") {
        tabs[previous].deactivate();
      }
      Utils.qsa(".tab").forEach((button) => {
        button.classList.toggle("tab-active", button.dataset.tab === active);
      });
      Utils.qsa(".tab-content").forEach((section) => {
        section.classList.toggle("hidden", section.id !== `tab-${active}`);
      });
      if (tabs[active] && typeof tabs[active].activate === "function") {
        tabs[active].activate();
      }
      syncModalMetaBarVisibility();
      const url = new URL(window.location.href);
      if (url.hash !== `#${active}`) {
        url.hash = `#${active}`;
        history.replaceState({}, "", url.toString());
      }
    }

    function revertHash() {
      const url = new URL(window.location.href);
      if (url.hash !== `#${active}`) {
        url.hash = `#${active}`;
        history.replaceState({}, "", url.toString());
      }
    }

    function reloadActive() {
      if (tabs[active] && typeof tabs[active].onFiltersUpdated === "function") {
        tabs[active].onFiltersUpdated();
      }
    }

    function current() {
      return active;
    }

    return { register, init, setActive, reloadActive, current };
  })();

  const OverviewTab = (() => {
    let initialized = false;
    let kpiMap = {};
    let heatmapContainer;
    let rlmRange = null;
    const heatmapState = {
      jobs: [],
      selectedJob: "",
    };
    const EVENT_ORDER = [
      "defect",
      "reference_change",
      "mask_applied",
      "sensitivity_change",
      "rlm_config_change",
    ];
    const EVENT_META = {
      defect: { label: "Defects", color: "#ef4444" },
      reference_change: { label: "Reference Changes", color: "#2563eb" },
      mask_applied: { label: "Masks Applied", color: "#f97316" },
      sensitivity_change: { label: "Sensitivity Changes", color: "#0ea5e9" },
      rlm_config_change: { label: "RLM Config Changes", color: "#14b8a6" },
    };
    const TIMELINE_TYPES = [
      "sensitivity_change",
      "mask_applied",
      "rlm_config_change",
      "reference_change",
    ];
    const TIMELINE_SYMBOL = {
      sensitivity_change: "circle",
      mask_applied: "square",
      rlm_config_change: "diamond",
      reference_change: "triangle-up",
    };

    const load = Utils.debounce(async () => {
      if (!heatmapContainer) {
        heatmapContainer = Utils.qs("#overviewHeatmapCanvas");
      }
      if (heatmapContainer) {
        const { job = "", order = "" } = Filters.getState();
        const jobValue = typeof job === "string" ? job.trim() : "";
        const orderValue = typeof order === "string" ? order.trim() : "";
        const hasSelection = Boolean(jobValue) || Boolean(orderValue);
        if (hasSelection) {
          heatmapState.jobs = [];
          heatmapState.selectedJob = "";
          heatmapContainer.innerHTML =
            `<div class="heatmap-wrapper heatmap-empty heatmap-notice"><span class='badge'>Loading heatmap…</span></div>`;
        } else if (!heatmapState.jobs.length) {
          heatmapContainer.innerHTML =
            `<div class="heatmap-wrapper heatmap-empty heatmap-notice"><span class='badge'>Select a job or order to view the heatmap.</span></div>`;
        }
      }
      LoadingOverlay.show();
      try {
        const data = await Api.get("overview");
        renderKpis(data.kpis || {});
        renderCharts(data);
      } catch (err) {
        console.error("Overview load failed", err);
      } finally {
        LoadingOverlay.hide();
      }
    }, FETCH_DEBOUNCE_MS);

    function init() {
      kpiMap = {};
      Utils.qsa(".kpi-card[data-kpi]").forEach((card) => {
        const key = card.dataset.kpi;
        kpiMap[key] = card.querySelector("p");
      });
      heatmapContainer = Utils.qs("#overviewHeatmapCanvas");
      initialized = true;
    }

    function activate() {
      if (!initialized) init();
      load.flush();
    }

    function onFiltersUpdated() {
      if (!heatmapContainer) {
        heatmapContainer = Utils.qs("#overviewHeatmapCanvas");
      }
      if (heatmapContainer) {
        const { job = "", order = "" } = Filters.getState();
        const jobValue = typeof job === "string" ? job.trim() : "";
        const orderValue =
          typeof order === "string"
            ? order.trim()
            : "";
        const hasSelection = Boolean(jobValue) || Boolean(orderValue);
        heatmapState.jobs = [];
        heatmapState.selectedJob = "";
        heatmapContainer.innerHTML = hasSelection
          ? `<div class="heatmap-wrapper heatmap-empty heatmap-notice"><span class='badge'>Loading heatmap…</span></div>`
          : `<div class="heatmap-wrapper heatmap-empty heatmap-notice"><span class='badge'>Select a job or order to view the heatmap.</span></div>`;
      }
      load();
    }

    function renderKpis(kpis) {
      Object.entries(kpiMap).forEach(([key, el]) => {
        if (!el) return;
        const value = kpis[key];
        switch (key) {
          case "total_length":
          case "active_length":
          case "inactive_length":
          case "learn_length":
            el.textContent = Utils.formatMeters(value || 0);
            break;
          case "active_pct":
          case "inactive_pct":
          case "learn_pct":
            el.textContent = `${Utils.formatNumber(value || 0, 1)}%`;
            break;
          default:
            el.textContent = Utils.formatNumber(value || 0);
        }
      });
    }

    function renderCharts(data) {
      const defectsByType = data.defects_by_type || [];
      const defectsTrend = data.defects_trend || [];
      const jobsMeters = data.jobs_meters || [];
      const jobsTime = data.jobs_time || [];
      const jobsDefects = data.jobs_defects || [];
      const jobEvents = data.job_events || [];
      const jobsDefectsTrend = data.jobs_defects_timeline || [];
      const jobMetrics = data.job_metrics || [];
      const jobHeatmaps = data.job_heatmaps || [];

      const jobsTimePct = jobsTime.map((job) => {
        const lengthActive = Number.isFinite(job.length_active) ? job.length_active : 0;
        const lengthInactive = Number.isFinite(job.length_inactive) ? job.length_inactive : 0;
        const lengthLearn = Number.isFinite(job.length_learn) ? job.length_learn : 0;
        const lengthTotal = lengthActive + lengthInactive + lengthLearn;

        const minutesActive = Number.isFinite(job.minutes_active) ? job.minutes_active : 0;
        const minutesInactive = Number.isFinite(job.minutes_inactive) ? job.minutes_inactive : 0;
        const minutesLearn = Number.isFinite(job.minutes_learn) ? job.minutes_learn : 0;
        const minutesTotal = minutesActive + minutesInactive + minutesLearn;

        const divisor = lengthTotal || minutesTotal;
        const activeValue = lengthTotal ? lengthActive : minutesActive;
        const inactiveValue = lengthTotal ? lengthInactive : minutesInactive;
        const learnValue = lengthTotal ? lengthLearn : minutesLearn;

        return {
          job: job.job || "Unassigned",
          active_pct: divisor ? (activeValue / divisor) * 100 : 0,
          inactive_pct: divisor ? (inactiveValue / divisor) * 100 : 0,
          learn_pct: divisor ? (learnValue / divisor) * 100 : 0,
        };
      });

      Plotly.react(
        "overviewDefectsByType",
        [
          {
            type: "pie",
            labels: defectsByType.map((d) => d.class),
            values: defectsByType.map((d) => d.count),
            hole: 0.35,
            textinfo: "label+percent",
            hoverinfo: "label+percent+value",
          },
        ],
        withResponsiveLayout({
          title: "Defects by Type",
          margin: { t: 50, l: 20, r: 20, b: 20 },
        }),
        plotlyConfig()
      );

      Plotly.react(
        "overviewDefectsTrend",
        [
          {
            type: "scatter",
            mode: "lines+markers",
            x: defectsTrend.map((d) => d.time),
            y: defectsTrend.map((d) => d.count),
            line: { color: "#0f172a" },
          },
        ],
        withResponsiveLayout({
          title: "Defects Trend",
          xaxis: { type: "date" },
          margin: { t: 40, l: 40, r: 20, b: 60 },
        }),
        plotlyConfig()
      );

      Plotly.react(
        "overviewJobsMeters",
        [
          {
            type: "bar",
            x: jobsMeters.map((d) => d.job),
            y: jobsMeters.map((d) => d.meters),
            marker: { color: "#10b981" },
          },
        ],
        {
          title: "Meters Run by Job",
          margin: { t: 40, l: 40, r: 20, b: 80 },
        },
        { responsive: true }
      );

      Plotly.react(
        "overviewJobsTime",
        [
          {
            type: "bar",
            name: "Active",
            x: jobsTimePct.map((d) => d.job),
            y: jobsTimePct.map((d) => d.active_pct),
            marker: { color: "#22c55e" },
          },
          {
            type: "bar",
            name: "Inactive",
            x: jobsTimePct.map((d) => d.job),
            y: jobsTimePct.map((d) => d.inactive_pct),
            marker: { color: "#ef4444" },
          },
          {
            type: "bar",
            name: "Learn",
            x: jobsTimePct.map((d) => d.job),
            y: jobsTimePct.map((d) => d.learn_pct),
            marker: { color: "#f59e0b" },
          },
        ],
        {
          barmode: "stack",
          title: "Inspection Mix by Job (%)",
          yaxis: { title: "Percent", ticksuffix: "%" },
          margin: { t: 50, l: 60, r: 20, b: 80 },
        },
        { responsive: true }
      );

      const rlmTrend = data.rlm_trend || {};
      updateRlmRange(rlmTrend);

      // Render in order so all time-series use the same reel-based window
      renderOverviewRlmTrend(rlmTrend);
      const reelDefectsTrend = data.job_reel_defects_timeline || [];
      const defectsTimelineSource = reelDefectsTrend.length ? reelDefectsTrend : jobsDefectsTrend;
      renderJobsDefectsTrend(defectsTimelineSource, jobsDefects);
      renderJobMetricCards(jobMetrics);
      const reelOpsTimeline = data.job_reel_operations_timeline || [];
      renderOperationsTimeline(jobEvents, reelOpsTimeline);
      renderJobHeatmap(jobHeatmaps);
    }

    let rlmRangeMs = null;

    function updateRlmRange(trendData) {
      const spans = Array.isArray(trendData.reel_spans) ? trendData.reel_spans : [];
      const tableRows = Array.isArray(trendData.table) ? trendData.table : [];
      let minTs = null;
      let maxTs = null;

      function consider(ts) {
        const date = ts ? new Date(ts) : null;
        if (!(date instanceof Date) || Number.isNaN(date.getTime())) return;
        const ms = date.getTime();
        if (minTs === null || ms < minTs) minTs = ms;
        if (maxTs === null || ms > maxTs) maxTs = ms;
      }

      spans.forEach((span) => {
        consider(span.start);
        consider(span.end);
      });
      tableRows.forEach((row) => {
        consider(row.start);
        consider(row.end);
      });

      if (minTs !== null && maxTs !== null && minTs < maxTs) {
        const paddedStart = minTs - 60 * 60 * 1000;
        const paddedEnd = maxTs + 60 * 60 * 1000;

        const roundedStart = new Date(paddedStart);
        roundedStart.setMinutes(0, 0, 0);

        const roundedEnd = new Date(paddedEnd);
        roundedEnd.setMinutes(0, 0, 0);
        if (roundedEnd.getTime() <= paddedEnd) {
          roundedEnd.setHours(roundedEnd.getHours() + 1);
        }

        rlmRangeMs = [roundedStart.getTime(), roundedEnd.getTime()];
      } else {
        rlmRangeMs = null;
      }
    }

    function toLocalIso(msValue) {
      const d = new Date(msValue);
      if (Number.isNaN(d.getTime())) return null;
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      const hours = String(d.getHours()).padStart(2, "0");
      const minutes = String(d.getMinutes()).padStart(2, "0");
      const seconds = String(d.getSeconds()).padStart(2, "0");
      return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
    }

    function getTimeRange(trendData) {
      if (trendData) {
        updateRlmRange(trendData);
      }
      if (rlmRangeMs) {
        const startIso = toLocalIso(rlmRangeMs[0]);
        const endIso = toLocalIso(rlmRangeMs[1]);
        if (startIso && endIso) {
          return [startIso, endIso];
        }
      }
      // Fallback to the current filter window if no reel-derived window exists
      const { start, end } = Filters.getState();
      const startDate = start ? new Date(start) : null;
      const endDate = end ? new Date(end) : null;
      if (
        startDate instanceof Date &&
        endDate instanceof Date &&
        !Number.isNaN(startDate.getTime()) &&
        !Number.isNaN(endDate.getTime()) &&
        startDate.getTime() < endDate.getTime()
      ) {
        const startIso = toLocalIso(startDate.getTime());
        const endIso = toLocalIso(endDate.getTime());
        if (startIso && endIso) {
          return [startIso, endIso];
        }
      }
      return null;
    }

    function renderJobsDefectsTrend(trend, totals) {
      const containerId = "overviewJobsDefects";
      if (!document.getElementById(containerId)) return;

      const range = getTimeRange();
      const rangeLabel =
        range && range.length === 2
          ? `${formatAsDate(range[0])} → ${formatAsDate(range[1])}`
          : "";

      if (!trend.length) {
        if (!totals.length) {
          Plotly.react(
            containerId,
            [],
            {
              title: "Defects per Job (Trend)",
              annotations: [
                {
                  text: "No defect activity in this window",
                  showarrow: false,
                  xref: "paper",
                  yref: "paper",
                  x: 0.5,
                  y: 0.5,
                  font: { color: "#94a3b8" },
                },
              ],
              xaxis: { visible: false },
              yaxis: { visible: false },
              margin: { t: 60, l: 40, r: 20, b: 40 },
            },
            plotlyConfig({ displayModeBar: false })
          );
        } else {
          Plotly.react(
            containerId,
            [
              {
                type: "bar",
                x: totals.map((item) => item.job),
                y: totals.map((item) => item.count),
                marker: { color: "#8b5cf6" },
              },
            ],
            {
              title: "Defects per Job",
              margin: { t: 60, l: 50, r: 20, b: 80 },
            },
            plotlyConfig()
          );
        }
        return;
      }

      const grouped = new Map();
      trend.forEach((point) => {
        const job = point.job || "Unassigned";
        const reelCode = point.reel_code || "";
        const reelId = point.reel_id !== undefined && point.reel_id !== null ? point.reel_id : null;
        const seriesLabel = reelCode ? `${reelCode}${job ? ` · ${job}` : ""}` : job;
        const entry = { time: point.time, count: point.count || 0, reel: reelCode, reel_id: reelId, job };
        if (!grouped.has(seriesLabel)) grouped.set(seriesLabel, []);
        grouped.get(seriesLabel).push(entry);
      });

      const traces = Array.from(grouped.entries()).map(([job, points]) => {
        const sortedPoints = points
          .slice()
          .sort((a, b) => new Date(a.time || 0).getTime() - new Date(b.time || 0).getTime());
        const xs = sortedPoints.map((item) => item.time);
        const ys = sortedPoints.map((item) => item.count || 0);
        const texts = sortedPoints.map((item) => {
          const base = buildDefectsTrendHover(item.reel || job, item);
          const timeLabel = item.time ? new Date(item.time).toLocaleString() : "";
          return timeLabel ? `${base}<br>${timeLabel}` : base;
        });
        const sizes = ys.map((value) => Math.min(6 + value * 2, 20));
        return {
          type: "scatter",
          mode: "lines+markers",
          name: job,
          x: xs,
          y: ys,
          text: texts,
          hoverinfo: "text",
          line: { shape: "linear" },
          marker: {
            size: sizes,
            sizemode: "diameter",
            line: { color: "#0f172a", width: 1 },
          },
          customdata: sortedPoints.map((item) => ({
            reel: item.reel,
            reel_id: item.reel_id,
            job: item.job,
            time: item.time,
          })),
        };
      });

      const layout = withResponsiveLayout({
        title: "Defects per Job (Trend)",
        xaxis: {
          type: "date",
          title: "Time",
          range: range || undefined,
          autorange: range ? false : true,
        },
        yaxis: { title: "Defects" },
        showlegend: false,
        margin: { t: 70, l: 60, r: 20, b: 90 },
        annotations: rangeLabel
          ? [
              {
                text: rangeLabel,
                showarrow: false,
                xref: "paper",
                yref: "paper",
                x: 0,
                y: 1.12,
                align: "left",
                font: { size: 11, color: "#475569" },
              },
            ]
          : [],
      });

      Plotly.react(containerId, traces, layout, plotlyConfig());

      const plotEl = document.getElementById(containerId);
      if (plotEl) {
        plotEl.on("plotly_click", (eventData) => {
          if (!eventData || !eventData.points || !eventData.points.length) return;
          const point = eventData.points[0];
          const payload = point && point.customdata ? point.customdata : null;
          const reelCode = payload && payload.reel ? payload.reel : "";
          const reelId = payload && payload.reel_id ? payload.reel_id : "";
          if (!reelCode && !reelId) return;
          Filters.addReel(reelCode, reelId);
          Router.setActive("job");
          scrollToTopSoon();
        });
        plotEl.style.cursor = "pointer";
      }
    }

    function renderOperationsTimeline(events, reelEvents = []) {
      const containerId = "overviewOperationsTimeline";
      if (!document.getElementById(containerId)) return;

      const range = getTimeRange();
      const rangeLabel =
        range && range.length === 2
          ? `${formatAsDate(range[0])} → ${formatAsDate(range[1])}`
          : "";

      const reelEventList = Array.isArray(reelEvents) ? reelEvents : [];
      const useReelEvents = reelEventList.length > 0;

      const filtered = (events || []).filter((event) =>
        TIMELINE_TYPES.includes(event.event_type)
      );

      if (useReelEvents) {
        const typesInData = Array.from(
          new Set(reelEventList.map((event) => event.event_type || "other"))
        );
        if (!typesInData.length) {
          return renderOperationsTimeline([], []);
        }
        const typeIndex = new Map(typesInData.map((type, idx) => [type, idx]));
        const traces = typesInData.map((type) => {
          const meta = getEventMeta(type);
          const points = reelEventList.filter((event) => (event.event_type || "other") === type);
          const xs = points.map((event) => event.time);
          const ys = points.map(() => typeIndex.get(type) || 0);
          const sizes = points.map((event) => Math.min(10 + (event.count || 1) * 2, 26));
          const texts = points.map((event) => {
            const lines = [];
            lines.push(`<b>${event.job || "Unassigned"}</b>`);
            if (event.reel_code) lines.push(`Reel: ${event.reel_code}`);
            if (event.time) {
              const date = new Date(event.time);
              if (!Number.isNaN(date.getTime())) {
                lines.push(date.toLocaleString());
              }
            }
            lines.push(`${meta.label} change`);
            lines.push(`Count: ${event.count || 0}`);
            return lines.join("<br>");
          });
          return {
            type: "scatter",
            mode: "markers",
            name: meta.label,
            x: xs,
            y: ys,
            text: texts,
            hoverinfo: "text",
            marker: {
              size: sizes,
              symbol: TIMELINE_SYMBOL[type] || "circle",
              color: meta.color,
              opacity: 0.9,
              line: { color: "#0f172a", width: 1 },
            },
            showlegend: false,
            customdata: points.map((event) => ({
              reel: event.reel_code || "",
              reel_id: event.reel_id || "",
            })),
          };
        });

        const yTicks = typesInData.map((type) => typeIndex.get(type) || 0);
        const yLabels = typesInData.map((type) => getEventMeta(type).label);

        const layout = {
          title: "Operational Changes Timeline",
          xaxis: {
            title: "Time",
            type: "date",
            range: range || undefined,
            autorange: range ? false : true,
          },
          yaxis: {
            title: "Change",
            tickvals: yTicks,
            ticktext: yLabels,
            range: [Math.min(...yTicks) - 0.5, Math.max(...yTicks) + 0.5],
            zeroline: false,
          },
          legend: { orientation: "h", x: 0, y: 1.1 },
          margin: { t: 70, l: 80, r: 20, b: 80 },
          shapes: [
            {
              type: "line",
              xref: "paper",
              x0: 0,
              x1: 1,
              yref: "paper",
              y0: 0,
              y1: 0,
              line: { color: "#cbd5f5", width: 1, dash: "dot" },
            },
          ],
          annotations: rangeLabel
            ? [
                {
                  text: rangeLabel,
                  showarrow: false,
                  xref: "paper",
                  yref: "paper",
                  x: 0,
                  y: 1.12,
                  align: "left",
                  font: { size: 11, color: "#475569" },
                },
              ]
            : [],
        };

        Plotly.react(containerId, traces, withResponsiveLayout(layout), plotlyConfig({ displayModeBar: false, showlegend: false }));
        const plotEl = document.getElementById(containerId);
        if (plotEl) {
        plotEl.on("plotly_click", (eventData) => {
          if (!eventData || !eventData.points || !eventData.points.length) return;
          const point = eventData.points[0];
          const payload = point && point.customdata ? point.customdata : null;
          const reelCode = payload && payload.reel ? payload.reel : "";
          const reelId = payload && payload.reel_id ? payload.reel_id : "";
          if (!reelCode && !reelId) return;
          Filters.addReel(reelCode, reelId);
          Router.setActive("job");
          scrollToTopSoon();
        });
          plotEl.style.cursor = "pointer";
        }
        return;
      }

      if (!filtered.length) {
        Plotly.react(
          containerId,
          [],
          {
            title: "Operational Changes Timeline",
            annotations: [
              {
                text: "No operational changes in this window",
                showarrow: false,
                xref: "paper",
                yref: "paper",
                x: 0.5,
                y: 0.6,
                font: { color: "#94a3b8" },
              },
            ],
            xaxis: { title: "Time", type: "date", range: range || undefined },
            yaxis: {
              title: "Change",
              range: [-0.1, 1.2],
              tickvals: [0, 1],
              ticktext: ["No change", "Change"],
              zeroline: true,
            },
            margin: { t: 60, l: 60, r: 20, b: 60 },
            shapes: [
              {
                type: "line",
                xref: "paper",
                x0: 0,
                x1: 1,
                y0: 0,
                y1: 0,
                line: { color: "#cbd5f5", width: 1, dash: "dot" },
              },
            ],
          },
          { responsive: true, displayModeBar: false }
        );
        return;
      }

      const grouped = new Map();
      filtered.forEach((event) => {
        const type = event.event_type || "other";
        if (!grouped.has(type)) {
          grouped.set(type, { meta: getEventMeta(type), list: [] });
        }
        grouped.get(type).list.push(event);
      });

      const typesInData = Array.from(
        new Set(filtered.map((event) => event.event_type || "other"))
      );
      const orderedTypes = TIMELINE_TYPES.filter((type) => typesInData.includes(type));

      const traces = orderedTypes
        .map((type) => {
          const bucket = grouped.get(type);
          if (!bucket) return null;
          const xs = bucket.list.map((event) => event.time);
          const ys = bucket.list.map(() => 1);
          const texts = bucket.list.map((event) => buildOperationHover(event, bucket.meta.label));
          return {
            type: "scatter",
            mode: "markers",
            name: bucket.meta.label,
            x: xs,
            y: ys,
            marker: {
              size: 14,
              symbol: TIMELINE_SYMBOL[type] || "circle",
              color: bucket.meta.color,
              opacity: 0.85,
              line: { color: "#0f172a", width: 1 },
            },
            hoverinfo: "text",
            text: texts,
          };
        })
        .filter(Boolean);

      const layout = {
        title: "Operational Changes Timeline",
        xaxis: {
          title: "Time",
          type: "date",
          range: range || undefined,
          autorange: range ? false : true,
        },
        yaxis: {
          title: "Change",
          range: [-0.1, 1.2],
          tickvals: [0, 1],
          ticktext: ["No change", "Change"],
          zeroline: true,
        },
        legend: { orientation: "h", x: 0, y: 1.1 },
        margin: { t: 70, l: 60, r: 20, b: 80 },
        shapes: [
          {
            type: "line",
            xref: "paper",
            x0: 0,
            x1: 1,
            y0: 0,
            y1: 0,
            line: { color: "#cbd5f5", width: 1, dash: "dot" },
          },
        ],
        annotations: rangeLabel
          ? [
              {
                text: rangeLabel,
                showarrow: false,
                xref: "paper",
                yref: "paper",
                x: 0,
                y: 1.12,
                align: "left",
                font: { size: 11, color: "#475569" },
              },
            ]
          : [],
      };

      Plotly.react(containerId, traces, withResponsiveLayout(layout), plotlyConfig({ displayModeBar: false }));
    }

    function renderOverviewRlmTrend(trendData) {
      const containerId = "overviewRlmTrendChart";
      const missingId = "overviewRlmMissing";
      const containerEl = document.getElementById(containerId);
      const missingEl = document.getElementById(missingId);
      if (!containerEl) return;
      updateRlmRange(trendData);

      const points = Array.isArray(trendData.points) ? trendData.points : [];
      const spans = Array.isArray(trendData.reel_spans) ? trendData.reel_spans : [];
      const tableRows = Array.isArray(trendData.table) ? trendData.table : [];
      const xRange = getTimeRange();
      const rangeLabel =
        xRange && xRange.length === 2
          ? `${formatAsDate(xRange[0])} → ${formatAsDate(xRange[1])}`
          : "";

      function renderMissingList(missingSpans) {
        if (!missingEl) return;
        if (!tableRows.length) {
          missingEl.innerHTML = "<div class=\"placeholder\">No reels in this window.</div>";
          return;
        }
        const pointStatsCache = new Map();
        const FEET_PER_METER = 3.28084;
        function formatRepeatDual(valueInInches) {
          if (valueInInches === null || valueInInches === undefined || Number.isNaN(valueInInches)) return "—";
          const mm = valueInInches * MM_TO_IN;
          return `${Utils.formatNumber(valueInInches, 2)} in (${Utils.formatNumber(mm, 2)} mm)`;
        }
        function getPointStats(row) {
          const label = labelFor(row);
          const cacheKey = `${label}-${row.start || ""}-${row.end || ""}`;
          if (pointStatsCache.has(cacheKey)) return pointStatsCache.get(cacheKey);
          const startTs = row.start ? new Date(row.start).getTime() : null;
          const endTs = row.end ? new Date(row.end).getTime() : null;
          const stats = { count: 0, min: null, max: null, sum: 0, hasRepeat: false };
          points.forEach((p) => {
            if (labelFor(p) !== label) return;
            const ts = p.time ? new Date(p.time).getTime() : null;
            if (ts === null || Number.isNaN(ts)) return;
            if (startTs !== null && !Number.isNaN(startTs) && ts < startTs) return;
            if (endTs !== null && !Number.isNaN(endTs) && ts > endTs) return;
            const repeat = Utils.toInches(p.repeat_length);
            stats.count += 1;
            if (repeat !== null && Number.isFinite(repeat)) {
              stats.hasRepeat = true;
              stats.min = stats.min === null ? repeat : Math.min(stats.min, repeat);
              stats.max = stats.max === null ? repeat : Math.max(stats.max, repeat);
              stats.sum += repeat;
            }
          });
          if (stats.hasRepeat && stats.count) {
            stats.avg = stats.sum / stats.count;
          } else {
            stats.avg = null;
          }
          pointStatsCache.set(cacheKey, stats);
          return stats;
        }
        const rows = tableRows
          .map((row) => {
            const label = labelFor(row);
            const windowLabel = `${formatAsDate(row.start)} → ${formatAsDate(row.end)}`;
            const metersLabel =
              row.meters !== undefined && row.meters !== null
                ? `${Utils.formatNumber(row.meters * FEET_PER_METER, 2)} ft (${Utils.formatNumber(row.meters, 2)} m)`
                : "N/A";
            const stats = getPointStats(row);
            const rlmCount = stats.count;
            const hasPoints = rlmCount > 0 ? "On" : "Off";
            const minRepeat = stats.min !== null ? formatRepeatDual(stats.min) : "—";
            const maxRepeat = stats.max !== null ? formatRepeatDual(stats.max) : "—";
            const avgRepeat = stats.avg !== null ? formatRepeatDual(stats.avg) : "—";
            return `
              <tr>
                <td>${Utils.escapeHtml(label)}</td>
                <td>${Utils.escapeHtml(windowLabel)}</td>
                <td>${Utils.escapeHtml(metersLabel)}</td>
                <td>${hasPoints}</td>
                <td>${rlmCount}</td>
                <td>${minRepeat}</td>
                <td>${maxRepeat}</td>
                <td>${avgRepeat}</td>
              </tr>
            `;
          })
          .join("");
        missingEl.innerHTML = `
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Reel</th>
                  <th>Window</th>
                  <th>Length (ft / m)</th>
                  <th>Repeat Length</th>
                  <th>RLM Points</th>
                  <th>Min Repeat (in / mm)</th>
                  <th>Max Repeat (in / mm)</th>
                  <th>Avg Repeat (in / mm)</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        `;
      }

      function formatAsDate(value) {
        if (!value) return "N/A";
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return "N/A";
        return date.toLocaleString();
      }

      if (!points.length) {
        renderMissingList(spans);
        Plotly.react(
          containerId,
          [],
          {
            title: "Repeat Length (RLM)",
            annotations: [
              {
                text: "No monitoring data in this window",
                showarrow: false,
                xref: "paper",
                yref: "paper",
                x: 0.5,
                y: 0.5,
                font: { color: "#94a3b8" },
              },
            ],
            xaxis: {
              title: "Time",
              type: "date",
              range: xRange || undefined,
              autorange: xRange ? false : true,
            },
        yaxis: { title: "Repeat Length (in)" },
            margin: { t: 60, l: 60, r: 60, b: 60 },
            showlegend: false,
            annotations: rangeLabel
              ? [
                  {
                    text: rangeLabel,
                    showarrow: false,
                    xref: "paper",
                    yref: "paper",
                    x: 0,
                    y: 1.15,
                    align: "left",
                    font: { size: 11, color: "#475569" },
                  },
                ]
              : [],
          },
          plotlyConfig({ displayModeBar: false })
        );
        return;
      }

      const palette = ["#0ea5e9", "#22c55e", "#f59e0b", "#ef4444", "#8b5cf6", "#14b8a6", "#ec4899", "#e11d48"];
      const colorMap = new Map();
      function colorForLabel(label) {
        const key = label || "Reel";
        if (!colorMap.has(key)) {
          const nextColor = palette[colorMap.size % palette.length];
          colorMap.set(key, nextColor);
        }
        return colorMap.get(key);
      }

      function labelFor(entry) {
        return entry.reel_code || entry.order_number || (Number.isFinite(entry.reel_id) ? `Reel ${entry.reel_id}` : "Reel");
      }

      function toRgba(hex, alpha) {
        if (typeof hex !== "string" || !hex.startsWith("#") || (hex.length !== 7 && hex.length !== 4)) {
          return `rgba(15, 23, 42, ${alpha})`;
        }
        let r;
        let g;
        let b;
        if (hex.length === 4) {
          r = parseInt(hex[1] + hex[1], 16);
          g = parseInt(hex[2] + hex[2], 16);
          b = parseInt(hex[3] + hex[3], 16);
        } else {
          r = parseInt(hex.slice(1, 3), 16);
          g = parseInt(hex.slice(3, 5), 16);
          b = parseInt(hex.slice(5, 7), 16);
        }
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
      }

      const normalizedPoints = points
        .map((entry) => {
          const time = entry.time;
          if (!time) return null;
          const webspeed = Number.isFinite(entry.webspeed) ? Number(entry.webspeed) : null;
          const repeatLength = Utils.toInches(entry.repeat_length);
          return {
            time,
            webspeed,
            repeatLength,
            label: labelFor(entry),
            reel_code: entry.reel_code || "",
            reel_id: entry.reel_id !== undefined ? entry.reel_id : null,
          };
        })
        .filter(Boolean)
        .sort((a, b) => new Date(a.time || 0).getTime() - new Date(b.time || 0).getTime());

      const labelsWithData = new Set(normalizedPoints.map((p) => p.label));
      const spansWithData = spans.filter((span) => labelsWithData.has(labelFor(span)));
      const spansMissing = spans.filter((span) => !labelsWithData.has(labelFor(span)));
      renderMissingList(spansMissing);

      function paddedRange(values) {
        const nums = values.filter((val) => Number.isFinite(val));
        if (!nums.length) return null;
        const minVal = Math.min(...nums);
        const maxVal = Math.max(...nums);
        const pad = 10;
        const lower = minVal - pad;
        const upper = maxVal + pad;
        return [lower, upper];
      }

      if (!normalizedPoints.length) {
        Plotly.react(
          containerId,
          [],
          {
            title: "Repeat Length & Web Speed (RLM)",
            annotations: [
              {
                text: "No monitoring data in this window",
                showarrow: false,
                xref: "paper",
                yref: "paper",
                x: 0.5,
                y: 0.5,
                font: { color: "#94a3b8" },
              },
            ],
            xaxis: { title: "Time", type: "date" },
            yaxis: { title: "Web Speed" },
            yaxis2: { title: "Repeat Length", overlaying: "y", side: "right" },
            margin: { t: 60, l: 60, r: 60, b: 60 },
          },
          plotlyConfig({ displayModeBar: false })
        );
        return;
      }

      const groupedRepeat = new Map();
      normalizedPoints.forEach((point) => {
        const label = point.label;
        if (!groupedRepeat.has(label)) groupedRepeat.set(label, []);
        groupedRepeat.get(label).push(point);
      });

      const repeatRanges = paddedRange(
        normalizedPoints
          .map((p) => (Number.isFinite(p.repeatLength) ? Number(p.repeatLength) : null))
          .filter((v) => v !== null)
      );

      function bucketByDate(series) {
        const buckets = new Map();
        series.forEach((item) => {
          const day = item.time ? item.time.split("T")[0] : "unknown";
          if (!buckets.has(day)) buckets.set(day, []);
          buckets.get(day).push(item);
        });
        return buckets;
      }

      const repeatTraces = Array.from(groupedRepeat.entries()).flatMap(([label, series]) => {
        const color = colorForLabel(label);
        const buckets = bucketByDate(series);
        return Array.from(buckets.entries()).map(([day, bucketSeries], idx) => ({
          type: "scatter",
          mode: "lines+markers",
          name: `Repeat Length (${label})`,
          x: bucketSeries.map((item) => item.time),
          y: bucketSeries.map((item) => item.repeatLength),
          line: { color },
          marker: { size: 6, color },
          hovertemplate: `Reel: ${label}<br>Date: ${day}<br>Time: %{x}<br>Repeat Length: %{y}<extra></extra>`,
          legendgroup: label,
          showlegend: false,
          customdata: bucketSeries.map((item) => ({
            reel: item.reel_code || label,
            reel_id: item.reel_id,
            time: item.time,
          })),
        }));
      });

      const shapes = spans
        .filter((span) => span && span.start && span.end)
        .map((span) => {
          const label = labelFor(span);
          const hasData = labelsWithData.has(label);
          const base = colorForLabel(label);
          const color = hasData ? toRgba(base, 0.08) : toRgba(base, 0.04);
          return {
            type: "rect",
            xref: "x",
            yref: "paper",
            x0: span.start,
            x1: span.end,
            y0: 0,
            y1: 1,
            fillcolor: color,
            line: { width: 0 },
          };
        });

      const layout = withResponsiveLayout({
        title: "Repeat Length (RLM)",
        xaxis: {
          title: "Time",
          type: "date",
          range: xRange || undefined,
          autorange: xRange ? false : true,
        },
        yaxis: { title: "Repeat Length (in)", range: repeatRanges || undefined },
        showlegend: false,
        margin: { t: 70, l: 70, r: 70, b: 80 },
        shapes,
        annotations: rangeLabel
          ? [
              {
                text: rangeLabel,
                showarrow: false,
                xref: "paper",
                yref: "paper",
                x: 0,
                y: 1.12,
                align: "left",
                font: { size: 11, color: "#475569" },
              },
            ]
          : [],
      });

      Plotly.react(containerId, repeatTraces, layout, plotlyConfig({ displayModeBar: false, showlegend: false }));

      const plotEl = document.getElementById(containerId);
      if (plotEl) {
        plotEl.on("plotly_click", (eventData) => {
          if (!eventData || !eventData.points || !eventData.points.length) return;
          const point = eventData.points[0];
          const payload = point && point.customdata ? point.customdata : null;
          const reelCode = payload && payload.reel ? payload.reel : "";
          const reelId = payload && payload.reel_id ? payload.reel_id : "";
          if (!reelCode && !reelId) return;
          Filters.addReel(reelCode, reelId);
          Router.setActive("job");
          scrollToTopSoon();
        });
        plotEl.style.cursor = "pointer";
      }

      renderAvgTrend(normalizedPoints);

      function renderAvgTrend(pointsList) {
        const avgContainer = document.getElementById("overviewRlmAvgTrend");
        if (!avgContainer) return;
        if (!pointsList.length) {
          Plotly.react(
            avgContainer,
            [],
            {
              title: "Average Repeat Length by Reel",
              annotations: [
                {
                  text: "No monitoring data in this window",
                  showarrow: false,
                  xref: "paper",
                  yref: "paper",
                  x: 0.5,
                  y: 0.5,
                  font: { color: "#94a3b8" },
                },
              ],
              xaxis: { visible: false },
              yaxis: { title: "Repeat Length (in)" },
              margin: { t: 50, l: 60, r: 20, b: 40 },
              showlegend: false,
            },
            plotlyConfig({ displayModeBar: false })
          );
          return;
        }

        const byLabel = new Map();
        pointsList.forEach((p) => {
          const label = p.label;
          if (!byLabel.has(label)) byLabel.set(label, []);
          byLabel.get(label).push(p);
        });

        const avgTraces = Array.from(byLabel.entries()).flatMap(([label, series]) => {
          const color = colorForLabel(label);
          const buckets = bucketByDate(series);
          return Array.from(buckets.entries()).map(([day, bucketSeries]) => {
            const repeatValues = bucketSeries
              .map((item) => (Number.isFinite(item.repeatLength) ? Number(item.repeatLength) : null))
              .filter((val) => val !== null);
            const avg =
              repeatValues.length > 0
                ? repeatValues.reduce((sum, val) => sum + val, 0) / repeatValues.length
                : null;
            const tsMid = bucketSeries[Math.floor(bucketSeries.length / 2)].time;
          return {
            type: "scatter",
            mode: "markers",
            name: `${label} (${day})`,
            x: [tsMid],
            y: [avg],
            marker: { size: 10, color },
            hovertemplate: `Reel: ${label}<br>Date: ${day}<br>Avg Repeat Length: %{y}<extra></extra>`,
            showlegend: false,
            customdata: [
              {
                reel: label,
                reel_id: series && series.length ? series[0].reel_id : null,
                time: tsMid,
              },
            ],
          };
        });
        });

        const avgValues = avgTraces
          .map((trace) => (trace && Array.isArray(trace.y) ? trace.y[0] : null))
          .filter((val) => Number.isFinite(val));
        const avgRange = paddedRange(avgValues);

        const avgPlotEl = document.getElementById("overviewRlmAvgTrend");

        Plotly.react(
          avgContainer,
          avgTraces,
          withResponsiveLayout({
            title: "Average Repeat Length by Reel",
            xaxis: {
              title: "Time",
              type: "date",
              range: xRange || undefined,
              autorange: xRange ? false : true,
            },
            yaxis: { title: "Repeat Length (in)", range: avgRange || undefined },
            showlegend: false,
            margin: { t: 60, l: 70, r: 20, b: 60 },
            annotations: rangeLabel
              ? [
                  {
                    text: rangeLabel,
                    showarrow: false,
                    xref: "paper",
                    yref: "paper",
                    x: 0,
                    y: 1.12,
                    align: "left",
                    font: { size: 11, color: "#475569" },
                  },
                ]
              : [],
          }),
          plotlyConfig({ displayModeBar: false, showlegend: false })
        );

        if (avgPlotEl) {
          avgPlotEl.on("plotly_click", (eventData) => {
            if (!eventData || !eventData.points || !eventData.points.length) return;
            const point = eventData.points[0];
            const raw = point && point.customdata;
            const payload = Array.isArray(raw) ? raw[0] : raw || null;
            const reelCode = payload && payload.reel ? payload.reel : "";
            const reelId = payload && payload.reel_id ? payload.reel_id : "";
            if (!reelCode && !reelId) return;
            Filters.addReel(reelCode, reelId);
            Router.setActive("job");
            scrollToTopSoon();
          });
          avgPlotEl.style.cursor = "pointer";
        }
      }
    }

    function renderJobMetricCards(jobMetrics) {
      const configs = [
        {
          id: "overviewRefChangesByJob",
          title: "Reference Changes by Job",
          key: "reference_changes",
          color: "#6366f1",
          label: "Reference changes",
        },
        {
          id: "overviewRlmMonitorsByJob",
          title: "RLM Monitor Points by Job",
          key: "rlm_monitor_count",
          color: "#0ea5e9",
          label: "RLM monitors",
        },
        {
          id: "overviewDefectsByJob",
          title: "Defects by Job",
          key: "defect_count",
          label: "Defects",
          breakdownKey: "defect_breakdown",
          palette: ["#f97316", "#fb923c", "#fdba74", "#facc15", "#fde047", "#bef264"],
        },
        {
          id: "overviewMasksByJob",
          title: "Masks Applied by Job",
          key: "mask_count",
          label: "Masks applied",
          breakdownKey: "mask_breakdown",
          palette: ["#ec4899", "#f472b6", "#f9a8d4", "#d946ef", "#a855f7", "#c4b5fd"],
        },
      ];

      configs.forEach((config) => renderSingleJobMetricChart(jobMetrics, config));
    }

    function renderJobHeatmap(jobHeatmaps) {
      if (!heatmapContainer) return;

      const filters = Filters.getState();
      const activeJobRaw = (filters.job || "").trim();
      const activeOrderRaw = (filters.order || "").trim();
      if (!activeJobRaw && !activeOrderRaw) {
        heatmapState.jobs = [];
        heatmapState.selectedJob = "";
        heatmapContainer.innerHTML =
          `<div class="heatmap-wrapper heatmap-empty heatmap-notice"><span class='badge'>Select a job or order to view the heatmap.</span></div>`;
        return;


      }

      heatmapState.jobs = [];
      heatmapState.selectedJob = "";
      heatmapContainer.innerHTML =
        `<div class="heatmap-wrapper heatmap-empty heatmap-notice"><span class='badge'>Loading heatmap…</span></div>`;

      const activeDisplayJob = activeJobRaw || "Unassigned";
      const activeDisplayOrder = activeOrderRaw || null;
      const normalized = (jobHeatmaps || []).map((job) => ({
        job: job.job || "Unassigned",
        order: job.order || ORDER_NONE,
        format_width: job.format_width,
        format_length: job.format_length,
        defects: job.defects || [],
        reference_images: job.reference_images || [],
        reference_background: job.reference_background || null,
      }));

      const matches = normalized.filter((job) => {
        const jobMatch = job.job === activeDisplayJob || job.job.toLowerCase() === activeDisplayJob.toLowerCase();
        const orderMatch = activeDisplayOrder
          ? activeDisplayOrder === ORDER_NONE
            ? job.order === ORDER_NONE
            : (job.order || ORDER_NONE) === activeDisplayOrder
          : true;
        return jobMatch && orderMatch;
      });

      if (!matches.length) {
        heatmapState.jobs = [];
        heatmapState.selectedJob = activeDisplayJob;
        heatmapContainer.innerHTML =
          `<div class="heatmap-wrapper heatmap-empty heatmap-notice"><span class='badge'>No defect coordinates for ${activeDisplayJob}${activeDisplayOrder ? ` / ${activeDisplayOrder}` : ""} in this window.</span></div>`;
        return;
      }

      const selectedEntry = matches[0];

      heatmapState.jobs = matches;
      heatmapState.selectedJob = selectedEntry.job;

      const slug = slugifyJob(selectedEntry.job);
      heatmapContainer.innerHTML = `
        <div class="heatmap-flex">
          <div class="heatmap-gallery" id="heatmap-gallery-${slug}"></div>
          <div class="heatmap-stack">
            <div class="heatmap-wrapper heatmap-empty" id="heatmap-overview-${slug}"></div>
            <div class="heatmap-legend heatmap-legend-overview" id="heatmap-overview-${slug}-legend"></div>
          </div>
        </div>
      `;

      const references = Array.isArray(selectedEntry.reference_images) ? selectedEntry.reference_images : [];
      const localFirstRef = references.find((ref) => ref && ref.image_src);
      const backgroundSrc = selectedEntry.reference_background || (localFirstRef ? localFirstRef.image_src : null);
      const referenceBackground = backgroundSrc ? urlForStatic(backgroundSrc) : null;
      const jobDefects = Array.isArray(selectedEntry.defects) ? selectedEntry.defects : [];

      JobHeatmap.attach(heatmapContainer, {
        reel: {
          reel_id: `overview-${slug}`,
          format_width: selectedEntry.format_width,
          format_length: selectedEntry.format_length,
        },
        defects: jobDefects.map((defect, idx) => ({
          defect_id: defect.defect_id ?? null,
          reel_id: defect.reel_id ?? `overview-${slug}`,
          coords: defect.coords,
          magnitude_value: Number(defect.magnitude_value ?? 0),
          severity_value: Number(defect.severity_value ?? 0),
          defect_key: defect.defect_key || `${defect.reel_id ?? "overview"}-${defect.defect_id ?? idx}`,
        })),
        referenceBackground,
      });

      renderReferenceGallery(heatmapContainer.querySelector(`#heatmap-gallery-${slug}`), references || []);
    }

    function renderReferenceGallery(container, references) {
      if (!container) return;
      if (!references || !references.length) {
        container.innerHTML = "<div class=\"heatmap-reference-empty\">No reference images for this job.</div>";
        return;
      }
      container.innerHTML = references
        .slice(0, 6)
        .map((ref, idx) => {
          const src = urlForStatic(ref.image_src);
          const alt = (ref.filename || `Reference ${idx + 1}`).replace(/"/g, "&quot;");
          return `<img src="${src}" alt="${alt}" loading="lazy" decoding="async" onclick="showImageModal('${src}')">`;
        })
        .join("");
    }

    function slugifyJob(name) {
      return String(name || "unassigned")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "unassigned";
    }

    function renderSingleJobMetricChart(jobMetrics, config) {
      const container = document.getElementById(config.id);
      if (!container) return;

      const source = Array.isArray(jobMetrics) ? jobMetrics : [];
      if (!source.length) {
        renderJobMetricPlaceholder(config.id, config.title);
        return;
      }

      const sorted = source
        .slice()
        .sort((a, b) => (b[config.key] || 0) - (a[config.key] || 0))
        .slice(0, 8);

      const hasValues = sorted.some((item) => (item[config.key] || 0) > 0);
      if (!hasValues) {
        renderJobMetricPlaceholder(config.id, config.title);
        return;
      }

      const labels = sorted.map((item) => item.job || "Unassigned");
      const totals = sorted.map((item) => item[config.key] || 0);

      if (config.breakdownKey) {
        const breakdownData = buildStackedSeries(sorted, config.breakdownKey, totals, config.palette);
        Plotly.react(
          config.id,
          breakdownData.traces,
          {
            title: config.title,
            margin: { t: 90, l: 70, r: 30, b: 80 },
            height: 360,
            barmode: "stack",
            xaxis: { automargin: true },
            yaxis: { rangemode: "tozero", title: config.label },
            legend: { orientation: "h", x: 0, y: 1.15 },
          },
          { responsive: true }
        );
        return;
      }

      const customData = sorted.map((item) => [
        item.top_defect_class || "None",
        item.top_defect_count || 0,
        item.dominant_phase || "N/A",
        item.top_mask_xml || "None",
        item.top_mask_count || 0,
      ]);

      Plotly.react(
        config.id,
        [
          {
            type: "bar",
            x: labels,
            y: totals,
            marker: { color: config.color },
            customdata: customData,
            hovertemplate:
              `<b>%{x}</b><br>${config.label}: %{y}<br>` +
              "Top defect: %{customdata[0]} (%{customdata[1]})<br>" +
              "Top mask: %{customdata[3]} (%{customdata[4]})<br>" +
              "Dominant phase: %{customdata[2]}<extra></extra>",
          },
        ],
        {
          title: config.title,
          margin: { t: 70, l: 70, r: 30, b: 80 },
          height: 360,
          yaxis: { rangemode: "tozero", title: config.label },
          xaxis: { automargin: true },
        },
        { responsive: true, displayModeBar: false }
      );
    }

    function buildStackedSeries(items, breakdownKey, totals, palette = []) {
      const maxSegments = 6;
      const accumTotals = new Map();

      items.forEach((item) => {
        (item[breakdownKey] || []).forEach(({ name, count }) => {
          if (!name || !count) return;
          accumTotals.set(name, (accumTotals.get(name) || 0) + count);
        });
      });

      const topCategories = Array.from(accumTotals.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, maxSegments)
        .map(([name]) => name);
      const topSet = new Set(topCategories);

      const traces = [];
      const colorPalette =
        palette.length >= topCategories.length
          ? palette
          : [
              "#f97316",
              "#fb923c",
              "#fde047",
              "#22c55e",
              "#2dd4bf",
              "#60a5fa",
              "#c084fc",
              "#f472b6",
            ];

      topCategories.forEach((category, idx) => {
        const color = colorPalette[idx % colorPalette.length];
        const values = items.map((item) => {
          const breakdown = item[breakdownKey] || [];
          const match = breakdown.find((entry) => entry.name === category);
          return match ? match.count || 0 : 0;
        });
        traces.push({
          type: "bar",
          name: category,
          x: items.map((item) => item.job || "Unassigned"),
          y: values,
          marker: { color },
          hovertemplate: "<b>%{x}</b><br>" + `${category}: %{y}<extra></extra>`,
        });
      });

      const otherValues = items.map((item, idx) => {
        const breakdown = item[breakdownKey] || [];
        const residual =
          (totals[idx] || 0) -
          breakdown.reduce((sum, entry) => (topSet.has(entry.name) ? sum + (entry.count || 0) : sum), 0);
        return Math.max(residual, 0);
      });

      if (otherValues.some((value) => value > 0)) {
        traces.push({
          type: "bar",
          name: "Other",
          x: items.map((item) => item.job || "Unassigned"),
          y: otherValues,
          marker: { color: "#94a3b8" },
          hovertemplate: "<b>%{x}</b><br>Other: %{y}<extra></extra>",
        });
      }

      return { traces };
    }

    function renderJobMetricPlaceholder(containerId, title) {
      Plotly.react(
        containerId,
        [],
        {
          title,
          annotations: [
            {
              text: "No data in this window",
              showarrow: false,
              xref: "paper",
              yref: "paper",
              x: 0.5,
              y: 0.5,
              font: { color: "#94a3b8" },
            },
          ],
          xaxis: { visible: false },
          yaxis: { visible: false },
          margin: { t: 50, l: 20, r: 20, b: 40 },
          height: 360,
        },
        { responsive: true, displayModeBar: false }
      );
    }

    function getEventMeta(type) {
      if (EVENT_META[type]) return EVENT_META[type];
      const label = (type || "Other")
        .split("_")
        .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
        .join(" ");
      return { label, color: "#475569" };
    }

    function buildOperationHover(event, label) {
      const lines = [];
      lines.push(`<b>${event.job || "Unassigned"}</b>`);
      if (event.time) {
        const date = new Date(event.time);
        if (!Number.isNaN(date.getTime())) {
          lines.push(date.toLocaleString());
        }
      }
      lines.push(`${label} change`);
      lines.push(`Count: ${event.count || 0}`);
      lines.push(...describeOperationEvent(event));
      return lines.filter(Boolean).join("<br>");
    }

    function describeOperationEvent(event) {
      const lines = [];
      switch (event.event_type) {
        case "defect":
          if (Array.isArray(event.class_breakdown) && event.class_breakdown.length) {
            const top = event.class_breakdown.slice(0, 4).map(
              (item) => `${item.class || "Unknown"} (${item.count})`
            );
            lines.push(`Top classes: ${top.join(", ")}`);
            if (event.class_breakdown.length > 4) {
              lines.push(`+${event.class_breakdown.length - 4} more classes`);
            }
          }
          break;
        case "reference_change":
          if (Array.isArray(event.details) && event.details.length) {
            const detail = event.details[0];
            const fromRef = detail.from || "previous";
            const toRef = detail.to || "new";
            lines.push(`Reference: ${fromRef} → ${toRef}`);
            if (detail.from_filename || detail.to_filename) {
              const fileFrom = detail.from_filename || "—";
              const fileTo = detail.to_filename || "—";
              lines.push(`File: ${fileFrom} → ${fileTo}`);
            }
          } else {
            lines.push("Reference image updated");
          }
          break;
        case "mask_applied":
          if (Array.isArray(event.details) && event.details.length) {
            const detail = event.details[0];
            const xml = detail.xml_id || "Mask";
            const sens = detail.sensitivity_id || detail.sensitivitysetid || "";
            const formatVal =
              detail.format_value !== undefined && detail.format_value !== null
                ? Utils.formatNumber(detail.format_value, 2)
                : "—";
            let maskLine = `${xml} · Format ${formatVal}`;
            if (sens) maskLine += ` · Sens ${sens}`;
            lines.push(maskLine);
          }
          break;
        case "sensitivity_change": {
          const summary = Array.isArray(event.details) ? event.details[0] : null;
          if (summary && Array.isArray(summary.changes)) {
            summary.changes.slice(0, 4).forEach((change) => {
              lines.push(formatSensitivityChange(change));
            });
            if (summary.changes.length > 4) {
              lines.push(`+${summary.changes.length - 4} more changes`);
            }
          }
          if (summary && summary.previous_settings) {
            lines.push(`Prev: ${formatSensitivitySnapshot(summary.previous_settings)}`);
          }
          if (summary && summary.current_settings) {
            lines.push(`Current: ${formatSensitivitySnapshot(summary.current_settings)}`);
          }
          break;
        }
        case "rlm_config_change": {
          const summary = Array.isArray(event.details) ? event.details[0] : null;
          if (summary && Array.isArray(summary.changes)) {
            summary.changes.slice(0, 5).forEach((change) => {
              lines.push(formatRlmChange(change));
            });
            if (summary.changes.length > 5) {
              lines.push(`+${summary.changes.length - 5} more keys`);
            }
          }
          if (summary && summary.previous_settings) {
            lines.push(`Prev: ${formatRlmSnapshot(summary.previous_settings)}`);
          }
          if (summary && summary.current_settings) {
            lines.push(`Current: ${formatRlmSnapshot(summary.current_settings)}`);
          }
          break;
        }
        default:
          break;
      }

      if (Array.isArray(event.reel_codes) && event.reel_codes.length) {
        lines.push(`Reels: ${event.reel_codes.join(", ")}`);
      }

      return lines.filter(Boolean);
    }

    function formatSensitivityChange(change) {
      if (!change || !change.class) return "";
      const prev = change.previous || {};
      const curr = change.current || {};
      const parts = [];
      parts.push(`${change.class}:`);
      parts.push(`T ${Utils.formatNumber(prev.threshold, 3)} → ${Utils.formatNumber(curr.threshold, 3)}`);
      parts.push(`W ${Utils.formatNumber(prev.warn, 3)} → ${Utils.formatNumber(curr.warn, 3)}`);
      return parts.join(" ");
    }

    function formatSensitivitySnapshot(snapshot) {
      const entries = Object.entries(snapshot || {});
      if (!entries.length) return "—";
      const maxEntries = 5;
      const rendered = entries.slice(0, maxEntries).map(([cls, values]) => {
        if (!values) return `${cls}: (n/a)`;
        return `${cls}: T ${Utils.formatNumber(values.threshold, 3)}, W ${Utils.formatNumber(values.warn, 3)}`;
      });
      const remainder = entries.length - maxEntries;
      if (remainder > 0) {
        rendered.push(`+${remainder} more classes`);
      }
      return rendered.join("; ");
    }

    function formatRlmChange(change) {
      if (!change || !change.key) return "";
      const oldVal = Utils.formatNumber(change.old, 3);
      const newVal = Utils.formatNumber(change.new, 3);
      return `${change.key}: ${oldVal} → ${newVal}`;
    }

    function formatRlmSnapshot(snapshot) {
      const entries = Object.entries(snapshot || {});
      if (!entries.length) return "—";
      const maxEntries = 6;
      const rendered = entries.slice(0, maxEntries).map(([key, value]) => `${key}: ${Utils.formatNumber(value, 3)}`);
      const remainder = entries.length - maxEntries;
      if (remainder > 0) {
        rendered.push(`+${remainder} more keys`);
      }
      return rendered.join(", ");
    }

    function buildDefectsTrendHover(job, point) {
      const lines = [`<b>${job}</b>`];
      if (point.time) {
        const date = new Date(point.time);
        if (!Number.isNaN(date.getTime())) {
          lines.push(date.toLocaleString());
        }
      }
      lines.push(`Defects: ${point.count || 0}`);
      return lines.join("<br>");
    }

    return { init, activate, onFiltersUpdated };
  })();

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
    let state = {
      page: 1,
      selectedReelId: null,
      sort: "time",
      cachedItems: [],
      pageInfo: null,
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

    const load = Utils.debounce(async () => {
      LoadingOverlay.show();
      try {
        const params = { page: state.page };
        if (state.reviewStatus) {
          params.review_status = state.reviewStatus;
        }
        const data = await Api.get("job-explorer", params);
        state.cachedItems = applySort(data.items || []);
        state.pageInfo = data.page_info || null;
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
        Filters.addReel(item.reel_code || "", item.reel_id);
      }
      renderList();
      await renderDetail(item.reel_id, immediate);
    }

    async function renderDetail(reelId, immediate) {
      if (!detailEl) return;
      const cached = summaryCache.get(reelId);
      if (cached) {
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
          Filters.addReel(reelCode, reelIdAttr || (currentSummary && currentSummary.reel ? currentSummary.reel.reel_id : ""));
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
        times.push(ts);
        webspeeds.push(Number(point.webspeed));
        repeatLengths.push(Utils.toInches(point.curlength));
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
    const REFERENCE_ZOOM_STORAGE_KEY = "qcReferenceZoom";
    const REFERENCE_ZOOM_MIN = 0.5;
    const REFERENCE_ZOOM_MAX = 3;
    const REFERENCE_ZOOM_STEP = 0.25;
    const REFERENCE_ZOOM_DEFAULT = 1;
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
    let referenceZoom = loadStoredReferenceZoom();
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
    let referenceRenderToken = 0;
    let positionTrackEl;
    let positionTrackMetaEl;
    let positionTrackStartEl;
    let positionTrackEndEl;
    let positionTrackSquaresEl;
    let positionTrackSegments = [];
    let positionTrackHoverIndex = null;

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
      referenceZoomInBtn = Utils.qs("#qcReferenceZoomIn");
      referenceZoomOutBtn = Utils.qs("#qcReferenceZoomOut");
      referenceZoomResetBtn = Utils.qs("#qcReferenceZoomReset");
      if (referenceMirrorBtn) {
        referenceMirrorBtn.addEventListener("click", () => {
          referenceMirror = !referenceMirror;
          persistReferenceMirror(referenceMirror);
          updateReferenceControls();
          applyReferenceTransform();
        });
      }
      if (referenceZoomInBtn) {
        referenceZoomInBtn.addEventListener("click", () => setReferenceZoom(referenceZoom + REFERENCE_ZOOM_STEP));
      }
      if (referenceZoomOutBtn) {
        referenceZoomOutBtn.addEventListener("click", () => setReferenceZoom(referenceZoom - REFERENCE_ZOOM_STEP));
      }
      if (referenceZoomResetBtn) {
        referenceZoomResetBtn.addEventListener("click", () => setReferenceZoom(REFERENCE_ZOOM_DEFAULT));
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
      renderReviewSummaryHistoryPlaceholder("Loading historical summary…");
      renderJobTablePlaceholder("Loading job summary…");
      fetchJobOverview(true).catch(() => {});
      fetchReviewSummaryHistory(true).catch(() => {});
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

    function loadStoredReferenceZoom() {
      try {
        const stored = window.localStorage.getItem(REFERENCE_ZOOM_STORAGE_KEY);
        if (stored === null) return REFERENCE_ZOOM_DEFAULT;
        return clampReferenceZoom(Number(stored));
      } catch (error) {
        return REFERENCE_ZOOM_DEFAULT;
      }
    }

    function persistReferenceZoom(value) {
      try {
        window.localStorage.setItem(REFERENCE_ZOOM_STORAGE_KEY, String(clampReferenceZoom(value)));
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
      shapes.forEach((shape) => {
        ctx.beginPath();
        ctx.moveTo((shape.xs[0] - geometry.centerX) * scale, -(shape.ys[0] - geometry.centerY) * scale);
        for (let idx = 1; idx < shape.xs.length; idx += 1) {
          ctx.lineTo((shape.xs[idx] - geometry.centerX) * scale, -(shape.ys[idx] - geometry.centerY) * scale);
        }
        ctx.closePath();
        ctx.fillStyle = "rgba(248, 113, 113, 0.45)";
        ctx.strokeStyle = "rgba(248, 113, 113, 0.95)";
        ctx.lineWidth = 2;
        ctx.fill();
        ctx.stroke();
      });
      ctx.restore();
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
      setReferenceStatus(
        referenceUrl
          ? "Overlaying the defect footprint on the reference image."
          : "Reference image unavailable. Showing footprint in reel space."
      );
      showReferencePlaceholder(referenceUrl ? "Loading reference preview…" : "Drawing footprint…");
      const image = await loadReferenceImage(referenceUrl);
      if (renderId !== referenceRenderToken) return;
      if (!image && referenceUrl) {
        setReferenceStatus("Failed to load reference image. Showing footprint in reel space.");
      } else if (image) {
        setReferenceStatus("Defect footprint aligned to the reference image.");
      }
      drawReferenceCanvas(shapes, geometry, image);
      applyReferenceTransform();
    }

    function setReferenceZoom(value) {
      const clamped = clampReferenceZoom(value);
      if (Math.abs(clamped - referenceZoom) < 0.0001) return;
      referenceZoom = clamped;
      persistReferenceZoom(referenceZoom);
      updateReferenceControls();
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
      if (referenceZoomResetBtn) {
        referenceZoomResetBtn.textContent = `${Math.round(referenceZoom * 100)}%`;
      }
      if (referenceZoomInBtn) {
        referenceZoomInBtn.disabled = referenceZoom >= REFERENCE_ZOOM_MAX - 0.001;
      }
      if (referenceZoomOutBtn) {
        referenceZoomOutBtn.disabled = referenceZoom <= REFERENCE_ZOOM_MIN + 0.001;
      }
    }

    function applyReferenceTransform() {
      if (!referenceInnerEl) return;
      const zoom = referenceZoom;
      const scaleX = referenceMirror ? -zoom : zoom;
      referenceInnerEl.style.transform = `scale(${scaleX}, ${zoom})`;
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
        fetchJobOverview(true).catch(() => {});
      }
      if (shouldRefreshReviewSummaryHistory) {
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

  const HeatmapTab = (() => {
    let tabEl;
    let stageEl;
    let overlayLayer;
    let draftLayer;
    let emptyNoticeEl;
    let imageEl;
    let saveBtn;
    let zoomButtons = [];
    let zoomValue = 1;
    let currentReferenceSrc = "";
    let referenceLoader = null;
    let prefetchedKey = "";
    let jobName = "";
    let machineId = null;
    let regions = [];
    let imageReady = false;
    let loading = false;
    let active = false;
    let tempRegionEl = null;
    let startPoint = null;
    let pointerId = null;
    let nextRegionId = -1;
    let polygonDraft = null;
    let drawMode = "rectangle";
    const POLYGON_CLOSE_THRESHOLD = 0.02;
    const ZOOM_MIN = 0.5;
    const ZOOM_MAX = 3;
    const ZOOM_STEP = 0.25;
    const ZOOM_DEFAULT = 1;
    const ZOOM_EPS = 0.001;

    function init() {
      tabEl = document.getElementById("tab-heatmap");
      if (!tabEl) return;
      stageEl = tabEl.querySelector("#heatmapStage");
      overlayLayer = tabEl.querySelector("#heatmapRegionsLayer");
      draftLayer = tabEl.querySelector("#heatmapDraftLayer");
      emptyNoticeEl = tabEl.querySelector("#heatmapEmptyNotice");
      imageEl = tabEl.querySelector("#heatmapReferenceImage");
      saveBtn = tabEl.querySelector("#heatmapSaveBtn");
      zoomButtons = Array.from(tabEl.querySelectorAll("[data-heatmap-zoom]"));
      if (imageEl) {
        imageEl.addEventListener("load", handleReferenceImageLoad);
        imageEl.addEventListener("error", () => {
          imageReady = false;
          imageEl.classList.add("hidden");
          if (stageEl) stageEl.classList.add("heatmap-stage--disabled");
          setEmptyNotice("Failed to load the reference image for this job.", false);
        });
      }
      if (stageEl) {
        stageEl.addEventListener("pointerdown", handlePointerDown);
      }
      if (overlayLayer) {
        overlayLayer.addEventListener("click", handleOverlayClick);
      }
      if (saveBtn) {
        saveBtn.addEventListener("click", handleSave);
      }
      if (zoomButtons.length) {
        zoomButtons.forEach((button) => {
          button.addEventListener("click", () => handleZoomAction(button.dataset.heatmapZoom));
        });
      }
      const toolButtons = Array.from(tabEl.querySelectorAll("[data-heatmap-tool]"));
      if (toolButtons.length) {
        toolButtons.forEach((button) => {
          button.addEventListener("click", () => {
            setDrawMode(button.dataset.heatmapTool || "rectangle");
          });
        });
        setDrawMode(drawMode);
      }
      applyZoom();
      maybePrefetchHeatmap();
      if (Filters && typeof Filters.onChange === "function") {
        Filters.onChange(() => {
          if (!active) {
            maybePrefetchHeatmap();
          }
        });
      }
    }

    function activate() {
      if (!tabEl) init();
      if (!tabEl) return;
      active = true;
      if (Filters && typeof Filters.setFieldDisabled === "function") {
        Filters.setFieldDisabled("order", true, { lock: true });
        Filters.setFieldDisabled("reel", true, { lock: true });
      }
      waitForFiltersReady().then(() => {
        if (!active) return;
        loadFromFilters();
      });
    }

    function deactivate() {
      active = false;
      if (Filters && typeof Filters.clearFieldOverride === "function") {
        Filters.clearFieldOverride("order");
        Filters.clearFieldOverride("reel");
      }
    }

    function onFiltersUpdated() {
      if (!active) return;
      loadFromFilters();
    }

    function waitForFiltersReady() {
      if (!Filters || typeof Filters.ready !== "function") {
        return Promise.resolve();
      }
      try {
        return Filters.ready();
      } catch (err) {
        return Promise.resolve();
      }
    }

    function loadFromFilters() {
      const filterState = Filters.getState ? Filters.getState() : {};
      jobName = (filterState.job || "").trim();
      machineId = filterState.machine_id || null;
      if (!jobName) {
        clearState();
        setEmptyNotice("Select a job to begin designing its heatmap.", false);
        return;
      }
      fetchHeatmap(filterState);
    }

    function setDrawMode(mode) {
      const normalized = mode === "polygon" ? "polygon" : "rectangle";
      drawMode = normalized;
      if (tabEl) {
        tabEl
          .querySelectorAll("[data-heatmap-tool]")
          .forEach((button) => button.classList.toggle("heatmap-tool-btn-active", button.dataset.heatmapTool === normalized));
      }
      if (normalized !== "polygon") {
        cancelPolygonDraft();
      }
    }

    function handleZoomAction(action) {
      if (!action || !jobName || !imageReady) return;
      if (action === "in") {
        setZoom(zoomValue + ZOOM_STEP);
      } else if (action === "out") {
        setZoom(zoomValue - ZOOM_STEP);
      } else if (action === "reset") {
        resetZoom();
      }
    }

    function setZoom(value, options = {}) {
      const force = Boolean(options.force);
      const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
      if (!force && Math.abs(clamped - zoomValue) < ZOOM_EPS) {
        updateZoomButtons();
        return;
      }
      zoomValue = clamped;
      applyZoom();
    }

    function resetZoom() {
      setZoom(ZOOM_DEFAULT, { force: true });
    }

    function applyZoom() {
      if (stageEl) {
        stageEl.style.transform = `scale(${zoomValue})`;
        stageEl.dataset.zoomLevel = zoomValue.toFixed(2);
      }
      updateZoomButtons();
    }

    function maybePrefetchHeatmap() {
      if (active) return;
      const filterState = Filters.getState ? Filters.getState() : {};
      const job = (filterState.job || "").trim();
      if (!job) {
        prefetchedKey = "";
        return;
      }
      const machine = filterState.machine_id || "";
      const key = `${job}::${machine}`;
      if (prefetchedKey === key) return;
      prefetchedKey = key;
      jobName = job;
      machineId = machine || null;
      fetchHeatmap(filterState);
    }

    function updateZoomButtons() {
      if (!zoomButtons.length) return;
      const interactive = Boolean(jobName && imageReady);
      zoomButtons.forEach((button) => {
        const action = button.dataset.heatmapZoom;
        if (!action) {
          button.disabled = !interactive;
          return;
        }
        if (!interactive) {
          button.disabled = true;
          return;
        }
        if (action === "in") {
          button.disabled = zoomValue >= ZOOM_MAX - ZOOM_EPS;
        } else if (action === "out") {
          button.disabled = zoomValue <= ZOOM_MIN + ZOOM_EPS;
        } else if (action === "reset") {
          button.disabled = Math.abs(zoomValue - ZOOM_DEFAULT) < ZOOM_EPS;
        } else {
          button.disabled = false;
        }
      });
    }

    function cancelReferenceLoader() {
      if (!referenceLoader) return;
      referenceLoader.onload = null;
      referenceLoader.onerror = null;
      referenceLoader = null;
    }

    function loadReferenceImage(src) {
      currentReferenceSrc = src || "";
      if (!imageEl) return;
      cancelReferenceLoader();
      if (!src) {
        imageReady = false;
        imageEl.classList.add("hidden");
        imageEl.removeAttribute("src");
        if (stageEl) stageEl.classList.add("heatmap-stage--disabled");
        return;
      }
      imageReady = false;
      imageEl.classList.add("hidden");
      if (stageEl) stageEl.classList.add("heatmap-stage--disabled");
      const loader = new Image();
      referenceLoader = loader;
      loader.decoding = "async";
      loader.onload = () => {
        if (referenceLoader !== loader) return;
        referenceLoader = null;
        if (imageEl.getAttribute("src") !== src) {
          imageEl.src = src;
        }
        handleReferenceImageLoad();
      };
      loader.onerror = () => {
        if (referenceLoader !== loader) return;
        referenceLoader = null;
        imageReady = false;
        if (imageEl) {
          imageEl.classList.add("hidden");
          imageEl.removeAttribute("src");
        }
        if (stageEl) stageEl.classList.add("heatmap-stage--disabled");
        setEmptyNotice("Failed to load the reference image for this job.", false);
      };
      loader.src = src;
    }

    function clearState() {
      regions = [];
      jobName = "";
      imageReady = false;
      resetZoom();
      cancelPolygonDraft();
      tempRegionEl = null;
      startPoint = null;
      pointerId = null;
      if (imageEl) {
        imageEl.classList.add("hidden");
        imageEl.removeAttribute("src");
      }
      currentReferenceSrc = "";
      cancelReferenceLoader();
      if (stageEl) stageEl.classList.add("heatmap-stage--disabled");
      if (overlayLayer) overlayLayer.innerHTML = "";
      if (draftLayer) draftLayer.innerHTML = "";
      updateSaveButtonState();
      updateZoomButtons();
    }

    async function fetchHeatmap(filterState) {
      if (!tabEl) return;
      cancelPolygonDraft();
      drawingCancel();
      cancelReferenceLoader();
      loading = true;
      updateSaveButtonState();
      setEmptyNotice("Loading heatmap…", true);
      try {
        const data = await Api.get("heatmap", {}, filterState);
        applyPayload(data || {});
      } catch (error) {
        if (overlayLayer) overlayLayer.innerHTML = "";
        regions = [];
        setEmptyNotice(
          error && error.message ? error.message : "Failed to load heatmap data. Try another job or refresh.",
          false
        );
        updateZoomButtons();
      } finally {
        loading = false;
        updateSaveButtonState();
      }
    }

    function applyPayload(payload) {
      resetZoom();
      const reference = payload && payload.reference_image ? payload.reference_image : null;
      if (reference && reference.image_src) {
        loadReferenceImage(urlForStatic(reference.image_src));
        setEmptyNotice("", true);
      } else {
        loadReferenceImage("");
        setEmptyNotice("No reference image is available for this job.", false);
      }
      regions = Array.isArray(payload?.regions) ? payload.regions.map(normalizeRegion).filter(Boolean) : [];
      renderRegions();
      updateSaveButtonState();
      updateZoomButtons();
    }

    function clamp01(value) {
      const num = Number(value);
      if (!Number.isFinite(num)) return 0;
      return Math.min(1, Math.max(0, num));
    }

    function normalizeRegion(region) {
      const shape = (region.shape || "rectangle").toLowerCase();
      const weight = Number(region.weight_pct) || 0;
      if (shape === "polygon" && Array.isArray(region.points)) {
        const points = region.points
          .map((pt) => ({
            x: clamp01(pt.x),
            y: clamp01(pt.y),
          }))
          .filter((pt) => Number.isFinite(pt.x) && Number.isFinite(pt.y));
        if (points.length < 3) return null;
        const bounds = boundingBox(points);
        if (!bounds) return null;
        return {
          id: region.region_id || generateRegionId(),
          shape: "polygon",
          weight_pct: weight,
          points,
          x0: bounds.minX,
          y0: bounds.minY,
          x1: bounds.maxX,
          y1: bounds.maxY,
        };
      }
      const x0 = clamp01(region.x0);
      const y0 = clamp01(region.y0);
      const x1 = clamp01(region.x1);
      const y1 = clamp01(region.y1);
      if (Math.abs(x1 - x0) < 0.00001 || Math.abs(y1 - y0) < 0.00001) {
        return null;
      }
      return {
        id: region.region_id || generateRegionId(),
        shape: "rectangle",
        weight_pct: weight,
        x0,
        y0,
        x1,
        y1,
      };
    }

    function boundingBox(points) {
      if (!Array.isArray(points) || !points.length) return null;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      points.forEach((pt) => {
        minX = Math.min(minX, pt.x);
        minY = Math.min(minY, pt.y);
        maxX = Math.max(maxX, pt.x);
        maxY = Math.max(maxY, pt.y);
      });
      if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
        return null;
      }
      return { minX, minY, maxX, maxY };
    }

    function getPolygonPoints(region) {
      if (!region) return [];
      if (region.shape === "polygon" && Array.isArray(region.points) && region.points.length >= 3) {
        return region.points
          .map((pt) => ({
            x: clamp01(pt.x),
            y: clamp01(pt.y),
          }))
          .filter((pt) => Number.isFinite(pt.x) && Number.isFinite(pt.y));
      }
      const x0 = clamp01(region.x0);
      const y0 = clamp01(region.y0);
      const x1 = clamp01(region.x1);
      const y1 = clamp01(region.y1);
      if (![x0, y0, x1, y1].every((val) => Number.isFinite(val))) {
        return [];
      }
      const left = Math.min(x0, x1);
      const right = Math.max(x0, x1);
      const top = Math.min(y0, y1);
      const bottom = Math.max(y0, y1);
      return [
        { x: left, y: top },
        { x: right, y: top },
        { x: right, y: bottom },
        { x: left, y: bottom },
      ];
    }

    function boxesOverlap(a, b) {
      if (!a || !b) return false;
      return !(a.maxX <= b.minX || a.minX >= b.maxX || a.maxY <= b.minY || a.minY >= b.maxY);
    }

    function polygonsOverlap(polyA, polyB) {
      for (let i = 0; i < polyA.length; i += 1) {
        const a1 = polyA[i];
        const a2 = polyA[(i + 1) % polyA.length];
        for (let j = 0; j < polyB.length; j += 1) {
          const b1 = polyB[j];
          const b2 = polyB[(j + 1) % polyB.length];
          if (segmentsIntersect(a1, a2, b1, b2)) {
            return true;
          }
        }
      }
      if (pointInPolygon(polyA[0], polyB)) return true;
      if (pointInPolygon(polyB[0], polyA)) return true;
      return false;
    }

    function segmentsIntersect(p1, p2, p3, p4) {
      const o1 = orientation(p1, p2, p3);
      const o2 = orientation(p1, p2, p4);
      const o3 = orientation(p3, p4, p1);
      const o4 = orientation(p3, p4, p2);
      if (o1 !== o2 && o3 !== o4) return true;
      if (o1 === 0 && onSegment(p1, p3, p2)) return true;
      if (o2 === 0 && onSegment(p1, p4, p2)) return true;
      if (o3 === 0 && onSegment(p3, p1, p4)) return true;
      if (o4 === 0 && onSegment(p3, p2, p4)) return true;
      return false;
    }

    function orientation(p, q, r) {
      const val = (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
      if (Math.abs(val) < 1e-9) return 0;
      return val > 0 ? 1 : 2;
    }

    function onSegment(p, q, r) {
      return (
        q.x <= Math.max(p.x, r.x) + 1e-9 &&
        q.x + 1e-9 >= Math.min(p.x, r.x) &&
        q.y <= Math.max(p.y, r.y) + 1e-9 &&
        q.y + 1e-9 >= Math.min(p.y, r.y)
      );
    }

    function pointInPolygon(point, polygon) {
      let inside = false;
      for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
        const xi = polygon[i].x;
        const yi = polygon[i].y;
        const xj = polygon[j].x;
        const yj = polygon[j].y;
        const intersect =
          yi > point.y !== yj > point.y && point.x < ((xj - xi) * (point.y - yi)) / (yj - yi + 1e-9) + xi;
        if (intersect) inside = !inside;
      }
      return inside;
    }

    function serializeRegion(region) {
      if (region.shape === "polygon" && Array.isArray(region.points)) {
        return {
          shape: "polygon",
          weight_pct: region.weight_pct,
          points: region.points.map((pt) => ({
            x: clamp01(pt.x),
            y: clamp01(pt.y),
          })),
        };
      }
      return {
        shape: "rectangle",
        weight_pct: region.weight_pct,
        x0: clamp01(region.x0),
        y0: clamp01(region.y0),
        x1: clamp01(region.x1),
        y1: clamp01(region.y1),
      };
    }

    function renderRegions() {
      if (!overlayLayer) return;
      overlayLayer.innerHTML = "";
      regions.forEach((region) => {
        const element =
          region.shape === "polygon" ? createPolygonRegionElement(region) : createRectangleRegionElement(region);
        if (element) {
          overlayLayer.appendChild(element);
        }
      });
      if (draftLayer) {
        draftLayer.innerHTML = "";
      }
    }

    function createRectangleRegionElement(region) {
      const bucket = bucketForWeight(region.weight_pct);
      const left = Math.min(region.x0, region.x1) * 100;
      const top = Math.min(region.y0, region.y1) * 100;
      const width = Math.abs(region.x1 - region.x0) * 100;
      const height = Math.abs(region.y1 - region.y0) * 100;
      if (width <= 0 || height <= 0) return null;
      const wrapper = document.createElement("div");
      wrapper.className = "heatmap-region";
      wrapper.dataset.regionId = region.id;
      wrapper.dataset.regionEditable = "true";
      wrapper.style.left = `${left}%`;
      wrapper.style.top = `${top}%`;
      wrapper.style.width = `${width}%`;
      wrapper.style.height = `${height}%`;

      const shape = document.createElement("div");
      shape.className = `heatmap-region__shape heatmap-region--bucket-${bucket}`;
      wrapper.appendChild(shape);
      wrapper.appendChild(buildRegionContent(region, width, height));
      return wrapper;
    }

    function createPolygonRegionElement(region) {
      if (!Array.isArray(region.points) || region.points.length < 3) return null;
      const bucket = bucketForWeight(region.weight_pct);
      const minX = Math.min(region.x0, region.x1);
      const maxX = Math.max(region.x0, region.x1);
      const minY = Math.min(region.y0, region.y1);
      const maxY = Math.max(region.y0, region.y1);
      const width = Math.max(0.0001, maxX - minX) * 100;
      const height = Math.max(0.0001, maxY - minY) * 100;
      const container = document.createElement("div");
      container.className = "heatmap-region heatmap-region--polygon";
      container.dataset.regionId = region.id;
      container.dataset.regionEditable = "true";
      container.style.left = `${minX * 100}%`;
      container.style.top = `${minY * 100}%`;
      container.style.width = `${width}%`;
      container.style.height = `${height}%`;
      const normalizedPoints = region.points.map((pt) => {
        const x = maxX - minX === 0 ? 0 : ((pt.x - minX) / (maxX - minX)) * 100;
        const y = maxY - minY === 0 ? 0 : ((pt.y - minY) / (maxY - minY)) * 100;
        return { x, y };
      });
      const polygonPoints = normalizedPoints.map((pt) => `${pt.x.toFixed(2)},${pt.y.toFixed(2)}`).join(" ");
      const shapeWrapper = document.createElement("div");
      shapeWrapper.className = "heatmap-region__polygon";
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 100 100");
      svg.setAttribute("preserveAspectRatio", "none");
      const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
      polygon.setAttribute("points", polygonPoints);
      polygon.classList.add(`heatmap-region--bucket-${bucket}`);
      svg.appendChild(polygon);
      shapeWrapper.appendChild(svg);
      container.appendChild(shapeWrapper);
      container.appendChild(buildRegionContent(region, width, height));
      return container;
    }

    function buildRegionContent(region, percentWidth, percentHeight) {
      const content = document.createElement("div");
      content.className = "heatmap-region__content";
      const position = computeLabelPosition(percentWidth, percentHeight);
      Object.entries(position).forEach(([key, value]) => {
        content.style[key] = value;
      });
      const label = document.createElement("span");
      label.className = "heatmap-region__label";
      label.textContent = `${Utils.formatNumber(region.weight_pct || 0)}%`;
      content.appendChild(label);
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "heatmap-region__remove";
      removeBtn.dataset.removeRegion = region.id;
      removeBtn.setAttribute("aria-label", "Remove region");
      removeBtn.innerHTML = "&times;";
      content.appendChild(removeBtn);
      return content;
    }

    function computeLabelPosition(percentWidth, percentHeight) {
      const minSize = Math.min(percentWidth, percentHeight);
      if (minSize >= 30) {
        return { left: "50%", top: "50%", transform: "translate(-50%, -50%)" };
      }
      if (minSize >= 20) {
        return { right: "6px", top: "6px", transform: "none" };
      }
      if (minSize >= 12) {
        return { left: "6px", top: "6px", transform: "none" };
      }
      if (minSize >= 8) {
        return { left: "6px", bottom: "6px", transform: "none" };
      }
      return { right: "6px", bottom: "6px", transform: "none" };
    }

    function handleOverlayClick(event) {
      const removeBtn = event.target.closest("[data-remove-region]");
      if (removeBtn) {
        const regionId = removeBtn.dataset.removeRegion;
        removeRegion(regionId);
        return;
      }
      const regionEl = event.target.closest("[data-region-id][data-region-editable]");
      if (regionEl) {
        const regionId = regionEl.dataset.regionId;
        if (!regionId) return;
        const clickedContent = event.target.closest(".heatmap-region__content");
        if (!clickedContent && !isEventInsideRegion(regionId, event)) {
          return;
        }
        promptRegionEdit(regionId);
      }
    }

    function isEventInsideRegion(regionId, event) {
      if (!regionId) return false;
      const region = regions.find((entry) => String(entry.id) === String(regionId));
      if (!region) return false;
      if (region.shape !== "polygon") return true;
      const polygonPoints = getPolygonPoints(region);
      if (!polygonPoints.length) return true;
      const point = getRelativePoint(event);
      if (!point) return false;
      return pointInPolygon(point, polygonPoints);
    }

    function promptRegionEdit(regionId) {
      if (!regionId) return;
      const region = regions.find((entry) => String(entry.id) === String(regionId));
      if (!region) return;
      openRegionModal(region);
    }

    function removeRegion(regionId) {
      if (!regionId) return;
      regions = regions.filter((region) => String(region.id) !== String(regionId));
      renderRegions();
      updateSaveButtonState();
    }

    function handlePointerDown(event) {
      if (!jobName) return;
      if (drawMode === "polygon") {
        handlePolygonClick(event);
        return;
      }
      if (event.button !== 0) return;
      const regionCover = event.target.closest("[data-region-id][data-region-editable]");
      if (regionCover) {
        const regionId = regionCover.dataset.regionId;
        const clickedContent = event.target.closest(".heatmap-region__content");
        if (regionId && (clickedContent || isEventInsideRegion(regionId, event))) {
          return;
        }
      }
      const point = getRelativePoint(event);
      if (!point) return;
      drawingCancel();
      startPoint = point;
      pointerId = event.pointerId;
      if (stageEl && stageEl.setPointerCapture) {
        stageEl.setPointerCapture(pointerId);
      }
      draftLayer && (draftLayer.innerHTML = "");
      tempRegionEl = document.createElement("div");
      tempRegionEl.className = "heatmap-region heatmap-region--draft";
      draftLayer && draftLayer.appendChild(tempRegionEl);
      updateDraftRegion(point.x, point.y, point.x, point.y);
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerCancel);
    }

    function handlePointerMove(event) {
      if (event.pointerId !== pointerId) return;
      const current = getRelativePoint(event);
      if (!current || !startPoint || !tempRegionEl) return;
      updateDraftRegion(startPoint.x, startPoint.y, current.x, current.y);
    }

    function handlePointerUp(event) {
      if (event.pointerId !== pointerId) return;
      finalizeDrawing(event);
    }

    function handlePointerCancel(event) {
      if (event.pointerId !== pointerId) return;
      drawingCancel();
    }

    function drawingCancel() {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      if (stageEl && pointerId !== null && stageEl.releasePointerCapture) {
        try {
          stageEl.releasePointerCapture(pointerId);
        } catch (err) {
          // ignore
        }
      }
      pointerId = null;
      startPoint = null;
      if (tempRegionEl && tempRegionEl.parentElement) {
        tempRegionEl.remove();
      }
      tempRegionEl = null;
    }

    function finalizeDrawing(event) {
      const endPoint = getRelativePoint(event);
      if (!startPoint || !endPoint) {
        drawingCancel();
        return;
      }
      const width = Math.abs(endPoint.x - startPoint.x);
      const height = Math.abs(endPoint.y - startPoint.y);
      if (width < 0.01 || height < 0.01) {
        drawingCancel();
        return;
      }
      const draftRegion = {
        id: generateRegionId(),
        shape: "rectangle",
        weight_pct: 50,
        x0: clamp01(startPoint.x),
        y0: clamp01(startPoint.y),
        x1: clamp01(endPoint.x),
        y1: clamp01(endPoint.y),
      };
      if (isRegionOverlapping(draftRegion)) {
        showToast("The new region overlaps with an existing zone. Please draw a non-overlapping area.", "error");
        drawingCancel();
        return;
      }
      drawingCancel();
      openRegionModal(draftRegion, {
        mode: "create",
        onConfirm: (region) => {
          regions.push(region);
          renderRegions();
          updateSaveButtonState();
        },
      });
    }

    function handlePolygonClick(event) {
      if (event.button !== 0) return;
      if (event.target.closest("[data-region-id]")) return;
      const point = getRelativePoint(event);
      if (!point) return;
      if (!polygonDraft) {
        startPolygonDraft(point);
        return;
      }
      if (isCloseToFirstPoint(point) && polygonDraft.points.length >= 3) {
        finalizePolygonDraft();
        return;
      }
      polygonDraft.points.push(point);
      updatePolygonDraftElement();
    }

    function startPolygonDraft(point) {
      polygonDraft = {
        points: [point],
        previewPoint: null,
        element: createPolygonDraftElement(),
        polyline: null,
      };
      if (polygonDraft.element) {
        polygonDraft.polyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
        polygonDraft.element.appendChild(polygonDraft.polyline);
      }
      if (draftLayer) {
        draftLayer.innerHTML = "";
        if (polygonDraft.element) {
          draftLayer.appendChild(polygonDraft.element);
        }
      }
      updatePolygonDraftElement();
      if (stageEl) {
        stageEl.addEventListener("pointermove", handlePolygonPointerMove);
      }
      document.addEventListener("keydown", handlePolygonKeyDown);
    }

    function handlePolygonPointerMove(event) {
      if (!polygonDraft) return;
      polygonDraft.previewPoint = getRelativePoint(event);
      updatePolygonDraftElement();
    }

    function handlePolygonKeyDown(event) {
      if (event.key === "Escape") {
        cancelPolygonDraft();
      }
    }

    function updatePolygonDraftElement() {
      if (!polygonDraft || !polygonDraft.polyline) return;
      const points = [...polygonDraft.points];
      if (polygonDraft.previewPoint) {
        points.push(polygonDraft.previewPoint);
      }
      const attr = points.map((pt) => `${(pt.x * 100).toFixed(2)} ${(pt.y * 100).toFixed(2)}`).join(" ");
      polygonDraft.polyline.setAttribute("points", attr);
    }

    function isCloseToFirstPoint(point) {
      if (!polygonDraft || !polygonDraft.points.length) return false;
      const first = polygonDraft.points[0];
      const distance = Math.hypot(point.x - first.x, point.y - first.y);
      return distance <= POLYGON_CLOSE_THRESHOLD;
    }

    function finalizePolygonDraft() {
      if (!polygonDraft || polygonDraft.points.length < 3) return;
      const points = polygonDraft.points.slice();
      cancelPolygonDraft(true);
      const bounds = boundingBox(points);
      if (!bounds) return;
      const region = {
        id: generateRegionId(),
        shape: "polygon",
        weight_pct: 50,
        points,
        x0: bounds.minX,
        y0: bounds.minY,
        x1: bounds.maxX,
        y1: bounds.maxY,
      };
      if (isRegionOverlapping(region)) {
        showToast("The new region overlaps with an existing zone. Please draw a non-overlapping area.", "error");
        return;
      }
      openRegionModal(region, {
        mode: "create",
        onConfirm: (confirmedRegion) => {
          regions.push(confirmedRegion);
          renderRegions();
          updateSaveButtonState();
        },
      });
    }

    function cancelPolygonDraft(finalizing = false) {
      if (!polygonDraft) return;
      if (polygonDraft.element && polygonDraft.element.parentElement) {
        polygonDraft.element.remove();
      }
      polygonDraft = null;
      if (stageEl) {
        stageEl.removeEventListener("pointermove", handlePolygonPointerMove);
      }
      document.removeEventListener("keydown", handlePolygonKeyDown);
      if (!finalizing && draftLayer) {
        draftLayer.innerHTML = "";
      }
    }

    function createPolygonDraftElement() {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 100 100");
      svg.setAttribute("preserveAspectRatio", "none");
      svg.classList.add("heatmap-polygon-draft");
      return svg;
    }

    function updateDraftRegion(x0, y0, x1, y1) {
      if (!tempRegionEl) return;
      const left = Math.min(x0, x1) * 100;
      const top = Math.min(y0, y1) * 100;
      const width = Math.abs(x1 - x0) * 100;
      const height = Math.abs(y1 - y0) * 100;
      tempRegionEl.style.left = `${left}%`;
      tempRegionEl.style.top = `${top}%`;
      tempRegionEl.style.width = `${width}%`;
      tempRegionEl.style.height = `${height}%`;
    }

    function getRelativePoint(event) {
      if (!stageEl) return null;
      const rect = stageEl.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;
      return { x: clamp01(x), y: clamp01(y) };
    }

    function updateSaveButtonState() {
      if (!saveBtn) return;
      saveBtn.disabled = !jobName || loading;
    }

    function setEmptyNotice(message, allowHide) {
      if (!emptyNoticeEl) return;
      if (!message && allowHide) {
        emptyNoticeEl.classList.add("hidden");
        return;
      }
      emptyNoticeEl.textContent = message;
      emptyNoticeEl.classList.remove("hidden");
    }

    function handleReferenceImageLoad() {
      imageReady = true;
      if (stageEl) stageEl.classList.remove("heatmap-stage--disabled");
      if (imageEl) imageEl.classList.remove("hidden");
      setEmptyNotice("", true);
      renderRegions();
      applyZoom();
    }

    function generateRegionId() {
      nextRegionId -= 1;
      return nextRegionId;
    }

    function isRegionOverlapping(candidate) {
      if (!candidate) return false;
      const candidatePoints = getPolygonPoints(candidate);
      if (!candidatePoints.length) return false;
      const candidateBox = boundingBox(candidatePoints);
      if (!candidateBox) return false;
      return regions.some((region) => {
        if (String(region.id) === String(candidate.id)) return false;
        const regionPoints = getPolygonPoints(region);
        if (!regionPoints.length) return false;
        const regionBox = boundingBox(regionPoints);
        if (!regionBox) return false;
        if (!boxesOverlap(candidateBox, regionBox)) return false;
        return polygonsOverlap(candidatePoints, regionPoints);
      });
    }

    async function handleSave() {
      if (!jobName) {
        showToast("Select a job before saving.", "error");
        return;
      }
      loading = true;
      updateSaveButtonState();
      try {
        await Api.post("heatmap", {
          job_name: jobName,
          machine_id: machineId,
          regions: regions.map(serializeRegion),
        });
        showToast("Heatmap saved.", "success");
        fetchHeatmap(Filters.getState ? Filters.getState() : {});
      } catch (error) {
        const message = error && error.message ? error.message : "Failed to save heatmap.";
        showToast(message, "error");
      } finally {
        loading = false;
        updateSaveButtonState();
      }
    }

    function openRegionModal(region, options = {}) {
      const modal = document.getElementById("heatmapModal");
      const input = document.getElementById("heatmapModalInput");
      const saveButton = modal ? modal.querySelector("[data-heatmap-modal-save]") : null;
      const cancelButtons = modal ? Array.from(modal.querySelectorAll("[data-heatmap-modal-cancel]")) : [];
      if (!modal || !input || !saveButton) return;
      modal.classList.remove("hidden");
      const titleEl = modal.querySelector("#heatmapModalTitle");
      if (titleEl) {
        titleEl.textContent = options && options.mode === "create" ? "New Region Weight" : "Update Region Weight";
      }
      input.value = Number(region.weight_pct) || 0;
      input.focus();
      input.select();
      setTimeout(() => {
        input.select();
      }, 0);
      const performSave = () => {
        const pct = Number(input.value);
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
          showToast("Enter a value between 0 and 100.", "error");
          return;
        }
        region.weight_pct = Math.round(pct);
        cleanup(false);
        if (typeof options.onConfirm === "function") {
          options.onConfirm(region);
        } else {
          renderRegions();
          updateSaveButtonState();
        }
      };
      const cleanup = (triggerCancelOrEvent = true) => {
        const triggerCancel =
          typeof triggerCancelOrEvent === "boolean" ? triggerCancelOrEvent : true;
        modal.classList.add("hidden");
        saveButton.removeEventListener("click", performSave);
        cancelButtons.forEach((btn) => btn.removeEventListener("click", cleanup));
        modal.removeEventListener("keydown", handleKeyPress);
        if (triggerCancel && typeof options.onCancel === "function") {
          options.onCancel();
        }
      };
      const handleKeyPress = (event) => {
        if (event.key === "Escape") {
          cleanup();
        } else if (event.key === "Enter") {
          event.preventDefault();
          performSave();
        }
      };
      saveButton.addEventListener("click", performSave);
      cancelButtons.forEach((btn) => btn.addEventListener("click", cleanup));
      modal.addEventListener("keydown", handleKeyPress);
    }

    return { init, activate, deactivate, onFiltersUpdated };
  })();

  function showToast(message, type = "success", timeout = 7000) {
    const container = document.getElementById("toastContainer");
    if (!container) {
      window.alert(message);
      return;
    }
    const toast = document.createElement("div");
    toast.className = `toast toast--${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.classList.add("toast--hide");
      setTimeout(() => toast.remove(), 300);
    }, timeout);
  }

  function urlForStatic(path) {
    if (!path) return "";
    // remove leading static/ if present
    const clean = path.replace(/^\/?static\//, "").replace(/^\/+/, "");
    const encoded = clean
      .split("/")
      .map(encodeURIComponent)
      .join("/");

    // ✅ use /static, not /dashboard/static
    return `${window.location.origin}/static/${encoded}`;
  }


  function bindTabNav() {
    Utils.qsa(".tab").forEach((button) => {
      button.addEventListener("click", () => {
        Router.setActive(button.dataset.tab);
      });
    });
  }

  function init() {
    bindTabNav();
    Filters.init();
    OverviewTab.init();
    JobExplorerTab.init();
    DefectExplorerTab.init();
    QcReviewTab.init();
    HeatmapTab.init();

    Router.register("overview", OverviewTab);
    Router.register("job", JobExplorerTab);
    Router.register("defects", DefectExplorerTab);
    Router.register("qc-review", QcReviewTab);
    Router.register("heatmap", HeatmapTab);
    Router.init();

    Filters.onChange(() => {
      Router.reloadActive();
    });
    // initial load for active tab
    Router.reloadActive();
  }

  function bindModalControls() {
    const prev = document.getElementById("modalPrevButton");
    const next = document.getElementById("modalNextButton");
    if (prev) {
      prev.addEventListener("click", () => cycleModalImage(-1));
    }
    if (next) {
      next.addEventListener("click", () => cycleModalImage(1));
    }
    syncModalDecisionUI(null);
    syncModalMetaBarVisibility();
  }

  function initializeApp() {
    init();
    bindModalControls();
    bindModalZoom();
    bindFootprintExpandButtons();
    bindFootprintModalZoom();
  }

  document.addEventListener("DOMContentLoaded", initializeApp);

  function updateModalMetaDisplay(sourceElement, index, total) {
    const meta = document.getElementById("modalMeta");
    if (!meta) return;
    const label =
      (sourceElement && (sourceElement.dataset.label || sourceElement.getAttribute("alt"))) || "";
    const hasTotal = Number.isFinite(total) && total > 0;
    const hasIndex = Number.isFinite(index) && index >= 0;
    const counter = hasTotal && hasIndex ? `${index + 1} / ${total}` : "";
    const displayParts = [];
    if (counter) displayParts.push(counter);
    if (label) displayParts.push(label);
    const display = displayParts.join(" · ");
    meta.textContent = display || label || counter || "";
  }

  function isDefectTabActive() {
    const tab = document.getElementById("tab-defects");
    return Boolean(tab && !tab.classList.contains("hidden"));
  }

  function syncModalMetaBarVisibility() {
    const modal = document.getElementById("imageModal");
    const shouldShow =
      Boolean(modal && modal.classList.contains("show")) && isDefectTabActive();
    ["modalMetaBar", "modalDecisionBar"].forEach((id) => {
      const bar = document.getElementById(id);
      if (bar) {
        bar.classList.toggle("hidden", !shouldShow);
      }
    });
  }

  function setModalImageScale(scale) {
    modalImageScale = Math.min(MODAL_MAX_SCALE, Math.max(MODAL_MIN_SCALE, scale));
    const img = document.getElementById("modalImage");
    if (img) {
      img.style.transform = `scale(${modalImageScale})`;
    }
  }

  function resetModalImageScale() {
    modalImageScale = 1;
    const img = document.getElementById("modalImage");
    if (img) {
      img.style.transform = "scale(1)";
    }
  }

  function bindModalZoom() {
    const img = document.getElementById("modalImage");
    if (!img) return;
    img.addEventListener(
      "wheel",
      (event) => {
        const modal = document.getElementById("imageModal");
        if (!modal || !modal.classList.contains("show")) return;
        event.preventDefault();
        const delta = event.deltaY > 0 ? -MODAL_SCALE_STEP : MODAL_SCALE_STEP;
        setModalImageScale(modalImageScale + delta);
      },
      { passive: false }
    );
  }

  function setFootprintModalScale(scale) {
    footprintModalScale = Math.min(FOOTPRINT_MAX_SCALE, Math.max(FOOTPRINT_MIN_SCALE, scale));
    updateFootprintModalScale();
  }

  function updateFootprintModalScale() {
    const stage = document.querySelector("#footprintModalCanvas .footprint-modal-stage");
    if (stage) {
      stage.style.transform = `scale(${footprintModalScale})`;
    }
  }

  function resetFootprintModalScale() {
    footprintModalScale = 1;
    updateFootprintModalScale();
  }

  function bindFootprintModalZoom() {
    const canvas = document.getElementById("footprintModalCanvas");
    if (canvas) {
      canvas.addEventListener(
        "wheel",
        (event) => {
          const modal = document.getElementById("footprintModal");
          if (!modal || !modal.classList.contains("show")) return;
          event.preventDefault();
          const delta = event.deltaY > 0 ? -FOOTPRINT_SCALE_STEP : FOOTPRINT_SCALE_STEP;
          setFootprintModalScale(footprintModalScale + delta);
        },
        { passive: false }
      );
    }
    const zoomIn = document.getElementById("footprintZoomIn");
    const zoomOut = document.getElementById("footprintZoomOut");
    const zoomReset = document.getElementById("footprintZoomReset");
    if (zoomIn) {
      zoomIn.addEventListener("click", () => setFootprintModalScale(footprintModalScale + FOOTPRINT_SCALE_STEP));
    }
    if (zoomOut) {
      zoomOut.addEventListener("click", () => setFootprintModalScale(footprintModalScale - FOOTPRINT_SCALE_STEP));
    }
    if (zoomReset) {
      zoomReset.addEventListener("click", () => resetFootprintModalScale());
    }
  }

  function bindFootprintExpandButtons() {
    Utils.qsa(".footprint-expand-btn").forEach((button) => {
      button.addEventListener("click", () => {
        const targetId = button.dataset.footprintTarget;
        const title = button.dataset.footprintTitle || button.textContent || "Footprint Preview";
        const target = targetId ? document.getElementById(targetId) : null;
        if (!target) return;
        openFootprintModal(target, title);
      });
    });
  }

  function openFootprintModal(sourceElement, title) {
    if (!sourceElement) return;
    closeFootprintModal();
    const modal = document.getElementById("footprintModal");
    const canvas = document.getElementById("footprintModalCanvas");
    const titleEl = document.getElementById("footprintModalTitle");
    if (!modal || !canvas) return;

    const placeholder = document.createElement("div");
    placeholder.className = "footprint-placeholder";
    placeholder.style.minHeight = `${sourceElement.offsetHeight || 200}px`;
    placeholder.style.minWidth = `${sourceElement.offsetWidth || sourceElement.clientWidth || 200}px`;
    sourceElement.parentNode.insertBefore(placeholder, sourceElement);

    const stage = document.createElement("div");
    stage.className = "footprint-modal-stage";
    stage.appendChild(sourceElement);

    canvas.innerHTML = "";
    canvas.appendChild(stage);

    footprintModalState.source = sourceElement;
    footprintModalState.placeholder = placeholder;
    footprintModalState.stage = stage;
    resetFootprintModalScale();

    if (titleEl) {
      titleEl.textContent = title || "Footprint Preview";
    }
    modal.classList.add("show");
  }

  function closeFootprintModal() {
    const modal = document.getElementById("footprintModal");
    if (modal) {
      modal.classList.remove("show");
    }
    if (footprintModalState.source && footprintModalState.placeholder) {
      footprintModalState.placeholder.parentNode.insertBefore(
        footprintModalState.source,
        footprintModalState.placeholder
      );
      footprintModalState.placeholder.remove();
    }
    if (footprintModalState.stage) {
      footprintModalState.stage.remove();
    }
    const canvas = document.getElementById("footprintModalCanvas");
    if (canvas) {
      canvas.innerHTML = "";
    }
    footprintModalState.source = null;
    footprintModalState.placeholder = null;
    footprintModalState.stage = null;
    footprintModalScale = 1;
  }

  window.closeFootprintModal = closeFootprintModal;

  function syncModalDecisionUI(decision) {
    const normalized = (decision || "").toLowerCase();
    const status = document.getElementById("modalDecisionStatus");
    if (status) {
      if (normalized === "pass" || normalized === "fail") {
        status.innerHTML = buildDecisionBadge(normalized);
      } else {
        status.innerHTML = '<span class="defect-decision-badge defect-decision-badge-pending">Pending</span>';
      }
    }
  }

  async function saveDefectLabel(defectId, { severity = null, confidence = null, uncertain = false, category = "" } = {}) {
    if (!defectId) {
      throw new Error("Missing defect id.");
    }
    const payload = {
      severity,
      confidence,
      uncertain: Boolean(uncertain),
    };
    if (category !== undefined) {
      const normalized = category === null ? "" : String(category || "").trim();
      payload.defect_category = normalized || null;
    }
    await Api.post(`defects/${defectId}/decision`, payload);
  }

  function applyModalSelection(element, index, total) {
    updateModalMetaDisplay(element, index, total);
    const modal = document.getElementById("imageModal");
    if (!modal) return;
    const defectId = element ? element.dataset.defectId || "" : "";
    const decision = element ? element.dataset.decision || "" : "";
    modal.dataset.defectId = defectId;
    modal.dataset.decision = decision;
    syncModalDecisionUI(decision);
    syncModalMetaBarVisibility();
  }

  function cycleModalImage(offset) {
    const modal = document.getElementById("imageModal");
    const img = document.getElementById("modalImage");
    if (!modal || !img || !modal.classList.contains("show")) return;
    const cells = Array.from(document.querySelectorAll("#defectTable tbody td img"));
    if (!cells.length) return;
    let currentIndex = Number(img.dataset.index);
    if (Number.isNaN(currentIndex) || currentIndex < 0) {
      currentIndex = 0;
    }
    const nextIndex = (currentIndex + offset + cells.length) % cells.length;
    const nextImg = cells[nextIndex];
    if (!nextImg) return;
    img.src = nextImg.src;
    img.dataset.index = String(nextIndex);
    resetModalImageScale();
    applyModalSelection(nextImg, nextIndex, cells.length);
  }

  window.showImageModal = function showImageModal(src, element) {
    const modal = document.getElementById("imageModal");
    const img = document.getElementById("modalImage");
    if (!modal || !img) return;
    resetModalImageScale();
    img.src = src;
    const cells = Array.from(document.querySelectorAll("#defectTable tbody td img"));
    let index = element ? cells.findIndex((cell) => cell === element) : -1;
    if (index < 0) {
      index = cells.findIndex((cell) => cell && cell.src === img.src);
    }
    img.dataset.index = index >= 0 ? String(index) : "";
    applyModalSelection(element || (index >= 0 ? cells[index] : null), index, cells.length);
    modal.classList.add("show");
    syncModalMetaBarVisibility();
  };

  window.closeModal = function closeModal() {
    const modal = document.getElementById("imageModal");
    const img = document.getElementById("modalImage");
    const meta = document.getElementById("modalMeta");
    if (modal) modal.classList.remove("show");
    if (img) {
      img.src = "";
      img.dataset.index = "";
    }
    if (meta) {
      meta.textContent = "";
    }
    resetModalImageScale();
    syncModalDecisionUI(null);
    if (modal) {
      modal.dataset.defectId = "";
      modal.dataset.decision = "";
    }
    syncModalMetaBarVisibility();
  };

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      const footprintModal = document.getElementById("footprintModal");
      if (footprintModal && footprintModal.classList.contains("show")) {
        closeFootprintModal();
        event.preventDefault();
        return;
      }
      const imageModal = document.getElementById("imageModal");
      if (imageModal && imageModal.classList.contains("show")) {
        closeModal();
        event.preventDefault();
        return;
      }
    }
    const modal = document.getElementById("imageModal");
    const img = document.getElementById("modalImage");
    if (!modal || !img || !modal.classList.contains("show")) return;
    if (event.key === "ArrowRight") {
      event.preventDefault();
      cycleModalImage(1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      cycleModalImage(-1);
    }
  });
})();
    function bucketForWeight(weight) {
      const value = Number(weight) || 0;
      if (value >= 90) return "critical";
      if (value >= 70) return "high";
      if (value >= 50) return "elevated";
      if (value >= 25) return "moderate";
      return "low";
    }
