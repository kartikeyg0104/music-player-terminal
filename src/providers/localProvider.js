import fs from 'node:fs/promises';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import { MusicProvider, buildResult, emptyResult } from './base.js';
import { createTrack, hashId, AVAILABILITY } from '../core/track.js';
import { matchesQuery } from '../core/util.js';
import { ValidationError } from '../core/errors.js';

export const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.m4a',
  '.aac',
  '.flac',
  '.ogg',
  '.oga',
  '.opus',
  '.wav',
  '.aiff',
  '.aif',
  '.wma',
]);

const MAX_DEPTH = 6;
const MAX_FILES = 20000;

/**
 * Local filesystem provider.
 *
 * Optional by design: Termify never requires a music folder to start. When no
 * directory is configured the provider reports itself unconfigured and the UI
 * offers to set one in Settings.
 *
 * The scan is lazy and cached in memory; tags are read with `music-metadata`
 * and fall back to the filename when a file has none.
 */
export class LocalProvider extends MusicProvider {
  static id = 'local';
  static label = 'Local files';

  #root;
  #tracks = null;
  #scanning = null;
  #lastScanAt = null;
  #errors = [];

  constructor(options = {}) {
    super(options);
    this.#root = options.musicDir ? path.resolve(options.musicDir) : null;
  }

  get isLive() {
    return true;
  }

  get root() {
    return this.#root;
  }

  /** Change the scanned directory and drop the cached index. */
  setRoot(dir) {
    const next = dir ? path.resolve(dir) : null;
    if (next === this.#root) return;
    this.#root = next;
    this.#tracks = null;
    this.#lastScanAt = null;
    this.#errors = [];
  }

  status() {
    if (!this.#root) {
      return {
        configured: false,
        reason: 'no local music folder configured',
        hint: 'Set a folder in Settings, or TERMIFY_MUSIC_DIR in .env',
      };
    }
    return { configured: true, reason: null, hint: null };
  }

  get capabilities() {
    return {
      text: true,
      artist: true,
      album: true,
      genre: true,
      genres: true,
      featured: true,
      pagination: true,
    };
  }

  get stats() {
    return {
      root: this.#root,
      count: this.#tracks?.length ?? null,
      lastScanAt: this.#lastScanAt,
      errors: this.#errors.length,
    };
  }

  async genres() {
    const tracks = await this.#index();
    return [...new Set(tracks.map((t) => t.genre).filter(Boolean))]
      .sort()
      .map((id) => ({ id, label: id }));
  }

  async featuredSections() {
    return [
      { id: 'all', label: 'Everything', description: 'Your whole local folder, A-Z' },
      { id: 'recent', label: 'Recently added', description: 'By file modification time' },
    ];
  }

  async featured(sectionId, options = {}) {
    const tracks = await this.#index();
    const rows =
      sectionId === 'recent'
        ? [...tracks].sort((a, b) => (b.providerData?.mtime ?? 0) - (a.providerData?.mtime ?? 0))
        : tracks;
    return this.#page(rows, options.page ?? 1, options.limit ?? 25);
  }

  async search(query) {
    this.assertConfigured();
    const tracks = await this.#index();
    let rows = tracks;
    if (query.text) {
      rows = rows.filter((t) =>
        [t.title, t.artist, t.album, t.genre].some((f) => matchesQuery(f, query.text)),
      );
    }
    if (query.artist) rows = rows.filter((t) => matchesQuery(t.artist, query.artist));
    if (query.album) rows = rows.filter((t) => matchesQuery(t.album, query.album));
    if (query.genre) rows = rows.filter((t) => matchesQuery(t.genre, query.genre));
    if (!rows.length && !query.text && !query.artist && !query.album && !query.genre) {
      return emptyResult(this.id);
    }
    return this.#page(rows, query.page ?? 1, query.limit ?? 25);
  }

  #page(rows, page, limit) {
    const start = (page - 1) * limit;
    return buildResult(this.id, rows.slice(start, start + limit), {
      total: rows.length,
      page,
      limit,
      note: this.#errors.length
        ? `${this.#errors.length} file(s) could not be read and were skipped.`
        : null,
    });
  }

  /** Force a rescan (Settings > cache actions). */
  async rescan() {
    this.#tracks = null;
    return (await this.#index()).length;
  }

  async #index() {
    this.assertConfigured();
    if (this.#tracks) return this.#tracks;
    if (this.#scanning) return this.#scanning;
    this.#scanning = this.#scan()
      .then((tracks) => {
        this.#tracks = tracks;
        this.#lastScanAt = new Date().toISOString();
        return tracks;
      })
      .finally(() => {
        this.#scanning = null;
      });
    return this.#scanning;
  }

  async #scan() {
    const root = this.#root;
    const stat = await fs.stat(root).catch(() => null);
    if (!stat?.isDirectory()) {
      throw new ValidationError(`local music folder is not a directory: ${root}`, {
        userMessage: 'Local music folder not found',
        hint: `Check the path in Settings (currently ${root}).`,
      });
    }
    this.#errors = [];
    const files = [];
    await walk(root, 0, files, this.#errors);

    const tracks = [];
    for (const file of files) {
      try {
        tracks.push(await this.#toTrack(file, root));
      } catch (error) {
        this.#errors.push({ file: file.path, message: error.message });
      }
    }
    tracks.sort(
      (a, b) =>
        a.artist.localeCompare(b.artist) ||
        a.album.localeCompare(b.album) ||
        (a.providerData.trackNo ?? 0) - (b.providerData.trackNo ?? 0) ||
        a.title.localeCompare(b.title),
    );
    this.logger?.info('local scan complete', { files: files.length, errors: this.#errors.length });
    return tracks;
  }

  async #toTrack(file, root) {
    let tags = null;
    try {
      tags = await parseFile(file.path, { duration: true, skipCovers: true });
    } catch (error) {
      // Unsupported or damaged tags are not fatal: fall back to the filename.
      this.logger?.debug('tag read failed', { file: file.path, error: error.message });
    }
    const common = tags?.common ?? {};
    const relative = path.relative(root, file.path);
    return createTrack({
      provider: this.id,
      // Path-derived hash: stable across restarts, independent of the URL.
      providerId: hashId(relative),
      title: common.title || path.basename(file.path, path.extname(file.path)),
      artist: common.artist || common.albumartist || 'Unknown artist',
      album: common.album || path.basename(path.dirname(file.path)),
      duration: tags?.format?.duration ?? null,
      genre: common.genre?.[0] ?? null,
      year: common.year ?? null,
      localPath: file.path,
      availability: AVAILABILITY.AVAILABLE,
      providerData: {
        relativePath: relative,
        mtime: file.mtime,
        trackNo: common.track?.no ?? null,
        codec: tags?.format?.codec ?? null,
      },
    });
  }

  /** Confirm the file is still on disk before playing it. */
  async resolve(track) {
    if (!track.localPath) return track;
    const exists = await fs
      .access(track.localPath)
      .then(() => true)
      .catch(() => false);
    if (exists) return track;
    return createTrack({ ...track, availability: AVAILABILITY.UNAVAILABLE });
  }
}

async function walk(dir, depth, out, errors) {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    errors.push({ file: dir, message: error.message });
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, depth + 1, out, errors);
    } else if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      const stat = await fs.stat(full).catch(() => null);
      out.push({ path: full, mtime: stat?.mtimeMs ?? 0 });
    }
    if (out.length >= MAX_FILES) return;
  }
}
