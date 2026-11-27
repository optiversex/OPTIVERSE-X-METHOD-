package store.optiversex.method

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast

class MainActivity : Activity() {
    private lateinit var web: WebView
    private lateinit var engine: Engine
    private lateinit var site: Site
    private var chooser: ValueCallback<Array<Uri>>? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 7)
        }

        web = WebView(this)
        web.setBackgroundColor(Color.BLACK)
        setContentView(web)

        engine = Engine(applicationContext) { js ->
            runOnUiThread { try { web.evaluateJavascript(js, null) } catch (e: Exception) { } }
        }
        engine.onBusy = { busy -> runOnUiThread { setBusy(busy) } }
        site = Site(applicationContext, engine)

        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = true
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            cacheMode = WebSettings.LOAD_DEFAULT
            textZoom = 100
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false)
        // keep the page's JavaScript running at full priority while the app is in the background (a video may be encoding)
        web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)

        web.addJavascriptInterface(Bridge(this, engine), "AndroidNative")

        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                site.handle(request)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val h = request.url.host ?: ""
                if (h == "optiversex.store" || h == "www.optiversex.store") return false
                try { startActivity(Intent(Intent.ACTION_VIEW, request.url)) } catch (e: Exception) { }
                return true
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(w: WebView, cb: ValueCallback<Array<Uri>>, p: FileChooserParams): Boolean {
                chooser?.onReceiveValue(null)
                chooser = cb
                return try {
                    startActivityForResult(p.createIntent(), 1)
                    true
                } catch (e: Exception) {
                    chooser = null
                    false
                }
            }
        }

        if (savedInstanceState == null) web.loadUrl("https://optiversex.store/")
        else web.restoreState(savedInstanceState)
    }

    @Suppress("DEPRECATION")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == 1) {
            val uris = WebChromeClient.FileChooserParams.parseResult(resultCode, data)
            if (uris != null) engine.register(uris)
            chooser?.onReceiveValue(uris)
            chooser = null
            return
        }
        super.onActivityResult(requestCode, resultCode, data)
    }

    private fun setBusy(b: Boolean) {
        if (b) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            try { startForegroundService(Intent(this, KeepAliveService::class.java)) } catch (e: Exception) { }
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            stopService(Intent(this, KeepAliveService::class.java))
        }
    }

    fun toast(msg: String) {
        runOnUiThread { Toast.makeText(this, msg, Toast.LENGTH_LONG).show() }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else super.onBackPressed()
    }

    override fun onDestroy() {
        engine.cancel()
        super.onDestroy()
    }
}
