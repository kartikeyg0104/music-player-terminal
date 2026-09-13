import fs from 'node:fs';
import path from 'node:path';
import { MusicProvider, buildResult } from './base.js';
import { createTrack, AVAILABILITY } from '../core/track.js';
import { matchesQuery } from '../core/util.js';
import { SAMPLE_TRACKS } from './sampleData.js';
import { synthesiseTone, isSynthesisAvailable } from '../playback/toneSynth.js';

const SAMPLE_NOTE = 'Demo mode: these are built-in sample entries, not live provider results.';

/**
 * Mock provider: deterministic fixture data for demo mode and tests.
 *
 * Everything it returns is flagged `isSample: true` and rendered with a SAMPLE
 * badge, so simulated data can never be mistaken for a live catalogue.
 *
 * Demo tracks are still genuinely playable: on first play each one is
 * synthesised into a short local tone file with ffmpeg, which exercises the
 * real audio pipeline end to end without pretending to be music. If ffmpeg is
 * absent the tracks degrade to metadata-only.
 */
export class MockProvider extends MusicProvider {
  static id = 'mock';
  static label = 'Demo (sample data)';

  #cacheDir;
  #synthesisAvailable;

  constructor(options = {}) {
    super(options);
    this.#cacheDir = options.cacheDir ? path.join(options.cacheDir, 'demo-audio') : null;
    this.#synthesisAvailable = options.synthesisAvailable ?? isSynthesisAvailable();
  }

  get isLive() {
    return false;
  }

  status() {
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

  async genres() {
    return [...new Set(SAMPLE_TRACKS.map((t) => t.genre))]
      .sort()
      .map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) }));
  }

  async featuredSections() {
    return [
      {
        id: 'all',
        label: 'Sample catalogue',
        description: 'Every built-in demo entry, in fixture order',
      },
      { id: 'short', label: 'Under two minutes', description: 'Demo entries with short durations' },
    ];
  }

  async featured(sectionId, options = {}) {
    const rows =
      sectionId === 'short' ? SAMPLE_TRACKS.filter((t) => t.duration < 120) : SAMPLE_TRACKS;
    return this.#page(rows, options.page ?? 1, options.limit ?? 25);
  }

  async search(query) {
    let rows = SAMPLE_TRACKS;
    if (query.text) {
      rows = rows.filter((t) =>
        [t.title, t.artist, t.album, t.genre].some((f) => matchesQuery(f, query.text)),
      );
    }
    if (query.artist) rows = rows.filter((t) => matchesQuery(t.artist, query.artist));
    if (query.album) rows = rows.filter((t) => matchesQuery(t.album, query.album));
    if (query.genre) rows = rows.filter((t) => matchesQuery(t.genre, query.genre));
    return this.#page(rows, query.page ?? 1, query.limit ?? 25);
  }

  #page(rows, page, limit) {
    const start = (page - 1) * limit;
    const slice = rows.slice(start, start + limit);
    return buildResult(
      this.id,
      slice.map((row) => this.#toTrack(row)),
      { total: rows.length, page, limit, isSample: true, note: SAMPLE_NOTE },
    );
  }

  #toTrack(row) {
    return createTrack({
      provider: this.id,
      providerId: row.id,
      title: row.title,
      artist: row.artist,
      album: row.album,
      duration: row.duration,
      genre: row.genre,
      year: row.year,
      license: 'Sample data (not a real release)',
      artworkUrl: null,
      streamUrl: null,
      availability: this.#synthesisAvailable ? AVAILABILITY.AVAILABLE : AVAILABILITY.METADATA_ONLY,
      isSample: true,
      providerData: { tone: row.tone, waveform: row.waveform },
    });
  }

  /**
   * Materialise the demo tone on demand so the audio path is exercised for
   * real. Files are cached, so this costs one ffmpeg run per demo track.
   */
  async resolve(track) {
    if (!this.#synthesisAvailable || !this.#cacheDir) {
      return createTrack({ ...track, availability: AVAILABILITY.METADATA_ONLY, localPath: null });
    }
    const file = path.join(this.#cacheDir, `${track.providerId}.wav`);
    if (!fs.existsSync(file)) {
      try {
        fs.mkdirSync(this.#cacheDir, { recursive: true });
        await synthesiseTone({
          outputPath: file,
          frequency: track.providerData?.tone ?? 220,
          waveform: track.providerData?.waveform ?? 'sine',
          seconds: Math.min(track.duration ?? 30, 45),
        });
      } catch (error) {
        this.logger?.warn('demo tone synthesis failed', { error: error.message });
        return createTrack({ ...track, availability: AVAILABILITY.METADATA_ONLY });
      }
    }
    return createTrack({ ...track, localPath: file, availability: AVAILABILITY.AVAILABLE });
  }
}
