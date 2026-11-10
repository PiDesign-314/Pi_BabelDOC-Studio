/* 反色阅读 — display-only night mode for the reader's PDF pages.
 *
 * The whole page stack (page canvas, transparent text layer, selection bands,
 * ghost bands, highlight / hand-underline / ink overlays) lives inside
 * `.r-page`, so a single CSS filter there inverts it as one unit — see
 * web/reverse-reading.css.  Nothing here touches the PDF file, the annotation
 * store or any export: the mode is a pure display transform and its state is a
 * reader preference in localStorage, independent of the app theme (#btn-theme).
 *
 * The script is loaded from <head> and restores the saved state synchronously,
 * before the first paint, so a restored session never flashes the white paper
 * page.  The class is set on <html> (the CSS hook) and mirrored onto <body>
 * once it exists, so `body.invert-reading` is also available as the public
 * hook for tests/extensions.
 */
(function () {
  "use strict";

  var KEY = "babeldoc-reader:invert";
  var CLASS = "invert-reading";
  var root = document.documentElement;
  var button = null;

  function read() {
    try {
      return window.localStorage.getItem(KEY) === "1";
    } catch (error) {
      /* storage blocked (private mode / file://): default to the paper page */
      return false;
    }
  }

  function write(on) {
    try {
      window.localStorage.setItem(KEY, on ? "1" : "0");
    } catch (error) {
      /* keep working for this page even if the preference cannot persist */
    }
  }

  function paint(on) {
    root.classList.toggle(CLASS, on);
    if (document.body) document.body.classList.toggle(CLASS, on);
    if (button) {
      button.classList.toggle("on", on);
      button.setAttribute("aria-pressed", on ? "true" : "false");
    }
    return on;
  }

  function isOn() {
    return root.classList.contains(CLASS);
  }

  function set(on) {
    write(on);
    return paint(on);
  }

  function toggle() {
    return set(!isOn());
  }

  function init() {
    button = document.getElementById("btn-invert");
    paint(read());
    if (button) {
      button.addEventListener("click", function (event) {
        event.preventDefault();
        toggle();
      });
    }
  }

  /* Parse-time restore: <head> script, i.e. before the first paint. */
  paint(read());

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  /* Another tab toggled the switch. */
  window.addEventListener("storage", function (event) {
    if (event.key === KEY) paint(read());
  });

  /* Restored from the back/forward cache without re-running the script. */
  window.addEventListener("pageshow", function (event) {
    if (event.persisted) paint(read());
  });

  window.StudioReverseReading = {
    KEY: KEY,
    isOn: isOn,
    set: set,
    toggle: toggle,
  };
})();
