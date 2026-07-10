# AGENTS.md — YouTube Ad-Skip Chrome Extension Spec

> **Target**: Manifest V3 Chrome Extension  
> **Purpose**: Automatically click YouTube's "Skip Ad" button when it appears.  
> **Non-goal**: Does NOT block ads, hide ads, fast-forward ads, or mute ads.  
> **Constraint**: Pure vanilla JS, no build tooling, no external dependencies, no tracking.

---

## 1. Design Principles

1. **Minimal intervention** — only click the skip button; never modify video playback, volume, or DOM structure.
2. **Observer-first, poll-second** — MutationObserver is the primary detection path; setInterval is a safety net only.
3. **Resilient to YouTube changes** — multi-selector fallback chain, graceful degradation, no single point of selector failure.
4. **SPA-aware** — YouTube never does full page reloads; every navigation is an SPA transition.
5. **Silent operation** — no visible UI on the page, no console spam in production, no user-facing notifications.

---

## 2. File Structure

```
yt-adskip/
├── manifest.json          # MV3 extension manifest
├── content.js             # Content script: DOM observer + skip logic
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

## 3. manifest.json Spec

```jsonc
{
  "manifest_version": 3,
  "name": "YT AdSkip",
  "version": "1.0.0",
  "description": "Automatically clicks YouTube's Skip Ad button when it appears.",
  "permissions": ["storage"],
  "host_permissions": ["*://www.youtube.com/*"],
  "content_scripts": [
    {
      "matches": ["*://www.youtube.com/*"],
      "js": ["content.js"],
      "run_at": "document_idle"
    }
  ],
  "action": {
    "default_popup": "popup/popup.html",
    "default_title": "YT AdSkip",
    "default_icon": {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  },
  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  }
}
```

### Key manifest decisions:
- **`permissions: ["storage"]`** — only permission needed; used for the on/off toggle state.
- **`host_permissions`** — scoped strictly to `www.youtube.com`. No broad `*://*/*` permissions.
- **`content_scripts` injection** — `document_idle` ensures the DOM (including the `#movie_player`) is fully parsed before the script runs. This is equivalent to `DOMContentLoaded` but accounts for deferred resources.
- **No `scripting` permission** — not needed; we use declarative `content_scripts` injection rather than `chrome.scripting.executeScript()`.
- **No `background.service_worker`** — the content script handles everything; popup reads/writes `chrome.storage.local` directly.

---

## 4. Content Script (`content.js`) — Detailed Spec

### 4.1 Core Skip Button Selector Chain

Apply selectors in this exact priority order. The first matching, visible, enabled button wins:

| Priority | Selector | Status | Notes |
|----------|----------|--------|-------|
| 1 | `.ytp-ad-skip-button-modern` | Current (2025–2026) | Modern YouTube UI skip button |
| 2 | `.ytp-ad-skip-button` | Stable fallback | Has existed for years, still present as base class |
| 3 | `.ytp-skip-ad-button` | Legacy | Older class name; keep for backward compatibility |
| 4 | `button.ytp-ad-skip-button-modern` | Tag-qualified | More specific variant of #1 |
| 5 | `.ytp-ad-text button` | Text-based | Button inside the ad text container — catches any Skip/Skip Ad button by context |
| 6 | `button:has-text("Skip")` | Text content | Last-resort text-match fallback (see §4.3 for `:has-text` polyfill) |

### 4.2 Input Validation (Before Clicking)

**Never click a button that hasn't passed ALL of these checks:**

1. **Exists** — `el !== null`
2. **Visible** — `el.offsetParent !== null` (catches `display: none` and `visibility: hidden` elements positioned off-screen via `position: absolute; top: -9999px`)
3. **Enabled** — `!el.disabled` and `el.getAttribute('aria-disabled') !== 'true'`
4. **Non-zero dimensions** — `el.offsetWidth > 0 && el.offsetHeight > 0` (catches `width: 0; height: 0` hidden buttons)
5. **In the DOM** — `document.contains(el)` (catches detached nodes)

### 4.3 `:has-text()` Polyfill

Since `:has-text()` is not a native CSS selector, implement a helper:

