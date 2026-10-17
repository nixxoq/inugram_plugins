import { t } from '../../i18n/index.js'
import { settings } from '../../settings.js'
import { registerTouch } from '../core/viewerListeners.js'
import { dp, runOnUiThread } from '../core/viewerUiUtils.js'

export interface ImageGesturesCallback {
  onSingleTap: () => void
  onPagePrev?: () => void
  onPageNext?: () => void
  onSubtitleUpdate?: () => void
  isMinimalMode?: boolean
}

export class ImageTransformController {
  private activity: JavaObject
  private density: number
  private isClosed: () => boolean

  public srcBitmap: JavaObject | null = null
  public imageBitmap: JavaObject | null = null
  public imageMatrix: JavaObject | null = null
  public matrixValues: JavaObject | null = null

  public currentScale = 1.0
  public fitScale = 1.0
  public minScale = 1.0
  public transX = 0
  public transY = 0
  public imageWidth = 0
  public imageHeight = 0
  public rawWidth = 0
  public rawHeight = 0
  public rotDeg = 0
  public isInverted = false

  constructor(activity: JavaObject, density = 1.0, isClosed: () => boolean = () => false) {
    this.activity = activity
    this.density = density
    this.isClosed = isClosed

    try {
      const floatType = inu.jvm.cls('java.lang.Float').getStaticField('TYPE') as JavaObject
      this.matrixValues = inu.jvm.cls('java.lang.reflect.Array').callStatic('newInstance', floatType, 9) as JavaObject
      this.imageMatrix = new (inu.jvm.cls('android.graphics.Matrix'))()
    } catch (err) {
      console.warn('[DocViewer] Matrix init error:', err)
    }
  }

  public curScale(): number {
    if (!this.imageMatrix || !this.matrixValues) return 1.0
    try {
      this.imageMatrix.call('getValues', this.matrixValues)
      return Number(inu.jvm.cls('java.lang.reflect.Array').callStatic('getFloat', this.matrixValues, 0)) || 1.0
    } catch {
      return 1.0
    }
  }

  public fixBounds(viewW: number, viewH: number): void {
    const rw = this.imageWidth * this.currentScale
    const rh = this.imageHeight * this.currentScale

    if (rw <= viewW) this.transX = (viewW - rw) / 2.0
    else if (this.transX > 0) this.transX = 0.0
    else if (this.transX + rw < viewW) this.transX = viewW - rw

    if (rh <= viewH) this.transY = (viewH - rh) / 2.0
    else if (this.transY > 0) this.transY = 0.0
    else if (this.transY + rh < viewH) this.transY = viewH - rh
  }

  public applyImageMatrix(imageView: JavaObject | null): void {
    if (!imageView || !this.imageMatrix) return
    runOnUiThread(
      this.activity,
      () => {
        try {
          if (!imageView || !this.imageMatrix) return
          this.imageMatrix.call('reset')
          this.imageMatrix.call('postScale', this.currentScale * 1.0, this.currentScale * 1.0)
          this.imageMatrix.call('postTranslate', this.transX * 1.0, this.transY * 1.0)
          imageView.call('setImageMatrix', this.imageMatrix)
          imageView.call('invalidate')
        } catch (err) {
          console.error('[DocViewer] applyImageMatrix error:', err)
        }
      },
      this.isClosed
    )
  }

  public resetImage(imageView: JavaObject | null, viewW: number, viewH: number): void {
    if (!this.imageBitmap || !imageView || !this.imageMatrix) return
    runOnUiThread(
      this.activity,
      () => {
        try {
          if (!this.imageBitmap || !imageView || !this.imageMatrix) return
          if (viewW <= 0 || viewH <= 0 || this.imageWidth <= 0 || this.imageHeight <= 0) return

          const pageFit = Math.min(viewW / this.imageWidth, viewH / this.imageHeight)
          const fit = Boolean(settings.get('fitwidth')) ? Math.max(pageFit, viewW / this.imageWidth) : pageFit

          this.minScale = pageFit
          this.fitScale = fit
          this.currentScale = fit

          this.transX = (viewW - this.imageWidth * fit) / 2.0
          this.transY = (viewH - this.imageHeight * fit) / 2.0

          this.fixBounds(viewW, viewH)
          this.applyImageMatrix(imageView)
        } catch (err) {
          console.error('[DocViewer] resetImage error:', err)
        }
      },
      this.isClosed
    )
  }

  public zoomBy(factor: number, fx: number, fy: number, imageView: JavaObject | null, viewW: number, viewH: number): void {
    if (!this.imageBitmap || !this.imageMatrix) return
    try {
      const newScale = Math.max(this.minScale, Math.min(this.fitScale * 10.0, this.currentScale * factor))
      const actualFactor = newScale / this.currentScale
      if (Math.abs(actualFactor - 1.0) < 0.0001) return

      this.transX = fx - (fx - this.transX) * actualFactor
      this.transY = fy - (fy - this.transY) * actualFactor
      this.currentScale = newScale

      this.fixBounds(viewW, viewH)
      this.applyImageMatrix(imageView)
    } catch (err) {
      console.error('[DocViewer] zoomBy error:', err)
    }
  }

