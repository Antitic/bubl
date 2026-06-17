'use strict';

// Cosmetic ad blocking: auto-executes on require. Sets up DOMContentLoaded
// listener that collects page DOM features (ids/classes/hrefs), sends them to
// the main process, which injects matching CSS via insertCSS and runs
// scriptlets via executeJavaScript. Also installs a MutationObserver so
// dynamically injected ad nodes (YouTube, SPAs) get hidden post-load.
// sandbox: false is required on the WebContentsView for this require to work.
try { require('@ghostery/adblocker-electron-preload'); } catch (e) {
  console.warn('[bubl/adblock] cosmetic preload failed:', e.message);
}

// Preload injected into tab web content. Runs with context isolation and
// no API exposed to the page. Its secondary job is to turn a
// decisive horizontal trackpad swipe into a back/forward navigation request,
// mirroring the native "overscroll to go back" gesture (which Electron does
// not enable for embedded views by default).
const { ipcRenderer } = require('electron');

const THRESHOLD = 140;   // accumulated deltaX for a deliberate swipe
const PAUSE_MS = 260;    // gesture is considered finished after this idle gap
const COOLDOWN_MS = 1200;

let accum = 0;
let lastTime = 0;
let cooldownUntil = 0;

window.addEventListener(
  'wheel',
  (e) => {
    const now = Date.now();
    if (now < cooldownUntil) return;

    // Only horizontal-dominant gestures count as a swipe.
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) * 1.4) {
      accum = 0;
      return;
    }

    // Ignore if the element under the pointer can actually scroll sideways
    // (e.g. a carousel) — then the swipe belongs to the page, not navigation.
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (canScrollX(el, e.deltaX)) {
      accum = 0;
      return;
    }

    if (now - lastTime > PAUSE_MS) accum = 0;
    lastTime = now;
    accum += e.deltaX;

    if (accum <= -THRESHOLD) {
      ipcRenderer.send('tab:gesture', 'back');
      reset(now);
    } else if (accum >= THRESHOLD) {
      ipcRenderer.send('tab:gesture', 'forward');
      reset(now);
    }
  },
  { passive: true }
);

function reset(now) {
  accum = 0;
  cooldownUntil = now + COOLDOWN_MS;
}

function canScrollX(el, deltaX) {
  let node = el;
  for (let i = 0; node && i < 6; i++, node = node.parentElement) {
    if (node.scrollWidth > node.clientWidth + 2) {
      const max = node.scrollWidth - node.clientWidth;
      // Can the gesture move this scroller in its direction?
      if (deltaX < 0 && node.scrollLeft > 0) return true;
      if (deltaX > 0 && node.scrollLeft < max) return true;
    }
  }
  return false;
}
