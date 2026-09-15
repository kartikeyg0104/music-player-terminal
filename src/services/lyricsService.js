import fs from 'node:fs/promises';
import path from 'node:path';
import { HttpClient } from '../providers/http.js';

/**
 * Lyrics, synchronised where the source genuinely provides timing.
 *
 * Two sources, both honest:
 *  - `local`: an `.lrc` file sitting next to a local audio file. Timestamps
 *    come from the file, so synchronisation is real.
 *  - `lrclib`: lrclib.net, a free, key-less, community lyrics API that
 *    returns `syncedLyrics` in LRC format when it has them.
 *
 * Termify never generates timings. If a source returns plain lyrics we render
 * them unsynchronised and label them as such.
 */
export class LyricsService {
  #settings;
  #http;
  #logger;
  /** Per-track memo: lyrics are small and only useful for this session. */
  #memo = new Map();

  constructor({ settings, logger, http } = {}) {
    this.#settings = settings;
    this.#logger = logger;
    this.#http = http ?? new HttpClient({ timeoutMs: 8000, minIntervalMs: 300, logger });
  }

  /**
   * @param {import('../core/track.js').Track} track
   * @returns {Promise<{status:'none'|'synced'|'plain', lines: {time:number|null,text:string}[], source: string|null, note: string|null}>}
   */
  async fetch(track, { signal } = {}) {
    if (!track) return none();
    const source = this.#settings?.get('lyricsSource') ?? 'local';
    if (source === 'off') return none('Lyrics are turned off in Settings.');
    if (this.#memo.has(track.id)) return this.#memo.get(track.id);

    let result = none();
    const local = await this.#readLocal(track);
    if (local) result = local;
    else if (source === 'lrclib') result = await this.#fetchLrclib(track, { signal });
    else if (track.localPath) result = none('No .lrc file next to this track.');
    else {
      result = none('Local lyrics only. Switch to lrclib in Settings to search online.');
    }

    this.#memo.set(track.id, result);
    return result;
  }

  async #readLocal(track) {
    if (!track.localPath) return null;
    const lrcPath = track.localPath.replace(/\.[^.]+$/, '.lrc');
    try {
      const text = await fs.readFile(lrcPath, 'utf8');
      const parsed = parseLrc(text);
      if (!parsed.lines.length) return null;
      return { ...parsed, source: path.basename(lrcPath), note: null };
    } catch {
      return null;
    }
  }

  async #fetchLrclib(track, { signal } = {}) {
    const url = new URL('https://lrclib.net/api/get');
    url.searchParams.set('track_name', track.title);
    url.searchParams.set('artist_name', track.artist);
    if (track.album) url.searchParams.set('album_name', track.album);
    if (track.duration) url.searchParams.set('duration', String(track.duration));

    try {
      const payload = await this.#http.getJson(url.toString(), {
        signal,
        provider: 'lrclib',
        retries: 1,
      });
      if (payload?.syncedLyrics) {
        const parsed = parseLrc(payload.syncedLyrics);
        if (parsed.lines.length) return { ...parsed, source: 'lrclib.net', note: null };
      }
      if (payload?.plainLyrics) {
        return {
          status: 'plain',
          lines: payload.plainLyrics.split('\n').map((text) => ({ time: null, text })),
          source: 'lrclib.net',
          note: 'lrclib has no timing data for this track - showing plain lyrics.',
        };
      }
      return none('lrclib has no lyrics for this track.');
    } catch (error) {
      this.#logger?.debug('lrclib lookup failed', { error: error.message });
      return none('Could not reach lrclib.net.');
    }
  }

  /** Index of the line that should be highlighted at `seconds`, or -1. */
  activeLine(lines, seconds) {
    if (!lines?.length) return -1;
    let active = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].time == null) continue;
      if (lines[i].time <= seconds) active = i;
      else break;
    }
    return active;
  }

  clear() {
    this.#memo.clear();
  }
}

function none(note = null) {
  return { status: 'none', lines: [], source: null, note };
}

/**
 * Parse LRC. Handles multiple timestamps per line and `[mm:ss.xx]`.
 * Exported for tests.
 */
export function parseLrc(text) {
  const lines = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    const content = raw.replace(/\[[^\]]*\]/g, '').trim();
    if (!stamps.length) continue;
    for (const stamp of stamps) {
      const minutes = Number(stamp[1]);
      const seconds = Number(stamp[2]);
      const fraction = stamp[3] ? Number(`0.${stamp[3]}`) : 0;
      lines.push({ time: minutes * 60 + seconds + fraction, text: content });
    }
  }
  lines.sort((a, b) => a.time - b.time);
  return { status: lines.length ? 'synced' : 'none', lines };
}
