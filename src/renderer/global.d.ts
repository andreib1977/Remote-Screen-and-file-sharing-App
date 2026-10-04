import type { PeerLinkApi } from '../../main/preload';

declare global {
  interface Window {
    peerlink: PeerLinkApi;
  }
}

export {};
