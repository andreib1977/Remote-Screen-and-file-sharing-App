#!/usr/bin/env node
/**
 * UI render check.
 *
 * Launches the real app window on screen, screenshots it, and inspects the pixels to prove
 * the interface actually painted: a crashed renderer or a blank window shows up as a flat
 * image, which is exactly the failure this catches in CI-like runs.
 *
 * Runs once per language by seeding settings.json, so a broken translation (missing strings,
 * an over-long label breaking the layout) shows up as a failed render check rather than
 * something only a Romanian speaker would notice.
 *
 *   node scripts/ui-check.js [--lang en,ro]
 */

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);

function readArg(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function log(...parts) {
  process.stdout.write(`[ui] ${parts.join(' ')}\n`);
}

/** Minimal PNG reader: enough to get RGBA pixels out of Chromium's output. */
function readPng(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`unsupported color type ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const rowIn = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const rowOut = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const rawByte = rowIn[x];
      const a = x >= channels ? rowOut[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let value;
      switch (filter) {
        case 0:
          value = rawByte;
          break;
        case 1:
          value = rawByte + a;
          break;
        case 2:
          value = rawByte + b;
          break;
        case 3:
          value = rawByte + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value = rawByte + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`unknown PNG filter ${filter}`);
      }
      rowOut[x] = value & 0xff;
    }
  }

  return { width, height, channels, pixels };
}

function analyze(image) {
  const { width, height, channels, pixels } = image;
  const colors = new Set();
  let sampled = 0;
  let accentPixels = 0;
  let lightPixels = 0;

  for (let y = 0; y < height; y += 3) {
    for (let x = 0; x < width; x += 3) {
      const index = (y * width + x) * channels;
      const r = pixels[index];
      const g = pixels[index + 1];
      const b = pixels[index + 2];
      colors.add((r << 16) | (g << 8) | b);
      sampled++;
      // The "Start sharing" / "Connect" button is the only large blue accent.
      if (b > 140 && b - r > 60 && b - g > 30) accentPixels++;
      // Body text and headings.
      if (r > 190 && g > 200 && b > 210) lightPixels++;
    }
  }

  return {
    width,
    height,
    distinctColors: colors.size,
    sampled,
    accentRatio: accentPixels / sampled,
    lightRatio: lightPixels / sampled
  };
}

async function main() {
  const workDir = path.join(os.tmpdir(), `peerlink-ui-${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });
  const shotBase = path.join(workDir, 'window.png');
  const logFile = path.join(workDir, 'app.log');
  const views = ['connect', 'share', 'settings'];
  const languages = readArg('--lang', 'en,ro').split(',').filter(Boolean);
  const home = path.join(workDir, 'home');
  const problems = [];

  for (const language of languages) {
    // The app reads settings.json before its first paint, so seeding the language here is
    // what makes this a real render check for that language.
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ language }, null, 2), 'utf8');

    const shot = shotBase.replace(/\.png$/, `-${language}.png`);
    const app = spawn(require('electron'), [ROOT], {
      cwd: ROOT,
      env: {
        ...process.env,
        PEERLINK_HOME: home,
        PEERLINK_SHOT: shot,
        PEERLINK_SHOT_DELAY: '6000',
        PEERLINK_SHOT_VIEWS: views.join(','),
        PEERLINK_AUTOPILOT: '1',
        PEERLINK_ROLE: 'host',
        PEERLINK_CLIENT_ID: `ui-check-${language}`,
        PEERLINK_STATUS_FILE: path.join(workDir, `status-${language}.json`),
        PEERLINK_LOG_FILE: logFile,
        PEERLINK_SERVER_URL: 'ws://127.0.0.1:1',
        PEERLINK_NO_LOCAL_SERVER: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    try {
      const expected = views.map((view) => shot.replace(/\.png$/, `-${view}.png`));
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline && !expected.every((file) => fs.existsSync(file))) {
        await new Promise((r) => setTimeout(r, 400));
      }

      const missing = expected.filter((file) => !fs.existsSync(file));
      if (missing.length) {
        problems.push(`${language}: no screenshot for ${missing.map((f) => path.basename(f)).join(', ')}`);
        continue;
      }

      for (let index = 0; index < views.length; index++) {
        const stats = analyze(readPng(expected[index]));
        log(
          `${language}/${views[index]}: ${stats.width}x${stats.height}, ${stats.distinctColors} colours, accent ${(
            stats.accentRatio * 100
          ).toFixed(2)}%, text ${(stats.lightRatio * 100).toFixed(2)}%`
        );
        if (stats.distinctColors < 60) problems.push(`${language}/${views[index]} looks blank (${stats.distinctColors} colours)`);
        if (stats.accentRatio < 0.0002) problems.push(`${language}/${views[index]} has no accent-coloured control`);
        if (stats.lightRatio < 0.0008) problems.push(`${language}/${views[index]} has almost no text pixels`);
      }

      // Regression guard: PEERLINK_SERVER_URL is a throwaway override for this run. It must
      // never be written to the profile, or a test run would permanently point a real
      // installation at a dead address (which is exactly what happened once).
      const settingsPath = path.join(home, 'settings.json');
      const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (saved.serverUrl === 'ws://127.0.0.1:1') {
        problems.push(`${language}: the PEERLINK_SERVER_URL override was persisted to settings.json`);
      }
      if (saved.language !== language) {
        problems.push(`${language}: settings.json language is "${saved.language}"`);
      }
    } catch (err) {
      problems.push(`${language}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      app.kill();
      await new Promise((r) => setTimeout(r, 900));
    }
  }

  if (problems.length) {
    log(`FAIL ${problems.join('; ')}`);
    if (fs.existsSync(logFile)) process.stderr.write(fs.readFileSync(logFile, 'utf8'));
    process.exitCode = 1;
  } else {
    log(`OK  all views rendered in ${languages.join(' + ')}`);
    log(`screenshots: ${workDir}`);
    log('result: PASS');
    process.exitCode = 0;
  }
}

main().catch((err) => {
  process.stderr.write(`[ui] fatal ${err.stack}\n`);
  process.exit(1);
});
