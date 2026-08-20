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
    maxEdge?: number;
    /** JPEG quality for the re-encode, 0–1. */
    quality?: number;
    /**
     * Files at or below this size AND within `maxEdge` are passed through as-is,
     * so a lean camera capture isn't needlessly re-encoded.
     */
    skipUnderBytes?: number;
}
export declare function normalizeScanImage(file: File, options?: NormalizeScanImageOptions): Promise<File>;
//# sourceMappingURL=normalize-scan-image.d.ts.map