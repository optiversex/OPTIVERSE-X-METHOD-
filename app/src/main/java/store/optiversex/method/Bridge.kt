package store.optiversex.method

import android.webkit.JavascriptInterface

/** What the page's app-bridge.js can call. Everything long-running is asynchronous and answers through window.__nat. */
class Bridge(private val act: MainActivity, private val engine: Engine) {
    @JavascriptInterface fun stage(id: Int, name: String, size: Double) = engine.stage(id, name, size.toLong())
    @JavascriptInterface fun unstage() = engine.release()
    @JavascriptInterface fun exec(id: Int, argsJson: String) = engine.exec(id, argsJson)
    @JavascriptInterface fun cancel() = engine.cancel()
    @JavascriptInterface fun deleteOut() = engine.deleteOut()

    @JavascriptInterface fun saveBegin(name: String): Int = engine.saveBegin(name)
    @JavascriptInterface fun saveChunk(h: Int, b64: String): Boolean = engine.saveChunk(h, b64)
    @JavascriptInterface fun saveEnd(h: Int, ok: Boolean): Boolean {
        val r = engine.saveEnd(h, ok)
        act.toast(if (r) "Saved to Movies/OptiverseX" else "Could not save the file")
        return r
    }
}
