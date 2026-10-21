(function () {
  const SIDEBAR_COLLAPSE_KEY = "bstSidebarCollapsed";
  const THEME_KEY = "bstTheme";
  const jobRequiredTabs = new Set(["job", "qc-review"]);

  function getFilterState() {
    if (!window.FilterState || typeof window.FilterState.getFilters !== "function") {
      return {};
    }
    return window.FilterState.getFilters() || {};
  }

  function hasJobSelection() {
    const filters = getFilterState();
    return Boolean((filters.job || "").trim());
  }

  function getPendingDashboardTab() {
    try {
      return sessionStorage.getItem("dashboardPendingTab") || "";
    } catch (err) {
      return "";
    }
  }

  function setPendingDashboardTab(tab) {
    try {
      if (tab) {
        sessionStorage.setItem("dashboardPendingTab", tab);
      } else {
        sessionStorage.removeItem("dashboardPendingTab");
      }
    } catch (err) {
      // ignore storage errors
    }
  }

  function syncActiveLink() {
    const path = window.location.pathname;
    const hash = window.location.hash.replace("#", "") || "overview";
    const pending = getPendingDashboardTab();
    let activeTab = pending;
    if (path.startsWith("/dashboard")) {
      activeTab = hash || "overview";
    }
    const links = document.querySelectorAll(".sidebar-link");
    links.forEach((link) => {
      const route = link.dataset.route;
      const tab = link.dataset.tab;
      let isActive = false;
      if (route === "dashboard") {
        if (path.startsWith("/dashboard")) {
          isActive = tab === activeTab;
        } else if (activeTab) {
          isActive = tab === activeTab;
        } else {
          isActive = Boolean(activeTab) && tab === activeTab;
        }
      } else if (route === "rlm-detail") {
        isActive =
          path.startsWith("/rlm") &&
          !path.startsWith("/rlm/press-intelligence") &&
          !path.startsWith("/rlm/delta-trends");
      } else if (route === "rlm-press-intelligence") {
        isActive = path.startsWith("/rlm/press-intelligence");
      } else if (route === "rlm-delta-trends") {
        isActive = path.startsWith("/rlm/delta-trends");
      } else if (route === "status-overview") {
        isActive = path.startsWith("/statusOverview");
      } else if (route === "bst-overview") {
        isActive = path.startsWith("/bst/overview") || path.startsWith("/statusOverview");
      } else if (route === "bst-change-flags") {
        isActive = path.startsWith("/bst/change-flags");
      } else if (route === "assistant") {
        isActive = path.startsWith("/assistant");
      } else if (route === "insights") {
        isActive = path.startsWith("/insights");
      }
      link.classList.toggle("sidebar-link--active", Boolean(isActive));
      link.setAttribute("aria-current", isActive ? "page" : "false");
    });
  }

  function initThemeToggle(body) {
    const toggle = document.getElementById("themeToggle");
    if (!toggle) return;

    const applyTheme = (mode) => {
      const darkMode = mode === "dark";
      body.classList.toggle("dark-mode", darkMode);
      toggle.setAttribute("aria-pressed", String(darkMode));
      const icon = toggle.querySelector("[aria-hidden]");
      const label = toggle.querySelector(".theme-toggle-text");
      if (icon) icon.textContent = darkMode ? "☀️" : "🌙";
      if (label) label.textContent = darkMode ? "Light Mode" : "Dark Mode";
      window.dispatchEvent(
        new CustomEvent("bst:themechange", { detail: { mode: darkMode ? "dark" : "light" } })
      );
    };

    const stored = (() => {
      try {
        return window.localStorage.getItem(THEME_KEY);
      } catch (err) {
        return null;
      }
    })();
    applyTheme(stored === "dark" ? "dark" : "light");

    toggle.addEventListener("click", () => {
      const nextMode = body.classList.contains("dark-mode") ? "light" : "dark";
      applyTheme(nextMode);
      try {
        window.localStorage.setItem(THEME_KEY, nextMode);
      } catch (err) {
        // ignore storage errors
      }
    });
  }

  function initSidebarControls(body) {
    const sidebar = document.querySelector(".app-sidebar");
    const toggleBtn = document.querySelector("[data-sidebar-toggle]");
    const backdrop = document.querySelector("[data-sidebar-backdrop]");
    const mediaQuery = window.matchMedia("(max-width: 1100px)");

    if (!sidebar) return;

    const notifyLayoutChange = () => {
      window.dispatchEvent(
        new CustomEvent("bst:layoutchange", {
          detail: {
            sidebarCollapsed: body.classList.contains("sidebar-collapsed"),
            sidebarOpen: body.classList.contains("sidebar-open"),
          },
        })
      );
    };

    const setCollapsed = (collapsed) => {
      body.classList.toggle("sidebar-collapsed", collapsed);
      if (toggleBtn) {
        toggleBtn.setAttribute("aria-expanded", String(!collapsed));
      }
      try {
        window.localStorage.setItem(SIDEBAR_COLLAPSE_KEY, collapsed ? "1" : "0");
      } catch (err) {
        // ignore storage errors
      }
      notifyLayoutChange();
    };

    const getStoredCollapsed = () => {
      try {
        return window.localStorage.getItem(SIDEBAR_COLLAPSE_KEY) === "1";
      } catch (err) {
        return false;
      }
    };

    setCollapsed(getStoredCollapsed());

    const closeMobile = () => {
      body.classList.remove("sidebar-open");
      if (toggleBtn) toggleBtn.setAttribute("aria-expanded", "false");
      notifyLayoutChange();
    };

    const openMobile = () => {
      body.classList.add("sidebar-open");
      if (toggleBtn) toggleBtn.setAttribute("aria-expanded", "true");
      notifyLayoutChange();
    };

    if (toggleBtn) {
      toggleBtn.addEventListener("click", () => {
        if (mediaQuery.matches) {
          if (body.classList.contains("sidebar-open")) {
            closeMobile();
          } else {
            openMobile();
          }
          return;
        }
        setCollapsed(!body.classList.contains("sidebar-collapsed"));
      });
    }

    if (backdrop) {
      backdrop.addEventListener("click", closeMobile);
    }

    mediaQuery.addEventListener("change", () => {
      if (!mediaQuery.matches) {
        closeMobile();
      }
      notifyLayoutChange();
    });

    return { closeMobile, mediaQuery };
  }

  function handleNavClicks(helpers) {
    const links = document.querySelectorAll(".sidebar-link");
    if (!links.length) return;

    links.forEach((link) => {
      link.addEventListener("click", (event) => {
        if (helpers && helpers.mediaQuery.matches && helpers.closeMobile) {
          helpers.closeMobile();
        }
        const route = link.dataset.route;
        const tab = link.dataset.tab;
        if (!route) return;

        const needsJob =
          route === "dashboard" && tab && jobRequiredTabs.has(tab) && !hasJobSelection();
        if (
          needsJob &&
          !window.location.pathname.startsWith("/dashboard")
        ) {
          event.preventDefault();
          event.stopPropagation();
          setPendingDashboardTab(tab);
          if (
            window.location.pathname.startsWith("/rlm") &&
            window.RLMHandlers &&
            typeof window.RLMHandlers.requestJobSelection === "function"
          ) {
            window.RLMHandlers.requestJobSelection(tab);
            syncActiveLink();
            return;
          }
          const targetHref = link.getAttribute("href") || `/dashboard#${tab}`;
          window.location.href = targetHref;
        } else if (route === "dashboard" && tab) {
          setPendingDashboardTab("");
        }
      });
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    const body = document.body;
    initThemeToggle(body);
    const helpers = initSidebarControls(body);
    handleNavClicks(helpers);
    syncActiveLink();

    window.addEventListener("hashchange", () => {
      if (window.location.pathname.startsWith("/dashboard")) {
        const currentHash = window.location.hash.replace("#", "") || "overview";
        if (currentHash) {
          setPendingDashboardTab(currentHash);
        }
      }
      syncActiveLink();
    });
  });
})();
