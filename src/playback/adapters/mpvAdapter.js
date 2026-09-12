import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { AudioAdapter } from './base.js';
import { PlaybackError } from '../../core/errors.js';
import { clampInt } from '../../core/util.js';
import { probe } from './ffplayAdapter.js';

/**
 * mpv backend - preferred when available.
 *
 * mpv exposes a JSON IPC socket, which gives true pause (no re-buffer), exact
 * seeking, live volume and event-driven end-of-file. One long-lived mpv
 * process is reused across tracks via `loadfile`, so there is never more than
 * one audio process.
 *
 * Install with `brew install mpv`; Termify falls back to ffplay otherwise.
 */
export class MpvAdapter extends AudioAdapter {
  static id = 'mpv';
  static label = 'mpv';

  static isAvailable() {
    return probe('mpv');
  }

  #child = null;
  #socket = null;
  #socketPath;
  #position = 0;
  #volume = 70;
  #requestId = 1;
  #pending = new Map();
  #buffer = '';
  #logger;
  #ready = null;
  #expectingLoad = false;
  #disposed = false;

  constructor({ logger } = {}) {
    super();
    this.#logger = logger ?? null;
    this.#socketPath = path.join(
      os.tmpdir(),
      `termify-mpv-${process.pid}-${crypto.randomBytes(4).toString('hex')}.sock`,
    );
  }

  get capabilities() {
    return { remoteStreams: true, seek: true, volume: true, truePause: true, position: true };
  }

  get position() {
    return this.#position;
  }

  async play(source, { startAt = 0, volume } = {}) {
    if (volume != null) this.#volume = clampInt(volume, 0, 100);
    await this.#ensureProcess();
    this.#position = Math.max(0, startAt);
    this.#expectingLoad = true;
    this.emit('buffering', { buffering: true });
    const options = [`start=${this.#position.toFixed(2)}`, `volume=${this.#volume}`];
    await this.#command(['loadfile', source.value, 'replace', options.join(',')]);
    await this.#command(['set_property', 'pause', false]);
  }

  async pause() {
    if (!this.#socket) return;
    await this.#command(['set_property', 'pause', true]);
  }

  async resume() {
    if (!this.#socket) return;
    await this.#command(['set_property', 'pause', false]);
  }

  async stop() {
    if (!this.#socket) return;
    this.#expectingLoad = false;
    await this.#command(['stop']).catch(() => {});
    this.#position = 0;
  }

  async seek(seconds) {
    const target = Math.max(0, seconds);
    this.#position = target;
    if (!this.#socket) return;
    this.emit('buffering', { buffering: true });
    await this.#command(['seek', target.toFixed(2), 'absolute']).catch(() => {});
  }

  async setVolume(volume) {
    this.#volume = clampInt(volume, 0, 100);
    if (!this.#socket) return;
    await this.#command(['set_property', 'volume', this.#volume]).catch(() => {});
  }

  async #ensureProcess() {
    if (this.#socket) return;
    if (this.#ready) return this.#ready;
    this.#ready = this.#start().finally(() => {
      this.#ready = null;
    });
    return this.#ready;
  }

  async #start() {
    const args = [
      '--idle=yes',
      '--no-video',
      '--no-terminal',
      '--really-quiet',
      `--input-ipc-server=${this.#socketPath}`,
      `--volume=${this.#volume}`,
      '--cache=yes',
      '--user-agent=Termify/1.0',
    ];
    this.#child = spawn('mpv', args, { stdio: 'ignore' });
    this.#child.on('error', (error) => {
      this.emit(
        'error',
        new PlaybackError(`mpv failed to start: ${error.message}`, {
          userMessage: 'Could not start mpv',
          hint: 'Install mpv (brew install mpv) or switch backend in Settings.',
          cause: error,
        }),
      );
    });
    this.#child.on('close', () => {
      this.#child = null;
      this.#socket = null;
      if (!this.#disposed) {
        this.emit(
          'error',
          new PlaybackError('mpv exited unexpectedly', {
            userMessage: 'The audio backend stopped unexpectedly',
            hint: 'Press play again to restart it.',
            retryable: true,
          }),
        );
      }
    });

    await this.#connect();
    await this.#command(['observe_property', 1, 'time-pos']).catch(() => {});
    await this.#command(['observe_property', 2, 'paused-for-cache']).catch(() => {});
  }

  /** mpv creates the socket asynchronously; retry briefly before giving up. */
  async #connect(attempt = 0) {
    if (attempt > 40) {
      throw new PlaybackError('mpv IPC socket never appeared', {
        userMessage: 'Could not talk to mpv',
        hint: 'Switch the audio backend to ffplay in Settings.',
      });
    }
    if (!fs.existsSync(this.#socketPath)) {
      await new Promise((r) => setTimeout(r, 50));
      return this.#connect(attempt + 1);
    }
    await new Promise((resolve, reject) => {
      const socket = net.connect(this.#socketPath);
      socket.once('connect', () => {
        this.#socket = socket;
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => this.#onData(chunk));
        socket.on('error', () => {});
        socket.on('close', () => {
          this.#socket = null;
        });
        resolve();
      });
      socket.once('error', reject);
    }).catch(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return this.#connect(attempt + 1);
    });
  }

  #onData(chunk) {
    this.#buffer += chunk;
    const lines = this.#buffer.split('\n');
    this.#buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.request_id != null && this.#pending.has(message.request_id)) {
        const { resolve, reject } = this.#pending.get(message.request_id);
        this.#pending.delete(message.request_id);
        if (message.error && message.error !== 'success') reject(new Error(message.error));
        else resolve(message.data);
        continue;
      }
      this.#onEvent(message);
    }
  }

  #onEvent(message) {
    if (message.event === 'property-change' && message.name === 'time-pos') {
      if (typeof message.data === 'number') {
        if (this.#expectingLoad) {
          this.#expectingLoad = false;
          this.emit('buffering', { buffering: false });
        }
        this.#position = message.data;
        this.emit('position', { seconds: message.data });
      }
      return;
    }
    if (message.event === 'property-change' && message.name === 'paused-for-cache') {
      this.emit('buffering', { buffering: Boolean(message.data) });
      return;
    }
    if (message.event === 'end-file') {
      this.#expectingLoad = false;
      this.emit('buffering', { buffering: false });
      if (message.reason === 'eof') {
        this.emit('ended', { seconds: this.#position });
      } else if (message.reason === 'error') {
        this.emit(
          'error',
          new PlaybackError(`mpv could not play the file: ${message.file_error ?? 'unknown'}`, {
            userMessage: 'Could not play this track',
            hint: 'The source may be offline. Try another track.',
            retryable: true,
          }),
        );
      }
    }
  }

  #command(command) {
    if (!this.#socket) return Promise.reject(new Error('mpv socket not connected'));
    const id = this.#requestId++;
    const payload = `${JSON.stringify({ command, request_id: id })}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`mpv command timed out: ${command[0]}`));
      }, 5000);
      this.#pending.set(id, {
        resolve: (data) => {
          clearTimeout(timer);
          resolve(data);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#socket.write(payload, (error) => {
        if (error) {
          clearTimeout(timer);
          this.#pending.delete(id);
          reject(error);
        }
      });
    });
  }

  async dispose() {
    this.#disposed = true;
    try {
      await this.#command(['quit']).catch(() => {});
    } finally {
      this.#socket?.destroy();
      this.#socket = null;
      if (this.#child) {
        this.#child.kill('SIGTERM');
        this.#child = null;
      }
      try {
        fs.rmSync(this.#socketPath, { force: true });
      } catch {
        /* best effort */
      }
      this.#logger?.debug('mpv adapter disposed');
      this.removeAllListeners();
    }
  }
}
