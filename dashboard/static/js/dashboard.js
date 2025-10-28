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
      if (elements.order) elements.order.value = state.order || "";
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
      scheduleEmit();
    }

    async function refreshOptions(initial = false) {
      if (refreshOptionsQueued && !initial) return;
      refreshOptionsQueued = true;
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
        option.textContent = value;
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
        chips.push({ key: "order", label: `Order: ${state.order}`, removable: true });
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

    return { init, getState, onChange, set, addReel, removeReel, getReelCodes };
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
      const jobEvents = data.job_events || [];
      const jobsDefectsTrend = data.jobs_defects_timeline || [];
      const jobMetrics = data.job_metrics || [];

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
        detailEl.innerHTML = buildSummary(cached);
        attachGalleryListeners(detailEl);
        attachSummaryActions(detailEl);
        if (immediate) {
          return;
        }
      } else {
        detailEl.innerHTML = "<div class=\"placeholder\">Loading reel summary…</div>";
      }

      try {
        const summary = await Api.get(`reel/${reelId}/summary`);
        summaryCache.set(reelId, summary);
        if (state.selectedReelId !== reelId) return;
        detailEl.innerHTML = buildSummary(summary);
        attachGalleryListeners(detailEl);
        attachSummaryActions(detailEl);
      } catch (err) {
        console.error("Failed to load reel summary", err);
        if (!cached) {
          detailEl.innerHTML = `<div class="placeholder">Failed to load reel summary: ${err.message}</div>`;
        }
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
                        )}">`
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

        <div class="summary-section">
          <h4>Sensitivity (Standard)</h4>
          ${sensitivityTable}
        </div>

        <div class="summary-section">
          <h4>Masks</h4>
          ${masksTable}
        </div>

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
        const byType = data.by_type || [];
        updateTypeOptions(byType);
        renderSummary(data.page_info, byType);
        renderCharts(data, byType);
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
      summaryTotalEl = Utils.qs("[data-defect-total]");
      summaryTypesEl = Utils.qs("#defectSummaryTypes");

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
    const clean = path.replace(/^\/?static\//, "").replace(/^\/+/, "");
    const encoded = clean
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    return `${window.location.origin}/dashboard/static/${encoded}`;
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
