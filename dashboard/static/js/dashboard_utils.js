const FETCH_DEBOUNCE_MS = 400;

  const MM_TO_IN = 25.4;
  const METERS_TO_FEET = 3.28084;

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
      const feet = Number(value) * METERS_TO_FEET;
      return `${Utils.formatNumber(feet, 2)} ft`;
    },
    buildFilterRequestKey(state = {}) {
      const normalizeValue = (value) => (value === undefined || value === null ? "" : String(value));
      const normalizeList = (value) => {
        if (!value) return [];
        const list = Array.isArray(value) ? value.slice() : [value];
        return list
          .map((entry) => normalizeValue(entry))
          .filter((entry) => entry !== "")
          .sort();
      };
      const normalized = {
        machine_id: normalizeValue(state.machine_id),
        start: normalizeValue(state.start),
        end: normalizeValue(state.end),
        job: normalizeValue(state.job),
        order: normalizeValue(state.order),
        reel_id: normalizeList(state.reel_id || state.reel_ids),
        reel_code: normalizeList(state.reel_code || state.reel_codes),
      };
      try {
        return JSON.stringify(normalized);
      } catch (err) {
        return "";
      }
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
    populateSelect(selectEl, entries = [], { placeholder } = {}) {
      if (!selectEl) return;
      const options = [];
      if (placeholder !== undefined) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = placeholder;
        options.push(option);
      }
      entries.forEach((entry) => {
        if (!entry || !entry.value) return;
        const option = document.createElement("option");
        option.value = entry.value;
        option.textContent = entry.label || entry.value;
        options.push(option);
      });
      selectEl.innerHTML = "";
      options.forEach((option) => selectEl.appendChild(option));
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

  function readCssVar(name) {
    return getComputedStyle(document.body).getPropertyValue(name).trim();
  }

  function getPlotlyTheme() {
    return {
      paper: readCssVar("--chart-paper-bg") || "#ffffff",
      plot: readCssVar("--chart-plot-bg") || "#f8fafc",
      font: readCssVar("--text-primary") || "#1f2937",
      grid: readCssVar("--chart-grid-color") || "rgba(148,163,184,0.4)",
      axis: readCssVar("--chart-axis-color") || "#94a3b8",
    };
  }

  function applyPlotlyTheme(layout = {}) {
    const theme = getPlotlyTheme();
    const themed = {
      ...layout,
      paper_bgcolor: theme.paper,
      plot_bgcolor: theme.plot,
      font: { ...(layout.font || {}), color: theme.font },
      hoverlabel: {
        ...(layout.hoverlabel || {}),
        bgcolor: theme.plot,
        font: { ...(layout.hoverlabel?.font || {}), color: theme.font },
      },
      legend: {
        ...(layout.legend || {}),
        font: { ...(layout.legend?.font || {}), color: theme.font },
      },
    };
    Object.keys(themed).forEach((key) => {
      if (/^[xy]axis\d*/.test(key)) {
        themed[key] = {
          ...themed[key],
          gridcolor: themed[key].gridcolor || theme.grid,
          zerolinecolor: themed[key].zerolinecolor || theme.grid,
          linecolor: themed[key].linecolor || theme.axis,
          tickfont: { ...(themed[key].tickfont || {}), color: theme.font },
        };
        if (themed[key].title) {
          themed[key] = {
            ...themed[key],
            title: {
              ...themed[key].title,
              font: { ...(themed[key].title.font || {}), color: theme.font },
            },
          };
        }
      }
    });
    return themed;
  }

  function refreshPlotlyTheme() {
    if (!window.Plotly) return;
    const theme = getPlotlyTheme();
    document.querySelectorAll(".js-plotly-plot").forEach((node) => {
      const layout = node.layout || {};
      const update = {
        paper_bgcolor: theme.paper,
        plot_bgcolor: theme.plot,
        "legend.font.color": theme.font,
        "hoverlabel.bgcolor": theme.plot,
        "hoverlabel.font.color": theme.font,
      };
      Object.keys(layout).forEach((key) => {
        if (/^[xy]axis\d*/.test(key)) {
          update[`${key}.gridcolor`] = theme.grid;
          update[`${key}.zerolinecolor`] = theme.grid;
          update[`${key}.linecolor`] = theme.axis;
          update[`${key}.tickfont.color`] = theme.font;
          if (layout[key]?.title) {
            update[`${key}.title.font.color`] = theme.font;
          }
        }
      });
      window.Plotly.relayout(node, update);
    });
  }

  window.addEventListener("bst:themechange", refreshPlotlyTheme);

  function ensurePlotlyPatched() {
    if (!window.Plotly || window.Plotly.__bstThemed) return;
    const originalReact = window.Plotly.react;
    const originalNewPlot = window.Plotly.newPlot;
    window.Plotly.react = function patchedReact(gd, data, layout, config) {
      return originalReact.call(this, gd, data, layout ? applyPlotlyTheme(layout) : layout, config);
    };
    window.Plotly.newPlot = function patchedNewPlot(gd, data, layout, config) {
      return originalNewPlot.call(this, gd, data, layout ? applyPlotlyTheme(layout) : layout, config);
    };
    window.Plotly.__bstThemed = true;
  }

  if (window.Plotly) {
    ensurePlotlyPatched();
  } else {
    window.addEventListener("load", ensurePlotlyPatched, { once: true });
  }

  function withResponsiveLayout(layout) {
    const themed = applyPlotlyTheme(layout);
    if (isMobileViewport()) {
      return { ...themed, dragmode: "pan" };
    }
    return themed;
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

  function formatReelLabel({ code = "", order = "", time = "" } = {}) {
    const parts = [];
    const normalizedCode = code || "";
    const normalizedOrder = order || "";
    const normalizedTime = normalizeReelLabelTime(time);
    if (normalizedCode) parts.push(normalizedCode);
    if (normalizedOrder) parts.push(normalizedOrder);
    if (normalizedTime) parts.push(normalizedTime);
    if (parts.length) return parts.join(" · ");
    if (normalizedCode) return normalizedCode;
    if (normalizedOrder) return normalizedOrder;
    return "Reel";
  }

  function normalizeReelLabelTime(value) {
    if (!value) return "";
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value.trim())) {
      return value.trim();
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const pad = (num) => String(num).padStart(2, "0");
    const year = date.getFullYear();
    const month = pad(date.getMonth() + 1);
    const day = pad(date.getDate());
    const hours = pad(date.getHours());
    const minutes = pad(date.getMinutes());
    return `${year}-${month}-${day} ${hours}:${minutes}`;
  }

  function computeDefaultRange(days = 2) {
    const end = new Date();
    const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
    const toIso = (date) => date.toISOString().slice(0, 10);
    return { start: toIso(start), end: toIso(end) };
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
        ctx.drawImage(backgroundImage, -drawWidth / 2, -drawLength / 2, drawWidth, drawLength);
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
        ctx.moveTo((agg.xs[0] - centerX) * scale, (agg.ys[0] - centerY) * scale);
        for (let i = 1; i < agg.xs.length; i += 1) {
          ctx.lineTo((agg.xs[i] - centerX) * scale, (agg.ys[i] - centerY) * scale);
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
      const snapshots = Array.isArray(summary.mask_snapshots) ? summary.mask_snapshots : [];
      const snapshotContainers = scope.querySelectorAll("[data-mask-snapshot-index]");
      if (snapshots.length && snapshotContainers.length) {
        snapshotContainers.forEach((container) => {
          const index = Number(container.dataset.maskSnapshotIndex);
          const snapshot = snapshots[index];
          if (snapshot) {
            attachContainer(container, reel, snapshot.masks || [], summary);
          }
        });
        return;
      }
      const container = scope.querySelector(`#${domId(reel)}`);
      if (container) {
        attachContainer(container, reel, summary.masks || [], summary);
      }
    }

    function attachContainer(container, reel, masks, summary) {
      const key = container.id || domId(reel);
      let state = heatmapState.get(key);
      if (!state) {
        state = {
          backgroundImage: null,
          backgroundImageUrl: null,
          backgroundImageLoading: false,
          backgroundImageFailed: false,
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
        state.backgroundImageFailed = false;
      }
      window.requestAnimationFrame(() => render(container, reel, masks, state));
    }

    function render(container, reel, masks, state, options = {}) {
      // options.offscreen: draw a copy at options.width and return the canvas (used by click-to-enlarge)
      const offscreen = Boolean(options.offscreen);
      const parsed = collectMasks(masks, Number(reel?.format_length));
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
        state.backgroundImageFailed = false;
      } else if (state.backgroundImageUrl !== referenceBackground) {
        state.backgroundImageUrl = referenceBackground;
        state.backgroundImage = null;
        state.backgroundImageLoading = false;
        state.backgroundImageFailed = false;
      }

      const hasMaskShapes = parsed.shapes.length > 0;
      if (!hasMaskShapes && !hasDimensionsOriginal) {
        const message = "Format dimensions unavailable";
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

      if (!offscreen) {
        container.classList.remove("heatmap-empty");
        container.innerHTML = "";
      }

      const dpr = offscreen ? 1 : window.devicePixelRatio || 1;
      const availableWidth = options.width || container.clientWidth || FALLBACK_SIZE;
      const size = Math.max(PADDING * 4, availableWidth);
      // padding, text and line widths grow with the canvas, so a large copy looks like the small one
      const ui = offscreen ? size / 420 : 1;
      const pad = PADDING * ui;

      const bounds = parsed.bounds;
      const frameCenterX = hasDimensionsOriginal ? 0 : (bounds.minX + bounds.maxX) / 2 || 0;
      const frameCenterY = hasDimensionsOriginal ? 0 : (bounds.minY + bounds.maxY) / 2 || 0;
      const frameMinX = frameCenterX - workingWidth / 2;
      const frameMaxX = frameCenterX + workingWidth / 2;
      const frameMinY = frameCenterY - workingLength / 2;
      const frameMaxY = frameCenterY + workingLength / 2;
      const viewMinX = hasMaskShapes ? Math.min(frameMinX, bounds.minX) : frameMinX;
      const viewMaxX = hasMaskShapes ? Math.max(frameMaxX, bounds.maxX) : frameMaxX;
      const viewMinY = hasMaskShapes ? Math.min(frameMinY, bounds.minY) : frameMinY;
      const viewMaxY = hasMaskShapes ? Math.max(frameMaxY, bounds.maxY) : frameMaxY;
      const viewWidth = Math.max(viewMaxX - viewMinX, 1);
      const viewLength = Math.max(viewMaxY - viewMinY, 1);
      const viewCenterX = (viewMinX + viewMaxX) / 2;
      const viewCenterY = (viewMinY + viewMaxY) / 2;
      // The canvas is only as tall as the picture needs, so it fits the card with no empty bands.
      const maxCanvasHeight = Math.round(size * 1.25);
      let scale = (size - pad * 2) / viewWidth;
      let canvasHeight = Math.ceil(viewLength * scale + pad * 2);
      if (canvasHeight > maxCanvasHeight) {
        canvasHeight = maxCanvasHeight;
        scale = (canvasHeight - pad * 2) / viewLength;
      }
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(size * dpr);
      canvas.height = Math.round(canvasHeight * dpr);
      canvas.style.width = `${size}px`;
      canvas.style.height = `${canvasHeight}px`;

      const ctx = canvas.getContext("2d");
      ctx.scale(dpr, dpr);

      ctx.fillStyle = "#f0f4fb";
      ctx.fillRect(0, 0, size, canvasHeight);

      const drawWidth = workingWidth * scale;
      const drawLength = workingLength * scale;
      const frameLeft = (frameMinX - viewCenterX) * scale;
      const frameTop = (frameMinY - viewCenterY) * scale;

      ctx.save();
      ctx.translate(size / 2, canvasHeight / 2);

      let backgroundImage = null;
      if (referenceBackground) {
        if (state.backgroundImage) {
          backgroundImage = state.backgroundImage;
        } else if (!offscreen && !state.backgroundImageLoading && !state.backgroundImageFailed) {
          state.backgroundImageLoading = true;
          requestBackgroundImage(referenceBackground, (img) => {
            state.backgroundImageLoading = false;
            if (!img) {
              if (state.backgroundImageUrl === referenceBackground) {
                state.backgroundImage = null;
                state.backgroundImageFailed = true;
              }
              window.requestAnimationFrame(() => {
                if (!container.isConnected) return;
                render(container, reel, masks, state);
              });
              return;
            }
            if (state.referenceBackground !== referenceBackground || !container.isConnected) {
              return;
            }
            state.backgroundImageFailed = false;
            state.backgroundImage = img;
            window.requestAnimationFrame(() => {
              if (!container.isConnected) return;
              render(container, reel, masks, state);
            });
          });
        }
      }

      if (backgroundImage) {
        ctx.drawImage(backgroundImage, frameLeft, frameTop, drawWidth, drawLength);
        ctx.fillStyle = "rgba(15, 23, 42, 0.03)";
        ctx.fillRect(frameLeft, frameTop, drawWidth, drawLength);
      } else {
        ctx.fillStyle = "#e1e7f5";
        ctx.fillRect(frameLeft, frameTop, drawWidth, drawLength);
      }

      ctx.strokeStyle = "#4a5a7a";
      ctx.lineWidth = ui;
      ctx.strokeRect(frameLeft, frameTop, drawWidth, drawLength);

      ctx.strokeStyle = "rgba(74, 90, 122, 0.18)";
      ctx.beginPath();
      ctx.moveTo(frameLeft, -viewCenterY * scale);
      ctx.lineTo(frameLeft + drawWidth, -viewCenterY * scale);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-viewCenterX * scale, frameTop);
      ctx.lineTo(-viewCenterX * scale, frameTop + drawLength);
      ctx.stroke();

      parsed.shapes.forEach((shape) => {
        if (!shape.points.length) return;
        ctx.beginPath();
        const first = shape.points[0];
        ctx.moveTo((first.x - viewCenterX) * scale, (first.y - viewCenterY) * scale);
        for (let i = 1; i < shape.points.length; i += 1) {
          const point = shape.points[i];
          ctx.lineTo((point.x - viewCenterX) * scale, (point.y - viewCenterY) * scale);
        }
        ctx.closePath();
        ctx.fillStyle = shape.removed ? "rgba(100, 116, 139, 0.08)" : MASK_COLOR.fill;
        ctx.fill();
        ctx.strokeStyle = shape.removed ? "rgba(100, 116, 139, 0.9)" : MASK_COLOR.stroke;
        ctx.lineWidth = 0.9 * ui;
        ctx.setLineDash(shape.removed ? [4 * ui, 3 * ui] : []);
        ctx.stroke();
      });
      ctx.setLineDash([]);

      ctx.restore();
      ctx.fillStyle = "#4a5a7a";
      ctx.font = `${12 * ui}px sans-serif`;
      ctx.textBaseline = "bottom";
      ctx.textAlign = "left";
      ctx.fillText(
        `X: ${Utils.formatNumber(viewMinX, 1)} to ${Utils.formatNumber(viewMaxX, 1)}`,
        8 * ui,
        canvasHeight - 8 * ui
      );
      ctx.textBaseline = "top";
      ctx.textAlign = "right";
      ctx.fillText(
        `Y: ${Utils.formatNumber(viewMinY, 1)} to ${Utils.formatNumber(viewMaxY, 1)}`,
        size - 8 * ui,
        8 * ui
      );

      if (offscreen) return canvas;

      // click to enlarge, like the reference images
      canvas.style.cursor = "zoom-in";
      canvas.title = "Click to enlarge";
      canvas.addEventListener("click", () => openLargeFootprint(container, reel, masks, state));
      container.appendChild(canvas);
      if (!hasMaskShapes) {
        const badge = document.createElement("span");
        badge.className = "badge heatmap-status-badge";
        badge.textContent = "No masks";
        container.appendChild(badge);
      }
      if (referenceBackground && state.backgroundImageFailed) {
        const badge = document.createElement("span");
        badge.className = "badge heatmap-status-badge heatmap-status-badge--warning";
        badge.textContent = "Reference unavailable";
        container.appendChild(badge);
      }
    }

    // Redraws the footprint wide (sharp when zoomed) and opens it in the same viewer the reference images use.
    function openLargeFootprint(container, reel, masks, state) {
      try {
        const large = render(container, reel, masks, state, { offscreen: true, width: 1600 });
        if (large && typeof window.showImageModal === "function") {
          window.showImageModal(large.toDataURL("image/png"));
        }
      } catch (err) {
        console.error("Could not enlarge the mask footprint", err);
      }
    }

    // L = formatlength (mm). Returns the y-ranges of a rectangle once it is wrapped into the image frame [-L/2, L/2].
    function wrapMaskY(y0, y1, L) {
      const lo = Math.min(y0, y1), hi = Math.max(y0, y1);
      const h = hi - lo, half = L / 2;
      if (h >= L) return [[-half, half]];            // taller than one repeat: full-height strip
      const start = ((lo + half) % L + L) % L - half;  // shift the start into [-L/2, L/2)
      const end = start + h;
      if (end <= half) return [[start, end]];
      return [[start, half], [-half, end - L]];      // crosses the bottom edge: split in two
    }

    function isAxisAlignedRect(points) {
      if (!Array.isArray(points) || points.length !== 4) return false;
      const xs = new Set(points.map((p) => p.x));
      const ys = new Set(points.map((p) => p.y));
      return xs.size === 2 && ys.size === 2;
    }

    // BST stores some masks with y outside the image frame (a mask wraps around the repeat).
    // Rectangles are wrapped into the frame so they are drawn where they really sit.
    function wrapRectPoints(points, formatLength) {
      const xs = points.map((p) => p.x);
      const ys = points.map((p) => p.y);
      const x0 = Math.min(...xs);
      const x1 = Math.max(...xs);
      return wrapMaskY(Math.min(...ys), Math.max(...ys), formatLength).map(([y0, y1]) => [
        { x: x0, y: y0 },
        { x: x1, y: y0 },
        { x: x1, y: y1 },
        { x: x0, y: y1 },
      ]);
    }

    function collectMasks(masks, formatLength) {
      const canWrap = Number.isFinite(formatLength) && formatLength > 0;
      const shapes = [];
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      const removedMasks = new Set(
        masks
          .filter((mask) => mask && (mask.event === "removed" || mask.noinspection === false))
          .map((mask) =>
            JSON.stringify([
              mask.xml_id || "",
              mask.sensitivitysetid || "",
              mask.coords || "",
            ])
          )
      );

      masks.forEach((mask) => {
        const isRemoval = mask && (mask.event === "removed" || mask.noinspection === false);
        const removed = Boolean(isRemoval) || removedMasks.has(
          JSON.stringify([
            mask?.xml_id || "",
            mask?.sensitivitysetid || "",
            mask?.coords || "",
          ])
        );
        const polygons = parseMaskCoords(mask?.coords);
        if (!polygons.length) return;
        polygons.forEach((points) => {
          const normalized = points.filter((pt) => Number.isFinite(pt.x) && Number.isFinite(pt.y));
          if (normalized.length < 3) return;
          const pieces = canWrap && isAxisAlignedRect(normalized) ? wrapRectPoints(normalized, formatLength) : [normalized];
          pieces.forEach((piece) => {
            piece.forEach((pt) => {
              minX = Math.min(minX, pt.x);
              maxX = Math.max(maxX, pt.x);
              minY = Math.min(minY, pt.y);
              maxY = Math.max(maxY, pt.y);
            });
            shapes.push({ points: piece, removed });
          });
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
    let activeCount = 0;

    function ensure() {
      if (!overlay) {
        overlay = document.getElementById("globalLoading");
      }
      return overlay;
    }

    function show() {
      const el = ensure();
      if (!el) return;
      activeCount += 1;
      el.classList.remove("hidden");
    }

    function hide() {
      const el = ensure();
      if (!el) return;
      activeCount = Math.max(0, activeCount - 1);
      if (activeCount === 0) {
        el.classList.add("hidden");
      }
    }

    function reset() {
      const el = ensure();
      activeCount = 0;
      if (el) {
        el.classList.add("hidden");
      }
    }

    return { show, hide, reset };
  })();

  function buildReelMetadata(source = {}) {
    const code =
      source.reel_code ||
      source.reel ||
      source.code ||
      source.value ||
      "";
    const order = source.order_number || source.order || "";
    const time =
      source.time ||
      source.time_end ||
      source.time_start ||
      source.timestamp ||
      source.reel_time ||
      "";
    const label = formatReelLabel({ code, order, time });
    return { code, order, time, label };
  }

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
    const clean = path.replace(/^\/?static\//, "").replace(/^\/+/, "");
    const encoded = clean
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    return `${window.location.origin}/static/${encoded}`;
  }

  window.FETCH_DEBOUNCE_MS = FETCH_DEBOUNCE_MS;
  window.MM_TO_IN = MM_TO_IN;
  window.Utils = Utils;
  window.ORDER_NONE = ORDER_NONE;
  window.MODAL_SCALE_STEP = MODAL_SCALE_STEP;
  window.MODAL_MIN_SCALE = MODAL_MIN_SCALE;
  window.MODAL_MAX_SCALE = MODAL_MAX_SCALE;
  window.FOOTPRINT_SCALE_STEP = FOOTPRINT_SCALE_STEP;
  window.FOOTPRINT_MIN_SCALE = FOOTPRINT_MIN_SCALE;
  window.FOOTPRINT_MAX_SCALE = FOOTPRINT_MAX_SCALE;
  window.modalImageScale = modalImageScale;
  window.footprintModalScale = footprintModalScale;
  window.footprintModalState = footprintModalState;
  window.SEVERITY_DESCRIPTIONS = SEVERITY_DESCRIPTIONS;
  window.CONFIDENCE_DESCRIPTIONS = CONFIDENCE_DESCRIPTIONS;
  window.HEATMAP_BUCKETS = HEATMAP_BUCKETS;
  window.JobHeatmap = JobHeatmap;
  window.MaskHeatmap = MaskHeatmap;
  window.LoadingOverlay = LoadingOverlay;
  window.buildReelMetadata = buildReelMetadata;
  window.showToast = showToast;
  window.urlForStatic = urlForStatic;
  window.requestBackgroundImage = requestBackgroundImage;
  window.paddedRange = paddedRange;
  window.formatTime = formatTime;
  window.computeDefaultRange = computeDefaultRange;
  window.formatReelLabel = formatReelLabel;
  window.normalizeReelLabelTime = normalizeReelLabelTime;
  window.scrollToTopSoon = scrollToTopSoon;
  window.buildDecisionBadge = buildDecisionBadge;
  window.buildDecisionCellContent = buildDecisionCellContent;