(function () {
  const REFRESH_MS = 5 * 60 * 1000;

  const galleries = new Map();
  const maskViews = new Map();
  const historyViews = new Map();
  const state = {
    refreshTimer: null,
    refreshRequestSeq: 0,
    refreshAbortController: null,
  };

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
    const requestSeq = state.refreshRequestSeq + 1;
    state.refreshRequestSeq = requestSeq;
    if (state.refreshAbortController) {
      state.refreshAbortController.abort();
    }
    const controller = new AbortController();
    state.refreshAbortController = controller;
    try {
      const res = await fetch("/bst/change-flags/api", { signal: controller.signal });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data = await res.json();
      if (requestSeq !== state.refreshRequestSeq) return;
      render(data);
    } catch (err) {
      if (err?.name === "AbortError") return;
      if (refs.grid) {
        refs.grid.innerHTML = `<div class="change-flags-empty">Unable to load BST change flags.</div>`;
      }
      if (refs.refresh) refs.refresh.textContent = "Refresh failed";
    } finally {
      if (state.refreshAbortController === controller) {
        state.refreshAbortController = null;
      }
      scheduleRefresh();
    }
  }

  function scheduleRefresh() {
    if (state.refreshTimer) clearTimeout(state.refreshTimer);
    state.refreshTimer = window.setTimeout(() => {
      loadFlags().catch((err) => console.error("Failed to refresh BST change flags", err));
    }, REFRESH_MS);
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
        ${renderReelExplorerLink(reel.reelContext, "Open in Reel Explorer", "change-press-card__reel-link")}
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
        reelContext: row.reelContext || null,
      });
    }
    const href = !hasHistoryView ? reelExplorerHref(row.reelContext) : "";
    const tag = hasHistoryView ? "button" : (href ? "a" : "span");
    const attrs = hasHistoryView
      ? ` type="button" data-history-view="${escapeAttr(historyId)}"`
      : (href ? ` href="${escapeAttr(href)}" aria-label="Open reel ${escapeAttr(row.reelNumber || "--")} in Reel Explorer"` : ` tabindex="0"`);
    return `
      <${tag} class="change-card-reel-chip ${escapeAttr(stateClass)}${hasHistoryView ? " change-card-reel-chip--interactive" : ""}"${attrs}>
        ${escapeHtml(row.reelNumber || "--")}
        <span class="change-card-reel-tooltip" role="tooltip">
          <strong>${escapeHtml(label)} - Reel ${escapeHtml(row.reelNumber || "--")}</strong>
          <small>${escapeHtml(formatTime(row.timeEnd))}</small>
          <small>Job - ${escapeHtml(row.jobNumber || "--")}</small>
          <small>Feet - ${escapeHtml(row.feet || "--")}</small>
          <small>${escapeHtml(summary || "No tolerance changes")}</small>
          ${href ? `<small class="change-card-reel-tooltip__action">Click to open in Reel Explorer</small>` : ""}
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
      .join("") + renderDialogReelExplorerLink(gallery.flag.reelContext);
    refs.refModal.showModal();
  }

  function openMaskView(maskId) {
    const view = maskViews.get(maskId);
    if (!view || !refs.refModal || !refs.refModalBody) return;
    const current = view.flag.currentReel || "--";
    if (refs.refModalTitle) refs.refModalTitle.textContent = `${view.title} · ${current}`;
    if (refs.refModalSubtitle) refs.refModalSubtitle.textContent = "Current mask state on the latest reel";
    refs.refModalBody.innerHTML = `
      <div class="change-mask-compare">
        ${renderMaskPanel("Current", view.maskComparison.after)}
      </div>
      ${renderDialogReelExplorerLink(view.flag.reelContext)}
    `;
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
        ${actionable.map((detail, index) => renderHistoryDetail(
          detail,
          history.title,
          history.reelNumber,
          index,
          history.reelContext
        )).join("")}
      </div>
      ${renderDialogReelExplorerLink(history.reelContext)}
    `;
    refs.refModal.showModal();
  }

  function renderHistoryDetail(detail, title, reelNumber, index, reelContext) {
    const images = Array.isArray(detail.images) ? detail.images.filter((image) => image && image.imageSrc) : [];
    const maskComparison = detail.maskComparison || null;
    const action = renderDetailAction(
      detail,
      `${title} · Reel ${reelNumber}`,
      { currentReel: reelNumber, reelContext },
      `history-${index}`,
      false
    );
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

  function renderDetailAction(detail, title, flag, keyPrefix = "", includeExplorerLink = true) {
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
    const explorerLink = includeExplorerLink
      ? renderReelExplorerLink(flag && flag.reelContext, "Open in Reel Explorer")
      : "";
    return `${action}${explorerLink}`;
  }

  function renderReelExplorerLink(context, label, className = "") {
    const href = reelExplorerHref(context);
    if (!href) return "";
    const extraClass = className ? ` ${escapeAttr(className)}` : "";
    return `<a class="change-open-reel-link${extraClass}" href="${escapeAttr(href)}">${escapeHtml(label)}</a>`;
  }

  function reelExplorerHref(context) {
    if (!context?.reelId || !context?.machineId) return "";
    const params = new URLSearchParams({
      open_reel_explorer: "1",
      machine_id: String(context.machineId),
      reel_id: String(context.reelId),
    });
    if (context.orderNumber) params.set("order", context.orderNumber);
    if (context.jobName) params.set("job", context.jobName);
    const startDate = String(context.timeStart || context.timeEnd || "").split("T")[0];
    const endDate = String(context.timeEnd || context.timeStart || "").split("T")[0];
    if (startDate) params.set("start", startDate);
    if (endDate) params.set("end", endDate);
    return `/dashboard/?${params.toString()}#job-explorer`;
  }

  function renderDialogReelExplorerLink(context) {
    const href = reelExplorerHref(context);
    if (!href) return "";
    return `
      <div class="change-ref-modal__reel-action">
        <a class="change-open-reel-link" href="${escapeAttr(href)}">Click to open in Reel Explorer</a>
      </div>
    `;
  }

  function renderMaskPanel(title, payload) {
    const image = payload && payload.image;
    const masks = payload && Array.isArray(payload.masks) ? payload.masks : [];
    const formatWidth = Number(payload && payload.format_width);
    const formatLength = Number(payload && payload.format_length);
    const stageStyle = Number.isFinite(formatWidth) && Number.isFinite(formatLength) && formatWidth > 0 && formatLength > 0
      ? ` style="aspect-ratio:${formatWidth} / ${formatLength}"`
      : "";
    return `
      <figure class="change-mask-panel">
        <div class="change-mask-stage"${stageStyle}>
          ${image && image.imageSrc ? `<img src="${escapeAttr(urlForStatic(image.imageSrc))}" alt="${escapeAttr(image.filename || title)}" loading="lazy" decoding="async">` : `<div class="change-mask-stage__blank">No reference image</div>`}
          ${renderMaskSvg(masks, formatWidth, formatLength)}
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

  function renderMaskSvg(masks, formatWidth, formatLength) {
    const rects = masks.map((mask) => ({ mask, rect: parseMaskRect(mask.coords) })).filter((item) => item.rect);
    if (!rects.length) return "";
    const hasFormatBounds = Number.isFinite(formatWidth) && Number.isFinite(formatLength)
      && formatWidth > 0 && formatLength > 0;
    const bounds = hasFormatBounds
      ? { x: -formatWidth / 2, y: -formatLength / 2, width: formatWidth, height: formatLength }
      : maskBounds(rects.map((item) => item.rect));
    // With the repeat length known, wrap each mask into the image frame (a mask crossing the
    // edge is split in two, one outside the frame lands where it belongs).
    const drawRects = hasFormatBounds
      ? rects.flatMap(({ mask, rect }) =>
          wrapMaskY(rect.y, rect.y + rect.height, formatLength).map(([y0, y1]) => ({
            mask,
            rect: { x: rect.x, y: y0, width: rect.width, height: Math.max(y1 - y0, 1) },
          }))
        )
      : rects;
    return `
      <svg class="change-mask-overlay" viewBox="${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}" preserveAspectRatio="none" aria-hidden="true">
        ${drawRects.map(({ mask, rect }) => `
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

  // L = formatlength (mm). Returns rectangles clipped to the image frame [-L/2, L/2].
  function wrapMaskY(y0, y1, L) {
    const lo = Math.min(y0, y1), hi = Math.max(y0, y1);
    const h = hi - lo, half = L / 2;
    if (h >= L) return [[-half, half]];            // full-height strip
    let start = ((lo + half) % L + L) % L - half;  // shift start into [-L/2, L/2)
    const end = start + h;
    if (end <= half) return [[start, end]];
    return [[start, half], [-half, end - L]];      // crosses the bottom edge: split
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
