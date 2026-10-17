export class PdfDocument {
  private pfd: JavaObject | null = null
  private renderer: JavaObject | null = null
  private pageCount: number
  private isClosed = false
  private cache = new Map<number, JavaObject>()
  private cacheOrder: number[] = []
  private readonly maxCacheSize = 5

  constructor(pfd: JavaObject, renderer: JavaObject, pageCount: number) {
    this.pfd = pfd
    this.renderer = renderer
    this.pageCount = pageCount
  }

  getPageCount(): number {
    return this.pageCount
  }

  renderPage(pageIndex: number, screenWidth: number, screenHeight: number): JavaObject {
    if (this.isClosed || !this.renderer) throw new Error('PdfDocument is closed')
    if (pageIndex < 0 || pageIndex >= this.pageCount) {
      throw new Error(`Page index ${pageIndex} out of bounds (0..${this.pageCount - 1})`)
    }

    const cached = this.cache.get(pageIndex)
    if (cached && !Boolean(cached.call('isRecycled'))) {
      const idx = this.cacheOrder.indexOf(pageIndex)
      if (idx !== -1) {
        this.cacheOrder.splice(idx, 1)
        this.cacheOrder.push(pageIndex)
      }
      return cached
    }

    const page = this.renderer.call('openPage', pageIndex) as JavaObject
    try {
      const safePw = Math.max(1, Number(page.call('getWidth')))
      const safePh = Math.max(1, Number(page.call('getHeight')))

      let sc = Math.min((screenWidth * 2.0) / safePw, 2560.0 / Math.max(safePw, safePh))
      sc = Math.max(sc, 0.5)

      const w = Math.max(1, Math.round(safePw * sc))
      const h = Math.max(1, Math.round(safePh * sc))

      const BitmapCls = inu.jvm.cls('android.graphics.Bitmap')
      const argb8888 = inu.jvm.cls('android.graphics.Bitmap$Config').getStaticField('ARGB_8888')

      const bmp = BitmapCls.callStatic('createBitmap', w, h, argb8888) as JavaObject
      bmp.call('eraseColor', -1)
      page.call('render', bmp, null, null, 1)

      this.addToCache(pageIndex, bmp)
      return bmp
    } finally {
      page.call('close')
    }
  }

  private addToCache(pageIndex: number, bmp: JavaObject): void {
    this.cache.set(pageIndex, bmp)
    this.cacheOrder.push(pageIndex)

    while (this.cacheOrder.length > this.maxCacheSize) {
      const oldestIdx = this.cacheOrder.shift()
      if (oldestIdx !== undefined && oldestIdx !== pageIndex) {
        this.cache.delete(oldestIdx)
      }
    }
  }

  prefetch(pageIndex: number, screenWidth: number, screenHeight: number): void {
    if (this.isClosed || pageIndex < 0 || pageIndex >= this.pageCount || this.cache.has(pageIndex)) return

    setTimeout(() => {
      try {
        if (!this.isClosed && !this.cache.has(pageIndex)) {
          this.renderPage(pageIndex, screenWidth, screenHeight)
        }
      } catch { }
    }, 50)
  }

  close(): void {
    if (this.isClosed) return
    this.isClosed = true
    this.cache.clear()
    this.cacheOrder = []

    try { this.renderer?.call('close') } catch { }
    this.renderer = null

    try { this.pfd?.call('close') } catch { }
    this.pfd = null
  }
}

export function openPdfDocument(filePath: string): PdfDocument {
  const ParcelFileDescriptorCls = inu.jvm.cls('android.os.ParcelFileDescriptor')
  const mode = Number(ParcelFileDescriptorCls.getStaticField('MODE_READ_ONLY'))
  const pfd = ParcelFileDescriptorCls.callStatic('open', new (inu.jvm.cls('java.io.File'))(filePath), mode) as JavaObject | null
  if (!pfd) throw new Error('Could not open ParcelFileDescriptor for PDF')

  try {
    const renderer = new (inu.jvm.cls('android.graphics.pdf.PdfRenderer'))(pfd)
    const count = Number(renderer.call('getPageCount'))
    if (count < 1) throw new Error('PDF document has 0 pages')
    return new PdfDocument(pfd, renderer, count)
  } catch (err) {
    try { pfd.call('close') } catch { }
    throw err
  }
}