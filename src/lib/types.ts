export type NoteStatus =
  | 'recording' // audio is being captured into this note
  | 'processing' // capture finished, remaining audio is being transcribed
  | 'summarizing' // the enhanced notes are being written
  | 'done'
  | 'interrupted' // TORU closed mid-recording; captured audio is finished on the next start
  | 'error';

/** Who said a line: "me" comes from your microphone, "them" from the computer's audio (the call). */
export type Speaker = 'me' | 'them';

/** What a recording listens to: the mic plus the computer's audio (a call), or only the mic (in person). */
export type AudioSources = 'both' | 'mic';

export interface Folder {
  id: string;
  name: string;
  description: string;
  /** Comma-separated names and terms the transcriber should spell correctly. */
  vocabulary: string;
  /** ISO-639-1 code, or '' to use the default from Settings. */
  language: string;
  /** Template for meetings in this folder, or '' to use the default from Settings. */
  templateId: string;
  /** Language to write this folder's notes in ('spoken', a language code, or '' for the default from Settings). */
  notesLanguage?: string;
  /** Extra instructions added to every summary in this folder. */
  instructions: string;
  color: string;
  createdAt: number;
  updatedAt: number;
}

export interface Note {
  id: string;
  folderId: string;
  title: string;
  /** True once the user renamed the note, so automatic titles stop. */
  titleEdited?: boolean;
  createdAt: number;
  updatedAt: number;
  durationMs: number;
  status: NoteStatus;
  error?: string;
  /** The enhanced notes (Markdown). */
  summary?: string;
  summaryModel?: string;
  summaryAt?: number;
  /** The template the current enhanced notes were written with. */
  summaryTemplate?: string;
  /** Template for the enhanced notes; '' or undefined means the folder's or the default. */
  templateId?: string;
  /** Write enhanced notes automatically when this recording ends. */
  autoSummary?: boolean;
  /** What the Ask tab sends: the full transcript (default) or only the notes (cheaper). */
  askContext?: 'transcript' | 'notes';
  /** What you typed during the meeting. */
  myNotes: string;
  sources: AudioSources;
  /** The call app that was using the microphone when recording started, e.g. "Zoom". */
  app?: string;
}

/** One transcribed stretch of audio from one speaker channel. */
export interface Segment {
  noteId: string;
  /** Unique per note across both channels; display order is by startMs. */
  index: number;
  startMs: number;
  endMs: number;
  speaker: Speaker;
  text: string;
  /**
   * A "me" line that repeats what "them" said at the same time: your mic picked
   * up your speakers. Hidden and left out of what the AI reads.
   */
  echo?: boolean;
}

/** One turn of the "Ask" conversation about a meeting. */
export interface ChatMessage {
  noteId: string;
  /** Order in the conversation. A compaction sits at x.5, right after the last message it covers. */
  index: number;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  model?: string;
  /** The answer was cut short with Stop. */
  stopped?: boolean;
  /** The answer started pasting the transcript; that part was cut off. */
  trimmed?: boolean;
  /** The request failed; content is empty and this explains why. */
  error?: string;
  /** Real token usage reported by OpenAI for the request that produced this answer. */
  usage?: TokenUsage;
  /** Characters sent in that request; with usage.prompt it calibrates later estimates. */
  promptChars?: number;
  /** 'compaction': a summary that replaces every earlier message in what's sent to the model. */
  kind?: 'compaction';
  /** For a compaction: how many messages it summarises in total. */
  covers?: number;
}

export interface TokenUsage {
  prompt: number;
  completion: number;
  /** Prompt tokens served from OpenAI's cache (billed at a discount). */
  cached: number;
}

/** Audio waiting to be transcribed. Deleted once its segment is stored. */
export interface PendingChunk {
  noteId: string;
  index: number;
  startMs: number;
  endMs: number;
  speaker: Speaker;
  audio: Blob;
  attempts: number;
  lastError?: string;
}

export interface Settings {
  /** Kept encrypted by the operating system, not in the database; merged in when read. */
  apiKey: string;
  transcribeModel: string;
  summaryModel: string;
  /** ISO-639-1 code, or '' for auto-detect. */
  language: string;
  /** Language to write notes in: 'spoken' (the meeting's own) or a language code. */
  notesLanguage: string;
  /** Default for new recordings: write enhanced notes when the meeting ends. */
  autoSummarize: boolean;
  /** Template used when neither the meeting nor its folder picks one. */
  templateId: string;
  /** Extra instructions added to every summary, e.g. "Write in British English." */
  instructions: string;
  /** Summarise older Ask messages automatically once they no longer fit what's sent. */
  autoCompact: boolean;
  theme: ThemePreference;
  lastFolderId?: string;
  /** Microphone device id, or '' for the system default. */
  micDeviceId: string;
  /** Default for new recordings. */
  sources: AudioSources;
  /** Offer to take notes when a call app (Teams, Zoom, Slack…) starts using the microphone. */
  detectMeetings: boolean;
  /** Stop recording shortly after the call app lets go of the microphone. */
  autoStop: boolean;
  /** Show the floating widget while recording when TORU's window isn't in front. */
  widget: boolean;
  /** Start TORU (in the tray) when you sign in to Windows. */
  openAtLogin: boolean;
}

export type ThemePreference = 'system' | 'light' | 'dark';

/**
 * Problems the recorder notices while recording:
 * - 'mic-silent': the microphone delivers no signal at all (muted in Windows, or the wrong device);
 * - 'nothing-heard': nobody has been heard on any channel for a while.
 */
export type RecordingAlert = 'mic-silent' | 'nothing-heard';

export interface RecordingState {
  noteId: string;
  alerts?: RecordingAlert[];
  folderId: string;
  sources: AudioSources;
  app?: string;
  paused: boolean;
  /** Recorded time before the current uninterrupted stretch. */
  elapsedMs: number;
  /** Epoch ms when the current stretch started, or null while paused. */
  runningSince: number | null;
}
