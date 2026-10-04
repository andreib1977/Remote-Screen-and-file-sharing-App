/**
 * Language registry shared by the app, the settings layer and the installer integration.
 *
 * The NSIS installer writes the chosen language to the registry; the main process reads it
 * so a fresh install opens in the language that was picked during setup.
 */

import { en } from './en';
import { ro } from './ro';
import type { Translations } from './en';

export const LANGUAGES = ['en', 'ro'] as const;
export type Language = (typeof LANGUAGES)[number];

export const DEFAULT_LANGUAGE: Language = 'en';

/** Registry location written by the installer (HKCU, so no admin rights needed). */
export const LANGUAGE_REGISTRY_KEY = 'Software\\PeerLink';
export const LANGUAGE_REGISTRY_VALUE = 'Language';

export const dictionaries: Record<Language, Translations> = { en, ro };

/** Endonym shown in the language picker ("English", "Română"). */
export const languageNames: Record<Language, string> = {
  en: en.language.name,
  ro: ro.language.name
};

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}

/** Maps anything locale-shaped ("ro-RO", "RO", "ro_MD") onto a supported language. */
export function languageFromLocale(locale: string | undefined | null): Language | null {
  if (!locale) return null;
  const primary = String(locale).toLowerCase().split(/[-_]/)[0];
  return isLanguage(primary) ? primary : null;
}

export type { Translations };
