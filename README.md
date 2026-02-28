# Mémora — Digital Photobook

A browser-based interactive photobook creator that treats memory-keeping as a craft. Mémora simulates the physical experience of opening, reading, and building a hardcover photo album — entirely in the browser, with no installation required.

---

## Overview

Most digital photo tools are galleries. Mémora is a book.

The distinction matters. A gallery optimizes for browsing; a book optimizes for telling a story. Mémora is built around that premise: every interaction — from opening the cover to flipping a page — is designed to feel intentional, tactile, and emotionally resonant. The closed-book opening animation is not a flourish; it is the moment that signals *this is something worth sharing.*

The application runs as a zero-dependency, vanilla JavaScript web app deployed on Vercel. Shareable links are powered by Supabase. Everything else lives in the browser.

---

## Features

### Editing

- **Multiple photo layouts** — Single, two-up, trio, and quad grid configurations per page, switchable at any time without losing content.
- **Drag-and-drop photo management** — Photos can be dragged between slots within a page or swapped across pages. Reordering entire spreads is handled through the page tray.
- **Non-destructive crop and reframe** — A pan-and-zoom crop modal lets users reframe any photo without modifying the original. The transform is stored as metadata and applied at render time.
- **Editable cover** — Title, subtitle, and cover photo are all directly editable inline on the closed-book face.
- **Page captions** — Each page supports an optional caption rendered in italic Playfair Display.
- **Add and delete spreads** — Pages can be added or removed at any point during editing.

### Reading Experience

- **Closed-book opening transition** — On load, the app presents a rendered hardcover. Clicking "Open" triggers a CSS 3D rotation of the cover that reveals the first spread underneath, synchronized with a paper sound effect.
- **Realistic 3D page flip** — Forward and backward navigation uses a CSS `@keyframes` animation with `perspective` and `rotateY` transforms. The destination spread is pre-rendered beneath the flipper, so no second render is required on `animationend`.
- **Read mode** — A dedicated read mode strips all editor chrome (layout pickers, drag handles, edit affordances, pen icons) via scoped CSS class toggling. The book becomes a clean reading experience, not a tool.
- **Keyboard navigation** — Arrow keys flip pages when the book is open.
- **Page tray** — A bottom-sheet tray displays thumbnails of all spreads and supports drag-to-reorder.

### Sharing

- **Shareable links** — The share flow uploads the current book state to Supabase and returns a URL. Recipients open the link in read mode — no account, no friction.
- **One-tap copy** — The share modal includes a copy-to-clipboard button with visual confirmation feedback.

### Image Handling

- **HEIC/HEIF support** — Three-tier decode fallback: native `createImageBitmap` (Safari), `<img>` tag decode (OS codec path), and a manual `VideoDecoder` API path that extracts the HEVC bitstream for GPU decoding on non-Safari browsers.
- **Graceful fade-in** — Images are preloaded before display. A skeleton shimmer animation occupies the slot during loading, and photos fade in on decode completion. Respects `prefers-reduced-motion`.

---

## Architecture

The application is split across three files:

| File | Role |
|---|---|
| `index.html` | Landing page with CTA to the editor |
| `editor.html` | Application shell — layout, modals, control surfaces |
| `app.js` | All application logic (~520 lines, vanilla ES6+) |
| `styles.css` | All styles (~776 lines, no preprocessor) |

### State Model

All application state lives in a single `spreads` array:

```javascript
spreads = [
  { type: 'cover', title: 'My Photobook', sub: '2024', photo: null },
  {
    type: 'spread',
    left:  { layout: 'single', photos: [...], caption: '' },
    right: { layout: 'two',    photos: [...], caption: '' }
  },
  ...
]
```

Photos are stored as base64 data URLs in memory. `render()` tears down and rebuilds the visible spread from the `spreads` state on every navigation or edit. This makes the state authoritative and the DOM entirely derived — there is no two-way binding to manage.

### Key Functions

