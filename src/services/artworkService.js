import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { probe } from '../playback/adapters/ffplayAdapter.js';

/**
 * Album artwork as terminal colour blocks.
 *
 * Inline-image protocols (iTerm2, kitty) are not universal and interact badly
 * with a full-screen TUI's redraw, so Termify takes a different route: ffmpeg
 * downscales the cover to a tiny raw RGB bitmap and we paint it with half-block
 * characters. That is real artwork, from real pixels, in any 256-colour
 * terminal - and when ffmpeg or the image is missing we fall back to a
 * generated monogram card rather than a blank hole.
 */
export class ArtworkService {
  #cacheDir;
  #logger;
  #memo = new Map();
  #pending = new Map();
  #available;

  constructor({ cacheDir, logger, available } = {}) {
    this.#cacheDir = cacheDir;
    this.#logger = logger;
    this.#available = available ?? probe('ffmpeg');
  }

  get available() {
    return this.#available;
  }

  /**
   * @param {import('../core/track.js').Track} track
   * @param {{width?: number, height?: number}} [size] in character cells
   * @returns {Promise<{kind:'pixels'|'fallback', rows?: string[][][], width:number, height:number}>}
   */
  async load(track, { width = 16, height = 8 } = {}) {
    const key = `${track?.id}:${width}x${height}`;
    if (this.#memo.has(key)) return this.#memo.get(key);
    if (this.#pending.has(key)) return this.#pending.get(key);

    const job = this.#load(track, width, height)
      .then((result) => {
        this.#memo.set(key, result);
        return result;
      })
      .catch(() => {
        const fallback = { kind: 'fallback', width, height };
        this.#memo.set(key, fallback);
        return fallback;
      })
      .finally(() => this.#pending.delete(key));

    this.#pending.set(key, job);
    return job;
  }

  /** Synchronous peek for render: returns null while the fetch is in flight. */
  peek(track, { width = 16, height = 8 } = {}) {
    return this.#memo.get(`${track?.id}:${width}x${height}`) ?? null;
  }

  async #load(track, width, height) {
    if (!this.#available || !track) return { kind: 'fallback', width, height };
    const source = track.localPath ?? track.artworkUrl;
    if (!source) return { kind: 'fallback', width, height };

    // Each cell is drawn as two vertical half-blocks, so sample 2x the rows.
    const pixels = await this.#toPixels(source, width, height * 2, Boolean(track.localPath));
    if (!pixels) return { kind: 'fallback', width, height };

    const rows = [];
    for (let y = 0; y < height; y += 1) {
      const row = [];
      for (let x = 0; x < width; x += 1) {
        row.push([pixelAt(pixels, width, x, y * 2), pixelAt(pixels, width, x, y * 2 + 1)]);
      }
      rows.push(row);
    }
    return { kind: 'pixels', rows, width, height };
  }

  /** Run ffmpeg to produce a tiny raw RGB buffer. */
  async #toPixels(source, width, height, isLocalAudio) {
    const cached = await this.#cachedSource(source, isLocalAudio);
    if (!cached) return null;
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      cached,
      '-vf',
      `scale=${width}:${height}:flags=lanczos`,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1',
    ];
    return new Promise((resolve) => {
      // argv array; `cached` is always a path we produced or verified.
      const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
      const chunks = [];
      child.stdout.on('data', (chunk) => chunks.push(chunk));
      child.on('error', () => resolve(null));
      child.on('close', (code) => {
        const buffer = Buffer.concat(chunks);
        if (code !== 0 || buffer.length < width * height * 3) return resolve(null);
        resolve(buffer);
      });
    });
  }

  /**
   * Local audio files are handed to ffmpeg directly (it reads embedded art).
   * Remote artwork is downloaded to the cache first so we never pass a URL to
   * a subprocess and never re-download the same cover.
   */
  async #cachedSource(source, isLocalAudio) {
    if (isLocalAudio) return fs.existsSync(source) ? source : null;
    if (!/^https?:\/\//i.test(source)) return null;
    const name = `${crypto.createHash('sha1').update(source).digest('hex')}.img`;
    const file = path.join(this.#cacheDir, name);
    if (fs.existsSync(file)) return file;
    try {
      const response = await fetch(source, {
        signal: AbortSignal.timeout(8000),
        headers: { 'user-agent': 'Termify/1.0' },
      });
      if (!response.ok) return null;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length < 64) return null;
      await fsp.mkdir(this.#cacheDir, { recursive: true });
      await fsp.writeFile(file, buffer);
      return file;
    } catch (error) {
      this.#logger?.debug('artwork download failed', { error: error.message });
      return null;
    }
  }

  async clearCache() {
    this.#memo.clear();
    try {
      const entries = await fsp.readdir(this.#cacheDir);
      await Promise.all(entries.map((e) => fsp.rm(path.join(this.#cacheDir, e), { force: true })));
      return entries.length;
    } catch {
      return 0;
    }
  }

  async cacheStats() {
    try {
      const entries = await fsp.readdir(this.#cacheDir);
      let bytes = 0;
      for (const entry of entries) {
        const stat = await fsp.stat(path.join(this.#cacheDir, entry)).catch(() => null);
        bytes += stat?.size ?? 0;
      }
      return { files: entries.length, bytes };
    } catch {
      return { files: 0, bytes: 0 };
    }
  }
}

function pixelAt(buffer, width, x, y) {
  const offset = (y * width + x) * 3;
  if (offset + 2 >= buffer.length) return '#000000';
  return `#${buffer[offset].toString(16).padStart(2, '0')}${buffer[offset + 1]
    .toString(16)
    .padStart(2, '0')}${buffer[offset + 2].toString(16).padStart(2, '0')}`;
}
