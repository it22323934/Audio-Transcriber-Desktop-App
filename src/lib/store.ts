// Typed data access for the whole app. Every write emits a change event so
// open views in other windows refresh themselves.
import { bridge } from './bridge';
import * as db from './db';
import { emit, subscribe } from './events';
import { RECOMMENDED_TRANSCRIBE_MODEL } from './transcribeModels';
import { DEFAULT_TEMPLATE_ID } from './templates';
import type { ChatMessage, Folder, Note, PendingChunk, RecordingState, Segment, Settings } from './types';

export const INBOX_ID = 'inbox';

export const FOLDER_COLORS = ['#c9dc4c', '#7cc4e8', '#f0a07c', '#b9a3f0', '#e8c46a', '#7fd6b4', '#ee93b8'];

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  transcribeModel: RECOMMENDED_TRANSCRIBE_MODEL,
  summaryModel: 'gpt-5-mini',
  language: '',
  notesLanguage: 'spoken',
  autoSummarize: true,
  templateId: DEFAULT_TEMPLATE_ID,
  instructions: '',
  autoCompact: false,
  theme: 'system',
  micDeviceId: '',
  sources: 'both',
  detectMeetings: true,
  autoStop: true,
  widget: true,
  openAtLogin: false,
};

interface MetaRow<T> {
  key: string;
  value: T;
}

