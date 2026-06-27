/**
 * nav-state.js
 *
 * Persists sidebar open/scroll state across SPA navigations in MkDocs Material.
 * Uses the Material document$ observable so it fires after every page swap,
 * not just on the initial DOMContentLoaded.
 */
(function () {
  "use strict";

  const STORAGE_KEY = "nav-state";
  const SIDEBAR_WIDTH_KEY = "gnus-sidebar-width";
  const TOGGLE_SEL  = "input.md-nav__toggle";
  const PRIMARY_SIDEBAR_SEL = ".md-sidebar--primary";
  const DESKTOP_MEDIA_QUERY = "(min-width: 76.25em)";
  const SCROLL_CONTAINER_SELS = [".md-sidebar__scrollwrap", ".md-sidebar__inner"];
  const DEFAULT_SIDEBAR_WIDTH_REM = 16;
  const MIN_SIDEBAR_WIDTH_REM = 12;
  const MAX_SIDEBAR_WIDTH_REM = 32;

  // ── Helpers ───────────────────────────────────────────────────────────────

  function getPrimarySidebar() {
    return document.querySelector(PRIMARY_SIDEBAR_SEL);
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function getRootFontSize() {
    return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  }

  function loadSidebarWidthRem() {
    const saved = parseFloat(localStorage.getItem(SIDEBAR_WIDTH_KEY) || "");
    return Number.isFinite(saved)
      ? clamp(saved, MIN_SIDEBAR_WIDTH_REM, MAX_SIDEBAR_WIDTH_REM)
      : DEFAULT_SIDEBAR_WIDTH_REM;
  }

  function applySidebarWidthRem(widthRem) {
    const clampedWidth = clamp(widthRem, MIN_SIDEBAR_WIDTH_REM, MAX_SIDEBAR_WIDTH_REM);
    document.documentElement.style.setProperty("--gnus-sidebar-width", `${clampedWidth}rem`);
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clampedWidth));
  }

  function getScrollWrap(sidebar) {
    return sidebar?.querySelector(".md-sidebar__scrollwrap") || null;
  }

  function getSidebarInner(sidebar) {
    return sidebar?.querySelector(".md-sidebar__inner") || null;
  }

  function getScrollContainer() {
    const sidebar = getPrimarySidebar();
    if (!sidebar) { return null; }

    return getScrollWrap(sidebar) || getSidebarInner(sidebar) || sidebar;
  }

  function clearSidebarHeightStyles(sidebar, scrollContainer, scrollWrap, sidebarInner) {
    if (sidebar) {
      sidebar.style.height = "";
      sidebar.style.maxHeight = "";
      sidebar.style.overflow = "";
    }

    if (scrollContainer) {
      scrollContainer.style.height = "";
      scrollContainer.style.maxHeight = "";
      scrollContainer.style.overflowY = "";
      scrollContainer.style.overflowX = "";
    }

    if (scrollWrap && scrollWrap !== scrollContainer) {
      scrollWrap.style.height = "";
      scrollWrap.style.maxHeight = "";
      scrollWrap.style.overflow = "";
    }

    if (sidebarInner && sidebarInner !== scrollContainer) {
      sidebarInner.style.height = "";
      sidebarInner.style.maxHeight = "";
      sidebarInner.style.overflow = "";
    }
  }

  function syncSidebarHeight() {
    const sidebar = getPrimarySidebar();
    const scrollWrap = getScrollWrap(sidebar);
    const sidebarInner = getSidebarInner(sidebar);
    const scrollContainer = getScrollContainer();

    if (!sidebar || !scrollContainer) {
      return;
    }

    if (!window.matchMedia(DESKTOP_MEDIA_QUERY).matches) {
      clearSidebarHeightStyles(sidebar, scrollContainer, scrollWrap, sidebarInner);
      return;
    }

    const navTitle = sidebar.querySelector(".md-nav__title");
    const footer = document.querySelector(".md-footer");
    const footerIsVisible = footer && getComputedStyle(footer).display !== "none";

    const titleBottom = navTitle
      ? navTitle.getBoundingClientRect().bottom
      : scrollContainer.getBoundingClientRect().top;
    const footerTop = footerIsVisible
      ? footer.getBoundingClientRect().top
      : window.innerHeight;

    const scrollViewportHeight = Math.max(footerTop - titleBottom, 0);
    const sidebarViewportHeight = Math.max(footerTop - sidebar.getBoundingClientRect().top, 0);

    // Clip the visible pane to the footer boundary while keeping nav content
    // at natural height inside the scroll container.
    sidebar.style.height = "auto";
    sidebar.style.maxHeight = `${sidebarViewportHeight}px`;
    sidebar.style.overflow = "hidden";

    scrollContainer.style.height = "auto";
    scrollContainer.style.maxHeight = `${scrollViewportHeight}px`;
    scrollContainer.style.overflowY = "auto";
    scrollContainer.style.overflowX = "hidden";

    if (scrollWrap && scrollWrap !== scrollContainer) {
      scrollWrap.style.height = "auto";
      scrollWrap.style.maxHeight = "none";
      scrollWrap.style.overflow = "visible";
    }

    if (sidebarInner && sidebarInner !== scrollContainer) {
      sidebarInner.style.height = "auto";
      sidebarInner.style.maxHeight = "none";
      sidebarInner.style.overflow = "visible";
    }
  }

  function bindSidebarResizer() {
    const sidebar = getPrimarySidebar();
    if (!sidebar || sidebar.querySelector(".gnus-sidebar-resizer")) {
      return;
    }

    const handle = document.createElement("div");
    handle.className = "gnus-sidebar-resizer";
    handle.setAttribute("aria-hidden", "true");
    sidebar.appendChild(handle);

    handle.addEventListener("mousedown", (event) => {
      const currentSidebar = getPrimarySidebar();
      if (!currentSidebar) {
        return;
      }

      const rootFontSize = getRootFontSize();
      const sidebarLeft = currentSidebar.getBoundingClientRect().left;

      const onMouseMove = (moveEvent) => {
        const widthRem = (moveEvent.clientX - sidebarLeft) / rootFontSize;
        applySidebarWidthRem(widthRem);
        syncSidebarHeight();
      };

      const onMouseUp = () => {
        document.body.classList.remove("gnus-sidebar-resizing");
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };

      document.body.classList.add("gnus-sidebar-resizing");
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      event.preventDefault();
    });
  }

  function bindSidebarWheelIsolation() {
    // Intentionally disabled: native browser scrolling keeps pane scroll
    // ownership correct and avoids cross-pane wheel coupling.
    return;
  }

  function getNavToggles() {
    return getPrimarySidebar()?.querySelectorAll(TOGGLE_SEL) || [];
  }

  function loadState() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    } catch (_) {
      return {};
    }
  }

  function saveState(patch) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(
      Object.assign(loadState(), patch)
    ));
  }

  // Stable ID derived from the visible label text so it survives SPA swaps.
  function stableId(toggle, index) {
    if (toggle.dataset.navStateId) { return toggle.dataset.navStateId; }
    const label = toggle.closest(".md-nav__item")
                        ?.querySelector(".md-nav__link")
                        ?.textContent.trim();
    const id = label ? "nav-" + label.replace(/\s+/g, "-").toLowerCase()
                     : (toggle.id || ("nav-toggle-" + index));
    toggle.dataset.navStateId = id;
    return id;
  }

  // ── Persist open/close on user interaction ────────────────────────────────

  function bindToggleListeners() {
    getNavToggles().forEach((toggle, index) => {
      if (toggle.dataset.navStateBound) { return; }
      toggle.dataset.navStateBound = "true";

      toggle.addEventListener("change", () => {
        const id = stableId(toggle, index);
        const openIds = new Set(loadState().openIds || []);
        if (toggle.checked) {
          openIds.add(id);
        } else {
          openIds.delete(id);
        }
        saveState({ openIds: Array.from(openIds) });
      });
    });
  }


  // ── Restore state (called after every SPA navigation) ────────────────────

  function restoreState() {
    const state = loadState();
    const openIds = new Set(state.openIds || []);

    // Suppress CSS transitions while we restore toggles and scroll.
    document.body.classList.add("nav-state-restoring");

    // Restore all open toggles.
    getNavToggles().forEach((toggle, index) => {
      if (openIds.has(stableId(toggle, index))) {
        toggle.checked = true;
      }
    });

    // Re-bind toggle listeners to any new DOM nodes from the SPA swap.
    applySidebarWidthRem(loadSidebarWidthRem());
    bindToggleListeners();
    bindSidebarResizer();
    bindSidebarWheelIsolation();

    // Re-enable transitions after the browser has painted the restored toggle
    // state so native sidebar scrolling is left entirely to the browser.
    requestAnimationFrame(() => {
      syncSidebarHeight();
      document.body.classList.remove("nav-state-restoring");
    });
  }

  // ── No-transition style ───────────────────────────────────────────────────

  (function injectStyle() {
    if (document.getElementById("nav-state-style")) { return; }
    const s = document.createElement("style");
    s.id = "nav-state-style";
    s.textContent =
      ".nav-state-restoring * {" +
      "  transition: none !important;" +
      "  animation: none !important;" +
      "  scroll-behavior: auto !important;" +
      "}";
    document.head.appendChild(s);
  })();

  // ── Entry point ───────────────────────────────────────────────────────────
  // Material exposes a RxJS document$ observable that emits after every
  // SPA page swap.  Fall back to DOMContentLoaded for non-Material builds.

  if (typeof document$ !== "undefined") {
    document$.subscribe(restoreState);
  } else {
    document.addEventListener("DOMContentLoaded", restoreState);
  }

  window.addEventListener("resize", syncSidebarHeight, { passive: true });
  window.addEventListener("load", syncSidebarHeight, { passive: true });

})();
