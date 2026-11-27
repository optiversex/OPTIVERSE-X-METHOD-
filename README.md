# OPTIVERSE X METHOD (Android app)

The app opens your website (https://optiversex.store) with its static files stored inside the APK, so the screen is
identical to the site. Login, cards, trial and every /api call still go to your real server. The Upload Method runs your
site's own logic (site-src/cxeng/probe.js: probe, plan, Auto / High / Very High, MP4 patch, checks); only the
"run ffmpeg" step is done by a native ffmpeg (x264, same settings) instead of the browser's ffmpeg.wasm.

## Build the APK (nothing to install on your PC)
1. Create a PRIVATE GitHub repository and upload everything from this folder (keep the .github folder).
2. Open the repository -> Actions -> "Build APK" -> Run workflow.
3. The first run builds ffmpeg for Android (about 15-25 minutes); later runs are fast (it is cached).
4. When the run is green, download the artifact "OPTIVERSE-X-METHOD-apk", unzip it and install the .apk.
   Needs Android 10 or newer on a 64-bit phone.

If a step fails, open the red step, copy the last 40 lines of its log and send them over.

## Updating the website part
Copy the changed website files into site-src/ and run the workflow again. tools/patch_site.py applies the few
app-specific changes and stops with a clear message if the website changed in a way it does not recognise.

## Left out on purpose
config.js, worker.js, wrangler.jsonc (secrets / server code) and the 32 MB wasm engine (not needed).
release.keystore is the signing key used for every build, so updates install over the old app.
