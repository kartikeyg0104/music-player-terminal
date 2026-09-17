import { box, text, h } from '../h.js';
import {
  ListView,
  TrackRow,
  Spinner,
  StatusBlock,
  Divider,
  Badge,
} from '../components/primitives.js';

/**
 * Discover: provider-published sections, genre browsing, and smart playlists
 * built from your own data.
 *
 * Every rail here is backed by something real. If a provider publishes no
 * curated sections the rail is absent - Termify does not invent a "trending"
 * list, and the sections it does show are labelled with the provider's own
 * ordering (e.g. "most downloaded", not "popular").
 */
/** Index of the first entry the cursor may land on. */
export function firstSelectableRailIndex(items) {
  const index = items.findIndex((item) => item.kind !== 'heading');
  return index < 0 ? 0 : index;
}

export function DiscoverView({
  theme,
  width,
  height,
  sections,
  genres,
  smartRecipes,
  smartAvailability,
  activePane,
  sectionCursor,
  resultCursor,
  search,
  favorites,
  currentTrackId,
  provider,
}) {
  const c = theme.colors;
  const g = theme.glyphs;

  const railWidth = Math.min(30, Math.max(18, Math.floor(width * 0.3)));
  const resultWidth = width - railWidth - 3;
  // The results pane carries a left border plus one column of padding.
  const innerWidth = resultWidth - 2;

  const railItems = buildRail({ sections, genres, smartRecipes });

  return box(
    { flexDirection: 'row', width, height },
    // --- left rail ------------------------------------------------------
    box(
      { flexDirection: 'column', width: railWidth, flexShrink: 0 },
      text(
        { color: activePane === 'rail' ? c.textStrong : c.textMuted, bold: true },
        `${activePane === 'rail' ? g.chevron : ' '} Browse`,
      ),
      railItems.length
        ? h(ListView, {
            theme,
            items: railItems,
            selectedIndex: sectionCursor.index,
            height: height - 3,
            focused: activePane === 'rail',
            renderItem: (item, index, selected) => renderRailRow(theme, item, selected, railWidth),
          })
        : h(StatusBlock, {
            theme,
            icon: g.info,
            title: 'Nothing to browse',
            lines: [`${provider?.label ?? 'This provider'} publishes no browsable sections.`],
          }),
    ),
    // A real left border rather than a one-line glyph, so the rule runs the
    // full height of the pane however tall the content is.
    box(
      {
        flexDirection: 'column',
        width: resultWidth,
        borderStyle: theme.unicode ? 'single' : 'classic',
        borderColor: c.line,
        borderTop: false,
        borderBottom: false,
        borderRight: false,
        paddingLeft: 1,
      },
      box(
        { flexDirection: 'row' },
        text(
          { color: activePane === 'results' ? c.textStrong : c.textMuted, bold: true },
          `${activePane === 'results' ? g.chevron : ' '} ${search.sectionId ? titleFor(railItems, search.sectionId) : 'Results'}`,
        ),
        search.isSample ? h(Badge, { theme, label: 'SAMPLE', tone: 'warning' }) : null,
        search.status === 'loading'
          ? box({ marginLeft: 2 }, h(Spinner, { theme, label: 'loading' }))
          : null,
      ),
      search.note ? text({ color: c.textFaint }, ` ${g.info} ${search.note}`) : null,
      h(Divider, { theme, width: innerWidth }),
      renderResults({
        theme,
        search,
        resultCursor,
        resultWidth: innerWidth,
        height: height - 5,
        favorites,
        currentTrackId,
        activePane,
        smartAvailability,
      }),
    ),
  );
}

/**
 * The rail model, shared with `App` so the rendered list and the list the
 * keyboard indexes into can never drift apart.
 * Headings are real entries (they occupy a row) but are not selectable.
 */
export function buildRail({ sections, genres, smartRecipes }) {
  const items = [];
  if (sections.length) {
    items.push({ key: 'h-sections', kind: 'heading', label: 'FROM PROVIDER' });
    for (const section of sections) {
      items.push({
        key: `section:${section.id}`,
        kind: 'section',
        id: section.id,
        label: section.label,
        hint: section.description,
      });
    }
  }
  if (genres.length) {
    items.push({ key: 'h-genres', kind: 'heading', label: 'GENRES' });
    for (const genre of genres.slice(0, 14)) {
      items.push({ key: `genre:${genre.id}`, kind: 'genre', id: genre.id, label: genre.label });
    }
  }
  if (smartRecipes.length) {
    items.push({ key: 'h-smart', kind: 'heading', label: 'FROM YOUR LIBRARY' });
    for (const recipe of smartRecipes) {
      items.push({
        key: `smart:${recipe.id}`,
        kind: 'smart',
        id: recipe.id,
        label: recipe.label,
        hint: recipe.description,
      });
    }
  }
  return items;
}

function renderRailRow(theme, item, selected, width) {
  const c = theme.colors;
  const g = theme.glyphs;
  if (item.kind === 'heading') {
    return text({ color: c.textFaint }, ` ${item.label}`);
  }
  return box(
    { flexDirection: 'row' },
    text({ color: selected ? c.accent : c.textFaint }, selected ? ` ${g.chevron} ` : '   '),
    text(
      { color: selected ? c.textStrong : c.text, bold: selected },
      item.label.slice(0, Math.max(4, width - 5)),
    ),
  );
}

function renderResults({
  theme,
  search,
  resultCursor,
  resultWidth,
  height,
  favorites,
  currentTrackId,
  activePane,
  smartAvailability,
}) {
  const g = theme.glyphs;

  if (search.status === 'idle') {
    return h(StatusBlock, {
      theme,
      icon: g.arrowRight,
      title: 'Pick something on the left',
      lines: [
        'Enter opens a section; tab switches panes.',
        smartAvailability
          ? `Your library: ${smartAvailability.tracks} tracks, ${smartAvailability.favorites} favorites, ${smartAvailability.history} plays recorded.`
          : null,
      ],
    });
  }
  if (search.status === 'error') {
    return h(StatusBlock, {
      theme,
      tone: 'danger',
      icon: g.cross,
      title: search.error?.title ?? 'Could not load',
      lines: [search.error?.hint, 'Press R to retry.'],
    });
  }
  if (search.status === 'loading' && !search.tracks.length) {
    return h(StatusBlock, { theme, icon: g.dot, title: 'Loading...', lines: [] });
  }
  if (!search.tracks.length) {
    return h(StatusBlock, {
      theme,
      icon: g.info,
      title: 'Nothing here',
      lines: [search.note ?? 'This section returned no tracks.'],
    });
  }

  return h(ListView, {
    theme,
    items: search.tracks.map((track) => ({ key: track.id, track })),
    selectedIndex: resultCursor.index,
    height,
    focused: activePane === 'results',
    width: resultWidth,
    renderItem: (item, index, selected) =>
      h(TrackRow, {
        theme,
        track: item.track,
        selected,
        playing: item.track.id === currentTrackId,
        favorite: favorites.has(item.track.id),
        width: resultWidth,
        showProvider: false,
      }),
  });
}

function titleFor(railItems, sectionId) {
  const found = railItems.find((item) => item.id === sectionId);
  return found?.label ?? 'Results';
}
