/**
 * Smart playlists built only from data Termify actually holds.
 *
 * Each recipe declares what it needs; when the underlying data is missing the
 * recipe reports `available: false` with a reason instead of producing an
 * empty-but-plausible list. Nothing here invents taste data.
 */
export class SmartPlaylistService {
  #db;
  #tracks;
  #favorites;
  #history;
  #playlists;

  constructor({ db, tracks, favorites, history, playlists }) {
    this.#db = db;
    this.#tracks = tracks;
    this.#favorites = favorites;
    this.#history = history;
    this.#playlists = playlists;
  }

  /** @returns {{id:string,label:string,description:string,requires:string}[]} */
  recipes() {
    return [
      {
        id: 'recently-played',
        label: 'Recently played',
        description: 'Your last 30 distinct tracks, newest first',
        requires: 'listening history',
      },
      {
        id: 'most-played',
        label: 'On repeat',
        description: 'Your 30 most-played tracks',
        requires: 'listening history',
      },
      {
        id: 'favorite-artists',
        label: 'From artists you like',
        description: 'Everything in your library by artists you have favourited',
        requires: 'favourites',
      },
      {
        id: 'undiscovered',
        label: 'Barely played',
        description: 'Library tracks you have played at most once',
        requires: 'a library with more than a few tracks',
      },
      {
        id: 'top-genre',
        label: 'Your top genre',
        description: 'Tracks in the genre you play most',
        requires: 'genre metadata in your history',
      },
    ];
  }

  /**
   * @param {string} recipeId
   * @returns {{available: boolean, reason: string|null, tracks: import('../core/track.js').Track[], label: string}}
   */
  generate(recipeId, { limit = 30 } = {}) {
    const recipe = this.recipes().find((r) => r.id === recipeId);
    if (!recipe) return { available: false, reason: 'Unknown recipe', tracks: [], label: recipeId };

    const ids = this.#idsFor(recipeId, limit);
    if (!ids.length) {
      return {
        available: false,
        reason: `Not enough data yet - this needs ${recipe.requires}.`,
        tracks: [],
        label: recipe.label,
      };
    }
    return {
      available: true,
      reason: null,
      tracks: this.#tracks.getMany(ids),
      label: recipe.label,
    };
  }

  #idsFor(recipeId, limit) {
    switch (recipeId) {
      case 'recently-played':
        return this.#db
          .prepare(
            `SELECT track_id, MAX(played_at) AS last FROM history
              GROUP BY track_id ORDER BY last DESC LIMIT ?`,
          )
          .all(limit)
          .map((r) => r.track_id);

      case 'most-played':
        return this.#db
          .prepare(
            `SELECT track_id, COUNT(*) AS plays FROM history
              GROUP BY track_id HAVING plays > 0
              ORDER BY plays DESC, MAX(played_at) DESC LIMIT ?`,
          )
          .all(limit)
          .map((r) => r.track_id);

      case 'favorite-artists': {
        const artists = this.#db
          .prepare(`SELECT DISTINCT t.artist FROM favorites f JOIN tracks t ON t.id = f.track_id`)
          .all()
          .map((r) => r.artist)
          .filter(Boolean);
        if (!artists.length) return [];
        const placeholders = artists.map(() => '?').join(',');
        return this.#db
          .prepare(
            `SELECT id FROM tracks WHERE artist IN (${placeholders}) COLLATE NOCASE
              ORDER BY artist, album, title LIMIT ?`,
          )
          .all(...artists, limit)
          .map((r) => r.id);
      }

      case 'undiscovered':
        return this.#db
          .prepare(
            `SELECT t.id, COUNT(h.id) AS plays FROM tracks t
               LEFT JOIN history h ON h.track_id = t.id
              WHERE t.availability = 'available'
              GROUP BY t.id HAVING plays <= 1
              ORDER BY plays ASC, t.updated_at DESC LIMIT ?`,
          )
          .all(limit)
          .map((r) => r.id);

      case 'top-genre': {
        const top = this.#db
          .prepare(
            `SELECT t.genre AS genre, COUNT(*) AS plays FROM history h
               JOIN tracks t ON t.id = h.track_id
              WHERE t.genre IS NOT NULL AND t.genre <> ''
              GROUP BY t.genre COLLATE NOCASE ORDER BY plays DESC LIMIT 1`,
          )
          .get();
        if (!top?.genre) return [];
        return this.#db
          .prepare(
            `SELECT id FROM tracks WHERE genre = ? COLLATE NOCASE ORDER BY artist, title LIMIT ?`,
          )
          .all(top.genre, limit)
          .map((r) => r.id);
      }

      default:
        return [];
    }
  }

  /**
   * Materialise a recipe into a real, editable playlist. Re-running replaces
   * the contents of the same playlist rather than creating duplicates.
   */
  materialise(recipeId, { limit = 30 } = {}) {
    const result = this.generate(recipeId, { limit });
    if (!result.available) return { created: false, reason: result.reason, playlist: null };
    const name = `Smart: ${result.label}`;
    const existing = this.#playlists.getByName(name);
    const playlist =
      existing ??
      this.#playlists.create(name, {
        description: `Generated from your ${recipeId.replace(/-/g, ' ')} data`,
        kind: 'smart',
        rule: { recipeId, limit },
      });
    this.#playlists.replaceTracks(playlist.id, result.tracks);
    return { created: true, reason: null, playlist: this.#playlists.get(playlist.id) };
  }

  /** Data-availability summary shown on the Discover screen. */
  availability() {
    return {
      history: this.#history.count(),
      favorites: this.#favorites.count(),
      tracks: this.#tracks.count(),
    };
  }
}
