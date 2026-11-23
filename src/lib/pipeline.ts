// Transcription and enhanced-notes steps, shared by the recorder window (live)
// and the UI (retry / regenerate buttons).
import { isEcho, overlaps, stripPromptCopy } from './echo';
import { errorMessage, formatClock, formatDate, formatDuration, sleep } from './format';
import { chat, OpenAIError, transcribe } from './openai';
import * as store from './store';
import { splitTitle, summaryPrompt } from './templates';
import type { Folder, Note, PendingChunk, Segment, Speaker } from './types';

/**
 * How much of the previous lines the transcriber gets as context. Enough to keep
 * names and spelling consistent; more makes it likelier to copy the context back.
 */
const PROMPT_CONTEXT_CHARS = 200;

function transcriptionPrompt(folder: Folder | undefined, previousText: string): string {
  const parts: string[] = [];
  const vocab = folder?.vocabulary.trim();
  if (vocab) parts.push(`Glossary: ${vocab}.`);
  const prev = previousText.trim();
  // Passing the tail of the previous chunk keeps wording and spelling consistent.
  if (prev) parts.push(prev.slice(-PROMPT_CONTEXT_CHARS));
  return parts.join('\n');
}

/** "Me"/"Them" for calls; in-person recordings have one channel with everyone on it. */
export function speakerLabel(speaker: Speaker, note: Pick<Note, 'sources'>): string {
  if (note.sources === 'mic') return '';
  return speaker === 'me' ? 'Me' : 'Them';
}

/** The transcript as the AI reads it: echo lines left out, one line per segment. */
export function transcriptForAI(note: Pick<Note, 'sources'>, segments: Segment[], withTimes = true): string {
  return segments
    .filter((s) => !s.echo)
    .map((s) => {
      const who = speakerLabel(s.speaker, note);
      return `${withTimes ? `[${formatClock(s.startMs)}] ` : ''}${who ? `${who}: ` : ''}${s.text}`;
    })
    .join('\n');
}

/**
 * How many clips either side of a new line can overlap it in time. A clip is
 * at least ~3 s and the echo window is 5 s either way, so 24 is a wide margin.
 */
const ECHO_NEIGHBOURS = 24;

/**
 * Re-checks the "me" lines around a new line for speaker echo and stores any
 * that changed. Runs after every transcribed chunk, in whichever order the two
 * channels finish. Reads only the lines near it, so it costs the same in
 * minute one and hour two.
 */
async function updateEchoes(noteId: string, around: Segment): Promise<void> {
  const segments = await store.getSegmentsNear(noteId, around.index, ECHO_NEIGHBOURS);
  if (!segments.some((s) => s.speaker === 'them')) return;
  const changed = segments
    .filter((s) => s.speaker === 'me' && overlaps(s, around))
    .filter((s) => isEcho(s, segments) !== !!s.echo)
    .map((s) => ({ ...s, echo: !s.echo }));
  await store.putSegments(changed);
}

/** Transcribes one chunk, stores its segment and removes the audio. */
async function transcribeChunk(chunk: PendingChunk, previousText: string): Promise<string> {
  const settings = await store.getSettings();
  const note = await store.getNote(chunk.noteId);
  if (!note) {
    await store.deleteChunk(chunk.noteId, chunk.index); // note was deleted meanwhile
    return '';
  }
  const folder = await store.getFolder(note.folderId);
  const prompt = transcriptionPrompt(folder, previousText);
  const raw = await transcribe({
    apiKey: settings.apiKey,
    model: settings.transcribeModel,
    audio: chunk.audio,
    name: `${chunk.speaker}.wav`,
    language: folder?.language || settings.language || undefined,
    prompt,
  });
  const text = stripPromptCopy(raw, prompt);
  if (text) {
    const segment: Segment = {
      noteId: chunk.noteId,
      index: chunk.index,
      startMs: chunk.startMs,
      endMs: chunk.endMs,
      speaker: chunk.speaker,
      text,
    };
    await store.putSegment(segment);
    if (note.sources === 'both') await updateEchoes(chunk.noteId, segment);
  }
  await store.deleteChunk(chunk.noteId, chunk.index);
  return text;
}

export type ChunkResult = { ok: true; text: string } | { ok: false; error: string; fatal: boolean };

export async function transcribeWithRetry(
  chunk: PendingChunk,
  previousText: string,
  maxAttempts = 3,
): Promise<ChunkResult> {
  for (let attempt = 1; ; attempt++) {
    try {
      return { ok: true, text: await transcribeChunk(chunk, previousText) };
    } catch (e) {
      const error = errorMessage(e);
      const retryable = e instanceof OpenAIError && e.retryable;
      await store.updateChunk(chunk.noteId, chunk.index, { attempts: chunk.attempts + attempt, lastError: error });
      if (!retryable || attempt >= maxAttempts) return { ok: false, error, fatal: !retryable };
      await sleep(attempt * 4000);
    }
  }
}

/** What one speaker said before `beforeMs`, for the transcriber's context. */
async function previousText(noteId: string, speaker: Speaker, beforeMs: number): Promise<string> {
  const segments = await store.getSegments(noteId);
  return segments
    .filter((s) => s.speaker === speaker && s.startMs < beforeMs)
    .map((s) => s.text)
    .join(' ');
}

