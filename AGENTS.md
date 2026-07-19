# AGENTS.md — YouTube Ad-Skip Chrome Extension Spec

> **Target**: Manifest V3 Chrome Extension  
> **Approach**: CDP mouse click on the skip button — generates `isTrusted: true` events.  
> **Non-goal**: Does NOT block ads, does NOT manipulate video playback.  
> **Constraint**: Pure vanilla JS, no build tooling, no external dependencies, no tracking.

---

## 1. Core Design Decision: CDP Click Only

YouTube's skip button handler **requires `isTrusted: true` click events**.
DOM-synthesized events are rejected. Video-speed manipulation (playbackRate +
seek) is detectable as abnormal playback behavior and triggers anti-adblock.

**Solution**: CDP (Chrome DevTools Protocol) `Input.dispatchMouseEvent` via
`chrome.debugger`. These are genuine browser-level mouse events with
`isTrusted: true` — YouTube accepts them as real user clicks.

The content script finds the skip button, sends viewport coordinates to the
background service worker, which attaches CDP, dispatches mouseMoved →
mousePressed → mouseReleased, then detaches.

---

## 2. File Structure

```
yt-adskip/
├── extension/               # Chrome extension source
│   ├── manifest.json         # MV3 manifest
│   ├── background.js         # CDP service worker
│   ├── content.js            # Ad detection + CDP click
│   ├── popup/
│   │   ├── popup.html
│   │   ├── popup.js
│   │   └── popup.css
│   └── icons/
│       ├── icon16.png
│       ├── icon48.png
│       └── icon128.png
├── tests/
│   ├── test_adskip.py        # End-to-end Playwright test
│   └── profiles/             # Test browser profiles (git-ignored)
├── AGENTS.md                 # This file (architectural spec)
├── CLAUDE.md                 # Original architecture sketch
├── TESTING.md                # Test instructions
└── README.md                 # User-facing readme
```

---

## 3. manifest.json

```jsonc
{
  "manifest_version": 3,
  "name": "YT AdSkip",
  "version": "2.0.6",
  "minimum_chrome_version": "96",
  "author": "hyperdreamer",
  "homepage_url": "https://github.com/hyperdreamer/yt-adskip",
  "description": "Automatically clicks YouTube's Skip Ad button via CDP.",
  "permissions": ["storage", "debugger", "management"],
  "background": { "service_worker": "background.js" },
  "host_permissions": ["*://www.youtube.com/*"],
  "content_scripts": [{
    "matches": ["*://www.youtube.com/*"],
    "js": ["content.js"],
    "run_at": "document_idle"
  }],
  "action": {
    "default_popup": "popup/popup.html",
    "default_title": "YT AdSkip",
    "default_icon": { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" }
  },
  "icons": { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" }
}
```

Key decisions:
- **`permissions: ["storage", "debugger", "management"]`** — storage for toggle/state, debugger for CDP mouse events, management for listing conflicting extensions.
- **`background.service_worker`** — handles CDP attach/detach and `Input.dispatchMouseEvent`.
- **`host_permissions`** — scoped to `www.youtube.com` only.
- **`run_at: "document_idle"`** — ensures `#movie_player` and `<video>` are present.
- **No `scripting` permission** — declarative content_scripts injection is sufficient.

---

## 4. Content Script (`content.js`)

### 4.1 Ad Detection — Three-Layer Strategy

#### Layer 1: YouTube's Internal API (Primary)
```js
function getAdState() {
  const p = document.getElementById('movie_player');
  return p && typeof p.getAdState === 'function' ? p.getAdState() : -1;
}
```
`getAdState()` returns `-1` when no ad is playing, `>= 0` during an ad.
This is the most reliable detection method.

#### Layer 2: CSS Class Checks (Fallback)
```js
function isAdPlaying() {
  if (getAdState() !== -1) return true;
  const player = document.getElementById('movie_player');
  return player && (
    player.classList.contains('ad-showing') ||
    player.classList.contains('ad-interrupting')
  );
}
```
When `getAdState()` is unavailable, fall back to the well-known CSS classes
YouTube applies to `#movie_player` during ad playback.

