import crypto from 'node:crypto';

/**
 * The one internal track shape every provider normalises into and every
 * consumer (queue, playlists, UI, playback) reads.
 *
 * @typedef {object} Track
 * @property {string} id            Stable internal id: `${provider}:${providerId}`.
 * @property {string} provider      Provider name, e.g. 'archive'.
 * @property {string} providerId    Provider-native identifier (stable, not a URL).
 * @property {string} title
 * @property {string} artist
 * @property {string} album
 * @property {number|null} duration Seconds, or null when the provider omits it.
 * @property {string|null} artworkUrl
 * @property {string|null} streamUrl        May expire - never treat as an identity.
 * @property {string|null} localPath        Set for on-disk files.
 * @property {string|null} externalUrl      Web page for metadata-only results.
 * @property {'available'|'metadata-only'|'unavailable'} availability
 * @property {string|null} genre
 * @property {number|null} year
 * @property {string|null} license
 * @property {boolean} isSample     True when the row is demo/mock data.
 * @property {Record<string, unknown>} providerData  Provider-specific extras.
 */

export const AVAILABILITY = /** @type {const} */ ({
  AVAILABLE: 'available',
  METADATA_ONLY: 'metadata-only',
  UNAVAILABLE: 'unavailable',
});

/**
 * Build a `Track` from loose provider input, filling every field.
 * Providers call this so the rest of the app never sees a partial track.
 * @param {Partial<Track> & { provider: string, providerId: string }} input
 * @returns {Track}
 */
export function createTrack(input) {
  const provider = String(input.provider ?? '');
  const providerId = String(input.providerId ?? '');
  if (!provider || !providerId) {
    throw new TypeError('createTrack requires provider and providerId');
  }
  const localPath = input.localPath ?? null;
  const streamUrl = input.streamUrl ?? null;
  const availability =
    input.availability ??
    (localPath || streamUrl ? AVAILABILITY.AVAILABLE : AVAILABILITY.METADATA_ONLY);

  return {
    id: `${provider}:${providerId}`,
    provider,
    providerId,
    title: cleanText(input.title) || 'Unknown title',
    artist: cleanText(input.artist) || 'Unknown artist',
    album: cleanText(input.album) || '',
    duration: normaliseDuration(input.duration),
    artworkUrl: input.artworkUrl || null,
    streamUrl,
    localPath,
    externalUrl: input.externalUrl || null,
    availability,
    genre: cleanText(input.genre) || null,
    year: Number.isFinite(Number(input.year)) && input.year ? Number(input.year) : null,
    license: input.license || null,
    isSample: Boolean(input.isSample),
    providerData: input.providerData ?? {},
  };
}

/** Is this track something the playback engine can actually open right now? */
export function isPlayable(track) {
  return (
    Boolean(track) &&
    track.availability === AVAILABILITY.AVAILABLE &&
    Boolean(track.streamUrl || track.localPath)
  );
}

/** What the audio adapter should open. */
export function playbackSource(track) {
  if (track?.localPath) return { kind: 'file', value: track.localPath };
  if (track?.streamUrl) return { kind: 'url', value: track.streamUrl };
  return null;
}

/**
 * Accepts `"215"`, `215`, `"03:35"`, `"1:02:03"`, `"53.33"`.
 * @returns {number|null} whole seconds
 */
export function normaliseDuration(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  }
  const text = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(text)) {
    const n = Number.parseFloat(text);
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  const parts = text.split(':');
  if (
    parts.length >= 2 &&
    parts.length <= 3 &&
    parts.every((p) => /^\d+(\.\d+)?$/.test(p.trim()))
  ) {
    return Math.round(parts.reduce((acc, part) => acc * 60 + Number.parseFloat(part.trim()), 0));
  }
  return null;
}

/** `215` -> `3:35`, `null` -> `--:--`. */
export function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '--:--';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** `7265` -> `2h 1m`. Used by the stats view. */
export function formatListeningTime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0m';
  // Under a minute, seconds are the honest unit - rounding 45s up to "1m"
  // would overstate a figure the stats screen presents as measured.
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/** Stable synthetic id for sources without one (local files, smart playlists). */
export function hashId(...parts) {
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}

function cleanText(value) {
  if (value == null) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

/** Round-trip a track through JSON storage without losing field discipline. */
export function serialiseTrack(track) {
  return JSON.stringify(track);
}

/** @returns {Track|null} */
export function deserialiseTrack(json) {
  if (!json) return null;
  try {
    const raw = JSON.parse(json);
    if (!raw?.provider || !raw?.providerId) return null;
    return createTrack(raw);
  } catch {
    return null;
  }
}
