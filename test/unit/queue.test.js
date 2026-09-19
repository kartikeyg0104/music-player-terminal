import test from 'node:test';
import assert from 'node:assert/strict';
import { Queue } from '../../src/playback/queue.js';
import { seededRandom } from '../../src/core/util.js';
import { makeTrack, makeTracks } from '../helpers.js';

const seeded = () => new Queue({ random: seededRandom(42) });

test('queue: add appends in order and reports length', () => {
  const q = new Queue();
  q.add(makeTracks(3));
  assert.equal(q.length, 3);
  assert.deepEqual(
    q.ordered.map((i) => i.track.title),
    ['Track 1', 'Track 2', 'Track 3'],
  );
  assert.equal(q.current, null, 'adding must not implicitly start playback');
});

test('queue: replace sets the current track to the chosen index', () => {
  const q = new Queue();
  q.replace(makeTracks(4), 2);
  assert.equal(q.current.title, 'Track 3');
  assert.equal(q.currentIndex, 2);
});

test('queue: addNext inserts directly after the current track', () => {
  const q = new Queue();
  q.replace(makeTracks(3), 0);
  q.addNext(makeTrack(99));
  assert.deepEqual(
    q.ordered.map((i) => i.track.title),
    ['Track 1', 'Track 99', 'Track 2', 'Track 3'],
  );
  assert.equal(q.next().title, 'Track 99');
});

test('queue: next walks forward and stops at the end with repeat off', () => {
  const q = new Queue();
  q.replace(makeTracks(3), 0);
  assert.equal(q.next().title, 'Track 2');
  assert.equal(q.next().title, 'Track 3');
  assert.equal(q.next(), null, 'end of queue returns null so the engine can stop');
  assert.equal(q.hasNext, false);
});

test('queue: repeat one replays only on automatic advance', () => {
  const q = new Queue();
  q.replace(makeTracks(3), 0);
  q.setRepeat('one');
  assert.equal(q.next({ auto: true }).title, 'Track 1', 'a finished track repeats');
  assert.equal(q.next({ auto: false }).title, 'Track 2', 'pressing next still moves on');
});

test('queue: repeat queue wraps around', () => {
  const q = new Queue();
  q.replace(makeTracks(2), 0);
  q.setRepeat('queue');
  assert.equal(q.next().title, 'Track 2');
  assert.equal(q.next().title, 'Track 1');
  assert.equal(q.hasNext, true);
});

test('queue: cycleRepeat walks off -> one -> queue -> off', () => {
  const q = new Queue();
  assert.equal(q.cycleRepeat(), 'one');
  assert.equal(q.cycleRepeat(), 'queue');
  assert.equal(q.cycleRepeat(), 'off');
});

test('queue: previous stops at the first track unless repeating', () => {
  const q = new Queue();
  q.replace(makeTracks(3), 0);
  assert.equal(q.previous().title, 'Track 1');
  q.setRepeat('queue');
  assert.equal(q.previous().title, 'Track 3', 'repeat queue wraps backwards too');
});

test('queue: shuffle keeps the current track current and restores order when off', () => {
  const q = seeded();
  q.replace(makeTracks(8), 3);
  const current = q.current;

  q.setShuffle(true);
  assert.equal(q.current.id, current.id, 'shuffling must not change what is playing');
  assert.equal(q.length, 8, 'shuffling must not lose tracks');

  const shuffledOrder = q.ordered.map((i) => i.track.title);
  q.setShuffle(false);
  assert.equal(q.current.id, current.id);
  assert.deepEqual(
    q.ordered.map((i) => i.track.title),
    makeTracks(8).map((t) => t.title),
    'turning shuffle off restores the original order exactly',
  );
  assert.notDeepEqual(
    shuffledOrder,
    makeTracks(8).map((t) => t.title),
  );
});

test('queue: shuffle only reorders what has not played yet', () => {
  const q = seeded();
  q.replace(makeTracks(10), 0);
  q.next();
  q.next(); // played 1,2,3 -> cursor at index 2
  const playedBefore = q.ordered.slice(0, 3).map((i) => i.track.title);
  q.setShuffle(true);
  assert.deepEqual(
    q.ordered.slice(0, 3).map((i) => i.track.title),
    playedBefore,
    'history within the queue is preserved',
  );
});

