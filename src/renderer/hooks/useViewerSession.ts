import { useCallback, useEffect, useRef, useState } from 'react';
import { ViewerSession, ViewerState } from '../lib/viewer-session';
import { SignalingClient } from '../lib/signaling-client';
import { TransferRecord } from '../../shared/transfer/manager';
import type { QualitySettings } from '../../shared/protocol';
import type { Toast } from '../ui/Toasts';

export interface ViewerController {
  state: ViewerState;
  transfers: TransferRecord[];
  stream: MediaStream | null;
  connect: (code: string, password: string, options: { wantsControl: boolean; autoAccept: boolean }) => Promise<void>;
  disconnect: () => void;
  requestControl: () => void;
  releaseControl: () => void;
  sendBrowserFiles: (files: FileList | File[]) => Promise<void>;
  sendPaths: (paths: string[]) => Promise<void>;
  setQuality: (patch: Partial<QualitySettings>) => Promise<void>;
  session: ViewerSession | null;
  attach: (signaling: SignalingClient) => void;
}

const initialState: ViewerState = {
  phase: 'idle',
  code: '',
  session: null,
  stats: null,
  controlGranted: false,
  controlRequested: false,
  remoteClipboard: null,
  error: null,
  endReason: null,
  hostConnected: false
};

export function useViewerSession(pushToast: (toast: Omit<Toast, 'id'>) => void, viewerName: string): ViewerController {
  const [state, setState] = useState<ViewerState>(initialState);
  const [transfers, setTransfers] = useState<TransferRecord[]>([]);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const sessionRef = useRef<ViewerSession | null>(null);
  const signalingRef = useRef<SignalingClient | null>(null);
  const toastRef = useRef(pushToast);
  toastRef.current = pushToast;
  const nameRef = useRef(viewerName);
  nameRef.current = viewerName;

  const attach = useCallback((signaling: SignalingClient) => {
    signalingRef.current = signaling;
  }, []);

  const ensureSession = useCallback(() => {
    const signaling = signalingRef.current;
    if (!signaling) return null;
    if (sessionRef.current) return sessionRef.current;
    const session = new ViewerSession(
      signaling,
      {
        state: (next) => setState(next),
        transfers: (list) => setTransfers([...list]),
        toast: (level, text, detail) => toastRef.current({ level, text, detail }),
        stream: (nextStream) => setStream(nextStream)
      },
      nameRef.current
    );
    sessionRef.current = session;
    return session;
  }, []);

  const connect = useCallback(
    async (code: string, password: string, options: { wantsControl: boolean; autoAccept: boolean }) => {
      const session = ensureSession();
      if (!session) return;
      setTransfers([]);
      await session.connect(code, password, options);
    },
    [ensureSession]
  );

  const disconnect = useCallback(() => {
    sessionRef.current?.disconnect();
    setTransfers([]);
  }, []);

  const requestControl = useCallback(() => sessionRef.current?.requestControl(), []);
  const releaseControl = useCallback(() => sessionRef.current?.releaseControl(), []);
  const sendBrowserFiles = useCallback((files: FileList | File[]) => sessionRef.current?.sendBrowserFiles(files) ?? Promise.resolve(), []);
  const sendPaths = useCallback((paths: string[]) => sessionRef.current?.sendPaths(paths) ?? Promise.resolve(), []);
  const setQuality = useCallback((patch: Partial<QualitySettings>) => sessionRef.current?.setQuality(patch) ?? Promise.resolve(), []);

  useEffect(() => {
    return () => {
      sessionRef.current?.disconnect();
      sessionRef.current = null;
    };
  }, []);

  return {
    state,
    transfers,
    stream,
    connect,
    disconnect,
    requestControl,
    releaseControl,
    sendBrowserFiles,
    sendPaths,
    setQuality,
    session: sessionRef.current,
    attach
  };
}
