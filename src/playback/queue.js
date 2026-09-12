import { Emitter } from '../core/events.js';
import { shuffleArray, moveItem } from '../core/util.js';

/**
 * The playback queue.
 *
 * Design notes:
 *  - `items` is the *authoritative order*. Shuffle never rewrites it; instead
 *    it maintains a separate `order` of indices. Toggling shuffle off
 *    therefore restores the original order exactly, and the currently playing
 *    track stays current.
 *  - Duplicates are allowed. Every entry carries a unique `uid`, so removing
 *    "the second copy of this song" is unambiguous.
 *  - Repeat modes: 'off' stops at the end, 'one' replays the current entry,
 *    'queue' wraps around.
 *  - Shuffle reshuffles only the *unplayed* remainder and avoids putting the
 *    current track immediately next, so you never hear the same song twice in
 *    a row by accident.
 *
 * @typedef {{ uid: string, track: import('../core/track.js').Track }} QueueItem
 */
export class Queue extends Emitter {
  /** @type {QueueItem[]} */
  #items = [];
  /** Indices into #items, in playback order. */
  #order = [];
  /** Position within #order, or -1 when nothing is current. */
  #cursor = -1;
  #shuffle = false;
  #repeat = 'off';
  #uidSeq = 0;
  #random;

  constructor({ random = Math.random } = {}) {
    super();
    this.#random = random;
  }

  // ---------------------------------------------------------------- state

  get items() {
    return this.#items.map((item) => item.track);
  }

