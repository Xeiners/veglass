// Run: node scripts/test-tutorial-sampling.mjs
// Bundle the real TS modules using Vite's existing esbuild dependency. Only the
// external frame/audio/AI boundaries are mocked: no keys, network or media writes.
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const hooks = { frames: [], requests: [], audio: [], failAt: null, cancel: null };
globalThis.__tutorialSamplingTest = hooks;
const result = await build({
  stdin: { contents: `
    export * from './src/lib/tutorial/frames';
    export { analyseTutorial } from './src/lib/tutorial/analyse';
    export { DEFAULT_TUTORIAL_OPTIONS } from './src/types/tutorial';
    export { DEFAULT_AI_SETTINGS } from './src/types/ai';
  `, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{ name: 'external-boundaries', setup(builder) {
    builder.onResolve({ filter: /^@\/lib\/(viral\/poster|ai\/client)$/ }, ({ path }) => ({ path, namespace: 'mock' }));
    builder.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({ loader: 'js', contents: path.endsWith('poster') ? `
      export const READABLE_WIDTH = 1280;
      export async function poster(asset, at, width) {
        globalThis.__tutorialSamplingTest.frames.push(at);
        return 'data:image/jpeg;base64,dGVzdA==';
      }
    ` : `
      export async function audioExcerpt(asset, start, duration) {
        globalThis.__tutorialSamplingTest.audio.push({ start, duration });
        return { mimeType: 'audio/mpeg', data: 'dGVzdA==', sourceStart: start };
      }
      export async function generate(model, body, options) {
        const hooks = globalThis.__tutorialSamplingTest;
        hooks.requests.push({ model, body, options });
        if (hooks.failAt === hooks.requests.length) throw new Error('Simulated failed batch');
        hooks.cancel?.abort();
        const label = body.contents[0].parts.find(p => p.text?.startsWith('Image à ')).text;
        const at = Number(label.match(/Image à ([0-9.]+)/)[1]);
        return { text: JSON.stringify({ steps: [{ at, until: at + 2, title: 'Action', say: 'On ouvre le menu.', action: 'click', x: .5, y: .5, confidence: 90 }] }) };
      }
    ` }));
  } }],
});
const api = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const { samplingPlan, sampleTimes, windows, normalizeFrameCount, analyseTutorial, DEFAULT_TUTORIAL_OPTIONS, DEFAULT_AI_SETTINGS } = api;
const allTimes = plan => plan.flatMap(span => span.times);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

// Historical output is unchanged, including the merged <30 s tail and short clips.
for (const duration of [8, 30, 54, 79, 80, 180, 360, 361, 389, 390, 719, 720, 1800]) {
  const legacy = windows(duration).map(span => ({ ...span, times: sampleTimes(span) }));
  for (const choice of [undefined, null, NaN, Infinity]) assert.deepEqual(samplingPlan(duration, choice), legacy);
}
assert.equal(allTimes(samplingPlan(360)).length, 40);
assert.equal(allTimes(samplingPlan(54)).length, 27);
assert.equal(allTimes(samplingPlan(720)).length, 80);
assert.equal(DEFAULT_TUTORIAL_OPTIONS.frameCount, null);
assert.equal(normalizeFrameCount(1), 10);
assert.equal(normalizeFrameCount(900), 800);
assert.equal(normalizeFrameCount(120.6), 121);
assert.equal(normalizeFrameCount('120'), null);
for (const duration of [0, -1, NaN, Infinity]) assert.deepEqual(samplingPlan(duration, 120), []);

// Every requested budget covers the whole video in contiguous bounded batches.
for (const duration of [8, 54.13, 180, 360, 389, 390, 600, 720, 3600, 7200]) {
  for (const requested of [10, 40, 41, 80, 120, 160, 320, 800]) {
    const plan = samplingPlan(duration, requested);
    const times = allTimes(plan);
    assert.equal(times.length, Math.max(windows(duration).length, Math.min(requested, Math.floor(duration * 2))));
    near(plan[0].start, 0);
    near(plan.at(-1).start + plan.at(-1).duration, duration);
    for (const [i, span] of plan.entries()) {
      assert.ok(span.times.length > 0 && span.times.length <= 40);
      if (i) near(span.start, plan[i - 1].start + plan[i - 1].duration);
      for (const at of span.times) assert.ok(at >= span.start - .005 && at < span.start + span.duration + .005);
    }
    assert.ok(times.every((at, i) => at >= 0 && at < duration && (!i || at > times[i - 1])));
  }
}

const reset = () => { hooks.frames = []; hooks.requests = []; hooks.audio = []; hooks.failAt = null; hooks.cancel = null; };
const asset = { id: 'test', kind: 'video', name: 'test.mp4', duration: 360 };
const frozenOptions = Object.freeze({ ...DEFAULT_TUTORIAL_OPTIONS, frameCount: 120 });
const progress = [];
let outcome = await analyseTutorial(asset, DEFAULT_AI_SETTINGS, frozenOptions, p => progress.push(p));
assert.equal(outcome.stills, 120);
assert.equal(outcome.failed, 0);
assert.equal(outcome.steps.length, 3);
assert.equal(hooks.requests.length, 3);
assert.deepEqual(hooks.frames, allTimes(samplingPlan(360, 120)));
assert.ok(progress.every((p, i) => p.ratio >= 0 && p.ratio <= 1 && (!i || p.ratio >= progress[i - 1].ratio)));
assert.equal(progress.at(-1).ratio, 1);
for (const [i, request] of hooks.requests.entries()) {
  const parts = request.body.contents[0].parts;
  assert.equal(parts.filter(p => p.inlineData?.mimeType === 'image/jpeg').length, 40);
  assert.equal(parts.filter(p => p.inlineData?.mimeType === 'audio/mpeg').length, 1);
  assert.equal(request.options.timeoutSecs, 420);
  assert.equal(request.model, DEFAULT_AI_SETTINGS.model);
  near(hooks.audio[i].start, i * 120);
  near(hooks.audio[i].duration, 120);
}

reset();
outcome = await analyseTutorial(asset, DEFAULT_AI_SETTINGS, DEFAULT_TUTORIAL_OPTIONS, () => {});
assert.equal(outcome.stills, 40);
assert.equal(hooks.requests.length, 1);

reset(); hooks.failAt = 2;
outcome = await analyseTutorial(asset, DEFAULT_AI_SETTINGS, frozenOptions, () => {});
assert.equal(hooks.requests.length, 3);
assert.equal(outcome.failed, 1);
assert.equal(outcome.stills, 80);

reset();
const controller = new AbortController(); hooks.cancel = controller;
await analyseTutorial(asset, DEFAULT_AI_SETTINGS, frozenOptions, () => {}, controller.signal);
assert.equal(hooks.requests.length, 1, 'Cancellation must stop subsequent paid batches');
assert.equal(hooks.frames.length, 40);
delete globalThis.__tutorialSamplingTest;
console.log('PASS: unchanged automatic mode, custom budgets, short/long videos, complete coverage, bounded requests, labelled frames/audio, progress, failed batches and cancellation (mocked services).');
