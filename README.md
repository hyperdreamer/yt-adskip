# YT AdSkip

A tiny Manifest V3 Chrome extension that automatically clicks YouTube's
"Skip Ad" button using Chrome DevTools Protocol (CDP). CDP generates
real mouse events (`isTrusted: true`) that YouTube accepts.

It does **not** block ads — the ads load normally, then the skip button is
clicked like a real user would.

- CDP `Input.dispatchMouseEvent` via `chrome.debugger` — YouTube accepts the click
- No video-speed manipulation — zero playback changes
- Pure vanilla JS — no build step, no dependencies, no tracking
- 250 ms polling + YouTube's native `onAdStart`/`onAdFinish` events
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

YouTube rejects synthetic click events (`isTrusted` check), so DOM-synthesized
clicks are ignored. The extension uses CDP to generate real mouse events:

1. **Ad detection** — Uses YouTube's internal `getAdState()` API on
   `#movie_player` plus CSS class checks (`ad-showing`, `ad-interrupting`).
   Also hooks YouTube's `onAdStart`/`onAdFinish` player events.

2. **CDP click** — The content script finds the skip button, computes its
   viewport center coordinates, and sends them to the background service
   worker. The background worker attaches `chrome.debugger`, dispatches
   `mouseMoved` → `mousePressed` → `mouseReleased`, then detaches. These
   events have `isTrusted: true` — YouTube accepts them as real user clicks.

3. **Ad ends naturally** — No video manipulation needed. The ad finishes
   as if the user clicked Skip themselves.

A 250 ms polling loop and `yt-navigate-finish` event listener keep detection
working across SPA navigations.

After each ad detection, the script increments a counter in
`chrome.storage.local` that the popup reads for the stats display.

## Files

```
yt-adskip/
├── manifest.json          # MV3 manifest
├── background.js          # CDP mouse click handler (service worker)
├── content.js             # Ad detection + CDP click
├── popup/
│   ├── popup.html         # Popup UI
│   ├── popup.js           # Toggle + stats
│   └── popup.css          # Dark theme styles
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   ├── icon128.png
├── README.md
├── TESTING.md
```

## Privacy

YT AdSkip runs entirely on your machine. It:

- Does not make any network requests.
- Does not collect, store, or transmit any data off your device.
- Only reads from `chrome.storage.local` and writes to the keys `enabled`,
  `stats`, `today`, and `debugOverlay`.
- Only runs on `https://www.youtube.com/*`.

## Limitations

- YouTube Music (`music.youtube.com`) and YouTube Shorts ads are not
  targeted — the content script match pattern is scoped to
  `www.youtube.com` only.
- 6-second "bumper" ads have no skip button — cannot be skipped.
- Embedded YouTube players on third-party sites are out of scope.

## License

MIT.
