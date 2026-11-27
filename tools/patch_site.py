#!/usr/bin/env python3
"""Builds app/src/main/assets/site from site-src/ (your website files).
To update the app after changing the website: copy the new website files into site-src/ and build again.
Every patch must match exactly once; if the website changed so a patch no longer matches, this stops with a clear message."""
import os, shutil, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "site-src")
DST = os.path.join(ROOT, "app", "src", "main", "assets", "site")

shutil.rmtree(DST, ignore_errors=True)
shutil.copytree(SRC, DST)
shutil.copy(os.path.join(ROOT, "tools", "app-bridge.js"), os.path.join(DST, "app-bridge.js"))

p = os.path.join(DST, "index.html")
s = open(p, encoding="utf-8").read()

PATCHES = [
    # 1. load the bridge first
    ('<head>\n<meta name="x-wm"', '<head>\n<script src="/app-bridge.js"></script>\n<meta name="x-wm"'),
    # 2. the engine is built into the app: always "installed", nothing to download
    ("async function hasCore(){\n  if(wasmBlob)return true;\n  try{if(!self.caches)return false;const c=await caches.open(CACHE);return !!(await c.match(CKEY))}catch(e){return false}\n}",
     "async function hasCore(){return true}"),
    ("async function coreURLs(){\n", "async function coreURLs(){\n  return{coreURL:'native',wasmURL:'native'};\n"),
    # 3. do not copy the video into browser storage: the app opens the picked file directly
    ("async function opfsRoot(){try{return navigator.storage&&navigator.storage.getDirectory?await navigator.storage.getDirectory():null}catch(e){return null}}",
     "async function opfsRoot(){return null}"),
    ("MEM_LIMIT=1.5*1073741824,STALL_MS", "MEM_LIMIT=0,STALL_MS"),
]
for old, new in PATCHES:
    n = s.count(old)
    if n != 1:
        sys.exit("PATCH FAILED (matched %d times, expected 1): %r" % (n, old[:70]))
    s = s.replace(old, new)
open(p, "w", encoding="utf-8").write(s)
print("site patched OK ->", DST)
