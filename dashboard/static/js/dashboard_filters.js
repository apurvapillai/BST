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
      clearButton: Utils.qs("#filtersClearButton"),
    };

    const reelOptionCache = new Map(); // reel_id -> { value, code, label }
    const reelIdsByCode = new Map(); // reel_code -> [reel_id]
    const pendingReelHydrations = new Set();
    const forcedDisabled = new Map();
    let pendingReelCodes = [];
    const STATUS_STYLES = {
      pass: { bg: "rgba(34, 197, 94, 0.35)", color: "#065f46" },
      fail: { bg: "rgba(248, 113, 113, 0.4)", color: "#7f1d1d" },
      pending: { bg: "", color: "" },
      no_defects: { bg: "rgba(191, 219, 254, 0.7)", color: "#1d4ed8" },
      complete: { bg: "rgba(191, 219, 254, 0.6)", color: "#1e3a8a" },
    };

    function rememberReelOption(entry = {}) {
      if (entry.value === undefined || entry.value === null) return false;
      const id = String(entry.value);
      const code = entry.code || entry.reel_code || "";
      const order = entry.order || entry.order_number || "";
      const timestamp =
        entry.time ||
        entry.time_end ||
        entry.time_start ||
        entry.timestamp ||
        entry.reel_time ||
        "";
      const label =
        entry.label ||
        formatReelLabel({
          code,
          order,
          time: timestamp,
        }) ||
        (code || `Reel ${id}`);
      const normalized = {
        value: id,
        code,
        label,
        status: entry.status || "",
        order,
        time: timestamp,
      };
      const prev = reelOptionCache.get(id);
      const changed =
        !prev ||
        prev.label !== normalized.label ||
        prev.code !== normalized.code ||
        prev.status !== normalized.status ||
        prev.order !== normalized.order ||
        prev.time !== normalized.time;
      reelOptionCache.set(id, normalized);
      if (normalized.code) {
        const list = reelIdsByCode.get(normalized.code) || [];
        if (!list.includes(id)) {
          list.push(id);
          reelIdsByCode.set(normalized.code, list);
        }
      }
      return changed;
    }

    function needsReelMetadata(meta = {}) {
      const code = meta.code || meta.reel_code || "";
      const order = meta.order || meta.order_number || "";
      const time =
        meta.time ||
        meta.time_end ||
        meta.time_start ||
        meta.timestamp ||
        meta.reel_time ||
        "";
      return !code || !order || !time;
    }

    async function hydrateReelMetadata(reelId, fallbackCode = "") {
      const idValue = reelId !== undefined && reelId !== null ? String(reelId).trim() : "";
      if (!idValue || pendingReelHydrations.has(idValue)) return;
      pendingReelHydrations.add(idValue);
      try {
        const summary = await Api.get(`reel/${idValue}/summary`);
        const reel = summary && summary.reel ? summary.reel : null;
        if (!reel) return;
        const code = reel.reel_code || fallbackCode || "";
        const order = reel.order_number || reel.order || "";
        const time =
          reel.time ||
          reel.time_end ||
          reel.time_start ||
          reel.timestamp ||
          "";
        const option = {
          value: reel.reel_id ?? idValue,
          code,
          order,
          time,
          label: formatReelLabel({ code, order, time }),
        };
        rememberReelOption(option);
        if (state.reel_ids.includes(String(reel.reel_id ?? idValue))) {
          renderChips();
        }
      } catch (err) {
        console.warn(`Filters: failed to hydrate reel metadata for ${reelId}`, err);
      } finally {
        pendingReelHydrations.delete(idValue);
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
        const code = entry && entry.code ? entry.code : "";
        const order = entry && entry.order ? entry.order : "";
        const time = entry && entry.time ? entry.time : "";
        const label =
          (entry && entry.label) ||
          formatReelLabel({ code, order, time }) ||
          (code || `Reel ${id}`);
        return {
          id,
          code,
          label,
          status: entry && entry.status ? entry.status : "",
        };
      });
    }

    function getJobOptions() {
      if (!elements.job) return [];
      return Array.from(elements.job.options || [])
        .filter((option) => option.value && option.value !== "")
        .map((option) => ({
          value: option.value,
          label: option.textContent.trim() || option.value,
        }));
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

    function registerReelMetadata(meta = {}) {
      if (!meta) return;
      const rawValue = meta.reel_id ?? meta.value ?? meta.id;
      if (rawValue === undefined || rawValue === null) return;
      const changed = rememberReelOption({
        value: rawValue,
        code: meta.reel_code ?? meta.code ?? "",
        label: meta.label,
        order: meta.order ?? meta.order_number ?? "",
        time: meta.time ?? meta.time_end ?? meta.time_start ?? meta.timestamp ?? "",
        status: meta.status,
      });
      if (changed && state.reel_ids.includes(String(rawValue))) {
        renderChips();
      }
    }

    const listeners = new Set();
    const optionListeners = new Set();
    const rangeDefaults = computeDefaultRange(2);
    const defaults = {
      machine_id:
        (root && root.dataset.defaultMachine) ||
        (elements.machine ? elements.machine.value : "5"),
      start:
        (root && root.dataset.defaultStartDate) ||
        (elements.start ? elements.start.value : rangeDefaults.start),
      end:
        (root && root.dataset.defaultEndDate) ||
        (elements.end ? elements.end.value : rangeDefaults.end),
      job: "",
      order: "",
      reel_ids: [],
    };
    const persisted = window.FilterState
      ? window.FilterState.initPage({
          page: "dashboard",
          defaults,
          resetOnReload: null,
        })
      : defaults;
    function shouldBootstrapFromQuery() {
      return false;
    }
    const baseFilters = persisted;
    let state = {
      machine_id: baseFilters.machine_id ?? defaults.machine_id,
      start: baseFilters.start ?? defaults.start,
      end: baseFilters.end ?? defaults.end,
      job: baseFilters.job ?? defaults.job,
      order: baseFilters.order ?? defaults.order,
      reel_ids: Array.isArray(baseFilters.reel_ids) ? [...baseFilters.reel_ids] : [],
    };
    let updating = false;
    let initialized = false;
    let refreshOptionsQueued = false;
    let urlSyncEnabled = false;
    let readyResolve = null;
    let lastOptionsKey = "";
    const readyPromise = new Promise((resolve) => {
      readyResolve = resolve;
    });

    function persistFilters(partial = {}) {
      if (!window.FilterState) return;
      const entries = getSelectedReelEntries()
        .map((entry) => entry.code)
        .filter((code) => code);
      const payload = { ...partial, reel_code: entries };
      window.FilterState.update(payload);
    }

    function persistAll() {
      const entries = getSelectedReelEntries()
        .map((entry) => entry.code)
        .filter((code) => code);
      persistFilters({
        machine_id: state.machine_id,
        start: state.start,
        end: state.end,
        job: state.job,
        order: state.order,
        reel_ids: state.reel_ids.slice(),
        reel_code: entries,
      });
    }

    function markReady() {
      if (readyResolve) {
        readyResolve();
        readyResolve = null;
      }
    }

    function markUserInteraction() {
      urlSyncEnabled = true;
    }

    const scheduleEmit = Utils.debounce(() => emit(false), FETCH_DEBOUNCE_MS);
    let firstEmit = true;
    const scheduleOptionsRefresh = Utils.debounce(() => refreshOptions(), 200);

    function optionsKey(filters = getState()) {
      return [
        filters.machine_id || "",
        filters.start || "",
        filters.end || "",
        filters.job || "",
        filters.order || "",
        Array.isArray(filters.reel_id) ? filters.reel_id.join(",") : filters.reel_id || "",
      ].join("|");
    }

    function hasFreshOptions() {
      return Boolean(lastOptionsKey && lastOptionsKey === optionsKey());
    }

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
      if (elements.machine && state.machine_id) elements.machine.value = state.machine_id;
      if (elements.start && state.start) elements.start.value = state.start;
      if (elements.end && state.end) elements.end.value = state.end;
      if (elements.job) elements.job.value = state.job || "";
      if (elements.order) elements.order.value = state.order || "";
      if (shouldBootstrapFromQuery()) {
        applySearchParams();
      } else {
        syncReelSelect();
      }
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
      persistAll();
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
      persistAll();
    }

    function attachListeners() {
      Object.entries(elements).forEach(([name, el]) => {
        if (!el || name === "chips") return;
        el.addEventListener("change", (evt) => {
          if (name === "reel") {
            if (el.multiple) {
              handleInputChange(name, getSelectedReelsFromSelect());
            } else {
              handleReelPickerChange(evt.target.value || "");
            }
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
      if (elements.clearButton) {
        elements.clearButton.addEventListener("click", () => {
          clearAllFilters().catch((error) => console.error("Failed to clear filters", error));
        });
      }
    }

    function getSelectedReelsFromSelect() {
      if (!elements.reel) return [];
      return Array.from(elements.reel.selectedOptions)
        .map((option) => option.value)
        .filter((value) => value);
    }

    function handleReelPickerChange(value) {
      if (!elements.reel) return;
      if (!value) {
        state.reel_ids = [];
        pendingReelCodes = [];
        syncReelSelect();
        persistFilters({ reel_ids: [] });
        emit(true);
        return;
      }
      const shouldReplace =
        typeof window !== "undefined" &&
        window.Router &&
        typeof window.Router.current === "function" &&
        window.Router.current() === "qc-review";
      addReel(null, value, {}, { replace: shouldReplace });
      elements.reel.value = "";
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
      if (!elements.reel.multiple) {
        Array.from(options).forEach((option) => {
          if (option.value === "") {
            option.selected = true;
            option.disabled = false;
          } else {
            option.selected = false;
            option.disabled = selectedSet.has(option.value);
          }
        });
        return;
      }
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

    function clearReelSelectionState() {
      state.reel_ids = [];
      pendingReelCodes = [];
      syncReelSelect();
    }

    function handleInputChange(field, value) {
      if (updating) return;
      markUserInteraction();
      switch (field) {
        case "machine":
          state.machine_id = value || "";
          state.job = "";
          if (elements.job) elements.job.value = "";
          state.order = "";
          if (elements.order) elements.order.value = "";
          clearReelSelectionState();
          renderChips();
          persistFilters({
            machine_id: state.machine_id,
            job: state.job,
            order: state.order,
            reel_ids: state.reel_ids.slice(),
          });
          scheduleOptionsRefresh();
          break;
        case "start": {
          const normalizedStart = value || "";
          if (state.start === normalizedStart) return;
          state.start = normalizedStart;
          persistFilters({ start: state.start, end: state.end });
          scheduleOptionsRefresh();
          break;
        }
        case "end": {
          const normalizedEnd = value || "";
          if (state.end === normalizedEnd) return;
          state.end = normalizedEnd;
          persistFilters({ end: state.end });
          scheduleOptionsRefresh();
          break;
        }
        case "job":
          state.job = value || "";
          if (elements.job) elements.job.value = state.job;
          state.order = "";
          if (elements.order) elements.order.value = "";
          clearReelSelectionState();
          renderChips();
          persistFilters({
            job: state.job,
            order: state.order,
            reel_ids: state.reel_ids.slice(),
          });
          scheduleOptionsRefresh();
          break;
        case "order":
          state.order = value || "";
          clearReelSelectionState();
          renderChips();
          persistFilters({ order: state.order, reel_ids: state.reel_ids.slice() });
          scheduleOptionsRefresh();
          break;
        case "reel":
          if (Array.isArray(value)) {
            state.reel_ids = value.map((entry) => `${entry}`.trim()).filter((entry) => entry);
          } else {
            state.reel_ids = value ? [`${value}`.trim()] : [];
          }
          syncReelSelect();
          persistFilters({ reel_ids: state.reel_ids.slice() });
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
        const requestState = getState();
        const requestOptionsKey = optionsKey(requestState);
        const data = await Api.get("filters", {}, requestState);
        updating = true;
        const jobOptions = ensureCurrentJobOption(data.jobs || []);
        updateSelect(elements.job, jobOptions, state.job ? [state.job] : []);
        updateSelect(elements.order, data.orders || [], state.order ? [state.order] : []);
        updateSelect(elements.reel, data.reel_codes || [], state.reel_ids);
        hydratePendingReelIds();
        lastOptionsKey = requestOptionsKey;
        updating = false;
        updateDependentFilters();
        renderChips();
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

    function ensureCurrentJobOption(options) {
      const list = Array.isArray(options) ? [...options] : [];
      if (!state.job) return list;
      const normalizedJob = String(state.job);
      const jobExists = list.some((raw) => {
        if (raw === undefined || raw === null || raw === "") return false;
        if (typeof raw === "object") {
          const rawValue =
            raw.value ??
            raw.job ??
            raw.job_number ??
            raw.job_id ??
            raw.id ??
            raw.code ??
            raw.label;
          return rawValue !== undefined && rawValue !== null && String(rawValue) === normalizedJob;
        }
        return String(raw) === normalizedJob;
      });
      if (jobExists) return list;
      const fallbackLabel = selectedOptionText(elements.job) || normalizedJob;
      list.unshift({
        value: normalizedJob,
        label: fallbackLabel,
      });
      return list;
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
        defaultOption.selected = true;
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
      if (selectEl === elements.reel && !isMultiple) {
        selectEl.value = "";
      } else if (isMultiple) {
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
      if (urlSyncEnabled) {
        Utils.updateUrlQuery(payload);
      }
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
      markUserInteraction();
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
          clearReelSelectionState();
          updateDependentFilters();
          persistFilters({
            machine_id: state.machine_id,
            job: state.job,
            order: state.order,
            reel_ids: state.reel_ids.slice(),
          });
          await refreshOptions(true);
          emit(true);
          break;
        case "start":
          state.start = defaults.start || "";
          if (elements.start) elements.start.value = state.start || "";
          persistFilters({ start: state.start });
          await refreshOptions(true);
          emit(true);
          break;
        case "end":
          state.end = defaults.end || "";
          if (elements.end) elements.end.value = state.end || "";
          persistFilters({ end: state.end });
          await refreshOptions(true);
          emit(true);
          break;
        case "job":
          state.job = "";
          if (elements.job) elements.job.value = "";
          state.order = "";
          if (elements.order) elements.order.value = "";
          clearReelSelectionState();
          renderChips();
          updateDependentFilters();
          persistFilters({ job: state.job, order: state.order, reel_ids: state.reel_ids.slice() });
          await refreshOptions(true);
          emit(true);
          break;
        case "order":
          state.order = "";
          if (elements.order) elements.order.value = "";
          clearReelSelectionState();
          renderChips();
          updateDependentFilters();
          persistFilters({ order: state.order, reel_ids: state.reel_ids.slice() });
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
            persistFilters({ reel_ids: state.reel_ids.slice() });
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
            persistFilters({ reel_ids: state.reel_ids.slice() });
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
      // Start/end chips removed per request – keep defaults in FilterState but don't render chips.
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
      markUserInteraction();
      updating = true;
      let needsOptionsRefresh = false;
      switch (field) {
        case "job":
          state.job = value || "";
          if (elements.job) elements.job.value = state.job;
          state.order = "";
          if (elements.order) elements.order.value = "";
          clearReelSelectionState();
          renderChips();
          persistFilters({ job: state.job, order: state.order, reel_ids: state.reel_ids.slice() });
          needsOptionsRefresh = true;
          break;
        case "order":
          state.order = value || "";
          if (state.order === ORDER_NONE) {
            ensureOrderOption(ORDER_NONE, "None");
          }
          if (elements.order) elements.order.value = state.order;
          clearReelSelectionState();
          renderChips();
          persistFilters({ order: state.order, reel_ids: state.reel_ids.slice() });
          needsOptionsRefresh = true;
          break;
        case "start":
          state.start = value || "";
          if (elements.start) elements.start.value = state.start || "";
          persistFilters({ start: state.start });
          break;
        case "end":
          state.end = value || "";
          if (elements.end) elements.end.value = state.end || "";
          persistFilters({ end: state.end });
          break;
        case "machine_id":
          state.machine_id = value || "";
          if (elements.machine) elements.machine.value = state.machine_id || "";
          persistFilters({ machine_id: state.machine_id });
          break;
        case "reel_ids":
          state.reel_ids = Array.isArray(value)
            ? value.map((entry) => `${entry}`.trim()).filter((entry) => entry)
            : [];
          pendingReelCodes = [];
          syncReelSelect();
          persistFilters({ reel_ids: state.reel_ids.slice() });
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
      if (updateUrl && !shouldEmit && urlSyncEnabled) {
        Utils.updateUrlQuery(getState());
      }
    }

    function addReel(code, reelId, metadata = {}, { replace = false } = {}) {
      const normalizedId =
        reelId !== undefined && reelId !== null ? String(reelId).trim() : "";
      let targetId = normalizedId;
      if (!targetId && code) {
        const ids = reelIdsByCode.get(code) || [];
        targetId = ids[0] || "";
      }
      if (!targetId) return;
      const alreadySelected = state.reel_ids.includes(targetId);
      markUserInteraction();
      if (replace) {
        state.reel_ids = targetId ? [targetId] : [];
      } else if (!alreadySelected) {
        state.reel_ids = [...state.reel_ids, targetId];
      }
      if (replace) {
        const normalizedMeta = {
          value: targetId,
          code: (metadata.code ?? metadata.reel_code ?? code) || "",
          label: metadata.label,
          order: metadata.order ?? metadata.order_number ?? "",
          time:
            metadata.time ??
            metadata.time_end ??
            metadata.time_start ??
            metadata.timestamp ??
            "",
        };
        rememberReelOption(normalizedMeta);
        state.reel_ids = targetId ? [targetId] : [];
        syncReelSelect();
        persistFilters({ reel_ids: state.reel_ids.slice() });
        if (needsReelMetadata({ ...metadata, value: targetId, code: normalizedMeta.code, order: normalizedMeta.order, time: normalizedMeta.time })) {
          hydrateReelMetadata(targetId, normalizedMeta.code);
        }
        emit(true);
        return;
      }
      if (!alreadySelected) {
        const normalizedMeta = {
          value: targetId,
          code: (metadata.code ?? metadata.reel_code ?? code) || "",
          label: metadata.label,
          order: metadata.order ?? metadata.order_number ?? "",
          time:
            metadata.time ??
            metadata.time_end ??
            metadata.time_start ??
            metadata.timestamp ??
            "",
        };
        rememberReelOption(normalizedMeta);
        syncReelSelect();
        persistFilters({ reel_ids: state.reel_ids.slice() });
        if (needsReelMetadata({ ...metadata, value: targetId, code: normalizedMeta.code, order: normalizedMeta.order, time: normalizedMeta.time })) {
          hydrateReelMetadata(targetId, normalizedMeta.code);
        }
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
      markUserInteraction();
      updating = true;
      const pendingMachineChange = entries.some(([key, proposedValue]) => {
        if (key !== "machine_id") return false;
        const normalizedNext = proposedValue !== undefined && proposedValue !== null ? String(proposedValue) : "";
        const normalizedCurrent = state.machine_id !== undefined && state.machine_id !== null ? String(state.machine_id) : "";
        return normalizedNext !== normalizedCurrent;
      });

      entries.forEach(([field, value]) => {
        switch (field) {
          case "job":
          case "order":
          case "start":
          case "end":
          case "machine_id":
            if (field === "job") {
              const hasPendingValue = value !== undefined && value !== null && value !== "";
              if (!hasPendingValue) {
                if (!state.job) return;
                if (!pendingMachineChange) return;
              }
            }
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
      persistAll();
      if (shouldEmit) emit(false);
      if (updateUrl && urlSyncEnabled) {
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
      markUserInteraction();
      const next = state.reel_ids.filter((entry) => entry !== targetId);
      if (next.length === state.reel_ids.length) return;
      state.reel_ids = next;
      syncReelSelect();
      persistFilters({ reel_ids: state.reel_ids.slice() });
      if (shouldEmit) emit(true);
      else renderChips();
    }

    function clearReels({ emit: shouldEmit = true } = {}) {
      if (!state.reel_ids.length && !pendingReelCodes.length) return;
      markUserInteraction();
      state.reel_ids = [];
      pendingReelCodes = [];
      syncReelSelect();
      persistFilters({ reel_ids: state.reel_ids.slice() });
      if (shouldEmit) emit(true);
      else renderChips();
    }

    async function clearAllFilters() {
      markUserInteraction();
      const nextStart = defaults.start || "";
      const nextEnd = defaults.end || "";
      const shouldKeepJob =
        typeof window !== "undefined" &&
        window.Router &&
        typeof window.Router.current === "function" &&
        window.Router.current() !== "overview";
      const jobChanged = !shouldKeepJob && Boolean(state.job);
      const hadChanges =
        state.start !== nextStart ||
        state.end !== nextEnd ||
        jobChanged ||
        state.order ||
        state.reel_ids.length ||
        pendingReelCodes.length;
      state.start = nextStart;
      state.end = nextEnd;
      if (!shouldKeepJob) {
        state.job = "";
        if (elements.job) elements.job.value = "";
      }
      state.order = "";
      state.reel_ids = [];
      pendingReelCodes = [];
      if (elements.start) elements.start.value = state.start || "";
      if (elements.end) elements.end.value = state.end || "";
      if (elements.order) elements.order.value = "";
      syncReelSelect();
      updateDependentFilters();
      renderChips();
      persistFilters({
        start: state.start,
        end: state.end,
        job: state.job,
        order: state.order,
        reel_ids: state.reel_ids.slice(),
      });
      if (!hadChanges) return;
      await refreshOptions(true);
      emit(true);
    }

    function clearJob({ emit: shouldEmit = true } = {}) {
      if (!state.job) return;
      markUserInteraction();
      set("job", "", { emit: shouldEmit, updateUrl: true });
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
      refreshOptions,
      hasFreshOptions,
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
      clearAllFilters,
      clearJob,
      updateReelStatus,
      setFieldDisabled,
      clearFieldOverride,
      registerReelMetadata,
      getJobOptions,
    };
  })();