```js
function querySelectorWithText(baseSelector, textStrings) {
  const elements = document.querySelectorAll(baseSelector);
  for (const el of elements) {
    const text = el.textContent.trim().toLowerCase();
    if (textStrings.some(s => text.includes(s.toLowerCase()))) {
      return el;
    }
  }
  return null;
}
```

Call as: `querySelectorWithText('button', ['skip', 'skip ad', 'skip ads'])`

### 4.4 Click Strategy

When a valid skip button is found:

1. **Only click once** — use a per-button-instance `WeakSet` to track already-clicked buttons so the same DOM node is never clicked twice.
2. **Use trusted click simulation** — call `el.click()`. This works because content scripts execute in the page's "isolated world" and `click()` triggers the same listener chain as a real user click in YouTube's JavaScript context.
3. **No repeated clicking** — after clicking, disconnect the observer briefly (100ms) to avoid re-triggering on any DOM churn YouTube does after the skip action.
4. **Log to console in debug mode only** — gated behind a `DEBUG` flag (set to `false` in production).

### 4.5 MutationObserver Configuration

```js
const observerConfig = {
  childList: true,       // Watch for added/removed nodes
  subtree: true,         // Watch entire DOM tree under target
  attributes: false,     // Don't watch attribute changes (not needed)
  characterData: false   // Don't watch text changes (overkill)
};
```

**Target**: `document.body` — YouTube dynamically injects the ad UI anywhere within the `<body>`. Observing `document.body` with `subtree: true` catches all injections.

**Debounce**: Use a trailing debounce of 25ms on the mutation callback. YouTube can batch-inject dozens of DOM nodes rapidly during ad transitions; processing every mutation individually wastes CPU. 25ms is below human perception (~40ms) so the skip still feels instant.

**Debounced callback pseudocode**:
```js
let debounceTimer = null;
function onMutation(mutations) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    findAndClickSkipButton();
  }, 25);
}
```

### 4.6 MutationObserver Filtering for Performance

Before running the full selector chain, do a cheap "quick check" against the added nodes:

```js
function mutationContainsAdElement(mutations) {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      // Quick check: does this element or its children match ad-related selectors?
      if (node.matches?.('.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, .ytp-ad-text, .ytp-ad-preview-text')) return true;
      if (node.querySelector?.('.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, .ytp-ad-text')) return true;
    }
  }
  return false;
}
```

Only run the full selector chain scan when this quick check passes. This avoids running `document.querySelectorAll` on every unrelated DOM change (e.g., chat messages, thumbnail loads).

### 4.7 Polling Fallback (`setInterval`)

