import { describe, it, expect, vi } from 'vitest'
import { createFrameSampler } from '../src/web/sample-frame'
import { DEFAULT_THRESHOLDS } from '../src/image-quality'

/**
 * jsdom has no canvas 2D implementation, so the context is stubbed. What matters
 * here is the geometry handed to it, which is the part that makes the sharpness
 * threshold portable across cameras.
 */
function stubCanvas(ctx: unknown = null) {
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ctx),
  }
  const spy = vi.spyOn(document, 'createElement').mockReturnValue(canvas as unknown as HTMLElement)
  return { canvas, spy }
}

function fakeCtx() {
  return {
    drawImage: vi.fn(),
    getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4),
      width: w,
      height: h,
    })),
  }
}

function fakeVideo(videoWidth: number, videoHeight: number) {
  return { videoWidth, videoHeight } as unknown as HTMLVideoElement
}

describe('createFrameSampler', () => {
  it('downsamples the longest edge to the working edge and keeps aspect ratio', () => {
    const ctx = fakeCtx()
    const { canvas, spy } = stubCanvas(ctx)
    try {
      const sampled = createFrameSampler().sample(fakeVideo(1920, 1080))

      expect(canvas.width).toBe(DEFAULT_THRESHOLDS.workingEdge)
      expect(canvas.height).toBe(Math.round(1080 * (DEFAULT_THRESHOLDS.workingEdge / 1920)))
      // The resolution check needs the TRUE source size, not the sampled size.
      expect(sampled?.sourceWidth).toBe(1920)
      expect(sampled?.sourceHeight).toBe(1080)
      expect(sampled?.frame.width).toBe(canvas.width)
    } finally {
      spy.mockRestore()
    }
  })

  it('scales against the longest edge on a portrait source', () => {
    const ctx = fakeCtx()
    const { canvas, spy } = stubCanvas(ctx)
    try {
      createFrameSampler().sample(fakeVideo(1080, 1920))
      expect(canvas.height).toBe(DEFAULT_THRESHOLDS.workingEdge)
      expect(canvas.width).toBe(Math.round(1080 * (DEFAULT_THRESHOLDS.workingEdge / 1920)))
    } finally {
      spy.mockRestore()
    }
  })

  it('never upscales a source smaller than the working edge', () => {
    const ctx = fakeCtx()
    const { canvas, spy } = stubCanvas(ctx)
    try {
      createFrameSampler().sample(fakeVideo(160, 120))
      // Upscaling would inflate the variance-of-Laplacian score and let a frame
      // that is genuinely too small read as sharp.
      expect(canvas.width).toBe(160)
      expect(canvas.height).toBe(120)
    } finally {
      spy.mockRestore()
    }
  })

  it('reuses one canvas across ticks', () => {
    const ctx = fakeCtx()
    const { spy } = stubCanvas(ctx)
    try {
      const sampler = createFrameSampler()
      sampler.sample(fakeVideo(1920, 1080))
      sampler.sample(fakeVideo(1920, 1080))
      sampler.sample(fakeVideo(1920, 1080))
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('allocates again after dispose', () => {
    const ctx = fakeCtx()
    const { spy } = stubCanvas(ctx)
    try {
      const sampler = createFrameSampler()
      sampler.sample(fakeVideo(1920, 1080))
      sampler.dispose()
      sampler.sample(fakeVideo(1920, 1080))
      expect(spy).toHaveBeenCalledTimes(2)
    } finally {
      spy.mockRestore()
    }
  })

  it('honours a custom working edge', () => {
    const ctx = fakeCtx()
    const { canvas, spy } = stubCanvas(ctx)
    try {
      createFrameSampler(64).sample(fakeVideo(1920, 1080))
      expect(canvas.width).toBe(64)
    } finally {
      spy.mockRestore()
    }
  })

  it.each([
    ['no dimensions yet', 0, 0],
    ['height not established', 640, 0],
  ])('returns null when the video is not ready (%s)', (_label, w, h) => {
    const sampler = createFrameSampler()
    expect(sampler.sample(fakeVideo(w, h))).toBeNull()
  })

  it('returns null when a 2D context is unavailable', () => {
    const { spy } = stubCanvas(null)
    try {
      expect(createFrameSampler().sample(fakeVideo(1920, 1080))).toBeNull()
    } finally {
      spy.mockRestore()
    }
  })
})
