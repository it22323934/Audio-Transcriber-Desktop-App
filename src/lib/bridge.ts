// The main-process bridge, as seen from a TORU window (see shared/bridge.ts).
import type { ToruBridge } from '../shared/bridge';

declare global {
  interface Window {
    toru: ToruBridge;
  }
}

export const bridge: ToruBridge = window.toru;
