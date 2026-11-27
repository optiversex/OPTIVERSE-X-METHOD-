/* OPTIVERSE X METHOD - Android app bridge.
 * Loaded first in <head> of the bundled page. The page keeps all of its own Upload Method logic (probe.js: probe, plan,
 * Auto / High / Very High, patchMp4, checks). This file only replaces the browser's ffmpeg.wasm with the app's native
 * ffmpeg, and lets the result be saved to the phone. */
(function () {
  "use strict";
  if (!window.AndroidNative) return;
  window.__isOptiverseApp = true;

  var pend = new Map();   // exec id -> {res, rej, ff}
  var cbs = new Map();    // stage id -> fn(ok, msg)
  var seq = 0;

  window.__nat = {
    logs: function (id, arr) {
      var p = pend.get(id); if (!p) return;
      var f = p.ff._log; if (!f) return;
      for (var i = 0; i < arr.length; i++) { try { f({ type: "stderr", message: arr[i] }); } catch (e) {} }
    },
    done: function (id, code) {
      var p = pend.get(id); if (!p) return;
      pend.delete(id); p.res(code);
    },
    cb: function (id, ok, msg) {
      var f = cbs.get(id); if (!f) return;
      cbs.delete(id); f(ok, msg);
    }
  };

  /* same surface as FFmpegWASM.FFmpeg that the page uses */
  function FFmpeg() { this._log = null; this._dead = false; this._ids = new Set(); }
  FFmpeg.prototype.on = function (ev, fn) { if (ev === "log") this._log = fn; };
  FFmpeg.prototype.off = function (ev) { if (ev === "log") this._log = null; };
  FFmpeg.prototype.load = function () { return Promise.resolve(true); };
  FFmpeg.prototype.exec = function (args) {
    var self = this;
    if (self._dead) return Promise.reject(new Error("called FFmpeg.terminate()"));
    return new Promise(function (res, rej) {
      var id = ++seq; self._ids.add(id);
      pend.set(id, { res: function (c) { self._ids.delete(id); res(c); }, rej: rej, ff: self });
      AndroidNative.exec(id, JSON.stringify(args));
    });
  };
  FFmpeg.prototype.createDir = function () { return Promise.resolve(true); };
  FFmpeg.prototype.deleteDir = function () { return Promise.resolve(true); };
  FFmpeg.prototype.mount = function (type, opts) {
    var f = opts && opts.files && opts.files[0];
    if (!f) return Promise.resolve(false);
    return new Promise(function (res) {
      var id = ++seq;
      cbs.set(id, function (ok) { res(!!ok); });
      AndroidNative.stage(id, f.name || "input.mp4", f.size);
    });
  };
  FFmpeg.prototype.unmount = function () { try { AndroidNative.unstage(); } catch (e) {} return Promise.resolve(true); };
  FFmpeg.prototype.deleteFile = function () { try { AndroidNative.deleteOut(); } catch (e) {} return Promise.resolve(true); };
  FFmpeg.prototype.writeFile = function () { return Promise.reject(new Error("writeFile is not supported in the app")); };
  FFmpeg.prototype.readFile = function () {
    return fetch("/__native/out.mp4", { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("output not found");
      return r.arrayBuffer();
    }).then(function (b) { return new Uint8Array(b); });
  };
  FFmpeg.prototype.terminate = function () {
    this._dead = true;
    try { AndroidNative.cancel(); } catch (e) {}
    var self = this;
    self._ids.forEach(function (id) {
      var p = pend.get(id);
      if (p) { pend.delete(id); p.rej(new Error("called FFmpeg.terminate()")); }
    });
    self._ids.clear();
  };

  window.FFmpegWASM = { FFmpeg: FFmpeg };
  window.FFmpegUtil = { toBlobURL: function (u) { return Promise.resolve(u); } };

  /* ---- "Download" of a finished file: save it into Movies/OptiverseX on the phone ---- */
  function readSlice(blob, o, n) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { var s = String(r.result); res(s.slice(s.indexOf(",") + 1)); };
      r.onerror = function () { rej(r.error); };
      r.readAsDataURL(blob.slice(o, o + n));
    });
  }
  async function saveBlob(url, name) {
    var h = AndroidNative.saveBegin(name || "video.mp4");
    if (h < 0) { alert("Could not create the file on this phone."); return; }
    var ok = false;
    try {
      var blob = await (await fetch(url)).blob();
      var CH = 3 * 1024 * 1024;
      for (var o = 0; o < blob.size; o += CH) {
        var b64 = await readSlice(blob, o, CH);
        if (!AndroidNative.saveChunk(h, b64)) throw new Error("write failed");
      }
      ok = true;
    } catch (e) { ok = false; }
    AndroidNative.saveEnd(h, ok);
  }
  var isBlobDl = function (a) { return a && a.hasAttribute && a.hasAttribute("download") && /^blob:/.test(a.href); };
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest && e.target.closest("a[download]");
    if (isBlobDl(a)) { e.preventDefault(); e.stopPropagation(); saveBlob(a.href, a.getAttribute("download")); }
  }, true);
  var oc = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (isBlobDl(this)) { saveBlob(this.href, this.getAttribute("download")); return; }
    return oc.apply(this, arguments);
  };
})();
