(function () {
  let jobModal = null;
  let jobModalSelect = null;
  let jobModalClose = null;
  let requestedJobTab = "";
  const guardedTabs = new Set(["job", "defects", "qc-review", "heatmap"]);

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
    OverviewTab.init();
    JobExplorerTab.init();
    DefectExplorerTab.init();
    QcReviewTab.init();
    HeatmapTab.init();

    Router.register("overview", OverviewTab);
    Router.register("job", JobExplorerTab);
    Router.register("defects", DefectExplorerTab);
    Router.register("qc-review", QcReviewTab);
    Router.register("heatmap", HeatmapTab);
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

    Filters.onChange(() => {
      Router.reloadActive();
    });
    Router.reloadActive();
  }

  function initializeApp() {
    initTabs();
    if (window.DefectModals && typeof window.DefectModals.bindAll === "function") {
      window.DefectModals.bindAll();
    }
  }

  document.addEventListener("DOMContentLoaded", initializeApp);
})();
