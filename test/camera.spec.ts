import { describe, it, expect, vi } from 'vitest'
import {
  attachStream,
  buildCameraConstraints,
  IDEAL_CAPTURE_HEIGHT,
  IDEAL_CAPTURE_WIDTH,
  openCamera,
} from '../src/web/camera'

describe('buildCameraConstraints', () => {
  it('always requests scan resolution, since the browser default of 640x480 is the biggest quality regression there is', () => {
    const video = buildCameraConstraints('user').video as MediaTrackConstraints
    expect(video.width).toEqual({ ideal: IDEAL_CAPTURE_WIDTH })
    expect(video.height).toEqual({ ideal: IDEAL_CAPTURE_HEIGHT })
  })

  it('uses `ideal` rather than `exact` so low-end cameras still open', () => {
    const video = buildCameraConstraints('user').video as MediaTrackConstraints
    expect(video.facingMode).toEqual({ ideal: 'user' })
    expect(JSON.stringify(video)).not.toContain('exact')
  })

  it('defaults to the front camera and honours an explicit facing mode', () => {
    expect((buildCameraConstraints().video as MediaTrackConstraints).facingMode).toEqual({ ideal: 'user' })
    expect((buildCameraConstraints('environment').video as MediaTrackConstraints).facingMode).toEqual({
      ideal: 'environment',
    })
  })

  it('never requests audio', () => {
    expect(buildCameraConstraints().audio).toBe(false)
  })
})

describe('openCamera', () => {
  it('passes the built constraints straight to getUserMedia', async () => {
    const stream = {} as MediaStream
    const getUserMedia = vi.fn().mockResolvedValue(stream)
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })

    await expect(openCamera('environment')).resolves.toBe(stream)
    expect(getUserMedia).toHaveBeenCalledWith(buildCameraConstraints('environment'))

    vi.unstubAllGlobals()
  })

  it('propagates a rejection so callers can render their own blocked state', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new Error('NotAllowedError'))
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })

    await expect(openCamera()).rejects.toThrow('NotAllowedError')

    vi.unstubAllGlobals()
  })
})

describe('attachStream', () => {
  function fakeVideo(play: () => Promise<void>) {
    return { srcObject: null, style: {}, play: vi.fn(play) } as unknown as HTMLVideoElement & {
      play: ReturnType<typeof vi.fn>
    }
  }

  it('assigns the stream and explicitly calls play(), which is what unsticks WKWebView', async () => {
    const el = fakeVideo(() => Promise.resolve())
    const stream = {} as MediaStream

    await attachStream(el, stream)

    expect(el.srcObject).toBe(stream)
    expect(el.play).toHaveBeenCalledTimes(1)
  })

  it('resolves even when play() is refused, because canplay may still arrive', async () => {
    const el = fakeVideo(() => Promise.reject(new Error('NotAllowedError')))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(attachStream(el, {} as MediaStream)).resolves.toBeUndefined()
    // The stream is live either way, so the caller must not be pushed into its
    // "camera unavailable" dead end by a playback refusal.
    expect(el.srcObject).not.toBeNull()

    consoleError.mockRestore()
  })
})
