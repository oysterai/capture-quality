# @oysterai/capture-quality

Real-time camera capture-quality gating: **blur, exposure, resolution, face presence and
distance**. One implementation, shared by every Oyster capture surface.

It exists because there were three cameras. The widget's had the full gate, the vendor
dashboard's had a hand-copied subset that had already drifted (no distance check, and a
detector running at a different sensitivity), and mobile had nothing. Fixing the widget
never reached the others.

## Layout

| Entry | Needs | Contains |
| --- | --- | --- |
| `@oysterai/capture-quality` | nothing | Scoring: thresholds, issue codes and priority, `analyzeFrameQuality`, `computeFaceHeightRatio`, `computeApproachProgress` |
| `@oysterai/capture-quality/web` | DOM | `createFrameSampler`, `openCamera`/`buildCameraConstraints`/`attachStream`, `measureFace` (face-api.js), `normalizeScanImage`, HEIC conversion |

The core is platform-free by contract: no DOM, no canvas, no camera, no framework. Face
*detection* is deliberately outside it, and callers pass `faceDetected` and
`faceHeightRatio` in. That is what lets the same thresholds and the same verdict logic
serve face-api.js in a browser and MLKit/MediaPipe on native without a second
implementation of the rules.

Nothing in here renders anything. Templates, styling, capture flow and copy stay in the
consuming app.

## Install

```jsonc
// package.json
"@oysterai/capture-quality": "github:oysterai/capture-quality#v0.1.0"
```

The repo is public and `dist/` is committed, so this needs no registry auth and no build
step in any CI environment (Cloudflare Pages, GitHub Actions, EAS). Once the package is
published to npm this becomes a plain `"^0.1.0"`, with no code change on either side.

`face-api.js` and `heic2any` are **optional** peers, only needed if you import
`measureFace` or `convertHeicToJpeg`. The package is `sideEffects: false`, so importing
`/web` for `normalizeScanImage` alone will not pull face-api.js into your bundle.

## Use

```ts
import { analyzeFrameQuality, computeApproachProgress } from '@oysterai/capture-quality'
import { createFrameSampler, measureFace, loadFaceDetectorModels } from '@oysterai/capture-quality/web'

const sampler = createFrameSampler()
await loadFaceDetectorModels('/models')

// on each tick (~500ms)
const face = await measureFace(videoEl)
const sampled = sampler.sample(videoEl)
if (!sampled) return

const result = analyzeFrameQuality({
  ...sampled,
  faceDetected: face.detected,
  faceHeightRatio: face.faceHeightRatio,
})

shutterEnabled.value = result.pass
hint.value = result.message                                   // actionable copy, or null
meter.value = computeApproachProgress(face.faceHeightRatio)   // 0..1 "move closer"
```

The tick loop itself stays in the app on purpose. The two consumers deliberately differ on
what a failed model load means (the self-serve widget blocks the shutter, the staff tool
degrades to quality-only gating) and on where the warning sits relative to the pose hint,
and forcing those to converge would be a product regression, not a cleanup.

Every threshold is injectable. `analyzeFrameQuality(input, myThresholds)` overrides
`DEFAULT_THRESHOLDS` wholesale.

## Calibration

`DEFAULT_THRESHOLDS` are tuned for **face-api.js TinyFaceDetector** frames downsampled to a
320px longest edge. Two of them do not transfer on their own:

- **`minSharpness` (120)** is a variance-of-Laplacian score, which scales with resolution.
  It is only meaningful at `workingEdge`. Change one and you must retune the other.
- **`minFaceHeightRatio` (0.46)** is measured against TinyFaceDetector's *tight* box (brow
  to chin, excluding hair and forehead). MLKit and MediaPipe return a larger head box and
  will read higher at the same distance, so a native port needs its own calibration pass
  rather than this number.

## Releasing

```bash
npm run verify          # typecheck + test + build
git commit -am "..."    # dist/ included; CI fails the build if it is stale
git tag v0.2.0 && git push --tags
```

Consumers pin the tag, so a release is not live anywhere until someone bumps the
specifier. `.github/workflows/publish.yml` also publishes to npm on tag, and skips itself
until an `NPM_TOKEN` secret exists.
