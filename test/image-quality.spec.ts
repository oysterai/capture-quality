import { describe, it, expect } from 'vitest'
import {
  analyzeFrameQuality,
  computeApproachProgress,
  computeFaceHeightRatio,
  computeLuminanceStats,
  computeMetrics,
  computeSharpness,
  toGrayscale,
  messageForIssue,
  APPROACH_FLOOR_RATIO,
  DEFAULT_THRESHOLDS,
  type QualityFrame,
  type QualityThresholds,
} from '../src/image-quality'

// --- synthetic frame builders -------------------------------------------------

/** Uniform grey frame (R=G=B=luma). Sharpness is ~0 → reads as blurry. */
function solidFrame(width: number, height: number, luma: number): QualityFrame {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = luma
    data[i + 1] = luma
    data[i + 2] = luma
    data[i + 3] = 255
  }
  return { data, width, height }
}

/** Alternating checkerboard → strong edges → high variance-of-Laplacian. */
function checkerFrame(width: number, height: number, a: number, b: number): QualityFrame {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = (x + y) % 2 === 0 ? a : b
      const i = (y * width + x) * 4
      data[i] = v
      data[i + 1] = v
      data[i + 2] = v
      data[i + 3] = 255
    }
  }
  return { data, width, height }
}

/** `baseLuma` frame with `glareFraction` of pixels blown out to pure white. */
function glareFrame(
  width: number,
  height: number,
  baseLuma: number,
  glareFraction: number,
): QualityFrame {
  const frame = solidFrame(width, height, baseLuma)
  const blown = Math.floor(width * height * glareFraction)
  for (let p = 0; p < blown; p++) {
    const i = p * 4
    frame.data[i] = 255
    frame.data[i + 1] = 255
    frame.data[i + 2] = 255
  }
  return frame
}

// A crisp, well-lit checkerboard used as the "good" baseline in many tests.
const SHARP_WELL_LIT = () => checkerFrame(320, 320, 110, 150)

const bigSource = { sourceWidth: 1280, sourceHeight: 720 }

// --- low-level metrics --------------------------------------------------------

describe('toGrayscale / computeLuminanceStats', () => {
  it('computes mean luma of a uniform frame', () => {
    const stats = computeLuminanceStats(solidFrame(16, 16, 100))
    expect(stats.mean).toBeCloseTo(100, 5)
    expect(stats.shadowClipFraction).toBe(0)
    expect(stats.highlightClipFraction).toBe(0)
  })

  it('flags clipped shadows on a near-black frame', () => {
    const stats = computeLuminanceStats(solidFrame(16, 16, 5))
    expect(stats.shadowClipFraction).toBe(1)
  })

  it('flags clipped highlights on a near-white frame', () => {
    const stats = computeLuminanceStats(solidFrame(16, 16, 255))
    expect(stats.highlightClipFraction).toBe(1)
  })

  it('handles an empty frame without dividing by zero', () => {
    const stats = computeLuminanceStats({ data: new Uint8ClampedArray(0), width: 0, height: 0 })
    expect(stats.mean).toBe(0)
    expect(stats.shadowClipFraction).toBe(1)
  })
})

describe('computeSharpness', () => {
  it('scores a sharp checkerboard far above a flat frame', () => {
    const sharp = computeMetrics(checkerFrame(32, 32, 110, 150)).sharpness
    const flat = computeMetrics(solidFrame(32, 32, 130)).sharpness
    expect(flat).toBeCloseTo(0, 5)
    expect(sharp).toBeGreaterThan(flat)
    expect(sharp).toBeGreaterThan(DEFAULT_THRESHOLDS.minSharpness)
  })

  it('returns 0 for frames too small to run the kernel', () => {
    const gray = toGrayscale(solidFrame(2, 2, 128))
    expect(computeSharpness(gray, 2, 2)).toBe(0)
  })
})

// --- exposure gating (isolated: blur disabled via minSharpness) ---------------

