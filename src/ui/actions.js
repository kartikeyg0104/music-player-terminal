import { h } from './h.js';
import { ConfirmModal, PromptModal, SelectModal } from './components/Modal.js';
import { toUserMessage } from '../core/errors.js';
import { formatDuration } from '../core/track.js';
import { SLEEP_TIMER_OPTIONS } from './constants.js';

/**
 * Every user-triggered command, in one place.
 *
 * Each action is responsible for: doing the thing, telling the user what
 * happened (a toast), and refreshing derived data. Views and the keymap only
 * call these - they never touch a service - so behaviour stays consistent
 * regardless of which screen a command was issued from.
 */
export function createActions({ container, toast, refresh, setModal, setQuery }) {
  const {
    playback,
    playlists,
    favorites,
    history,
    settings,
    cache,
    artwork,
    registry,
    smartPlaylists,
    search,
  } = container;

  const closeModal = () => setModal(null);

  /** Run something that may throw and turn failures into a toast. */
  const guard = async (fn, context) => {
    try {
      return await fn();
    } catch (error) {
      const message = toUserMessage(error);
      container.logger?.warn(`${context} failed`, { error: error?.message });
      toast.error(message.title, message.hint);
      return null;
    }
  };

  return {
    // ------------------------------------------------------------ playback
    async playTrack(track, list, index) {
      if (!track) return;
      await guard(async () => {
        if (list?.length > 1) await playback.playTracks(list, index);
        else await playback.playTracks([track], 0);
      }, 'play');
    },

    enqueue(track) {
      const added = playback.enqueue(track);
      if (added) toast.success(`Queued "${track.title}"`);
    },

    playNext(track) {
      playback.enqueueNext(track);
      toast.success(`Playing next: "${track.title}"`);
    },

    removeFromQueue(position) {
      const entry = playback.queue.ordered[position];
      if (!entry) return;
      playback.queue.removeAt(position);
      toast.info(`Removed "${entry.track.title}" from the queue`);
    },

    moveQueueItem(from, to, cursor) {
      if (playback.queue.move(from, to)) cursor.setIndex(to);
    },

    confirmClearQueue() {
      const count = playback.queue.length;
      if (!count) return toast.info('The queue is already empty');
      setModal({
        kind: 'confirm',
        title: 'Clear the queue?',
        message: `This removes all ${count} queued track${count === 1 ? '' : 's'} and stops playback.`,
        confirmLabel: 'Clear queue',
        danger: true,
        onConfirm: async () => {
          closeModal();
          await playback.clearQueue();
          toast.info('Queue cleared');
        },
      });
      return undefined;
    },

    openSleepTimer(active) {
      if (active) {
        setModal({
          kind: 'confirm',
          title: 'Cancel the sleep timer?',
          message: `Playback stops in ${Math.ceil(active.remainingSeconds / 60)} minute(s).`,
          confirmLabel: 'Cancel timer',
          onConfirm: () => {
            closeModal();
            playback.cancelSleepTimer();
            toast.info('Sleep timer cancelled');
          },
        });
        return;
      }
      setModal({
        kind: 'select',
        title: 'Sleep timer',
        message: 'Pause playback after:',
        options: SLEEP_TIMER_OPTIONS.map((m) => ({ label: `${m} minutes`, value: m })),
        onSelect: (option) => {
          closeModal();
          playback.startSleepTimer(option.value);
          toast.success(`Sleep timer set for ${option.value} minutes`);
        },
      });
    },

    // ----------------------------------------------------------- favorites
    toggleFavorite(track) {
      if (!track) return;
      const { favorited } = favorites.toggle(track);
      refresh();
      toast.push({
        level: favorited ? 'success' : 'info',
        title: favorited
          ? `Added "${track.title}" to favorites`
          : `Removed "${track.title}" from favorites`,
      });
    },

    // ------------------------------------------------------------ history
    confirmClearHistory() {
      if (!history.count()) return toast.info('There is no history to clear');
      setModal({
        kind: 'confirm',
        title: 'Clear listening history?',
        message: 'This deletes every recorded play and the statistics derived from it.',
        confirmLabel: 'Clear history',
        danger: true,
        onConfirm: () => {
          closeModal();
          const removed = history.clear();
          refresh();
          toast.info(`Cleared ${removed} history entries`);
        },
      });
      return undefined;
    },

    removeHistoryEntry(id) {
      if (history.removeEntry(id)) {
        refresh();
        toast.info('History entry removed');
      }
    },

    // ---------------------------------------------------------- playlists
    promptNewPlaylist() {
      setModal({
        kind: 'prompt',
        title: 'New playlist',
        message: 'Give it a name:',
        placeholder: 'e.g. Late night coding',
        validate: (value) => (value.trim() ? null : 'Name cannot be empty'),
        onSubmit: (value) => {
          closeModal();
          guard(() => {
            const playlist = playlists.create(value);
            refresh();
            toast.success(`Created "${playlist.name}"`);
          }, 'create playlist');
        },
      });
    },

    promptRenamePlaylist(playlist) {
      setModal({
        kind: 'prompt',
        title: 'Rename playlist',
        message: `Currently "${playlist.name}".`,
        initialValue: playlist.name,
        validate: (value) => (value.trim() ? null : 'Name cannot be empty'),
        onSubmit: (value) => {
          closeModal();
          guard(() => {
            playlists.rename(playlist.id, value);
            refresh();
            toast.success('Playlist renamed');
          }, 'rename playlist');
        },
      });
    },

    confirmDeletePlaylist(playlist) {
      setModal({
        kind: 'confirm',
        title: `Delete "${playlist.name}"?`,
        message: `${playlist.trackCount} track${playlist.trackCount === 1 ? '' : 's'} will be removed from this playlist. The tracks themselves stay in your library.`,
        confirmLabel: 'Delete',
        danger: true,
        onConfirm: () => {
          closeModal();
          playlists.remove(playlist.id);
          refresh();
          toast.info(`Deleted "${playlist.name}"`);
        },
      });
    },

    confirmClearPlaylist(playlist) {
      if (!playlist.trackCount) return toast.info('That playlist is already empty');
      setModal({
        kind: 'confirm',
        title: `Empty "${playlist.name}"?`,
        message: 'Every track is removed from the playlist. The playlist itself is kept.',
        confirmLabel: 'Empty it',
        danger: true,
        onConfirm: () => {
          closeModal();
          playlists.clear(playlist.id);
          refresh();
          toast.info('Playlist emptied');
        },
      });
      return undefined;
    },

    promptAddToPlaylist(track) {
      const existing = playlists.list();
      const options = [
        { label: '+ New playlist...', value: '__new__' },
        ...existing.map((p) => ({
          label: p.name,
          value: p.id,
          hint: `${p.trackCount} track${p.trackCount === 1 ? '' : 's'}`,
        })),
      ];
      setModal({
        kind: 'select',
        title: 'Add to playlist',
        message: `"${track.title}" by ${track.artist}`,
        options,
        onSelect: (option) => {
          closeModal();
          if (option.value === '__new__') {
            setModal({
              kind: 'prompt',
              title: 'New playlist',
              message: `It will start with "${track.title}".`,
              validate: (value) => (value.trim() ? null : 'Name cannot be empty'),
              onSubmit: (value) => {
                closeModal();
                guard(() => {
                  const playlist = playlists.create(value);
                  playlists.addTrack(playlist.id, track);
                  refresh();
                  toast.success(`Created "${playlist.name}" with 1 track`);
                }, 'create playlist');
              },
            });
            return;
          }
          guard(() => {
            const result = playlists.addTrack(option.value, track);
            refresh();
            toast.success(
              result.duplicate
                ? `Added again to "${option.label}" (now appears twice)`
                : `Added to "${option.label}"`,
            );
          }, 'add to playlist');
        },
      });
    },

    removeFromPlaylist(playlistId, position, track) {
      if (playlists.removeAt(playlistId, position)) {
        refresh();
        toast.info(`Removed "${track.title}"`);
      }
    },

    movePlaylistTrack(playlistId, from, to, cursor) {
      if (playlists.move(playlistId, from, to)) {
        refresh();
        cursor.setIndex(Math.max(0, to));
      }
    },

    async playPlaylist(playlistId) {
      const tracks = playlists.tracks(playlistId);
      if (!tracks.length) return toast.info('That playlist is empty');
      await guard(() => playback.playTracks(tracks, 0), 'play playlist');
      return undefined;
    },

    queuePlaylist(playlistId) {
      const tracks = playlists.tracks(playlistId);
      if (!tracks.length) return toast.info('That playlist is empty');
      playback.enqueue(tracks);
      toast.success(`Queued ${tracks.length} tracks`);
      return undefined;
    },

    // ------------------------------------------------------------ discover
    async openDiscoverItem(item) {
      if (!item || item.kind === 'heading') return;
      if (item.kind === 'section') {
        await search.loadFeatured(item.id);
        return;
      }
      if (item.kind === 'genre') {
        await search.search({ genre: item.id, text: '' });
        return;
      }
      if (item.kind === 'smart') {
        const result = smartPlaylists.generate(item.id);
        if (!result.available) {
          toast.warn('Not enough data yet', result.reason);
          return;
        }
        setModal({
          kind: 'confirm',
          title: result.label,
          message: `${result.tracks.length} tracks from your own library. Play now, or save as a playlist?`,
          confirmLabel: 'Play now',
          onConfirm: async () => {
            closeModal();
            await playback.playTracks(result.tracks, 0);
          },
          onCancelAction: () => {
            closeModal();
            const saved = smartPlaylists.materialise(item.id);
            if (saved.created) {
              refresh();
              toast.success(`Saved as "${saved.playlist.name}"`);
            }
          },
        });
      }
    },

    // ------------------------------------------------------------ settings
    cycleSetting(key, direction) {
      guard(() => {
        const value = settings.cycle(key, direction);
        if (key === 'audioBackend') toast.info('Audio backend changes apply to the next track');
        if (key === 'defaultProvider') {
          search.reset();
          setQuery('');
          toast.info(`Provider set to ${value}`);
        }
      }, 'change setting');
    },

    promptSetting(spec, value) {
      setModal({
        kind: 'prompt',
        title: spec.label,
        message: spec.description,
        initialValue: String(value ?? ''),
        onSubmit: (next) => {
          closeModal();
          guard(() => {
            settings.set(spec.key, next);
            toast.success(`${spec.label} updated`);
          }, 'change setting');
        },
      });
    },

    chooseSetting(spec, value) {
      setModal({
        kind: 'select',
        title: spec.label,
        message: spec.description,
        options: spec.values.map((v) => ({
          label: v === value ? `${v}  (current)` : v,
          value: v,
        })),
        onSelect: (option) => {
          closeModal();
          guard(() => {
            settings.set(spec.key, option.value);
            if (spec.key === 'defaultProvider') {
              search.reset();
              setQuery('');
            }
            toast.success(`${spec.label}: ${option.value}`);
          }, 'change setting');
        },
      });
    },

    runSettingsAction(id) {
      switch (id) {
        case 'rescan-local': {
          if (!registry.has('local')) return;
          const local = registry.get('local');
          if (!local.status().configured) {
            toast.warn('No local folder set', 'Set "Local music folder" first.');
            return;
          }
          toast.info('Scanning local folder...');
          local
            .rescan()
            .then((count) => toast.success(`Found ${count} local tracks`))
            .catch((error) => {
              const message = toUserMessage(error);
              toast.error(message.title, message.hint);
            });
          return;
        }
        case 'clear-cache': {
          const removed = cache.clear();
          toast.success(`Cleared ${removed} cached responses`);
          return;
        }
        case 'clear-artwork': {
          artwork.clearCache().then((n) => toast.success(`Removed ${n} cached images`));
          return;
        }
        case 'clear-history': {
          setModal({
            kind: 'confirm',
            title: 'Clear listening history?',
            message: 'Every recorded play and all statistics are deleted.',
            confirmLabel: 'Clear history',
            danger: true,
            onConfirm: () => {
              closeModal();
              const removed = history.clear();
              refresh();
              toast.info(`Cleared ${removed} entries`);
            },
          });
          return;
        }
        case 'reset-settings': {
          setModal({
            kind: 'confirm',
            title: 'Reset all settings?',
            message:
              'Every preference returns to its default. Playlists, favorites and history are untouched.',
            confirmLabel: 'Reset',
            danger: true,
            onConfirm: () => {
              closeModal();
              settings.resetAll();
              toast.success('Settings reset to defaults');
            },
          });
          return;
        }
        default:
          toast.warn(`Unknown action: ${id}`);
      }
    },

    // ---------------------------------------------------------------- info
    showTrackInfo(track) {
      const lines = [
        `Artist    ${track.artist}`,
        track.album ? `Album     ${track.album}` : null,
        `Duration  ${formatDuration(track.duration)}`,
        `Provider  ${track.provider}`,
        `Id        ${track.providerId}`,
        track.genre ? `Genre     ${track.genre}` : null,
        track.year ? `Year      ${track.year}` : null,
        track.license ? `License   ${track.license}` : null,
        track.localPath ? `File      ${track.localPath}` : null,
        track.externalUrl ? `Web       ${track.externalUrl}` : null,
        `Status    ${track.availability}${track.isSample ? ' (sample data)' : ''}`,
      ].filter(Boolean);
      setModal({
        kind: 'confirm',
        title: track.title,
        message: lines.join('\n'),
        confirmLabel: 'Close',
        onConfirm: closeModal,
      });
    },

    closeModal,
  };
}

/** Renders whichever dialog is open. */
export function renderModal({ theme, modal, width, setModal }) {
  const close = () => setModal(null);
  switch (modal.kind) {
    case 'confirm':
      return h(ConfirmModal, {
        theme,
        width,
        title: modal.title,
        message: modal.message,
        confirmLabel: modal.confirmLabel,
        danger: modal.danger,
        onConfirm: modal.onConfirm,
        onCancel: modal.onCancelAction ?? close,
      });
    case 'prompt':
      return h(PromptModal, {
        theme,
        width,
        title: modal.title,
        message: modal.message,
        initialValue: modal.initialValue,
        placeholder: modal.placeholder,
        validate: modal.validate,
        onSubmit: modal.onSubmit,
        onCancel: close,
      });
    case 'select':
      return h(SelectModal, {
        theme,
        width,
        title: modal.title,
        message: modal.message,
        options: modal.options,
        onSelect: modal.onSelect,
        onCancel: close,
      });
    default:
      return null;
  }
}
