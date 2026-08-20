import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { normalizeScanImage } from '../src/web/normalize-scan-image'

/**
 * jsdom has neither createImageBitmap nor a real canvas, so these tests stub
 * both and pin the DECISION logic: what passes through untouched, what gets
 * redrawn and at which target size. Pixel fidelity is out of scope here — the
 * live pass-through check against the real backend covers that.
 */

let bitmapSize = { width: 640, height: 480 }
const drawImage = vi.fn()
const toBlobResult = { blob: new Blob([new Uint8Array(1000)], { type: 'image/jpeg' }) }
let lastCanvas: { width: number; height: number } | null = null

beforeEach(() => {
  drawImage.mockClear()
  lastCanvas = null

  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ ...bitmapSize, close: vi.fn() })),
  )

  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    if (tag !== 'canvas') throw new Error('unexpected element: ' + tag)
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage }),
      toBlob: (cb: (b: Blob | null) => void) => cb(toBlobResult.blob),
    }
    lastCanvas = canvas as unknown as { width: number; height: number }
    return canvas as unknown as HTMLElement
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function jpeg(name: string, bytes: number): File {
  return new File([new Uint8Array(bytes)], name, { type: 'image/jpeg' })
}

describe('normalizeScanImage decision boundaries', () => {
  it('passes a full 1080p-class camera capture through untouched', async () => {
    // The camera now captures at ideal 1920×1080 — within the 2560 edge cap,
    // so a lean capture must never be re-encoded (and degraded).
    bitmapSize = { width: 1920, height: 1080 }
    const file = jpeg('capture.jpg', 600_000)

    expect(await normalizeScanImage(file)).toBe(file)
    expect(drawImage).not.toHaveBeenCalled()
  })

  it('downscales anything over the 2560 edge cap to exactly the cap', async () => {
    bitmapSize = { width: 4032, height: 3024 }
    const file = jpeg('gallery.jpg', 4_000_000)

    const result = await normalizeScanImage(file)

    expect(result).not.toBe(file)
    expect(result.type).toBe('image/jpeg')
    expect(lastCanvas).toMatchObject({ width: 2560, height: 1920 })
  })

  it('re-encodes an over-1MB file even when its dimensions are within the cap', async () => {
    bitmapSize = { width: 2400, height: 1600 }
    const file = jpeg('dense.jpg', 2_500_000)

    const result = await normalizeScanImage(file)

    expect(result).not.toBe(file)
    // No downscale needed — only the re-encode.
    expect(lastCanvas).toMatchObject({ width: 2400, height: 1600 })
  })

  it('keeps the original when the re-encode would grow the file', async () => {
    bitmapSize = { width: 3000, height: 2000 }
    const file = jpeg('tiny-but-wide.jpg', 500) // smaller than the stubbed 1000-byte blob

    expect(await normalizeScanImage(file)).toBe(file)
  })

  it('leaves non-processable types alone', async () => {
    const file = new File([new Uint8Array(5_000_000)], 'clip.gif', { type: 'image/gif' })

    expect(await normalizeScanImage(file)).toBe(file)
    expect(drawImage).not.toHaveBeenCalled()
  })

  it('falls back to the original when decoding throws', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => {
        throw new Error('corrupt')
      }),
    )
    const file = jpeg('broken.jpg', 3_000_000)

    expect(await normalizeScanImage(file)).toBe(file)
  })
})
