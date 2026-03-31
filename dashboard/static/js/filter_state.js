(function () {
  const STORAGE_KEY = "bstFilterState.v1";

  function getNavigationType() {
    if (typeof performance === "undefined") return null;
    if (typeof performance.getEntriesByType === "function") {
      const entries = performance.getEntriesByType("navigation");
      if (entries && entries.length && entries[0] && entries[0].type) {
        return entries[0].type;
      }
    }
    if (performance.navigation) {
      const legacyType = performance.navigation.type;
      const legacyMap = {
        0: "navigate",
        1: "reload",
        2: "back_forward",
        255: "reserved",
      };
      if (legacyType in legacyMap) {
        return legacyMap[legacyType];
      }
      if (legacyType === performance.navigation.TYPE_RELOAD) return "reload";
      if (legacyType === performance.navigation.TYPE_BACK_FORWARD) return "back_forward";
      if (legacyType === performance.navigation.TYPE_NAVIGATE) return "navigate";
    }
    return null;
  }

  function isReloadNavigation() {
    const navType = getNavigationType();
    return navType === "reload" || navType === "back_forward";
  }

  function isFreshNavigation() {
    const navType = getNavigationType();
    if (!navType) return true;
    return navType === "navigate";
  }

  function clone(value) {
    if (Array.isArray(value)) return value.slice();
    if (value && typeof value === "object") return { ...value };
    return value;
  }

  function loadStore() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      return null;
    }
  }

  function saveStore(store) {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch (err) {
      // ignore storage errors
    }
  }

  const store = loadStore() || { filters: {}, meta: {} };
  if (!store.meta) store.meta = {};
  if (!store.meta.pages) store.meta.pages = {};

  function applyDefaults(target, defaults) {
    if (!defaults) return;
    Object.entries(defaults).forEach(([key, value]) => {
      target[key] = clone(value);
    });
  }

  function ensureMissing(target, defaults) {
    if (!defaults) return;
    Object.entries(defaults).forEach(([key, value]) => {
      if (!(key in target)) {
        target[key] = clone(value);
      }
    });
  }

  function initPage(config = {}) {
    const { page = "default", defaults = {}, resetOnReload = {} } = config;
    const filters = store.filters || {};
    const pageMeta = store.meta.pages[page] || { visited: false };
    if (!pageMeta.visited) {
      applyDefaults(filters, defaults);
      pageMeta.visited = true;
    } else {
      ensureMissing(filters, defaults);
    }
    store.meta.pages[page] = pageMeta;
    if (isReloadNavigation()) {
      const hasResetOverrides = Boolean(resetOnReload && Object.keys(resetOnReload).length);
      if (hasResetOverrides) {
        applyDefaults(filters, resetOnReload);
      }
    }
    store.filters = filters;
    store.meta.currentPage = page;
    saveStore(store);
    return clone(filters);
  }

  function update(partial = {}) {
    if (!store.filters) {
      store.filters = {};
    }
    Object.entries(partial).forEach(([key, value]) => {
      store.filters[key] = clone(value);
    });
    saveStore(store);
  }

  function getFilters() {
    return clone(store.filters || {});
  }

  window.FilterState = {
    initPage,
    update,
    getFilters,
    isReload: () => isReloadNavigation(),
    isFresh: () => isFreshNavigation(),
  };
})();