  /** Entries in *playback* order, each tagged with its queue index. */
  get ordered() {
    return this.#order.map((index, position) => ({
      ...this.#items[index],
      index,
      position,
      isCurrent: position === this.#cursor,
    }));
  }

  get length() {
    return this.#items.length;
  }

  get isEmpty() {
    return this.#items.length === 0;
  }

  get shuffle() {
    return this.#shuffle;
  }

  get repeat() {
    return this.#repeat;
  }

  /** @returns {QueueItem|null} */
  get currentItem() {
    if (this.#cursor < 0 || this.#cursor >= this.#order.length) return null;
    return this.#items[this.#order[this.#cursor]] ?? null;
  }

  get current() {
    return this.currentItem?.track ?? null;
  }

  get currentIndex() {
    return this.#cursor < 0 ? -1 : this.#order[this.#cursor];
  }

  /** The next `count` entries in playback order, for the queue preview. */
  upcoming(count = 5) {
    const out = [];
    for (let i = this.#cursor + 1; i < this.#order.length && out.length < count; i += 1) {
      out.push({ ...this.#items[this.#order[i]], position: i });
    }
    if (out.length < count && this.#repeat === 'queue') {
      for (let i = 0; i < this.#cursor + 1 && out.length < count; i += 1) {
        out.push({ ...this.#items[this.#order[i]], position: i, wrapped: true });
      }
    }
    return out;
  }

  // ------------------------------------------------------------- mutation

  /**
   * Append tracks to the end of the queue.
   * @param {import('../core/track.js').Track | import('../core/track.js').Track[]} tracks
   * @returns {number} how many were added
   */
  add(tracks) {
    const list = Array.isArray(tracks) ? tracks : [tracks];
    if (!list.length) return 0;
    const startIndex = this.#items.length;
    for (const track of list) this.#items.push({ uid: this.#nextUid(), track });
    const newIndices = list.map((_, i) => startIndex + i);
    // New items go to the end of the play order, shuffled among themselves
    // when shuffle is on so an appended album is not re-ordered by accident.
    this.#order.push(...(this.#shuffle ? shuffleArray(newIndices, this.#random) : newIndices));
    this.#emit('added', { count: list.length });
    return list.length;
  }

  /** Insert immediately after the current track ("play next"). */
  addNext(tracks) {
    const list = Array.isArray(tracks) ? tracks : [tracks];
    if (!list.length) return 0;
    const startIndex = this.#items.length;
    for (const track of list) this.#items.push({ uid: this.#nextUid(), track });
    const newIndices = list.map((_, i) => startIndex + i);
    const at = this.#cursor < 0 ? 0 : this.#cursor + 1;
    this.#order.splice(at, 0, ...newIndices);
    this.#emit('added', { count: list.length, next: true });
    return list.length;
  }

  /**
   * Replace the queue and start at `startIndex` of the supplied list.
   * @returns {import('../core/track.js').Track|null} the track now current
   */
  replace(tracks, startIndex = 0) {
    this.#items = tracks.map((track) => ({ uid: this.#nextUid(), track }));
    const indices = this.#items.map((_, i) => i);
    if (this.#shuffle) {
      // Keep the chosen track first, shuffle the rest.
      const rest = indices.filter((i) => i !== startIndex);
      this.#order = [startIndex, ...shuffleArray(rest, this.#random)].filter(
        (i) => i != null && i >= 0,
      );
      this.#cursor = this.#items.length ? 0 : -1;
    } else {
      this.#order = indices;
      this.#cursor = this.#items.length
        ? Math.min(Math.max(0, startIndex), indices.length - 1)
        : -1;
    }
    this.#emit('replaced', { count: this.#items.length });
    return this.current;
  }

  /** Remove by position in *playback* order. */
  removeAt(position) {
    if (position < 0 || position >= this.#order.length) return false;
    const index = this.#order[position];
    this.#order.splice(position, 1);
    this.#items.splice(index, 1);
    // Every stored index above the removed one shifts down by one.
    this.#order = this.#order.map((i) => (i > index ? i - 1 : i));
    if (position < this.#cursor) this.#cursor -= 1;
    else if (position === this.#cursor)
      this.#cursor = Math.min(this.#cursor, this.#order.length - 1);
    if (!this.#order.length) this.#cursor = -1;
    this.#emit('removed', { position });
    return true;
  }

  /** Remove by the entry's unique id (used by the UI's selected row). */
  removeUid(uid) {
    const position = this.#order.findIndex((index) => this.#items[index]?.uid === uid);
    if (position < 0) return false;
    return this.removeAt(position);
  }

  /** Reorder within the playback order. Only upcoming items should move. */
  move(fromPosition, toPosition) {
    if (fromPosition < 0 || fromPosition >= this.#order.length) return false;
    const to = Math.min(this.#order.length - 1, Math.max(0, toPosition));
    if (to === fromPosition) return false;
    const currentIndex = this.#cursor >= 0 ? this.#order[this.#cursor] : null;
    this.#order = moveItem(this.#order, fromPosition, to);
    if (currentIndex != null) this.#cursor = this.#order.indexOf(currentIndex);
    this.#emit('moved', { from: fromPosition, to });
    return true;
  }

  clear() {
    this.#items = [];
    this.#order = [];
    this.#cursor = -1;
    this.#emit('cleared');
  }

  // ------------------------------------------------------------ navigation

  /** Make the entry at `position` (playback order) current. */
  jumpTo(position) {
    if (position < 0 || position >= this.#order.length) return null;
    this.#cursor = position;
    this.#emit('cursor', { position });
    return this.current;
  }

  /**
   * Advance.
   * @param {{ auto?: boolean }} [options] `auto: true` means a track ended by
   *   itself, which is the only case where repeat-one replays the same track.
   *   An explicit "next" press always moves on.
   * @returns {import('../core/track.js').Track|null} null means "stop"
   */
  next({ auto = false } = {}) {
    if (!this.#order.length) return null;
    if (auto && this.#repeat === 'one') {
      this.#emit('cursor', { position: this.#cursor, repeated: true });
      return this.current;
    }
    if (this.#cursor + 1 < this.#order.length) {
      this.#cursor += 1;
      this.#emit('cursor', { position: this.#cursor });
      return this.current;
    }
    if (this.#repeat === 'queue') {
      // Reshuffle on wrap so a repeated shuffled queue is not identical.
      if (this.#shuffle) this.#reshuffleAll();
      this.#cursor = 0;
      this.#emit('cursor', { position: 0, wrapped: true });
      return this.current;
    }
    if (!auto && this.#repeat === 'one') {
      this.#emit('cursor', { position: this.#cursor });
      return this.current;
    }
    return null;
  }

  /**
   * Go back. Callers restart the current track instead when the user is more
   * than a few seconds in - that policy lives in the engine, not here.
   */
  previous() {
    if (!this.#order.length) return null;
    if (this.#cursor > 0) {
      this.#cursor -= 1;
    } else if (this.#repeat === 'queue') {
      this.#cursor = this.#order.length - 1;
    } else {
      this.#cursor = 0;
    }
    this.#emit('cursor', { position: this.#cursor });
    return this.current;
  }

  get hasNext() {
    if (!this.#order.length) return false;
    if (this.#repeat === 'queue' || this.#repeat === 'one') return true;
    return this.#cursor + 1 < this.#order.length;
  }

  get hasPrevious() {
    if (!this.#order.length) return false;
    return this.#cursor > 0 || this.#repeat === 'queue';
  }

  // ----------------------------------------------------------------- modes

  /**
   * Toggle or set shuffle.
   *
   * Turning it on reshuffles only what has not played yet, keeping the current
   * track current. Turning it off restores the queue's natural order with the
   * cursor still on the same track.
   */
  setShuffle(enabled) {
    const next = Boolean(enabled);
    if (next === this.#shuffle) return this.#shuffle;
    this.#shuffle = next;
    const currentIndex = this.#cursor >= 0 ? this.#order[this.#cursor] : null;

    if (next) {
      const played = this.#order.slice(0, Math.max(0, this.#cursor + 1));
      const remaining = this.#order.slice(this.#cursor + 1);
      const shuffled = shuffleArray(remaining, this.#random);
      // Avoid an immediate repeat of the track that is playing.
      if (shuffled.length > 1 && currentIndex != null && shuffled[0] === currentIndex) {
        [shuffled[0], shuffled[1]] = [shuffled[1], shuffled[0]];
      }
      this.#order = [...played, ...shuffled];
    } else {
      this.#order = this.#items.map((_, i) => i);
      this.#cursor = currentIndex == null ? -1 : this.#order.indexOf(currentIndex);
    }
    this.#emit('shuffle', { shuffle: this.#shuffle });
    return this.#shuffle;
  }

  toggleShuffle() {
    return this.setShuffle(!this.#shuffle);
  }

  /** @param {'off'|'one'|'queue'} mode */
  setRepeat(mode) {
    const allowed = ['off', 'one', 'queue'];
    this.#repeat = allowed.includes(mode) ? mode : 'off';
    this.#emit('repeat', { repeat: this.#repeat });
    return this.#repeat;
  }

  cycleRepeat() {
    const order = ['off', 'one', 'queue'];
    return this.setRepeat(order[(order.indexOf(this.#repeat) + 1) % order.length]);
  }

  #reshuffleAll() {
    const currentIndex = this.#cursor >= 0 ? this.#order[this.#cursor] : null;
    const shuffled = shuffleArray(
      this.#items.map((_, i) => i),
      this.#random,
    );
    if (shuffled.length > 1 && currentIndex != null && shuffled[0] === currentIndex) {
      [shuffled[0], shuffled[1]] = [shuffled[1], shuffled[0]];
    }
    this.#order = shuffled;
  }

  // ------------------------------------------------------------ persistence

  /** Snapshot for the resume-on-restart feature. */
  snapshot() {
    return {
      trackIds: this.#items.map((item) => item.track.id),
      order: [...this.#order],
      cursor: this.#cursor,
      shuffle: this.#shuffle,
      repeat: this.#repeat,
    };
  }

  /**
   * Restore a snapshot. Tracks that no longer resolve are dropped and the
   * order is repaired, so a stale snapshot can never wedge the queue.
   * @param {{trackIds: string[], order: number[], cursor: number, shuffle: boolean, repeat: string}} snapshot
   * @param {(id: string) => import('../core/track.js').Track|null} lookup
   */
  restore(snapshot, lookup) {
    if (!snapshot?.trackIds?.length) return 0;
    const resolved = [];
    const indexMap = new Map();
    snapshot.trackIds.forEach((id, oldIndex) => {
      const track = lookup(id);
      if (!track) return;
      indexMap.set(oldIndex, resolved.length);
      resolved.push({ uid: this.#nextUid(), track });
    });
    if (!resolved.length) return 0;

    this.#items = resolved;
    const order = (snapshot.order ?? [])
      .map((oldIndex) => indexMap.get(oldIndex))
      .filter((i) => i != null);
    // Anything the snapshot's order missed still belongs in the queue.
    const seen = new Set(order);
    for (let i = 0; i < resolved.length; i += 1) if (!seen.has(i)) order.push(i);
    this.#order = order;

    this.#shuffle = Boolean(snapshot.shuffle);
    this.setRepeat(snapshot.repeat);
    this.#cursor = Math.min(Math.max(-1, snapshot.cursor ?? -1), this.#order.length - 1);
    this.#emit('restored', { count: resolved.length });
    return resolved.length;
  }

  #nextUid() {
    this.#uidSeq += 1;
    return `q${this.#uidSeq}`;
  }

  #emit(type, payload = {}) {
    this.emit('change', { type, ...payload });
  }
}
