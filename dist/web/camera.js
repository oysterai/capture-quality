/**
 * getUserMedia plumbing shared by every browser capture surface.
 *
 * Both of the pieces here are hard-won rather than boilerplate: the resolution
 * constraint is the single biggest lever on scan input quality, and the explicit
 * `play()` is what keeps the flow alive inside a WKWebView. Each was fixed once
 * in the widget and then silently missing from the dashboard camera for weeks.
 */
/**
 * Without an explicit resolution browsers default to 640x480 (~0.3MP), and
 * production scans were overwhelmingly captured at exactly that. The analyzer and
 * the evidence-crop layer both receive the capture at full resolution, so this is
 * the single biggest lever on scan input quality.
 *
 * `ideal` never hard-fails: the browser picks the closest supported mode, so
 * old/low-end cameras keep working at whatever they have.
 */
export const IDEAL_CAPTURE_WIDTH = 1920;
export const IDEAL_CAPTURE_HEIGHT = 1080;
export function buildCameraConstraints(facingMode = 'user') {
    return {
        video: {
            facingMode: { ideal: facingMode },
            width: { ideal: IDEAL_CAPTURE_WIDTH },
            height: { ideal: IDEAL_CAPTURE_HEIGHT },
        },
        audio: false,
    };
}
/** Request the camera at scan resolution. Rejects exactly as getUserMedia does. */
export function openCamera(facingMode = 'user') {
    return navigator.mediaDevices.getUserMedia(buildCameraConstraints(facingMode));
}
/**
 * Attach a stream to a <video> and *explicitly* start playback.
 *
 * The `autoplay` attribute alone is not enough. WebKit evaluates it during the media load
 * algorithm, so a `srcObject` assigned afterwards can leave the element parked below
 * `readyState 3` inside a WKWebView, which is what breaks the scan in the Oyster app's
 * consultation WebView while it works in every desktop browser. `canplay` then never fires,
 * and face-api's `awaitMediaLoaded` waits on a `load` event that a <video> element never
 * emits, so detection hangs rather than fails. Calling `play()` is what starts the pipeline.
 *
 * A rejected `play()` is swallowed on purpose: the stream is live, only playback was
 * refused, and `canplay` may still arrive on its own. Callers gate their analysis loop on
 * that event either way, so a rejection here can never start detection against a dead video.
 */
export async function attachStream(el, stream) {
    el.srcObject = stream;
    el.style.backgroundColor = 'transparent';
    try {
        await el.play();
    }
    catch (err) {
        console.error(err);
    }
}
//# sourceMappingURL=camera.js.map