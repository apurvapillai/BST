(function () {
  const FETCH_DEBOUNCE_MS = 400;

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
  };

  const ORDER_NONE = "__NONE__";

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
        };
        reelState.set(key, state);
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
      let globalMinX = Infinity;
      let globalMaxX = -Infinity;
      let globalMinY = Infinity;
      let globalMaxY = -Infinity;

      defects.forEach((defect) => {
        if (!Array.isArray(defect.coords)) return;
        const magnitude = Number(defect.magnitude_value) || 0;
        const severity = Number(defect.severity_value) || 0;
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
        stats.defectTotal += agg.count;
        stats.polygonCount += 1;
        stats.magnitudeSum += agg.magnitudeSum;
        stats.severitySum += agg.severitySum;
        stats.minX = Math.min(stats.minX, agg.minX);
        stats.maxX = Math.max(stats.maxX, agg.maxX);
        stats.minY = Math.min(stats.minY, agg.minY);
        stats.maxY = Math.max(stats.maxY, agg.maxY);
        stats.areaSum += (agg.area || 0) * agg.count;
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
      for (const bucket of HEATMAP_BUCKETS) {
        if (areaValue <= bucket.max) return bucket;
      }
      return HEATMAP_BUCKETS[HEATMAP_BUCKETS.length - 1];
    }

    function renderLegend(container, reel, bucketStatsArray, state, rerender) {
      const legendEl = document.getElementById(`${domId(reel)}-legend`);
      if (!legendEl) return;
      const statsMap = new Map((bucketStatsArray || []).map((entry) => [entry.bucket.key, entry]));
      const html = HEATMAP_BUCKETS.map((bucket) => {
        const stats = statsMap.get(bucket.key);
        const defectTotal = stats ? stats.defectTotal : 0;
        const hasData = defectTotal > 0;
        if (!hasData) {
          state.disabledBuckets.delete(bucket.key);
        }
        const toggledOff = state.disabledBuckets.has(bucket.key);
        const checkboxDisabled = hasData ? "" : "disabled";
        const checkedAttr = hasData && !toggledOff ? "checked" : "";
        const itemClass = !hasData || toggledOff ? "disabled" : "";
        const avgMag = hasData && stats ? stats.magnitudeSum / defectTotal : 0;
        const avgSev = hasData && stats ? stats.severitySum / defectTotal : 0;
        const countLabel = hasData ? `${defectTotal} defect${defectTotal === 1 ? "" : "s"}` : "0 defects";
        return `
          <label class="heatmap-legend-item ${itemClass}">
            <input type="checkbox" data-bucket="${bucket.key}" ${checkedAttr} ${checkboxDisabled}>
            <span class="swatch" style="background:${bucket.legend}"></span>
            <span class="legend-label">${bucket.label}</span>
            <span class="legend-count">${countLabel}</span>
            <span class="legend-meta">Mag ${Utils.formatNumber(avgMag, 2)} · Sev ${Utils.formatNumber(avgSev, 2)}</span>
          </label>
        `;
      }).join(" ");

      legendEl.innerHTML = html;
      legendEl.querySelectorAll('input[type="checkbox"]').forEach((input) => {
        if (input.disabled) return;
        input.addEventListener("change", (event) => {
          const bucketKey = event.target.dataset.bucket;
          if (!bucketKey) return;
          if (event.target.checked) {
            state.disabledBuckets.delete(bucketKey);
          } else {
            state.disabledBuckets.add(bucketKey);
          }
          window.requestAnimationFrame(() => rerender());
        });
      });
    }

    return { domId, attach };
  })();

  const MaskHeatmap = (() => {
    const PADDING = 24;
    const FALLBACK_SIZE = 360;
    const MASK_COLOR = {
      fill: "rgba(250, 204, 21, 0.12)",
      stroke: "rgba(217, 119, 6, 0.25)",
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

    const listeners = new Set();
    const defaults = {
      machine_id:
        (root && root.dataset.defaultMachine) ||
        (elements.machine ? elements.machine.value : ""),
      start:
        (root && root.dataset.defaultStart) ||
        (elements.start ? elements.start.value : ""),
      end:
        (root && root.dataset.defaultEnd) ||
        (elements.end ? elements.end.value : ""),
      job: "",
      order: "",
      reel_codes: [],
    };
    let state = {
      machine_id: defaults.machine_id,
      start: defaults.start,
      end: defaults.end,
      job: defaults.job,
      order: defaults.order,
      reel_codes: [],
    };
    let updating = false;
    let initialized = false;
    let refreshOptionsQueued = false;

    const scheduleEmit = Utils.debounce(() => emit(false), FETCH_DEBOUNCE_MS);
    let firstEmit = true;
    const scheduleOptionsRefresh = Utils.debounce(() => refreshOptions(), 200);

    function init() {
      if (!elements.machine) return;
      applySearchParams();
      renderChips();
      attachListeners();
      refreshOptions(true).then(() => {
        emit(true);
        initialized = true;
      });
    }

    function applySearchParams() {
      const params = new URLSearchParams(window.location.search);
      ["machine_id", "start", "end", "job", "order"].forEach((key) => {
        if (params.has(key)) {
      state[key] = params.get(key) || "";
    }
  });
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
  state.reel_codes = normalized;

  updating = true;
  if (elements.machine) elements.machine.value = state.machine_id || elements.machine.value;
  if (elements.start) elements.start.value = state.start || "";
  if (elements.end) elements.end.value = state.end || "";
  if (elements.job) elements.job.value = state.job || "";
  if (state.order === ORDER_NONE) {
    ensureOrderOption(ORDER_NONE, "None");
    if (elements.order) elements.order.value = ORDER_NONE;
  } else if (elements.order) {
    elements.order.value = state.order || "";
  }
      syncReelSelect();
      updating = false;
    }

    function attachListeners() {
      Object.entries(elements).forEach(([name, el]) => {
        if (!el || name === "chips") return;
        el.addEventListener("change", (evt) => {
          if (name === "reel") {
            handleInputChange(name, getSelectedReelsFromSelect());
          } else {
            handleInputChange(name, evt.target.value);
          }
        });
        if (name === "start" || name === "end") {
          el.addEventListener("blur", () => handleInputChange(name, el.value));
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

    function syncReelSelect() {
      if (!elements.reel) return;
      const selectedSet = new Set(state.reel_codes);
      const options = Array.from(elements.reel.options);
      selectedSet.forEach((code) => {
        if (!options.some((option) => option.value === code)) {
          const option = document.createElement("option");
          option.value = code;
          option.textContent = code;
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
          state.order = "";
          state.reel_codes = [];
          syncReelSelect();
          scheduleOptionsRefresh();
          break;
        case "start":
          state.start = value || "";
          scheduleOptionsRefresh();
          break;
        case "end":
          state.end = value || "";
          scheduleOptionsRefresh();
          break;
        case "job":
          state.job = value || "";
          state.order = "";
          state.reel_codes = [];
          syncReelSelect();
          scheduleOptionsRefresh();
          break;
        case "order":
          state.order = value || "";
          state.reel_codes = [];
          syncReelSelect();
          scheduleOptionsRefresh();
          break;
        case "reel":
          state.reel_codes = Array.isArray(value) ? value : [value].filter((entry) => entry);
          break;
        default:
          break;
      }
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
        updateSelect(elements.reel, data.reel_codes || [], state.reel_codes);
        updating = false;
      } catch (err) {
        console.error("Failed to refresh filter options", err);
      } finally {
        refreshOptionsQueued = false;
        LoadingOverlay.hide();
      }
    }

    function updateSelect(selectEl, values, currentValues) {
      if (!selectEl) return;
      const isMultiple = !!selectEl.multiple;
      const selectedSet = new Set(currentValues || []);
      const frag = document.createDocumentFragment();

      if (!isMultiple) {
        const defaultOption = document.createElement("option");
        defaultOption.value = "";
        defaultOption.textContent = "All";
        defaultOption.selected = !selectedSet.size;
        frag.appendChild(defaultOption);
      } else if (!Array.from(selectedSet).length) {
        const defaultOption = document.createElement("option");
        defaultOption.value = "";
        defaultOption.textContent = "All";
        defaultOption.selected = true;
        frag.appendChild(defaultOption);
      }

      const mergedValues = Array.from(new Set([...(values || []), ...(currentValues || [])])).filter(
        (value) => value
      );

      mergedValues.forEach((value) => {
        if (!value) return;
        const option = document.createElement("option");
        option.value = value;
        if (selectEl === elements.order && value === ORDER_NONE) {
          option.textContent = "None";
        } else {
          option.textContent = value;
        }
        option.selected = selectedSet.has(value);
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
      return {
        machine_id: state.machine_id,
        start: state.start,
        end: state.end,
        job: state.job,
        order: state.order,
        reel_code: [...state.reel_codes],
      };
    }

    function getReelCodes() {
      return [...state.reel_codes];
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
          state.reel_codes = [];
          syncReelSelect();
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
          state.reel_codes = [];
          syncReelSelect();
          await refreshOptions(true);
          emit(true);
          break;
        case "order":
          state.order = "";
          if (elements.order) elements.order.value = "";
          state.reel_codes = [];
          syncReelSelect();
          await refreshOptions(true);
          emit(true);
          break;
        case "reel_code":
          if (value) {
            removeReel(value, { emit: true });
          } else {
            state.reel_codes = [];
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
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return value;
      return date.toLocaleString();
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
      state.reel_codes.forEach((code) => {
        chips.push({ key: "reel_code", label: `Reel: ${code}`, removable: true, value: code });
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
      switch (field) {
        case "job":
          state.job = value || "";
          if (elements.job) elements.job.value = state.job;
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
        case "reel_codes":
          state.reel_codes = Array.isArray(value) ? value.filter((entry) => entry) : [];
          syncReelSelect();
          break;
        case "reel_code":
          state.reel_codes = value ? [value] : [];
          syncReelSelect();
          break;
        default:
          break;
      }
      updating = false;
      if (shouldEmit) emit(false);
      if (updateUrl && !shouldEmit) {
        Utils.updateUrlQuery(getState());
      }
    }

    function addReel(code) {
      const value = (code || "").trim();
      if (!value) return;
      if (!state.reel_codes.includes(value)) {
        state.reel_codes = [...state.reel_codes, value];
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
      updating = false;
      if (shouldEmit) emit(false);
      if (updateUrl) {
        Utils.updateUrlQuery(getState());
      }
    }

    function removeReel(code, { emit: shouldEmit = false } = {}) {
      const value = (code || "").trim();
      if (!value) return;
      const next = state.reel_codes.filter((entry) => entry !== value);
      if (next.length === state.reel_codes.length) return;
      state.reel_codes = next;
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

    return { init, getState, onChange, set, setMany, addReel, removeReel, getReelCodes };
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
                url.searchParams.append(key, Utils.normalizeDateInput(item));
              } else {
                url.searchParams.append(key, item);
              }
            });
          return;
        }
        if (key === "start" || key === "end") {
          url.searchParams.append(key, Utils.normalizeDateInput(value));
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
  };

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
      if (active === name) return;

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
        const total =
          (job.minutes_active || 0) +
          (job.minutes_inactive || 0) +
          (job.minutes_learn || 0);
        return {
          job: job.job,
          active_pct: total ? (job.minutes_active / total) * 100 : 0,
          inactive_pct: total ? (job.minutes_inactive / total) * 100 : 0,
          learn_pct: total ? (job.minutes_learn / total) * 100 : 0,
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
        {
          title: "Defects by Type",
          margin: { t: 50, l: 20, r: 20, b: 20 },
        },
        { responsive: true }
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
        {
          title: "Defects Trend",
          xaxis: { type: "date" },
          margin: { t: 40, l: 40, r: 20, b: 60 },
        },
        { responsive: true }
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

      renderJobsDefectsTrend(jobsDefectsTrend, jobsDefects);
      renderJobMetricCards(jobMetrics);
      renderOperationsTimeline(jobEvents);
      renderJobHeatmap(jobHeatmaps);
    }

    function renderJobsDefectsTrend(trend, totals) {
      const containerId = "overviewJobsDefects";
      if (!document.getElementById(containerId)) return;

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
            { responsive: true, displayModeBar: false }
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
            { responsive: true }
          );
        }
        return;
      }

      const grouped = new Map();
      trend.forEach((point) => {
        const job = point.job || "Unassigned";
        const entry = { time: point.time, count: point.count || 0 };
        if (!grouped.has(job)) grouped.set(job, []);
        grouped.get(job).push(entry);
      });

      const traces = Array.from(grouped.entries()).map(([job, points]) => {
        const sortedPoints = points
          .slice()
          .sort((a, b) => new Date(a.time || 0).getTime() - new Date(b.time || 0).getTime());
        const xs = sortedPoints.map((item) => item.time);
        const ys = sortedPoints.map((item) => item.count || 0);
        const texts = sortedPoints.map((item) => buildDefectsTrendHover(job, item));
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
        };
      });

      const layout = {
        title: "Defects per Job (Trend)",
        xaxis: { type: "date", title: "Time" },
        yaxis: { title: "Defects" },
        legend: { orientation: "h", x: 0, y: 1.1 },
        margin: { t: 70, l: 60, r: 20, b: 90 },
      };

      Plotly.react(containerId, traces, layout, { responsive: true });
    }

    function renderOperationsTimeline(events) {
      const containerId = "overviewOperationsTimeline";
      if (!document.getElementById(containerId)) return;

      const filtered = (events || []).filter((event) =>
        TIMELINE_TYPES.includes(event.event_type)
      );

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
            xaxis: { title: "Time", type: "date" },
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
        xaxis: { title: "Time", type: "date" },
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
      };

      Plotly.react(containerId, traces, layout, { responsive: true, displayModeBar: false });
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

      JobHeatmap.attach(heatmapContainer, {
        reel: {
          reel_id: `overview-${slug}`,
          format_width: selectedEntry.format_width,
          format_length: selectedEntry.format_length,
        },
        defects: (selectedEntry.defects || []).map((defect) => ({
          coords: defect.coords,
          magnitude_value: Number(defect.magnitude_value ?? 0),
          severity_value: Number(defect.severity_value ?? 0),
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
    let state = {
      page: 1,
      selectedReelId: null,
      sort: "time",
      cachedItems: [],
      pageInfo: null,
    };
    const summaryCache = new Map();

    const load = Utils.debounce(async () => {
      LoadingOverlay.show();
      try {
        const data = await Api.get("job-explorer", { page: state.page });
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

      if (sortSelect) {
        sortSelect.addEventListener("change", () => {
          state.sort = sortSelect.value;
          state.page = 1;
          load.flush();
        });
      }
    }

    function activate() {
      load.flush();
    }

    function onFiltersUpdated() {
      state.page = 1;
      load();
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
        case "drift":
          sorted.sort((a, b) => (b.rlm_config_drift?.length || 0) - (a.rlm_config_drift?.length || 0));
          break;
        case "rlm_off":
          sorted.sort((a, b) => {
            const aEnabled = a.rlm_enabled ? 1 : 0;
            const bEnabled = b.rlm_enabled ? 1 : 0;
            return aEnabled - bEnabled || ((b.defect_count || 0) - (a.defect_count || 0));
          });
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
      const selectedCodes = Filters.getReelCodes();
      const selectedSet = new Set(selectedCodes);
      const orderMap = new Map(selectedCodes.map((code, index) => [code, index]));
      const pinned = [];
      const others = [];
      state.cachedItems.forEach((item) => {
        if (item.reel_code && selectedSet.has(item.reel_code)) {
          pinned.push(item);
        } else {
          others.push(item);
        }
      });
      pinned.sort((a, b) => {
        const aIndex = orderMap.has(a.reel_code) ? orderMap.get(a.reel_code) : 0;
        const bIndex = orderMap.has(b.reel_code) ? orderMap.get(b.reel_code) : 0;
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
        if (item.reel_code && selectedSet.has(item.reel_code)) {
          card.classList.add("reviewed");
        }
        if ((item.ref_change_count || 0) > 1) {
          card.classList.add("alert");
        }

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
            ${item.reel_code && selectedSet.has(item.reel_code) ? '<span class="badge review">In review</span>' : ""}
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
      const selectedReels = Filters.getReelCodes();
      if (selectedReels.length) {
        const match = state.cachedItems.find((item) => item.reel_code && selectedReels.includes(item.reel_code));
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
        Filters.addReel(item.reel_code || "");
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
        attachSummaryActions(detailEl);
        JobHeatmap.attach(detailEl, cached);
        MaskHeatmap.attach(detailEl, cached);
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
        attachSummaryActions(detailEl);
        JobHeatmap.attach(detailEl, summary);
        MaskHeatmap.attach(detailEl, summary);
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
      const reelMeters =
        typeof reel.reel_start === "number" && typeof reel.reel_end === "number"
          ? reel.reel_end - reel.reel_start
          : null;
      const inReview = reel.reel_code ? Filters.getReelCodes().includes(reel.reel_code) : false;
      const addButton = reel.reel_code
        ? `<button class="add-reel-button" data-add-reel="${reel.reel_code}" ${inReview ? "disabled" : ""}>${
            inReview ? "In review" : "Add to review"
          }</button>`
        : "";

      const phaseTimeline = renderTimeline(phases, "Inspection timeline");
      const rlmPhaseTimeline =
        rlm.phases && rlm.phases.length
          ? renderTimeline(rlm.phases, "RLM timeline")
          : "<span class='badge'>No RLM phases</span>";

      const rlmPoints = rlm.points || [];
      const rlmPointsTable = rlmPoints.length
        ? `<table class="data-table">
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
                      <td>${formatMetricCell(point.curlength)}</td>
                    </tr>`
                 )
                 .join("")}
             </tbody>
           </table>`
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
      const heatmapInner = `
          ${wrapperHtml}
          <div class="heatmap-legend heatmap-legend-job" id="${heatmapId}-legend"></div>
        `;
      const heatmapSection = `
        <div class="summary-section">
          <h4>Defect Heatmap</h4>
          ${heatmapInner}
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

      return `
        <div class="summary-header">
          <div>
            <div class="summary-title">${reel.reel_code || "Reel"}</div>
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
            ${addButton}
          </div>
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
        </div>

        <div class="summary-section">
          <h4>Defects Summary</h4>
          <div class="summary-metadata">
            <span>Total defects: ${defectsSummary.total || 0}</span>
            <span>Types: ${defectsSummary.types || 0}</span>
          </div>
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
        .filter((p) => p.start !== null && p.end !== null && p.end > p.start);
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

    function attachSummaryActions(scope) {
      if (!scope) return;
      const button = scope.querySelector("[data-add-reel]");
      if (!button) return;
      const reelCode = button.dataset.addReel || "";
      const isAlreadySelected = reelCode && Filters.getReelCodes().includes(reelCode);
      if (isAlreadySelected) {
        button.disabled = true;
        button.textContent = "In review";
      }
      button.addEventListener("click", () => {
        if (!reelCode) return;
        const summary = summaryCache.get(state.selectedReelId) || null;
        if (summary && summary.reel) {
          const { job_name: jobName, order_number: orderNumber } = summary.reel;
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
        Filters.addReel(reelCode);
        button.disabled = true;
        button.textContent = "In review";
      });
    }

    function formatRange(start, end) {
      if (!start && !end) return "N/A";
      const startStr = start ? formatTime(start) : "N/A";
      const endStr = end ? formatTime(end) : "N/A";
      return `${startStr} → ${endStr}`;
    }

    function formatTime(value) {
      if (!value) return "N/A";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return "N/A";
      return date.toLocaleString();
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
    let tableBody;
    let paginationEl;
    let summaryTotalEl;
    let summaryTypesEl;
    let tabScope;
    let chipsEl;
    let updating = false;
    let typeOptionCache = new Set();

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
    };

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

        const data = await Api.get("defects", params);
        state.pageInfo = data.page_info || null;
        const byType = data.by_type || [];
        updateTypeOptions(byType);
        renderSummary(data.page_info, byType);
        renderCharts(data, byType);
        renderFootprints(data);
        renderTable(data.rows || []);
        renderPagination();
      } catch (err) {
        console.error("Defect explorer load failed", err);
        if (tableBody) {
          tableBody.innerHTML = `<tr><td colspan="11">Failed to load defects: ${err.message}</td></tr>`;
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
      tableBody = Utils.qs("#defectTable tbody");
      paginationEl = Utils.qs("#defectPagination");
      summaryTotalEl = Utils.qs("[data-defect-total]");
      summaryTypesEl = Utils.qs("#defectSummaryTypes");
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

    function renderTable(rows) {
      if (!tableBody) return;
      if (!rows.length) {
        tableBody.innerHTML = "<tr><td colspan='11'>No defects match the current filters.</td></tr>";
        return;
      }
      tableBody.innerHTML = rows
        .map(
          (row) => `
            <tr>
              <td>${row.reel_id || ""}</td>
              <td>${row.reel_code || ""}</td>
              <td>${formatTime(row.defect_time)}</td>
              <td>${row.order_number || ""}</td>
              <td>${row.job_name || ""}</td>
              <td>${row.class_name || ""}</td>
              <td>${Utils.formatNumber(row.magnitude_value, 3)}</td>
              <td>${Utils.formatNumber(row.severity_value, 2)}</td>
              <td>${Utils.formatNumber(row.format_position, 1)}</td>
              <td>${row.phase || ""}</td>
              <td>
                ${
                  row.image_src
                    ? `<img src="${urlForStatic(row.image_src)}" alt="defect" data-label="${[row.job_name, row.order_number, row.defect_time]
                        .filter(Boolean)
                        .join(" · ")}" data-index="${row.defect_id || ""}" onclick="showImageModal('${urlForStatic(
                        row.image_src
                      )}', this)" loading="lazy" decoding="async">`
                    : ""
                }
              </td>
            </tr>
          `
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

    function renderFootprints(data) {
      if (!tabScope) return;
      const heatmapEl = Utils.qs("#heatmap-defect-explorer");
      const maskEl = Utils.qs("#mask-heatmap-defect-explorer");
      const coordsEl = Utils.qs("#mask-heatmap-defect-explorer-coords");
      if (!heatmapEl || !maskEl) return;

      const reel = buildFootprintReel(data);
      const defects = extractDefectFootprints(data.rows || []);
      const masks = Array.isArray(data.masks) ? data.masks : [];
      const referenceImages = Array.isArray(data.reference_images) ? data.reference_images : [];
      const latestReference = referenceImages.length ? referenceImages[0] : null;
      const referenceBackground =
        latestReference && latestReference.image_src ? urlForStatic(latestReference.image_src) : null;

      JobHeatmap.attach(tabScope, { reel, defects, referenceBackground });
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
          const display = coordsText ? escapeHtml(coordsText) : "—";
          return `
            <div class="mask-coords-row">
              <span class="mask-coords-label">${escapeHtml(label)}</span>
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

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function formatTime(value) {
      if (!value) return "";
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
    }

    return { init, activate, deactivate, onFiltersUpdated };
  })();

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

    Router.register("overview", OverviewTab);
    Router.register("job", JobExplorerTab);
    Router.register("defects", DefectExplorerTab);
    Router.init();

    Filters.onChange(() => {
      Router.reloadActive();
    });
    // initial load for active tab
    Router.reloadActive();
  }

  document.addEventListener("DOMContentLoaded", init);

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

  window.showImageModal = function showImageModal(src, element) {
    const modal = document.getElementById("imageModal");
    const img = document.getElementById("modalImage");
    if (!modal || !img) return;
    img.src = src;
    const cells = Array.from(document.querySelectorAll("#defectTable tbody td img"));
    let index = element ? cells.findIndex((cell) => cell === element) : -1;
    if (index < 0) {
      index = cells.findIndex((cell) => cell && cell.src === img.src);
    }
    img.dataset.index = index >= 0 ? String(index) : "";
    updateModalMetaDisplay(
      element || (index >= 0 ? cells[index] : null),
      index,
      cells.length
    );
    modal.classList.add("show");
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
  };

  document.addEventListener("keydown", (event) => {
    const modal = document.getElementById("imageModal");
    const img = document.getElementById("modalImage");
    if (!modal || !img || !modal.classList.contains("show")) return;
    let currentIndex = Number(img.dataset.index);
    const cells = Array.from(document.querySelectorAll("#defectTable tbody td img"));
    if (!cells.length) return;
    if (Number.isNaN(currentIndex) || currentIndex < 0) {
      currentIndex = 0;
    }
    if (event.key === "ArrowRight") {
      const nextIndex = (currentIndex + 1) % cells.length;
      const nextImg = cells[nextIndex];
      if (nextImg) {
        img.src = nextImg.src;
        img.dataset.index = String(nextIndex);
        updateModalMetaDisplay(nextImg, nextIndex, cells.length);
      }
    } else if (event.key === "ArrowLeft") {
      const prevIndex = (currentIndex - 1 + cells.length) % cells.length;
      const prevImg = cells[prevIndex];
      if (prevImg) {
        img.src = prevImg.src;
        img.dataset.index = String(prevIndex);
        updateModalMetaDisplay(prevImg, prevIndex, cells.length);
      }
    }
  });
})();
