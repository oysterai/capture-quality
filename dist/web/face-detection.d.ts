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
export declare const DEFAULT_FACE_SCORE_THRESHOLD = 0.3;
/** Default location the tiny_face_detector weights are served from. */
export declare const DEFAULT_MODEL_URI = "/models";
/**
 * Load the TinyFaceDetector weights. Resolves true on success, false on failure
 * rather than throwing: callers differ on what a failed load should mean (the
 * self-serve widget blocks, the staff tool degrades to quality-only gating), and
 * that is a product decision, not this module's to make.
 */
export declare function loadFaceDetectorModels(modelUri?: string): Promise<boolean>;
export interface FaceMeasurement {
    /** Whether any face cleared the score threshold this tick. */
    detected: boolean;
    /**
     * Largest face box height as a fraction of the *visible* frame height, or null
     * when it could not be established. Feed straight into `analyzeFrameQuality`,
     * which treats null as "not measured" and skips the distance check.
     */
    faceHeightRatio: number | null;
    /** Detector confidence for the measured face, for calibration/debugging. */
    score: number | null;
}
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
export declare function measureFace(video: HTMLVideoElement, options?: {
    scoreThreshold?: number;
}): Promise<FaceMeasurement>;
//# sourceMappingURL=face-detection.d.ts.map