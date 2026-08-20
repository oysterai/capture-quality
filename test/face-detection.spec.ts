import { describe, it, expect, vi, beforeEach } from 'vitest'

const detectAllFaces = vi.fn()
const loadFromUri = vi.fn()

vi.mock('face-api.js', () => ({
  detectAllFaces: (...args: unknown[]) => detectAllFaces(...args),
  nets: { tinyFaceDetector: { loadFromUri: (...args: unknown[]) => loadFromUri(...args) } },
  TinyFaceDetectorOptions: class {
    scoreThreshold: number
    constructor(opts: { scoreThreshold: number }) {
      this.scoreThreshold = opts.scoreThreshold
    }
  },
}))

const { DEFAULT_FACE_SCORE_THRESHOLD, loadFaceDetectorModels, measureFace } = await import(
  '../src/web/face-detection'
)

/** A camera source rendered into a container with `object-fit: cover`. */
function fakeVideo(rect = { width: 480, height: 640 }, source = { width: 1920, height: 1080 }) {
  return {
    videoWidth: source.width,
    videoHeight: source.height,
    getBoundingClientRect: () => rect,
  } as unknown as HTMLVideoElement
}

const face = (height: number, score = 0.9) => ({ box: { height }, score })

beforeEach(() => {
  detectAllFaces.mockReset()
  loadFromUri.mockReset()
})

describe('loadFaceDetectorModels', () => {
  it('resolves true once the weights load', async () => {
    loadFromUri.mockResolvedValue(undefined)
    await expect(loadFaceDetectorModels()).resolves.toBe(true)
    expect(loadFromUri).toHaveBeenCalledWith('/models')
  })

  it('resolves false instead of throwing, leaving the block-or-degrade call to the app', async () => {
    loadFromUri.mockRejectedValue(new Error('404'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(loadFaceDetectorModels('/custom/models')).resolves.toBe(false)
    expect(loadFromUri).toHaveBeenCalledWith('/custom/models')

    consoleError.mockRestore()
  })
})

describe('measureFace', () => {
  it('reports no face, and no ratio, on an empty detection', async () => {
    detectAllFaces.mockResolvedValue([])
    await expect(measureFace(fakeVideo())).resolves.toEqual({
      detected: false,
      faceHeightRatio: null,
      score: null,
    })
  })

  it('measures the LARGEST box so a bystander further back cannot unblock the shutter', async () => {
    detectAllFaces.mockResolvedValue([face(120, 0.7), face(400, 0.95), face(300, 0.8)])

    const result = await measureFace(fakeVideo())

    expect(result.detected).toBe(true)
    expect(result.score).toBe(0.95)
    // A 16:9 source in a portrait card is cover-cropped horizontally, so the
    // whole 1080px of source height stays visible.
    expect(result.faceHeightRatio).toBeCloseTo(400 / 1080, 5)
  })

  it('normalises against the VISIBLE height, so one threshold holds across layouts', async () => {
    detectAllFaces.mockResolvedValue([face(400)])
    // A portrait phone source is the case that separates them: the landscape
    // panel cover-crops it vertically, so a third of the source height the
    // detector measured against is not on screen at all.
    const phoneSource = { width: 1080, height: 1920 }

    const phone = await measureFace(fakeVideo({ width: 390, height: 844 }, phoneSource))
    const landscapePanel = await measureFace(fakeVideo({ width: 704, height: 600 }, phoneSource))

    expect(phone.faceHeightRatio).toBeCloseTo(400 / 1920, 5)
    expect(landscapePanel.faceHeightRatio).toBeCloseTo(400 / (600 / (704 / 1080)), 5)
    // A raw source-height ratio would report these as identical, and the same
    // distance threshold would then misfire on one of the two layouts.
    expect(landscapePanel.faceHeightRatio!).toBeGreaterThan(phone.faceHeightRatio! * 1.5)
  })

  it('returns a null ratio when the element has no layout yet', async () => {
    detectAllFaces.mockResolvedValue([face(400)])
    const result = await measureFace(fakeVideo({ width: 0, height: 0 }))
    // Null means "not measured", which the core skips rather than failing.
    expect(result).toMatchObject({ detected: true, faceHeightRatio: null })
  })

  it('runs the detector below face-api default, since turned-head captures score lower', async () => {
    detectAllFaces.mockResolvedValue([])
    await measureFace(fakeVideo())

    expect(DEFAULT_FACE_SCORE_THRESHOLD).toBeLessThan(0.5)
    expect(detectAllFaces.mock.calls[0][1]).toMatchObject({
      scoreThreshold: DEFAULT_FACE_SCORE_THRESHOLD,
    })
  })

  it('honours an overridden score threshold', async () => {
    detectAllFaces.mockResolvedValue([])
    await measureFace(fakeVideo(), { scoreThreshold: 0.6 })
    expect(detectAllFaces.mock.calls[0][1]).toMatchObject({ scoreThreshold: 0.6 })
  })

  it('degrades to "no face" instead of rejecting, so one bad tick cannot kill the loop', async () => {
    detectAllFaces.mockRejectedValue(new Error('backend not initialised'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(measureFace(fakeVideo())).resolves.toEqual({
      detected: false,
      faceHeightRatio: null,
      score: null,
    })

    consoleError.mockRestore()
  })
})
