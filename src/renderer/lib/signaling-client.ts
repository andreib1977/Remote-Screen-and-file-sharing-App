/**
 * Signaling client: the only long-lived connection to the rendezvous server.
 * Everything after the handshake is peer-to-peer.
 */

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export type SignalingEvent =
  | { t: 'hello'; protocol: number; iceServers: IceServerConfig[] }
  /** `maxViewers` is the server's hard per-session peer limit (1 = two devices total). */
  | { t: 'host-ok'; code: string; iceServers: IceServerConfig[]; maxViewers?: number }
  | { t: 'viewer-joined'; viewerName?: string; seq?: number }
  | { t: 'join-failed'; reason: string }
  | { t: 'join-ok'; code: string; hostName?: string; iceServers: IceServerConfig[]; seq?: number; maxViewers?: number }
  | { t: 'viewer-gone'; reason: string; seq?: number }
  | { t: 'host-gone'; reason: string }
  | { t: 'replaced'; reason: string }
  | { t: 'signal'; payload: unknown; seq?: number }
  /** Terminal join errors, surfaced by the server as `error` with a code we care about. */
  | { t: 'no-such-session'; message?: string }
  | { t: 'rate-limited'; message?: string }
  | { t: 'error'; code: string; message: string }
  | { t: 'pong'; seq?: number };

export interface SignalingStatus {
  state: 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';
  url: string;
  attempt: number;
  lastError?: string;
  latencyMs?: number;
}

type StatusListener = (status: SignalingStatus) => void;

export interface SignalingHandlers {
  onEvent: (event: SignalingEvent) => void;
  onStatus: StatusListener;
}

const BACKOFF_MS = [500, 1000, 2000, 3000, 5000, 8000, 13000];

/**
 * Accepts `ws://host:port`, `http://host:port`, `host:port` and anything already ending
 * in a path, and returns the real WebSocket endpoint. People paste all four shapes.
 */
export function normalizeServerUrl(input: string): string {
  const raw = String(input || '').trim();
  if (!raw) return '';
  let candidate = raw;
  if (!/^[a-z]+:\/\//i.test(candidate)) candidate = `ws://${candidate}`;
  try {
    const url = new URL(candidate);
    if (url.protocol === 'http:') url.protocol = 'ws:';
    if (url.protocol === 'https:') url.protocol = 'wss:';
    if (url.pathname === '/' || url.pathname === '') url.pathname = '/ws';
    return url.toString().replace(/\/$/, '');
  } catch {
    return raw;
  }
}

export class SignalingClient {
  private url: string;
  private ws: WebSocket | null = null;
  private queue: string[] = [];
  private attempt = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  private seq = 0;
  private lastPingAt = 0;
  private status: SignalingStatus;

  constructor(url: string, private readonly handlers: SignalingHandlers) {
    this.url = normalizeServerUrl(url);
    this.status = { state: 'idle', url: this.url, attempt: 0 };
  }

  getStatus(): SignalingStatus {
    return { ...this.status };
  }

  private setStatus(patch: Partial<SignalingStatus>): void {
    this.status = { ...this.status, url: this.url, ...patch };
    this.handlers.onStatus(this.getStatus());
  }

  setUrl(url: string): void {
    const normalized = normalizeServerUrl(url);
    if (normalized === this.url) return;
    this.url = normalized;
    this.reconnectNow();
  }

  connect(): void {
    this.closedByUser = false;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;

    this.setStatus({ state: this.attempt > 0 ? 'reconnecting' : 'connecting', attempt: this.attempt });

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch (err) {
      this.setStatus({ state: 'closed', lastError: err instanceof Error ? err.message : String(err) });
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.setStatus({ state: 'open', lastError: undefined, attempt: 0 });
      for (const message of this.queue.splice(0)) {
        try {
          socket.send(message);
        } catch {
          this.queue.push(message);
          break;
        }
      }
      this.startPing();
    };

    socket.onmessage = (ev) => {
      let parsed: SignalingEvent & { t: string };
      try {
        parsed = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (parsed.t === 'pong') {
        const latency = Date.now() - this.lastPingAt;
        this.setStatus({ latencyMs: latency });
      }
      this.handlers.onEvent(parsed);
    };

    socket.onerror = () => {
      this.setStatus({ lastError: `cannot reach ${this.url}` });
    };

    socket.onclose = (ev) => {
      this.stopPing();
      this.ws = null;
      if (this.closedByUser) {
        this.setStatus({ state: 'closed' });
        return;
      }
      this.setStatus({ state: 'closed', lastError: ev.reason || this.status.lastError });
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer) return;
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt++;
    this.setStatus({ state: 'reconnecting', attempt: this.attempt });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private reconnectNow(): void {
    this.closedByUser = false;
    this.attempt = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const old = this.ws;
    this.ws = null;
    if (old) {
      old.onclose = null;
      try {
        old.close();
      } catch {
        /* ignore */
      }
    }
    this.connect();
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.lastPingAt = Date.now();
      this.send({ t: 'ping', seq: ++this.seq });
    }, 15_000);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  send(message: Record<string, unknown>): void {
    const text = JSON.stringify(message);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(text);
        return;
      } catch {
        /* fall through to queue */
      }
    }
    this.queue.push(text);
    if (this.queue.length > 64) this.queue.shift();
    if (!this.ws) this.connect();
  }

  close(): void {
    this.closedByUser = true;
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.ws;
    this.ws = null;
    if (socket) {
      socket.onclose = null;
      try {
        socket.close(1000, 'client closing');
      } catch {
        /* ignore */
      }
    }
    this.setStatus({ state: 'closed' });
  }
}
