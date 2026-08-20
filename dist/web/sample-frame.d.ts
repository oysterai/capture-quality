/**
 * Sample a live <video> into the fixed-size RGBA frame the core scorer expects.
 *
 * Fixing the working size is not an optimisation, it is what makes the sharpness
 * threshold portable: variance-of-Laplacian scales with resolution, so a value
 * tuned on a 1080p laptop camera would reject everything from a 4K phone unless
 * every caller downsamples identically first. That is exactly the kind of detail
 * that drifts when each app rolls its own, which is why it lives here.
 */
import { type QualityFrame } from '../image-quality.js';
export interface SampledFrame {
    /** RGBA frame downsampled to `workingEdge`. */
    frame: QualityFrame;
    /** True (pre-downsample) source dimensions, for the resolution check. */
    sourceWidth: number;
    sourceHeight: number;
}
export interface FrameSampler {
    /** Returns null when the video isn't ready (no dimensions yet) or 2D context is unavailable. */
    sample(video: HTMLVideoElement): SampledFrame | null;
    /** Drop the retained canvas. Call on unmount. */
    dispose(): void;
}
/**
 * Create a sampler that reuses one offscreen canvas across ticks.
 *
 * The canvas is retained rather than created per call because this runs on every
 * preview tick; allocating a canvas (and its backing surface) at 2Hz churns
 * memory for no benefit.
 */
export declare function createFrameSampler(workingEdge?: number): FrameSampler;
//# sourceMappingURL=sample-frame.d.ts.map