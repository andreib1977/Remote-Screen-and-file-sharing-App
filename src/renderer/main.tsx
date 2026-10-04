import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { LanguageProvider } from './lib/i18n';
import { api } from './lib/hooks';
import { DEFAULT_LANGUAGE, isLanguage, type Language } from '../shared/i18n';
import './styles.css';

/**
 * The language has to be known before the first paint, so settings are read here rather than
 * inside `App`: otherwise the UI would flash English while the file loads and then swap to
 * Romanian.
 */
function Root(): JSX.Element {
  const [language, setLanguage] = useState<Language | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const settings = await api().getSettings();
        if (!cancelled) setLanguage(isLanguage(settings.language) ? settings.language : DEFAULT_LANGUAGE);
      } catch {
        if (!cancelled) setLanguage(DEFAULT_LANGUAGE);
      }
    })();

    // Settings dispatches this when the user picks another language, so the tree
    // re-renders without a reload.
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ language?: string }>).detail;
      if (isLanguage(detail?.language)) setLanguage(detail.language);
    };
    window.addEventListener('peerlink:language', onChanged);
    return () => {
      cancelled = true;
      window.removeEventListener('peerlink:language', onChanged);
    };
  }, []);

  if (!language) return <div className="boot">…</div>;

  return (
    <LanguageProvider language={language}>
      <App />
    </LanguageProvider>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('#root missing');
createRoot(container).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
