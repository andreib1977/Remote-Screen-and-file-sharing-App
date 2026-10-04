/**
 * React glue: exposes the desktop bridge, session password helpers and small hooks.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PeerLinkApi } from '../../main/preload';

export function api(): PeerLinkApi {
  const bridge = window.peerlink;
  if (!bridge) throw new Error('PeerLink desktop bridge unavailable');
  return bridge;
}

export function useMounted(): () => boolean {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return useCallback(() => mounted.current, []);
}

/** SHA-256 of "peerlink:v1:<password>" - the server only ever compares hashes. */
export async function hashPassword(password: string): Promise<string> {
  const data = new TextEncoder().encode(`peerlink:v1:${password}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Six digits, like a desk phone extension - easy to read out loud. */
export function generatePassword(): string {
  const digits = '0123456789';
  let out = '';
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  for (const byte of bytes) out += digits[byte % 10];
  return out;
}

/** Ticks once per interval so progress bars can recompute rates without extra state. */
export function useTicker(intervalMs = 500): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return tick;
}

export function useCopyToClipboard(): [string | null, (text: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copy = useCallback((text: string) => {
    void api()
      .copyText(text)
      .catch(() => navigator.clipboard?.writeText(text))
      .finally(() => {
        setCopied(text);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(null), 1400);
      });
  }, []);
  return [copied, copy];
}
