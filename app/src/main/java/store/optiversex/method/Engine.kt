package store.optiversex.method

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.system.Os
import android.system.OsConstants
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.concurrent.thread

class Picked(val name: String, val size: Long, val uri: Uri)

/**
 * Native replacement for the website's ffmpeg.wasm worker.
 * The page keeps ALL of its own logic (probe -> plan -> modes -> patchMp4 -> checks). Only "run this ffmpeg command"
 * is done here, with a real ffmpeg binary (x264, same settings) instead of WebAssembly.
 */
class Engine(private val ctx: Context, private val js: (String) -> Unit) {
    private val ffmpeg = File(ctx.applicationInfo.nativeLibraryDir, "libffmpeg.so").absolutePath
    private val work = File(ctx.cacheDir, "work").also { it.mkdirs() }
    val outFile = File(work, "out.mp4")

    private val picked = CopyOnWriteArrayList<Picked>()
    @Volatile private var proc: Process? = null
    @Volatile private var inPath: String? = null
    private var pfd: ParcelFileDescriptor? = null
    private var copy: File? = null

    private val saves = HashMap<Int, Pair<Uri, OutputStream>>()
    private var saveSeq = 0

    var onBusy: ((Boolean) -> Unit)? = null
    private var running = 0

    // ---------- files the user picked (the WebView file chooser reports them here) ----------
    fun register(uris: Array<Uri>) {
        for (u in uris) {
            var name = "video"
            var size = -1L
            try {
                ctx.contentResolver.query(u, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                    if (c.moveToFirst()) {
                        name = c.getString(0) ?: name
                        if (!c.isNull(1)) size = c.getLong(1)
                    }
                }
                if (size < 0) size = ctx.contentResolver.openFileDescriptor(u, "r")?.use { it.statSize } ?: -1L
            } catch (e: Exception) { /* size stays -1 */ }
            picked.add(Picked(name, size, u))
        }
        while (picked.size > 8) picked.removeAt(0)
    }

    // ---------- make the picked video readable by the ffmpeg process ----------
    fun stage(id: Int, @Suppress("UNUSED_PARAMETER") name: String, size: Long) {
        thread(name = "stage-$id") {
            var ok = false
            var msg = ""
            try {
                release()
                val p = picked.lastOrNull { it.size == size } ?: picked.lastOrNull()
                if (p == null) {
                    msg = "no picked file"
                } else {
                    val ext = p.name.substringAfterLast('.', "mp4").lowercase().filter { it.isLetterOrDigit() }.ifEmpty { "mp4" }
                    var path: String? = null
                    // 1) no copy at all: the child process opens the same open file descriptor (instant, no extra storage)
                    try {
                        val d = ctx.contentResolver.openFileDescriptor(p.uri, "r")
                        if (d != null) {
                            val seekable = try { Os.lseek(d.fileDescriptor, 0L, OsConstants.SEEK_CUR); true } catch (e: Exception) { false }
                            val cand = "/proc/${android.os.Process.myPid()}/fd/${d.fd}"
                            if (seekable && opens(cand)) { pfd = d; path = cand } else d.close()
                        }
                    } catch (e: Exception) { /* fall back to a copy */ }
                    // 2) fallback: one fast native copy into the app cache
                    if (path == null) {
                        val dst = File(work, "input.$ext")
                        dst.delete()
                        ctx.contentResolver.openInputStream(p.uri)!!.use { i -> dst.outputStream().use { o -> i.copyTo(o, 1 shl 20) } }
                        copy = dst
                        path = dst.absolutePath
                    }
                    inPath = path
                    ok = true
                }
            } catch (e: Exception) {
                msg = e.toString()
            }
            js("window.__nat&&window.__nat.cb($id,$ok,${JSONObject.quote(msg)})")
        }
    }

    private fun opens(path: String): Boolean = try {
        val pr = ProcessBuilder(ffmpeg, "-nostdin", "-hide_banner", "-i", path).redirectErrorStream(true).start()
        val txt = pr.inputStream.bufferedReader().readText()
        pr.waitFor()
        !Regex("Permission denied|No such file|Operation not permitted|Is a directory").containsMatchIn(txt)
    } catch (e: Exception) { false }

