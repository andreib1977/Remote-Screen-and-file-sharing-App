import { useCallback, useEffect, useRef, useState } from 'react';
import { HostSession, HostState, HostConfig, initialState as initialHostState } from '../lib/host-session';
import { SignalingClient } from '../lib/signaling-client';
import { TransferRecord } from '../../shared/transfer/manager';
import { api } from '../lib/hooks';
import type { MonitorInfo, QualitySettings } from '../../shared/protocol';
import type { Toast } from '../ui/Toasts';

export interface HostController {
  state: HostState;
  transfers: TransferRecord[];
  monitors: MonitorInfo[];
  /** which display is currently being shared */
  activeMonitorId: string;
  quality: QualitySettings;
  start: (config?: Partial<HostConfig>) => Promise<void>;
  stop: () => void;
  grantControl: () => void;
  denyControl: () => void;
  sendPaths: (paths: string[]) => Promise<void>;
  switchMonitor: (id: string) => Promise<void>;
  setQuality: (patch: Partial<QualitySettings>) => Promise<void>;
  setPassword: (password: string) => Promise<void>;
  setAllowRemoteInput: (allow: boolean) => Promise<void>;
  session: HostSession | null;
  /** set by the app so the host knows where to report events */
  attach: (signaling: SignalingClient) => void;
}

export function useHostSession(pushToast: (toast: Omit<Toast, 'id'>) => void, onRemoteClipboard: (text: string) => void): HostController {
  const [state, setState] = useState<HostState>({ ...initialHostState });
  const [transfers, setTransfers] = useState<TransferRecord[]>([]);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [activeMonitorId, setActiveMonitorId] = useState('');
  const [quality, setQualityState] = useState<QualitySettings>({ fps: 30, quality: 0.8, scale: 1, audio: false });
  const sessionRef = useRef<HostSession | null>(null);
  const signalingRef = useRef<SignalingClient | null>(null);
  const toastRef = useRef(pushToast);
  toastRef.current = pushToast;
  const clipboardRef = useRef(onRemoteClipboard);
  clipboardRef.current = onRemoteClipboard;

  const attach = useCallback((signaling: SignalingClient) => {
    signalingRef.current = signaling;
  }, []);

  const start = useCallback(
    async (config?: Partial<HostConfig>) => {
      const signaling = signalingRef.current;
      if (!signaling) return;
      if (sessionRef.current) return;

      const { displays } = await api().listDisplays();
      const monitorList: MonitorInfo[] = displays.map((d) => ({
        id: d.id,
        label: d.label,
        width: d.width,
        height: d.height,
        primary: d.primary
      }));
      setMonitors(monitorList);
      setActiveMonitorId((current) => current || monitorList.find((m) => m.primary)?.id || monitorList[0]?.id || '');

      const session = new HostSession(
        signaling,
        {
          allowRemoteInput: config?.allowRemoteInput ?? false,
          autoAcceptFiles: config?.autoAcceptFiles ?? true,
          quality: config?.quality ?? quality,
          monitors: monitorList,
          password: config?.password ?? '',
          displayName: config?.displayName ?? '',
          audio: config?.quality?.audio ?? quality.audio
        },
        {
          state: (next) => setState(next),
          transfers: (list) => setTransfers([...list]),
          toast: (level, text, detail) => toastRef.current({ level, text, detail }),
          remoteClipboard: (text) => clipboardRef.current(text)
        }
      );
      sessionRef.current = session;
      await session.start({ ...config, monitors: monitorList });
      attach(signaling);
    },
    [attach, quality]
  );

  const stop = useCallback(() => {
    sessionRef.current?.stop();
    sessionRef.current = null;
    setTransfers([]);
  }, []);

  useEffect(() => {
    return () => {
      sessionRef.current?.stop();
      sessionRef.current = null;
    };
  }, []);

  const grantControl = useCallback(() => void sessionRef.current?.grantControl(), []);
  const denyControl = useCallback(() => sessionRef.current?.denyControl(), []);
  const sendPaths = useCallback((paths: string[]) => sessionRef.current?.sendPaths(paths) ?? Promise.resolve(), []);
  const switchMonitor = useCallback(async (id: string) => {
    setActiveMonitorId(id);
    await sessionRef.current?.switchMonitor(id);
  }, []);
  const setQuality = useCallback(
    async (patch: Partial<QualitySettings>) => {
      setQualityState((prev) => ({ ...prev, ...patch }));
      await sessionRef.current?.setQuality(patch);
    },
    []
  );
  const setPassword = useCallback((password: string) => sessionRef.current?.setPassword(password) ?? Promise.resolve(), []);
  const setAllowRemoteInput = useCallback(
    (allow: boolean) => sessionRef.current?.setAllowRemoteInput(allow) ?? Promise.resolve(),
    []
  );

  return {
    state,
    transfers,
    monitors,
    activeMonitorId,
    quality,
    start,
    stop,
    grantControl,
    denyControl,
    sendPaths,
    switchMonitor,
    setQuality,
    setPassword,
    setAllowRemoteInput,
    session: sessionRef.current,
    attach
  };
}
