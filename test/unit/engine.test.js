import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackEngine, PLAYBACK_STATE } from '../../src/playback/engine.js';
import { NullAdapter } from '../../src/playback/adapters/nullAdapter.js';
import { PlaybackError } from '../../src/core/errors.js';
import { createTrack, AVAILABILITY } from '../../src/core/track.js';
import { seededRandom } from '../../src/core/util.js';
import { makeServices, makeTracks, makeTrack, waitFor } from '../helpers.js';

/**
 * The engine is exercised against a deterministic silent adapter
 * (`autoTick: false`, so time only moves when a test says so) and a fake
 * registry. That makes every transition observable without real audio.
 */
function harness({ resolve, settings: overrides } = {}) {
  const services = makeServices({ settings: overrides });
  const adapter = new NullAdapter({ autoTick: false });
  const registry = {
    has: () => true,
    get: () => ({ resolve: resolve ?? (async (t) => t) }),
  };
  const engine = new PlaybackEngine({
    adapter,
    registry,
    history: services.history,
    settings: services.settings,
    random: seededRandom(7),
  });
  return {
    engine,
    adapter,
    services,
    async close() {
      await engine.dispose();
      services.close();
    },
  };
}

test('engine: playTracks moves idle -> playing and records history', async (t) => {
  const h = harness();
  t.after(() => h.close());

  assert.equal(h.engine.state.status, PLAYBACK_STATE.IDLE);
  await h.engine.playTracks(makeTracks(3), 0);

  assert.equal(h.engine.state.status, PLAYBACK_STATE.PLAYING);
  assert.equal(h.engine.state.track.title, 'Track 1');
  assert.equal(h.engine.state.duration, 101);
  assert.equal(h.services.history.openSessionTrackId, h.engine.state.track.id);
});

test('engine: pause and resume round-trip without losing position', async (t) => {
  const h = harness();
  t.after(() => h.close());
  await h.engine.playTracks(makeTracks(2), 0);
  h.adapter.advance(12);
  assert.equal(Math.round(h.engine.state.position), 12);

  await h.engine.pause();
  assert.equal(h.engine.state.status, PLAYBACK_STATE.PAUSED);
  assert.equal(Math.round(h.engine.state.position), 12);

  await h.engine.resume();
  assert.equal(h.engine.state.status, PLAYBACK_STATE.PLAYING);
  assert.equal(Math.round(h.engine.state.position), 12);
});

test('engine: togglePlayPause follows the state machine', async (t) => {
  const h = harness();
  t.after(() => h.close());
  await h.engine.playTracks(makeTracks(1), 0);
  await h.engine.togglePlayPause();
  assert.equal(h.engine.state.status, PLAYBACK_STATE.PAUSED);
  await h.engine.togglePlayPause();
  assert.equal(h.engine.state.status, PLAYBACK_STATE.PLAYING);
});

test('engine: stop clears position and current playback', async (t) => {
  const h = harness();
  t.after(() => h.close());
  await h.engine.playTracks(makeTracks(2), 0);
  h.adapter.advance(30);
  await h.engine.stop();
  assert.equal(h.engine.state.status, PLAYBACK_STATE.IDLE);
  assert.equal(h.engine.state.position, 0);
});

test('engine: a finished track auto-advances to the next one', async (t) => {
  const h = harness();
  t.after(() => h.close());
  await h.engine.playTracks(makeTracks(3), 0);
  h.adapter.emit('ended', {});
  await waitFor(() => h.engine.state.track?.title === 'Track 2', { label: 'auto advance' });
  assert.equal(h.engine.state.status, PLAYBACK_STATE.PLAYING);
});

test('engine: the end of the queue stops playback and announces it', async (t) => {
  const h = harness();
  t.after(() => h.close());
  let finished = false;
  h.engine.on('queue-finished', () => {
    finished = true;
  });
  await h.engine.playTracks([makeTrack(1)], 0);
  h.adapter.emit('ended', {});
  await waitFor(() => finished, { label: 'queue-finished' });
  assert.equal(h.engine.state.status, PLAYBACK_STATE.IDLE);
});