    fun release() {
        try { pfd?.close() } catch (e: Exception) { }
        pfd = null
        copy?.delete()
        copy = null
        inPath = null
    }

    fun deleteOut() { outFile.delete() }

    // ---------- run ffmpeg ----------
    private fun mapArg(a: String): String = when {
        a == "out.mp4" -> outFile.absolutePath
        a.startsWith("/in/") -> inPath ?: a
        else -> a
    }

    fun exec(id: Int, argsJson: String) {
        thread(name = "ffmpeg-$id") {
            var code = -1
            bump(1)
            try {
                val arr = JSONArray(argsJson)
                val cmd = ArrayList<String>()
                cmd.add(ffmpeg)
                cmd.add("-nostdin")
                for (i in 0 until arr.length()) cmd.add(mapArg(arr.getString(i)))
                val pb = ProcessBuilder(cmd).directory(work)
                pb.environment()["TMPDIR"] = ctx.cacheDir.absolutePath
                pb.redirectOutput(ProcessBuilder.Redirect.DISCARD)
                val pr = pb.start()
                proc = pr
                pump(id, pr.errorStream)
                code = pr.waitFor()
            } catch (e: Exception) {
                logLines(id, listOf("[native] $e"))
                code = 127
            } finally {
                proc = null
                bump(-1)
            }
            js("window.__nat&&window.__nat.done($id,$code)")
        }
    }

    fun cancel() { proc?.destroyForcibly() }

    private fun pump(id: Int, s: InputStream) {
        val buf = ByteArray(8192)
        val line = ByteArrayOutputStream()
        val batch = ArrayList<String>()
        var last = System.currentTimeMillis()
        fun flush() {
            if (batch.isNotEmpty()) { logLines(id, ArrayList(batch)); batch.clear() }
            last = System.currentTimeMillis()
        }
        while (true) {
            val n = s.read(buf)
            if (n < 0) break
            for (i in 0 until n) {
                val b = buf[i].toInt()
                if (b == 10 || b == 13) {
                    if (line.size() > 0) { batch.add(line.toString("UTF-8")); line.reset() }
                } else line.write(b)
            }
            if (batch.size >= 60 || System.currentTimeMillis() - last > 120) flush()
        }
        if (line.size() > 0) batch.add(line.toString("UTF-8"))
        flush()
    }

    private fun logLines(id: Int, lines: List<String>) {
        js("window.__nat&&window.__nat.logs($id,${JSONArray(lines)})")
    }

    private fun bump(d: Int) {
        var busy: Boolean? = null
        synchronized(this) {
            val before = running
            running += d
            if (before == 0 && running > 0) busy = true else if (before > 0 && running == 0) busy = false
        }
        busy?.let { onBusy?.invoke(it) }
    }

    // ---------- save the finished file to Movies/OptiverseX (MediaStore, no storage permission needed) ----------
    fun saveBegin(name: String): Int {
        val v = ContentValues().apply {
            put(MediaStore.Video.Media.DISPLAY_NAME, name)
            put(MediaStore.Video.Media.MIME_TYPE, "video/mp4")
            put(MediaStore.Video.Media.RELATIVE_PATH, "Movies/OptiverseX")
            put(MediaStore.Video.Media.IS_PENDING, 1)
        }
        val uri = ctx.contentResolver.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, v) ?: return -1
        val out = ctx.contentResolver.openOutputStream(uri) ?: return -1
        val h = ++saveSeq
        synchronized(saves) { saves[h] = Pair(uri, out) }
        return h
    }

    fun saveChunk(h: Int, b64: String): Boolean {
        val s = synchronized(saves) { saves[h] } ?: return false
        return try { s.second.write(Base64.decode(b64, Base64.DEFAULT)); true } catch (e: Exception) { false }
    }

    fun saveEnd(h: Int, ok: Boolean): Boolean {
        val s = synchronized(saves) { saves.remove(h) } ?: return false
        try { s.second.close() } catch (e: Exception) { }
        return if (ok) {
            val v = ContentValues().apply { put(MediaStore.Video.Media.IS_PENDING, 0) }
            ctx.contentResolver.update(s.first, v, null, null)
            true
        } else {
            ctx.contentResolver.delete(s.first, null, null)
            false
        }
    }
}
