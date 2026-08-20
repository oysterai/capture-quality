/**
 * face-api.js wrapper: model loading plus the one measurement the quality core
 * needs back from a detector (is there a face, and how big is it on screen).
 *
 * Kept behind this seam so the core never imports a detector. Swapping face-api
 * for MediaPipe, or adding an MLKit implementation on native, means writing
 * another module with this same shape rather than touching the scoring rules.
 */
import { detectAllFaces, nets, TinyFaceDetectorOptions } from 'face-api.js';
import { computeFaceHeightRatio } from '../image-quality.js';
/**
 * `scoreThreshold` sits below face-api's 0.5 default on purpose. Two of the three
 * scan captures are deliberately turned-head profiles ("Turn your head slightly
 * to the left/right"), and TinyFaceDetector (TinyYolov2 trained on WIDERFACE)
 * scores non-frontal faces markedly lower than frontal ones. At 0.5 those frames
 * intermittently read as "no face", which blocks the shutter on two thirds of the
 * flow.
 *
 * Lowering it is low-risk: a spurious detection only *unlocks* the shutter, and
 * the frame must still clear the distance, exposure and sharpness gates
 * afterwards. `inputSize` is left at the 416 default deliberately, since it governs
 * how well *small* faces resolve, and a face's size relative to the input is
 * invariant to it, so raising it would cost latency without helping profiles.
 */
export const DEFAULT_FACE_SCORE_THRESHOLD = 0.3;
/** Default location the tiny_face_detector weights are served from. */
export const DEFAULT_MODEL_URI = '/models';
let detectorOptions = null;
let detectorScoreThreshold = null;
function optionsFor(scoreThreshold) {
    // Built once rather than per tick.
    if (!detectorOptions || detectorScoreThreshold !== scoreThreshold) {
        detectorOptions = new TinyFaceDetectorOptions({ scoreThreshold });
        detectorScoreThreshold = scoreThreshold;
    }
    return detectorOptions;
}
/**
 * Load the TinyFaceDetector weights. Resolves true on success, false on failure
 * rather than throwing: callers differ on what a failed load should mean (the
 * self-serve widget blocks, the staff tool degrades to quality-only gating), and
 * that is a product decision, not this module's to make.
 */
export async function loadFaceDetectorModels(modelUri = DEFAULT_MODEL_URI) {
    try {
        await nets.tinyFaceDetector.loadFromUri(modelUri);
        return true;
    }
    catch (error) {
        console.error('Error loading face detection models:', error);
        return false;
    }
}
const NO_FACE = { detected: false, faceHeightRatio: null, score: null };
/**
 * Measure face presence and distance for one preview frame.
 *
 * No cooldown or latching by design. An earlier version held a 2s "hold still"
 * freeze after each successful detection, which left the reading stale for up to
 * four ticks and made the distance gate lie: step backwards and the shutter stays
 * green for two seconds.
 *
 * Errors resolve to "no face" rather than rejecting, so a single bad tick cannot
 * take down a caller's interval loop.
 */
export async function measureFace(video, options = {}) {
    if (!video)
        return NO_FACE;
    try {
        const detections = await detectAllFaces(video, optionsFor(options.scoreThreshold ?? DEFAULT_FACE_SCORE_THRESHOLD));
        if (detections.length === 0) {
            return NO_FACE;
        }
        // Largest box = nearest face, so a bystander further back can never be the
        // one that unblocks the shutter.
        const largest = detections.reduce((a, b) => (b.box.height > a.box.height ? b : a));
        const rect = video.getBoundingClientRect();
        return {
            detected: true,
            score: largest.score,
            // Height, not width: yaw (turning the head for the Left/Right captures)
            // narrows the box while leaving its height broadly intact, so height is the
            // dimension that tracks distance rather than pose.
            faceHeightRatio: computeFaceHeightRatio({
                boxHeight: largest.box.height,
                videoWidth: video.videoWidth,
                videoHeight: video.videoHeight,
                frameWidth: rect.width,
                frameHeight: rect.height,
            }),
        };
    }
    catch (error) {
        console.error('Face detection error:', error);
        return NO_FACE;
    }
}
//# sourceMappingURL=face-detection.js.map