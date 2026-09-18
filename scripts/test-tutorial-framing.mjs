// Run: node scripts/test-tutorial-framing.mjs (pure code, no media/API writes).
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const compiled = await build({
  stdin: { contents: `
    export { placeTutorial } from './src/lib/tutorial/build';
    export { DEFAULT_TUTORIAL_OPTIONS, zoomProfileOf } from './src/types/tutorial';
    export { smartZoom } from './src/lib/tutorial/zoom';
    export { fitClip } from './src/lib/fitClip';
    export { resolveClipAt } from './src/store/selectors';
  `, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { placeTutorial, DEFAULT_TUTORIAL_OPTIONS, zoomProfileOf, smartZoom, fitClip, resolveClipAt } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`
);
assert.equal(DEFAULT_TUTORIAL_OPTIONS.zoom, 'off');
assert.equal(zoomProfileOf(undefined).id, 'off');
assert.equal(zoomProfileOf('invalid').id, 'off');
const steps = [{ id: 'step', at: 10, until: 13, title: 'Ouvrir', say: 'On ouvre le menu.', action: 'click', point: { x: .8, y: .3 }, confidence: 95, enabled: true, banner: null, shortcut: null, take: null }];
const options = { ...DEFAULT_TUTORIAL_OPTIONS, voiceover: false, cursor: false, banners: false, captions: false, chapters: false };

for (const [sw, sh, pw, ph] of [[1920,1080,1920,1080], [1920,1080,1080,1920], [1080,1920,1920,1080], [3840,2160,1080,1080]]) {
  const asset = { id: 'source', kind: 'video', name: 'recording.mp4', width: sw, height: sh, duration: 60 };
  const existing = { id: 'existing', kind: 'media', trackId: 'existing-track', assetId: 'source', start: 0, duration: 5, scale: 1.7 };
  const settings = { width: pw, height: ph, fps: 30 };
  const project = { id: 'project', name: 'test', settings, clips: [existing], assets: [asset], tracks: [], transitions: [], schemaVersion: 11 };
  const before = JSON.stringify(project);
  const outcome = placeTutorial(project, asset, steps, options, new Map(), new Map());
  const screen = outcome.project.clips.find(c => c.id !== 'existing' && c.assetId === 'source');
  assert.deepEqual([screen.scale, screen.x, screen.y, screen.rotation], [1, 0, 0, 0]);
  assert.equal(outcome.shots, 0);
  for (const key of ['scale', 'x', 'y', 'rotation']) assert.equal(screen.animation?.[key], undefined);
  assert.equal(smartZoom(steps, screen, asset, settings, zoomProfileOf('off')), undefined);
  assert.equal(outcome.project.settings, settings, 'Project resolution unchanged');
  assert.equal(outcome.project.clips[0], existing, 'Existing edits unchanged');
  assert.equal(JSON.stringify(project), before, 'Input project not mutated');

  const animated = placeTutorial(project, asset, steps, { ...options, zoom: 'balanced' }, new Map(), new Map());
  const zoomed = animated.project.clips.find(c => c.id !== 'existing' && c.assetId === 'source');
  assert.ok(animated.shots > 0 && zoomed.animation?.scale, 'Explicit zoom still works');
  assert.equal(zoomed.scale, 1, 'No hidden cover multiplier even with explicit zoom');
  for (const at of [0, 30, 59]) assert.equal(resolveClipAt(zoomed, at).scale, 1, 'Action zoom returns to the full recording');

  const volume = [{ id: 'audio-key', time: 0, value: .5, easing: { x1: 0, y1: 0, x2: 1, y2: 1 } }];
  const old = { ...zoomed, scale: 3.16, x: -150, y: 40, rotation: 15, animation: { ...zoomed.animation, volume } };
  const oldSnapshot = JSON.stringify(old);
  const fitted = fitClip(old, asset);
  assert.deepEqual([fitted.scale, fitted.x, fitted.y, fitted.rotation], [1, 0, 0, 0]);
  assert.equal(fitted.animation.volume, volume, 'Narration ducking preserved');
  assert.deepEqual(Object.keys(fitted.animation), ['volume'], 'Old camera curves actually removed');
  assert.equal(fitted.effects, old.effects);
  assert.equal(JSON.stringify(old), oldSnapshot, 'Manual fit is immutable');
  for (const at of [0, 10, 30, 59]) assert.equal(resolveClipAt(fitted, at).scale, 1);

  const image = { ...asset, kind: 'image' };
  assert.equal(fitClip(old, image), old, 'Unrelated image layers are untouched');
}
console.log('PASS: fixed default, full-width resting shot in all formats, explicit zoom returns to uncropped frame, manual fit clears only camera animation, resolution/audio/existing edits preserved.');
