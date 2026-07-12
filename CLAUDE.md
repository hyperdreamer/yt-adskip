# YT AdSkip — Chrome Extension Architecture (HISTORICAL)

> **⚠️ This is the original architecture sketch. For the current, detailed spec, see [AGENTS.md](./AGENTS.md).**

## Overview
A Chrome Manifest V3 extension that automatically skips YouTube ads.
Primary approach: CDP (Chrome DevTools Protocol) mouse clicks on the skip button
(`isTrusted: true`). Fallback: video-speed manipulation (16× playbackRate + seek).
Does NOT block ads — only skips them.

## Architecture

### Components
1. **manifest.json** — MV3 extension manifest
   - Permissions: storage, debugger
   - Background service worker for CDP click dispatch
   - Content script injected into `*://www.youtube.com/*`
   - Run at `document_idle`

2. **background.js** — Service worker
   - Handles CDP attach/detach
   - Dispatches `Input.dispatchMouseEvent` at viewport coordinates
   - Returns `{ok: true/false}` to content script

3. **content.js** — Content script injected into YouTube pages
   - Ad detection via `getAdState()` API + CSS classes + `onAdStart`/`onAdFinish` events
   - CDP click: sends skip button coordinates to background.js
   - Video-speed fallback: 16× playbackRate + seek to near duration
   - 250ms polling loop + SPA navigation handling

4. **popup/** — Popup UI
   - Toggle on/off switch with status indicator
   - Live stats: skips today, total, last skip time
   - Debug overlay toggle
   - Dark/light theme support

### Detection Strategy
- **Primary**: YouTube's internal `getAdState()` API on `#movie_player`
- **Fallback**: CSS class checks (`ad-showing`, `ad-interrupting`)
- **Events**: `onAdStart` / `onAdFinish` for reliable lifecycle tracking
- **Skip selectors**: `.ytp-ad-skip-button-modern`, `.ytp-ad-skip-button`, `.ytp-skip-ad-button`
- **Navigation handling**: `yt-navigate-finish` event with idempotent re-hook
- **Interval**: 250ms polling as continuous safety net

### Files
```
yt-adskip/
├── manifest.json
├── background.js
├── content.js
├── popup/
│   ├── popup.html
│   ├── popup.js
│   └── popup.css
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

### Key Design Decisions
- No external dependencies — pure vanilla JS
- No ad blocking — only skips ads (CDP click + video-speed)
- No tracking/analytics
- Works across SPA navigations
- Small footprint, fast execution

### Constraints
- No build tooling required (no webpack/vite)
- No external API calls
- Must work with YouTube's current DOM structure (2026)
