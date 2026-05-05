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
      const text = await response.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch (err) {
          const message = response.ok
            ? "Server returned an invalid JSON response"
            : response.statusText || `Request failed (${response.status})`;
          throw new Error(message);
        }
      }
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
    let pendingJobTab = "";
    const jobRequiredTabs = new Set(["job", "qc-review"]);
    const hashToRoute = {
      "job-explorer": "job",
      "defect-trends": "defect-trends",
      "defect-drivers": "defect-drivers",
      "reference-check": "reference-check",
      overview: "overview",
      "qc-review": "qc-review",
      job: "job",
      "defect-trends": "defect-trends",
    };
    const routeToHash = {
      job: "job-explorer",
      "defect-trends": "defect-trends",
      "defect-drivers": "defect-drivers",
      "reference-check": "reference-check",
      overview: "overview",
      "qc-review": "qc-review",
    };

    function register(name, module) {
      tabs[name] = module;
    }

    function init() {
      handleHashChange();
      window.addEventListener("hashchange", handleHashChange);
    }

    function normalizeHash(hash) {
      if (!hash) return "overview";
      return hashToRoute[hash] || hash;
    }

    function handleHashChange() {
      const rawHash = window.location.hash.replace("#", "") || "overview";
      const target = normalizeHash(rawHash);
      setActive(target);
    }

    function setActive(name) {
      let target = name;
      if (!tabs[target]) target = "overview";
      const requiresJob = jobRequiredTabs.has(target);
      if (
        requiresJob &&
        (!Filters.hasJobSelection || !Filters.hasJobSelection())
      ) {
        requestJobSelection(target);
        return;
      }
      if (active === target) {
        if (tabs[active] && typeof tabs[active].activate === "function") {
          tabs[active].activate();
        }
        return;
      }

      const previous = active;
      active = target;
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
      const targetHash = routeToHash[active] || active;
      if (url.hash !== `#${targetHash}`) {
        url.hash = `#${targetHash}`;
        history.replaceState({}, "", url.toString());
      }
      if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
        window.dispatchEvent(
          new CustomEvent("dashboard:tab-change", {
            detail: { tab: active },
          })
        );
      }
    }

    function revertHash() {
      const url = new URL(window.location.href);
      const targetHash = routeToHash[active] || active;
      if (url.hash !== `#${targetHash}`) {
        url.hash = `#${targetHash}`;
        history.replaceState({}, "", url.toString());
      }
    }

    function consumePendingJobTab() {
      const target = pendingJobTab;
      pendingJobTab = "";
      return target;
    }

    function hasPendingJobTab() {
      return Boolean(pendingJobTab);
    }

    function requiresJobTab(name) {
      return jobRequiredTabs.has(name);
    }

    function requestJobSelection(target) {
      pendingJobTab = target;
      if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
        window.dispatchEvent(
          new CustomEvent("dashboard:job-required", {
            detail: { tab: target },
          })
        );
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

    return {
      register,
      init,
      setActive,
      reloadActive,
      current,
      consumePendingJobTab,
      hasPendingJobTab,
      requiresJobTab,
      requestJobSelection,
    };
  })();

  if (typeof window !== "undefined") {
    window.Router = Router;
  }
