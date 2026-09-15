import { Emitter } from '../core/events.js';
import { ValidationError } from '../core/errors.js';
import { matchesQuery, moveItem } from '../core/util.js';

const MAX_NAME_LENGTH = 80;

/**
 * Playlist CRUD.
 *
 * Playlists store ordered *references* (`tracks.id`) - never stream URLs -
 * so a playlist survives URL expiry and provider changes. Position numbers are
 * always a dense 0..n-1 sequence, rewritten inside a transaction on every
 * mutation so reordering can never leave a gap or a duplicate.
 */
export class PlaylistService extends Emitter {
  #db;
  #tracks;

  /**
   * @param {object} deps
   * @param {import('better-sqlite3').Database} deps.db
   * @param {import('./trackRepository.js').TrackRepository} deps.tracks
   */
  constructor({ db, tracks }) {
    super();
    this.#db = db;
    this.#tracks = tracks;

    this.rewritePositions = db.transaction((playlistId, trackIds) => {
      db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?').run(playlistId);
      const insert = db.prepare(
        'INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at) VALUES (?, ?, ?, ?)',
      );
      const now = new Date().toISOString();
      trackIds.forEach((trackId, index) => insert.run(playlistId, trackId, index, now));
      db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(now, playlistId);
    });
  }

  /** @returns {{id:number,name:string,description:string,kind:string,trackCount:number,duration:number|null,createdAt:string,updatedAt:string}[]} */
  list() {
    return this.#db
      .prepare(
        `SELECT p.id, p.name, p.description, p.kind, p.created_at, p.updated_at,
                COUNT(pt.track_id)                                   AS track_count,
                SUM(CASE WHEN t.duration IS NULL THEN 0 ELSE t.duration END) AS known_duration,
                SUM(CASE WHEN t.duration IS NULL THEN 1 ELSE 0 END)  AS unknown_durations
           FROM playlists p
           LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
           LEFT JOIN tracks t ON t.id = pt.track_id
          GROUP BY p.id
          ORDER BY p.name COLLATE NOCASE`,
      )
      .all()
      .map(toPlaylistSummary);
  }

  get(id) {
    const row = this.#db
      .prepare(
        `SELECT p.id, p.name, p.description, p.kind, p.created_at, p.updated_at,
                COUNT(pt.track_id) AS track_count,
                SUM(CASE WHEN t.duration IS NULL THEN 0 ELSE t.duration END) AS known_duration,
                SUM(CASE WHEN t.duration IS NULL THEN 1 ELSE 0 END) AS unknown_durations
           FROM playlists p
           LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
           LEFT JOIN tracks t ON t.id = pt.track_id
          WHERE p.id = ?
          GROUP BY p.id`,
      )
      .get(id);
    return row ? toPlaylistSummary(row) : null;
  }

  getByName(name) {
    const row = this.#db
      .prepare('SELECT id FROM playlists WHERE name = ? COLLATE NOCASE')
      .get(String(name).trim());
    return row ? this.get(row.id) : null;
  }