  public onDoubleTap(x: number, y: number, imageView: JavaObject | null, viewW: number, viewH: number): void {
    runOnUiThread(
      this.activity,
      () => {
        if (!this.imageBitmap) return
        if (this.curScale() > this.fitScale * 1.1) {
          this.resetImage(imageView, viewW, viewH)
        } else {
          this.zoomBy(2.6, x, y, imageView, viewW, viewH)
        }
      },
      this.isClosed
    )
  }

  public displayImage(
    src: JavaObject,
    imageView: JavaObject,
    getViewDimensions: () => { w: number; h: number }
  ): void {
    if (this.isClosed() || !imageView) return

    let bmp = src
    if (this.rotDeg !== 0) {
      try {
        const m = new (inu.jvm.cls('android.graphics.Matrix'))()
        m.call('postRotate', this.rotDeg * 1.0)
        const rotated = inu.jvm.cls('android.graphics.Bitmap').callStatic(
          'createBitmap',
          src,
          0,
          0,
          Number(src.call('getWidth')),
          Number(src.call('getHeight')),
          m,
          true
        ) as JavaObject
        if (rotated) bmp = rotated
      } catch (err) {
        console.error('[DocViewer] Bitmap rotate error:', err)
      }
    }

    this.imageBitmap = bmp
    this.imageWidth = Math.max(1, Number(bmp.call('getWidth')))
    this.imageHeight = Math.max(1, Number(bmp.call('getHeight')))

    try { bmp.call('prepareToDraw') } catch { }

    imageView.call('setScaleType', inu.jvm.cls('android.widget.ImageView$ScaleType').getStaticField('MATRIX'))
    this.applyInvertFilter(imageView, this.isInverted)
    try { imageView.call('setImageTintList', null) } catch { }
    imageView.call('setImageBitmap', bmp)
    try { imageView.call('setImageAlpha', 255) } catch { }
    imageView.call('setVisibility', 0)
    imageView.call('invalidate')

    imageView.call(
      'post',
      inu.jvm.runnable(() => {
        if (this.isClosed() || !imageView) return
        const { w: vw, h: vh } = getViewDimensions()
        this.resetImage(imageView, vw, vh)
      })
    )
  }

  public applyInvertFilter(imageView: JavaObject | null, enable: boolean): void {
    if (!imageView) return
    try {
      if (enable) {
        const ArrayCls = inu.jvm.cls('java.lang.reflect.Array')
        const floatType = inu.jvm.cls('java.lang.Float').getStaticField('TYPE') as JavaObject
        const floatArray = ArrayCls.callStatic('newInstance', floatType, 20) as JavaObject

        const invertVals = [
          -1.0, 0.0, 0.0, 0.0, 255.0,
          0.0, -1.0, 0.0, 0.0, 255.0,
          0.0, 0.0, -1.0, 0.0, 255.0,
          0.0, 0.0, 0.0, 1.0, 0.0,
        ]
        for (let i = 0; i < 20; i++) ArrayCls.callStatic('setFloat', floatArray, i, invertVals[i])

        const filter = new (inu.jvm.cls('android.graphics.ColorMatrixColorFilter'))(floatArray)
        imageView.call('setColorFilter', filter)
      } else {
        imageView.call('clearColorFilter')
      }
    } catch (err) {
      console.error('[DocViewer] applyInvertFilter error:', err)
    }
  }

  public rotateClockwise(imageView: JavaObject | null, getViewDimensions: () => { w: number; h: number }): void {
    if (!this.srcBitmap || !imageView) return
    this.rotDeg = (this.rotDeg + 90) % 360
    runOnUiThread(
      this.activity,
      () => {
        if (this.srcBitmap && imageView) {
          this.displayImage(this.srcBitmap, imageView, getViewDimensions)
        }
      },
      this.isClosed
    )
    inu.ui?.toast(t('viewer.rotated', { deg: this.rotDeg }))
  }

  public toggleInvert(imageView: JavaObject | null): void {
    this.isInverted = !this.isInverted
    runOnUiThread(
      this.activity,
      () => this.applyInvertFilter(imageView, this.isInverted),
      this.isClosed
    )
    inu.ui?.toast(this.isInverted ? t('viewer.invertEnabled') : t('viewer.invertDisabled'))
  }