test('engine: autoAdvance off leaves playback idle at the end of a track', async (t) => {
  const h = harness({ settings: {} });
  t.after(() => h.close());
  h.services.settings.set('autoAdvance', false);
  await h.engine.playTracks(makeTracks(3), 0);
  h.adapter.emit('ended', {});
  await waitFor(() => h.engine.state.status === PLAYBACK_STATE.IDLE, { label: 'idle' });
  assert.equal(h.engine.state.track.title, 'Track 1', 'the track does not change');
});

test('engine: previous restarts the track when past the threshold', async (t) => {
  const h = harness();
  t.after(() => h.close());
  await h.engine.playTracks(makeTracks(3), 1);
  h.adapter.advance(30);
  await h.engine.previous();
  assert.equal(h.engine.state.track.title, 'Track 2', 'still the same track');
  assert.equal(h.engine.state.position, 0, 'restarted from the beginning');
});

test('engine: previous moves back when near the start of a track', async (t) => {
  const h = harness();
  t.after(() => h.close());
  await h.engine.playTracks(makeTracks(3), 1);
  h.adapter.advance(1);
  await h.engine.previous();
  assert.equal(h.engine.state.track.title, 'Track 1');
});

test('engine: an unplayable track fails cleanly and skips on', async (t) => {
  const h = harness({
    resolve: async (track) =>
      track.title === 'Track 1'
        ? createTrack({ ...track, availability: AVAILABILITY.UNAVAILABLE, streamUrl: null })
        : track,
  });
  t.after(() => h.close());

  const errors = [];
  h.engine.on('playback-error', (e) => errors.push(e));
  await h.engine.playTracks(makeTracks(3), 0);

  assert.equal(errors.length, 1);
  assert.match(errors[0].title, /not available/);
  await waitFor(() => h.engine.state.track?.title === 'Track 2', { label: 'skip past dead track' });
});

test('engine: repeated failures stop the auto-skip instead of spinning', async (t) => {
  const h = harness({
    resolve: async (track) =>
      createTrack({ ...track, availability: AVAILABILITY.UNAVAILABLE, streamUrl: null }),
  });
  t.after(() => h.close());

  const notices = [];
  h.engine.on('notice', (n) => notices.push(n));
  await h.engine.playTracks(makeTracks(10), 0);
  await waitFor(() => notices.some((n) => /Several tracks in a row/.test(n.message)), {
    timeoutMs: 5000,
    label: 'give-up notice',
  });
  assert.equal(h.engine.state.status, PLAYBACK_STATE.ERROR);
});

test('engine: an adapter error surfaces as a user-facing message', async (t) => {
  const h = harness();
  t.after(() => h.close());
  const errors = [];
  h.engine.on('playback-error', (e) => errors.push(e));

  await h.engine.playTracks([makeTrack(1)], 0);
  h.adapter.fail(
    new PlaybackError('stream died', { userMessage: 'Could not reach the audio stream' }),
  );

  assert.equal(h.engine.state.status, PLAYBACK_STATE.ERROR);
  assert.equal(errors.at(-1).title, 'Could not reach the audio stream');
});

test('engine: seek clamps to the track duration and never goes negative', async (t) => {
  const h = harness();
  t.after(() => h.close());
  await h.engine.playTracks([makeTrack(1)], 0); // duration 101

  await h.engine.seekTo(-50);
  assert.equal(h.engine.state.position, 0);

  await h.engine.seekTo(9999);
  assert.equal(h.engine.state.position, 100, 'clamped to duration - 1');

  await h.engine.seekBy(-40);
  assert.equal(h.engine.state.position, 60);
});

test('engine: volume is clamped and persisted to settings', async (t) => {
  const h = harness();
  t.after(() => h.close());
  await h.engine.setVolume(140);
  assert.equal(h.engine.state.volume, 100);
  await h.engine.adjustVolume(-250);
  assert.equal(h.engine.state.volume, 0);
  assert.equal(h.services.settings.get('volume'), 0, 'survives a restart');
});

test('engine: shuffle and repeat are mirrored into settings', async (t) => {
  const h = harness();
  t.after(() => h.close());
  assert.equal(h.engine.toggleShuffle(), true);
  assert.equal(h.services.settings.get('shuffle'), true);
  assert.equal(h.engine.cycleRepeat(), 'one');
  assert.equal(h.services.settings.get('repeat'), 'one');
});