test('queue: shuffle avoids replaying the current track immediately', () => {
  // Run many seeds: the guard must hold for all of them, not just a lucky one.
  for (let seed = 1; seed <= 50; seed += 1) {
    const q = new Queue({ random: seededRandom(seed) });
    q.replace(makeTracks(6), 0);
    q.setShuffle(true);
    const upcoming = q.upcoming(1)[0];
    if (upcoming) {
      assert.notEqual(upcoming.track.id, q.current.id, `seed ${seed} repeated the current track`);
    }
  }
});

test('queue: duplicates are allowed and removable individually', () => {
  const q = new Queue();
  const track = makeTrack(1);
  q.add([track, makeTrack(2), track]);
  assert.equal(q.length, 3);

  const uids = q.ordered.map((i) => i.uid);
  assert.equal(new Set(uids).size, 3, 'each entry has its own identity');

  q.removeUid(uids[2]);
  assert.deepEqual(
    q.ordered.map((i) => i.track.title),
    ['Track 1', 'Track 2'],
    'removing the second copy leaves the first',
  );
});

test('queue: removing the track before the cursor keeps the same track current', () => {
  const q = new Queue();
  q.replace(makeTracks(4), 2); // current = Track 3
  q.removeAt(0);
  assert.equal(q.current.title, 'Track 3');
  assert.equal(q.length, 3);
});

test('queue: removing the current track promotes the next one', () => {
  const q = new Queue();
  q.replace(makeTracks(3), 1);
  q.removeAt(1);
  assert.equal(q.current.title, 'Track 3');
});

test('queue: removing the last remaining track clears the cursor', () => {
  const q = new Queue();
  q.replace([makeTrack(1)], 0);
  q.removeAt(0);
  assert.equal(q.current, null);
  assert.equal(q.isEmpty, true);
});

test('queue: move reorders without changing what is playing', () => {
  const q = new Queue();
  q.replace(makeTracks(5), 0);
  q.move(3, 1);
  assert.deepEqual(
    q.ordered.map((i) => i.track.title),
    ['Track 1', 'Track 4', 'Track 2', 'Track 3', 'Track 5'],
  );
  assert.equal(q.current.title, 'Track 1');
});

test('queue: upcoming shows what plays next, including the wrap when repeating', () => {
  const q = new Queue();
  q.replace(makeTracks(3), 2);
  assert.deepEqual(q.upcoming(2), []);
  q.setRepeat('queue');
  const upcoming = q.upcoming(2);
  assert.equal(upcoming.length, 2);
  assert.equal(upcoming[0].wrapped, true);
  assert.equal(upcoming[0].track.title, 'Track 1');
});

test('queue: snapshot and restore survive a missing track', () => {
  const q = new Queue();
  const tracks = makeTracks(4);
  q.replace(tracks, 1);
  q.setRepeat('queue');
  const snapshot = q.snapshot();

  const restored = new Queue();
  // Pretend Track 3 has vanished from the library since the snapshot.
  const library = new Map(tracks.filter((t) => t.title !== 'Track 3').map((t) => [t.id, t]));
  const count = restored.restore(snapshot, (id) => library.get(id) ?? null);

  assert.equal(count, 3);
  assert.equal(restored.length, 3);
  assert.equal(restored.repeat, 'queue');
  assert.ok(!restored.ordered.some((i) => i.track.title === 'Track 3'));
  assert.ok(restored.current, 'the cursor still points at a real track');
});

test('queue: restore repairs an order array that misses entries', () => {
  const tracks = makeTracks(3);
  const q = new Queue();
  const library = new Map(tracks.map((t) => [t.id, t]));
  const count = q.restore(
    { trackIds: tracks.map((t) => t.id), order: [0], cursor: 0, shuffle: false, repeat: 'off' },
    (id) => library.get(id) ?? null,
  );
  assert.equal(count, 3);
  assert.equal(q.ordered.length, 3, 'tracks missing from the order are appended, not dropped');
});

test('queue: clear empties everything', () => {
  const q = new Queue();
  q.replace(makeTracks(3), 1);
  q.clear();
  assert.equal(q.length, 0);
  assert.equal(q.current, null);
  assert.equal(q.hasNext, false);
  assert.equal(q.hasPrevious, false);
});

test('queue: emits a change event for every mutation', () => {
  const q = new Queue();
  const types = [];
  q.on('change', (e) => types.push(e.type));
  q.add(makeTracks(2));
  q.jumpTo(0);
  q.move(0, 1);
  q.setShuffle(true);
  q.setRepeat('one');
  q.clear();
  assert.deepEqual(types, ['added', 'cursor', 'moved', 'shuffle', 'repeat', 'cleared']);
});
