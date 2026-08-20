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
  data: Uint8ClampedArray
  width: number
  height: number
}

/** Machine-readable reason a frame was rejected, in surfacing-priority order. */
export type QualityIssueCode =
  | 'no_face'
  | 'low_resolution'
  | 'face_too_far'
  | 'too_dark'
  | 'overexposed'
  | 'blurry'

export interface QualityThresholds {
  /** Minimum accepted source frame width/height, in real (pre-downsample) px. */
  minSourceWidth: number
  minSourceHeight: number
  /** Mean luma (0–255) below this → too_dark. */
  minMeanLuminance: number
  /** Mean luma (0–255) above this → overexposed. */
  maxMeanLuminance: number
  /** Fraction of near-white (blown-out) pixels above this → overexposed (glare). */
  maxHighlightClipFraction: number
  /** Variance-of-Laplacian below this (at `workingEdge`) → blurry. */
  minSharpness: number
  /**
   * Detected face-box height, as a fraction of the *visible* frame height, below
   * which the subject is too far from the camera (see `computeFaceHeightRatio`).
   */
  minFaceHeightRatio: number
  /** Fixed longest-edge, in px, the caller downsamples to before scoring. */
  workingEdge: number
}

/**
 * Starting-point thresholds. CALIBRATION-PENDING: tune against real captures
 * before trusting these to hard-block submission on every device. They are
 * deliberately lenient so guidance nudges rather than traps the user.
 */
export const DEFAULT_THRESHOLDS: QualityThresholds = {
  minSourceWidth: 480,
  minSourceHeight: 480,
  minMeanLuminance: 50,
  maxMeanLuminance: 205,
  maxHighlightClipFraction: 0.25,
  // Tuned for an RGBA frame downsampled to a 320px longest edge. Re-calibrate if
  // `workingEdge` changes — VoL scales with resolution.
  minSharpness: 120,
  // Calibrated against real captures, NOT borrowed from prior art. The obvious
  // reference (jzaefferer/video-call-linter, same face-api stack) rejects below
  // 0.21 — but that is a "can colleagues see your face on a call" bar, and a
  // skin scan needs pore-level detail. Measured on an iPhone front camera, 0.217
  // still framed the subject's whole torso: recognisable, useless for analysis.
  // Note this is a *tight* box — brow to chin, excluding hair and forehead — so
  // it reads lower than a head-box detector would at the same distance.
  minFaceHeightRatio: 0.46,
  workingEdge: 320,
}

export interface QualityMetrics {
  /** Mean luma across the frame, 0–255. */
  meanLuminance: number
  /** Fraction of pixels at/near white (luma > 250). */
  highlightClipFraction: number
  /** Fraction of pixels at/near black (luma < 16). */
  shadowClipFraction: number
  /** Variance of the Laplacian response over the (fixed-size) grayscale frame. */
  sharpness: number
}

export interface QualityResult {
  /** True when the frame cleared every check. */
  pass: boolean
  /** All failed checks, in surfacing-priority order. */
  issues: QualityIssueCode[]
  /** The single most important issue to show the user, or null when passing. */
  primaryIssue: QualityIssueCode | null
  /** Actionable copy for `primaryIssue`, or null when passing. */
  message: string | null
  metrics: QualityMetrics
}

/** Actionable, on-brand copy per issue. Voice matches the ticket's examples. */
const ISSUE_MESSAGES: Record<QualityIssueCode, string> = {
  no_face: 'We couldn’t detect a face — please re-centre your camera.',
  low_resolution: 'Your camera resolution is too low for an accurate scan.',
  face_too_far: 'Move closer — your face is too far from the camera.',
  too_dark: 'Your image is too dark — try moving to better light.',
  overexposed: 'Too much light — move away from glare or direct light.',
  blurry: 'Hold still — the image is too blurry to analyse.',
}