export function uid(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------- settings

// The API key lives in the main process (encrypted with Windows' DPAPI); each
// window caches it until the settings change.
let apiKeyCache: Promise<string> | null = null;
subscribe((e) => {
  if (e.type === 'settings') apiKeyCache = null;
});

function apiKey(): Promise<string> {
  apiKeyCache ??= bridge.secrets.getApiKey().catch(() => '');
  return apiKeyCache;
}

export async function getSettings(): Promise<Settings> {
  const [row, key] = await Promise.all([db.get<MetaRow<Partial<Settings>>>('meta', 'settings'), apiKey()]);
  return { ...DEFAULT_SETTINGS, ...(row?.value ?? {}), apiKey: key };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const { apiKey: key, ...rest } = patch;
  if (key !== undefined) {
    await bridge.secrets.setApiKey(key);
    apiKeyCache = Promise.resolve(key);
  }
  const row = await db.mutate<MetaRow<Partial<Settings>>>('meta', 'settings', (cur) => ({
    key: 'settings',
    value: { ...(cur?.value ?? {}), ...rest },
  }));
  emit({ type: 'settings' });
  return { ...DEFAULT_SETTINGS, ...(row?.value ?? {}), apiKey: await apiKey() };
}

// --------------------------------------------------------------- recording

export async function getRecording(): Promise<RecordingState | null> {
  const row = await db.get<MetaRow<RecordingState>>('meta', 'recording');
  return row?.value ?? null;
}

export async function setRecording(state: RecordingState | null): Promise<void> {
  if (state) await db.put<MetaRow<RecordingState>>('meta', { key: 'recording', value: state });
  else await db.del('meta', 'recording');
  emit({ type: 'recording' });
}

// ----------------------------------------------------------------- folders

function sortFolders(folders: Folder[]): Folder[] {
  return folders.sort((a, b) => {
    if (a.id === INBOX_ID) return -1;
    if (b.id === INBOX_ID) return 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

export async function listFolders(): Promise<Folder[]> {
  return sortFolders(await db.getAll<Folder>('folders'));
}

export async function getFolder(id: string): Promise<Folder | undefined> {
  return db.get<Folder>('folders', id);
}

export async function ensureInbox(): Promise<Folder> {
  const existing = await getFolder(INBOX_ID);
  if (existing) return existing;
  const now = Date.now();
  const inbox: Folder = {
    id: INBOX_ID,
    name: 'Inbox',
    description: 'Meetings that aren’t filed in a folder yet.',
    vocabulary: '',
    language: '',
    templateId: '',
    instructions: '',
    color: '#a3a194',
    createdAt: now,
    updatedAt: now,
  };
  await db.put('folders', inbox);
  emit({ type: 'folders' });
  return inbox;
}

export async function createFolder(input: Partial<Folder> & { name: string }): Promise<Folder> {
  const now = Date.now();
  const count = (await db.getAll<Folder>('folders')).length;
  const folder: Folder = {
    description: '',
    vocabulary: '',
    language: '',
    templateId: '',
    instructions: '',
    color: FOLDER_COLORS[count % FOLDER_COLORS.length],
    ...input,
    id: uid(),
    createdAt: now,
    updatedAt: now,
  };
  await db.put('folders', folder);
  emit({ type: 'folders' });
  return folder;
}

export async function updateFolder(id: string, patch: Partial<Folder>): Promise<void> {
  await db.mutate<Folder>('folders', id, (cur) => (cur ? { ...cur, ...patch, id, updatedAt: Date.now() } : undefined));
  emit({ type: 'folders' });
}

/** Deletes a folder; its meetings move to the Inbox. */
export async function deleteFolder(id: string): Promise<void> {
  if (id === INBOX_ID) throw new Error('The Inbox can’t be deleted.');
  await ensureInbox();
  const notes = await db.getAllByIndex<Note>('notes', 'folderId', id);
  await db.putMany(
    'notes',
    notes.map((n) => ({ ...n, folderId: INBOX_ID, updatedAt: Date.now() })),
  );
  await db.del('folders', id);
  emit({ type: 'folders' });
  emit({ type: 'notes' });
}

// ------------------------------------------------------------------- notes

const byNewest = (a: Note, b: Note) => b.createdAt - a.createdAt;

export async function listNotes(folderId?: string): Promise<Note[]> {
  const notes = folderId
    ? await db.getAllByIndex<Note>('notes', 'folderId', folderId)
    : await db.getAll<Note>('notes');
  return notes.sort(byNewest);
}

export async function getNote(id: string): Promise<Note | undefined> {
  return db.get<Note>('notes', id);
}

export async function createNote(
  input: Pick<Note, 'folderId' | 'title' | 'status' | 'sources'> & Partial<Pick<Note, 'autoSummary' | 'app' | 'templateId'>>,
): Promise<Note> {
  const now = Date.now();
  const note: Note = { ...input, id: uid(), createdAt: now, updatedAt: now, durationMs: 0, myNotes: '' };
  await db.put('notes', note);
  emit({ type: 'notes', noteId: note.id });
  return note;
}

/**
 * Applies a patch atomically. A function patch receives the current note and
 * may return undefined to skip the write.
 */
export async function updateNote(
  id: string,
  patch: Partial<Note> | ((note: Note) => Partial<Note> | undefined),
): Promise<Note | undefined> {
  const updated = await db.mutate<Note>('notes', id, (cur) => {
    if (!cur) return undefined;
    const p = typeof patch === 'function' ? patch(cur) : patch;
    if (!p) return undefined;
    return { ...cur, ...p, id, updatedAt: Date.now() };
  });
  if (updated) emit({ type: 'notes', noteId: id });
  return updated;
}

export async function deleteNote(id: string): Promise<void> {
  await db.deleteByIndex('segments', 'noteId', id);
  await db.deleteByIndex('chunks', 'noteId', id);
  await db.deleteByIndex('messages', 'noteId', id);
  await db.del('notes', id);
  emit({ type: 'notes', noteId: id });
}

// ---------------------------------------------------------------- segments

/** Order of a conversation: by start time, then "them" before "me" at the same moment. */
export const byTime = (a: Segment, b: Segment) =>
  a.startMs - b.startMs || (a.speaker === b.speaker ? a.index - b.index : a.speaker === 'them' ? -1 : 1);

/** A note's transcript in speaking order, echo lines included (callers decide whether to show them). */
export async function getSegments(noteId: string): Promise<Segment[]> {
  const segs = await db.getAllByIndex<Segment>('segments', 'noteId', noteId);
  return segs.sort(byTime);
}

export async function getAllSegments(): Promise<Segment[]> {
  return db.getAll<Segment>('segments');
}

/** Just these lines of a note (for live updates, instead of re-reading the whole transcript). */
export async function getSegmentsByIndex(noteId: string, indexes: number[]): Promise<Segment[]> {
  return db.getMany<Segment>('segments', indexes.map((i) => [noteId, i]));
}

/**
 * Lines whose index is within `spread` of `index`. Indexes follow the order
 * clips were cut in, so these are the lines said around the same time.
 */
export async function getSegmentsNear(noteId: string, index: number, spread: number): Promise<Segment[]> {
  const lines = await db.getRange<Segment>('segments', IDBKeyRange.bound([noteId, Math.max(0, index - spread)], [noteId, index + spread]));
  return lines.sort(byTime);
}

/** The most recent lines of a note, in speaking order, read without loading the rest. */
export async function getRecentSegments(noteId: string, count: number): Promise<Segment[]> {
  const lines = await db.getLast<Segment>('segments', IDBKeyRange.bound([noteId, 0], [noteId, Infinity]), count);
  return lines.sort(byTime);
}

export async function putSegment(segment: Segment): Promise<void> {
  await db.put('segments', segment);
  emit({ type: 'segments', noteId: segment.noteId, indexes: [segment.index] });
}

export async function putSegments(segments: Segment[]): Promise<void> {
  if (!segments.length) return;
  await db.putMany('segments', segments);
  for (const noteId of new Set(segments.map((s) => s.noteId))) {
    emit({ type: 'segments', noteId, indexes: segments.filter((s) => s.noteId === noteId).map((s) => s.index) });
  }
}

// ---------------------------------------------------------------- messages

export async function getMessages(noteId: string): Promise<ChatMessage[]> {
  const messages = await db.getAllByIndex<ChatMessage>('messages', 'noteId', noteId);
  return messages.sort((a, b) => a.index - b.index);
}

export async function putMessage(message: ChatMessage): Promise<void> {
  await db.put('messages', message);
  emit({ type: 'messages', noteId: message.noteId });
}

/** Deletes a note's messages from `fromIndex` on (all of them by default). */
export async function deleteMessages(noteId: string, fromIndex = 0): Promise<void> {
  const keys = await db.getRangeKeys('messages', IDBKeyRange.bound([noteId, fromIndex], [noteId, Infinity]));
  await db.deleteKeys('messages', keys);
  emit({ type: 'messages', noteId });
}

// ------------------------------------------------------------------ chunks

export async function addChunk(chunk: PendingChunk): Promise<void> {
  await db.put('chunks', chunk);
  emit({ type: 'chunks', noteId: chunk.noteId });
}

export async function getChunks(noteId: string): Promise<PendingChunk[]> {
  const chunks = await db.getAllByIndex<PendingChunk>('chunks', 'noteId', noteId);
  return chunks.sort((a, b) => a.index - b.index);
}

export async function countChunks(noteId: string): Promise<number> {
  return db.countByIndex('chunks', 'noteId', noteId);
}

export async function updateChunk(noteId: string, index: number, patch: Partial<PendingChunk>): Promise<void> {
  await db.mutate<PendingChunk>('chunks', [noteId, index], (cur) => (cur ? { ...cur, ...patch } : undefined));
}

export async function deleteChunk(noteId: string, index: number): Promise<void> {
  await db.del('chunks', [noteId, index]);
  emit({ type: 'chunks', noteId });
}

/** Audio still waiting to be transcribed: the only data that can grow large (~1 MB per 30 s). */
export async function audioBacklog(): Promise<{ chunks: number; bytes: number; noteIds: string[] }> {
  const chunks = await db.getAll<PendingChunk>('chunks'); // Blobs are handles; their bytes aren't read
  return {
    chunks: chunks.length,
    bytes: chunks.reduce((sum, c) => sum + c.audio.size, 0),
    noteIds: [...new Set(chunks.map((c) => c.noteId))],
  };
}

/** Deletes waiting audio for one note, or for every note except `keepNoteId`. Returns affected notes. */
export async function discardChunks(opts: { noteId?: string; keepNoteId?: string } = {}): Promise<string[]> {
  if (opts.noteId) {
    await db.deleteByIndex('chunks', 'noteId', opts.noteId);
    emit({ type: 'chunks', noteId: opts.noteId });
    return [opts.noteId];
  }
  const keys = (await db.getAllKeys('chunks')) as [string, number][];
  const doomed = keys.filter(([noteId]) => noteId !== opts.keepNoteId);
  await db.deleteKeys('chunks', doomed);
  const noteIds = [...new Set(doomed.map(([noteId]) => noteId))];
  for (const noteId of noteIds) emit({ type: 'chunks', noteId });
  return noteIds;
}

/** Removes audio and transcript lines whose note no longer exists. Returns how many were removed. */
export async function sweepOrphans(): Promise<number> {
  const noteIds = new Set((await db.getAllKeys('notes')) as string[]);
  let removed = 0;
  for (const name of ['chunks', 'segments', 'messages'] as const) {
    const keys = (await db.getAllKeys(name)) as [string, number][];
    const orphans = keys.filter(([noteId]) => !noteIds.has(noteId));
    await db.deleteKeys(name, orphans);
    removed += orphans.length;
  }
  return removed;
}

// ------------------------------------------------------------------ backup

export interface Backup {
  app: 'toru-desktop';
  version: 1;
  exportedAt: number;
  settings: Partial<Settings>;
  folders: Folder[];
  notes: Note[];
  segments: Segment[];
  messages: ChatMessage[];
}

export async function exportBackup(): Promise<Backup> {
  const { apiKey: _omit, ...settings } = await getSettings();
  return {
    app: 'toru-desktop',
    version: 1,
    exportedAt: Date.now(),
    settings,
    folders: await db.getAll<Folder>('folders'),
    notes: await db.getAll<Note>('notes'),
    segments: await db.getAll<Segment>('segments'),
    messages: await db.getAll<ChatMessage>('messages'),
  };
}

/** Merges a backup into the current data. Records with the same id are replaced. */
export async function importBackup(data: unknown): Promise<{ folders: number; notes: number }> {
  const b = data as Partial<Backup>;
  if (!b || b.app !== 'toru-desktop' || !Array.isArray(b.folders) || !Array.isArray(b.notes)) {
    throw new Error('That file isn’t a TORU desktop backup.');
  }
  // Recordings that were in flight when the backup was made can't resume.
  const notes = b.notes.map((n) =>
    n.status === 'done' || n.status === 'error' ? n : { ...n, status: 'done' as const },
  );
  await db.putMany('folders', b.folders);
  await db.putMany('notes', notes);
  await db.putMany('segments', Array.isArray(b.segments) ? b.segments : []);
  await db.putMany('messages', Array.isArray(b.messages) ? b.messages : []);
  if (b.settings) {
    const { apiKey: _omit, ...rest } = b.settings;
    await saveSettings(rest);
  }
  emit({ type: 'folders' });
  emit({ type: 'notes' });
  return { folders: b.folders.length, notes: notes.length };
}
