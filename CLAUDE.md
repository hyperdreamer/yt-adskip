# YT AdSkip — Chrome Extension Architecture (HISTORICAL)

> **⚠️ This is the original architecture sketch. For the current, detailed spec, see [AGENTS.md](./AGENTS.md).**

## Overview
A Chrome Manifest V3 extension that automatically clicks YouTube's "Skip Ad" button
as soon as it becomes available. Does NOT block ads — only clicks the skip button.

## Architecture

### Components
1. **manifest.json** — MV3 extension manifest
   - Permissions: storage
   - Content script injected into `*://www.youtube.com/*`
   - Run at `document_idle`

2. **content.js** — Content script injected into YouTube pages
   - Uses MutationObserver to watch DOM for the "Skip" button appearing
   - Targets the YouTube-specific skip button:
     - The button with class `.ytp-ad-skip-button` or `.ytp-skip-ad-button`
     - Or the text "Skip" / "Skip Ad" in a button within `.ytp-ad-text`
   - When detected, clicks it immediately
   - Polling fallback every 1000ms as a safety net
   - Handles SPA navigation (YouTube uses history.pushState)

3. **popup/** (optional) — Popup UI
   - Toggle on/off switch
   - Status indicator

### Detection Strategy
- **Primary**: MutationObserver on `document.body` watching for added nodes
- **Target selectors** (YouTube's known skip button classes):
  - `.ytp-ad-skip-button-modern` (current)
  - `.ytp-ad-skip-button` (legacy)
  - `.ytp-skip-ad-button`
  - Any button containing text "Skip" or "Skip Ad" within the ad overlay
- **Navigation handling**: Listen for `yt-navigate-finish` event (YouTube's custom SPA event)
- **Interval fallback**: `setInterval` every 1000ms as backup

### Files
```
yt-adskip/
├── manifest.json
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
- No ad blocking — only clicks skip
- Silent operation — no visible UI on the page
- Works across SPA navigations
- Small footprint, fast execution

### Constraints
- No build tooling required (no webpack/vite)
- No external API calls
- No tracking/analytics
- Must work with YouTube's current DOM structure (2026)
