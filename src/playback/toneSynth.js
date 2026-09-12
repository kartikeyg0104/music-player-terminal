import { spawn, spawnSync } from 'node:child_process';

/**
 * Generates the short audio files demo mode plays.
 *
 * Demo tracks are synthesised tones, not music - that is the point. They make
 * the whole playback path (spawn, position reporting, auto-advance, errors)
 * genuinely exercisable without a network or any licensed audio.
 */

let available = null;

export function isSynthesisAvailable() {
  if (available != null) return available;
  try {
    const result = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 4000 });
    available = !result.error && result.status === 0;
  } catch {
    available = false;
  }
  return available;
}

/**
 * Render a tone to a WAV file with a short fade in/out so it is not jarring.
 * @param {{outputPath: string, frequency: number, waveform?: 'sine'|'square'|'triangle', seconds?: number}} options
 */
export function synthesiseTone({ outputPath, frequency, waveform = 'sine', seconds = 30 }) {
  const duration = Math.max(3, Math.min(120, Math.round(seconds)));
  const hz = Math.max(40, Math.min(4000, Number(frequency) || 220));
  const shape = ['sine', 'square', 'triangle'].includes(waveform) ? waveform : 'sine';

  // Two detuned voices plus a gentle tremolo, so demo audio is pleasant at
  // low volume rather than a bare test tone.
  const filter = [
    `aevalsrc=0.18*${shapeExpr(shape, hz)}+0.10*${shapeExpr(shape, hz * 1.5)}:d=${duration}:s=44100`,
    'tremolo=f=0.6:d=0.25',
    `afade=t=in:st=0:d=0.6`,
    `afade=t=out:st=${Math.max(0, duration - 0.8)}:d=0.8`,
  ].join(',');

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-filter_complex',
    filter,
    '-ac',
    '1',
    '-ar',
    '44100',
    '-c:a',
    'pcm_s16le',
    outputPath,
  ];

  return new Promise((resolve, reject) => {
    // argv array: nothing here is interpolated into a shell.
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-1000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(outputPath);
      else reject(new Error(`ffmpeg tone synthesis failed (${code}): ${stderr.trim()}`));
    });
  });
}

function shapeExpr(shape, hz) {
  const t = `${hz}*t`;
  if (shape === 'square') return `sgn(sin(2*PI*${t}))`;
  if (shape === 'triangle') return `(2/PI)*asin(sin(2*PI*${t}))`;
  return `sin(2*PI*${t})`;
}

/** Test hook so the mock provider can be exercised without ffmpeg. */
export function __setSynthesisAvailable(value) {
  available = value;
}
