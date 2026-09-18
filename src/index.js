#!/usr/bin/env node
import process from 'node:process';
import { render } from 'ink';
import { h } from './ui/h.js';
import { App } from './ui/App.js';
import { createContainer } from './container.js';
import { detectCapabilities } from './ui/theme.js';
import { runDoctor } from './doctor.js';
import { VERSION } from './ui/constants.js';
import { toUserMessage } from './core/errors.js';

/**
 * Entry point and process lifecycle.
 *
 * Responsibilities kept deliberately narrow: parse flags, build the
 * container, mount Ink, and guarantee exactly one clean shutdown path no
 * matter how the process is asked to stop. Anything that touches the terminal
 * outside Ink's control happens here and nowhere else.
 */

const USAGE = `
termify ${VERSION} - your music, your terminal

  termify                 start the player
  termify --demo          start with built-in sample data (no network, no keys)
  termify --doctor        check the environment and exit
  termify --provider ID   start on a specific provider (archive|jamendo|local|mock)
  termify --data-dir DIR  use a different data directory
  termify --version       print the version
  termify --help          show this

Environment variables are documented in .env.example.
`;

function parseArgs(argv) {
  const args = { demo: false, doctor: false, provider: null, dataDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--demo') args.demo = true;
    else if (arg === '--doctor') args.doctor = true;
    else if (arg === '--provider') args.provider = argv[++i] ?? null;
    else if (arg === '--data-dir') args.dataDir = argv[++i] ?? null;
    else if (arg === '--version' || arg === '-v') args.version = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else args.unknown = arg;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (args.unknown) {
    process.stderr.write(`termify: unknown option "${args.unknown}"\n${USAGE}`);
    return 2;
  }
  if (args.doctor) {
    return runDoctor({ dataDir: args.dataDir });
  }

  let container;
  try {
    container = await createContainer({ demo: args.demo, dataDir: args.dataDir });
  } catch (error) {
    const message = toUserMessage(error);
    process.stderr.write(`termify: ${message.title}\n`);
    if (message.hint) process.stderr.write(`  ${message.hint}\n`);
    return 1;
  }

  if (args.provider) {
    try {
      container.settings.set('defaultProvider', args.provider);
    } catch {
      process.stderr.write(`termify: unknown provider "${args.provider}"\n`);
      await container.dispose();
      return 2;
    }
  }

  container.capabilities = detectCapabilities(process.stdout, process.env);

  if (!process.stdout.isTTY) {
    process.stderr.write(
      'termify: this is a full-screen terminal app and needs a TTY.\n' +
        '  Run it directly in a terminal, or use `termify --doctor` for a non-interactive check.\n',
    );
    await container.dispose();
    return 1;
  }

  // ---------------------------------------------------------- lifecycle
  let shuttingDown = false;
  let instance = null;

  /**
   * The single shutdown path. Unmounting Ink restores the alternate screen,
   * the cursor and raw mode; disposing the container stops audio, kills child
   * processes and closes the database. Guarded so a SIGINT racing a `q` press
   * cannot run it twice.
   */
  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      instance?.unmount();
    } catch {
      /* already unmounted */
    }
    try {
      await container.dispose();
    } catch (error) {
      container.logger?.error('shutdown error', { message: error?.message });
    }
    process.exitCode = code;
  };

  const onSignal = (signal) => {
    container.logger?.info('received signal', { signal });
    shutdown(0).then(() => {
      // Give Ink one tick to flush its final frame before the process ends.
      setTimeout(() => process.exit(process.exitCode ?? 0), 30).unref();
    });
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);

  // A thrown error must never leave the terminal in the alternate screen.
  process.on('uncaughtException', (error) => {
    container.logger?.error('uncaught exception', { message: error.message, stack: error.stack });
    shutdown(1).then(() => {
      process.stderr.write(`termify crashed: ${error.message}\n`);
      if (container.logger?.file) {
        process.stderr.write(`Details in ${container.logger.file}\n`);
      }
      process.exit(1);
    });
  });
  process.on('unhandledRejection', (reason) => {
    container.logger?.error('unhandled rejection', { reason: String(reason) });
  });

  instance = render(h(App, { container, onExit: () => shutdown(0) }), {
    exitOnCtrlC: false, // handled in App so cleanup runs first
    patchConsole: true, // stray console output must not corrupt the frame
  });

  await instance.waitUntilExit();
  await shutdown(process.exitCode ?? 0);
  return process.exitCode ?? 0;
}

main()
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((error) => {
    process.stderr.write(`termify: fatal: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
