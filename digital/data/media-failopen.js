/*
 * media-failopen.js — keeps the presentation alive when a media file will not load.
 *
 * Why this exists
 * ---------------
 * The iSpring player gates slide advancement on media readiness. In player.js:
 *
 *     ready() { return nj(this) && this.Ne }
 *
 * `Ne` is set only by the "canplay" / "canplaythrough" / "loadeddata" events. There is no error
 * listener and no timeout anywhere in that path, so a media file that never becomes playable
 * leaves the gate closed forever and the deck stops dead on a spinner. That is exactly what
 * happened when Git LFS pointer stubs were served in place of the real mp3/mp4 files.
 *
 * Two things worth knowing before changing this file
 * --------------------------------------------------
 * 1. The trigger is NOT the "error" event. Because sources are declared with a child <source>
 *    element, the error fires on the <source>, and the media element's own `.error` property
 *    stays null (verified: readyState 0, networkState 3, error null). Anything keyed on `error`
 *    would never fire. We watch networkState instead.
 *
 * 2. Every <audio> in this deck carries preload="none", so sitting at readyState 0 with
 *    networkState 1 (IDLE) is the correct, healthy resting state for an unplayed sound. A naive
 *    "readyState is still 0 after N seconds" timeout would replace all 89 of them with silence.
 *    The stall timer below only runs while networkState is 2 (LOADING).
 *
 * What it does
 * ------------
 * Watches every <audio>/<video> the player creates. If one cannot load, it swaps in a tiny valid
 * placeholder so the browser fires "canplay" naturally, the player's gate opens, and the deck
 * carries on. A silent moment or a black frame is acceptable; a dead page is not.
 *
 * Deliberately dependency-free, and loaded BEFORE player.js so it is watching from the start.
 */
(function () {
  'use strict';

  var AUDIO_FALLBACK = 'data/_silent.mp3';

  // Two video placeholders. H.264 is right for essentially every browser, but a handful of
  // Linux Chromium/Firefox builds ship without proprietary codecs — in those, an H.264
  // placeholder would fail to load exactly like the file it is replacing, and the deck would
  // stall anyway. Pick a container the browser will admit to supporting.
  var VIDEO_FALLBACKS = [
    { src: 'data/_blank.mp4', type: 'video/mp4; codecs="avc1.42E01E"' },
    { src: 'data/_blank.webm', type: 'video/webm; codecs="vp8"' }
  ];

  // How long an element may sit in NETWORK_LOADING without reaching HAVE_CURRENT_DATA before we
  // give up on it. Generous, because real media on a slow connection must not be cut off. The
  // networkState check catches outright failures in milliseconds, so this is only the backstop
  // for a genuinely stalled transfer.
  var STALL_MS = 20000;

  var NETWORK_LOADING = 2;    // HTMLMediaElement.NETWORK_LOADING
  var NETWORK_NO_SOURCE = 3;  // HTMLMediaElement.NETWORK_NO_SOURCE
  var HAVE_CURRENT_DATA = 2;  // HTMLMediaElement.HAVE_CURRENT_DATA

  var watched = [];  // { el: HTMLMediaElement, loadingSince: number }
  var ticker = null;

  function videoFallback() {
    try {
      var probe = document.createElement('video');
      for (var i = 0; i < VIDEO_FALLBACKS.length; i++) {
        if (probe.canPlayType && probe.canPlayType(VIDEO_FALLBACKS[i].type)) {
          return VIDEO_FALLBACKS[i].src;
        }
      }
    } catch (e) { /* fall through */ }
    return VIDEO_FALLBACKS[0].src;
  }

  function isPlaceholder(url) {
    return url.indexOf('_silent.mp3') !== -1 || url.indexOf('_blank.') !== -1;
  }

  function failOpen(entry, reason) {
    var el = entry.el;
    if (entry.done) return;
    entry.done = true;

    var current = el.currentSrc || el.getAttribute('src') || '';
    // Never recurse into replacing a placeholder with another placeholder.
    if (isPlaceholder(current)) return;

    try {
      if (window.console && console.warn) {
        console.warn('[media-failopen] ' + reason + ' — substituting placeholder for: ' +
          (current || '(no src)'));
      }

      // Drop any <source> children; they take precedence over the src attribute.
      var sources = el.getElementsByTagName('source');
      while (sources.length) sources[0].parentNode.removeChild(sources[0]);

      el.setAttribute('src', el.tagName === 'VIDEO' ? videoFallback() : AUDIO_FALLBACK);
      el.load();
    } catch (e) {
      /* Never let the shim itself throw into the player. */
    }
  }

  function tick() {
    var now = new Date().getTime();
    var live = 0;

    for (var i = 0; i < watched.length; i++) {
      var entry = watched[i];
      if (entry.done) continue;
      live++;

      var el = entry.el;

      // Healthy: enough data to play. Nothing to do, ever again.
      if (el.readyState >= HAVE_CURRENT_DATA) { entry.done = true; continue; }

      // Hard failure: the browser exhausted every candidate source.
      if (el.networkState === NETWORK_NO_SOURCE) {
        failOpen(entry, 'networkState=NETWORK_NO_SOURCE');
        continue;
      }

      // Stall detection — ONLY while actually loading. An element at networkState 1 (IDLE) with
      // preload="none" is behaving correctly and must be left alone, however long it sits there.
      if (el.networkState === NETWORK_LOADING) {
        if (!entry.loadingSince) entry.loadingSince = now;
        else if (now - entry.loadingSince > STALL_MS) {
          failOpen(entry, 'stalled in NETWORK_LOADING for ' + STALL_MS + 'ms');
        }
      } else {
        entry.loadingSince = 0;
      }
    }

    if (!live && ticker) { clearInterval(ticker); ticker = null; }
  }

  function watch(el) {
    if (el.__failOpenWatched) return;
    el.__failOpenWatched = true;

    var entry = { el: el, loadingSince: 0, done: false };
    watched.push(entry);

    // Belt and braces: a direct error on the element. This fires when src is set as an attribute
    // rather than via <source> — which is the path the shim itself uses, and the path the player
    // uses for dynamically created elements.
    if (el.addEventListener) {
      el.addEventListener('error', function () {
        if (el.readyState < HAVE_CURRENT_DATA) failOpen(entry, 'error event');
      }, false);
    }

    if (!ticker) ticker = setInterval(tick, 250);
  }

  function sweep(root) {
    var scope = root && root.querySelectorAll ? root : document;
    var els = scope.querySelectorAll('audio,video');
    for (var i = 0; i < els.length; i++) watch(els[i]);
  }

  // Catch elements the player creates later.
  if (typeof MutationObserver === 'function') {
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var added = records[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (n.nodeType !== 1) continue;
          if (n.tagName === 'AUDIO' || n.tagName === 'VIDEO') watch(n);
          else sweep(n);
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  } else {
    setInterval(function () { sweep(document); }, 1000);
  }

  sweep(document);
  if (document.addEventListener) {
    document.addEventListener('DOMContentLoaded', function () { sweep(document); }, false);
  }
})();
