import { useEffect, useRef } from 'react';
import { api } from '../lib/hooks';
import type { HostController } from './useHostSession';
import type { ViewerController } from './useViewerSession';

interface AutoPilotConfig {
  enabled: boolean;
  role: 'host' | 'viewer';
  clientId: string;
  serverUrl?: string;
  password?: string;
  code?: string;
  sendFile?: string;
  codeFile?: string;
  wantsControl?: boolean;
  quality?: { fps?: number; scale?: number };
}

/**
 * Drives a scripted session for the end-to-end test. Completely inactive unless the app
 * was started with PEERLINK_AUTOPILOT=1.
 */
export function useAutoPilot(args: {
  ready: boolean;
  host: HostController;
  viewer: ViewerController;
  onStartHost: () => Promise<void>;
  signalingStatus?: () => { state: string; url: string; attempt: number; lastError?: string };
  /** invoked once the scripted client identity is known, so the UI can present it */
  onClientId?: (clientId: string) => void;
}): void {
  const configRef = useRef<AutoPilotConfig | null>(null);
  const startedRef = useRef(false);
  const { ready, host, viewer } = args;

  const report = (payload: Record<string, unknown>) => {
    void api()
      .autopilot?.status(payload)
      .catch(() => undefined);
  };

  useEffect(() => {
    void (async () => {
      const config = (await api().autopilot?.config().catch(() => null)) as AutoPilotConfig | null;
      if (!config?.enabled) return;
      configRef.current = config;
      // Scripted runs identify as their client id so the harness can tell peers apart.
      args.onClientId?.(config.clientId);
      report({ role: config.role, clientId: config.clientId, phase: 'boot' });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Report the current phase continuously so the driver can wait on it.
  useEffect(() => {
    const config = configRef.current;
    if (!config) return;
    report({
      role: config.role,
      clientId: config.clientId,
      signal: args.signalingStatus?.() ?? null,
      hostPhase: host.state.phase,
      hostCode: host.state.code,
      hostError: host.state.error,
      hostViewer: host.state.viewer ? host.state.viewer.name : null,
      hostControlGranted: host.state.controlGranted,
      maxViewers: host.state.maxViewers,
      replacedViewers: host.state.replacedViewers,
      hostStats: host.state.stats
        ? { fps: Math.round(host.state.stats.fps), kbps: host.state.stats.bitrateKbps, buffered: host.state.stats.bufferedAmount }
        : null,
      viewerPhase: viewer.state.phase,
      viewerError: viewer.state.error,
      viewerEndReason: viewer.state.endReason,
      viewerHostConnected: viewer.state.hostConnected,
      controlGranted: viewer.state.controlGranted || host.state.controlGranted,
      /** Where the app expects the input helper, and whether it found it. */
      helper: host.state.helper ?? null,
      transfers: [...host.transfers, ...viewer.transfers].map((transfer) => ({
        id: transfer.id,
        name: transfer.meta.name,
        direction: transfer.direction,
        status: transfer.status,
        progress: transfer.progress,
        size: transfer.meta.size,
        savedPath: transfer.savedPath,
        error: transfer.error
      }))
    });
  }, [ready, host.state, viewer.state, host.transfers, viewer.transfers, args.signalingStatus]);

  useEffect(() => {
    const config = configRef.current;
    if (!config || !ready || startedRef.current) return;
    startedRef.current = true;

    void (async () => {
      if (config.role === 'host') {
        await args.onStartHost();
        // Publish the code so the viewer process can pick it up.
        if (config.codeFile) {
          const started = Date.now();
          const waitForCode = async (): Promise<void> => {
            const code = host.state.code;
            if (code) {
              await api().autopilot.writeFile(config.codeFile!, code.replace(/\s/g, ''));
              report({ role: 'host', code: code.replace(/\s/g, ''), phase: 'published-code' });
              return;
            }
            if (Date.now() - started > 30_000) {
              report({ role: 'host', phase: 'code-timeout' });
              return;
            }
            setTimeout(() => void waitForCode(), 250);
          };
          void waitForCode();
        }
        if (config.password) await host.setPassword(config.password);
      } else if (config.role === 'viewer' && config.code && config.password) {
        await viewer.connect(config.code, config.password, { wantsControl: Boolean(config.wantsControl), autoAccept: true });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // Once the session is live, send the configured file (either side can do this).
  const sentRef = useRef(false);
  useEffect(() => {
    const config = configRef.current;
    if (!config?.sendFile || sentRef.current) return;
    if (viewer.state.phase !== 'live' && viewer.state.phase !== 'negotiating') return;
    sentRef.current = true;

    // Poll rather than react: the channels open a few milliseconds after the media
    // connection, and the harness only cares that the send eventually happens.
    void (async () => {
      const deadline = Date.now() + 30_000;
      let ready = false;
      while (Date.now() < deadline) {
        if (viewer.session?.readyForTransfers()) {
          ready = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!ready) {
        report({ role: config.role, phase: 'send-failed', error: 'data channels never opened' });
        return;
      }
      report({ role: config.role, phase: 'sending-file', file: config.sendFile });
      try {
        await viewer.sendPaths([config.sendFile!]);
      } catch (err) {
        report({ role: config.role, phase: 'send-failed', error: err instanceof Error ? err.message : String(err) });
      }
    })();
  }, [viewer.state.phase, viewer.session]);
}
