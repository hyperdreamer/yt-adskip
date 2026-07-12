/**
 * YT AdSkip - Content Script
 *
 * Auto-clicks YouTube's "Skip Ad" button using CDP (Chrome DevTools Protocol)
 * mouse events. CDP generates isTrusted: true clicks that YouTube accepts.
 * No ad blocking, no video-speed manipulation — just a real click on Skip.
 */

(function () {
  'use strict';

  const DEBUG = false;
  const LOG = DEBUG ? console.log.bind(console, '[YT AdSkip]') : () => {};

  const POLL_INTERVAL_MS = 250;
  const MIN_AD_BEFORE_SKIP_MS = 1000;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  let enabled = true;
  let pollTimer = null;
  let adStartTime = 0;
  let initialized = false;

  // Event listener references for idempotent re-hook on SPA navigation.
  let adStartHandler = null;
  let adFinishHandler = null;
  let hookRetries = 0;
  const MAX_HOOK_RETRIES = 40;

  // ---------------------------------------------------------------------------
  // Ad detection
  // ---------------------------------------------------------------------------

  function getAdState() {
    try {
      const p = document.getElementById('movie_player');
      return p && typeof p.getAdState === 'function' ? p.getAdState() : -1;
    } catch (_) { return -1; }
  }

  function isAdPlaying() {
    if (getAdState() !== -1) return true;
    const player = document.getElementById('movie_player');
    return player && (
      player.classList.contains('ad-showing') ||
      player.classList.contains('ad-interrupting')
    );
  }

  // ---------------------------------------------------------------------------
  // Debug overlay (gated behind storage key "debugOverlay")
  // ---------------------------------------------------------------------------

  let showOverlay = false;
  let overlayEl = null;

  function ensureOverlay() {
    if (overlayEl) return;
    overlayEl = document.createElement('div');
    overlayEl.id = '__yt_adskip_overlay';
    overlayEl.style.cssText = 'position:fixed;top:0;right:0;z-index:999999;background:rgba(0,0,0,0.85);color:#0f0;padding:3px 10px;font:11px monospace;border-radius:0 0 0 6px;pointer-events:none;display:none';
    if (document.body) document.body.appendChild(overlayEl);
  }

  function updateOverlay(text) {
    if (!showOverlay) { if (overlayEl) overlayEl.style.display = 'none'; return; }
    ensureOverlay();
    overlayEl.textContent = 'YT AdSkip: ' + text;
    overlayEl.style.display = '';
  }

  function setDebugOverlay(enabled) {
    showOverlay = !!enabled;
    if (!showOverlay && overlayEl) overlayEl.style.display = 'none';
  }

  // ---------------------------------------------------------------------------
  // CDP click via background script — generates isTrusted: true mouse events
  // ---------------------------------------------------------------------------

  /** Find the skip button and get its viewport-relative center coordinates. */
  function findSkipButton() {
    const btn = document.querySelector('.ytp-ad-skip-button-modern') ||
                document.querySelector('.ytp-ad-skip-button') ||
                document.querySelector('.ytp-skip-ad-button');
    if (!btn || btn.offsetParent === null || btn.disabled) return null;
    const r = btn.getBoundingClientRect();
    return {
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
    };
  }

  /** CDP click — real mouse events via Chrome DevTools Protocol. */
  function tryCdpClick(btn) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: 'adskip:click', x: btn.x, y: btn.y },
          (resp) => resolve(resp && resp.ok === true)
        );
      } catch (_) {
        resolve(false);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------------

  let cdpAttempted = false;

  function trySkipAd() {
    if (!enabled) return;

    if (!isAdPlaying()) {
      adStartTime = 0;
      cdpAttempted = false;
      return;
    }

    if (!adStartTime) {
      adStartTime = Date.now();
      LOG('📺 Ad detected');
      updateOverlay('AD 0.0s');
      bumpStats();
      return;
    }

    const elapsed = Date.now() - adStartTime;
    updateOverlay('AD ' + (elapsed / 1000).toFixed(1) + 's | state=' + getAdState());

    if (elapsed > MIN_AD_BEFORE_SKIP_MS && !cdpAttempted) {
      const btn = findSkipButton();
      if (btn) {
        cdpAttempted = true;
        updateOverlay('🖱 CDP click');
        tryCdpClick(btn).then((ok) => {
          if (ok) LOG('✅ CDP click succeeded');
          else    LOG('❌ CDP click failed');
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // YouTube native events — idempotent, cleans up old listeners on SPA nav
  // ---------------------------------------------------------------------------

  function hookYouTubeEvents() {
    const player = document.getElementById('movie_player');
    if (!player) {
      if (hookRetries++ < MAX_HOOK_RETRIES) {
        setTimeout(hookYouTubeEvents, 500);
      }
      return;
    }
    hookRetries = 0;

    if (adStartHandler) player.removeEventListener('onAdStart', adStartHandler);
    if (adFinishHandler) player.removeEventListener('onAdFinish', adFinishHandler);

    adStartHandler = function () {
      if (!enabled) return;
      adStartTime = Date.now();
      cdpAttempted = false;
    };
    adFinishHandler = function () {
      adStartTime = 0;
      cdpAttempted = false;
    };

    player.addEventListener('onAdStart', adStartHandler);
    player.addEventListener('onAdFinish', adFinishHandler);
  }

  // ---------------------------------------------------------------------------
  // Stats — debounced writes to chrome.storage.local
  // ---------------------------------------------------------------------------

  let pendingSkips = 0;
  let flushTimer = null;

  function flushStats() {
    const toAdd = pendingSkips;
    pendingSkips = 0;
    if (toAdd === 0) return;
    try {
      chrome.storage.local.get(['stats', 'today'], function (data) {
        const prevS = (data && data.stats) || { totalSkips: 0, lastSkipTime: null };
        const stats = {
          totalSkips: (prevS.totalSkips || 0) + toAdd,
          lastSkipTime: Date.now()
        };
        const todayKey = new Date().toISOString().slice(0, 10);
        const prevT = (data && data.today) || { date: todayKey, count: 0 };
        const today = {
          date: todayKey,
          count: (prevT.date === todayKey ? prevT.count : 0) + toAdd
        };
        chrome.storage.local.set({ stats: stats, today: today });
      });
    } catch (e) { console.warn('[YT AdSkip] flushStats error', e); }
  }

  function bumpStats() {
    pendingSkips++;
    if (flushTimer) return;
    flushTimer = setTimeout(function () {
      flushTimer = null;
      flushStats();
    }, 500);
  }

  window.addEventListener('beforeunload', function () {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    flushStats();
  });

  // ---------------------------------------------------------------------------
  // Enable/disable
  // ---------------------------------------------------------------------------

  function enable() {
    enabled = true;
    if (!pollTimer) pollTimer = setInterval(trySkipAd, POLL_INTERVAL_MS);
  }
  function disable() {
    enabled = false;
    adStartTime = 0;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    flushStats();
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // ---------------------------------------------------------------------------
  // Storage listener
  // ---------------------------------------------------------------------------

  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local') return;
      if (changes.enabled) changes.enabled.newValue ? enable() : disable();
      if (changes.debugOverlay) setDebugOverlay(changes.debugOverlay.newValue);
    });
  } catch (e) { console.warn('[YT AdSkip] onChanged error', e); }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  function startAll() {
    if (initialized) return;
    initialized = true;
    hookYouTubeEvents();
    pollTimer = setInterval(trySkipAd, POLL_INTERVAL_MS);

    document.addEventListener('yt-navigate-finish', function () {
      adStartTime = 0;
      cdpAttempted = false;
      hookYouTubeEvents();
    });
  }

  startAll();
  try {
    chrome.storage.local.get(['enabled', 'debugOverlay'], function (data) {
      if (chrome.runtime.lastError) {
        console.warn('[YT AdSkip] init storage read failed', chrome.runtime.lastError);
        return;
      }
      if (data && data.enabled === false) disable();
      if (data && data.debugOverlay) setDebugOverlay(true);
    });
  } catch (e) { console.warn('[YT AdSkip] init error', e); }
})();