describe('analyzeFrameQuality — exposure', () => {
  const t: QualityThresholds = { ...DEFAULT_THRESHOLDS, minSharpness: 0 }

  it('rejects a too-dark frame with the dark message', () => {
    const res = analyzeFrameQuality(
      { frame: solidFrame(64, 64, 20), ...bigSource, faceDetected: true },
      t,
    )
    expect(res.pass).toBe(false)
    expect(res.primaryIssue).toBe('too_dark')
    expect(res.message).toMatch(/too dark/i)
  })

  it('rejects a globally overexposed frame', () => {
    const res = analyzeFrameQuality(
      { frame: solidFrame(64, 64, 240), ...bigSource, faceDetected: true },
      t,
    )
    expect(res.pass).toBe(false)
    expect(res.primaryIssue).toBe('overexposed')
  })

  it('rejects a frame with strong glare even when the mean is acceptable', () => {
    const frame = glareFrame(64, 64, 128, 0.3) // mean ~166 (< 205) but 30% blown out
    const stats = computeLuminanceStats(frame)
    expect(stats.mean).toBeLessThan(t.maxMeanLuminance)
    expect(stats.highlightClipFraction).toBeGreaterThan(t.maxHighlightClipFraction)

    const res = analyzeFrameQuality({ frame, ...bigSource, faceDetected: true }, t)
    expect(res.primaryIssue).toBe('overexposed')
  })

  it('accepts a well-lit frame', () => {
    const res = analyzeFrameQuality(
      { frame: solidFrame(64, 64, 128), ...bigSource, faceDetected: true },
      t,
    )
    expect(res.issues).not.toContain('too_dark')
    expect(res.issues).not.toContain('overexposed')
  })
})

// --- blur gating --------------------------------------------------------------

describe('analyzeFrameQuality — blur', () => {
  it('rejects a flat (unfocused) frame as blurry', () => {
    const res = analyzeFrameQuality(
      { frame: solidFrame(64, 64, 128), ...bigSource, faceDetected: true },
      DEFAULT_THRESHOLDS,
    )
    expect(res.issues).toContain('blurry')
  })

  it('does not flag a sharp frame as blurry', () => {
    const res = analyzeFrameQuality(
      { frame: SHARP_WELL_LIT(), ...bigSource, faceDetected: true },
      DEFAULT_THRESHOLDS,
    )
    expect(res.issues).not.toContain('blurry')
  })
})

// --- resolution gating --------------------------------------------------------

describe('analyzeFrameQuality — resolution', () => {
  it('rejects a source frame below the minimum dimensions', () => {
    const res = analyzeFrameQuality(
      { frame: SHARP_WELL_LIT(), sourceWidth: 320, sourceHeight: 240, faceDetected: true },
      DEFAULT_THRESHOLDS,
    )
    expect(res.issues).toContain('low_resolution')
  })

  it('accepts a source frame at or above the minimum dimensions', () => {
    const res = analyzeFrameQuality(
      {
        frame: SHARP_WELL_LIT(),
        sourceWidth: DEFAULT_THRESHOLDS.minSourceWidth,
        sourceHeight: DEFAULT_THRESHOLDS.minSourceHeight,
        faceDetected: true,
      },
      DEFAULT_THRESHOLDS,
    )
    expect(res.issues).not.toContain('low_resolution')
  })
})

// --- face presence + priority + pass -----------------------------------------

describe('analyzeFrameQuality — face + priority', () => {
  it('reports no_face when the detector sees no face', () => {
    const res = analyzeFrameQuality(
      { frame: SHARP_WELL_LIT(), ...bigSource, faceDetected: false },
      DEFAULT_THRESHOLDS,
    )
    expect(res.issues).toContain('no_face')
    expect(res.primaryIssue).toBe('no_face')
  })

  it('surfaces the highest-priority issue when several fail at once', () => {
    // Dark AND no face AND low res → no_face wins the surfaced message.
    const res = analyzeFrameQuality(
      { frame: solidFrame(64, 64, 20), sourceWidth: 100, sourceHeight: 100, faceDetected: false },
      DEFAULT_THRESHOLDS,
    )
    expect(res.primaryIssue).toBe('no_face')
    expect(res.issues).toEqual(['no_face', 'low_resolution', 'too_dark', 'blurry'])
  })

  it('passes a sharp, well-lit, high-res frame with a face', () => {
    const res = analyzeFrameQuality(
      { frame: SHARP_WELL_LIT(), ...bigSource, faceDetected: true },
      DEFAULT_THRESHOLDS,
    )
    expect(res.pass).toBe(true)
    expect(res.issues).toEqual([])
    expect(res.primaryIssue).toBeNull()
    expect(res.message).toBeNull()
  })
})

// --- face distance geometry ---------------------------------------------------

