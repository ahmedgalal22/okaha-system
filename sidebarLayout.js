/**
 * sidebarLayout.js — resizable, collapsible, and responsive sidebar behavior
 */

const STORAGE_WIDTH_KEY = 'financial_sidebar_width';
const STORAGE_COLLAPSED_KEY = 'financial_sidebar_collapsed';
const DEFAULT_WIDTH = 260;
const MIN_WIDTH = 60;
const MAX_WIDTH = 500;
const OVERLAY_QUERY = '(max-width: 1024px)';

function clampWidth(value) {
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth || 0;
  const safeMax = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, viewportWidth - 48));
  return Math.min(Math.max(value, MIN_WIDTH), safeMax);
}

export function initSidebarLayout() {
  if (document.body.dataset.sidebarLayoutBound === '1') return;
  document.body.dataset.sidebarLayoutBound = '1';

  const sidebar = document.getElementById('sidebar');
  const mainContent = document.getElementById('mainContent');
  const toggleBtn = document.getElementById('sidebarToggle');
  if (!sidebar || !mainContent) return;

  const navLinks = sidebar.querySelectorAll('.sidebar-link');
  navLinks.forEach((link) => {
    const labelEl = link.querySelector('.sidebar-link__label');
    const label = (link.dataset.tooltip || link.getAttribute('aria-label') || labelEl?.textContent || '').trim();
    if (label) {
      if (!link.dataset.tooltip) link.dataset.tooltip = label;
    }
  });

  const tooltip = document.createElement('div');
  tooltip.className = 'sidebar-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.setAttribute('aria-hidden', 'true');
  document.body.appendChild(tooltip);

  let activeLink = null;

  const getLinkLabel = (link) => {
    const labelEl = link.querySelector('.sidebar-link__label');
    return (link.dataset.tooltip || link.getAttribute('aria-label') || labelEl?.textContent || '').trim();
  };

  const positionTooltip = (link) => {
    const rect = link.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const gap = 12;
    const top = rect.top + rect.height / 2;
    let left = rect.left - tooltipRect.width - gap;

    if (left < 8) {
      left = rect.right + gap;
    }

    const maxLeft = window.innerWidth - tooltipRect.width - 8;
    tooltip.style.left = `${Math.min(Math.max(left, 8), maxLeft)}px`;
    tooltip.style.top = `${Math.min(Math.max(top, 8), window.innerHeight - 8)}px`;
  };

  const showTooltip = (link) => {
    const label = getLinkLabel(link);
    if (!label) return;
    tooltip.textContent = label;
    tooltip.classList.add('is-visible');
    tooltip.setAttribute('aria-hidden', 'false');
    activeLink = link;
    requestAnimationFrame(() => positionTooltip(link));
  };

  const hideTooltip = () => {
    tooltip.classList.remove('is-visible');
    tooltip.setAttribute('aria-hidden', 'true');
    activeLink = null;
  };

  sidebar.addEventListener('mouseover', (event) => {
    const link = event.target.closest('.sidebar-link');
    if (!link || !sidebar.contains(link)) return;
    if (activeLink === link) return;
    showTooltip(link);
  });

  sidebar.addEventListener('mouseout', (event) => {
    if (!activeLink) return;
    const related = event.relatedTarget;
    if (related && related.closest && related.closest('.sidebar-link') === activeLink) return;
    hideTooltip();
  });

  sidebar.addEventListener('scroll', () => {
    if (activeLink) hideTooltip();
  }, { passive: true });

  const resizeHandle = sidebar.querySelector('.sidebar__resize-handle');
  const overlayMedia = window.matchMedia(OVERLAY_QUERY);

  const state = {
    width: DEFAULT_WIDTH,
    collapsed: false,
    overlay: overlayMedia.matches,
    open: false,
  };

  const storedWidth = Number.parseInt(localStorage.getItem(STORAGE_WIDTH_KEY) || '', 10);
  if (Number.isFinite(storedWidth)) state.width = storedWidth;
  state.collapsed = localStorage.getItem(STORAGE_COLLAPSED_KEY) === '1';

  const applyWidth = (width, persist = false) => {
    const clamped = clampWidth(width);
    document.documentElement.style.setProperty('--sidebar-width', `${clamped}px`);
    state.width = clamped;
    if (persist) localStorage.setItem(STORAGE_WIDTH_KEY, String(clamped));
  };

  const updateToggleButton = () => {
    if (!toggleBtn) return;
    const label = state.overlay
      ? (state.open ? 'إغلاق القائمة' : 'فتح القائمة')
      : (state.collapsed ? 'توسيع القائمة' : 'طي القائمة');
    toggleBtn.setAttribute('aria-label', label);
    toggleBtn.setAttribute('title', label);
    toggleBtn.setAttribute('aria-expanded', state.overlay ? String(state.open) : String(!state.collapsed));
    toggleBtn.setAttribute('aria-controls', 'sidebar');
  };

  const updateAria = () => {
    const isHidden = state.overlay && !state.open;
    sidebar.setAttribute('aria-hidden', isHidden ? 'true' : 'false');
  };

  const applyCollapsed = (collapsed, persist = false) => {
    state.collapsed = collapsed;
    if (!state.overlay) {
      document.body.classList.toggle('sidebar-collapsed', collapsed);
    }
    if (persist) localStorage.setItem(STORAGE_COLLAPSED_KEY, collapsed ? '1' : '0');
    updateToggleButton();
  };

  const applyOverlay = (open) => {
    state.open = open;
    document.body.classList.toggle('sidebar-open', open);
    updateToggleButton();
    updateAria();
  };

  const syncMode = (isOverlay) => {
    state.overlay = isOverlay;
    if (state.overlay) {
      document.body.classList.remove('sidebar-collapsed');
      applyOverlay(false);
    } else {
      document.body.classList.remove('sidebar-open');
      document.body.classList.toggle('sidebar-collapsed', state.collapsed);
      updateAria();
    }
    updateToggleButton();
  };

  applyWidth(state.width);
  syncMode(state.overlay);

  overlayMedia.addEventListener('change', (event) => {
    syncMode(event.matches);
  });

  if (toggleBtn && !toggleBtn.dataset.sidebarLayoutBound) {
    toggleBtn.dataset.sidebarLayoutBound = '1';
    toggleBtn.addEventListener('click', () => {
      if (state.overlay) {
        applyOverlay(!state.open);
      } else {
        applyCollapsed(!state.collapsed, true);
      }
    });
  }

  sidebar.addEventListener('click', (event) => {
    if (!state.overlay || !state.open) return;
    if (event.target.closest('[data-page]')) {
      applyOverlay(false);
    }
  });

  mainContent.addEventListener('click', () => {
    if (state.overlay && state.open) applyOverlay(false);
  });

  if (resizeHandle && !resizeHandle.dataset.bound) {
    resizeHandle.dataset.bound = '1';

    let resizing = false;
    let startX = 0;
    let startWidth = 0;
    let rafId = 0;
    let pendingWidth = null;

    const scheduleWidth = (nextWidth) => {
      pendingWidth = nextWidth;
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        applyWidth(pendingWidth ?? state.width);
        rafId = 0;
      });
    };

    const onPointerMove = (event) => {
      if (!resizing) return;
      const nextWidth = startWidth + (startX - event.clientX);
      scheduleWidth(nextWidth);
    };

    const stopResize = () => {
      if (!resizing) return;
      resizing = false;
      document.body.classList.remove('sidebar-resizing');
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', stopResize);
      window.removeEventListener('pointercancel', stopResize);
      if (pendingWidth !== null) applyWidth(pendingWidth, true);
      pendingWidth = null;
    };

    const onPointerDown = (event) => {
      if (state.overlay) return;
      if (event.button !== 0) return;
      if (event.pointerType && event.pointerType !== 'mouse') return;
      event.preventDefault();

      if (state.collapsed) applyCollapsed(false, true);

      resizing = true;
      startX = event.clientX;
      startWidth = state.width;
      document.body.classList.add('sidebar-resizing');
      resizeHandle.setPointerCapture?.(event.pointerId);

      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', stopResize);
      window.addEventListener('pointercancel', stopResize);
    };

    resizeHandle.addEventListener('pointerdown', onPointerDown);
  }

  window.addEventListener('resize', () => {
    if (state.overlay) return;
    const clamped = clampWidth(state.width);
    if (clamped !== state.width) applyWidth(clamped, true);
    if (activeLink) positionTooltip(activeLink);
  });
}
