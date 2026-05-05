(function () {
  let pendingAutoJobTab = "";
  let autoJobSelectionPromise = null;
  const guardedTabs = new Set(["job", "qc-review"]);
  const TAB_SCRIPT_CONFIG = {
    job: { path: "/static/js/tabs/job_explorer.js", exportName: "JobExplorerTab" },
    "defect-trends": { path: "/static/js/tabs/defect_trends.js", exportName: "DefectTrendsTab" },
    "defect-drivers": { path: "/static/js/tabs/defect_drivers.js", exportName: "DefectDriversTab" },
    "qc-review": { path: "/static/js/tabs/qc_review.js", exportName: "QcReviewTab" },
    "reference-check": { path: "/static/js/tabs/reference_check.js", exportName: "ReferenceCheckTab" },
  };
  const tabModuleCache = {};

  function updateSidebarHighlight(tabName) {
    if (!tabName) return;
    Utils.qsa('.sidebar-link[data-route="dashboard"]').forEach((link) => {
      const matches = link.dataset.tab === tabName;
      link.classList.toggle("sidebar-link--active", matches);
      link.setAttribute("aria-current", matches ? "page" : "false");
    });
  }

  function setRequiresJobClass(tabName) {
    const shouldRequire = guardedTabs.has(tabName);
    document.body.classList.toggle("requires-job-tab", shouldRequire);
    document.body.classList.toggle("reference-check-tab", tabName === "reference-check");
    document.body.classList.toggle("defect-trends-tab", tabName === "defect-trends");
  }

  // normalizeDashboardUrl() disabled to allow deep links (previously stripped ? and # from /dashboard)

  function bindTabNav() {
    const selectors = '.tab, .sidebar-link[data-route="dashboard"][data-tab]';
    Utils.qsa(selectors).forEach((node) => {
      node.addEventListener("click", (event) => {
        const targetTab = node.dataset.tab;
        if (!targetTab) return;
        const needsJob =
          guardedTabs.has(targetTab) &&
          typeof Filters.hasJobSelection === "function" &&
          !Filters.hasJobSelection();
        const isLink = node.tagName === "A";
        if (isLink) {
          event.preventDefault();
        }
        if (needsJob) {
          event.preventDefault();
          event.stopPropagation();
          if (typeof Router.requestJobSelection === "function") {
            Router.requestJobSelection(targetTab);
          }
          return;
        }
        Router.setActive(targetTab);
        updateSidebarHighlight(targetTab);
        setRequiresJobClass(targetTab);
        sessionStorage.removeItem("dashboardPendingTab");
      });
    });
  }

  function resolveDeferredTab() {
    let pending = null;
    try {
      pending = sessionStorage.getItem("dashboardPendingTab");
      if (pending) {
        sessionStorage.removeItem("dashboardPendingTab");
      }
    } catch (err) {
      pending = null;
    }
    if (!pending) return;
    const hasJob =
      typeof Filters.hasJobSelection === "function" ? Filters.hasJobSelection() : false;
    if (hasJob) {
      Router.setActive(pending);
      return;
    }
    if (typeof Router.requestJobSelection === "function") {
      Router.requestJobSelection(pending);
    }
  }

  async function requestLatestJobSelection(targetTab) {
    pendingAutoJobTab = targetTab || pendingAutoJobTab || "job";
    if (autoJobSelectionPromise) {
      return autoJobSelectionPromise;
    }
    autoJobSelectionPromise = autoSelectLatestJob()
      .then((selected) => {
        if (!selected && Filters && typeof Filters.promptJobSelection === "function") {
          Filters.promptJobSelection(pendingAutoJobTab);
        }
        return selected;
      })
      .catch((err) => {
        console.error("Unable to auto-select latest job", err);
        if (Filters && typeof Filters.promptJobSelection === "function") {
          Filters.promptJobSelection(pendingAutoJobTab);
        }
      })
      .finally(() => {
        autoJobSelectionPromise = null;
      });
    return autoJobSelectionPromise;
  }

  async function autoSelectLatestJob() {
    const selectedJob =
      Filters && typeof Filters.getState === "function" ? String(Filters.getState().job || "").trim() : "";
    if (selectedJob) {
      const target = consumeRequestedJobTab();
      Router.setActive(target);
      return true;
    }
    if (Filters && typeof Filters.ready === "function") {
      await Filters.ready();
    }
    if (
      Filters &&
      typeof Filters.hasFreshOptions === "function" &&
      !Filters.hasFreshOptions() &&
      typeof Filters.refreshOptions === "function"
    ) {
      await Filters.refreshOptions(true);
    }
    let options = Filters.getJobOptions ? Filters.getJobOptions() : [];
    let entries = Array.isArray(options) ? options.filter((option) => option && option.value) : [];
    if (!entries.length && Filters && typeof Filters.refreshOptions === "function") {
      await Filters.refreshOptions(true);
      options = Filters.getJobOptions ? Filters.getJobOptions() : [];
      entries = Array.isArray(options) ? options.filter((option) => option && option.value) : [];
    }
    if (!entries.length) return false;
    const latestJob = String(entries[0].value || "").trim();
    if (!latestJob) return false;
    Filters.set("job", latestJob, { emit: true, updateUrl: true });
    const target = consumeRequestedJobTab();
    Router.setActive(target);
    return true;
  }

  function consumeRequestedJobTab() {
    const target =
      (Router.consumePendingJobTab && Router.consumePendingJobTab()) ||
      pendingAutoJobTab ||
      "job";
    pendingAutoJobTab = "";
    return target;
  }

  function setupJobAutoSelection() {
    window.addEventListener("dashboard:job-required", (event) => {
      const target = event && event.detail && event.detail.tab ? event.detail.tab : "";
      requestLatestJobSelection(target);
    });
  }

  function getActiveJobRequiredTab() {
    const activeTab = Router && typeof Router.current === "function" ? Router.current() : "";
    if (!activeTab) return "";
    if (Router && typeof Router.requiresJobTab === "function") {
      return Router.requiresJobTab(activeTab) ? activeTab : "";
    }
    return guardedTabs.has(activeTab) ? activeTab : "";
  }

  function shouldAutoSelectJobForPayload(payload) {
    const activeTab = getActiveJobRequiredTab();
    if (!activeTab) return "";
    const job = payload && payload.job !== undefined ? payload.job : "";
    return String(job || "").trim() ? "" : activeTab;
  }

  function initTabs() {
    // normalizeDashboardUrl(); // disabled to preserve incoming hashes
    bindTabNav();
    setupJobAutoSelection();
    Filters.init();
    if (typeof OverviewTab !== "undefined" && OverviewTab && typeof OverviewTab.init === "function") {
      OverviewTab.init();
    }

    Router.register("overview", OverviewTab);
    Router.register("job", createLazyTab("job"));
    Router.register("defect-trends", createLazyTab("defect-trends"));
    Router.register("defect-drivers", createLazyTab("defect-drivers"));
    Router.register("qc-review", createLazyTab("qc-review"));
    Router.register("reference-check", createLazyTab("reference-check"));
    Router.init();
    resolveDeferredTab();
    const initialTab = typeof Router.current === "function" ? Router.current() : "overview";
    if (initialTab) {
      updateSidebarHighlight(initialTab);
      setRequiresJobClass(initialTab);
    }
    window.addEventListener("dashboard:tab-change", (event) => {
      const tab = event && event.detail && event.detail.tab;
      if (tab) {
        updateSidebarHighlight(tab);
        setRequiresJobClass(tab);
      }
    });

    const serializeFilters = (value) => {
      if (!value || typeof Utils !== "object" || typeof Utils.buildFilterRequestKey !== "function") {
        try {
          return JSON.stringify(value || {});
        } catch (err) {
          return "";
        }
      }
      return Utils.buildFilterRequestKey(value);
    };
    let lastFiltersKey = serializeFilters(Filters.getState ? Filters.getState() : {});
    Filters.onChange((payload) => {
      const nextKey = serializeFilters(payload);
      if (lastFiltersKey && nextKey === lastFiltersKey) {
        return;
      }
      lastFiltersKey = nextKey;
      const autoJobTab = shouldAutoSelectJobForPayload(payload);
      if (autoJobTab) {
        requestLatestJobSelection(autoJobTab);
        return;
      }
      Router.reloadActive();
    });
  }

  function createLazyTab(tabName) {
    if (!TAB_SCRIPT_CONFIG[tabName]) {
      return {
        activate() {},
        onFiltersUpdated() {},
        deactivate() {},
      };
    }
    let moduleRef = null;
    let loadPromise = null;
    let initialized = false;

    function ensureModule() {
      if (moduleRef) return Promise.resolve(moduleRef);
      if (!loadPromise) {
        showTabLoadingIndicator(tabName);
        loadPromise = loadTabModuleScript(tabName)
          .then((mod) => {
            moduleRef = mod;
            hideTabLoadingIndicator(tabName);
            loadPromise = null;
            return mod;
          })
          .catch((err) => {
            showTabLoadingIndicator(tabName, "Failed to load tab. Please try again.");
            loadPromise = null;
            return Promise.reject(err);
          });
      }
      return loadPromise;
    }

    function ensureInitialized(mod) {
      if (!initialized && mod && typeof mod.init === "function") {
        mod.init();
        initialized = true;
      }
    }

    function invoke(mod, method) {
      if (mod && typeof mod[method] === "function") {
        mod[method]();
      }
    }

    return {
      activate() {
        ensureModule()
          .then((mod) => {
            ensureInitialized(mod);
            invoke(mod, "activate");
          })
          .catch(() => {});
      },
      onFiltersUpdated() {
        ensureModule()
          .then((mod) => {
            ensureInitialized(mod);
            invoke(mod, "onFiltersUpdated");
          })
          .catch(() => {});
      },
      deactivate() {
        if (!moduleRef) return;
        invoke(moduleRef, "deactivate");
      },
    };
  }

  function loadTabModuleScript(tabName) {
    const config = TAB_SCRIPT_CONFIG[tabName];
    if (!config) {
      return Promise.reject(new Error(`No loader defined for tab "${tabName}"`));
    }
    if (!tabModuleCache[tabName]) {
      tabModuleCache[tabName] = fetch(config.path, { credentials: "same-origin" })
        .then((response) => {
          if (!response.ok) {
            throw new Error(`Failed to load ${tabName} tab (${response.status})`);
          }
          return response.text();
        })
        .then((source) => {
          const moduleSource = `${source}\nexport default ${config.exportName};`;
          const blob = new Blob([moduleSource], { type: "text/javascript" });
          const blobUrl = URL.createObjectURL(blob);
          return import(/* webpackIgnore: true */ blobUrl)
            .then((module) => {
              URL.revokeObjectURL(blobUrl);
              return module && module.default ? module.default : null;
            })
            .catch((err) => {
              URL.revokeObjectURL(blobUrl);
              throw err;
            });
        })
        .catch((err) => {
          console.error(`Failed to load ${tabName} tab`, err);
          throw err;
        });
      tabModuleCache[tabName] = tabModuleCache[tabName].catch((err) => {
        delete tabModuleCache[tabName];
        return Promise.reject(err);
      });
    }
    return tabModuleCache[tabName];
  }

  function showTabLoadingIndicator(tabName, message) {
    const section = document.getElementById(`tab-${tabName}`);
    if (!section) return;
    let indicator = section.querySelector("[data-tab-loading]");
    if (!indicator) {
      indicator = document.createElement("div");
      indicator.dataset.tabLoading = "true";
      indicator.className = "tab-loading-indicator placeholder";
      indicator.setAttribute("role", "status");
      indicator.setAttribute("aria-live", "polite");
      section.prepend(indicator);
    }
    indicator.textContent = message || "Loading…";
  }

  function hideTabLoadingIndicator(tabName) {
    const section = document.getElementById(`tab-${tabName}`);
    if (!section) return;
    const indicator = section.querySelector("[data-tab-loading]");
    if (indicator) {
      indicator.remove();
    }
  }

  function initializeApp() {
    initTabs();
    if (window.DefectModals && typeof window.DefectModals.bindAll === "function") {
      window.DefectModals.bindAll();
    }
  }

  document.addEventListener("DOMContentLoaded", initializeApp);
})();
