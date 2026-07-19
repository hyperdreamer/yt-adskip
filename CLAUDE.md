# YT AdSkip — Chrome Extension Architecture (HISTORICAL)

> **⚠️ This is the original architecture sketch. For the current, detailed spec, see [AGENTS.md](./AGENTS.md).**

## Overview
A Chrome Manifest V3 extension that automatically clicks YouTube's "Skip Ad"
button using CDP (Chrome DevTools Protocol) mouse events. CDP generates
`isTrusted: true` clicks — indistinguishable from real user interaction.
Does NOT block ads, does NOT manipulate video playback.

## Architecture

### Components
1. **manifest.json** — MV3 extension manifest
   - Permissions: storage, debugger, management
   - Background service worker for CDP click dispatch
   - Content script injected into `*://www.youtube.com/*`
   - Run at `document_idle`

2. **background.js** — Service worker
   - Handles CDP attach/detach
   - Dispatches `Input.dispatchMouseEvent` (mouseMoved → press → release)
   - Returns `{ok: true/false}` to content script

3. **content.js** — Content script injected into YouTube pages
   - Ad detection via `getAdState()` + CSS classes + `onAdStart`/`onAdFinish`
   - Finds skip button, sends viewport coordinates to background.js
   - 250ms polling loop + SPA navigation handling

4. **popup/** — Popup UI
   - Toggle on/off switch with status indicator
   - Live stats: skips today, total, last skip time
   - Debug overlay toggle
   - Dark/light theme support

### Detection Strategy
- **Primary**: YouTube's internal `getAdState()` API on `#movie_player`
- **Fallback**: CSS class checks (`ad-showing`, `ad-interrupting`)
- **Events**: `onAdStart` / `onAdFinish`
- **Skip selectors**: `.ytp-ad-skip-button-modern`, `.ytp-ad-skip-button`, `.ytp-skip-ad-button`
- **Navigation**: `yt-navigate-finish` event with idempotent re-hook
- **Interval**: 250ms polling

### Files
```
yt-adskip/
├── extension/
│   ├── manifest.json
│   ├── background.js
│   ├── content.js
│   ├── popup/
│   │   ├── popup.html
│   │   ├── popup.js
│   │   └── popup.css
│   └── icons/
│       ├── icon16.png
│       ├── icon48.png
│       └── icon128.png
├── tests/
│   └── test_adskip.py
└── README.md
```

### Key Design Decisions
- No external dependencies — pure vanilla JS
- No ad blocking — only clicks skip
- No video manipulation — zero playback changes
- No tracking/analytics
- Works across SPA navigations

### Constraints
- No build tooling required (no webpack/vite)
- No external API calls
