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
export declare function isHeic(file: File): boolean;
/**
 * Transcode a HEIC/HEIF file to a JPEG `File`, preserving the base name with a
 * `.jpg` extension. Throws if the blob can't be decoded (corrupt/unsupported).
 */
export declare function convertHeicToJpeg(file: File, quality?: number): Promise<File>;
//# sourceMappingURL=heic.d.ts.map