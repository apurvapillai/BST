(function () {
  let jobModal = null;
  let jobModalSelect = null;
  let jobModalClose = null;
  let requestedJobTab = "";
  const guardedTabs = new Set(["job", "defects", "qc-review", "heatmap"]);
  const TAB_SCRIPT_CONFIG = {
    job: { path: "/static/js/tabs/job_explorer.js", exportName: "JobExplorerTab" },
    defects: { path: "/static/js/tabs/defect_explorer.js", exportName: "DefectExplorerTab" },
    "defect-drivers": { path: "/static/js/tabs/defect_drivers.js", exportName: "DefectDriversTab" },
    "qc-review": { path: "/static/js/tabs/qc_review.js", exportName: "QcReviewTab" },
    heatmap: { path: "/static/js/tabs/heatmap.js", exportName: "HeatmapTab" },
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

  function openJobModal(targetTab) {
    if (!jobModal || !jobModalSelect) return;
    requestedJobTab = targetTab || "";
    const options = Filters.getJobOptions ? Filters.getJobOptions() : [];
    Utils.populateSelect(jobModalSelect, options, { placeholder: "Select a job" });
    jobModalSelect.value = "";
    jobModal.classList.remove("hidden");
    jobModal.setAttribute("aria-hidden", "false");
    jobModalSelect.focus();
  }

  function closeJobModal() {
    if (!jobModal) return;
    jobModal.classList.add("hidden");
    jobModal.setAttribute("aria-hidden", "true");
  }

  function setupJobModal() {
    jobModal = document.getElementById("jobSelectModal");
    jobModalSelect = document.getElementById("jobSelectModalInput");
    jobModalClose = document.getElementById("jobSelectModalClose");
    if (!jobModal || !jobModalSelect || !jobModalClose) {
      return;
    }
    jobModalSelect.addEventListener("change", () => {
      const value = (jobModalSelect.value || "").trim();
      if (!value) return;
      Filters.set("job", value, { emit: true, updateUrl: true });
      closeJobModal();
      const target =
        (Router.consumePendingJobTab && Router.consumePendingJobTab()) ||
        requestedJobTab ||
        "job";
      requestedJobTab = "";
      Router.setActive(target);
    });
    jobModalClose.addEventListener("click", () => {
      closeJobModal();
      if (Router.consumePendingJobTab) {
        Router.consumePendingJobTab();
      }
    });
    window.addEventListener("dashboard:job-required", (event) => {
      const target = event && event.detail && event.detail.tab ? event.detail.tab : "";
      openJobModal(target);
    });
  }

  function initTabs() {
    // normalizeDashboardUrl(); // disabled to preserve incoming hashes
    bindTabNav();
    setupJobModal();
    Filters.init();
    if (typeof OverviewTab !== "undefined" && OverviewTab && typeof OverviewTab.init === "function") {
      OverviewTab.init();
    }

    Router.register("overview", OverviewTab);
    Router.register("job", createLazyTab("job"));
    Router.register("defects", createLazyTab("defects"));
    Router.register("defect-drivers", createLazyTab("defect-drivers"));
    Router.register("qc-review", createLazyTab("qc-review"));
    Router.register("heatmap", createLazyTab("heatmap"));
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
