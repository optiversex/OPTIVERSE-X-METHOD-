/* OptiBirdsX source protection (deterrent only).
 * Add inside <head> of index.html:  <script src="protect.js"></script>
 * It never removes or reloads the page, so a running encode is not interrupted.
 */
(function () {
  'use strict';

  var CHECK_EVERY_MS = 1000;
  var PAUSE_LIMIT_MS = 800;
  var FLASH_MS = 2000;

  var devtoolsOpen = false;
  var flashing = false;
  var flashTimer = null;
  var overlay = null;

  function buildOverlay() {
    var el = document.createElement('div');
    el.setAttribute('data-obx-protect', '');
    el.setAttribute('role', 'alertdialog');
    el.setAttribute('aria-label', 'Protected');
    el.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2147483647', 'display:flex',
      'flex-direction:column', 'align-items:center', 'justify-content:center',
      'gap:12px', 'padding:24px', 'text-align:center', 'background:#0b0f17',
      'color:#fff', 'font-family:system-ui,sans-serif', 'user-select:none'
    ].join(';');
    [
      ['\uD83D\uDD12', 'font-size:64px'],
      ['Protected', 'font-size:32px;font-weight:700'],
      ['Developer tools are not allowed on this site. Close them to continue.',
        'font-size:16px;opacity:.75;max-width:420px']
    ].forEach(function (row) {
      var line = document.createElement('div');
      line.textContent = row[0];
      line.style.cssText = row[1];
      el.appendChild(line);
    });
    return el;
  }

  function render() {
    var show = devtoolsOpen || flashing;
    if (show) {
      if (!overlay || !overlay.isConnected) {
        overlay = buildOverlay();
        document.documentElement.appendChild(overlay);
      }
    } else if (overlay) {
      overlay.remove();
      overlay = null;
    }
  }

  // Put the screen back if someone deletes it while it should be visible.
  new MutationObserver(function () {
    if ((devtoolsOpen || flashing) && overlay && !overlay.isConnected) render();
  }).observe(document.documentElement, { childList: true });

  function flash() {
    flashing = true;
    render();
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { flashing = false; render(); }, FLASH_MS);
  }

  // 1) Right-click menu
  window.addEventListener('contextmenu', function (e) { e.preventDefault(); }, true);

  // 2) DevTools / view-source / save-page shortcuts
  window.addEventListener('keydown', function (e) {
    var c = e.code;
    var mod = e.ctrlKey || e.metaKey;
    var blocked =
      e.key === 'F12' ||
      (mod && e.shiftKey && (c === 'KeyI' || c === 'KeyJ' || c === 'KeyC' || c === 'KeyK')) ||
      (e.metaKey && e.altKey && (c === 'KeyI' || c === 'KeyJ' || c === 'KeyC' || c === 'KeyU')) ||
      (mod && !e.altKey && (c === 'KeyU' || c === 'KeyS'));
    if (!blocked) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    flash();
  }, true);

  // 3) Detect open DevTools. A worker hits `debugger`; with DevTools open it
  //    pauses, so "end" does not arrive in time. The page itself never freezes.
  try {
    var source =
      'onmessage=function(){postMessage("start");debugger;postMessage("end")}';
    var url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    var worker = new Worker(url);
    var busy = false;
    var limit = null;

    worker.onmessage = function (e) {
      if (e.data === 'start') {
        limit = setTimeout(function () { devtoolsOpen = true; render(); }, PAUSE_LIMIT_MS);
        return;
      }
      clearTimeout(limit);
      busy = false;
      // A quick round trip means nothing is pausing the worker any more.
      if (devtoolsOpen && performance.now() - sentAt < PAUSE_LIMIT_MS) {
        devtoolsOpen = false;
        render();
      }
    };

    var sentAt = 0;
    setInterval(function () {
      if (busy || document.hidden) return;
      busy = true;
      sentAt = performance.now();
      worker.postMessage(0);
    }, CHECK_EVERY_MS);
  } catch (err) {
    console.warn('Protection check unavailable:', err);
  }
})();