/** Retries audio that failed to transcribe earlier (or was left when TORU closed), then finalises the note. */
export async function retryPendingChunks(noteId: string): Promise<void> {
  const chunks = await store.getChunks(noteId);
  if (!chunks.length) return finalizeNote(noteId);
  await store.updateNote(noteId, { status: 'processing', error: undefined });
  for (const chunk of chunks) {
    const result = await transcribeWithRetry(chunk, await previousText(noteId, chunk.speaker, chunk.startMs), 2);
    if (!result.ok) {
      await store.updateNote(noteId, { status: 'error', error: result.error });
      if (result.fatal) return;
    }
  }
  await finalizeNote(noteId);
}

/**
 * Gives up on audio that couldn't be transcribed (for one note, or all notes
 * except the live recording). Whatever transcript already exists is kept.
 */
export async function discardAudio(noteId?: string): Promise<number> {
  const live = await store.getRecording();
  if (noteId && live?.noteId === noteId) throw new Error('Stop the recording first.');
  const affected = await store.discardChunks(noteId ? { noteId } : { keepNoteId: live?.noteId });
  for (const id of affected) {
    await store.updateNote(id, (n) =>
      n.status === 'error' || n.status === 'interrupted' ? { status: 'done', error: undefined } : undefined,
    );
  }
  return affected.length;
}

/**
 * Called once a note's audio is fully captured and its queue has drained.
 * Writes the enhanced notes (if enabled) and settles the note's status.
 */
export async function finalizeNote(
  noteId: string,
  opts: { autoSummarize?: boolean; deleteIfEmpty?: boolean } = {},
): Promise<void> {
  const note = await store.getNote(noteId);
  if (!note) return;
  const pending = await store.countChunks(noteId);
  if (pending > 0) {
    await store.updateNote(noteId, {
      status: 'error',
      error: note.error ?? `${pending} part${pending === 1 ? '' : 's'} of the audio couldn’t be transcribed.`,
    });
    return;
  }
  const segments = await store.getSegments(noteId);
  if (!segments.some((s) => !s.echo && s.text.trim())) {
    if (opts.deleteIfEmpty && !note.myNotes.trim()) {
      await store.deleteNote(noteId); // nothing was said and nothing was typed: don't leave an empty note
      return;
    }
    await store.updateNote(noteId, { status: 'done', error: undefined });
    return;
  }
  const settings = await store.getSettings();
  if (opts.autoSummarize ?? note.autoSummary ?? settings.autoSummarize) {
    try {
      await generateSummary(noteId);
    } catch {
      // generateSummary already recorded the error on the note.
    }
  } else {
    await store.updateNote(noteId, { status: 'done', error: undefined });
  }
}

function userMessage(note: Note, folder: Folder | undefined, transcript: string): string {
  const lines: string[] = [];
  if (note.titleEdited) lines.push(`Meeting title: ${note.title}`);
  lines.push(`When: ${formatDate(note.createdAt)}${note.durationMs ? ` · ${formatDuration(note.durationMs)}` : ''}`);
  if (folder && folder.id !== store.INBOX_ID) {
    lines.push(`Folder: ${folder.name}${folder.description ? ` — ${folder.description}` : ''}`);
  }
  lines.push(
    note.sources === 'mic'
      ? 'Recorded in person with one microphone, so speakers aren’t labelled.'
      : `Recorded from ${note.app ? `a ${note.app} call` : 'a call'}: "Me" is the user, "Them" is the other side.`,
  );
  if (note.myNotes.trim()) {
    lines.push('', 'My own notes, typed during the meeting (make sure every point is covered):', note.myNotes.trim());
  }
  lines.push('', 'Transcript:', '"""', transcript, '"""');
  return lines.join('\n');
}

/** The template a note is enhanced with: its own, else its folder's, else the default. */
export async function templateFor(note: Note): Promise<string> {
  if (note.templateId) return note.templateId;
  const [folder, settings] = await Promise.all([store.getFolder(note.folderId), store.getSettings()]);
  return folder?.templateId || settings.templateId;
}

/** Writes the enhanced notes. Pass a template to switch to it (it's remembered on the note). */
export async function generateSummary(noteId: string, templateId?: string): Promise<void> {
  const note = await store.getNote(noteId);
  if (!note) throw new Error('Note not found.');
  const segments = await store.getSegments(noteId);
  const transcript = transcriptForAI(note, segments);
  if (!transcript.trim()) throw new Error('There’s no transcript to work from yet.');
  const [folder, settings] = await Promise.all([store.getFolder(note.folderId), store.getSettings()]);
  const template = templateId ?? (await templateFor(note));

  await store.updateNote(noteId, { status: 'summarizing', error: undefined, ...(templateId ? { templateId } : {}) });
  try {
    const raw = await chat({
      apiKey: settings.apiKey,
      model: settings.summaryModel,
      system: summaryPrompt(template, settings.instructions, folder?.instructions),
      user: userMessage(note, folder, transcript),
    });
    const { title, body } = splitTitle(raw);
    await store.updateNote(noteId, (cur) => ({
      status: 'done',
      error: undefined,
      summary: body,
      summaryModel: settings.summaryModel,
      summaryAt: Date.now(),
      summaryTemplate: template,
      ...(title && !cur.titleEdited ? { title } : {}),
    }));
  } catch (e) {
    await store.updateNote(noteId, { status: 'error', error: `Enhancing the notes failed: ${errorMessage(e)}` });
    throw e;
  }
}
