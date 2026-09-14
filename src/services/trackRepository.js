import { createTrack, serialiseTrack } from '../core/track.js';

/**
 * The tracks table is a shared dictionary: playlists, favourites and history
 * all reference `tracks.id` rather than copying track data. Anything that
 * wants to persist a reference to a track calls `upsert()` first.
 */
export class TrackRepository {
  #db;

  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.#db = db;
    this.upsertStmt = db.prepare(`
      INSERT INTO tracks (
        id, provider, provider_id, title, artist, album, duration, genre, year,
        artwork_url, local_path, external_url, availability, is_sample, payload, updated_at
      ) VALUES (
        @id, @provider, @provider_id, @title, @artist, @album, @duration, @genre, @year,
        @artwork_url, @local_path, @external_url, @availability, @is_sample, @payload, @updated_at
      )
      ON CONFLICT (id) DO UPDATE SET
        title        = excluded.title,
        artist       = excluded.artist,
        album        = excluded.album,
        duration     = COALESCE(excluded.duration, tracks.duration),
        genre        = COALESCE(excluded.genre, tracks.genre),
        year         = COALESCE(excluded.year, tracks.year),
        artwork_url  = COALESCE(excluded.artwork_url, tracks.artwork_url),
        local_path   = COALESCE(excluded.local_path, tracks.local_path),
        external_url = COALESCE(excluded.external_url, tracks.external_url),
        availability = excluded.availability,
        payload      = excluded.payload,
        updated_at   = excluded.updated_at
    `);
    this.getStmt = db.prepare('SELECT payload FROM tracks WHERE id = ?');
    this.upsertMany = db.transaction((tracks) => {
      for (const track of tracks) this.upsertStmt.run(toRow(this.#merge(track)));
      return tracks.length;
    });
  }

  /**
   * Store or refresh a track.
   * @param {import('../core/track.js').Track} track
   * @returns {import('../core/track.js').Track}
   */
  upsert(track) {
    const merged = this.#merge(track);
    this.upsertStmt.run(toRow(merged));
    return merged;
  }

  /**
   * Fold an incoming track over what we already know.
   *
   * Providers return different amounts of detail depending on the endpoint: a
   * search hit may omit the duration that a metadata lookup supplied earlier.
   * Merging here (rather than only in the SQL columns) keeps the stored JSON
   * payload and the indexed columns telling the same story.
   */
  #merge(track) {
    const existing = this.get(track.id);
    if (!existing) return track;
    return createTrack({
      ...existing,
      ...track,
      duration: track.duration ?? existing.duration,
      genre: track.genre ?? existing.genre,
      year: track.year ?? existing.year,
      artworkUrl: track.artworkUrl ?? existing.artworkUrl,
      localPath: track.localPath ?? existing.localPath,
      externalUrl: track.externalUrl ?? existing.externalUrl,
      license: track.license ?? existing.license,
      providerData: { ...existing.providerData, ...track.providerData },
    });
  }

  /** @param {import('../core/track.js').Track[]} tracks */
  upsertAll(tracks) {
    if (!tracks?.length) return 0;
    return this.upsertMany(tracks);
  }

  /** @returns {import('../core/track.js').Track | null} */
  get(id) {
    const row = this.getStmt.get(id);
    return row ? hydrate(row.payload) : null;
  }

  /** @returns {import('../core/track.js').Track[]} */
  getMany(ids) {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.#db
      .prepare(`SELECT id, payload FROM tracks WHERE id IN (${placeholders})`)
      .all(...ids);
    const byId = new Map(rows.map((r) => [r.id, hydrate(r.payload)]));
    return ids.map((id) => byId.get(id)).filter(Boolean);
  }

  /** Mark a track as no longer resolvable, keeping it visible in playlists. */
  markUnavailable(id) {
    const track = this.get(id);
    if (!track) return null;
    const updated = createTrack({ ...track, availability: 'unavailable', streamUrl: null });
    return this.upsert(updated);
  }

  count() {
    return this.#db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n;
  }

  /** Delete tracks nothing references any more. Returns rows removed. */
  pruneOrphans() {
    return this.#db
      .prepare(
        `DELETE FROM tracks WHERE id NOT IN (SELECT track_id FROM playlist_tracks)
           AND id NOT IN (SELECT track_id FROM favorites)
           AND id NOT IN (SELECT track_id FROM history)`,
      )
      .run().changes;
  }
}

function toRow(track) {
  return {
    id: track.id,
    provider: track.provider,
    provider_id: track.providerId,
    title: track.title,
    artist: track.artist,
    album: track.album ?? '',
    duration: track.duration ?? null,
    genre: track.genre ?? null,
    year: track.year ?? null,
    artwork_url: track.artworkUrl ?? null,
    local_path: track.localPath ?? null,
    external_url: track.externalUrl ?? null,
    availability: track.availability,
    is_sample: track.isSample ? 1 : 0,
    payload: serialiseTrack(track),
    updated_at: new Date().toISOString(),
  };
}

function hydrate(payload) {
  try {
    return createTrack(JSON.parse(payload));
  } catch {
    return null;
  }
}
