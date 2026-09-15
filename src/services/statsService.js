/**
 * Listening statistics derived entirely from the history table.
 *
 * Every figure here is computed from rows that actually exist. When there is
 * no data the result is `{ available: false }` rather than a zero, so the UI
 * can say "no data yet" instead of implying you have listened to nothing.
 */
export class StatsService {
  #db;
  #tracks;

  constructor({ db, tracks }) {
    this.#db = db;
    this.#tracks = tracks;
  }

  summary() {
    const totals = this.#db
      .prepare(
        `SELECT COUNT(*) AS plays,
                COALESCE(SUM(listened_sec), 0) AS seconds,
                COUNT(DISTINCT track_id) AS unique_tracks,
                MIN(played_at) AS first_play,
                MAX(played_at) AS last_play
           FROM history`,
      )
      .get();

    if (!totals.plays) {
      return {
        available: false,
        plays: 0,
        seconds: 0,
        uniqueTracks: 0,
        firstPlay: null,
        lastPlay: null,
      };
    }
    return {
      available: true,
      plays: totals.plays,
      seconds: totals.seconds,
      uniqueTracks: totals.unique_tracks,
      firstPlay: totals.first_play,
      lastPlay: totals.last_play,
    };
  }

  /** @returns {{track: import('../core/track.js').Track, plays: number, seconds: number}[]} */
  topTracks({ limit = 10 } = {}) {
    const rows = this.#db
      .prepare(
        `SELECT track_id, COUNT(*) AS plays, COALESCE(SUM(listened_sec), 0) AS seconds
           FROM history GROUP BY track_id
          ORDER BY plays DESC, seconds DESC LIMIT ?`,
      )
      .all(limit);
    const tracks = new Map(this.#tracks.getMany(rows.map((r) => r.track_id)).map((t) => [t.id, t]));
    return rows
      .filter((r) => tracks.has(r.track_id))
      .map((r) => ({ track: tracks.get(r.track_id), plays: r.plays, seconds: r.seconds }));
  }

  /** @returns {{artist: string, plays: number, seconds: number, tracks: number}[]} */
  topArtists({ limit = 8 } = {}) {
    return this.#db
      .prepare(
        `SELECT t.artist AS artist, COUNT(*) AS plays,
                COALESCE(SUM(h.listened_sec), 0) AS seconds,
                COUNT(DISTINCT h.track_id) AS tracks
           FROM history h JOIN tracks t ON t.id = h.track_id
          GROUP BY t.artist COLLATE NOCASE
          ORDER BY plays DESC, seconds DESC LIMIT ?`,
      )
      .all(limit);
  }

  /** @returns {{genre: string, plays: number}[]} only genres the provider actually supplied */
  topGenres({ limit = 6 } = {}) {
    return this.#db
      .prepare(
        `SELECT t.genre AS genre, COUNT(*) AS plays
           FROM history h JOIN tracks t ON t.id = h.track_id
          WHERE t.genre IS NOT NULL AND t.genre <> ''
          GROUP BY t.genre COLLATE NOCASE
          ORDER BY plays DESC LIMIT ?`,
      )
      .all(limit);
  }

  /**
   * Plays per day for the last `days` days, oldest first. Days with no
   * listening are present with `plays: 0` so the sparkline has a real x-axis.
   */
  activity({ days = 14, now = new Date() } = {}) {
    const rows = this.#db
      .prepare(
        `SELECT substr(played_at, 1, 10) AS day, COUNT(*) AS plays,
                COALESCE(SUM(listened_sec), 0) AS seconds
           FROM history GROUP BY day`,
      )
      .all();
    const byDay = new Map(rows.map((r) => [r.day, r]));
    const out = [];
    for (let i = days - 1; i >= 0; i -= 1) {
      const date = new Date(now.getTime() - i * 86400000);
      const key = date.toISOString().slice(0, 10);
      const row = byDay.get(key);
      out.push({ day: key, plays: row?.plays ?? 0, seconds: row?.seconds ?? 0 });
    }
    return out;
  }

  /** Counts for the Home screen tiles. */
  libraryCounts() {
    const favorites = this.#db.prepare('SELECT COUNT(*) AS n FROM favorites').get().n;
    const playlists = this.#db.prepare('SELECT COUNT(*) AS n FROM playlists').get().n;
    const tracks = this.#db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n;
    const history = this.#db.prepare('SELECT COUNT(*) AS n FROM history').get().n;
    return { favorites, playlists, tracks, history };
  }
}
