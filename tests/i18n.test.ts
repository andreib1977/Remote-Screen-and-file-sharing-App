/**
 * Translation integrity.
 *
 * `ro.ts` is typed as `Translations`, so TypeScript already fails the build on a missing
 * section. These tests cover what the type system cannot see: string-level gaps, broken
 * placeholders, and strings that were copied from English and never actually translated.
 */

import { describe, expect, it } from 'vitest';
import { en } from '../src/shared/i18n/en';
import { ro } from '../src/shared/i18n/ro';
import { LANGUAGES, dictionaries, languageFromLocale, isLanguage, languageNames } from '../src/shared/i18n';
import { format } from '../src/shared/i18n/format';

type Dict = Record<string, Record<string, string>>;

const sections = Object.keys(en) as (keyof typeof en)[];

describe('translation dictionaries', () => {
  it('uses the same section keys in both languages', () => {
    expect(Object.keys(ro).sort()).toEqual(Object.keys(en).sort());
  });

  it('has a Romanian string for every English key', () => {
    const missing: string[] = [];
    for (const section of sections) {
      const english = en[section] as Record<string, string>;
      const romanian = (ro as unknown as Dict)[section] ?? {};
      for (const key of Object.keys(english)) {
        if (!romanian[key] || romanian[key].trim() === '') missing.push(`${section}.${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('uses the same placeholders in both languages', () => {
    const placeholders = (value: string) => (value.match(/\{(\w+)\}/g) ?? []).sort();
    const mismatches: string[] = [];
    for (const section of sections) {
      const english = en[section] as Record<string, string>;
      const romanian = (ro as unknown as Dict)[section] ?? {};
      for (const key of Object.keys(english)) {
        const expected = placeholders(english[key]);
        const actual = placeholders(romanian[key] ?? '');
        if (JSON.stringify(expected) !== JSON.stringify(actual)) {
          mismatches.push(`${section}.${key}: en=${expected.join(',')} ro=${actual.join(',')}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('actually translates the user-visible headline strings', () => {
    // A handful of strings that would be glaring if left in English.
    const mustDiffer = [
      'tabs.connect',
      'tabs.share',
      'tabs.settings',
      'share.startSharing',
      'share.stopSharing',
      'connect.title',
      'connect.password',
      'viewer.requestControl',
      'settings.files',
      'settings.languageSection',
      'transfers.title'
    ];
    for (const path of mustDiffer) {
      const [section, key] = path.split('.') as [keyof typeof en, string];
      const english = (en[section] as Record<string, string>)[key];
      const romanian = (ro as unknown as Dict)[section]?.[key];
      expect(romanian, path).not.toBe(english);
    }
  });

  it('does not leak untranslated English words into Romanian sentences', () => {
    // Braces and product names are fine; whole English words are not. Checked against a
    // small list of words that must never appear verbatim in a Romanian string.
    const forbidden = ['the ', ' and ', ' with ', 'Sharing', 'Settings', 'Connect to', 'File transfer'];
    const offenders: string[] = [];
    for (const section of sections) {
      const romanian = (ro as unknown as Dict)[section] ?? {};
      for (const [key, value] of Object.entries(romanian)) {
        for (const word of forbidden) {
          if (value.includes(word)) offenders.push(`${section}.${key} contains "${word}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('language helpers', () => {
  it('recognises supported and unsupported tags', () => {
    expect(isLanguage('en')).toBe(true);
    expect(isLanguage('ro')).toBe(true);
    expect(isLanguage('de')).toBe(false);
    expect(isLanguage(undefined)).toBe(false);
  });

  it('maps Windows/BCP-47 locales onto a supported language', () => {
    expect(languageFromLocale('ro-RO')).toBe('ro');
    expect(languageFromLocale('ro')).toBe('ro');
    expect(languageFromLocale('en-GB')).toBe('en');
    expect(languageFromLocale('de-DE')).toBeNull();
    expect(languageFromLocale('')).toBeNull();
    expect(languageFromLocale(null)).toBeNull();
  });

  it('has a dictionary and a display name for every supported language', () => {
    for (const language of LANGUAGES) {
      expect(dictionaries[language], language).toBeTruthy();
      expect(languageNames[language], language).toBeTruthy();
    }
    expect(languageNames.ro).toBe('Română');
  });
});

describe('string interpolation', () => {
  it('fills placeholders', () => {
    expect(format('{count} active', { count: 3 })).toBe('3 active');
    expect(format('{width}×{height}', { width: 1920, height: 1080 })).toBe('1920×1080');
  });

  it('leaves unknown placeholders visible instead of printing undefined', () => {
    expect(format('{missing} left', {})).toBe('{missing} left');
  });

  it('returns the template untouched when there is nothing to substitute', () => {
    expect(format('simple')).toBe('simple');
  });
});
