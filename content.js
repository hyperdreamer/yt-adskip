/**
 * YT AdSkip - Content Script
 *
 * Automatically clicks YouTube's "Skip Ad" button as soon as it appears.
 * - Does NOT block, hide, fast-forward, or mute ads.
 * - Detection: MutationObserver (primary) + setInterval polling (fallback).
 * - SPA-aware: survives YouTube's history-based navigation.
 *
 * Spec: see AGENTS.md §4.
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  const DEBUG = false; // Set to true for verbose console logging

  const POLL_INTERVAL_MS = 2000;     // Polling fallback cadence
  const DEBOUNCE_MS = 25;           // MutationObserver debounce
  const POST_CLICK_PAUSE_MS = 100;  // Brief observer pause after a click

  // Selector chain, priority order (AGENTS.md §4.1).
  const SKIP_SELECTORS = [
    '.ytp-ad-skip-button-modern',               // 1. Current (2025-2026)
    '.ytp-ad-skip-button',                      // 2. Stable fallback
    '.ytp-skip-ad-button',                      // 3. Legacy
    'button.ytp-ad-skip-button-modern',         // 4. Tag-qualified
    '.ytp-ad-text button',                      // 5. Text-context
    'button'                                    // 6. base for text-match fallback (§4.3)
  ];

  // Quick-check selectors for mutation filtering (§4.6).
  const QUICK_CHECK_SELECTORS = [
    '.ytp-ad-skip-button',
    '.ytp-ad-skip-button-modern',
    '.ytp-skip-ad-button',
    '.ytp-ad-text',
    '.ytp-ad-preview-text'
  ].join(', ');

  // Text fragments to match a "skip" button (§4.3).
  const SKIP_TEXT_FRAGMENTS = ['skip', 'skip ad', 'skip ads'];

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  let enabled = true;
  let observer = null;
  let pollTimer = null;
  let debounceTimer = null;
  let resumeTimer = null;

  // Per-button-instance click tracking (§4.4). WeakSet avoids memory leaks
  // when YouTube removes old button nodes from the DOM.
  const clickedButtons = new WeakSet();

  // ---------------------------------------------------------------------------
  // Logging helpers
  // ---------------------------------------------------------------------------

  function log(...args) {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log('[YT AdSkip]', ...args);
    }
  }

  // ---------------------------------------------------------------------------
  // Selector helpers
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

  // ---------------------------------------------------------------------------
  // Button validation (AGENTS.md §4.2)
  // ---------------------------------------------------------------------------

  function isValidButton(el) {
    if (!el) return false;
    if (clickedButtons.has(el)) return false;
    if (!document.contains(el)) return false;
    if (el.offsetParent === null) return false;            // hidden via display/visibility
    if (el.disabled) return false;                          // native disabled
    if (el.getAttribute('aria-disabled') === 'true') return false;
    if (!(el.offsetWidth > 0 && el.offsetHeight > 0)) return false; // zero-size hidden
    return true;
  }

  // ---------------------------------------------------------------------------
  // Core: find and click the skip button
  // ---------------------------------------------------------------------------

  function findSkipButton() {
    // Selectors 1-5: direct class/tag matches.
    for (let i = 0; i < SKIP_SELECTORS.length - 1; i++) {
      const el = document.querySelector(SKIP_SELECTORS[i]);
      if (isValidButton(el)) {
        log('matched selector', i + 1, SKIP_SELECTORS[i]);
        return el;
      }
    }
    // Selector 6: text-match fallback (§4.3).
    const textMatch = querySelectorWithText(SKIP_SELECTORS[5], SKIP_TEXT_FRAGMENTS);
    if (isValidButton(textMatch)) {
      log('matched via text-content fallback');
      return textMatch;
    }
    return null;
  }

  function clickSkipButton(button) {
    if (!button) return false;
    if (clickedButtons.has(button)) return false;
    try {
      button.click();
      clickedButtons.add(button);
      log('clicked skip button', button);
      bumpStats();
      return true;
    } catch (err) {
      log('click failed', err);
      return false;
    }
  }

  function findAndClickSkipButton() {
    if (!enabled) return;
    const button = findSkipButton();
    if (button) {
      const clicked = clickSkipButton(button);
      if (clicked) {
        // Brief pause to avoid re-triggering on post-click DOM churn (§4.4).
        pauseObserverBriefly();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // MutationObserver (AGENTS.md §4.5, §4.6)
  // ---------------------------------------------------------------------------

  function mutationContainsAdElement(mutations) {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (typeof node.matches === 'function' &&
            node.matches(QUICK_CHECK_SELECTORS)) {
          return true;
        }
        if (typeof node.querySelector === 'function' &&
            node.querySelector(QUICK_CHECK_SELECTORS)) {
          return true;
        }
      }
    }
    return false;
  }

  function onMutation(mutations) {
    if (!enabled) return;
    if (!mutationContainsAdElement(mutations)) return; // §4.6 quick-check
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      findAndClickSkipButton();
    }, DEBOUNCE_MS);
  }

  function startObserver() {
    if (observer || !document.body) return;
    observer = new MutationObserver(onMutation);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: false,
      characterData: false
    });
    log('MutationObserver started');
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
      log('MutationObserver stopped');
    }
  }

  function pauseObserverBriefly() {
    stopObserver();
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => {
      if (enabled) startObserver();
    }, POST_CLICK_PAUSE_MS);
  }

  // ---------------------------------------------------------------------------
  // Polling fallback (AGENTS.md §4.7)
  // ---------------------------------------------------------------------------

  function startPolling() {
    if (pollTimer !== null) return;
    pollTimer = setInterval(() => {
      if (!enabled) return;
      findAndClickSkipButton();
    }, POLL_INTERVAL_MS);
    log('polling started (', POLL_INTERVAL_MS, 'ms )');
  }

  function stopPolling() {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
      log('polling stopped');
    }
  }

  // ---------------------------------------------------------------------------
  // SPA navigation handling (AGENTS.md §4.8)
  // ---------------------------------------------------------------------------

  function registerNavigationListeners() {
    document.addEventListener('yt-navigate-finish', () => {
      log('yt-navigate-finish');
      if (enabled) findAndClickSkipButton();
    });
    document.addEventListener('yt-page-data-updated', () => {
      log('yt-page-data-updated');
      if (enabled) findAndClickSkipButton();
    });
  }

  // ---------------------------------------------------------------------------
  // Enable / disable lifecycle (AGENTS.md §5)
  // ---------------------------------------------------------------------------

  function enable() {
    if (enabled) return;
    enabled = true;
    startObserver();
    startPolling();
    findAndClickSkipButton();
  }

  function disable() {
    enabled = false;
    stopObserver();
    stopPolling();
    clearTimeout(debounceTimer);
    clearTimeout(resumeTimer);
  }

  // ---------------------------------------------------------------------------
  // Stats (AGENTS.md §5)
  // ---------------------------------------------------------------------------

  function bumpStats() {
    try {
      chrome.storage.local.get(['stats'], (data) => {
        const prev = (data && data.stats) || { totalSkips: 0, lastSkipTime: null };
        const stats = {
          totalSkips: (prev.totalSkips || 0) + 1,
          lastSkipTime: Date.now()
        };
        chrome.storage.local.set({ stats });
      });
    } catch (err) {
      // storage may be unavailable in some contexts; ignore silently.
      log('stats write failed', err);
    }
  }

  function ensureTodayStats(callback) {
    try {
      chrome.storage.local.get(['stats', 'today'], (data) => {
        const todayKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
        const today = (data && data.today) || { date: todayKey, count: 0 };
        if (today.date !== todayKey) {
          // Roll over to a new day.
          const fresh = { date: todayKey, count: 0 };
          chrome.storage.local.set({ today: fresh });
        }
        if (typeof callback === 'function') callback();
      });
    } catch (err) {
      log('today stats init failed', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Storage change subscription
  // ---------------------------------------------------------------------------

  function registerStorageListener() {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.enabled) return;
        const next = changes.enabled.newValue;
        if (next) enable();
        else disable();
      });
    } catch (err) {
      log('storage listener failed', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Initialization (AGENTS.md §4.10)
  // ---------------------------------------------------------------------------

  function init() {
    // 1. Read enabled state; default to true.
    try {
      chrome.storage.local.get(['enabled'], (data) => {
        const isEnabled = data && typeof data.enabled === 'boolean' ? data.enabled : true;
        enabled = isEnabled;
        if (enabled) {
          startObserver();
          startPolling();
        }
        registerNavigationListeners();
        registerStorageListener();
        // 3d. immediate run, but only if enabled and a player exists.
        const player = document.getElementById('movie_player');
        const inAd = player && (
          player.classList.contains('ad-showing') ||
          player.classList.contains('ad-interrupting')
        );
        if (enabled && (inAd || player)) {
          findAndClickSkipButton();
        }
        ensureTodayStats();
      });
    } catch (err) {
      // Fallback: behave as if enabled.
      log('init storage read failed, defaulting to enabled', err);
      enabled = true;
      startObserver();
      startPolling();
      registerNavigationListeners();
      registerStorageListener();
      findAndClickSkipButton();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
