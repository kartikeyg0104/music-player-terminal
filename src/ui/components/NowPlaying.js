import { box, text, h } from '../h.js';
import { ProgressBar, VolumeMeter, Spinner, Badge } from './primitives.js';
import { Artwork } from './Artwork.js';
import { Visualizer } from './Visualizer.js';
import { formatDuration } from '../../core/track.js';
import { truncate } from '../../core/util.js';
import { PLAYBACK_STATE } from '../../playback/engine.js';

/**
 * The persistent Now Playing region.
 *
 * Always visible, always the same shape, so the eye learns where to look:
 * artwork, then title/artist, then transport + progress, then modes. It
 * degrades in two steps - artwork drops first, then the queue preview - so
 * the essentials survive a small terminal.
 */
export function NowPlaying({
  theme,
  width,
  playback,
  artworkService,
  showArtwork,
  visualizerMode,
  levels,
  upcoming,
  compact,
  favorite,
}) {
  const c = theme.colors;
  const g = theme.glyphs;
  const { track, status, position, duration, buffering, volume, shuffle, repeat } = playback;

  const artWidth = showArtwork && !compact && width > 74 ? 14 : 0;
  const artHeight = 6;
  const bodyWidth = Math.max(20, width - artWidth - (artWidth ? 2 : 0));

  return box(
    { flexDirection: 'column', width },
    text({ color: c.line }, g.hLine.repeat(Math.max(0, width))),
    box(
      { flexDirection: 'row', width },
      artWidth
        ? box(
            { flexDirection: 'column', marginRight: 2, flexShrink: 0 },
            h(Artwork, {
              theme,
              track,
              service: artworkService,
              width: artWidth,
              height: artHeight,
            }),
          )
        : null,
      box(
        { flexDirection: 'column', width: bodyWidth },
        h(TrackLine, { theme, track, status, buffering, width: bodyWidth, favorite }),
        h(TransportLine, {
          theme,
          width: bodyWidth,
          status,
          position,
          duration,
          estimated: playback.positionEstimated,
          canSeek: playback.canSeek,
        }),
        h(ModeLine, {
          theme,
          width: bodyWidth,
          shuffle,
          repeat,
          volume,
          canSetVolume: playback.canSetVolume,
          sleepTimer: playback.sleepTimer,
          visualizerMode,
          levels,
          playing: status === PLAYBACK_STATE.PLAYING,
          compact,
        }),
        upcoming?.length && !compact
          ? h(QueuePreview, { theme, width: bodyWidth, upcoming })
          : null,
      ),
    ),
  );
}

function TrackLine({ theme, track, status, buffering, width, favorite }) {
  const c = theme.colors;
  const g = theme.glyphs;

  if (!track) {
    return box(
      { flexDirection: 'row' },
      text({ color: c.textFaint }, ` ${g.stop} `),
      text({ color: c.textMuted }, 'Nothing playing'),
      text({ color: c.textFaint }, `   ${g.dot}  press / to search, or 3 to browse`),
    );
  }

  const icon =
    status === PLAYBACK_STATE.PLAYING
      ? g.play
      : status === PLAYBACK_STATE.PAUSED
        ? g.pause
        : status === PLAYBACK_STATE.ERROR
          ? g.cross
          : g.stop;
  const iconColor =
    status === PLAYBACK_STATE.PLAYING
      ? c.accent
      : status === PLAYBACK_STATE.ERROR
        ? c.danger
        : c.textMuted;

  const titleWidth = Math.max(10, Math.floor(width * 0.45));
  const artistWidth = Math.max(8, width - titleWidth - 24);

  return box(
    { flexDirection: 'row' },
    buffering || status === PLAYBACK_STATE.LOADING
      ? box({ marginRight: 1 }, h(Spinner, { theme }))
      : text({ color: iconColor }, ` ${icon} `),
    text({ color: c.textStrong, bold: true }, truncate(track.title, titleWidth)),
    text({ color: c.textFaint }, `  ${g.dot}  `),
    text({ color: c.textMuted }, truncate(track.artist, artistWidth)),
    favorite ? text({ color: c.danger }, `  ${g.heart}`) : null,
    track.isSample ? h(Badge, { theme, label: 'SAMPLE', tone: 'warning' }) : null,
  );
}

