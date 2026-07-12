# YT AdSkip

A tiny Manifest V3 Chrome extension that automatically skips YouTube
ads. It uses Chrome DevTools Protocol (CDP) to generate real mouse
clicks (`isTrusted: true`) on the skip button, with a video-speed
fallback (16× playback + seek) for bumper ads and edge cases.

It does **not** block or hide ads — the ads still load normally.

- CDP clicks via `chrome.debugger` `Input.dispatchMouseEvent` — YouTube accepts them
- Video-speed fallback for unskippable bumper ads or CDP failures
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
clicks (`.click()`, `MouseEvent`) are ignored. The extension uses a two-tier
approach:

1. **CDP click** (primary) — The content script finds the skip button, sends
   its viewport coordinates to the background service worker, which attaches
   Chrome DevTools Protocol and dispatches real `mouseMoved` →
   `mousePressed` → `mouseReleased` events. These have `isTrusted: true` and
   YouTube accepts them.

2. **Video-speed** (fallback) — For bumper ads with no skip button, or when
   CDP fails (debugger already attached), the content script sets the video's
   `playbackRate` to 16× and mutes audio, then seeks `currentTime` to near
   `duration` to trigger ad completion.

3. **Ad detection** — Uses YouTube's internal `getAdState()` API on
   `#movie_player` plus CSS class checks (`ad-showing`, `ad-interrupting`).
   Also hooks YouTube's `onAdStart`/`onAdFinish` player events for
   reliable ad-lifecycle tracking.

4. **Restore** — When the ad finishes (detected via `onAdFinish` or polling),
   restores the original `playbackRate` and mute state so the main video
   plays normally.

A 250 ms polling loop and `yt-navigate-finish` event listener keep detection
working across SPA navigations.

After each ad detection, the script increments a counter in
`chrome.storage.local` that the popup reads for the stats display.

## Files

```
yt-adskip/
├── manifest.json          # MV3 manifest
├── background.js          # CDP mouse click handler (service worker)
├── content.js             # Content script: ad detection + CDP click + video-speed
├── popup/
│   ├── popup.html         # Popup UI
│   ├── popup.js           # Toggle + stats
│   └── popup.css          # Dark theme styles
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   ├── icon128.png
├── README.md
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
- 6-second "bumper" ads still get sped through — no skip button needed.
- Embedded YouTube players on third-party sites are out of scope.

## License

MIT.