/**
 * Surfacing priority: the most fundamental / most actionable issue wins when a
 * frame trips several checks at once (no point saying "too blurry" when there's
 * no face in view).
 */
const ISSUE_PRIORITY: QualityIssueCode[] = [
  'no_face',
  'low_resolution',
  // Above exposure and blur: it's the most actionable instruction, and a distant
  // face makes the blur reading meaningless anyway — sharpness is measured over
  // the whole frame, so a busy background can score "sharp" while the skin is mush.
  'face_too_far',
  'too_dark',
  'overexposed',
  'blurry',
]

export function messageForIssue(code: QualityIssueCode): string {
  return ISSUE_MESSAGES[code]
}

const REC601 = { r: 0.299, g: 0.587, b: 0.114 } as const

/** Per-pixel luma (Rec. 601), returned as a flat 0–255 grayscale buffer. */
export function toGrayscale(frame: QualityFrame): Float32Array {
  const { data, width, height } = frame
  const gray = new Float32Array(width * height)
  for (let i = 0, p = 0; p < gray.length; i += 4, p++) {
    gray[p] = REC601.r * data[i] + REC601.g * data[i + 1] + REC601.b * data[i + 2]
  }
  return gray
}

/** Mean luma plus the fraction of clipped shadows/highlights. */
export function computeLuminanceStats(frame: QualityFrame): {
  mean: number
  shadowClipFraction: number
  highlightClipFraction: number
} {
  const gray = toGrayscale(frame)
  const n = gray.length
  if (n === 0) {
    return { mean: 0, shadowClipFraction: 1, highlightClipFraction: 0 }
  }

  let sum = 0
  let shadow = 0
  let highlight = 0
  for (let p = 0; p < n; p++) {
    const y = gray[p]
    sum += y
    if (y < 16) shadow++
    else if (y > 250) highlight++
  }

  return {
    mean: sum / n,
    shadowClipFraction: shadow / n,
    highlightClipFraction: highlight / n,
  }
}

/**
 * Variance of the Laplacian over the grayscale frame — the classic focus metric.
 * A sharp frame has strong, high-variance edges; a blurred one flattens them.
 *
 * Uses the 4-neighbour Laplacian kernel [0 1 0; 1 -4 1; 0 1 0] over interior
 * pixels. The result is meaningful only relative to a fixed working size (see
 * `workingEdge`), so callers must downsample consistently before calling.
 */
export function computeSharpness(gray: Float32Array, width: number, height: number): number {
  // Need at least a 3×3 interior to run the kernel.
  if (width < 3 || height < 3) return 0

  let sum = 0
  let sumSq = 0
  let count = 0

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      const lap = gray[i - 1] + gray[i + 1] + gray[i - width] + gray[i + width] - 4 * gray[i]
      sum += lap
      sumSq += lap * lap
      count++
    }
  }

  if (count === 0) return 0
  const mean = sum / count
  return sumSq / count - mean * mean
}

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
export function computeFaceHeightRatio(input: {
  boxHeight: number
  videoWidth: number
  videoHeight: number
  frameWidth: number
  frameHeight: number
}): number | null {
  const { boxHeight, videoWidth, videoHeight, frameWidth, frameHeight } = input

  if (videoWidth <= 0 || videoHeight <= 0 || frameWidth <= 0 || frameHeight <= 0) {
    return null
  }
  if (boxHeight <= 0) {
    return null
  }

  // `cover` scales the source until it covers both axes, so the larger factor wins.
  const scale = Math.max(frameWidth / videoWidth, frameHeight / videoHeight)
  // Clamped: float error can push this a hair past the true source height, and
  // the visible region can never exceed what the source actually has.
  const visibleSourceHeight = Math.min(videoHeight, frameHeight / scale)

  return boxHeight / visibleSourceHeight
}

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
export const APPROACH_FLOOR_RATIO = 0.15

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
export function computeApproachProgress(
  faceHeightRatio: number | null | undefined,
  minFaceHeightRatio: number = DEFAULT_THRESHOLDS.minFaceHeightRatio,
  floor: number = APPROACH_FLOOR_RATIO,
): number {
  if (faceHeightRatio == null || !Number.isFinite(faceHeightRatio)) return 0
  if (faceHeightRatio <= 0 || floor <= 0 || minFaceHeightRatio <= 0) return 0

  // A floor at or above the target leaves no band to interpolate over; treating it
  // as a plain step is the only honest answer, and it keeps a misconfigured
  // threshold from producing a divide-by-zero or a negative sweep.
  if (floor >= minFaceHeightRatio) {
    return faceHeightRatio >= minFaceHeightRatio ? 1 : 0
  }

  if (faceHeightRatio <= floor) return 0
  if (faceHeightRatio >= minFaceHeightRatio) return 1

  const progress = Math.log(faceHeightRatio / floor) / Math.log(minFaceHeightRatio / floor)

  return Math.min(1, Math.max(0, progress))
}

