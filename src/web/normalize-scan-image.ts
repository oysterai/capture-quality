/**
 * Downscale + re-encode a scan image so it stays well under the backend's upload
 * caps before it leaves the browser.
 *
 * Skin-scan uploads fail with "The images.N.image failed to upload." when a file
 * exceeds the server's PHP `upload_max_filesize` (often 2M on a deployed box),
 * even though the app's own rule allows up to 5MB. Camera captures already go
 * through a JPEG canvas encode, but gallery/file-picker images (screenshots,
 * DSLR/phone photos) are sent raw and can be several MB. This normalizes every
 * image at the single upload chokepoint so the source no longer matters.
 *
 * Conservative by design: the longest edge is capped at a size that still gives
 * the skin analyzer plenty of detail, and anything already small is returned
 * untouched so we never re-compress (and degrade) an already-lean capture. Any
 * failure falls back to the original file — normalization must never block a scan.
 */

export interface NormalizeScanImageOptions {
  /** Cap for the longest edge in pixels. Above this the image is downscaled. */
  maxEdge?: number
  /** JPEG quality for the re-encode, 0–1. */
  quality?: number
  /**
   * Files at or below this size AND within `maxEdge` are passed through as-is,
   * so a lean camera capture isn't needlessly re-encoded.
   */
  skipUnderBytes?: number
}

const DEFAULTS = {
  // 2560px longest edge keeps pores/texture detail for analysis while shrinking a
  // multi-MP photo dramatically. Raised from 2000 alongside the 1080p camera
  // constraint so a full camera capture passes through untouched; a 2560-edge
  // q0.9 JPEG of a face still lands well under the ~2MB deployed PHP cap this
  // file exists to respect (measured 0.7–0.9MB on real production captures,
  // including 4032px mobile photos).
  maxEdge: 2560,
  quality: 0.9,
  skipUnderBytes: 1_000_000, // ~1MB
}

/** Types we can decode + redraw. Others (e.g. unknown) are returned unchanged. */
const PROCESSABLE = /^image\/(jpeg|jpg|png|webp)$/i

export async function normalizeScanImage(
  file: File,
  options: NormalizeScanImageOptions = {},
): Promise<File> {
  const { maxEdge, quality, skipUnderBytes } = { ...DEFAULTS, ...options }

  // Browser-only APIs; bail safely anywhere they're missing.
  if (typeof document === 'undefined' || typeof createImageBitmap === 'undefined') {
    return file
  }
  if (!PROCESSABLE.test(file.type)) {
    return file
  }

  let bitmap: ImageBitmap | null = null
  try {
    // `from-image` applies EXIF orientation so gallery photos don't upload sideways.
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    const { width, height } = bitmap
    const longestEdge = Math.max(width, height)

    // Already small in both dimensions and bytes → nothing to gain, keep original.
    if (longestEdge <= maxEdge && file.size <= skipUnderBytes) {
      return file
    }

    const scale = longestEdge > maxEdge ? maxEdge / longestEdge : 1
    const targetWidth = Math.round(width * scale)
    const targetHeight = Math.round(height * scale)

    const canvas = document.createElement('canvas')
    canvas.width = targetWidth
    canvas.height = targetHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return file

    ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight)

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), 'image/jpeg', quality)
    })

    // toBlob failed, or re-encoding somehow grew the file (e.g. tiny source) →
    // keep whatever is smaller/safer, which is the original.
    if (!blob || blob.size >= file.size) {
      return file
    }

    const baseName = file.name.replace(/\.[^./\\]+$/, '') || 'scan'
    return new File([blob], `${baseName}.jpg`, {
      type: 'image/jpeg',
      lastModified: file.lastModified,
    })
  } catch (error) {
    console.warn('[normalizeScanImage] falling back to original file', error)
    return file
  } finally {
    bitmap?.close()
  }
}
