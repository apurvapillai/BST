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

    function bucketForWeight(weight) {
      const value = Number(weight) || 0;
      if (value >= 90) return "critical";
      if (value >= 70) return "high";
      if (value >= 50) return "elevated";
      if (value >= 25) return "moderate";
      return "low";
    }

    return { init, activate, deactivate, onFiltersUpdated };
  })();