  /**
   * @param {string} name
   * @param {{description?: string, kind?: string, rule?: object|null}} [options]
   */
  create(name, options = {}) {
    const cleanName = validateName(name);
    if (this.getByName(cleanName)) {
      throw new ValidationError(`playlist "${cleanName}" exists`, {
        userMessage: `A playlist called "${cleanName}" already exists`,
        hint: 'Pick a different name.',
      });
    }
    const now = new Date().toISOString();
    const info = this.#db
      .prepare(
        `INSERT INTO playlists (name, description, kind, rule, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        cleanName,
        options.description ?? '',
        options.kind ?? 'manual',
        options.rule ? JSON.stringify(options.rule) : null,
        now,
        now,
      );
    this.emit('change', { type: 'created', id: info.lastInsertRowid });
    return this.get(info.lastInsertRowid);
  }

  rename(id, name) {
    const cleanName = validateName(name);
    const existing = this.getByName(cleanName);
    if (existing && existing.id !== id) {
      throw new ValidationError('duplicate playlist name', {
        userMessage: `A playlist called "${cleanName}" already exists`,
      });
    }
    const info = this.#db
      .prepare('UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?')
      .run(cleanName, new Date().toISOString(), id);
    if (!info.changes) throw new ValidationError('playlist not found');
    this.emit('change', { type: 'renamed', id });
    return this.get(id);
  }

  remove(id) {
    const info = this.#db.prepare('DELETE FROM playlists WHERE id = ?').run(id);
    if (info.changes) this.emit('change', { type: 'deleted', id });
    return info.changes > 0;
  }

  /** @returns {import('../core/track.js').Track[]} in playlist order */
  tracks(id, { filter = '' } = {}) {
    const rows = this.#db
      .prepare(
        `SELECT t.payload FROM playlist_tracks pt
           JOIN tracks t ON t.id = pt.track_id
          WHERE pt.playlist_id = ?
          ORDER BY pt.position`,
      )
      .all(id);
    const tracks = rows
      .map((row) => {
        try {
          return JSON.parse(row.payload);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const hydrated = this.#tracks.getMany(tracks.map((t) => t.id));
    if (!filter) return hydrated;
    return hydrated.filter((t) =>
      [t.title, t.artist, t.album].some((field) => matchesQuery(field, filter)),
    );
  }

  trackIds(id) {
    return this.#db
      .prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position')
      .all(id)
      .map((r) => r.track_id);
  }

  /**
   * Append a track. Duplicates are allowed (a playlist may legitimately
   * contain the same song twice) but the caller is told what happened.
   * @returns {{added: boolean, duplicate: boolean, position: number}}
   */
  addTrack(playlistId, track, { allowDuplicate = true } = {}) {
    if (!this.get(playlistId)) throw new ValidationError('playlist not found');
    this.#tracks.upsert(track);
    const ids = this.trackIds(playlistId);
    const duplicate = ids.includes(track.id);
    if (duplicate && !allowDuplicate) {
      return { added: false, duplicate: true, position: ids.indexOf(track.id) };
    }
    this.rewritePositions(playlistId, [...ids, track.id]);
    this.emit('change', { type: 'tracks', id: playlistId });
    return { added: true, duplicate, position: ids.length };
  }

  /** Append many tracks in one transaction. */
  addTracks(playlistId, tracks, { allowDuplicate = true } = {}) {
    if (!this.get(playlistId)) throw new ValidationError('playlist not found');
    this.#tracks.upsertAll(tracks);
    const ids = this.trackIds(playlistId);
    const existing = new Set(ids);
    const incoming = [];
    let skipped = 0;
    for (const track of tracks) {
      if (!allowDuplicate && existing.has(track.id)) {
        skipped += 1;
        continue;
      }
      existing.add(track.id);
      incoming.push(track.id);
    }
    if (incoming.length) {
      this.rewritePositions(playlistId, [...ids, ...incoming]);
      this.emit('change', { type: 'tracks', id: playlistId });
    }
    return { added: incoming.length, skipped };
  }

  /** Remove by position so duplicates can be removed individually. */
  removeAt(playlistId, position) {
    const ids = this.trackIds(playlistId);
    if (position < 0 || position >= ids.length) return false;
    ids.splice(position, 1);
    this.rewritePositions(playlistId, ids);
    this.emit('change', { type: 'tracks', id: playlistId });
    return true;
  }

  removeTrack(playlistId, trackId) {
    const ids = this.trackIds(playlistId);
    const next = ids.filter((id) => id !== trackId);
    if (next.length === ids.length) return false;
    this.rewritePositions(playlistId, next);
    this.emit('change', { type: 'tracks', id: playlistId });
    return true;
  }

  /** @returns {boolean} whether anything moved */
  move(playlistId, from, to) {
    const ids = this.trackIds(playlistId);
    if (from < 0 || from >= ids.length) return false;
    const target = Math.min(ids.length - 1, Math.max(0, to));
    if (target === from) return false;
    this.rewritePositions(playlistId, moveItem(ids, from, target));
    this.emit('change', { type: 'reordered', id: playlistId });
    return true;
  }

  /** Replace the whole track list (used when regenerating a smart playlist). */
  replaceTracks(playlistId, tracks) {
    this.#tracks.upsertAll(tracks);
    this.rewritePositions(
      playlistId,
      tracks.map((t) => t.id),
    );
    this.emit('change', { type: 'tracks', id: playlistId });
    return tracks.length;
  }

  clear(playlistId) {
    this.rewritePositions(playlistId, []);
    this.emit('change', { type: 'tracks', id: playlistId });
  }
}

function toPlaylistSummary(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    kind: row.kind ?? 'manual',
    trackCount: row.track_count ?? 0,
    // Total duration is only meaningful when every track reports one; the UI
    // renders "~" when some are unknown rather than inventing a number.
    duration: row.track_count ? (row.known_duration ?? 0) : 0,
    // Only claim the total is approximate when there is something to total.
    durationPartial: row.track_count > 0 && (row.unknown_durations ?? 0) > 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateName(name) {
  const clean = String(name ?? '').trim();
  if (!clean) {
    throw new ValidationError('empty playlist name', {
      userMessage: 'Playlist name cannot be empty',
    });
  }
  if (clean.length > MAX_NAME_LENGTH) {
    throw new ValidationError('playlist name too long', {
      userMessage: `Playlist names are limited to ${MAX_NAME_LENGTH} characters`,
    });
  }
  return clean;
}
