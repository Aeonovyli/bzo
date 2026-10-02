#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const controlsPath = path.join(rootDir, 'docs', 'controls.md');
const helpPath = path.join(rootDir, 'public', 'index.html');

function fail(message) {
  console.error(`Controls docs check failed: ${message}`);
  process.exitCode = 1;
}

function assertPatterns(label, content, checks) {
  for (const check of checks) {
    if (!check.pattern.test(content)) {
      fail(`${label} missing ${check.name}`);
    }
  }
}

const controls = fs.readFileSync(controlsPath, 'utf8');
const help = fs.readFileSync(helpPath, 'utf8');

const canonicalChecks = [
  {
    name: 'forward/backward controls (W/S or Up/Down)',
    doc: /W`\s*\/\s*`S`\s*or\s*`Up`\s*\/\s*`Down`/i,
    help: /<strong>W\/S<\/strong>\s*or\s*<strong>Up\/Down<\/strong>/i,
  },
  {
    name: 'turn controls (A/D or Left/Right)',
    doc: /A`\s*\/\s*`D`\s*or\s*`Left`\s*\/\s*`Right`/i,
    help: /<strong>A\/D<\/strong>\s*or\s*<strong>Left\/Right<\/strong>/i,
  },
  {
    name: 'shoot control (Enter)',
    doc: /`Enter` — shoot/i,
    help: /<strong>Enter<\/strong> — Shoot/i,
  },
  {
    name: 'jump control (Tab)',
    doc: /`Tab`/i,
    help: /<strong>Tab<\/strong>/i,
  },
  {
    name: 'drop flag control (Space)',
    doc: /`Space`\s*—\s*drop flag/i,
    help: /<strong>Space<\/strong>\s*—\s*Drop Flag/i,
  },
  {
    name: 'self-destruct control (Delete)',
    doc: /`Delete`\s*—\s*self-destruct/i,
    help: /<strong>Delete<\/strong>\s*—\s*Self-Destruct/i,
  },
  {
    name: 'pause control (P)',
    doc: /`P`\s*—\s*pause/i,
    help: /<strong>P<\/strong>\s*—\s*Pause/i,
  },
  {
    name: 'chat open control (N)',
    doc: /`N`\s*—\s*open chat/i,
    help: /<strong>N<\/strong>\s*—\s*Open Chat/i,
  },
  {
    name: 'voice microphone toggle (B)',
    doc: /`B`\s*—\s*toggle the voice microphone/i,
    help: /<strong>B<\/strong>\s*—\s*<b>Toggle Microphone<\/b>/i,
  },
  {
    name: 'autopilot control (9)',
    doc: /`9`\s*or\s*`\/autopilot/i,
    help: /<strong>9<\/strong>\s*—\s*Autopilot/i,
  },
  {
    name: 'hunt control (U)',
    doc: /`U`\s*—\s*hunt/i,
    help: /<strong>U<\/strong>\s*—\s*Hunt/i,
  },
  {
    name: 'add hunt control (7)',
    doc: /`7`\s*—\s*add hunt/i,
    help: /<strong>7<\/strong>\s*—\s*Add Hunt/i,
  },
  {
    name: 'help toggle control (/ or ?)',
    doc: /`\/`\s*or\s*`\?`\s*—\s*show\/hide help panel/i,
    help: /<strong>\/<\/strong>\s*or\s*<strong>\?<\/strong>\s*—\s*<b>Show\/Hide Help<\/b>/i,
  },
];

assertPatterns(
  'docs/controls.md',
  controls,
  canonicalChecks.map((check) => ({ name: check.name, pattern: check.doc })),
);

assertPatterns(
  'Help panel controls section',
  help,
  canonicalChecks.map((check) => ({ name: check.name, pattern: check.help })),
);

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log('Controls docs check passed');
