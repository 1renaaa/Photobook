# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **self-contained, single-file web application** — a browser-based interactive digital photobook creator. The entire application lives in one file: `photobook.html`.

**To run:** Open `photobook.html` directly in any modern browser. No build step, server, package manager, or dependencies required.

## Architecture

All HTML, CSS (~240 lines), and JavaScript (~520 lines) are embedded in `photobook.html`. There is no framework — just vanilla ES6+ JavaScript.

### Data Model

The central state is a `spreads` array:
```javascript
spreads = [
  { type: 'cover', title: 'My Photobook', sub: '2024' },
  { type: 'spread', left: { layout, photos: [...], caption }, right: { layout, photos: [...], caption } },
  ...
]
```
Photos are stored as base64 data URLs in memory (lost on page refresh — no persistence layer).

### Key Functions

| Function | Purpose |
|---|---|
| `render()` / `buildSpread()` / `buildPage()` | Regenerate DOM from `spreads` state |
| `go()` / `goTo()` | Page flip with 3D CSS transform animation |
| `setLayout()` | Change photo grid layout for a page |
| `readImageToDataURL()` | Load images including HEIC/HEIF conversion |
| `renderTray()` / `openTray()` / `closeTray()` | Thumbnail tray for all pages |
| `decodeHEICwithVideoDecoder()` | Advanced HEIC decoding via VideoDecoder API |
| `bindPhotoDrag()` | Drag-to-swap photos between slots |

### Theming (CSS Variables)

```css
--cream: #f5f0e8
--warm:  #e8dcc8
--brown: #5c3d2e
--gold:  #c9a84c
```

Fonts: **Playfair Display** (headings), **Lato** (UI) — loaded from Google Fonts.

## Notable Implementation Details

- **HEIC support:** Three-tier fallback — native browser (Safari), Canvas API conversion, VideoDecoder API. Users on non-Safari browsers see a help modal with conversion tips.
- **3D page flip:** CSS `@keyframes` with `cubic-bezier` timing and `perspective`/`rotateY` transforms.
- **Drag & drop:** Used for reordering photos within a page, swapping photos between pages, and reordering pages in the tray.
- **Keyboard navigation:** Arrow keys flip pages.
- **Layouts:** Multiple photo grid configurations (single, two-up, side-by-side, trio) rendered via CSS Grid.
