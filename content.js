/**
 * YT AdSkip - Content Script
 *
 * Automatically clicks YouTube's "Skip Ad" button as soon as it appears.
 * - Does NOT block, hide, fast-forward, or mute ads.
 * - Detection: MutationObserver on body (childList) + MutationObserver on
 *   #movie_player (class changes for ad-showing/ad-interrupting) + polling fallback.
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

  const POLL_INTERVAL_MS = 1000;     // Polling fallback cadence
  const DEBOUNCE_MS = 25;            // MutationObserver debounce
  const POST_CLICK_PAUSE_MS = 100;   // Brief observer pause after a click

  // Selector chain, priority order (AGENTS.md §4.1).
  const SKIP_SELECTORS = [
    '.ytp-ad-skip-button-modern',               // 1. Current
    '.ytp-ad-skip-button',                      // 2. Stable fallback
    '.ytp-skip-ad-button',                      // 3. Legacy
    'button.ytp-ad-skip-button-modern',         // 4. Tag-qualified
    '.ytp-ad-text button',                      // 5. Text-context
    'button'                                    // 6. base for text-match fallback
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
  let bodyObserver = null;
  let playerObserver = null;
  let pollTimer = null;
  let debounceTimer = null;
  let resumeTimer = null;
  let initialized = false;

  // Per-button-instance click tracking (§4.4).
  const clickedButtons = new WeakSet();

  // ---------------------------------------------------------------------------
  // Logging helpers
  // ---------------------------------------------------------------------------

  function log(...args) {
    if (DEBUG) console.log('[YT AdSkip]', ...args);
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
  // Button validation (§4.2)
  // ---------------------------------------------------------------------------

  function isValidButton(el) {
    if (!el) return false;
    if (clickedButtons.has(el)) return false;
    if (!document.contains(el)) return false;
    if (el.offsetParent === null) return false;            // display:none or not rendered
    if (el.disabled) return false;                          // native disabled
    if (el.getAttribute('aria-disabled') === 'true') return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    if (!(el.offsetWidth > 0 && el.offsetHeight > 0)) return false;
    // Check if button is inside the ad player overlay (not a random "Skip" elsewhere)
    const inPlayer = el.closest('#movie_player');
    if (!inPlayer) return false;
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
        pauseObserversBriefly();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // MutationObserver — body (childList) (§4.5, §4.6)
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

  function onBodyMutation(mutations) {
    if (!enabled) return;
    if (!mutationContainsAdElement(mutations)) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      findAndClickSkipButton();
    }, DEBOUNCE_MS);
  }

  function startBodyObserver() {
    if (bodyObserver || !document.body) return;
    bodyObserver = new MutationObserver(onBodyMutation);
    bodyObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: false,
      characterData: false
    });
    log('body MutationObserver started');
  }

  function stopBodyObserver() {
    if (bodyObserver) {
      bodyObserver.disconnect();
      bodyObserver = null;
      log('body MutationObserver stopped');
    }
  }

  // ---------------------------------------------------------------------------
  // MutationObserver — #movie_player (class/attribute changes)
  // YouTube toggles ad-showing / ad-interrupting classes on #movie_player
  // to indicate ad playback. Watching these catches ads that were pre-loaded
  // in the DOM and revealed via class changes (missed by childList observer).
  // ---------------------------------------------------------------------------

  function onPlayerMutation(mutations) {
    if (!enabled) return;
    for (const mutation of mutations) {
      if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
        const player = mutation.target;
        if (player.classList.contains('ad-showing') ||
            player.classList.contains('ad-interrupting')) {
          log('player entered ad state, scanning for skip button');
          findAndClickSkipButton();
        }
        break; // One class change is enough
      }
    }
  }

  function startPlayerObserver() {
    if (playerObserver) return;
    const player = document.getElementById('movie_player');
    if (!player) {
      // Player not yet in DOM — body observer will catch it
      return;
    }
    playerObserver = new MutationObserver(onPlayerMutation);
    playerObserver.observe(player, {
      attributes: true,
      attributeFilter: ['class']
    });
    log('player MutationObserver started on #movie_player');
  }

  function stopPlayerObserver() {
    if (playerObserver) {
      playerObserver.disconnect();
      playerObserver = null;
      log('player MutationObserver stopped');
    }
  }

  // Try to start the player observer — if the player isn't ready yet,
  // the body observer's childList will catch it, and we retry on next check.
  function ensurePlayerObserver() {
    if (!playerObserver) startPlayerObserver();
  }

  // ---------------------------------------------------------------------------
  // Pause / resume observers
  // ---------------------------------------------------------------------------

  function pauseObserversBriefly() {
    stopBodyObserver();
    stopPlayerObserver();
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => {
      if (enabled) {
        startBodyObserver();
        startPlayerObserver();
      }
    }, POST_CLICK_PAUSE_MS);
  }

  // ---------------------------------------------------------------------------
  // Polling fallback (§4.7)
  // ---------------------------------------------------------------------------

  function startPolling() {
    if (pollTimer !== null) return;
    pollTimer = setInterval(() => {
      if (!enabled) return;
      ensurePlayerObserver(); // retry if player wasn't ready at init
      findAndClickSkipButton();
    }, POLL_INTERVAL_MS);
    log('polling started (', POLL_INTERVAL_MS, 'ms)');
  }

  function stopPolling() {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
      log('polling stopped');
    }
  }

  // ---------------------------------------------------------------------------
  // SPA navigation handling (§4.8)
  // ---------------------------------------------------------------------------

  function registerNavigationListeners() {
    document.addEventListener('yt-navigate-finish', () => {
      log('yt-navigate-finish');
      if (enabled) {
        ensurePlayerObserver();
        findAndClickSkipButton();
      }
    });
    document.addEventListener('yt-page-data-updated', () => {
      log('yt-page-data-updated');
      if (enabled) {
        ensurePlayerObserver();
        findAndClickSkipButton();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Enable / disable lifecycle (§5)
  // ---------------------------------------------------------------------------

  function enable() {
    if (enabled) return;
    enabled = true;
    startBodyObserver();
    startPlayerObserver();
    startPolling();
    findAndClickSkipButton();
  }

  function disable() {
    enabled = false;
    stopBodyObserver();
    stopPlayerObserver();
    stopPolling();
    clearTimeout(debounceTimer);
    clearTimeout(resumeTimer);
  }

  // ---------------------------------------------------------------------------
  // Stats (§5)
  // ---------------------------------------------------------------------------

  function bumpStats() {
    try {
      chrome.storage.local.get(['stats', 'today'], (data) => {
        const prevStats = (data && data.stats) || { totalSkips: 0, lastSkipTime: null };
        const stats = {
          totalSkips: (prevStats.totalSkips || 0) + 1,
          lastSkipTime: Date.now()
        };

        // Also increment today's count, handling date rollover.
        const todayKey = new Date().toISOString().slice(0, 10);
        const prevToday = (data && data.today) || { date: todayKey, count: 0 };
        const today = {
          date: todayKey,
          count: (prevToday.date === todayKey ? prevToday.count : 0) + 1
        };

        chrome.storage.local.set({ stats, today });
      });
    } catch (err) {
      log('stats write failed', err);
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
  // Initialization (§4.10)
  // ---------------------------------------------------------------------------

  function initObservers() {
    if (initialized) return;
    initialized = true;
    startBodyObserver();
    startPlayerObserver();
    startPolling();
    registerNavigationListeners();
    registerStorageListener();

    // Immediate check — if an ad is already showing.
    const player = document.getElementById('movie_player');
    if (player && (player.classList.contains('ad-showing') ||
                   player.classList.contains('ad-interrupting'))) {
      findAndClickSkipButton();
    }
  }

  function init() {
    // Start observers IMMEDIATELY (synchronous) — don't wait for storage read.
    // Default to enabled; storage listener will correct if user had disabled.
    initObservers();

    // Read persisted enabled state asynchronously to correct if needed.
    try {
      chrome.storage.local.get(['enabled'], (data) => {
        if (data && data.enabled === false) {
          disable();
        }
      });
    } catch (err) {
      log('storage read failed, staying enabled', err);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
