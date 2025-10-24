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
        if (value !== undefined && value !== null && value !== "") {
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

  const Filters = (() => {
    const elements = {
      machine: Utils.qs("#filterMachine"),
      start: Utils.qs("#filterStart"),
      end: Utils.qs("#filterEnd"),
      job: Utils.qs("#filterJob"),
      order: Utils.qs("#filterOrder"),
      reel: Utils.qs("#filterReel"),
      apply: Utils.qs("#applyFilters"),
    };

    const listeners = new Set();
    let state = {
      machine_id: elements.machine ? elements.machine.value : "",
      start: elements.start ? elements.start.value : "",
      end: elements.end ? elements.end.value : "",
      job: "",
      order: "",
      reel_code: "",
    };
    let updating = false;
    let initialized = false;
    let refreshOptionsQueued = false;

    const scheduleEmit = Utils.debounce(() => emit(false), FETCH_DEBOUNCE_MS);
    const scheduleOptionsRefresh = Utils.debounce(() => refreshOptions(), 200);

    function init() {
      if (!elements.machine) return;
      applySearchParams();
      attachListeners();
      refreshOptions(true).then(() => {
        emit(true);
        initialized = true;
      });
    }

    function applySearchParams() {
      const params = new URLSearchParams(window.location.search);
      ["machine_id", "start", "end", "job", "order", "reel_code"].forEach((key) => {
        if (params.has(key)) {
          const value = params.get(key) || "";
          if (key === "reel_code") {
            state.reel_code = value;
          } else {
            state[key] = value;
          }
        }
      });
      updating = true;
      if (elements.machine) elements.machine.value = state.machine_id || elements.machine.value;
      if (elements.start && state.start) elements.start.value = state.start;
      if (elements.end && state.end) elements.end.value = state.end;
      if (elements.job) elements.job.value = state.job || "";
      if (elements.order) elements.order.value = state.order || "";
      if (elements.reel) elements.reel.value = state.reel_code || "";
      updating = false;
    }

    function attachListeners() {
      Object.entries(elements).forEach(([name, el]) => {
        if (!el || name === "apply") return;
        el.addEventListener("change", (evt) => handleInputChange(name, evt.target.value));
        if (name === "start" || name === "end") {
          el.addEventListener("blur", () => handleInputChange(name, el.value));
        }
      });
      if (elements.apply) {
        elements.apply.addEventListener("click", () => emit(true));
      }
    }

    function handleInputChange(field, value) {
      if (updating) return;
      switch (field) {
        case "machine":
          state.machine_id = value || "";
          state.job = "";
          state.order = "";
          state.reel_code = "";
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
          state.reel_code = "";
          scheduleOptionsRefresh();
          break;
        case "order":
          state.order = value || "";
          state.reel_code = "";
          scheduleOptionsRefresh();
          break;
        case "reel":
          state.reel_code = value || "";
          break;
        default:
          break;
      }
      scheduleEmit();
    }

    async function refreshOptions(initial = false) {
      if (refreshOptionsQueued && !initial) return;
      refreshOptionsQueued = true;
      try {
        const data = await Api.get("filters", {}, state);
        updating = true;
        updateSelect(elements.job, data.jobs || [], state.job);
        updateSelect(elements.order, data.orders || [], state.order);
        updateSelect(elements.reel, data.reel_codes || [], state.reel_code);
        updating = false;
      } catch (err) {
        console.error("Failed to refresh filter options", err);
      } finally {
        refreshOptionsQueued = false;
      }
    }

    function updateSelect(selectEl, values, currentValue) {
      if (!selectEl) return;
      const previousValue = selectEl.value;
      const frag = document.createDocumentFragment();
      const defaultOption = document.createElement("option");
      defaultOption.value = "";
      defaultOption.textContent = "All";
      frag.appendChild(defaultOption);
      values.forEach((value) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value;
        frag.appendChild(option);
      });
      selectEl.innerHTML = "";
      selectEl.appendChild(frag);
      const desiredValue = currentValue && values.includes(currentValue) ? currentValue : "";
      selectEl.value = desiredValue;
      if (desiredValue !== currentValue) {
        if (selectEl === elements.job) state.job = desiredValue;
        if (selectEl === elements.order) state.order = desiredValue;
        if (selectEl === elements.reel) state.reel_code = desiredValue;
      }
      if (selectEl.value !== previousValue) {
        selectEl.dispatchEvent(new Event("change", { bubbles: false }));
      }
    }

    function emit(force) {
      if (!initialized && !force) return;
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
        reel_code: state.reel_code,
      };
    }

    function onChange(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    }

    function set(field, value, { emit: shouldEmit = true, updateUrl = true } = {}) {
      state[field] = value || "";
      updating = true;
      if (field === "job" && elements.job) elements.job.value = state.job;
      if (field === "order" && elements.order) elements.order.value = state.order;
      if (field === "reel_code" && elements.reel) elements.reel.value = state.reel_code;
      updating = false;
      if (shouldEmit) emit(false);
      if (updateUrl && !shouldEmit) {
        Utils.updateUrlQuery(getState());
      }
    }

    return { init, getState, onChange, set };
  })();

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

      active = name;
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

    const load = Utils.debounce(async () => {
      try {
        const data = await Api.get("overview");
        renderKpis(data.kpis || {});
        renderCharts(data);
      } catch (err) {
        console.error("Overview load failed", err);
      }
    }, FETCH_DEBOUNCE_MS);

    function init() {
      kpiMap = {};
      Utils.qsa(".kpi-card[data-kpi]").forEach((card) => {
        const key = card.dataset.kpi;
        kpiMap[key] = card.querySelector("p");
      });
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

      Plotly.react(
        "overviewDefectsByType",
        [
          {
            type: "bar",
            x: defectsByType.map((d) => d.class),
            y: defectsByType.map((d) => d.count),
            marker: { color: "#2563eb" },
          },
        ],
        {
          title: "Defects by Type",
          margin: { t: 40, l: 40, r: 20, b: 60 },
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
            x: jobsTime.map((d) => d.job),
            y: jobsTime.map((d) => d.minutes_active),
            marker: { color: "#22c55e" },
          },
          {
            type: "bar",
            name: "Inactive",
            x: jobsTime.map((d) => d.job),
            y: jobsTime.map((d) => d.minutes_inactive),
            marker: { color: "#ef4444" },
          },
          {
            type: "bar",
            name: "Learn",
            x: jobsTime.map((d) => d.job),
            y: jobsTime.map((d) => d.minutes_learn),
            marker: { color: "#f59e0b" },
          },
        ],
        {
          barmode: "stack",
          title: "Minutes by Job and Phase",
          margin: { t: 40, l: 40, r: 20, b: 80 },
        },
        { responsive: true }
      );

      Plotly.react(
        "overviewJobsDefects",
        [
          {
            type: "bar",
            x: jobsDefects.map((d) => d.job),
            y: jobsDefects.map((d) => d.count),
            marker: { color: "#8b5cf6" },
          },
        ],
        {
          title: "Defects per Job",
          margin: { t: 40, l: 40, r: 20, b: 80 },
        },
        { responsive: true }
      );
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

    const load = Utils.debounce(async () => {
      try {
        const data = await Api.get("job-explorer", { page: state.page });
        state.cachedItems = applySort(data.items || []);
        state.pageInfo = data.page_info || null;
        renderList();
        renderPagination();
        ensureSelection();
      } catch (err) {
        console.error("Job explorer load failed", err);
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
      state.selectedReelId = null;
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
      if (!state.cachedItems.length) {
        const empty = document.createElement("div");
        empty.className = "placeholder";
        empty.textContent = "No reels found for this window.";
        listEl.appendChild(empty);
        if (detailEl) {
          detailEl.innerHTML = '<div class="placeholder">Select a reel to view details.</div>';
        }
        return;
      }

      state.cachedItems.forEach((item) => {
        const card = document.createElement("div");
        card.className = "reel-card";
        if (state.selectedReelId === item.reel_id) {
          card.classList.add("active");
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
            <span class="badge">Ref changes: ${item.ref_change_count || 0}</span>
            <span class="badge">RLM pts: ${item.rlm_monitor_count || 0}</span>
          </div>
          <div class="metrics-row">
            ${renderPhaseChips(item.phase_mix_pct || {})}
            ${item.sens_standard_changed ? '<span class="badge critical">Sensitivity drift</span>' : ""}
            ${!item.rlm_enabled ? '<span class="badge critical">RLM disabled</span>' : ""}
          </div>
        `;

        card.addEventListener("click", () => selectReel(item));
        listEl.appendChild(card);
      });
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
            `<img src="${urlForStatic(img.image_src)}" alt="${img.filename || ""}" onclick="showImageModal('${urlForStatic(
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
      const filterReel = Filters.getState().reel_code;
      if (filterReel) {
        const match = state.cachedItems.find((item) => item.reel_code === filterReel);
        if (match) {
          selectReel(match, { updateFilter: false, immediate: true });
          return;
        }
      }
      const initial = state.cachedItems[0];
      selectReel(initial, { updateFilter: false, immediate: true });
    }

    async function selectReel(item, { updateFilter = true, immediate = false } = {}) {
      state.selectedReelId = item.reel_id;
      if (updateFilter) {
        Filters.set("reel_code", item.reel_code || "", { emit: false, updateUrl: true });
      }
      renderList();
      await renderDetail(item.reel_id, immediate);
    }

    async function renderDetail(reelId, immediate) {
      if (!detailEl) return;
      detailEl.innerHTML = "<div class=\"placeholder\">Loading reel summary…</div>";
      try {
        const summary = await Api.get(`reel/${reelId}/summary`);
        detailEl.innerHTML = buildSummary(summary);
        attachGalleryListeners(detailEl);
      } catch (err) {
        console.error("Failed to load reel summary", err);
        detailEl.innerHTML = `<div class="placeholder">Failed to load reel summary: ${err.message}</div>`;
      }
    }

    function buildSummary(data) {
      const reel = data.reel || {};
      const refImages = data.reference_images || [];
      const sensitivities = data.sensitivities || [];
      const masks = data.masks || [];
      const phases = data.inspection_phases || [];
      const rlm = data.rlm || {};
      const defectsSummary = data.defects_summary || { total: 0, types: 0 };
      const reelMeters =
        typeof reel.reel_start === "number" && typeof reel.reel_end === "number"
          ? reel.reel_end - reel.reel_start
          : null;

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
                        )}">`
                    )
                    .join("")
                : "<span class='badge'>No reference images</span>"
            }
          </div>
        </div>

        <div class="summary-section">
          <h4>Sensitivity (Standard)</h4>
          ${
            sensitivities.length
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
              : "<span class='badge'>No standard sensitivities</span>"
          }
        </div>

        <div class="summary-section">
          <h4>Masks</h4>
          ${
            masks.length
              ? `<table class="data-table">
                  <thead><tr><th>Timestamp</th><th>Coords</th><th>Format</th></tr></thead>
                  <tbody>
                    ${masks
                      .map(
                        (mask) =>
                          `<tr><td>${formatTime(mask.timestamp)}</td><td>${(mask.coords || "").slice(
                            0,
                            40
                          )}${mask.coords && mask.coords.length > 40 ? "…" : ""}</td><td>${Utils.formatNumber(
                            mask.format_value,
                            2
                          )}</td></tr>`
                      )
                      .join("")}
                  </tbody>
                </table>`
              : "<span class='badge'>No masks</span>"
          }
        </div>

        <div class="summary-section">
          <h4>Inspection Phases</h4>
          ${renderTimeline(phases)}
        </div>

        <div class="summary-section">
          <h4>RLM</h4>
          <div class="summary-metadata">
            <span>Monitor points: ${rlm.monitor_count || 0}</span>
            <span>Config: ${rlm.config ? "Loaded" : "Not available"}</span>
          </div>
          ${
            rlm.phases && rlm.phases.length
              ? renderTimeline(rlm.phases, "RLM timeline")
              : "<span class='badge'>No RLM phases</span>"
          }
        </div>

        <div class="summary-section">
          <h4>Defects Summary</h4>
          <div class="summary-metadata">
            <span>Total defects: ${defectsSummary.total || 0}</span>
            <span>Types: ${defectsSummary.types || 0}</span>
          </div>
        </div>
      `;
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

    const state = {
      page: 1,
      class_name: "",
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
      try {
        const params = {
          page: state.page,
        };
        if (state.class_name) params.class_name = state.class_name;
        if (state.phase) params.phase = state.phase;
        if (state.magnitude_min) params.magnitude_min = state.magnitude_min;
        if (state.magnitude_max) params.magnitude_max = state.magnitude_max;
        if (state.severity_min) params.severity_min = state.severity_min;
        if (state.severity_max) params.severity_max = state.severity_max;
        if (state.position_min) params.position_min = state.position_min;
        if (state.position_max) params.position_max = state.position_max;

        const data = await Api.get("defects", params);
        state.pageInfo = data.page_info || null;
        updateTypeOptions(data.by_type || []);
        renderCharts(data);
        renderTable(data.rows || []);
        renderPagination();
      } catch (err) {
        console.error("Defect explorer load failed", err);
        if (tableBody) {
          tableBody.innerHTML = `<tr><td colspan="11">Failed to load defects: ${err.message}</td></tr>`;
        }
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

      [
        [typeSelect, "class_name"],
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
    }

    function activate() {
      load.flush();
    }

    function onFiltersUpdated() {
      state.page = 1;
      load();
    }

    function handleLocalFilterChange(key, value) {
      state[key] = value || "";
      state.page = 1;
      load();
    }

    function updateTypeOptions(byType) {
      if (!typeSelect) return;
      const current = state.class_name;
      const options = ["<option value=''>All</option>"].concat(
        byType.map((type) => `<option value="${type.class}">${type.class}</option>`)
      );
      typeSelect.innerHTML = options.join("");
      if (current && byType.some((t) => t.class === current)) {
        typeSelect.value = current;
      } else {
        typeSelect.value = "";
        state.class_name = "";
      }
    }

    function renderCharts(data) {
      const byType = data.by_type || [];
      const trend = data.trend || [];
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
        "defectTrendChart",
        [
          {
            type: "scatter",
            mode: "lines+markers",
            x: trend.map((item) => item.time),
            y: trend.map((item) => item.count),
            line: { color: "#2563eb" },
          },
        ],
        { title: "Defects Over Time", xaxis: { type: "date" }, margin: { t: 40, l: 40, r: 20, b: 60 } },
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
                    ? `<img src="${urlForStatic(row.image_src)}" alt="defect" onclick="showImageModal('${urlForStatic(
                        row.image_src
                      )}')">`
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

    function formatTime(value) {
      if (!value) return "";
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
    }

    return { init, activate, onFiltersUpdated };
  })();

  function urlForStatic(path) {
    if (!path) return "";
    return `${window.location.origin}/dashboard/static/${path.replace(/^\/?static\//, "")}`;
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

  window.showImageModal = function showImageModal(src) {
    const modal = document.getElementById("imageModal");
    const img = document.getElementById("modalImage");
    if (!modal || !img) return;
    img.src = src;
    modal.style.display = "block";
  };

  window.closeModal = function closeModal() {
    const modal = document.getElementById("imageModal");
    const img = document.getElementById("modalImage");
    if (modal) modal.style.display = "none";
    if (img) img.src = "";
  };
})();
