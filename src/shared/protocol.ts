/**
 * PeerLink wire protocol.
 *
 * `ctl` channel: JSON text messages (typed below).
 * `file` channel: framed binary chunks (see ./transfer/framing.ts).
 */

import type { InputCommand } from './input-protocol';

export const PROTOCOL_VERSION = 1;
/**
 * Payload size per data-channel message.
 *
 * This is deliberately modest: Chromium caps SCTP messages (typically 256 KiB), and a
 * frame that exceeds that limit makes the whole channel fail with "Failure to send
 * data". 64 KiB is the long-standing portable ceiling, and throughput comes from
 * pipelining these frames rather than from making each one huge.
 */
export const CHUNK_SIZE = 64 * 1024;
/**
 * How many bytes may sit in the transport buffer before the sender waits.
 *
 * Tuned empirically against the real data channel: 8 MiB (~128 frames) sustains the link
 * without triggering drops, while keeping memory flat regardless of file size. Larger
 * windows looked faster in theory but produced chunk gaps in practice.
 */
export const MAX_IN_FLIGHT_BYTES = 8 * 1024 * 1024;
export const MAX_CONCURRENT_FILES = 3;

export interface FileMeta {
  id: string;
  name: string;
  size: number;
  mime: string;
  /** milliseconds since epoch, informational only */
  mtime?: number;
  /** set when the file came from a folder drop */
  relativePath?: string;
}

export interface MonitorInfo {
  id: string;
  label: string;
  width: number;
  height: number;
  primary: boolean;
}

export interface SessionInfo {
  hostName: string;
  appVersion: string;
  platform: string;
  monitors: MonitorInfo[];
  /** virtual desktop geometry in physical pixels, matching desktopCapturer */
  desktop: { x: number; y: number; width: number; height: number };
  canControl: boolean;
  inputHelperReady: boolean;
  allowRemoteInput: boolean;
  quality: QualitySettings;
}

export interface QualitySettings {
  /** capture frame rate ceiling */
  fps: number;
  /** JPEG-ish quality hint for the browser encoder (0..1) */
  quality: number;
  /** scale factor applied to the captured frame, 1 = native resolution */
  scale: number;
  /** capture system audio (loopback) and forward it to the viewer */
  audio: boolean;
}

export const DEFAULT_QUALITY: QualitySettings = { fps: 30, quality: 0.8, scale: 1, audio: false };

export type HostToViewer =
  | { t: 'session'; info: SessionInfo }
  | { t: 'quality'; quality: QualitySettings }
  | { t: 'control-state'; granted: boolean; reason?: string }
  | { t: 'clipboard'; text: string; from: 'host' | 'viewer' }
  | { t: 'chat'; text: string; at: number }
  | { t: 'notice'; level: 'info' | 'warn' | 'error'; text: string }
  | { t: 'file-offer'; file: FileMeta }
  | { t: 'file-accept'; id: string; resumeAt?: number }
  | { t: 'file-reject'; id: string; reason: string }
  | { t: 'file-progress'; id: string; received: number }
  | { t: 'file-done'; id: string; savedPath?: string; ok: boolean; error?: string }
  | { t: 'file-cancel'; id: string; by: 'host' | 'viewer' }
  | { t: 'file-resume-request'; id: string; have: number }
  | { t: 'pong'; seq: number }
  | { t: 'ping'; seq: number };

export type ViewerToHost =
  | { t: 'hello'; viewerName: string; appVersion: string; platform: string; wantsControl: boolean; wantAudio: boolean }
  | { t: 'request-control' }
  | { t: 'release-control' }
  | { t: 'input'; cmd: InputCommand }
  | { t: 'clipboard'; text: string; from: 'host' | 'viewer' }
  | { t: 'chat'; text: string; at: number }
  | { t: 'set-quality'; quality: Partial<QualitySettings> }
  | { t: 'file-offer'; file: FileMeta }
  | { t: 'file-accept'; id: string; resumeAt?: number }
  | { t: 'file-reject'; id: string; reason: string }
  | { t: 'file-progress'; id: string; received: number }
  | { t: 'file-done'; id: string; savedPath?: string; ok: boolean; error?: string }
  | { t: 'file-cancel'; id: string; by: 'host' | 'viewer' }
  | { t: 'file-resume-request'; id: string; have: number }
  | { t: 'pong'; seq: number }
  | { t: 'ping'; seq: number };

export type CtlMessage = HostToViewer | ViewerToHost;

/** Messages that carry a file payload on the `file` channel. */
export interface TransferInit {
  id: string;
  name: string;
  size: number;
  mime: string;
  relativePath?: string;
  from: 'host' | 'viewer';
}