The polling fallback runs at **2000ms** intervals (up from 500ms in the original sketch, per best practice to avoid triggering YouTube's anti-automation heuristics).

The MutationObserver should catch 99% of skip buttons. The polling fallback exists for:
- Edge cases where the observer misses an injection (e.g., if the observer is temporarily disconnected during a SPA transition)
- YouTube A/B experiments that use non-standard injection timing

**Implementation**: The interval timer is started once on script initialization and runs for the lifetime of the page. It is lightweight — a single `querySelector` call that returns `null` in the vast majority of ticks.

### 4.8 SPA Navigation Handling

YouTube is a single-page application. User navigations between videos, from homepage → watch page, from watch page → Shorts, etc. do NOT cause full page reloads. The content script must survive and stay effective across these transitions.

**Strategy** — three layers:

#### Layer 1: `yt-navigate-finish` Event (Primary)
```js
document.addEventListener('yt-navigate-finish', () => {
  // Re-run skip button detection immediately after navigation
  findAndClickSkipButton();
});
```
This is YouTube's own custom event, fired after every SPA navigation completes. It is the most reliable signal.

#### Layer 2: URL Change Detection via `yt-page-data-updated` (Secondary)
```js
document.addEventListener('yt-page-data-updated', () => {
  findAndClickSkipButton();
});
```
YouTube fires this after page data (including ad metadata) is loaded.

#### Layer 3: MutationObserver Persistence (Always Active)
The MutationObserver on `document.body` is never disconnected (except for the brief 100ms pause after a successful click). Since `document.body` is never replaced during SPA navigation (only its children change), the observer stays valid across all navigations with no re-initialization needed.

**No `history.pushState`/`popstate` monkey-patching** — not needed because:
1. YouTube's own events are more reliable and fire at the right time (after DOM is ready).
2. Monkey-patching `history` methods is fragile and can conflict with YouTube's own code.

### 4.9 Ad Detection for Context Awareness (Optional Enhancement)

The `#movie_player` element receives CSS classes during ad playback:

| Class on `#movie_player` | Meaning |
|---|---|
| `.ad-showing` | An ad is currently being displayed |
| `.ad-interrupting` | An ad has interrupted playback (mid-roll) |

These can be used to gate the full selector scan:

```js
const player = document.getElementById('movie_player');
if (player?.classList.contains('ad-showing') || player?.classList.contains('ad-interrupting')) {
  // Ad is playing — run the full selector chain aggressively
  findAndClickSkipButton();
}
```

The MutationObserver quick-check (§4.6) makes this gating less critical, but it adds a useful semantic check.

### 4.10 Initialization Sequence

On content script load (`document_idle`):

1. Read `chrome.storage.local` for the enabled/disabled state (default: `true`).
2. If disabled, do nothing (do not start observer or interval).
3. If enabled:
   a. Start MutationObserver on `document.body`.
   b. Start polling `setInterval` at 2000ms.
   c. Register `yt-navigate-finish` and `yt-page-data-updated` event listeners.
   d. Run `findAndClickSkipButton()` immediately (catches any ad already present at page load).
4. Listen for `chrome.storage.onChanged` to dynamically enable/disable without page reload.

---

## 5. State Management (`chrome.storage.local`)

The popup and content script share state via `chrome.storage.local`.

### Storage Schema

```jsonc
{
  "enabled": true,              // boolean — master on/off toggle
  "stats": {
    "totalSkips": 0,            // number — lifetime skip count
    "lastSkipTime": null        // number | null — Date.now() of last skip
  }
}
```

### Cross-context Communication

- **Popup → Content Script**: Popup writes `{ enabled: true/false }` to `chrome.storage.local`. Content script listens via `chrome.storage.onChanged`.
- **Content Script → Popup**: Content script writes updated `stats` to `chrome.storage.local` after each successful skip. Popup reads on open.

### Disable/Enable Behavior

When the user toggles `enabled` to `false`:
- Content script disconnects the MutationObserver.
- Content script clears the polling interval.
- Event listeners remain registered (cheap), but handler checks `enabled` flag and no-ops.

When toggled back to `true`:
- Re-connect MutationObserver.
- Re-start polling interval.
- Run `findAndClickSkipButton()` immediately.

---

## 6. Popup UI Spec (`popup/`)

### 6.1 `popup.html`

A compact popup (300×200px default):

```
┌─────────────────────────────┐
│  YT AdSkip                  │
│                             │
│  [===========●] Enabled     │  ← Toggle switch (large, touch-friendly)
│                             │
│  Status: ● Active           │  ← Green dot = enabled and watching
│         ○ Paused            │  ← Gray dot = disabled
│                             │
│  Skips today: 42            │  ← Stats (from storage)
│  Total skips: 1,337         │
│                             │
│  Last skip: 2 min ago       │
└─────────────────────────────┘
```

HTML structure:
- A `<label>` containing a checkbox input styled as a toggle switch.
- A status indicator `<div>` with conditional class `.active` / `.paused`.
- Stats `<div>` with spans for dynamic values.

### 6.2 `popup.js`

On popup open:
1. Read `chrome.storage.local` for `enabled` and `stats`.
2. Render toggle state.
3. Render stats.

On toggle change:
1. Write new `enabled` state to `chrome.storage.local`.
2. Update the status indicator.

### 6.3 `popup.css`

- Dark theme (`#1a1a1a` background) matching YouTube's dark UI.
- Toggle switch: 48px wide, 24px tall, with a circular knob that slides.
- Green accent color: `#3ea6ff` (YouTube blue) for active state.
- System font stack: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`.

---

## 7. Icon Spec (`icons/`)

### 7.1 Design

A simple, recognizable icon:
- **Base**: A rounded square with a "skip forward" double-arrowhead symbol (⏭ style).
- **Color palette**: YouTube-inspired — red (`#FF0000`) arrow on white/dark background, or white arrow on `#3ea6ff` (YouTube blue) background.
- **Clean at small sizes**: The 16×16 variant must be pixel-perfect and recognizable.

### 7.2 Sizes

| Size | Use |
|------|-----|
| 16×16 | Chrome toolbar (default) |
| 48×48 | Chrome extensions management page (`chrome://extensions`) |
| 128×128 | Chrome Web Store listing, installation dialog |

### 7.3 Format

PNG with transparency. Alternately, SVG icons can be used if declared in manifest (Chrome 88+ supports SVG icons).

### 7.4 State Variants

- **Default** (enabled, on YouTube): Colored icon.
- **Disabled** (toggled off): Grayscale/desaturated version. The popup toggles the icon via `chrome.action.setIcon()` (requires adding `"action"` permission if using dynamically; alternatively, stay with a single icon and indicate state only in the popup).

**Recommendation**: Use a single icon. Dynamic icon switching adds complexity and permissions. The popup is where detailed state lives.

---

## 8. Edge Cases — Complete Enumeration

### 8.1 Mid-Roll Ads
- **What**: Ads that appear during video playback, not just at the start (pre-roll).
- **Handling**: The MutationObserver watches the entire `document.body` with `subtree: true`, so mid-roll ad injection is caught identically to pre-roll ads. No special handling needed.

### 8.2 Bumper Ads (6-Second Unskippable)
- **What**: Short (6s) ads with no skip button ever.
- **Handling**: The extension does nothing — there's no skip button to click. The find function returns `null`, no action is taken. This is correct behavior.

### 8.3 Unskippable Ads (15-20s)
- **What**: Longer ads where the skip button appears after 5 seconds.
- **Handling**: The MutationObserver detects the button as soon as it's injected. YouTube injects the skip button element into the DOM at the moment it becomes clickable (not before with `disabled=true`). So the button is immediately clickable when detected.

### 8.4 Ad Pods (Multiple Ads in Sequence)
- **What**: YouTube plays 2+ ads back-to-back (e.g., "Ad 1 of 2").
- **Handling**: Each ad in the pod will trigger its own skip button injection, caught by the MutationObserver independently. The `WeakSet` click tracking (§4.4) is per-button-instance, so it correctly allows clicking multiple distinct skip buttons across the ad pod.

### 8.5 Skip Button Injected But Hidden
- **What**: Button exists in DOM but is not yet visible (YouTube's transitional state).
- **Handling**: The visibility check in §4.2 (`offsetParent !== null`) catches this. The button will be skipped until it becomes visible, at which point the next MutationObserver tick will find and click it.

### 8.6 Rapid Navigation
- **What**: User rapidly navigates between multiple videos.
- **Handling**: The 25ms debounce on the MutationObserver callback absorbs rapid DOM changes. The observer itself stays connected — no re-initialization needed.

### 8.7 YouTube Tab in Background
- **What**: User switches to another tab while an ad is playing.
- **Handling**: The content script continues running. When the ad becomes skippable, the skip button click will fire. This is acceptable — YouTube continues playing in background tabs, and users expect the ad to be skipped when they return.

### 8.8 Embedded YouTube Players
- **What**: YouTube videos embedded on third-party sites via `<iframe>`.
- **Handling**: The `host_permissions` and `content_scripts.matches` are scoped to `*://www.youtube.com/*`. Embedded players on other domains are NOT touched. This is intentional — we only auto-skip on youtube.com itself.

### 8.9 YouTube Shorts
- **What**: Short-form vertical videos with a different player UI.
- **Handling**: Shorts use a different ad system. The standard skip button selectors are unlikely to match. The extension gracefully does nothing on Shorts. If Shorts ads become skippable in the future with similar selectors, the observer will pick them up automatically.

### 8.10 YouTube Music (`music.youtube.com`)
- **What**: YouTube's music streaming subdomain.
- **Handling**: The `content_scripts.matches` pattern `*://www.youtube.com/*` does NOT match `music.youtube.com`. YouTube Music is out of scope.

### 8.11 YouTube TV / Living Room Apps
- **What**: YouTube on smart TVs, game consoles.
- **Handling**: Out of scope — Chrome extensions only run in desktop Chrome.

### 8.12 Antidetection / Rate Limiting
- **What**: YouTube may have heuristics to detect automated click patterns.
- **Handling**: The extension clicks only once per skip button and uses native `el.click()`, which is indistinguishable from a user click at the DOM event level. The 2000ms polling interval (not 100ms) is conservative. This approach has been battle-tested by multiple open-source extensions with no widespread detection reports.

---

## 9. Debug Mode

Include a `DEBUG` flag at the top of `content.js`:

```js
const DEBUG = false; // Set to true during development
```

When `true`:
- Log all detected mutations, selector matches, and click attempts to console.
- Log timing information (time from mutation to click).
- Log skipped buttons with reason (e.g., "button found but hidden — waiting").

When `false`:
- Zero console output. Silent operation.

---

## 10. Testing Checklist

### Manual Testing (on youtube.com)

- [ ] Pre-roll ad: Skip button appears → clicked within 25ms
- [ ] Mid-roll ad: Skip button appears during video → clicked within 25ms
- [ ] Ad pod (2 ads): Both skip buttons clicked independently
- [ ] Bumper ad (6s unskippable): No error, no action taken
- [ ] Unskippable ad (15s): Skip button clicked as soon as it appears at 5s
- [ ] SPA navigation (click related video): Observer stays active, next ad skipped
- [ ] SPA navigation (type new URL): Observer stays active, next ad skipped
- [ ] SPA navigation (homepage → watch page): Observer active, ad skipped
- [ ] Toggle OFF via popup: Ads no longer auto-skipped
- [ ] Toggle ON via popup: Ads auto-skipped again
- [ ] Popup shows correct skip count after multiple skips
- [ ] Extension works after browser restart (no manual re-enable needed)
- [ ] No console errors in any scenario
- [ ] No visible UI on the YouTube page
- [ ] Works with YouTube dark theme
- [ ] Works with YouTube light theme

### Automated Testing Considerations

- Unit tests for `isValidButton()` validation logic.
- Unit tests for selector chain fallback.
- Integration test: inject mock DOM with fake skip button, verify it's clicked.
- Not feasible to fully automate on live YouTube due to ad availability randomness.

---

## 11. Research References

- **FadBlock** (0x48piraj): Uses recursive polling at 100ms with class-based ad detection on `#movie_player`. Primary reference for ad detection classes.
- **RemoveAdblockThing**: Multi-selector redundancy approach. Recommends combining `.ytp-ad-skip-button` + `.ytp-ad-skip-button-modern`.
- **Skip YouTube Ads After Update (GreasyFork)**: Uses `getElementsByClassName` with `.ytp-ad-skip-button.ytp-button`. 500ms polling.
- **YouTube Ad Ultimate Blocker (2026)**: Dual-insurance approach — `yt-navigate-finish` event + MutationObserver fallback with 200ms throttling.
- **Open YouTube Optimizer v3.1.1**: Switched from document-wide MutationObserver to event-only SPA detection (`yt-navigate-finish` + `yt-page-data-fetched`) citing performance gains.
- **Best practice consensus (2025–2026)**: MutationObserver + `yt-navigate-finish` event + conservative polling fallback is the gold standard for YouTube extensions.

---

## 12. Implementation Order (for Codex)

1. **`manifest.json`** — Create the extension manifest.
2. **`content.js`** — Implement the core skip logic (sections 4.1–4.9).
3. **`popup/popup.html`** + **`popup/popup.js`** + **`popup/popup.css`** — Build the popup UI.
4. **Icons** — Create/generate the three icon sizes.
5. **`README.md`** — User-facing readme with install instructions.
6. **Test** — Load unpacked in Chrome, verify against the testing checklist (§10).

---

*Spec version: 1.0. Last updated: 2026-07-10.*
