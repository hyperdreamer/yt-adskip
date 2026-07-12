/**
 * YT AdSkip - Content Script
 *
 * Auto-clicks YouTube's "Skip Ad" button using CDP (Chrome DevTools Protocol)
 * mouse events. CDP generates isTrusted: true clicks that YouTube accepts.
 * No ad blocking, no video-speed manipulation — just a real click on Skip.
 */

(function () {
  'use strict';

  const POLL_INTERVAL_MS = 250;
  const MIN_AD_BEFORE_SKIP_MS = 1000;

  // ---------------------------------------------------------------------------
  // Diagnostics — enable debugOverlay in popup or set DEBUG=true for console
  // ---------------------------------------------------------------------------

  const DEBUG = true;
  const LOG = console.log.bind(console, '[YT AdSkip]');
  const WARN = console.warn.bind(console, '[YT AdSkip]');

  LOG('content script loaded on', location.href);

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  let enabled = true;
  let pollTimer = null;
  let adStartTime = 0;
  let initialized = false;
  let skippedAds = 0; // track this session

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
    LOG('debugOverlay', showOverlay ? 'ON' : 'OFF');
    if (!showOverlay && overlayEl) overlayEl.style.display = 'none';
  }

  // ---------------------------------------------------------------------------
  // CDP click via background script
  // ---------------------------------------------------------------------------

  function findSkipButton() {
    // Try known selectors
    const selectors = [
      '.ytp-ad-skip-button-modern',
      '.ytp-ad-skip-button',
      '.ytp-skip-ad-button',
      '.ytp-ad-skip-button-container .ytp-ad-skip-button',
      'button[aria-label*="Skip"]',
    ];
    for (const sel of selectors) {
      try {
        const btn = document.querySelector(sel);
        if (btn && btn.offsetParent !== null && !btn.disabled) {
          const r = btn.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            return {
              x: Math.round(r.left + r.width / 2),
              y: Math.round(r.top + r.height / 2),
            };
          }
        }
      } catch (_) {}
    }
    return null;
  }

  function tryCdpClick(btn) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: 'adskip:click', x: btn.x, y: btn.y },
          (resp) => {
            if (chrome.runtime.lastError) {
              WARN('CDP sendMessage error:', chrome.runtime.lastError.message);
              resolve(false);
            } else {
              resolve(resp && resp.ok === true);
            }
          }
        );
      } catch (e) {
        WARN('CDP sendMessage exception:', e.message);
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

    const adPlaying = isAdPlaying();
    if (!adPlaying) {
      if (adStartTime) LOG('ad ended');
      adStartTime = 0;
      cdpAttempted = false;
      return;
    }

    if (!adStartTime) {
      adStartTime = Date.now();
      skippedAds++;
      LOG('📺 Ad #' + skippedAds + ' detected');
      updateOverlay('AD #' + skippedAds + ' 0.0s');
      bumpStats();
      return;
    }

    const elapsed = Date.now() - adStartTime;
    updateOverlay('AD #' + skippedAds + ' ' + (elapsed / 1000).toFixed(1) + 's');

    if (elapsed < MIN_AD_BEFORE_SKIP_MS) return;

    if (cdpAttempted) {
      // Still waiting — log status periodically
      if (elapsed % 1000 < POLL_INTERVAL_MS) {
        LOG('⏳ CDP attempted, waiting... elapsed=' + (elapsed / 1000).toFixed(1) + 's');
      }
      return;
    }

    const btn = findSkipButton();
    if (btn) {
      cdpAttempted = true;
      LOG('🖱 Skip button found at (' + btn.x + ', ' + btn.y + '), dispatching CDP click');
      updateOverlay('🖱 CDP click');
      tryCdpClick(btn).then((ok) => {
        if (ok) {
          LOG('✅ CDP click SUCCEEDED');
          updateOverlay('✅ skipped');
        } else {
          WARN('❌ CDP click FAILED');
          updateOverlay('❌ CDP failed');
        }
      });
    } else {
      // No skip button yet — this is normal for pre-skip-countdown phase
      // Log every 2s so we know we're still polling
      if (elapsed % 2000 < POLL_INTERVAL_MS) {
        LOG('🔍 polling for skip button... elapsed=' + (elapsed / 1000).toFixed(1) + 's');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // YouTube native events
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
    LOG('🎬 movie_player hooked');

    if (adStartHandler) player.removeEventListener('onAdStart', adStartHandler);
    if (adFinishHandler) player.removeEventListener('onAdFinish', adFinishHandler);

    adStartHandler = function () {
      if (!enabled) return;
      adStartTime = Date.now();
      cdpAttempted = false;
      LOG('🎬 onAdStart fired');
    };
    adFinishHandler = function () {
      LOG('🎬 onAdFinish fired');
      adStartTime = 0;
      cdpAttempted = false;
    };

    player.addEventListener('onAdStart', adStartHandler);
    player.addEventListener('onAdFinish', adFinishHandler);
  }

  // ---------------------------------------------------------------------------
  // Stats
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
    } catch (e) { WARN('flushStats error', e); }
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
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    flushStats();
  });

  // ---------------------------------------------------------------------------
  // Enable/disable
  // ---------------------------------------------------------------------------

  function enable() {
    enabled = true;
    LOG('✅ enabled');
    if (!pollTimer) pollTimer = setInterval(trySkipAd, POLL_INTERVAL_MS);
  }
  function disable() {
    enabled = false;
    LOG('⏸ disabled');
    adStartTime = 0;
    cdpAttempted = false;
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
  } catch (e) { WARN('onChanged error', e); }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  function startAll() {
    if (initialized) return;
    initialized = true;
    LOG('▶ startAll — hooking events, starting poll');
    hookYouTubeEvents();
    pollTimer = setInterval(trySkipAd, POLL_INTERVAL_MS);

    document.addEventListener('yt-navigate-finish', function () {
      LOG('🔄 yt-navigate-finish');
      adStartTime = 0;
      cdpAttempted = false;
      hookYouTubeEvents();
    });
  }

  startAll();
  try {
    chrome.storage.local.get(['enabled', 'debugOverlay'], function (data) {
      if (chrome.runtime.lastError) {
        WARN('init storage read failed', chrome.runtime.lastError);
        return;
      }
      LOG('storage init: enabled=' + (data && data.enabled) + ' debugOverlay=' + (data && data.debugOverlay));
      if (data && data.enabled === false) disable();
      if (data && data.debugOverlay) setDebugOverlay(true);
    });
  } catch (e) { WARN('init error', e); }
})();
