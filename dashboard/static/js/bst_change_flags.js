(function () {
  const galleries = new Map();
  const maskViews = new Map();
  const historyViews = new Map();

  const refs = {
    grid: document.getElementById("changeFlagsGrid"),
    refresh: document.getElementById("changeFlagsRefresh"),
    refModal: document.getElementById("changeRefModal"),
    refModalTitle: document.getElementById("changeRefModalTitle"),
    refModalSubtitle: document.getElementById("changeRefModalSubtitle"),
    refModalBody: document.getElementById("changeRefModalBody"),
    refModalClose: document.getElementById("changeRefModalClose"),
  };

  async function loadFlags() {
    try {
      const res = await fetch("/bst/change-flags/api");
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data = await res.json();
      render(data);
    } catch (err) {
      if (refs.grid) {
        refs.grid.innerHTML = `<div class="change-flags-empty">Unable to load BST change flags.</div>`;
      }
      if (refs.refresh) refs.refresh.textContent = "Refresh failed";
    }
  }

  function render(data) {
    const rows = data.rows || [];
    if (refs.refresh) refs.refresh.textContent = `Last refresh ${formatTime(data.generatedAt)}`;
    if (!refs.grid) return;
    if (!rows.length) {
      refs.grid.innerHTML = `<div class="change-flags-empty">No press data available.</div>`;
      return;
    }
    galleries.clear();
    maskViews.clear();
    historyViews.clear();
    refs.grid.innerHTML = rows.map(renderPressCard).join("");
  }

  function renderPressCard(row) {
    const reel = row.displayReel || {};
    const headerState = cardState(row);
    return `
      <article class="change-press-card">
        <header class="change-press-card__header change-press-card__header--${escapeAttr(headerState)}">
          <div class="change-press-card__heading">
            <h2>${escapeHtml(row.machineName || "Press")}</h2>
            <p class="change-press-card__reel">${escapeHtml(reel.reelCode || "--")}</p>
          </div>
          <span class="change-press-card__time">${escapeHtml(formatTime(reel.endedAt))}</span>
        </header>
        <div class="change-press-card__meta">
          <span>Job ${escapeHtml(reel.jobNumber || "--")}</span>
          <span>${escapeHtml(reel.feet || "--")}</span>
        </div>
        <div class="change-flag-pair">
          ${renderFlag("RLM Tolerance", row.rlmTolerance)}
          ${renderFlag("BST Tolerance", row.bstSetup)}
        </div>
        ${renderCardReelHistory(row.reelHistory || [])}
      </article>
    `;
  }

  function cardState(row) {
    const flags = [row && row.rlmTolerance, row && row.bstSetup].filter(Boolean);
    if (flags.some((flag) => flag.state === "changed")) return "changed";
    if (flags.length && flags.every((flag) => flag.state === "unchanged")) return "unchanged";
    if (isNoPriorRlmReel(row)) return "unchanged";
    return "missing";
  }

  function isNoPriorRlmReel(row) {
    const flag = row && row.rlmTolerance;
    return Boolean(flag && flag.state === "missing" && /No prior RLM reel/i.test(flag.label || ""));
  }

  function renderFlag(title, flag) {
    const item = flag || { state: "missing", label: "No comparison", details: [] };
    const state = item.state || "missing";
    const details = item.details || [];
    const statusLabel = state === "unchanged" ? "Good" : item.label || "--";
    const reelText = state === "changed" ? reelLine(item) : "";
    const detailsClass = details.length > 2 ? "change-flag__details change-flag__details--scroll" : "change-flag__details";
    return `
      <div class="change-flag change-flag--${escapeAttr(state)}" tabindex="0">
        <span class="change-flag__title">${escapeHtml(title)}</span>
        <strong class="change-flag__status${state === "unchanged" ? " change-flag__status--good" : ""}">${escapeHtml(statusLabel)}</strong>
        ${reelText ? `<small>${escapeHtml(reelText)}</small>` : ""}
        ${details.length ? `<div class="${escapeAttr(detailsClass)}"><ul>${details.map((detail) => renderDetail(detail, title, item)).join("")}</ul></div>` : ""}
      </div>
    `;
  }

  function renderDetail(detail, title, flag) {
    const action = renderDetailAction(detail, title, flag);
    return `
      <li>
        <span>${escapeHtml(detail.label || "Change")}</span>
        <small>${escapeHtml(detail.summary || "")}</small>
        ${action}
      </li>
    `;
  }

  function renderCardReelHistory(history) {
    if (!history.length) return "";
    return `
      <div class="change-card-reel-history">
        ${renderReelHistoryGroup("BST", "bstState", history)}
        ${renderReelHistoryGroup("RLM", "rlmState", history)}
      </div>
    `;
  }

  function renderReelHistoryGroup(label, stateKey, history) {
    const groupClass = `change-card-reel-group--${label.toLowerCase()}`;
    return `
      <div class="change-card-reel-group ${escapeAttr(groupClass)}">
        <span class="change-card-reel-label">${escapeHtml(label)}</span>
        <div class="change-card-reel-strip">
          ${history.map((row) => renderReelHistoryChip(row, label, stateKey)).join("")}
        </div>
      </div>
    `;
  }

  function renderReelHistoryChip(row, label, stateKey) {
    const stateClass = row[stateKey] || row.state || "neutral";
    const summary = label === "BST" ? row.bstSummary : row.rlmSummary;
    const details = Array.isArray(label === "BST" ? row.bstDetails : row.rlmDetails) ? (label === "BST" ? row.bstDetails : row.rlmDetails) : [];
    const hasHistoryView = stateClass === "alert" && details.some((detail) => detail && (hasDetailImages(detail) || Boolean(detail.maskComparison)));
    const historyId = hasHistoryView ? `history-${historyViews.size + 1}` : "";
    if (hasHistoryView) {
      historyViews.set(historyId, {
        title: label,
        reelNumber: row.reelNumber || "--",
        summary: summary || "",
        details,
      });
    }
    const tag = hasHistoryView ? "button" : "span";
    const attrs = hasHistoryView ? ` type="button" data-history-view="${escapeAttr(historyId)}"` : "";
    return `
      <${tag} class="change-card-reel-chip ${escapeAttr(stateClass)}${hasHistoryView ? " change-card-reel-chip--interactive" : ""}"${attrs}>
        ${escapeHtml(row.reelNumber || "--")}
        <span class="change-card-reel-tooltip" role="tooltip">
          <strong>${escapeHtml(label)} - Reel ${escapeHtml(row.reelNumber || "--")}</strong>
          <small>${escapeHtml(formatTime(row.timeEnd))}</small>
          <small>Job - ${escapeHtml(row.jobNumber || "--")}</small>
          <small>Feet - ${escapeHtml(row.feet || "--")}</small>
          <small>${escapeHtml(summary || "No tolerance changes")}</small>
        </span>
      </${tag}>
    `;
  }

  function hasDetailImages(detail) {
    return Array.isArray(detail && detail.images) && detail.images.some((image) => image && image.imageSrc);
  }

  function reelRange(flag) {
    const current = flag.currentReel || "--";
    const previous = flag.previousReel || "--";
    return `${previous} to ${current}`;
  }

  function reelLine(flag) {
    const current = flag.currentReel || "--";
    if (flag.state === "changed") return flag.previousReel ? reelRange(flag) : `Reel ${current}`;
    return `Reel ${current}`;
  }

  function formatTime(value) {
    if (!value) return "--";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "--";
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, "&#96;");
  }

  function urlForStatic(path) {
    const cleaned = String(path || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!cleaned) return "";
    if (/^https?:\/\//i.test(cleaned) || cleaned.startsWith("/static/")) return cleaned;
    return `/static/${cleaned}`;
  }

  function openReferenceGallery(galleryId) {
    const gallery = galleries.get(galleryId);
    if (!gallery || !refs.refModal || !refs.refModalBody) return;
    const current = gallery.flag.currentReel || "--";
    if (refs.refModalTitle) refs.refModalTitle.textContent = `${gallery.title} · ${current}`;
    if (refs.refModalSubtitle) refs.refModalSubtitle.textContent = gallery.detail.summary || "";
    refs.refModalBody.innerHTML = gallery.images
      .map(
        (image, index) => `
          <figure class="change-ref-image">
            <img src="${escapeAttr(urlForStatic(image.imageSrc))}" alt="${escapeAttr(image.filename || image.label || `Reference ${index + 1}`)}" loading="lazy" decoding="async">
            <figcaption>
              <strong>${escapeHtml(image.label || `Reference ${index + 1}`)}</strong>
              <span>${escapeHtml(image.filename || "")}</span>
              ${image.format ? `<small>Format ${escapeHtml(image.format)}</small>` : ""}
            </figcaption>
          </figure>
        `
      )
      .join("");
    refs.refModal.showModal();
  }

  function openMaskView(maskId) {
    const view = maskViews.get(maskId);
    if (!view || !refs.refModal || !refs.refModalBody) return;
    const current = view.flag.currentReel || "--";
    if (refs.refModalTitle) refs.refModalTitle.textContent = `${view.title} · ${current}`;
    if (refs.refModalSubtitle) refs.refModalSubtitle.textContent = view.detail.summary || "";
    const sequence = Array.isArray(view.maskComparison.sequence) ? view.maskComparison.sequence : [];
    if (sequence.length) {
      refs.refModalBody.innerHTML = `
        <div class="change-mask-sequence">
          ${sequence.map((step) => renderMaskPanel(step.label || "Step", step)).join("")}
        </div>
      `;
    } else {
      refs.refModalBody.innerHTML = `
        <div class="change-mask-compare">
          ${renderMaskPanel("Before", view.maskComparison.before)}
          ${renderMaskPanel("After", view.maskComparison.after)}
        </div>
      `;
    }
    refs.refModal.showModal();
  }

  function openHistoryView(historyId) {
    const history = historyViews.get(historyId);
    if (!history || !refs.refModal || !refs.refModalBody) return;
    const actionable = (history.details || []).filter((detail) => detail && (hasDetailImages(detail) || Boolean(detail.maskComparison)));
    if (!actionable.length) return;
    if (refs.refModalTitle) refs.refModalTitle.textContent = `${history.title} · Reel ${history.reelNumber || "--"}`;
    if (refs.refModalSubtitle) refs.refModalSubtitle.textContent = history.summary || "";
    refs.refModalBody.innerHTML = `
      <div class="change-history-view">
        ${actionable.map((detail, index) => renderHistoryDetail(detail, history.title, history.reelNumber, index)).join("")}
      </div>
    `;
    refs.refModal.showModal();
  }

  function renderHistoryDetail(detail, title, reelNumber, index) {
    const images = Array.isArray(detail.images) ? detail.images.filter((image) => image && image.imageSrc) : [];
    const maskComparison = detail.maskComparison || null;
    const action = renderDetailAction(detail, `${title} · Reel ${reelNumber}`, { currentReel: reelNumber }, `history-${index}`);
    return `
      <section class="change-history-view__item">
        <div class="change-history-view__meta">
          <span>${escapeHtml(detail.label || "Change")}</span>
          <small>${escapeHtml(detail.summary || "")}</small>
        </div>
        ${action}
        ${!images.length && !maskComparison ? `<small>No viewable content</small>` : ""}
      </section>
    `;
  }

  function renderDetailAction(detail, title, flag, keyPrefix = "") {
    const images = Array.isArray(detail.images) ? detail.images.filter((image) => image && image.imageSrc) : [];
    const maskComparison = detail.maskComparison || null;
    let action = "";
    if (images.length) {
      const galleryId = `${keyPrefix || "gallery"}-${galleries.size + 1}`;
      galleries.set(galleryId, { title, flag, detail, images });
      action = `<button type="button" class="change-ref-link" data-ref-gallery="${escapeAttr(galleryId)}">View images</button>`;
    } else if (maskComparison) {
      const maskId = `${keyPrefix || "mask"}-${maskViews.size + 1}`;
      maskViews.set(maskId, { title, flag, detail, maskComparison });
      action = `<button type="button" class="change-ref-link" data-mask-view="${escapeAttr(maskId)}">View mask</button>`;
    }
    return action;
  }

  function renderMaskPanel(title, payload) {
    const image = payload && payload.image;
    const masks = payload && Array.isArray(payload.masks) ? payload.masks : [];
    return `
      <figure class="change-mask-panel">
        <div class="change-mask-stage">
          ${image && image.imageSrc ? `<img src="${escapeAttr(urlForStatic(image.imageSrc))}" alt="${escapeAttr(image.filename || title)}" loading="lazy" decoding="async">` : `<div class="change-mask-stage__blank">No reference image</div>`}
          ${renderMaskSvg(masks)}
        </div>
        <figcaption>
          <strong>${escapeHtml(title)} · ${escapeHtml((payload && payload.reel) || "--")}</strong>
          <span>${escapeHtml(image && image.filename || "")}</span>
          ${image && image.format ? `<small>Reference format ${escapeHtml(image.format)}</small>` : ""}
        </figcaption>
        ${masks.length ? `
          <div class="change-mask-coords">
            ${masks.map((mask) => `
              <div class="change-mask-coords__item">
                <span>${escapeHtml(mask.label || "Mask")}</span>
                <small>${escapeHtml(mask.coords || "--")}</small>
              </div>
            `).join("")}
          </div>
        ` : ""}
      </figure>
    `;
  }

  function renderMaskSvg(masks) {
    const rects = masks.map((mask) => ({ mask, rect: parseMaskRect(mask.coords) })).filter((item) => item.rect);
    if (!rects.length) return "";
    const bounds = maskBounds(rects.map((item) => item.rect));
    return `
      <svg class="change-mask-overlay" viewBox="${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}" preserveAspectRatio="none" aria-hidden="true">
        ${rects.map(({ mask, rect }) => `
          <rect
            x="${rect.x}"
            y="${rect.y}"
            width="${rect.width}"
            height="${rect.height}"
            rx="0"
            vector-effect="non-scaling-stroke"
          />
          <title>${escapeHtml(mask.label || "Mask")}</title>
        `).join("")}
      </svg>
    `;
  }

  function parseMaskRect(coords) {
    const values = String(coords || "")
      .split(/[,\s]+/)
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));
    if (values.length < 4) return null;
    const x1 = values[0];
    const y1 = values[1];
    const x2 = values[2];
    const y2 = values[3];
    return {
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      width: Math.max(Math.abs(x2 - x1), 1),
      height: Math.max(Math.abs(y2 - y1), 1),
    };
  }

  function maskBounds(rects) {
    const minX = Math.min(...rects.map((rect) => rect.x));
    const minY = Math.min(...rects.map((rect) => rect.y));
    const maxX = Math.max(...rects.map((rect) => rect.x + rect.width));
    const maxY = Math.max(...rects.map((rect) => rect.y + rect.height));
    const padX = Math.max((maxX - minX) * 0.08, 25);
    const padY = Math.max((maxY - minY) * 0.08, 25);
    return {
      x: minX - padX,
      y: minY - padY,
      width: Math.max(maxX - minX + padX * 2, 1),
      height: Math.max(maxY - minY + padY * 2, 1),
    };
  }

  document.addEventListener("click", (event) => {
    const historyButton = event.target.closest("[data-history-view]");
    if (historyButton) {
      event.preventDefault();
      event.stopPropagation();
      openHistoryView(historyButton.getAttribute("data-history-view"));
      return;
    }
    const galleryButton = event.target.closest("[data-ref-gallery]");
    if (galleryButton) {
      event.preventDefault();
      event.stopPropagation();
      openReferenceGallery(galleryButton.getAttribute("data-ref-gallery"));
      return;
    }
    const maskButton = event.target.closest("[data-mask-view]");
    if (maskButton) {
      event.preventDefault();
      event.stopPropagation();
      openMaskView(maskButton.getAttribute("data-mask-view"));
      return;
    }
    if (event.target === refs.refModal) {
      refs.refModal.close();
    }
  });

  refs.refModalClose?.addEventListener("click", () => refs.refModal?.close());

  loadFlags();
})();
