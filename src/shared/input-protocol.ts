/**
 * Input events sent viewer -> host. Coordinates are normalised (0..1) against the
 * whole virtual desktop so any monitor layout and any remote zoom level works.
 */

export type MouseButton = 'left' | 'right' | 'middle' | 'back' | 'forward';

export type InputCommand =
  | { k: 'move'; x: number; y: number }
  | { k: 'button'; b: MouseButton; down: boolean; clicks?: number }
  | { k: 'wheel'; dx: number; dy: number }
  | { k: 'key'; code: string; vk?: number; down: boolean; repeat?: boolean }
  | { k: 'text'; s: string }
  /** viewer-side paste: put this text on the host clipboard */
  | { k: 'clipboard'; s: string };

/** Keys the viewer forwards even though they are usually handled by the OS/browser. */
export const FORWARDED_CODES = new Set([
  'Escape',
  'Tab',
  'Enter',
  'NumpadEnter',
  'Backspace',
  'Delete',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  'MetaLeft', 'MetaRight',
  'ContextMenu'
]);

/**
 * Decides whether a keydown should be sent to the host instead of being acted on locally.
 * Modifier-only presses are forwarded too, so Ctrl+C on the host works.
 */
export function shouldForwardKey(ev: {
  code: string;
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}): boolean {
  if (ev.code.startsWith('Control') || ev.code.startsWith('Alt') || ev.code.startsWith('Shift')) return true;
  if (FORWARDED_CODES.has(ev.code)) return true;
  if (ev.ctrlKey || ev.altKey || ev.metaKey) return true;
  return false;
}

/**
 * Escape hatch: Ctrl+Alt+Shift+Q always releases the viewer from remote control,
 * even while every other keystroke is being forwarded to the host.
 */
export function isPanicCombo(ev: { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
  return ev.code === 'KeyQ' && ev.ctrlKey && ev.altKey && ev.shiftKey;
}
