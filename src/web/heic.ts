/**
 * Browser-side HEIC/HEIF → JPEG conversion.
 *
 * iPhones default to HEIC, which desktop Chrome/Firefox can neither paint in an
 * `<img>` nor decode via canvas — so a gallery-picked HEIC must be transcoded in
 * the browser before it can be previewed or uploaded. The decoder (libheif via
 * `heic2any`) is ~1.4MB of wasm, so it is imported dynamically inside
 * `convertHeicToJpeg`: it only downloads when a HEIC is actually chosen, keeping
 * it out of the main widget bundle for the common (JPEG) path.
 */

/**
 * True when the file is HEIC/HEIF. Desktop file pickers frequently report an
 * empty `type` for HEIC, so the extension is the reliable signal.
 */
export function isHeic(file: File): boolean {
  const type = file.type.toLowerCase()
  if (type === 'image/heic' || type === 'image/heif') {
    return true
  }
  return /\.hei[cf]$/i.test(file.name)
}

/**
 * Transcode a HEIC/HEIF file to a JPEG `File`, preserving the base name with a
 * `.jpg` extension. Throws if the blob can't be decoded (corrupt/unsupported).
 */
export async function convertHeicToJpeg(file: File, quality = 0.9): Promise<File> {
  const { default: heic2any } = await import('heic2any')
  const result = await heic2any({ blob: file, toType: 'image/jpeg', quality })
  // heic2any returns Blob[] only for multi-frame HEICs; we keep the first frame.
  const blob = Array.isArray(result) ? result[0] : result
  const name = file.name.replace(/\.hei[cf]$/i, '.jpg')
  return new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() })
}
