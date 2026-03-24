(function () {
  let modalsBound = false;
  let zoomBound = false;
  let footprintButtonsBound = false;
  let keydownBound = false;

  function bindAll() {
    if (!modalsBound) {
      bindModalControls();
      modalsBound = true;
    }
    if (!zoomBound) {
      bindModalZoom();
      bindFootprintModalZoom();
      zoomBound = true;
    }
    if (!footprintButtonsBound) {
      bindFootprintExpandButtons();
      footprintButtonsBound = true;
    }
    if (!keydownBound) {
      document.addEventListener("keydown", handleModalShortcuts);
      keydownBound = true;
    }
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

  function handleModalShortcuts(event) {
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
  }

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

  function showImageModal(src, element) {
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
  }

  function closeModal() {
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
  }

  window.DefectModals = { bindAll, syncModalMetaBarVisibility };
  window.syncModalMetaBarVisibility = syncModalMetaBarVisibility;
  window.showImageModal = showImageModal;
  window.closeModal = closeModal;
  window.closeFootprintModal = closeFootprintModal;
  window.saveDefectLabel = saveDefectLabel;
})();