#### Layer 3: YouTube Player Events
```js
// Handler references stored for idempotent cleanup on SPA navigation
let adStartHandler = null;
let adFinishHandler = null;

function hookYouTubeEvents() {
  const player = document.getElementById('movie_player');
  if (!player) {
    if (hookRetries++ < MAX_HOOK_RETRIES) setTimeout(hookYouTubeEvents, 500);
    return;
  }
  hookRetries = 0;
  // Clean up old listeners before re-attaching (SPA-safe)
  if (adStartHandler) player.removeEventListener('onAdStart', adStartHandler);
  if (adFinishHandler) player.removeEventListener('onAdFinish', adFinishHandler);

  adStartHandler = function () { adStartTime = Date.now(); };
  adFinishHandler = function () { adStartTime = 0; };
  player.addEventListener('onAdStart', adStartHandler);
  player.addEventListener('onAdFinish', adFinishHandler);
}
```
YouTube's native `onAdStart` and `onAdFinish` events provide reliable
ad-lifecycle boundaries. Handlers are tracked in variables so old listeners
can be removed before re-attaching on SPA navigation — prevents memory leaks.
Retries are capped at 40 attempts (~20 s) in case `#movie_player` never loads.

### 4.2 Main Loop — Polling at 250 ms
```js
const POLL_INTERVAL_MS = 250;
const MIN_AD_BEFORE_SKIP_MS = 1000; // brief grace period before acting
let cdpAttempted = false;

function trySkipAd() {
  if (!enabled) return;
  if (!isAdPlaying()) { adStartTime = 0; cdpAttempted = false; return; }
  if (!adStartTime) { adStartTime = Date.now(); return; }
  if (Date.now() - adStartTime < MIN_AD_BEFORE_SKIP_MS) return;
  if (cdpAttempted) return;
  const btn = findSkipButton();
  if (!btn) return;
  cdpAttempted = true;
  tryCdpClick(btn).then((result) => {
    if (result.ok) bumpStats();
    else cdpAttempted = false;
  });
}
```

The poll runs every 250 ms — fast enough to catch ad transitions quickly,
slow enough to avoid triggering YouTube's anti-automation heuristics.

### 4.3 Skip Strategy — CDP Click

When the skip button is visible (after 1s grace period):

1. `findSkipButton()` locates `.ytp-ad-skip-button-modern` / `.ytp-ad-skip-button` / `.ytp-skip-ad-button`
2. Computes viewport center coordinates via `getBoundingClientRect()`
3. Sends `{ type: "adskip:click", x, y }` to the background service worker
4. Background attaches `chrome.debugger`, dispatches `mouseMoved` → `mousePressed` → `mouseReleased`, detaches
5. YouTube's handler receives `isTrusted: true` and accepts the click
6. Ad ends naturally

A `cdpAttempted` flag ensures only one click per ad — no spamming.

### 4.4 Background Service Worker (`background.js`)

```js
async function cdpClick(tabId, x, y) {
  await attachDebugger(tabId);           // chrome.debugger.attach
  await dispatchMouse(tabId, 'mouseMoved', x, y);
  await dispatchMouse(tabId, 'mousePressed', x, y);
  await dispatchMouse(tabId, 'mouseReleased', x, y);
  await detachDebugger(tabId);           // chrome.debugger.detach
}
```

`Input.dispatchMouseEvent` generates real OS-level mouse events at the
specified viewport coordinates. These pass YouTube's `isTrusted` check.

### 4.5 SPA Navigation Handling

```js
document.addEventListener('yt-navigate-finish', function () {
  adStartTime = 0;
  hookYouTubeEvents(); // idempotent — cleans up old handlers before re-attaching
});
```

YouTube never does full page reloads. `yt-navigate-finish` fires after
every SPA transition. Reset ad state and re-hook the player events.
`hookYouTubeEvents()` is idempotent — it removes old `onAdStart`/`onAdFinish`
listeners before attaching new ones, so repeated navigations don't leak.

### 4.7 Initialization Sequence

On content script load (`document_idle`):

