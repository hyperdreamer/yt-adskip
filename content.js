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
      bumpStats();
      return;
    }

    const elapsed = Date.now() - adStartTime;
    if (elapsed > MIN_AD_BEFORE_SKIP_MS) {
      tryClickSkipButton();
      skipAd();
    }
  }

  // ---------------------------------------------------------------------------
  // YouTube native events
  // ---------------------------------------------------------------------------

  function hookYouTubeEvents() {
    const player = document.getElementById('movie_player');
    if (!player) { setTimeout(hookYouTubeEvents, 500); return; }

    player.addEventListener('onAdStart', () => {
      if (!enabled) return;
      adStartTime = Date.now();
    });

    player.addEventListener('onAdFinish', () => {
      adStartTime = 0;
      restorePlayback();
    });
  }

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------

  let pendingSkips = 0;
  let flushTimer = null;

  function bumpStats() {
    pendingSkips++;
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      const toAdd = pendingSkips;
      pendingSkips = 0;
      flushTimer = null;
      if (toAdd === 0) return;
      try {
        chrome.storage.local.get(['stats', 'today'], (data) => {
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
          chrome.storage.local.set({ stats, today });
        });
      } catch (_) {}
    }, 500);
  }

  // ---------------------------------------------------------------------------
  // Enable/disable
  // ---------------------------------------------------------------------------

  function enable()  { enabled = true; }
  function disable() { enabled = false; adStartTime = 0; restorePlayback(); }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.enabled) return;
      changes.enabled.newValue ? enable() : disable();
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

    document.addEventListener('yt-navigate-finish', () => {
      adStartTime = 0;
      hookYouTubeEvents();
    });
  }

  // Start immediately, check persisted state async
  startAll();
  try {
    chrome.storage.local.get(['enabled'], (data) => {
      if (data && data.enabled === false) disable();
    });
  } catch (_) {}
})();
