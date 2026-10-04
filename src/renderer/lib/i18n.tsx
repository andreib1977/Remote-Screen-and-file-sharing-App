/**
 * React binding for the string dictionaries.
 *
 * `useT()` returns a `t` function scoped to the active language:
 *
 *   const t = useT();
 *   t('share.startSharing')                       // "Start sharing"
 *   t('share.connectedTo', { name, time })        // "Connected to Ana · 4:12"
 */

import { createContext, useCallback, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { dictionaries, type Language } from '../../shared/i18n';
import { format } from '../../shared/i18n/format';

export type Translate = (key: string, values?: Record<string, string | number>) => string;

interface LanguageContextValue {
  language: Language;
  t: Translate;
}

const LanguageContext = createContext<LanguageContextValue>({
  language: 'en',
  t: (key) => key
});

export function LanguageProvider({ language, children }: { language: Language; children: ReactNode }): JSX.Element {
  // Keep the out-of-tree translator in step with the React one.
  setActiveLanguage(language);

  const value = useMemo<LanguageContextValue>(() => {
    const dictionary = dictionaries[language] ?? dictionaries.en;
    const t: Translate = (key, values) => {
      const [section, name] = key.split('.') as [string, string];
      const group = (dictionary as Record<string, Record<string, string>>)[section];
      // Fall back to English rather than showing a raw key if a string is ever missing.
      const template = group?.[name] ?? (dictionaries.en as Record<string, Record<string, string>>)[section]?.[name] ?? key;
      return format(template, values);
    };
    return { language, t };
  }, [language]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useT(): Translate {
  return useContext(LanguageContext).t;
}

export function useLanguage(): Language {
  return useContext(LanguageContext).language;
}

/** Convenience for components that need both. */
export function useTranslation(): LanguageContextValue {
  return useContext(LanguageContext);
}

/** Stable `t` for use inside `useCallback` dependency lists. */
export function useTranslate(): Translate {
  const { t, language } = useContext(LanguageContext);
  return useCallback(t, [language, t]);
}

/**
 * Translation for code that runs outside the React tree.
 *
 * The session classes (`host-session`, `viewer-session`) raise toasts from callbacks and
 * cannot call a hook, so they use this instead. It reads the active language from a
 * module-level value that `LanguageProvider` keeps in sync, which avoids threading a
 * translator through every constructor.
 */
let activeLanguage: Language = 'en';

export function setActiveLanguage(language: Language): void {
  activeLanguage = language;
}

export function translate(key: string, values?: Record<string, string | number>): string {
  const [section, name] = key.split('.') as [string, string];
  const dictionary = dictionaries[activeLanguage] ?? dictionaries.en;
  const group = (dictionary as Record<string, Record<string, string>>)[section];
  const template =
    group?.[name] ?? (dictionaries.en as Record<string, Record<string, string>>)[section]?.[name] ?? key;
  return format(template, values);
}