1. Call `startAll()` immediately — start polling and hook player events.
2. Asynchronously read `chrome.storage.local` for enabled/disabled state and debug overlay toggle.
3. If disabled, call `disable()` (clears ad state and stops polling).
4. Register a single `chrome.storage.onChanged` listener that handles both `enabled` and `debugOverlay` keys.
5. Register a `beforeunload` listener that flushes any pending stats immediately (prevents losing skip counts on SPA navigations).

The script starts enabled by default and corrects itself if the persisted
state says otherwise. This avoids a flash where ads play for one poll cycle
before the stored state is read.

---

## 5. State Management (`chrome.storage.local`)

### Storage Schema

```jsonc
{
  "enabled": true,              // boolean — master on/off toggle
  "stats": {
    "totalSkips": 0,            // number — lifetime skip count
    "lastSkipTime": null        // number | null — Date.now() of last skip
  },
  "today": {
    "date": "2026-07-10",       // string — YYYY-MM-DD date key
    "count": 0                  // number — skips for today
  },
  "debugOverlay": false         // boolean — show debug overlay
}
```

### Cross-context Communication

- **Popup → Content Script**: Popup writes `{ enabled: true/false }` or `{ debugOverlay: true/false }` to storage.
  Content script listens via a single `chrome.storage.onChanged` handler that dispatches to `enable()`/`disable()` or `setDebugOverlay()`.
- **Content Script → Popup**: Content script writes updated `stats` after each successful CDP click.
  Popup reads on open and listens via `onChanged`. Stats are debounced at 500 ms and flushed immediately on `beforeunload` to avoid data loss.

### Disable Behavior

When toggled off:
- `enabled` set to `false` — poll handler no-ops.
- `adStartTime` reset to `0`.
- Stats flushed immediately.

When toggled back on:
- `enabled` set to `true` — poll handler resumes.
- No immediate action taken; next ad trigger will be caught normally.

---

## 6. Popup UI

A compact popup (~300×200) with:
- Toggle switch (enabled/disabled)
- Status indicator (green dot = active, gray = paused)
- Stats: skips today, total skips, last skip time (relative)
- Debug overlay toggle

Dark theme with light-theme support via `prefers-color-scheme: light`.

---

## 7. Icons

Three PNG sizes: 16×16 (toolbar), 48×48 (extensions page), 128×128 (store).
Clean, recognizable skip-forward icon. Single color variant — popup handles
state indication, not the icon.

---

## 8. Edge Cases

| Scenario | Handling |
|---|---|
| Pre-roll ad | Ad detected via `getAdState()`/CSS classes → CDP click on skip button |
| Mid-roll ad | Same detection, same handling. `onAdStart` fires reliably. |
| Bumper ads (6s unskippable) | No skip button exists — cannot be skipped. Limitation. |
| Ad pods (multiple ads) | Each ad triggers its own `onAdStart`/`onAdFinish` cycle |
| SPA navigation during ad | `yt-navigate-finish` resets ad state |
| User disables mid-ad | `disable()` clears state, no-op until re-enabled |
| YouTube in background tab | Content script continues running — ad still skipped |
| Embedded players | Out of scope — `host_permissions` scoped to `www.youtube.com` |
| YouTube Shorts | Different player — detection likely won't match, gracefully no-ops |
| YouTube Music | Out of scope — `music.youtube.com` doesn't match host_permissions |

---

## 9. Research & Rationale

All DOM-synthesized click approaches fail because YouTube's React-based
player requires `isTrusted: true` click events:

- `el.click()` — no effect
- `PointerEvent` dispatch — `isTrusted: false`, rejected
- `MouseEvent` dispatch — same
- Video-speed manipulation (playbackRate + seek) — detectable as abnormal
  playback behavior, triggers anti-adblock interstitial

CDP `Input.dispatchMouseEvent` is the only mechanism that produces genuine
`isTrusted: true` mouse events from within a Chrome extension. The
`chrome.debugger` API attaches at the browser level and dispatches OS-level
input events — indistinguishable from real user interaction.

---

*Spec version: 2.1. Last updated: 2026-07-11.*
