package store.optiversex.method

import android.content.Context
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.io.FileInputStream
import java.io.IOException
import java.io.InputStream

/**
 * The page lives at its real address (https://optiversex.store) so cookies, login and /api calls behave exactly like
 * the website. Only the static files are answered from inside the APK (instant start); /api/* goes to the real server.
 */
class Site(private val ctx: Context, private val engine: Engine) {
    private val hosts = setOf("optiversex.store", "www.optiversex.store")

    fun handle(req: WebResourceRequest): WebResourceResponse? {
        val u = req.url
        if (u.host !in hosts) return null
        val path = u.path ?: "/"
        if (path.startsWith("/api/")) return null
        if (path == "/__native/out.mp4") return serveOut(req)
        if (req.method != "GET" && req.method != "HEAD") return null
        var rel = path.trim('/')
        if (rel.isEmpty()) rel = "index.html"
        for (c in listOf(rel, "$rel.html")) {
            val r = serveAsset("site/$c", req)
            if (r != null) return r
        }
        return null   // not bundled -> normal network request
    }

    private fun serveAsset(p: String, req: WebResourceRequest): WebResourceResponse? {
        val mime = mimeOf(p)
        if (mime.startsWith("video/")) {
            val len = try { ctx.assets.openFd(p).use { it.length } } catch (e: IOException) { return null }
            return ranged(req, mime, len, "public, max-age=86400") { start ->
                val s = ctx.assets.openFd(p).createInputStream()
                skipFully(s, start)
                s
            }
        }
        val st = try { ctx.assets.open(p) } catch (e: IOException) { return null }
        val text = mime.startsWith("text/") || mime.contains("javascript") || mime.contains("json") || mime.contains("svg")
        return WebResourceResponse(mime, if (text) "utf-8" else null, 200, "OK", mapOf("Cache-Control" to "no-cache"), st)
    }

    private fun serveOut(req: WebResourceRequest): WebResourceResponse {
        val f = engine.outFile
        if (!f.exists()) {
            return WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
        }
        return ranged(req, "video/mp4", f.length(), "no-store") { start ->
            val s = FileInputStream(f)
            s.channel.position(start)
            s
        }
    }

    private fun ranged(req: WebResourceRequest, mime: String, len: Long, cache: String, open: (Long) -> InputStream): WebResourceResponse {
        val rh = req.requestHeaders["Range"] ?: req.requestHeaders["range"]
        var start = 0L
        var end = len - 1
        var partial = false
        if (rh != null && rh.startsWith("bytes=")) {
            val spec = rh.substring(6).split(",")[0].trim()
            val a = spec.substringBefore('-')
            val b = spec.substringAfter('-', "")
            if (a.isEmpty()) {
                start = maxOf(0L, len - (b.toLongOrNull() ?: 0L))
            } else {
                start = a.toLongOrNull() ?: 0L
                if (b.isNotEmpty()) end = minOf(end, b.toLongOrNull() ?: end)
            }
            partial = true
        }
        if (len <= 0L || start >= len || start > end) {
            return WebResourceResponse(mime, null, 416, "Range Not Satisfiable",
                mapOf("Content-Range" to "bytes */$len"), ByteArrayInputStream(ByteArray(0)))
        }
        val n = end - start + 1
        val h = HashMap<String, String>()
        h["Accept-Ranges"] = "bytes"
        h["Content-Length"] = n.toString()
        h["Cache-Control"] = cache
        if (partial) h["Content-Range"] = "bytes $start-$end/$len"
        val body = Limited(open(start), n)
        return if (partial) WebResourceResponse(mime, null, 206, "Partial Content", h, body)
        else WebResourceResponse(mime, null, 200, "OK", h, body)
    }

    private fun skipFully(s: InputStream, n: Long) {
        var left = n
        while (left > 0) {
            val k = s.skip(left)
            if (k <= 0) { if (s.read() < 0) break else left-- } else left -= k
        }
    }

    private class Limited(private val s: InputStream, private var left: Long) : InputStream() {
        override fun read(): Int {
            if (left <= 0) return -1
            val r = s.read()
            if (r >= 0) left--
            return r
        }
        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (left <= 0) return -1
            val n = s.read(b, off, minOf(len.toLong(), left).toInt())
            if (n > 0) left -= n
            return n
        }
        override fun close() = s.close()
    }

    private fun mimeOf(p: String): String = when (p.substringAfterLast('.', "").lowercase()) {
        "html", "htm" -> "text/html"
        "js", "mjs" -> "text/javascript"
        "css" -> "text/css"
        "json" -> "application/json"
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "ico" -> "image/x-icon"
        "svg" -> "image/svg+xml"
        "mp4" -> "video/mp4"
        "txt" -> "text/plain"
        "woff2" -> "font/woff2"
        "woff" -> "font/woff"
        else -> "application/octet-stream"
    }
}
