#!/usr/bin/env node
/**
 * Patches NSIS's Romanian language file.
 *
 * Why this exists: NSIS 3.0.4.1's `Contrib/Language files/Romanian.nsh` defines only 3 of the
 * 5 `MULTIUSER` strings that every other bundled language provides (they were added upstream
 * to the other files but never to Romanian). electron-builder compiles the installer with
 * `/WX`, so each missing string is a hard build failure:
 *
 *   warning: LangString "MULTIUSER_TEXT_INSTALLMODE_TITLE" for language Romanian is missing,
 *            using fallback from "...\English.nsh"
 *   Error: warning treated as error
 *
 * The file lives in electron-builder's cache rather than in this repository, so it is patched
 * here. The patch is:
 *   - idempotent: running it twice changes nothing;
 *   - self-checking: it compares the Romanian file against English.nsh and only adds what is
 *     genuinely absent, so a future NSIS release that fixes this upstream is left alone.
 *
 *   node scripts/patch-nsis-romanian.js
 *
 * `npm run package` runs this before electron-builder. It is also safe to run by hand - it
 * prints what it found and what it did.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const NSIS_CACHE = path.join(os.homedir(), 'AppData', 'Local', 'electron-builder', 'Cache', 'nsis');

/** Romanian text for the strings Romanian.nsh is missing, keyed by NSIS string name. */
const TRANSLATIONS = {
  MULTIUSER_TEXT_INSTALLMODE_TITLE: 'Opțiuni de instalare',
  MULTIUSER_TEXT_INSTALLMODE_SUBTITLE:
    'Alegeți dacă PeerLink este disponibil pentru toți utilizatorii sau doar pentru dvs.',
  MULTIUSER_INNERTEXT_INSTALLMODE_TOP:
    'Selectați dacă doriți să instalați $(^NameDA) doar pentru dvs. sau pentru toți utilizatorii acestui computer. $(^ClickNext)',
  MULTIUSER_INNERTEXT_INSTALLMODE_ALLUSERS: 'Instalează pentru oricine folosește acest computer',
  MULTIUSER_INNERTEXT_INSTALLMODE_CURRENTUSER: 'Instalează doar pentru mine'
};

/** Maps each NSIS string name onto the `!ifdef` guard the language files use. */
const GUARDS = {
  MULTIUSER_TEXT_INSTALLMODE_TITLE: 'MULTIUSER_INSTALLMODEPAGE',
  MULTIUSER_TEXT_INSTALLMODE_SUBTITLE: 'MULTIUSER_INSTALLMODEPAGE',
  MULTIUSER_INNERTEXT_INSTALLMODE_TOP: 'MULTIUSER_INSTALLMODEPAGE',
  MULTIUSER_INNERTEXT_INSTALLMODE_ALLUSERS: 'MULTIUSER_INSTALLMODEPAGE',
  MULTIUSER_INNERTEXT_INSTALLMODE_CURRENTUSER: 'MULTIUSER_INSTALLMODEPAGE'
};

const PATCH_START = '; --- added by PeerLink (scripts/patch-nsis-romanian.js) ---';
const PATCH_END = '; --- end PeerLink patch ---';

const log = (...parts) => process.stdout.write(`[nsis-patch] ${parts.join(' ')}\n`);

function findLanguageDir() {
  if (!fs.existsSync(NSIS_CACHE)) return null;
  for (const version of fs.readdirSync(NSIS_CACHE).filter((name) => name.startsWith('nsis-'))) {
    const dir = path.join(NSIS_CACHE, version, 'Contrib', 'Language files');
    if (fs.existsSync(path.join(dir, 'Romanian.nsh'))) return dir;
  }
  return null;
}

function definedStrings(contents) {
  const names = new Set();
  for (const match of contents.matchAll(/LangFileString\}\s+(\w+)/g)) names.add(match[1]);
  return names;
}

function main() {
  const dir = findLanguageDir();
  if (!dir) {
    log('NSIS cache not found yet - skipping. Package once and re-run to apply.');
    return;
  }

  const romanianPath = path.join(dir, 'Romanian.nsh');
  const englishPath = path.join(dir, 'English.nsh');
  if (!fs.existsSync(englishPath)) {
    log('English.nsh missing - unexpected NSIS layout, skipping.');
    return;
  }

  const original = fs.readFileSync(romanianPath, 'utf8');
  const romanianDefined = definedStrings(original);
  const englishDefined = definedStrings(fs.readFileSync(englishPath, 'utf8'));

  const missing = [...englishDefined].filter((name) => !romanianDefined.has(name));

  if (missing.length === 0) {
    // Nothing missing. If an older patch of ours is still in the file, leave it: it defines
    // strings that are now also defined upstream, and duplicate LangStrings are a warning.
    log('nothing to do - Romanian.nsh already defines every string English.nsh does.');
    return;
  }

  const untranslated = missing.filter((name) => !TRANSLATIONS[name]);
  if (untranslated.length > 0) {
    log(`WARNING: no Romanian text prepared for: ${untranslated.join(', ')}`);
    log('Add them to TRANSLATIONS in this script, or the installer build will keep failing.');
  }

  // Strip any previous patch before re-adding, so repeated runs converge on one block.
  const cleaned = original.replace(new RegExp(`\\n?${PATCH_START}[\\s\\S]*?${PATCH_END}\\n?`, 'g'), '\n');

  const blocks = [];
  for (const group of new Set(missing.map((name) => GUARDS[name] ?? 'MULTIUSER_INSTALLMODEPAGE'))) {
    const names = missing.filter((name) => (GUARDS[name] ?? 'MULTIUSER_INSTALLMODEPAGE') === group && TRANSLATIONS[name]);
    if (names.length === 0) continue;
    blocks.push(
      [`!ifdef ${group}`, ...names.map((name) => `  \${LangFileString} ${name} "${TRANSLATIONS[name]}"`), '!endif'].join('\n')
    );
  }

  const patch = [
    PATCH_START,
    `; NSIS 3.0.4.1's Romanian.nsh is missing these (every other language file has them) and`,
    `; electron-builder compiles with /WX, where a missing LangString is a fatal warning.`,
    ...blocks,
    PATCH_END,
    ''
  ].join('\n');

  fs.writeFileSync(romanianPath, `${cleaned.trimEnd()}\n\n${patch}`, 'utf8');
  log(`patched ${romanianPath}`);
  log(`added ${missing.length} string(s): ${missing.join(', ')}`);
}

main();
