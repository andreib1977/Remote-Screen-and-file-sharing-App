/**
 * Screen capture (host side) and remote input capture (viewer side).
 */

import type { PeerLinkApi } from '../../main/preload';

const api = (): PeerLinkApi => {
  const bridge = (window as unknown as { peerlink?: PeerLinkApi }).peerlink;
  if (!bridge) throw new Error('PeerLink desktop bridge unavailable');
  return bridge;
};

export interface CaptureOptions {
  /** desktopCapturer source id; omit for the primary screen */
  sourceId?: string;
  fps: number;
  /** 1 = native resolution, 0.5 = half, ... */
  scale: number;
  audio: boolean;
}

export interface CaptureResult {
  stream: MediaStream;
  settings: MediaTrackSettings;
  audioActive: boolean;
}

/**
 * Capture the desktop through Electron's display-media handler.
 *
 * `navigator.mediaDevices.getDisplayMedia()` is the supported route on Electron 32+:
 * the legacy `getUserMedia({ chromeMediaSource: 'desktop' })` path now ends in a
 * Chromium CHECK failure (STATE_PENDING_APPROVAL with no picker). The main process's
 * `setDisplayMediaRequestHandler` decides which screen is handed over, so the user
 * never sees Chrome's own picker.
 */
export async function startCapture(options: CaptureOptions): Promise<CaptureResult> {
  const trace = (message: string) => {
    void api()
      .autopilot?.log(`capture: ${message}`)
      .catch(() => undefined);
  };

  trace(`prepare source=${options.sourceId ?? '(primary)'} audio=${options.audio} fps=${options.fps}`);
  await api().prepareCapture({ sourceId: options.sourceId, audio: options.audio });

  trace('requesting display media');
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: options.fps } as MediaTrackConstraints,
      audio: options.audio
    });
    trace('getDisplayMedia resolved');
  } catch (err) {
    trace(`getDisplayMedia rejected: ${err instanceof Error ? `${err.name} ${err.message}` : String(err)}`);
    stream = await legacyDesktopCapture(options, trace);
  }

  const track = stream.getVideoTracks()[0];
  if (track) {
    try {
      await track.applyConstraints({ frameRate: options.fps } as MediaTrackConstraints);
    } catch {
      /* frame rate is a hint; ignore */
    }
  }

  if (options.scale && options.scale < 1 && track) {
    const settings = track.getSettings();
    if (settings.width && settings.height) {
      try {
        await track.applyConstraints({
          width: Math.round(settings.width * options.scale),
          height: Math.round(settings.height * options.scale)
        } as MediaTrackConstraints);
      } catch {
        /* scaling is a hint; ignore */
      }
    }
  }

  const audioActive = stream.getAudioTracks().length > 0;
  return { stream, settings: track ? track.getSettings() : {}, audioActive };
}

export function stopStream(stream: MediaStream | null): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Last-resort capture path for builds where `getDisplayMedia` is unavailable. Kept
 * deliberately defensive: it must never take the whole app down with it.
 */
async function legacyDesktopCapture(options: CaptureOptions, trace: (message: string) => void): Promise<MediaStream> {
  const mandatory: Record<string, string | number> = { chromeMediaSource: 'desktop' };
  if (options.sourceId) mandatory.chromeMediaSourceId = options.sourceId;
  if (options.fps > 0) mandatory.maxFrameRate = options.fps;
  trace(`legacy getUserMedia fallback ${JSON.stringify(mandatory)}`);
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    video: { ...({ mandatory } as any) } as MediaTrackConstraints
  });
}

/**
 * Maps a pointer position inside a letterboxed <video> to normalised desktop
 * coordinates (0..1) over the whole remote virtual desktop.
 */
export function toDesktopCoords(
  video: HTMLVideoElement,
  clientX: number,
  clientY: number
): { x: number; y: number } | null {
  const rect = video.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const videoAspect = (video.videoWidth || 16) / (video.videoHeight || 9);
  const boxAspect = rect.width / rect.height;

  let drawWidth = rect.width;
  let drawHeight = rect.height;
  let offsetX = 0;
  let offsetY = 0;

  if (boxAspect > videoAspect) {
    // pillarboxed: content is narrower than the box
    drawWidth = rect.height * videoAspect;
    offsetX = (rect.width - drawWidth) / 2;
  } else if (boxAspect < videoAspect) {
    // letterboxed: content is shorter than the box
    drawHeight = rect.width / videoAspect;
    offsetY = (rect.height - drawHeight) / 2;
  }

  const x = (clientX - rect.left - offsetX) / drawWidth;
  const y = (clientY - rect.top - offsetY) / drawHeight;
  if (x < -0.02 || x > 1.02 || y < -0.02 || y > 1.02) return null;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}
