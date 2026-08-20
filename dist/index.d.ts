/**
 * `@oysterai/capture-quality` — core entrypoint.
 *
 * Platform-free by contract: no DOM, no canvas, no camera, no framework. It
 * scores an already-sampled RGBA frame and answers "is this good enough to
 * analyse, and if not, what do I tell the user".
 *
 * Face *detection* deliberately lives outside this module. Callers pass
 * `faceDetected` and `faceHeightRatio` in, which is what lets the same
 * thresholds and the same verdict logic serve face-api.js in the browser and
 * MLKit/MediaPipe on native without a second implementation.
 *
 * Browser plumbing (canvas sampling, getUserMedia, face-api, HEIC, upload
 * normalisation) lives in `@oysterai/capture-quality/web`.
 */
export * from './image-quality.js';
//# sourceMappingURL=index.d.ts.map