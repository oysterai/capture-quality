/**
 * Sample a live <video> into the fixed-size RGBA frame the core scorer expects.
 *
 * Fixing the working size is not an optimisation, it is what makes the sharpness
 * threshold portable: variance-of-Laplacian scales with resolution, so a value
 * tuned on a 1080p laptop camera would reject everything from a 4K phone unless
 * every caller downsamples identically first. That is exactly the kind of detail
 * that drifts when each app rolls its own, which is why it lives here.
 */
import { DEFAULT_THRESHOLDS, type QualityFrame } from '../image-quality.js'

export interface SampledFrame {
  /** RGBA frame downsampled to `workingEdge`. */
  frame: QualityFrame
  /** True (pre-downsample) source dimensions, for the resolution check. */
  sourceWidth: number
  sourceHeight: number
}

export interface FrameSampler {
  /** Returns null when the video isn't ready (no dimensions yet) or 2D context is unavailable. */
  sample(video: HTMLVideoElement): SampledFrame | null
  /** Drop the retained canvas. Call on unmount. */
  dispose(): void
}

/**
 * Create a sampler that reuses one offscreen canvas across ticks.
 *
 * The canvas is retained rather than created per call because this runs on every
 * preview tick; allocating a canvas (and its backing surface) at 2Hz churns
 * memory for no benefit.
 */
export function createFrameSampler(workingEdge: number = DEFAULT_THRESHOLDS.workingEdge): FrameSampler {
  let canvas: HTMLCanvasElement | null = null

  return {
    sample(video: HTMLVideoElement): SampledFrame | null {
      if (!video || !video.videoWidth || !video.videoHeight) {
        return null
      }

      const sourceWidth = video.videoWidth
      const sourceHeight = video.videoHeight
      const longest = Math.max(sourceWidth, sourceHeight)
      // Never upscale: a source smaller than the working edge is already caught by
      // the resolution check, and upscaling would only distort the sharpness score.
      const scale = Math.min(1, workingEdge / longest)
      const w = Math.max(1, Math.round(sourceWidth * scale))
      const h = Math.max(1, Math.round(sourceHeight * scale))

      if (!canvas) {
        canvas = document.createElement('canvas')
      }
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) {
        return null
      }

      ctx.drawImage(video, 0, 0, w, h)
      return { frame: ctx.getImageData(0, 0, w, h), sourceWidth, sourceHeight }
    },

    dispose() {
      canvas = null
    },
  }
}
