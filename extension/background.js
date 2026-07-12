/**
 * YT AdSkip — Background Service Worker
 *
 * Handles CDP (Chrome DevTools Protocol) mouse clicks.
 * When the content script detects a visible skip button, it sends the
 * button's viewport coordinates here. The background worker attaches
 * CDP, dispatches real mouse events (isTrusted: true), then detaches.
 *
 * CDP mouse events bypass YouTube's synthetic-click rejection entirely.
 */

'use strict';

const LOG = console.log.bind(console, '[YT AdSkip BG]');

// ── CDP mouse click ──────────────────────────────────────────────────

async function cdpClick(tabId, x, y) {
  LOG('cdpClick: tab=' + tabId + ' x=' + x + ' y=' + y);

  try {
    await attachDebugger(tabId);
    LOG('CDP attached to tab ' + tabId);
  } catch (e) {
    LOG('CDP attach FAILED: ' + e.message);
    return { ok: false, error: 'attach failed: ' + e.message };
  }

  try {
    // Move cursor to target position
    await dispatchMouse(tabId, 'mouseMoved', x, y);
    await sleep(15);
    // Press
    await dispatchMouse(tabId, 'mousePressed', x, y);
    await sleep(30);
    // Release
    await dispatchMouse(tabId, 'mouseReleased', x, y);

    await detachDebugger(tabId);
    return { ok: true };
  } catch (e) {
    await detachDebugger(tabId).catch(() => {});
    return { ok: false, error: e.message };
  }
}

function dispatchMouse(tabId, type, x, y) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
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

function attachDebugger(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

function detachDebugger(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => resolve());
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Message handler ───────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'adskip:click' && sender.tab?.id) {
    cdpClick(sender.tab.id, msg.x, msg.y).then(sendResponse);
    return true; // keep channel open for async response
  }
});