  public setupTouch(
    iv: JavaObject,
    getViewDimensions: () => { w: number; h: number },
    callbacks: ImageGesturesCallback
  ): number {
    let lx = 0
    let ly = 0
    let downX = 0
    let downY = 0
    let downTime = 0
    let isDragging = false
    let lastTapTime = 0
    let lastTapX = 0
    let lastTapY = 0
    let singleTapTimer: any = null
    let lastPinchDist = 0
    let lastFocusX = 0
    let lastFocusY = 0

    try {
      iv.call('setClickable', true)
      iv.call('setFocusable', true)
    } catch { }

    return registerTouch(iv, (_view, event) => {
      const action = Number(event.call('getAction')) & 0xff
      const pointerCount = Number(event.call('getPointerCount'))

      if (callbacks.isMinimalMode) {
        if (action === 0) {
          downTime = Date.now()
          return true
        }
        if (action === 1 || action === 3) {
          if (Date.now() - downTime < 260) callbacks.onSingleTap()
          return true
        }
        return true
      }

      if (action === 0) {
        downX = Number(event.call('getX'))
        downY = Number(event.call('getY'))
        lx = downX
        ly = downY
        downTime = Date.now()
        isDragging = false
        lastPinchDist = 0

        const now = Date.now()
        if (now - lastTapTime < 280 && Math.hypot(downX - lastTapX, downY - lastTapY) < dp(25, this.density)) {
          if (singleTapTimer) {
            clearTimeout(singleTapTimer)
            singleTapTimer = null
          }
          lastTapTime = 0
          const { w: vw, h: vh } = getViewDimensions()
          this.onDoubleTap(downX, downY, iv, vw, vh)
          return true
        }

        lastTapTime = now
        lastTapX = downX
        lastTapY = downY
        return true
      }

      if (action === 5) {
        if (pointerCount >= 2) {
          const x0 = Number(event.call('getX', 0))
          const y0 = Number(event.call('getY', 0))
          const x1 = Number(event.call('getX', 1))
          const y1 = Number(event.call('getY', 1))
          lastPinchDist = Math.hypot(x1 - x0, y1 - y0)
          lastFocusX = (x0 + x1) / 2
          lastFocusY = (y0 + y1) / 2
          lx = lastFocusX
          ly = lastFocusY
          isDragging = true
        }
        return true
      }

      if (action === 2) {
        const { w: vw, h: vh } = getViewDimensions()
        if (pointerCount >= 2 && lastPinchDist > 0) {
          const x0 = Number(event.call('getX', 0))
          const y0 = Number(event.call('getY', 0))
          const x1 = Number(event.call('getX', 1))
          const y1 = Number(event.call('getY', 1))
          const dist = Math.hypot(x1 - x0, y1 - y0)
          const focusX = (x0 + x1) / 2
          const focusY = (y0 + y1) / 2

          if (dist > 0 && lastPinchDist > 0 && this.imageMatrix) {
            this.transX += focusX - lastFocusX
            this.transY += focusY - lastFocusY
            this.zoomBy(dist / lastPinchDist, focusX, focusY, iv, vw, vh)
          }

          lastPinchDist = dist
          lastFocusX = focusX
          lastFocusY = focusY
          lx = focusX
          ly = focusY
          isDragging = true
          return true
        }

        if (pointerCount === 1) {
          const curX = Number(event.call('getX'))
          const curY = Number(event.call('getY'))
          const dx = curX - lx
          const dy = curY - ly

          if (Math.hypot(curX - downX, curY - downY) > dp(8, this.density)) {
            isDragging = true
          }

          if (this.imageMatrix && (isDragging || Math.hypot(dx, dy) > 1)) {
            this.transX += dx
            this.transY += dy
            this.fixBounds(vw, vh)
            this.applyImageMatrix(iv)
          }

          lx = curX
          ly = curY
          return true
        }
        return true
      }

      if (action === 6) {
        lastPinchDist = 0
        const remainingIndex = Number(event.call('getActionIndex')) === 0 ? 1 : 0
        try {
          lx = Number(event.call('getX', remainingIndex))
          ly = Number(event.call('getY', remainingIndex))
        } catch { }
        return true
      }

      if (action === 1 || action === 3) {
        lastPinchDist = 0
        const upX = Number(event.call('getX'))
        const upY = Number(event.call('getY'))
        const totalDx = upX - downX
        const totalDy = upY - downY
        const dt = Date.now() - downTime

        if ((callbacks.onPagePrev || callbacks.onPageNext) && this.currentScale <= this.fitScale * 1.08) {
          if (Math.abs(totalDx) > dp(45, this.density) && Math.abs(totalDx) > Math.abs(totalDy) * 1.3 && dt < 450) {
            if (totalDx < 0) callbacks.onPageNext?.()
            else callbacks.onPagePrev?.()
            return true
          }
        }

        if (!isDragging && dt < 220) {
          if (singleTapTimer) clearTimeout(singleTapTimer)
          singleTapTimer = setTimeout(() => {
            singleTapTimer = null
            callbacks.onSingleTap()
          }, 260)
        }
        return true
      }

      return false
    })
  }

  public dispose(): void {
    this.srcBitmap = null
    this.imageBitmap = null
    this.imageMatrix = null
    this.matrixValues = null
  }
}