| Function | Purpose |
|---|---|
| `render()` / `buildSpread()` / `buildPage()` | Rebuild DOM from current state |
| `go()` / `goTo()` | Page flip with pre-rendered destination |
| `setLayout()` | Swap photo grid configuration for a page |
| `readImageToDataURL()` | Load images with HEIC/HEIF three-tier fallback |
| `renderTray()` / `openTray()` / `closeTray()` | Thumbnail tray management |
| `bindPhotoDrag()` | Drag-to-swap photo behavior across slots |
| `openShareModal()` / `copyShareLink()` | Supabase upload and link generation |

### Theming

All visual tokens are defined as CSS custom properties:

```css
--cream: #f5f0e8
--warm:  #e8dcc8
--brown: #5c3d2e
--gold:  #c9a84c
```

Typography uses **Playfair Display** (headings, captions, cover) and **Lato** (UI labels, controls), loaded from Google Fonts.

### Mode System

Application state is surfaced through CSS classes on `<body>`:

- `mode-closed` — book is shut; editor chrome is hidden
- `mode-open` — book is open; controls and rails are visible
- `mode-read` — all editor affordances are suppressed via scoped selectors

This approach means the read/edit distinction is entirely in CSS — no conditional rendering logic in JavaScript.

---

## Performance Considerations

**Image preloading.** When navigating to a spread, images for adjacent spreads are preloaded in the background using `new Image()` with an `onload` callback. This eliminates visible decode latency on flip.

**Skeleton shimmer.** While an image is loading, the slot receives a `.loading` class that drives a CSS `background-position` animation to simulate a shimmer. The animation is disabled for users who prefer reduced motion.

**Flip animation architecture.** The page flip overlays a `.flipper-container` div with `backface-visibility: hidden` faces on top of an already-rendered destination spread. When the animation completes, the flipper is removed — the destination is already correct underneath. This avoids a double render on every page turn.

**Debounced auto-save.** Edit events (photo uploads, caption changes, cover edits) are debounced before persisting state, preventing excessive write operations during rapid input.

**CSS 3D compositing.** Photo slots, the book cover, and the flipper all use `will-change: transform` and `transform: translateZ(0)` to promote layers to the GPU compositor, keeping animations at 60fps even on lower-end hardware.

**HEIC decode fallback.** The three-tier HEIC strategy ensures that the most capable decode path available on the current browser is used, with graceful degradation. The `VideoDecoder` path manually extracts the HEVC bitstream and feeds it to the GPU decoder, avoiding a full JavaScript HEIC library dependency.

---

## Deployment

The application is deployed on **Vercel** as a static site. No build step is required — files are served as-is.

**Supabase** provides the backend for the share feature:
- Book state is serialized and uploaded to Supabase storage on share.
- The resulting URL contains a `?share=<id>` query parameter.
- On load, `app.js` reads the `share` param, fetches the stored state, and opens the book in read mode.

No user accounts, authentication, or server-side logic are involved in the editing flow. The share feature is the only network operation.

---

## Future Improvements

- **Persistence without sharing** — Local storage or IndexedDB backup so books survive page refresh without requiring a share link.
- **Export to PDF** — Print-ready PDF generation using the existing layout system.
- **Custom themes** — User-selectable color palettes and font pairings beyond the current warm cream default.
- **Mobile touch support** — Swipe gestures for page flip; pinch-to-zoom in the crop modal.
- **Collaborative editing** — Real-time multi-user editing via Supabase Realtime, treating the `spreads` array as the shared document.
- **Cover templates** — Pre-designed cover layouts beyond the current single-photo format.
- **Video support** — Short clips embedded in photo slots, playing silently in read mode.

---

## Vision

Mémora is built on a conviction that digital memories deserve more than a grid.

The web has made it trivially easy to store thousands of photos. What it has not made easy is the act of curation — choosing which moments matter, arranging them into a sequence, writing the caption that makes a photograph a story. Mémora creates the conditions for that act. The constraint of a book format, the physicality of the page flip, the weight of the cover opening — these are not aesthetic choices. They are the scaffolding for intention.

The goal is a tool that feels like a gift to make and a gift to receive.

---

*Built with vanilla JavaScript, CSS 3D transforms, Supabase, and Vercel.*