export function computeMetrics(frame: QualityFrame): QualityMetrics {
  const { mean, shadowClipFraction, highlightClipFraction } = computeLuminanceStats(frame)
  const gray = toGrayscale(frame)
  const sharpness = computeSharpness(gray, frame.width, frame.height)
  return {
    meanLuminance: mean,
    highlightClipFraction,
    shadowClipFraction,
    sharpness,
  }
}

export interface AnalyzeInput {
  /** Sampled preview frame, already downsampled to `thresholds.workingEdge`. */
  frame: QualityFrame
  /** True (pre-downsample) source dimensions, for the resolution check. */
  sourceWidth: number
  sourceHeight: number
  /**
   * Whether a face is currently detected in frame. Supplied by the caller's face
   * detector (face-api today, MediaPipe later) so this module stays DOM-free.
   */
  faceDetected: boolean
  /**
   * Largest detected face box height as a fraction of the visible frame height
   * (see `computeFaceHeightRatio`). Null/undefined means "not measured", which
   * skips the distance check rather than failing it.
   */
  faceHeightRatio?: number | null
}

/**
 * Score a single capture frame against every quality check and return an ordered
 * verdict. Pure and synchronous — safe to call on every preview tick.
 */
export function analyzeFrameQuality(
  input: AnalyzeInput,
  thresholds: QualityThresholds = DEFAULT_THRESHOLDS,
): QualityResult {
  const { frame, sourceWidth, sourceHeight, faceDetected, faceHeightRatio } = input
  const metrics = computeMetrics(frame)
  const issues: QualityIssueCode[] = []

  if (!faceDetected) {
    issues.push('no_face')
  }

  if (sourceWidth < thresholds.minSourceWidth || sourceHeight < thresholds.minSourceHeight) {
    issues.push('low_resolution')
  }

  // Fails open on an unmeasured ratio: this gate hard-blocks the shutter, so
  // "we couldn't measure" must never be the reason someone can't take a photo.
  if (faceDetected && faceHeightRatio != null && faceHeightRatio < thresholds.minFaceHeightRatio) {
    issues.push('face_too_far')
  }

  if (metrics.meanLuminance < thresholds.minMeanLuminance) {
    issues.push('too_dark')
  } else if (
    metrics.meanLuminance > thresholds.maxMeanLuminance ||
    metrics.highlightClipFraction > thresholds.maxHighlightClipFraction
  ) {
    issues.push('overexposed')
  }

  if (metrics.sharpness < thresholds.minSharpness) {
    issues.push('blurry')
  }

  const ordered = ISSUE_PRIORITY.filter((code) => issues.includes(code))
  const primaryIssue = ordered[0] ?? null

  return {
    pass: ordered.length === 0,
    issues: ordered,
    primaryIssue,
    message: primaryIssue ? ISSUE_MESSAGES[primaryIssue] : null,
    metrics,
  }
}
