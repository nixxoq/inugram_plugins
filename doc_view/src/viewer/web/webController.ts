import { sanitizeHtml } from '../../web/sanitizer.js'
import {
  showJsAlertDialog,
  showJsConfirmDialog,
  showJsPromptDialog,
} from '../dialogs/viewerDialogs.js'

export interface WebViewControllerOptions {
  themeIndex?: () => number
  density?: () => number
}

let nextChromeClientId = 1
const chromeCallbacks = new Map<
  number,
  {
    onAlert: (message: string, result: JavaObject) => void
    onConfirm: (message: string, result: JavaObject) => void
    onPrompt: (message: string, defaultValue: string, result: JavaObject) => void
  }
>()

let webChromeClientClass: DefinedClass | null = null

function getWebChromeClientClass(): DefinedClass {
  if (!webChromeClientClass) {
    webChromeClientClass = inu.jvm.defineClass({
      superclass: inu.jvm.cls('android.webkit.WebChromeClient'),
      fields: { id: 'int' },
      methods: {
        onJsAlert: {
          params: ['android.webkit.WebView', 'java.lang.String', 'java.lang.String', 'android.webkit.JsResult'],
          returns: 'boolean',
          body: (self, _view, _url, message, result) => {
            try {
              const cbs = chromeCallbacks.get(Number(self.getField('id')))
              if (cbs) {
                cbs.onAlert(String(message ?? ''), result as JavaObject)
                return true
              }
            } catch (err) {
              console.error('[DocViewer] onJsAlert error:', err)
            }
            try { (result as JavaObject).call('confirm') } catch { }
            return true
          },
        },
        onJsConfirm: {
          params: ['android.webkit.WebView', 'java.lang.String', 'java.lang.String', 'android.webkit.JsResult'],
          returns: 'boolean',
          body: (self, _view, _url, message, result) => {
            try {
              const cbs = chromeCallbacks.get(Number(self.getField('id')))
              if (cbs) {
                cbs.onConfirm(String(message ?? ''), result as JavaObject)
                return true
              }
            } catch (err) {
              console.error('[DocViewer] onJsConfirm error:', err)
            }
            try { (result as JavaObject).call('cancel') } catch { }
            return true
          },
        },
        onJsPrompt: {
          params: ['android.webkit.WebView', 'java.lang.String', 'java.lang.String', 'java.lang.String', 'android.webkit.JsPromptResult'],
          returns: 'boolean',
          body: (self, _view, _url, message, defaultValue, result) => {
            try {
              const cbs = chromeCallbacks.get(Number(self.getField('id')))
              if (cbs) {
                cbs.onPrompt(String(message ?? ''), String(defaultValue ?? ''), result as JavaObject)
                return true
              }
            } catch (err) {
              console.error('[DocViewer] onJsPrompt error:', err)
            }
            try { (result as JavaObject).call('cancel') } catch { }
            return true
          },
        },
      },
    })
  }
  return webChromeClientClass
}

export class WebViewController {
  private activity: JavaObject
  private isClosed: () => boolean
  private options: WebViewControllerOptions
  private chromeClientId: number | null = null

  public webView: JavaObject | null = null
  public rawDocumentHtml: string | null = null
  public isJsAllowed = false
  public webZoom = 100

  constructor(
    activity: JavaObject,
    isClosed: () => boolean = () => false,
    options: WebViewControllerOptions = {}
  ) {
    this.activity = activity
    this.isClosed = isClosed
    this.options = options
  }