describe('computeFaceHeightRatio', () => {
  // A 16:9 source is wider than every frame the widget renders today, so `cover`
  // always crops horizontally and the full source height stays visible.
  const source = { videoWidth: 1920, videoHeight: 1080 }

  it('reduces to boxHeight / videoHeight when the frame is narrower than the source', () => {
    const ratio = computeFaceHeightRatio({
      boxHeight: 300,
      ...source,
      frameWidth: 390, // phone viewport
      frameHeight: 844,
    })
    expect(ratio).toBeCloseTo(300 / 1080, 5)
  })

  it('gives the same ratio across every frame aspect the widget renders', () => {
    // The point of normalising against the *visible* height: one threshold has to
    // hold for the 480x640 desktop card, the ~390x844 phone viewport and the
    // landscape ~704x600 contained panel alike.
    const frames = [
      { frameWidth: 480, frameHeight: 640 },
      { frameWidth: 390, frameHeight: 844 },
      { frameWidth: 704, frameHeight: 600 },
    ]
    const ratios = frames.map((f) => computeFaceHeightRatio({ boxHeight: 300, ...source, ...f }))
    for (const ratio of ratios) {
      expect(ratio).toBeCloseTo(300 / 1080, 5)
    }
  })

  it('accounts for the vertical crop when the frame is wider than the source', () => {
    // 32:9 frame over a 16:9 source → cover crops top and bottom, so the visible
    // height is half the source and the face fills twice as much of it.
    const ratio = computeFaceHeightRatio({
      boxHeight: 300,
      ...source,
      frameWidth: 1920,
      frameHeight: 540,
    })
    expect(ratio).toBeCloseTo((300 / 1080) * 2, 5)
  })

  it('returns null when the video has not been laid out or measured yet', () => {
    expect(
      computeFaceHeightRatio({ boxHeight: 300, ...source, frameWidth: 0, frameHeight: 0 }),
    ).toBeNull()
    expect(
      computeFaceHeightRatio({
        boxHeight: 300,
        videoWidth: 0,
        videoHeight: 0,
        frameWidth: 390,
        frameHeight: 844,
      }),
    ).toBeNull()
    expect(
      computeFaceHeightRatio({ boxHeight: 0, ...source, frameWidth: 390, frameHeight: 844 }),
    ).toBeNull()
  })
})

// --- face distance gate -------------------------------------------------------

describe('analyzeFrameQuality — face distance', () => {
  const below = DEFAULT_THRESHOLDS.minFaceHeightRatio / 2
  const above = DEFAULT_THRESHOLDS.minFaceHeightRatio * 2

  it('rejects a face that fills too little of the frame', () => {
    const res = analyzeFrameQuality(
      { frame: SHARP_WELL_LIT(), ...bigSource, faceDetected: true, faceHeightRatio: below },
      DEFAULT_THRESHOLDS,
    )
    expect(res.issues).toContain('face_too_far')
    expect(res.primaryIssue).toBe('face_too_far')
    expect(res.message).toMatch(/closer|too far/i)
    expect(res.pass).toBe(false)
  })

  it('accepts a face that clears the minimum height ratio', () => {
    const res = analyzeFrameQuality(
      { frame: SHARP_WELL_LIT(), ...bigSource, faceDetected: true, faceHeightRatio: above },
      DEFAULT_THRESHOLDS,
    )
    expect(res.issues).not.toContain('face_too_far')
    expect(res.pass).toBe(true)
  })

  it('treats the threshold itself as close enough', () => {
    const res = analyzeFrameQuality(
      {
        frame: SHARP_WELL_LIT(),
        ...bigSource,
        faceDetected: true,
        faceHeightRatio: DEFAULT_THRESHOLDS.minFaceHeightRatio,
      },
      DEFAULT_THRESHOLDS,
    )
    expect(res.issues).not.toContain('face_too_far')
  })

  it('fails open when the ratio could not be measured', () => {
    // This gate hard-blocks the shutter, so "we couldn't measure" must never be
    // the reason someone can't take a photo.
    for (const faceHeightRatio of [null, undefined]) {
      const res = analyzeFrameQuality(
        { frame: SHARP_WELL_LIT(), ...bigSource, faceDetected: true, faceHeightRatio },
        DEFAULT_THRESHOLDS,
      )
      expect(res.issues).not.toContain('face_too_far')
      expect(res.pass).toBe(true)
    }
  })

  it('surfaces no_face over face_too_far when the detector sees nothing', () => {
    const res = analyzeFrameQuality(
      { frame: SHARP_WELL_LIT(), ...bigSource, faceDetected: false, faceHeightRatio: below },
      DEFAULT_THRESHOLDS,
    )
    expect(res.primaryIssue).toBe('no_face')
    expect(res.issues).not.toContain('face_too_far')
  })

  it('surfaces face_too_far over exposure and blur issues', () => {
    // A distant face makes the frame-wide blur reading meaningless, so distance
    // is the instruction worth giving first.
    const res = analyzeFrameQuality(
      { frame: solidFrame(320, 320, 20), ...bigSource, faceDetected: true, faceHeightRatio: below },
      DEFAULT_THRESHOLDS,
    )
    expect(res.primaryIssue).toBe('face_too_far')
    expect(res.issues).toEqual(['face_too_far', 'too_dark', 'blurry'])
  })
})

