/**
 * YT AdSkip — Background Service Worker
 *
 * Handles CDP mouse clicks via chrome.debugger.
 * Uses target-based attachment to avoid cross-extension iframe conflicts.
 */

'use strict';

const LOG = console.log.bind(console, '[YT AdSkip BG]');

LOG('service worker started');

// ── CDP mouse click ──────────────────────────────────────────────────

async function cdpClick(tabId, x, y) {
  LOG('cdpClick: tab=' + tabId + ' x=' + x + ' y=' + y);

  // Find YouTube page target — avoids extension sub-frames
  const targetId = await findYouTubeTarget(tabId);
  if (!targetId) {
    return { ok: false, error: 'no page target for tab ' + tabId };
  }

  try {
    await attachDebugger({ targetId });
  } catch (e) {
    const msg = e.message;
    if (msg.includes('different extension')) {
      // List likely conflicting extensions for the user
      LOG('Cross-extension conflict detected. Checking active extensions...');
      let exts = ['(unable to list)'];
      try {
        exts = await getActiveExtensions();
        LOG('Active extensions:', exts.join(', '));
      } catch (_) {
        LOG('Could not list active extensions');
      }
      return {
        ok: false,
        error: 'Another extension is blocking CDP. Try disabling: ' + exts.join(', ')
      };
    }
    return { ok: false, error: 'attach failed: ' + msg };
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

/** Find the YouTube page target, ignoring extension sub-frames. */
function findYouTubeTarget(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.getTargets((targets) => {
      if (chrome.runtime.lastError || !Array.isArray(targets)) {
        resolve(null);
        return;
      }
      for (const t of targets) {
        if (t.tabId === tabId && t.type === 'page' && t.url.includes('youtube.com/watch')) {
          resolve(t.id);
          return;
        }
      }
      for (const t of targets) {
        if (t.tabId === tabId && t.type === 'page' && t.url.includes('youtube.com')) {
          resolve(t.id);
          return;
        }
      }
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

/** List extensions that might be injecting content into web pages. */
function getActiveExtensions() {
  return new Promise((resolve, reject) => {
    chrome.management.getAll((exts) => {
      try {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        const names = exts
          .filter(e => e.enabled && e.id !== chrome.runtime.id)
          .map(e => e.name)
          .slice(0, 10);
        resolve(names);
      } catch (e) {
        reject(e);
      }
    });
  });
}

function dispatchMouse(targetId, type, x, y) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ targetId }, 'Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
      ...(type === 'mouseMoved' && { button: 'none', buttons: 0, clickCount: 0 }),
      ...(type === 'mouseReleased' && { buttons: 0 }),
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