function TransportLine({ theme, width, status, position, duration, estimated, canSeek }) {
  const c = theme.colors;
  const g = theme.glyphs;
  const controls = [
    { glyph: g.prev, active: false },
    { glyph: status === PLAYBACK_STATE.PLAYING ? g.pause : g.play, active: true },
    { glyph: g.next, active: false },
  ];
  const controlWidth = controls.reduce((n, ctl) => n + ctl.glyph.length + 2, 0);
  const timeWidth = 14;
  const barWidth = Math.max(6, width - controlWidth - timeWidth - 4);

  return box(
    { flexDirection: 'row', marginTop: 0 },
    ...controls.map((ctl, i) =>
      text({ key: i, color: ctl.active ? c.accent : c.textMuted }, ` ${ctl.glyph} `),
    ),
    text(null, ' '),
    h(ProgressBar, {
      theme,
      value: position,
      max: duration ?? 0,
      width: barWidth,
      elapsedLabel: formatDuration(position).padStart(5),
      totalLabel: duration ? formatDuration(duration) : '--:--',
      estimated,
      tone: canSeek ? undefined : c.textMuted,
    }),
  );
}

function ModeLine({
  theme,
  width,
  shuffle,
  repeat,
  volume,
  canSetVolume,
  sleepTimer,
  visualizerMode,
  levels,
  playing,
  compact,
}) {
  const c = theme.colors;
  const g = theme.glyphs;
  const repeatGlyph = repeat === 'one' ? g.repeatOne : g.repeat;
  const vizWidth = compact ? 0 : Math.max(0, Math.min(22, width - 46));

  return box(
    { flexDirection: 'row', width },
    text({ color: shuffle ? c.accent : c.textFaint }, ` ${g.shuffle} `),
    text({ color: shuffle ? c.text : c.textFaint }, shuffle ? 'shuffle' : 'in order'),
    text({ color: repeat === 'off' ? c.textFaint : c.accent }, `  ${repeatGlyph} `),
    text(
      { color: repeat === 'off' ? c.textFaint : c.text },
      repeat === 'off' ? 'no repeat' : repeat === 'one' ? 'repeat one' : 'repeat all',
    ),
    text(null, '  '),
    h(VolumeMeter, { theme, volume, width: 8, muted: !canSetVolume }),
    sleepTimer
      ? text({ color: c.warning }, `  ${g.clock} ${Math.ceil(sleepTimer.remainingSeconds / 60)}m`)
      : null,
    vizWidth > 4
      ? box(
          { flexGrow: 1, justifyContent: 'flex-end', flexDirection: 'row' },
          h(Visualizer, { theme, playing, width: vizWidth, mode: visualizerMode, levels }),
        )
      : null,
  );
}

function QueuePreview({ theme, width, upcoming }) {
  const c = theme.colors;
  const g = theme.glyphs;
  const items = upcoming.slice(0, 2);
  return box(
    { flexDirection: 'column', marginTop: 0 },
    ...items.map((item, i) =>
      box(
        { key: item.uid ?? i, flexDirection: 'row' },
        text({ color: c.textFaint }, `   ${i === 0 ? 'next' : '    '} `),
        text({ color: c.textMuted }, truncate(item.track.title, Math.floor(width * 0.4))),
        text({ color: c.textFaint }, ` ${g.dot} ${truncate(item.track.artist, 24)}`),
        item.wrapped ? text({ color: c.textFaint }, `  ${g.repeat}`) : null,
      ),
    ),
  );
}