test('engine: enqueue on an empty queue selects but does not start playing', async (t) => {
  const h = harness();
  t.after(() => h.close());
  h.engine.enqueue(makeTracks(2));
  assert.equal(h.engine.state.status, PLAYBACK_STATE.IDLE);
  assert.equal(h.engine.state.track.title, 'Track 1');
  assert.equal(h.engine.state.queueLength, 2);
});

test('engine: seeking ahead does not inflate recorded listening time', async (t) => {
  const h = harness();
  t.after(() => h.close());
  await h.engine.playTracks(makeTracks(2), 0);
  // Jump 90 seconds into the track: none of it was listened to.
  await h.engine.seekTo(90);
  h.adapter.advance(0.2);
  await h.engine.stop();
  assert.equal(h.services.history.count(), 0, 'a seek is not listening');
});

test('engine: history records real listening time, not skips', async (t) => {
  const h = harness();
  t.after(() => h.close());

  await h.engine.playTracks(makeTracks(2), 0);
  // The engine credits listening time as `min(wall-clock delta, position
  // delta)`, so a seek can never inflate it. That means this test has to
  // spend real time: advance the position in step with the clock.
  for (let i = 0; i < 9; i += 1) {
    await new Promise((r) => setTimeout(r, 400));
    h.adapter.advance(0.4);
  }
  await h.engine.stop();

  const entries = h.services.history.list();
  assert.equal(entries.length, 1, 'one row per listening session');
  assert.ok(
    entries[0].listenedSeconds >= 3,
    `listening time accumulated (${entries[0]?.listenedSeconds}s)`,
  );
});

test('engine: an instantly skipped track leaves no history row', async (t) => {
  const h = harness();
  t.after(() => h.close());
  await h.engine.playTracks(makeTracks(3), 0);
  await h.engine.next();
  await h.engine.next();
  await h.engine.stop();
  assert.equal(h.services.history.count(), 0);
});

test('engine: the sleep timer pauses playback and can be cancelled', async (t) => {
  const h = harness();
  t.after(() => h.close());
  await h.engine.playTracks(makeTracks(2), 0);

  const timer = h.engine.startSleepTimer(30);
  assert.equal(timer.minutes, 30);
  assert.ok(h.engine.state.sleepTimer.remainingSeconds > 1700);

  assert.equal(h.engine.cancelSleepTimer(), true);
  assert.equal(h.engine.state.sleepTimer, null);
  assert.equal(h.engine.cancelSleepTimer(), false, 'cancelling twice is harmless');
});

test('engine: state exposes the resolved track, not the stored one', async (t) => {
  const h = harness({
    resolve: async (track) => createTrack({ ...track, streamUrl: 'https://fresh.invalid/x.mp3' }),
  });
  t.after(() => h.close());
  await h.engine.playTracks([makeTrack(1)], 0);
  assert.equal(h.engine.state.track.streamUrl, 'https://fresh.invalid/x.mp3');
  assert.equal(
    h.engine.queue.current.streamUrl,
    'https://example.invalid/1.mp3',
    'the queue keeps the stored reference',
  );
});

test('engine: a backend that cannot stream refuses a URL with a clear message', async (t) => {
  const services = makeServices();
  const adapter = new NullAdapter({ autoTick: false });
  // Pretend this is afplay: local files only.
  Object.defineProperty(adapter, 'capabilities', {
    get: () => ({
      remoteStreams: false,
      seek: true,
      volume: true,
      truePause: true,
      position: true,
    }),
  });
  const engine = new PlaybackEngine({
    adapter,
    registry: { has: () => false, get: () => null },
    history: services.history,
    settings: services.settings,
  });
  t.after(async () => {
    await engine.dispose();
    services.close();
  });

  const errors = [];
  engine.on('playback-error', (e) => errors.push(e));
  await engine.playTracks([makeTrack(1)], 0);
  assert.match(errors[0].title, /cannot stream online audio/);
});

test('engine: dispose stops everything and is safe to call twice', async () => {
  const h = harness();
  await h.engine.playTracks(makeTracks(2), 0);
  await h.engine.dispose();
  await h.engine.dispose();
  h.services.close();
});
