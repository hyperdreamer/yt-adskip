/**
 * YT AdSkip - Popup Script
 *
 * Renders the toggle switch and live stats from chrome.storage.local.
 * Uses onChanged listener for instant updates instead of polling.
 */

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const toggleEl = $('enabled');
  const labelEl  = $('enabled-label');
  const debugEl  = $('debugOverlay');
  const statusEl = $('status');
  const statusText = $('status-text');
  const todayEl = $('stat-today');
  const totalEl = $('stat-total');
  const lastEl  = $('stat-last');

  // Periodic refresh for relative-time display ("2 min ago") that ages.
  let relativeTimer = null;

  function formatRelative(ts) {
    if (!ts || typeof ts !== 'number') return 'never';
    const diffMs = Date.now() - ts;
    if (diffMs < 0) return 'just now';
    const sec = Math.floor(diffMs / 1000);
    if (sec < 5) return 'just now';
    if (sec < 60) return sec + 's ago';
    const min = Math.floor(sec / 60);
    if (min < 60) return min + ' min ago';
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + ' hr ago';
    const day = Math.floor(hr / 24);
    return day + ' day' + (day === 1 ? '' : 's') + ' ago';
  }

  function formatNumber(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '0';
    return n.toLocaleString();
  }

  function applyEnabledState(flag) {
    toggleEl.checked = !!flag;
    labelEl.textContent = flag ? 'Enabled' : 'Disabled';
    if (flag) {
      statusEl.classList.remove('paused');
      statusEl.classList.add('active');
      statusText.textContent = 'Active';
    } else {
      statusEl.classList.remove('active');
      statusEl.classList.add('paused');
      statusText.textContent = 'Paused';
    }
  }

  function renderStats(stats, today) {
    totalEl.textContent = formatNumber(stats && stats.totalSkips);
    lastEl.textContent  = formatRelative(stats && stats.lastSkipTime);
    todayEl.textContent = formatNumber(today && today.count);
  }

  function readState() {
    chrome.storage.local.get(['enabled', 'stats', 'today', 'debugOverlay'], (data) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        console.error('YT AdSkip: storage read failed', lastError);
        return;
      }
      applyEnabledState(data && data.enabled !== false);
      debugEl.checked = !!(data && data.debugOverlay);
      renderStats(data && data.stats, data && data.today);
    });
  }

  function onToggle() {
    const next = !!toggleEl.checked;
    chrome.storage.local.set({ enabled: next }, () => {
      if (chrome.runtime.lastError) {
        console.error('YT AdSkip: storage write failed', chrome.runtime.lastError);
        toggleEl.checked = !next; // revert UI
        return;
      }
      applyEnabledState(next);
    });
  }

  toggleEl.addEventListener('change', onToggle);

  debugEl.addEventListener('change', () => {
    chrome.storage.local.set({ debugOverlay: !!debugEl.checked });
  });

  // Listen for storage changes from content script (instant updates).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.enabled) applyEnabledState(changes.enabled.newValue);
    if (changes.stats || changes.today) readState();
  });

  // Slow periodic refresh only for the "last skip" relative time,
  // which ages even when the storage value doesn't change.
  relativeTimer = setInterval(() => {
    chrome.storage.local.get(['stats'], (data) => {
      if (!chrome.runtime.lastError) {
        lastEl.textContent = formatRelative(data && data.stats && data.stats.lastSkipTime);
      }
    });
  }, 10000);

  // Clean up on unload.
  window.addEventListener('unload', () => {
    if (relativeTimer) clearInterval(relativeTimer);
  });

  readState();
})();
