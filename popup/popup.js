/**
 * YT AdSkip - Popup Script
 *
 * Renders the toggle switch and live stats from chrome.storage.local.
 * Writes the enabled/disabled state on toggle.
 */

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const toggleEl   = $('enabled');
  const labelEl    = $('enabled-label');
  const statusEl   = document.querySelector('.status');
  const statusText = $('status-text');
  const todayEl    = $('stat-today');
  const totalEl    = $('stat-total');
  const lastEl     = $('stat-last');

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

  function applyEnabledState(enabled) {
    toggleEl.checked = !!enabled;
    labelEl.textContent = enabled ? 'Enabled' : 'Disabled';
    if (enabled) {
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
    chrome.storage.local.get(['enabled', 'stats', 'today'], (data) => {
      applyEnabledState(data && data.enabled !== false);
      renderStats(data && data.stats, data && data.today);
    });
  }

  function onToggle() {
    const next = !!toggleEl.checked;
    chrome.storage.local.set({ enabled: next }, () => {
      applyEnabledState(next);
    });
  }

  toggleEl.addEventListener('change', onToggle);

  // Refresh stats every second so the "last skip" relative time stays current
  // and so skips fired in the content script are visible without re-opening.
  setInterval(readState, 1000);
  readState();
})();
