# YT AdSkip

A tiny Manifest V3 Chrome extension that automatically clicks YouTube's
**Skip Ad** button the moment it becomes available.

It does **not** block, hide, fast-forward, or mute ads — it only clicks the
official "Skip Ad" button YouTube itself injects.

- Pure vanilla JS — no build step, no dependencies, no tracking
- MutationObserver (primary) + 2-second polling (fallback)
- SPA-aware: survives YouTube's history-based navigation
- On/off toggle and live skip stats in a compact popup

---

## Install (unpacked)

1. Clone or download this repository.
2. Open Chrome and navigate to `chrome://extensions/`.
3. Toggle **Developer mode** on (top-right).
4. Click **Load unpacked** and select the `yt-adskip` directory
   (the one containing `manifest.json`).
5. Visit `https://www.youtube.com/` and start watching. The extension icon
   appears in the toolbar; click it to toggle the extension and view stats.

## Usage

- The extension starts **enabled** by default. No interaction required.
- Click the toolbar icon to open the popup:
  - **Toggle** — enable / disable the auto-skip.
  - **Status** — green dot = active, gray dot = paused.
  - **Stats** — skips today, total skips, and time since the last skip.
- The state is stored in `chrome.storage.local` and persists across browser
  restarts.

## How it works

YouTube injects the skip button into the DOM as soon as an ad becomes
skippable. The content script (`content.js`):

1. Watches `document.body` with a `MutationObserver` and a 25 ms debounce.
2. Runs a multi-selector fallback chain against the player's known button
   classes (`.ytp-ad-skip-button-modern`, `.ytp-ad-skip-button`,
   `.ytp-skip-ad-button`, etc.) plus a final text-match fallback.
3. Validates each candidate before clicking (visible, enabled, non-zero
   size, attached to the DOM, not already clicked).
4. Clicks the button once, then briefly pauses the observer to avoid
   re-triggering on the post-click DOM churn.
5. A 2-second polling timer covers any edge cases the observer misses.
6. `yt-navigate-finish` and `yt-page-data-updated` events re-run detection
   after every SPA navigation so the script stays effective as you move
   between videos.

After each click, the script increments a counter in
`chrome.storage.local` that the popup reads for the stats display.

## Files

```
yt-adskip/
├── manifest.json          # MV3 manifest
├── content.js             # Content script: observer + skip logic
├── popup/
│   ├── popup.html         # Popup UI
│   ├── popup.js           # Toggle + stats
│   └── popup.css          # Dark theme styles
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── AGENTS.md              # Architecture spec
├── CLAUDE.md              # Original architecture sketch
└── README.md              # This file
```

## Privacy

YT AdSkip runs entirely on your machine. It:

- Does not make any network requests.
- Does not collect, store, or transmit any data off your device.
- Only reads from `chrome.storage.local` and writes to the keys `enabled`,
  `stats`, and `today`.
- Only runs on `https://www.youtube.com/*`.

## Limitations

- YouTube Music (`music.youtube.com`) and YouTube Shorts ads are not
  targeted — the content script match pattern is scoped to
  `www.youtube.com` only.
- 6-second "bumper" ads have no skip button, so the script has nothing to
  click. This is correct behavior.
- Embedded YouTube players on third-party sites are out of scope.

## License

MIT.