  public createWebView(): JavaObject {
    const wv = new (inu.jvm.cls('android.webkit.WebView'))(this.activity)
    this.webView = wv

    const s = wv.call('getSettings') as JavaObject
    s.call('setJavaScriptEnabled', false)
    s.call('setBlockNetworkLoads', true)
    s.call('setAllowFileAccess', false)
    s.call('setAllowContentAccess', false)
    try {
      s.call('setAllowFileAccessFromFileURLs', false)
      s.call('setAllowUniversalAccessFromFileURLs', false)
      s.call('setGeolocationEnabled', false)
      s.call('setSaveFormData', false)
      s.call('setSupportZoom', true)
      s.call('setBuiltInZoomControls', true)
      s.call('setDisplayZoomControls', false)
    } catch { }

    const chromeClient = new (getWebChromeClientClass())()
    const id = nextChromeClientId++
    chromeClient.setField('id', id)
    this.chromeClientId = id

    chromeCallbacks.set(id, {
      onAlert: (message, result) => {
        if (this.isClosed()) {
          try { result.call('confirm') } catch { }
          return
        }
        let done = false
        showJsAlertDialog(
          this.activity,
          message,
          () => {
            if (done) return
            done = true
            try { result.call('confirm') } catch { }
          },
          {
            themeIndex: this.options.themeIndex?.(),
            density: this.options.density?.(),
            isClosed: this.isClosed,
          }
        )
      },
      onConfirm: (message, result) => {
        if (this.isClosed()) {
          try { result.call('cancel') } catch { }
          return
        }
        let done = false
        showJsConfirmDialog(
          this.activity,
          message,
          (confirmed) => {
            if (done) return
            done = true
            try {
              if (confirmed) result.call('confirm')
              else result.call('cancel')
            } catch { }
          },
          {
            themeIndex: this.options.themeIndex?.(),
            density: this.options.density?.(),
            isClosed: this.isClosed,
          }
        )
      },
      onPrompt: (message, defaultValue, result) => {
        if (this.isClosed()) {
          try { result.call('cancel') } catch { }
          return
        }
        let done = false
        showJsPromptDialog(
          this.activity,
          message,
          defaultValue,
          (val) => {
            if (done) return
            done = true
            try {
              if (val !== null) result.call('confirm', val)
              else result.call('cancel')
            } catch { }
          },
          {
            themeIndex: this.options.themeIndex?.(),
            density: this.options.density?.(),
            isClosed: this.isClosed,
          }
        )
      },
    })

    wv.call('setWebChromeClient', chromeClient)
    return wv
  }

  public loadHtml(html: string, enableJs: boolean): void {
    if (this.isClosed() || !this.webView) return

    try {
      const MAX_BRIDGE_STRING_BYTES = 1040000
      let safeHtml = html
      if (safeHtml.length > MAX_BRIDGE_STRING_BYTES) {
        console.warn(`[DocViewer] HTML length (${safeHtml.length} bytes) exceeds bridge limit, truncating safely`)
        safeHtml = safeHtml.slice(0, MAX_BRIDGE_STRING_BYTES - 200) + '</div></body></html>'
      }

      const s = this.webView.call('getSettings') as JavaObject
      s.call('setJavaScriptEnabled', enableJs)
      try {
        s.call('setJavaScriptCanOpenWindowsAutomatically', enableJs)
        s.call('setDomStorageEnabled', true)
      } catch { }
      s.call('setBlockNetworkLoads', true)
      s.call('setAllowFileAccess', false)
      s.call('setAllowContentAccess', false)
      try {
        s.call('setAllowFileAccessFromFileURLs', false)
        s.call('setAllowUniversalAccessFromFileURLs', false)
        s.call('setGeolocationEnabled', false)
        s.call('setSaveFormData', false)
      } catch { }

      this.isJsAllowed = enableJs
      this.webView.call('loadDataWithBaseURL', null, safeHtml, 'text/html', 'utf-8', null)
    } catch (err) {
      console.error('[DocViewer] loadHtml error:', err)
      throw err
    }
  }

  public reloadWithSanitization(html: string, allowJs: boolean): void {
    this.rawDocumentHtml = html
    this.loadHtml(sanitizeHtml(html, { allowInlineScripts: allowJs }), allowJs)
  }

  public zoomIn(): void {
    if (!this.webView) return
    try {
      this.webView.call('zoomIn')
      this.webZoom = Math.min(300, this.webZoom + 20)
    } catch { }
  }

  public zoomOut(): void {
    if (!this.webView) return
    try {
      this.webView.call('zoomOut')
      this.webZoom = Math.max(50, this.webZoom - 20)
    } catch { }
  }

  public dispose(): void {
    if (this.chromeClientId !== null) {
      chromeCallbacks.delete(this.chromeClientId)
      this.chromeClientId = null
    }
    if (this.webView) {
      try {
        this.webView.call('stopLoading')
        this.webView.call('setWebChromeClient', null)
        this.webView.call('loadUrl', 'about:blank')
        this.webView.call('destroy')
      } catch { }
      this.webView = null
    }
    this.rawDocumentHtml = null
  }
}