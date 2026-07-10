/**
 * YT AdSkip - Content Script
 *
 * Skips YouTube ads by seeking past them via video.currentTime.
 * YouTube rejects synthetic click events (isTrusted check),
 * but currentTime manipulation bypasses this entirely.
 *
 * Approach based on SponsorBlock/maze-utils pattern.
 */

(function () {
  'use strict';

  const LOG = console.log.bind(console, '[YT AdSkip]');

  const POLL_INTERVAL_MS = 250;
  const MIN_AD_DURATION_BEFORE_SKIP_MS = 1000; // Don't seek immediately — let ad start

  let enabled = true;
  let pollTimer = null;
  let adStartTime = 0;

  // ---------------------------------------------------------------------------
  // Create visible status banner
  // ---------------------------------------------------------------------------

  const banner = document.createElement('div');
  banner.id = '__yt_adskip_banner';
  banner.style.cssText = 'position:fixed;top:0;right:0;z-index:999999;background:#000;color:#0f0;padding:4px 12px;font:12px monospace;border-radius:0 0 0 8px;opacity:0.85;pointer-events:none';
  banner.textContent = 'YT AdSkip: ready';
  document.addEventListener('DOMContentLoaded', () => {
    if (document.body) document.body.appendChild(banner);
  });
  if (document.body) document.body.appendChild(banner);

  function updateBanner(text) {
    const b = document.getElementById('__yt_adskip_banner');
    if (b) b.textContent = 'YT AdSkip: ' + text;
  }

  function getAdState() {
    try {
      const player = document.getElementById('movie_player');
      return player && typeof player.getAdState === 'function' ? player.getAdState() : -1;
    } catch (_) { return -1; }
  }

  // ---------------------------------------------------------------------------
  // YouTube ad state mapping (from reversed YouTube player code)
  // -1 = no ad, 0 = unknown, 1 = pre-roll, 2 = mid-roll, 3 = post-roll
  // ---------------------------------------------------------------------------

  function isAdPlaying() {
    return getAdState() !== -1;
  }

  // ---------------------------------------------------------------------------
  // Skip strategy: seek video past the ad
  // ---------------------------------------------------------------------------

  function skipAd() {
    const video = document.querySelector('video');
    if (!video || !isFinite(video.duration)) return false;

    // Seek to near the end to trigger YouTube's ad-skip logic
    const targetTime = Math.min(video.duration - 0.5, video.currentTime + 30);
    if (targetTime > video.currentTime) {
      const oldTime = video.currentTime;
      video.currentTime = targetTime;
      LOG('⏩ Seeked:', oldTime.toFixed(1), '→', targetTime.toFixed(1), 'duration:', video.duration.toFixed(1));
      updateBanner('SEEKED ' + oldTime.toFixed(0) + '→' + targetTime.toFixed(0) + 's');
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Also try clicking the skip button as a complement to seeking
  // ---------------------------------------------------------------------------

  function clickSkipButton() {
    const button = document.querySelector('.ytp-ad-skip-button-modern') ||
                   document.querySelector('.ytp-ad-skip-button') ||
                   document.querySelector('.ytp-skip-ad-button');
    if (!button || button.offsetParent === null || button.disabled) return false;

    try {
      const rect = button.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const init = {
        bubbles: true, cancelable: true, composed: true, view: window,
        clientX: cx, clientY: cy, screenX: cx, screenY: cy,
        button: 0, buttons: 1
      };
      button.dispatchEvent(new PointerEvent('pointerdown', Object.assign({}, init, { pointerType: 'mouse', pointerId: 1, isPrimary: true })));
      button.dispatchEvent(new MouseEvent('mousedown', init));
      button.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, init, { pointerType: 'mouse', pointerId: 1, isPrimary: true })));
      button.dispatchEvent(new MouseEvent('mouseup', init));
      button.dispatchEvent(new MouseEvent('click', init));
      LOG('🖱️ Clicked skip button');
      return true;
    } catch (_) { return false; }
  }

  // ---------------------------------------------------------------------------
  // Main ad-skip loop
  // ---------------------------------------------------------------------------

  function trySkipAd() {
    if (!enabled) return;

    const state = getAdState();
    if (state === -1) {
      adStartTime = 0;
      return; // No ad playing
    }

    // Ad is playing — track when it started
    if (!adStartTime) {
      adStartTime = Date.now();
      LOG('📺 Ad detected! state=' + state);
      updateBanner('AD state=' + state);
      return; // Let the ad play for a bit before skipping
    }

    const elapsed = Date.now() - adStartTime;
    updateBanner('AD ' + (elapsed / 1000).toFixed(1) + 's | state=' + state);

    // Try clicking the skip button first (for skippable ads)
    clickSkipButton();

    // If the ad has been playing for a while and we're still in it, seek past it
    if (elapsed > MIN_AD_DURATION_BEFORE_SKIP_MS) {
      if (isAdPlaying()) {
        skipAd();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // YouTube native ad events
  // ---------------------------------------------------------------------------

  function hookYouTubeEvents() {
    const player = document.getElementById('movie_player');
    if (!player) {
      // Player not ready — retry
      setTimeout(hookYouTubeEvents, 500);
      return;
    }

    player.addEventListener('onAdStart', () => {
      LOG('🔴 onAdStart');
      adStartTime = Date.now();
      updateBanner('AD STARTED');
    });

    player.addEventListener('onAdFinish', () => {
      LOG('🟢 onAdFinish');
      adStartTime = 0;
      updateBanner('AD FINISHED');
    });

    LOG('🎣 Hooked onAdStart/onAdFinish');
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  LOG('🚀 YT AdSkip loaded — seeking approach');
  updateBanner('ready');

  hookYouTubeEvents();

  pollTimer = setInterval(trySkipAd, POLL_INTERVAL_MS);

  // SPA navigation
  document.addEventListener('yt-navigate-finish', () => {
    LOG('🧭 navigate');
    adStartTime = 0;
    hookYouTubeEvents();
  });
})();
