/**
 * YT AdSkip - Content Script
 *
 * Skips YouTube ads by speeding through them (playbackRate + seek).
 * YouTube rejects synthetic click events (isTrusted check), so we
 * bypass the DOM event system entirely via video manipulation.
 */

(function () {
  'use strict';

  const DEBUG = false;
  const LOG = DEBUG ? console.log.bind(console, '[YT AdSkip]') : () => {};

  const POLL_INTERVAL_MS = 250;
  const MIN_AD_BEFORE_SKIP_MS = 1000;
  const PLAYBACK_SPEED = 16;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  let enabled = true;
  let pollTimer = null;
  let adStartTime = 0;
  let originalPlaybackRate = 1;
  let wasMuted = false;
  let initialized = false;

  // Event listener references for idempotent re-hook on SPA navigation.
  let adStartHandler = null;
  let adFinishHandler = null;
  let hookRetries = 0;
  const MAX_HOOK_RETRIES = 40; // ~20 s max wait for #movie_player

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
  // Skip strategy: speed through ad
  // ---------------------------------------------------------------------------

  function skipAd() {
    const video = document.querySelector('video');
    if (!video || !isFinite(video.duration)) return false;

    if (video.playbackRate !== PLAYBACK_SPEED) {
      originalPlaybackRate = video.playbackRate || 1;
      wasMuted = video.muted;
      video.muted = true;
      video.playbackRate = PLAYBACK_SPEED;
      LOG('⏩ Speed 16x');
      return true;
    }

    // Also seek near end
    const target = Math.max(0, video.duration - 0.5);
    if (target > video.currentTime + 0.5) {
      video.currentTime = target;
      return true;
    }
    return false;
  }

  function restorePlayback() {
    const video = document.querySelector('video');
    if (!video) return;
    if (video.playbackRate === PLAYBACK_SPEED) {
      video.playbackRate = originalPlaybackRate || 1;
      video.muted = wasMuted;
      LOG('🔄 Restored playback');
    }
  }

  // ---------------------------------------------------------------------------
  // Best-effort click (doesn't work due to isTrusted, but harmless)
  // ---------------------------------------------------------------------------

  function tryClickSkipButton() {
    const btn = document.querySelector('.ytp-ad-skip-button-modern') ||
                document.querySelector('.ytp-ad-skip-button') ||
                document.querySelector('.ytp-skip-ad-button');
    if (!btn || btn.offsetParent === null || btn.disabled) return;
    try {
      const r = btn.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const init = { bubbles: true, cancelable: true, composed: true, view: window,
        clientX: cx, clientY: cy, screenX: cx, screenY: cy, button: 0, buttons: 1 };
      btn.dispatchEvent(new PointerEvent('pointerdown', Object.assign({}, init, { pointerType: 'mouse', pointerId: 1, isPrimary: true })));
      btn.dispatchEvent(new MouseEvent('mousedown', init));
      btn.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, init, { pointerType: 'mouse', pointerId: 1, isPrimary: true })));
      btn.dispatchEvent(new MouseEvent('mouseup', init));
      btn.dispatchEvent(new MouseEvent('click', init));
    } catch (_) {}
  }

  // ---------------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------------

  function trySkipAd() {
    if (!enabled) return;

    if (!isAdPlaying()) {
      adStartTime = 0;
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
    if (elapsed > MIN_AD_BEFORE_SKIP_MS) {
      tryClickSkipButton();
      skipAd();
      updateOverlay('⏩ skipping');
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

    // Remove old listeners before re-attaching (SPA-safe)
    if (adStartHandler) player.removeEventListener('onAdStart', adStartHandler);
    if (adFinishHandler) player.removeEventListener('onAdFinish', adFinishHandler);

    adStartHandler = function () {
      if (!enabled) return;
      adStartTime = Date.now();
    };
    adFinishHandler = function () {
      adStartTime = 0;
      restorePlayback();
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
    } catch (_) {}
  }

  function bumpStats() {
    pendingSkips++;
    if (flushTimer) return;
    flushTimer = setTimeout(function () {
      flushTimer = null;
      flushStats();
    }, 500);
  }

  // Flush any pending stats before the page unloads (e.g. SPA navigation away).
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

  function enable()  { enabled = true; }
  function disable() { enabled = false; adStartTime = 0; restorePlayback(); }

  // ---------------------------------------------------------------------------
  // Storage listener — single handler for all keys
  // ---------------------------------------------------------------------------

  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local') return;
      if (changes.enabled) changes.enabled.newValue ? enable() : disable();
      if (changes.debugOverlay) setDebugOverlay(changes.debugOverlay.newValue);
    });
  } catch (_) {}

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
      hookYouTubeEvents();
    });
  }

  // Start immediately, check persisted state async
  startAll();
  try {
    chrome.storage.local.get(['enabled', 'debugOverlay'], function (data) {
      if (data && data.enabled === false) disable();
      if (data && data.debugOverlay) setDebugOverlay(true);
    });
  } catch (_) {}
})();
