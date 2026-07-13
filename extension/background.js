/**
 * YT AdSkip — Background Service Worker
 *
 * Handles CDP (Chrome DevTools Protocol) mouse clicks.
 * Uses chrome.debugger.getTargets to find the YouTube page target
 * and attach only to that, avoiding cross-extension security errors
 * from other extensions' iframes on the page.
 */

'use strict';

const LOG = console.log.bind(console, '[YT AdSkip BG]');

LOG('service worker started');

// ── CDP mouse click ──────────────────────────────────────────────────

async function cdpClick(tabId, x, y) {
  LOG('cdpClick: tab=' + tabId + ' x=' + x + ' y=' + y);

  // Find the YouTube page target — ignore sub-frames from other extensions
  const targetId = await findYouTubeTarget(tabId);
  if (!targetId) {
    LOG('No YouTube page target found for tab', tabId);
    return { ok: false, error: 'no page target' };
  }

  try {
    await attachDebugger({ targetId });
    LOG('CDP attached to target', targetId);
  } catch (e) {
    LOG('CDP attach FAILED:', e.message);
    return { ok: false, error: 'attach failed: ' + e.message };
  }

  try {
    await dispatchMouse(targetId, 'mouseMoved', x, y);
    await sleep(15);
    await dispatchMouse(targetId, 'mousePressed', x, y);
    await sleep(30);
    await dispatchMouse(targetId, 'mouseReleased', x, y);

    await detachDebugger(targetId);
    return { ok: true };
  } catch (e) {
    await detachDebugger(targetId).catch(() => {});
    return { ok: false, error: e.message };
  }
}

/** Find the YouTube page target for a tab, ignoring extension sub-frames. */
function findYouTubeTarget(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.getTargets((targets) => {
      // First try: find a page target for youtube.com/watch
      for (const t of targets) {
        if (t.tabId === tabId && t.type === 'page' && t.url.includes('youtube.com/watch')) {
          resolve(t.id);
          return;
        }
      }
      // Second try: any youtube.com page target for this tab
      for (const t of targets) {
        if (t.tabId === tabId && t.type === 'page' && t.url.includes('youtube.com')) {
          resolve(t.id);
          return;
        }
      }
      // Fallback: any page target for this tab
      for (const t of targets) {
        if (t.tabId === tabId && t.type === 'page') {
          resolve(t.id);
          return;
        }
      }
      resolve(null);
    });
  });
}

function dispatchMouse(targetId, type, x, y) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ targetId }, 'Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: type === 'mouseMoved' ? 'none' : 'left',
      buttons: type === 'mouseReleased' ? 0 : 1,
      clickCount: type === 'mousePressed' ? 1 : 0,
    }, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
}

function attachDebugger(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, '1.3', () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

function detachDebugger(targetId) {
  return new Promise((resolve) => {
    chrome.debugger.detach({ targetId }, () => resolve());
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Message handler ───────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'adskip:click' && sender.tab?.id) {
    cdpClick(sender.tab.id, msg.x, msg.y).then(sendResponse);
    return true;
  }
});
