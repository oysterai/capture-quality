/**
 * Real-time image-quality checks for the scan capture flow.
 *
 * Poor input (too dark, blown-out, blurry, no face, tiny resolution, face too far
 * from the camera) is the main driver of inaccurate skin analyses. Rather than
 * let those frames reach the engine, we score each live preview frame *during*
 * capture and only allow the shutter to fire once the frame clears every check —
 * surfacing a specific, actionable message otherwise ("too dark — move to better
 * light").
 *
 * Design notes / why this isn't a throwaway heuristic:
 *
 *  - **Resolution-independent sharpness.** Variance-of-Laplacian (the standard
 *    focus metric used by OpenCV/PyImageSearch and, under the hood, capture SDKs)
 *    scales with image size, so a raw threshold tuned on one device fails on
 *    another. The caller downsamples every frame to a *fixed* working edge
 *    (`workingEdge`) before scoring, which removes that dependence and makes the
 *    threshold transferable across cameras.
 *
 *  - **Exposure via mean luminance + clipping.** Mean luma catches globally
 *    dark/bright frames; highlight-clip fraction separately catches glare/blowout
 *    that a mean can miss (a face washed out by a window behind a dark room can
 *    read as an acceptable mean). This mirrors what AWS Rekognition exposes as
 *    `Quality.Brightness` and identity SDKs surface as glare warnings.
 *
 *  - **Thresholds are injectable and documented as calibration-pending.** The
 *    defaults below are sane starting points, NOT universal truths. They are
 *    meant to be tuned against a labelled set of real accepted/rejected captures
 *    (ideally correlated with the engine's downstream accuracy). Every consumer
 *    can override them, and the tests assert *behaviour* against injected
 *    thresholds rather than baking in magic numbers.
 *
 * This module is pure (no DOM/canvas): it operates on an already-sampled RGBA
 * frame plus the true source dimensions, so it runs unchanged in the browser and
 * under jsdom in unit tests. Sampling the video frame to a canvas is the caller's
 * job (see `WebCamera.vue`).
 */
/** A sampled RGBA frame. `ImageData` satisfies this shape structurally. */
export interface QualityFrame {
    /** RGBA bytes, length === width * height * 4. */
    data: Uint8ClampedArray;
    width: number;
    height: number;
}
/** Machine-readable reason a frame was rejected, in surfacing-priority order. */
export type QualityIssueCode = 'no_face' | 'low_resolution' | 'face_too_far' | 'too_dark' | 'overexposed' | 'blurry';
export interface QualityThresholds {
    /** Minimum accepted source frame width/height, in real (pre-downsample) px. */
    minSourceWidth: number;
    minSourceHeight: number;
    /** Mean luma (0–255) below this → too_dark. */
    minMeanLuminance: number;
    /** Mean luma (0–255) above this → overexposed. */
    maxMeanLuminance: number;
    /** Fraction of near-white (blown-out) pixels above this → overexposed (glare). */
    maxHighlightClipFraction: number;
    /** Variance-of-Laplacian below this (at `workingEdge`) → blurry. */
    minSharpness: number;
    /**
     * Detected face-box height, as a fraction of the *visible* frame height, below
     * which the subject is too far from the camera (see `computeFaceHeightRatio`).
     */
    minFaceHeightRatio: number;
    /** Fixed longest-edge, in px, the caller downsamples to before scoring. */
    workingEdge: number;
}
/**
 * Starting-point thresholds. CALIBRATION-PENDING: tune against real captures
 * before trusting these to hard-block submission on every device. They are
 * deliberately lenient so guidance nudges rather than traps the user.
 */
export declare const DEFAULT_THRESHOLDS: QualityThresholds;
export interface QualityMetrics {
    /** Mean luma across the frame, 0–255. */
    meanLuminance: number;
    /** Fraction of pixels at/near white (luma > 250). */
    highlightClipFraction: number;
    /** Fraction of pixels at/near black (luma < 16). */
    shadowClipFraction: number;
    /** Variance of the Laplacian response over the (fixed-size) grayscale frame. */
    sharpness: number;
}
export interface QualityResult {
    /** True when the frame cleared every check. */
    pass: boolean;
    /** All failed checks, in surfacing-priority order. */
    issues: QualityIssueCode[];
    /** The single most important issue to show the user, or null when passing. */
    primaryIssue: QualityIssueCode | null;
    /** Actionable copy for `primaryIssue`, or null when passing. */
    message: string | null;
    metrics: QualityMetrics;
}
export declare function messageForIssue(code: QualityIssueCode): string;
/** Per-pixel luma (Rec. 601), returned as a flat 0–255 grayscale buffer. */
export declare function toGrayscale(frame: QualityFrame): Float32Array;
/** Mean luma plus the fraction of clipped shadows/highlights. */
export declare function computeLuminanceStats(frame: QualityFrame): {
    mean: number;
    shadowClipFraction: number;
    highlightClipFraction: number;
};
/**
 * Variance of the Laplacian over the grayscale frame — the classic focus metric.
 * A sharp frame has strong, high-variance edges; a blurred one flattens them.
 *
 * Uses the 4-neighbour Laplacian kernel [0 1 0; 1 -4 1; 0 1 0] over interior
 * pixels. The result is meaningful only relative to a fixed working size (see
 * `workingEdge`), so callers must downsample consistently before calling.
 */
