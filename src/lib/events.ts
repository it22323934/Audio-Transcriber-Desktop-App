// Change notifications between TORU's windows. Every write in store.ts emits
// an event; UI hooks re-read whatever they display when one arrives.

export type AppEvent =
  | { type: 'folders' }
  | { type: 'notes'; noteId?: string }
  /** `indexes`: the lines that were added or changed; without it, reload the whole transcript. */
  | { type: 'segments'; noteId: string; indexes?: number[] }
  | { type: 'chunks'; noteId: string }
  | { type: 'messages'; noteId: string }
  | { type: 'recording' }
  | { type: 'settings' }
  /** Input levels (0–1 RMS) of the microphone and the computer's audio. */
  | { type: 'level'; me: number; them: number }
  /** A page showing a level meter says so every couple of seconds; levels only flow while someone watches. */
  | { type: 'level-watch' }
  | { type: 'toast'; message: string; tone?: 'error' | 'info' };

type Listener = (event: AppEvent) => void;

const listeners = new Set<Listener>();
let channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel {
  if (!channel) {
    channel = new BroadcastChannel('toru-desktop-events');
    channel.onmessage = (e: MessageEvent<AppEvent>) => {
      for (const l of listeners) l(e.data);
    };
  }
  return channel;
}

export function emit(event: AppEvent): void {
  getChannel().postMessage(event);
  // BroadcastChannel doesn't echo to the sending context, so notify locally too.
  queueMicrotask(() => {
    for (const l of listeners) l(event);
  });
}

export function subscribe(listener: Listener): () => void {
  getChannel();
  listeners.add(listener);
  return () => listeners.delete(listener);
}
