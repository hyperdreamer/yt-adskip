/**
 * YT AdSkip - Content Script (DEBUG BUILD)
 *
 * Unconditional console logging active — open DevTools (F12) on YouTube
 * to see exactly what the extension detects and clicks.
 */

(function () {
  'use strict';

  window.__YT_ADSKIP_LOADED = Date.now();
  const LOG = console.log.bind(console, '[YT AdSkip]');

  const POLL_INTERVAL_MS = 500;
  const DEBOUNCE_MS = 25;
  const POST_CLICK_PAUSE_MS = 100;

  const SKIP_SELECTORS = [
    '.ytp-ad-skip-button-modern',
    '.ytp-ad-skip-button',
    '.ytp-skip-ad-button',
    'button.ytp-ad-skip-button-modern',
    '.ytp-ad-text button',
    'button'
  ];

  const SKIP_TEXT = [
    'skip', 'skip ad', 'skip ads',
    'überspringen', 'saltar', 'pular', 'ignora', 'passer'
  ];

  let enabled = true;
  let observer = null;
  let pollTimer = null;
  let clickedButtons = new WeakSet();
  let foundCount = 0;
  let clickCount = 0;

  LOG('🚀 Content script loaded — YT AdSkip active');

  // ---------------------------------------------------------------------------

  function querySelectorWithText(baseSelector, textStrings) {
    const elements = document.querySelectorAll(baseSelector);
    for (const el of elements) {
      const text = (el.textContent || '').trim().toLowerCase();
      if (!text) continue;
      if (textStrings.some((s) => text.includes(s.toLowerCase()))) {
        return el;
      }
    }
    return null;
  }

  function isValidButton(el) {
    if (!el) return false;
    if (clickedButtons.has(el)) return false;
    if (!document.contains(el)) return false;
    if (el.offsetParent === null) return false;
    if (el.disabled) return false;
    if (el.getAttribute('aria-disabled') === 'true') return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    if (!(el.offsetWidth > 0 && el.offsetHeight > 0)) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden') return false;
    if (cs.opacity === '0') return false;
    if (cs.pointerEvents === 'none') return false;
    if (!el.closest('#movie_player')) return false;
    return true;
  }

  function findSkipButton() {
    for (let i = 0; i < SKIP_SELECTORS.length - 1; i++) {
      const el = document.querySelector(SKIP_SELECTORS[i]);
      if (isValidButton(el)) {
        LOG('✅ Found skip button via selector:', SKIP_SELECTORS[i], el);
        foundCount++;
        return el;
      }
    }
    const textMatch = querySelectorWithText(SKIP_SELECTORS[5], SKIP_TEXT);
    if (isValidButton(textMatch)) {
      LOG('✅ Found skip button via text match:', textMatch);
      foundCount++;
      return textMatch;
    }
    return null;
  }

  function clickSkipButton(button) {
    if (!button) return false;
    if (clickedButtons.has(button)) return false;

    LOG('🖱️ Attempting to click:', button.tagName, button.className, button.textContent?.trim());

    const rect = button.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    const mouseInit = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: cx, clientY: cy, screenX: cx, screenY: cy,
      button: 0, buttons: 1
    };
    const pointerInit = Object.assign({}, mouseInit, {
      pointerType: 'mouse', pointerId: 1, isPrimary: true,
      width: 1, height: 1, pressure: 0.5
    });

    button.focus();
    button.dispatchEvent(new PointerEvent('pointerdown', pointerInit));
    button.dispatchEvent(new MouseEvent('mousedown', mouseInit));
    button.dispatchEvent(new PointerEvent('pointerup', pointerInit));
    button.dispatchEvent(new MouseEvent('mouseup', mouseInit));
    button.dispatchEvent(new MouseEvent('click', mouseInit));

    // Try every known YouTube ad-skip mechanism
    const player = document.getElementById('movie_player');
    if (player) {
      // Method 1: Direct internal handler
      try { if (typeof player.onAdUxClicked === 'function') player.onAdUxClicked(); } catch (_) {}
      // Method 2: Call with button context
      try { if (typeof player.onAdUxClicked === 'function') player.onAdUxClicked.call(button); } catch (_) {}
      // Method 3: Try cancelAd
      try { if (typeof player.cancelAd === 'function') player.cancelAd(); } catch (_) {}
      // Method 4: Try skipAd
      try { if (typeof player.skipAd === 'function') player.skipAd(); } catch (_) {}
      // Method 5: Access ad manager directly
      try {
        const adMgr = player.adManager || player.adManager_ || player.getAdManager?.();
        if (adMgr && typeof adMgr.skip === 'function') { adMgr.skip(); LOG('🔧 adManager.skip() called'); }
        if (adMgr && typeof adMgr.skipAd === 'function') { adMgr.skipAd(); LOG('🔧 adManager.skipAd() called'); }
      } catch (_) {}
      // Method 6: Try to find any skip method on the button itself
      try {
        for (const key of Object.keys(button)) {
          if (key.toLowerCase().includes('skip') && typeof button[key] === 'function') {
            button[key]();
            LOG('🔧 button.' + key + '() called');
          }
        }
      } catch (_) {}
    }

    clickedButtons.add(button);
    clickCount++;
    updateBanner('CLICKED ' + (button.textContent?.trim() || button.className) + ' | state=' + getAdStateStr());
    return true;
  }

  function getAdStateStr() {
    try {
      const p = document.getElementById('movie_player');
      return p && typeof p.getAdState === 'function' ? p.getAdState() : '?';
    } catch (_) { return 'err'; }
  }

  function findAndClickSkipButton() {
    if (!enabled) return;
    const button = findSkipButton();
    if (button) {
      if (clickSkipButton(button)) {
        if (observer) { observer.disconnect(); observer = null; }
        setTimeout(() => { if (enabled && !observer) startObserver(); }, 100);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Observer

  function startObserver() {
    if (observer || !document.body) return;
    observer = new MutationObserver((mutations) => {
      if (!enabled) return;
      // Quick check
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.matches && node.matches('.ytp-ad-skip-button,.ytp-ad-skip-button-modern,.ytp-skip-ad-button,.ytp-ad-text')) {
            LOG('🔍 Observer: matched added node directly');
            findAndClickSkipButton();
            return;
          }
          if (node.querySelector && node.querySelector('.ytp-ad-skip-button,.ytp-ad-skip-button-modern,.ytp-skip-ad-button,.ytp-ad-text')) {
            LOG('🔍 Observer: matched descendant');
            findAndClickSkipButton();
            return;
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    LOG('👁️ Observer started on document.body');
  }

  // ---------------------------------------------------------------------------
  // Polling

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      if (!enabled) return;
      findAndClickSkipButton();
    }, POLL_INTERVAL_MS);
    LOG('⏱️ Polling started (', POLL_INTERVAL_MS, 'ms)');
  }

  // ---------------------------------------------------------------------------
  // SPA navigation

  document.addEventListener('yt-navigate-finish', () => {
    LOG('🧭 Navigation: yt-navigate-finish');
    findAndClickSkipButton();
  });
  document.addEventListener('yt-page-data-updated', () => {
    LOG('🧭 Navigation: yt-page-data-updated');
    findAndClickSkipButton();
  });

  // ---------------------------------------------------------------------------
  // Init — run immediately, no storage dependency
  // ---------------------------------------------------------------------------

  LOG('🎬 Init — player exists:', !!document.getElementById('movie_player'),
      'classes:', document.getElementById('movie_player')?.className?.substring(0, 100));

  startObserver();
  startPolling();
  findAndClickSkipButton();

  // Expose for CDP testing
  window.__YT_ADSKIP_CHECK__ = findAndClickSkipButton;

  // Create a visible debug banner on the page
  const banner = document.createElement('div');
  banner.id = '__yt_adskip_banner';
  banner.style.cssText = 'position:fixed;top:0;right:0;z-index:999999;background:#000;color:#0f0;padding:4px 12px;font:12px monospace;border-radius:0 0 0 8px;opacity:0.85;pointer-events:none';
  banner.textContent = 'YT AdSkip: waiting';
  document.body?.appendChild(banner);

  function updateBanner(text) {
    const b = document.getElementById('__yt_adskip_banner');
    if (b) b.textContent = 'YT AdSkip: ' + text;
  }

  // Override click to show on banner
  const _origClick = clickSkipButton;
  clickSkipButton = function(btn) {
    updateBanner('CLICKED ' + (btn.textContent?.trim() || btn.className));
    return _origClick(btn);
  };

  // Override find to show on banner
  const _origFind = findSkipButton;
  findSkipButton = function() {
    const btn = _origFind();
    if (btn) updateBanner('FOUND: ' + (btn.className || 'text-match'));
    return btn;
  };

  LOG('✅ YT AdSkip ready — watching for skip buttons');
})();
