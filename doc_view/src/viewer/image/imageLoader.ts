import { t } from '../../i18n/index.js'

export interface DecodedImage {
  bitmap: JavaObject
  width: number
  height: number
  rawWidth: number
  rawHeight: number
  sampleSize: number
  orientationDeg: number
}

function calculateInSampleSize(rawW: number, rawH: number, maxW: number, maxH: number): number {
  let sampleSize = 1
  while ((rawW / sampleSize) > maxW || (rawH / sampleSize) > maxH) {
    sampleSize *= 2
  }
  return Math.max(1, sampleSize)
}

function getExifRotation(filePath: string): { degrees: number; flipHorizontal: boolean } {
  try {
    const exif = new (inu.jvm.cls('android.media.ExifInterface'))(filePath)
    const orientation = Number(exif.call('getAttributeInt', 'Orientation', 1))

    switch (orientation) {
      case 3: return { degrees: 180, flipHorizontal: false }
      case 6: return { degrees: 90, flipHorizontal: false }
      case 8: return { degrees: 270, flipHorizontal: false }
      case 2: return { degrees: 0, flipHorizontal: true }
      case 4: return { degrees: 180, flipHorizontal: true }
      case 5: return { degrees: 90, flipHorizontal: true }
      case 7: return { degrees: 270, flipHorizontal: true }
      default: return { degrees: 0, flipHorizontal: false }
    }
  } catch {
    return { degrees: 0, flipHorizontal: false }
  }
}

export function loadImageBitmapSync(
  filePath: string,
  maxTargetW = 2048,
  maxTargetH = 2048,
  preferRgb565 = false
): DecodedImage {
  const BitmapFactoryCls = inu.jvm.cls('android.graphics.BitmapFactory')
  const OptionsCls = inu.jvm.cls('android.graphics.BitmapFactory$Options')
  const BitmapCls = inu.jvm.cls('android.graphics.Bitmap')
  const BitmapConfigCls = inu.jvm.cls('android.graphics.Bitmap$Config')
  const MatrixCls = inu.jvm.cls('android.graphics.Matrix')

  const probeOpts = new OptionsCls()
  probeOpts.setField('inJustDecodeBounds', true)
  BitmapFactoryCls.callStatic('decodeFile', filePath, probeOpts)

  const rawW = Number(probeOpts.getField('outWidth'))
  const rawH = Number(probeOpts.getField('outHeight'))

  if (rawW <= 0 || rawH <= 0) {
    throw new Error(t('image.invalidDimensions', { width: rawW, height: rawH }))
  }
  if (rawW > 16384 || rawH > 16384) {
    throw new Error(t('image.resolutionLimitExceeded', { width: rawW, height: rawH }))
  }

  let sampleSize = calculateInSampleSize(rawW, rawH, maxTargetW, maxTargetH)
  let bmp: JavaObject | null = null
  let attempts = 0

  while (attempts < 3) {
    try {
      const decodeOpts = new OptionsCls()
      decodeOpts.setField('inJustDecodeBounds', false)
      decodeOpts.setField('inSampleSize', sampleSize)
      decodeOpts.setField(
        'inPreferredConfig',
        BitmapConfigCls.getStaticField(preferRgb565 && attempts === 0 ? 'RGB_565' : 'ARGB_8888')
      )
      try {
        const ColorSpaceCls = inu.jvm.cls('android.graphics.ColorSpace')
        decodeOpts.setField(
          'inPreferredColorSpace',
          ColorSpaceCls.callStatic('get', inu.jvm.cls('android.graphics.ColorSpace$Named').getStaticField('SRGB'))
        )
      } catch { }

      bmp = BitmapFactoryCls.callStatic('decodeFile', filePath, decodeOpts) as JavaObject | null
      if (bmp) break
    } catch {
      sampleSize *= 2
    }
    attempts++
    sampleSize *= 2
  }

  if (!bmp) throw new Error(t('image.decodeFailed'))

  try {
    if (Boolean(bmp.call('hasGainmap'))) {
      bmp.call('setGainmap', null)
    }
  } catch { }

  const MAX_CANVAS_BYTES = 60 * 1024 * 1024
  const MAX_CANVAS_DIMEN = 2560

  const bw = Number(bmp.call('getWidth'))
  const bh = Number(bmp.call('getHeight'))
  let byteCount = 0
  try {
    byteCount = Number(bmp.call('getByteCount'))
  } catch { }

  if (bw > MAX_CANVAS_DIMEN || bh > MAX_CANVAS_DIMEN || byteCount > MAX_CANVAS_BYTES) {
    const scale = Math.min(MAX_CANVAS_DIMEN / bw, MAX_CANVAS_DIMEN / bh)
    if (scale < 1.0) {
      const targetW = Math.max(1, Math.round(bw * scale))
      const targetH = Math.max(1, Math.round(bh * scale))
      const scaled = BitmapCls.callStatic('createScaledBitmap', bmp, targetW, targetH, true) as JavaObject
      if (scaled && !Boolean(scaled.call('equals', bmp))) {
        try { bmp.call('recycle') } catch { }
        bmp = scaled
      }
    }
  }

  const exif = getExifRotation(filePath)
  if (exif.degrees !== 0 || exif.flipHorizontal) {
    try {
      const matrix = new MatrixCls()
      if (exif.degrees !== 0) matrix.call('postRotate', exif.degrees * 1.0)
      if (exif.flipHorizontal) matrix.call('postScale', -1.0, 1.0)

      const rotated = BitmapCls.callStatic(
        'createBitmap',
        bmp,
        0,
        0,
        Number(bmp.call('getWidth')),
        Number(bmp.call('getHeight')),
        matrix,
        true
      ) as JavaObject

      if (rotated && !Boolean(rotated.call('equals', bmp))) {
        try { bmp.call('recycle') } catch { }
        bmp = rotated
      }
    } catch (exifErr) {
      console.warn('[DocViewer] EXIF rotation error:', exifErr)
    }
  }

  return {
    bitmap: bmp,
    width: Number(bmp.call('getWidth')),
    height: Number(bmp.call('getHeight')),
    rawWidth: rawW,
    rawHeight: rawH,
    sampleSize,
    orientationDeg: exif.degrees,
  }
}

export function loadImageBitmapAsync(
  filePath: string,
  maxTargetW = 2560,
  maxTargetH = 2560,
  preferRgb565 = false
): Promise<DecodedImage> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        resolve(loadImageBitmapSync(filePath, maxTargetW, maxTargetH, preferRgb565))
      } catch (err) {
        reject(err)
      }
    }, 0)
  })
}