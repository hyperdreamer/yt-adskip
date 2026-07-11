# AGENTS.md — YouTube Ad-Skip Chrome Extension Spec

> **Target**: Manifest V3 Chrome Extension  
> **Approach**: Seeking-based ad skip — bypasses YouTube's `isTrusted` click rejection via video manipulation.  
> **Non-goal**: Does NOT block or hide ads — only speeds through them.  
> **Constraint**: Pure vanilla JS, no build tooling, no external dependencies, no tracking.

---

## 1. Core Design Decision: Why Clicking Doesn't Work

YouTube's skip button handler **requires `isTrusted: true` click events**. Every
programmatic click approach — `el.click()`, `PointerEvent` dispatch, full
`MouseEvent` sequence, React synthetic event probing — has been tried and
rejected by YouTube's framework. The extension **cannot** trigger the skip
button via DOM events.

**Solution**: Bypass the DOM event system entirely. Manipulate the `<video>`
element directly — speed up playback to 16×, seek to the end of the ad, then
restore normal playback. This achieves the same result (ad skipped) without
ever touching the skip button.

---

## 2. File Structure

```
yt-adskip/
├── manifest.json          # MV3 extension manifest
├── content.js             # Content script: ad detection + seek skip
├── popup/
│   ├── popup.html         # Extension popup UI
│   ├── popup.js           # Popup logic: toggle, stats
│   └── popup.css          # Popup styles
├── icons/
│   ├── icon16.png         # 16×16 toolbar icon
│   ├── icon48.png         # 48×48 extensions page icon
│   └── icon128.png        # 128×128 store listing / install icon
├── AGENTS.md              # This file (architectural spec)
├── CLAUDE.md              # Original architecture sketch
└── README.md              # User-facing readme
```

---

## 3. manifest.json

```jsonc
{
  "manifest_version": 3,
  "name": "YT AdSkip",
  "version": "1.0.0",
  "description": "Automatically skips YouTube ads by speeding through them.",
  "permissions": ["storage"],
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
- **`permissions: ["storage"]`** — for the on/off toggle state and skip stats.
- **`host_permissions`** — scoped to `www.youtube.com` only.
- **`run_at: "document_idle"`** — ensures `#movie_player` and `<video>` are present.
- **No `scripting` permission** — declarative content_scripts injection is sufficient.
- **No service worker** — content script handles everything; popup reads/writes storage directly.

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
  adFinishHandler = function () { adStartTime = 0; restorePlayback(); };
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
const PLAYBACK_SPEED = 16;
const MIN_AD_BEFORE_SKIP_MS = 1000; // brief grace period before acting

function trySkipAd() {
  if (!enabled) return;
  if (!isAdPlaying()) { adStartTime = 0; return; }
  if (!adStartTime) { adStartTime = Date.now(); bumpStats(); return; }
  if (Date.now() - adStartTime < MIN_AD_BEFORE_SKIP_MS) return;

  tryClickSkipButton(); // best-effort, usually rejected
  skipAd();
}
```

The poll runs every 250 ms — fast enough to catch ad transitions quickly,
slow enough to avoid triggering YouTube's anti-automation heuristics.

### 4.3 Skip Strategy — Video Manipulation

```js
function skipAd() {
  const video = document.querySelector('video');
  if (!video || !isFinite(video.duration)) return false;

  // Step 1: Speed up to 16x and mute
  if (video.playbackRate !== PLAYBACK_SPEED) {
    originalPlaybackRate = video.playbackRate || 1;
    wasMuted = video.muted;
    video.muted = true;
    video.playbackRate = PLAYBACK_SPEED;
    return true;
  }

  // Step 2: Seek near end to trigger ad completion
  const target = Math.max(0, video.duration - 0.5);
  if (target > video.currentTime + 0.5) {
    video.currentTime = target;
    return true;
  }
  return false;
}
```

Two-step process:
1. Set `playbackRate` to 16× and mute. Record original values for restore.
2. Seek `currentTime` to near `duration` (0.5s from end). This triggers
   YouTube to mark the ad as watched/completed.

### 4.4 Playback Restore

```js
function restorePlayback() {
  const video = document.querySelector('video');
  if (!video) return;
  if (video.playbackRate === PLAYBACK_SPEED) {
    video.playbackRate = originalPlaybackRate || 1;
    video.muted = wasMuted;
  }
}
```

Called when the ad finishes (detected via polling or `onAdFinish`).
Restores the video to its original `playbackRate` and mute state so the
main content plays normally.

### 4.5 Best-Effort Click (Harmless Fallback)

```js
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
    btn.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerType: 'mouse', pointerId: 1, isPrimary: true }));
    btn.dispatchEvent(new MouseEvent('mousedown', init));
    btn.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerType: 'mouse', pointerId: 1, isPrimary: true }));
    btn.dispatchEvent(new MouseEvent('mouseup', init));
    btn.dispatchEvent(new MouseEvent('click', init));
  } catch (_) {}
}
```

Dispatches a full `PointerEvent` → `MouseEvent` sequence with computed
coordinates. YouTube rejects these because `isTrusted` is `false`, but
it costs nothing and might work if YouTube ever relaxes the check.

### 4.6 SPA Navigation Handling

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
3. If disabled, call `disable()` (clears ad state, restores playback).
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
- **Content Script → Popup**: Content script writes updated `stats` after each ad
  detection. Popup reads on open and listens via `onChanged`. Stats are debounced at 500 ms and flushed immediately on `beforeunload` to avoid data loss.

### Disable Behavior

When toggled off:
- `enabled` set to `false` — poll handler no-ops.
- `adStartTime` reset to `0`.
- Playback restored (speed back to 1×, unmute if muted).

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
| Pre-roll ad | Ad detected via `getAdState()`/CSS classes → sped through at 16× |
| Mid-roll ad | Same detection, same handling. `onAdStart` fires reliably. |
| Bumper ads (6s unskippable) | No skip button exists — sped through just like any other ad |
| Ad pods (multiple ads) | Each ad triggers its own `onAdStart`/`onAdFinish` cycle |
| SPA navigation during ad | `yt-navigate-finish` resets ad state and restores playback |
| User disables mid-ad | Playback restored immediately |
| YouTube in background tab | Content script continues running — ad still skipped |
| Embedded players | Out of scope — `host_permissions` scoped to `www.youtube.com` |
| YouTube Shorts | Different player — detection likely won't match, gracefully no-ops |
| YouTube Music | Out of scope — `music.youtube.com` doesn't match host_permissions |

---

## 9. Research & Rationale

All click-based approaches fail because YouTube's framework (React-based
player UI) requires `isTrusted: true` click events. Attempted and abandoned:

- `el.click()` — no effect
- `PointerEvent` dispatch — `isTrusted: false`, rejected
- `MouseEvent` dispatch — same
- Full `pointerdown` → `mousedown` → `pointerup` → `mouseup` → `click` sequence — rejected
- `onAdUxClicked` internal API probing — unreliable

The seeking approach (16× `playbackRate` + `seekTo()`) is battle-tested
and the only mechanism confirmed to work across YouTube's current player.

---

*Spec version: 2.1. Last updated: 2026-07-11.*