export declare function computeSharpness(gray: Float32Array, width: number, height: number): number;
/**
 * Height of a detected face box as a fraction of the source region the user can
 * actually see, accounting for the preview's `object-fit: cover` crop.
 *
 * Detection boxes come back in *source* pixels (`videoWidth × videoHeight`) while
 * the preview is cover-cropped into whatever box the parent gives it — and this
 * widget renders the camera at three very different aspect ratios (a 480×640
 * desktop card, a ~390×844 phone viewport, and a *landscape* ~704×600 contained
 * panel). Normalising against the visible height rather than the raw source
 * height is what makes one threshold hold across all three.
 *
 * Height-only is deliberate: it sidesteps the front camera's `scaleX(-1)` preview
 * mirroring entirely, and the centred `object-position` never needs resolving
 * because we want the size of the visible region, not its offset.
 *
 * Returns null when geometry can't be established (video not yet laid out, no
 * box). Callers must read null as "unknown", never as "too far" — the shutter
 * gate fails open.
 */
export declare function computeFaceHeightRatio(input: {
    boxHeight: number;
    videoWidth: number;
    videoHeight: number;
    frameWidth: number;
    frameHeight: number;
}): number | null;
/**
 * Face-height ratio at which the indicator reads empty — the 0% anchor for
 * `computeApproachProgress`. Not a gate; nothing is blocked at this value.
 *
 * Set *below* the distance a user typically starts from rather than at it. A
 * person holding a phone at arm's length reads around 0.20–0.25, and anchoring
 * there would show them an empty indicator in the single most common starting
 * position — no evidence the thing responds to them at all, which is the exact
 * failure this indicator exists to fix. At 0.15 that same start already reads
 * roughly half full, while someone genuinely across the room still reads zero.
 *
 * 0.15 also sits below the point where TinyFaceDetector at `inputSize` 416 gets
 * unreliable, so "empty" and "no face detected" tend to coincide rather than
 * contradict each other.
 */
export declare const APPROACH_FLOOR_RATIO = 0.15;
/**
 * How close the subject is to the capture distance, as 0..1, for driving a
 * continuous "move closer" indicator.
 *
 * This exists because the gate is a boolean and distance is not. A user who is too
 * far gets told so, but nothing tells them whether stepping forward is working —
 * so they hunt. This is the signal that closes that loop; it never gates anything.
 *
 * **The curve is logarithmic, not linear in the ratio.** Two reasons, and the
 * second is the one that decides it:
 *
 * 1. Apparent face height scales as 1/distance, so equal steps toward the camera
 *    produce ever-larger jumps in the ratio. Interpolating on the ratio directly
 *    would show the user the arithmetic rather than their own movement.
 * 2. Detector box-height jitter is roughly constant in *relative* terms, so a log
 *    map turns it into a constant *absolute* wobble at every distance. A linear
 *    map concentrates that wobble near the threshold — precisely where the user is
 *    trying to hold still — and a reciprocal (linear-in-distance) map concentrates
 *    it far away while going nearly flat at the end, leaving the final approach
 *    with almost no feedback. Log is the only one of the three that is uniform.
 *
 * Clamped at both ends. At or past `minFaceHeightRatio` this pins to 1 — there is
 * deliberately no too-close bound, so "closer still" must not read as overshoot.
 * An unmeasured frame returns 0 rather than throwing; callers decide whether to
 * draw that or hold the previous value.
 */
export declare function computeApproachProgress(faceHeightRatio: number | null | undefined, minFaceHeightRatio?: number, floor?: number): number;
export declare function computeMetrics(frame: QualityFrame): QualityMetrics;
export interface AnalyzeInput {
    /** Sampled preview frame, already downsampled to `thresholds.workingEdge`. */
    frame: QualityFrame;
    /** True (pre-downsample) source dimensions, for the resolution check. */
    sourceWidth: number;
    sourceHeight: number;
    /**
     * Whether a face is currently detected in frame. Supplied by the caller's face
     * detector (face-api today, MediaPipe later) so this module stays DOM-free.
     */
    faceDetected: boolean;
    /**
     * Largest detected face box height as a fraction of the visible frame height
     * (see `computeFaceHeightRatio`). Null/undefined means "not measured", which
     * skips the distance check rather than failing it.
     */
    faceHeightRatio?: number | null;
}
/**
 * Score a single capture frame against every quality check and return an ordered
 * verdict. Pure and synchronous — safe to call on every preview tick.
 */
export declare function analyzeFrameQuality(input: AnalyzeInput, thresholds?: QualityThresholds): QualityResult;
//# sourceMappingURL=image-quality.d.ts.map