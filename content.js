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

  const DEBUG = false;

  const POLL_INTERVAL_MS = 1000;
  const DEBOUNCE_MS = 25;
  const POST_CLICK_PAUSE_MS = 100;

  // Selector chain, priority order (AGENTS.md §4.1).
  const SKIP_SELECTORS = [
    '.ytp-ad-skip-button-modern',
    '.ytp-ad-skip-button',
    '.ytp-skip-ad-button',
    'button.ytp-ad-skip-button-modern',
    '.ytp-ad-text button',
    'button'   // base for text-match fallback
  ];

  // Quick-check selectors for mutation filtering (§4.6).
  const QUICK_CHECK_SELECTORS = [
    '.ytp-ad-skip-button',
    '.ytp-ad-skip-button-modern',
    '.ytp-skip-ad-button',
    '.ytp-ad-text',
    '.ytp-ad-preview-text'
  ].join(', ');

  // Text fragments for text-match fallback (§4.3).
  // English + common YouTube localizations.
  const SKIP_TEXT_FRAGMENTS = [
    'skip', 'skip ad', 'skip ads',        // English
    'überspringen', 'überspringen anzeige', // German
    'saltar', 'saltar anuncio',            // Spanish
    'pular', 'pular anúncio',              // Portuguese
    'ignora', 'ignora annuncio',           // Italian
    'passer', 'passer annonce',            // French
    ' überslaan',                           // Dutch
    ' пропустить',                          // Russian
    ' スキップ',                             // Japanese
  ];

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

  // In-memory accumulator to avoid read-modify-write races on stats.
  // Flushed to storage on a debounced timer.
  let pendingSkipIncrement = 0;
  let flushStatsTimer = null;
  const STATS_FLUSH_MS = 500;

  const clickedButtons = new WeakSet();

  // ---------------------------------------------------------------------------
  // Logging
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
  // Ad-state helper
  // ---------------------------------------------------------------------------

  function isAdPlaying() {
    const player = document.getElementById('movie_player');
    return player && (
      player.classList.contains('ad-showing') ||
      player.classList.contains('ad-interrupting')
    );
  }

  // ---------------------------------------------------------------------------
  // Button validation (§4.2)
  // ---------------------------------------------------------------------------

  function isValidButton(el) {
    if (!el) return false;
    if (clickedButtons.has(el)) return false;
    if (!document.contains(el)) return false;
    if (el.offsetParent === null) return false;
    if (el.disabled) return false;
    if (el.getAttribute('aria-disabled') === 'true') return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    if (!(el.offsetWidth > 0 && el.offsetHeight > 0)) return false;
    // Must be inside the player, not a random "Skip" elsewhere.
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
      log('clicked skip button');
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
      if (clickSkipButton(button)) {
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
    debounceTimer = setTimeout(findAndClickSkipButton, DEBOUNCE_MS);
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
    log('body observer started');
  }

  function stopBodyObserver() {
    if (bodyObserver) {
      bodyObserver.disconnect();
      bodyObserver = null;
    }
  }

  // ---------------------------------------------------------------------------
  // MutationObserver — #movie_player (class changes)
  // ---------------------------------------------------------------------------

  function onPlayerMutation(mutations) {
    if (!enabled) return;
    for (const mutation of mutations) {
      if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
        const player = mutation.target;
        if (player.classList.contains('ad-showing') ||
            player.classList.contains('ad-interrupting')) {
          log('player entered ad state');
          findAndClickSkipButton();
          break; // Found the ad state — done with this batch
        }
        // Don't break here — keep checking remaining mutation records
      }
    }
  }

  function startPlayerObserver() {
    const player = document.getElementById('movie_player');
    if (!player) return;

    // If we already have an observer on this element, skip.
    // If the observed element changed (SPA navigation recreates #movie_player),
    // disconnect the old one and create a fresh observer.
    if (playerObserver) {
      // Check if current player is different from the observed one.
      // MutationObserver doesn't expose its target, so we disconnect
      // and reconnect unconditionally — it's cheap.
      playerObserver.disconnect();
      playerObserver = null;
    }

    playerObserver = new MutationObserver(onPlayerMutation);
    playerObserver.observe(player, {
      attributes: true,
      attributeFilter: ['class']
    });
    log('player observer started on #movie_player');
  }

  function stopPlayerObserver() {
    if (playerObserver) {
      playerObserver.disconnect();
      playerObserver = null;
    }
  }

  function ensurePlayerObserver() {
    startPlayerObserver();
  }

  // ---------------------------------------------------------------------------
  // Pause / resume
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
      findAndClickSkipButton();
    }, POLL_INTERVAL_MS);
    log('polling started (', POLL_INTERVAL_MS, 'ms)');
  }

  function stopPolling() {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
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
    clearTimeout(flushStatsTimer);
    pendingSkipIncrement = 0;
  }

  // ---------------------------------------------------------------------------
  // Stats (§5) — in-memory accumulator to avoid read-modify-write races
  // ---------------------------------------------------------------------------

  function bumpStats() {
    pendingSkipIncrement++;
    if (flushStatsTimer) return; // already scheduled
    flushStatsTimer = setTimeout(flushStats, STATS_FLUSH_MS);
  }

  function flushStats() {
    flushStatsTimer = null;
    const toAdd = pendingSkipIncrement;
    pendingSkipIncrement = 0;
    if (toAdd === 0) return;

    try {
      chrome.storage.local.get(['stats', 'today'], (data) => {
        const prevStats = (data && data.stats) || { totalSkips: 0, lastSkipTime: null };
        const stats = {
          totalSkips: (prevStats.totalSkips || 0) + toAdd,
          lastSkipTime: Date.now()
        };

        const todayKey = new Date().toISOString().slice(0, 10);
        const prevToday = (data && data.today) || { date: todayKey, count: 0 };
        const today = {
          date: todayKey,
          count: (prevToday.date === todayKey ? prevToday.count : 0) + toAdd
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
        if (changes.enabled.newValue) enable();
        else disable();
      });
    } catch (err) {
      log('storage listener failed', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Initialization (§4.10)
  // ---------------------------------------------------------------------------

  function startAll() {
    if (initialized) return;
    initialized = true;
    startBodyObserver();
    startPlayerObserver();
    startPolling();
    registerNavigationListeners();
    registerStorageListener();

    if (isAdPlaying()) {
      findAndClickSkipButton();
    }
  }

  function init() {
    // Start observers IMMEDIATELY — don't wait for async storage.
    // The callback corrects state if user had previously disabled.
    startAll();

    // Check persisted state to possibly disable.
    try {
      const storageTimeout = setTimeout(() => {
        // Callback didn't fire — stay enabled (safe default).
        log('storage read timed out, staying enabled');
      }, 3000);

      chrome.storage.local.get(['enabled'], (data) => {
        clearTimeout(storageTimeout);
        if (data && data.enabled === false) {
          disable();
        }
      });
    } catch (err) {
      log('storage read failed, staying enabled', err);
    }
  }

  init();
})();