// --- approach progress --------------------------------------------------------

describe('computeApproachProgress', () => {
  // Expressed against the threshold, never against 0.46 — the threshold has already
  // moved twice and these tests must survive it moving again.
  const target = DEFAULT_THRESHOLDS.minFaceHeightRatio
  const floor = APPROACH_FLOOR_RATIO

  it('reads 0 at and below the far anchor', () => {
    expect(computeApproachProgress(floor)).toBe(0)
    expect(computeApproachProgress(floor / 2)).toBe(0)
  })

  it('reads a full 1 exactly at the capture threshold', () => {
    expect(computeApproachProgress(target)).toBe(1)
  })

  it('stays pinned at 1 past the threshold — there is no too-close bound', () => {
    // Closer than required is not an error, so the indicator must not retreat or
    // overshoot. This is the assertion that encodes the product decision.
    expect(computeApproachProgress(target * 1.5)).toBe(1)
    expect(computeApproachProgress(target * 4)).toBe(1)
  })

  it('rises monotonically across the band', () => {
    const steps = 12
    const values = Array.from({ length: steps + 1 }, (_, i) =>
      computeApproachProgress(floor + ((target - floor) * i) / steps),
    )

    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThan(values[i - 1])
    }
    expect(values.at(0)).toBe(0)
    expect(values.at(-1)).toBe(1)
  })

  it('is logarithmic — half the meter at the geometric mean of the anchors', () => {
    // A ratio-linear map puts 0.5 at the arithmetic mean instead. Pinning the
    // geometric one is what stops the curve being quietly "simplified" later.
    expect(computeApproachProgress(Math.sqrt(floor * target))).toBeCloseTo(0.5, 6)
    expect(computeApproachProgress((floor + target) / 2)).toBeGreaterThan(0.5)
  })

  it('spreads detector jitter evenly across the band', () => {
    // This is the property the log curve is chosen for, so it gets a test rather
    // than a comment. Box-height noise is roughly constant in relative terms, so
    // the same ±2% wobble must move the readout by the same amount whether the
    // user is far away or nearly there. A linear map fails this by concentrating
    // the wobble near the threshold — exactly where the user is trying to hold
    // still — and a reciprocal map fails it at the other end.
    const wobble = (r: number) =>
      computeApproachProgress(r * 1.02) - computeApproachProgress(r * 0.98)

    const nearlyThere = wobble(target * 0.9)
    const wellBack = wobble(floor * 1.5)

    expect(nearlyThere).toBeCloseTo(wellBack, 6)
    expect(nearlyThere).toBeGreaterThan(0)
  })

  it('treats an unmeasured frame as no progress rather than throwing', () => {
    // WebCamera nulls the ratio on every tick the detector misses, which is routine
    // on the turned-head steps.
    expect(computeApproachProgress(null)).toBe(0)
    expect(computeApproachProgress(undefined)).toBe(0)
    expect(computeApproachProgress(Number.NaN)).toBe(0)
    expect(computeApproachProgress(0)).toBe(0)
    expect(computeApproachProgress(-1)).toBe(0)
  })

  it('degrades to a step when the anchors are misconfigured', () => {
    // A floor at or above the target has no band to sweep; it must not divide by
    // zero or run the progress backwards.
    expect(computeApproachProgress(target, target, target)).toBe(1)
    expect(computeApproachProgress(target * 0.9, target, target)).toBe(0)
    expect(computeApproachProgress(target, target, target * 2)).toBe(1)
  })

  it('tracks a threshold override so recalibration moves the indicator with the gate', () => {
    // The indicator completing while the shutter stays locked would be the worst
    // possible failure, so it reads the same threshold the gate does.
    const stricter = target * 1.2
    expect(computeApproachProgress(target, stricter)).toBeLessThan(1)
    expect(computeApproachProgress(stricter, stricter)).toBe(1)
  })
})

// --- copy guardrail -----------------------------------------------------------

describe('messageForIssue', () => {
  it('returns actionable copy for every issue code', () => {
    expect(messageForIssue('no_face')).toMatch(/face/i)
    expect(messageForIssue('low_resolution')).toMatch(/resolution/i)
    expect(messageForIssue('face_too_far')).toMatch(/closer|too far/i)
    expect(messageForIssue('too_dark')).toMatch(/dark/i)
    expect(messageForIssue('overexposed')).toMatch(/light|glare/i)
    expect(messageForIssue('blurry')).toMatch(/blurr?y|still/i)
  })
})
