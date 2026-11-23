// The contract between Electron's main process and TORU's windows. The preload
// script implements ToruBridge on window.toru; the renderer only ever talks to
// the main process through it. This file holds types and constants only, so
// both sides can import it.
import type { AudioSources, RecordingState } from '../lib/types';

/** Commands for the hidden recorder window, relayed by the main process. */
export type RecorderCommand =
  | { type: 'START'; folderId?: string; sources?: AudioSources; app?: string; title?: string }
  | { type: 'STOP' }
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  | { type: 'STATUS' }
  /** TORU is quitting: stop capturing and keep the unsent audio for the next start. */
  | { type: 'QUIT' };

export interface RecorderReply {
  ok: boolean;
  error?: string;
  noteId?: string;
  recording?: boolean;
  /** Still transcribing or writing notes for a meeting that has ended. */
  busy?: boolean;
}

/** Settings the main process acts on (tray, meeting detection, widget, login item). */
export interface MainPrefs {
  detectMeetings: boolean;
  autoStop: boolean;
  widget: boolean;
  openAtLogin: boolean;
}

/** What the floating widget shows. */
export type WidgetState =
  | { mode: 'hidden' }
  /** A meeting is being recorded. */
  | { mode: 'recording' }
  /** A call app started using the microphone: offer to take notes. */
  | { mode: 'prompt'; app: string }
  /** The call app let go of the microphone: stopping at `until` unless the user keeps going. */
  | { mode: 'ending'; app: string; until: number }
  /** The recording just stopped. */
  | { mode: 'done'; noteId: string };

export type WidgetAction =
  | { type: 'start' }
  | { type: 'dismiss' }
  | { type: 'keep-going' }
  | { type: 'open-note'; noteId: string }
  | { type: 'size'; height: number };

export interface ToruBridge {
  env: {
    /** OpenAI API base URL (overridden in tests). */
    openaiBase: string;
    /** Running under the end-to-end tests. */
    test: boolean;
    platform: string;
    version: string;
  };
  recorder: {
    /** Sends a command to the recorder window and waits for its reply. */
    call(cmd: RecorderCommand): Promise<RecorderReply>;
    /** Recorder window only: tells the main process it can take commands. */
    ready(): void;
    /** Recorder window only: the live recording changed (null when idle). */
    publish(state: RecordingState | null): void;
  };
  secrets: {
    getApiKey(): Promise<string>;
    setApiKey(key: string): Promise<void>;
  };
  app: {
    /** Brings the main window forward, optionally at a route like "/note/<id>". */
    show(route?: string): void;
    onNavigate(listener: (route: string) => void): () => void;
    /**
     * Keeps the window's title-bar buttons in the page's colours. `titleBar`
     * overrides the buttons' background (e.g. dimmed while a dialog is open).
     */
    setTheme(theme: { dark: boolean; background: string; text: string; titleBar?: string }): void;
    syncPrefs(prefs: MainPrefs): void;
    openExternal(url: string): void;
    /** Opens Windows' microphone privacy settings. */
    openMicSettings(): void;
  };
  meetings: {
    /** Call apps using the microphone right now, e.g. ["Zoom"]. */
    active(): Promise<string[]>;
    onChange(listener: (apps: string[]) => void): () => void;
  };
  widget: {
    state(): Promise<WidgetState>;
    onState(listener: (state: WidgetState) => void): () => void;
    act(action: WidgetAction): void;
  };
  /** Only while running the end-to-end tests. */
  test?: {
    /** Pretends a call app started or stopped using the microphone. */
    meeting(app: string, active: boolean): void;
  };
}

/** IPC channel names, shared by main and preload. */
export const IPC = {
  env: 'toru:env',
  recorderCall: 'toru:recorder-call',
  recorderReady: 'toru:recorder-ready',
  recorderState: 'toru:recorder-state',
  getApiKey: 'toru:get-api-key',
  setApiKey: 'toru:set-api-key',
  show: 'toru:show',
  navigate: 'toru:navigate',
  theme: 'toru:theme',
  prefs: 'toru:prefs',
  openExternal: 'toru:open-external',
  openMicSettings: 'toru:open-mic-settings',
  meetingsActive: 'toru:meetings-active',
  meetingsChanged: 'toru:meetings-changed',
  widgetState: 'toru:widget-state',
  widgetChanged: 'toru:widget-changed',
  widgetAct: 'toru:widget-act',
  testMeeting: 'toru:test-meeting',
} as const;
