// One meeting. While it's recording, the page is a notepad with a recording
// dock; afterwards it shows the enhanced notes (with your own notes one click
// away), the speaker-labelled transcript, and Ask.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { bridge } from '../../lib/bridge';
import { downloadFile, noteToMarkdown, safeFilename } from '../../lib/export';
import { errorMessage, formatClock, formatDate, formatDuration, timeAgo } from '../../lib/format';
import { discardAudio, generateSummary, retryPendingChunks, speakerLabel } from '../../lib/pipeline';
import * as store from '../../lib/store';
import { getTemplate, TEMPLATES } from '../../lib/templates';
import type { Note, RecordingState, Segment } from '../../lib/types';
import { elapsedMs, useDebouncedSave, useFolders, useLive, useNote, useNow, useSettings } from '../hooks';
import { IconCopy, IconDownload, IconPause, IconPlay, IconRefresh, IconSparkle, IconStop, IconTrash } from '../icons';
import { Markdown, toggleTask } from '../Markdown';
import { toast } from '../toast';
import { LevelBars, Menu, StatusChip } from './bits';
import { ChatPanel } from './ChatPanel';
import { useConfirm } from './Modal';
import { Select } from './Select';

type Tab = 'notes' | 'transcript' | 'ask';

export function NoteView(props: {
  noteId: string;
  recording: RecordingState | null | undefined;
  /** Rendered at the top left, opposite the note actions (e.g. a back link). */
  back?: ReactNode;
  onDeleted?: () => void;
}) {
  const { noteId, recording } = props;
  const note = useNote(noteId);
  const segments = useLive(
    () => store.getSegments(noteId),
    [noteId],
    (e) => e.type === 'segments' && e.noteId === noteId,
  );
  const pending =
    useLive(
      () => store.countChunks(noteId),
      [noteId],
      (e) => e.type === 'chunks' && e.noteId === noteId,
    ) ?? 0;
  const folders = useFolders();
  const settings = useSettings();
  const live = recording?.noteId === noteId;
  const [tab, setTab] = useState<Tab>('notes');
  const [busy, setBusy] = useState<null | 'summary' | 'retry'>(null);
  const { confirm, element: confirmEl } = useConfirm();

  useEffect(() => setTab('notes'), [noteId]);

  const folder = note ? folders?.find((f) => f.id === note.folderId) : undefined;
  const templateId = note?.templateId || folder?.templateId || settings?.templateId || TEMPLATES[0].id;
  const endRef = useFollow(segments?.length ?? 0, live && tab === 'transcript');

  if (note === undefined) return <Skeleton lines={5} />;
  if (note === null) {
    return (
      <>
        {props.back}
        <div className="empty">
          <h3>This meeting was deleted</h3>
        </div>
      </>
    );
  }

  async function enhance(template?: string) {
    if (!settings?.apiKey) {
      toast('Add your OpenAI API key in Settings first.', 'error');
      return;
    }
    setBusy('summary');
    try {
      await generateSummary(noteId, template);
      setTab('notes');
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(null);
    }
  }

  async function retry() {
    setBusy('retry');
    try {
      await retryPendingChunks(noteId);
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(null);
    }
  }

  async function discard() {
    const ok = await confirm({
      title: 'Discard the waiting audio?',
      message: `${pending} part${pending === 1 ? '' : 's'} of audio couldn’t be transcribed and ${pending === 1 ? 'is' : 'are'} taking up space. The transcript you already have is kept.`,
      confirmLabel: 'Discard audio',
      danger: true,
    });
    if (!ok) return;
    try {
      await discardAudio(noteId);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  }

  async function markdown() {
    const [segs, f, chat] = await Promise.all([store.getSegments(noteId), store.getFolder(note!.folderId), store.getMessages(noteId)]);
    return noteToMarkdown(note!, f, segs, chat);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(await markdown());
      toast('Copied as Markdown');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  }

  async function remove() {
    const ok = await confirm({
      title: 'Delete this meeting?',
      message: `“${note!.title}”, its notes and transcript will be permanently deleted.`,
      confirmLabel: 'Delete meeting',
      danger: true,
    });
    if (!ok) return;
    await store.deleteNote(noteId);
    props.onDeleted?.();
  }

  const working = busy !== null || note.status === 'processing' || note.status === 'summarizing';
  const hasTranscript = !!segments?.some((s) => !s.echo);

  return (
    <article className={`note-view ${live ? 'is-live' : ''}`}>
      <div className="note-topbar">
        <div>{props.back}</div>
        <div className="note-actions">
          <button className="icon-btn" onClick={copy} aria-label="Copy as Markdown" title="Copy as Markdown">
            <IconCopy />
          </button>
          <Menu label="More actions">
            {(close) => (
              <>
                <button
                  onClick={async () => {
                    close();
                    downloadFile(`${safeFilename(note.title)}.md`, await markdown());
                  }}
                >
                  <IconDownload size={15} /> Download .md
                </button>
                <button
                  disabled={working || live || !hasTranscript}
                  onClick={() => {
                    close();
                    void enhance();
                  }}
                >
                  <IconSparkle size={15} /> {note.summary ? 'Rewrite the notes' : 'Enhance notes'}
                </button>
                <hr />
                <button
                  className="danger"
                  disabled={live}
                  onClick={() => {
                    close();
                    void remove();
                  }}
                >
                  <IconTrash size={15} /> {live ? 'Stop recording to delete' : 'Delete meeting'}
                </button>
              </>
            )}
          </Menu>
        </div>
      </div>

      <header className="note-head">
        <TitleField value={note.title} onCommit={(title) => store.updateNote(noteId, { title, titleEdited: true })} />
        <div className="meta-row">
          <Select
            variant="chip"
            ariaLabel="Move to folder"
            title="Move to another folder"
            value={note.folderId}
            options={(folders ?? []).map((f) => ({ value: f.id, label: f.name, dot: f.color }))}
            onChange={(folderId) => void store.updateNote(note.id, { folderId })}
          />
          <span className="chip">{formatDate(note.createdAt)}</span>
          {note.durationMs > 0 && <span className="chip">{formatDuration(note.durationMs)}</span>}
          {note.app && <span className="chip">{note.app}</span>}
          {note.sources === 'mic' && <span className="chip">In person</span>}
          <Select
            variant="chip"
            ariaLabel="Notes template"
            title="Template for the enhanced notes"
            value={templateId}
            options={TEMPLATES.map((t) => ({ value: t.id, label: t.name, description: t.description }))}
            onChange={(id) => void store.updateNote(note.id, { templateId: id })}
            listMinWidth={280}
          />
          <StatusChip note={note} live={live} paused={live && recording?.paused} />
        </div>
      </header>

      {note.error && (
        <div className="callout callout-error" style={{ marginTop: 16 }}>
          <div className="callout-body">
            <span>
              {note.error}
              {live && ' The audio is being kept. Fix the problem in Settings and it will be sent automatically.'}
            </span>
            {!live && (pending > 0 || hasTranscript) && (
              <div className="callout-actions">
                {pending > 0 ? (
                  <>
                    <button className="btn btn-sm btn-light" onClick={retry} disabled={working}>
                      <IconRefresh size={14} /> {busy === 'retry' ? 'Retrying…' : 'Retry transcription'}
                    </button>
                    <button className="btn btn-sm btn-ghost" onClick={discard} disabled={working}>
                      Discard audio
                    </button>
                  </>
                ) : (
                  <button className="btn btn-sm btn-light" onClick={() => enhance()} disabled={working}>
                    <IconSparkle size={14} /> {note.summary ? 'Try again' : 'Enhance notes'}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="note-toolbar" style={{ marginTop: 22 }}>
        <div className="seg" role="tablist">
          <button role="tab" aria-selected={tab === 'notes'} onClick={() => setTab('notes')}>
            Notes
          </button>
          <button role="tab" aria-selected={tab === 'transcript'} onClick={() => setTab('transcript')}>
            Transcript
          </button>
          <button role="tab" aria-selected={tab === 'ask'} onClick={() => setTab('ask')}>
            Ask
          </button>
        </div>
      </div>

      <div className="note-body" role="tabpanel">
        {tab === 'notes' && (
          <NotesPanel
            note={note}
            live={live}
            hasTranscript={hasTranscript}
            busy={busy === 'summary'}
            templateId={templateId}
            autoSummary={note.autoSummary ?? settings?.autoSummarize ?? true}
            onEnhance={enhance}
          />
        )}
        {tab === 'transcript' && (
          <TranscriptPanel note={note} segments={segments} live={live} paused={!!recording?.paused} pending={pending} />
        )}
        {tab === 'ask' && segments && <ChatPanel note={note} folder={folder} segments={segments} />}
        <div ref={endRef} />
      </div>

      {live && recording && (
        <RecordingDock recording={recording} note={note} segments={segments ?? []} onTranscript={() => setTab('transcript')} />
      )}
      {confirmEl}
    </article>
  );
}

// ------------------------------------------------------------------- notes

function NotesPanel(props: {
  note: Note;
  live: boolean;
  hasTranscript: boolean;
  busy: boolean;
  templateId: string;
  autoSummary: boolean;
  onEnhance: (templateId?: string) => void;
}) {
  const { note, live } = props;
  const [view, setView] = useState<'enhanced' | 'mine'>('enhanced');
  const template = getTemplate(props.templateId);

  if (props.busy || note.status === 'summarizing') {
    return (
      <div style={{ display: 'grid', gap: 18 }}>
        <div className="row faint" style={{ fontSize: 13 }}>
          <span className="spinner" /> Enhancing your notes with the transcript…
        </div>
        <Skeleton lines={8} />
      </div>
    );
  }

  if (live || !note.summary) {
    return (
      <div className="notepad">
        <MyNotes
          key={note.id}
          note={note}
          placeholder={
            live
              ? 'Write notes as you go: a word or two per point is enough. When the meeting ends, TORU fills in the details from the transcript.'
              : 'Your notes for this meeting.'
          }
        />
        {live ? (
          <label className="switch switch-sm enhance-switch">
            <input
              type="checkbox"
              checked={props.autoSummary}
              onChange={(e) => void store.updateNote(note.id, { autoSummary: e.target.checked })}
            />
            <span className="switch-text">
              <strong>Enhance notes when the meeting ends</strong>
              <span className="field-hint">With the {template.name} template. Uses your OpenAI credits, usually about 1¢.</span>
            </span>
          </label>
        ) : props.hasTranscript ? (
          <div className="enhance-card">
            <div>
              <strong>Turn this into proper notes</strong>
              <p>
                {template.name}: {template.description.toLowerCase()}. Your notes above decide what matters most.
              </p>
            </div>
            <button className="btn btn-primary" onClick={() => props.onEnhance()}>
              <IconSparkle size={15} /> Enhance notes
            </button>
          </div>
        ) : note.status === 'processing' || note.status === 'interrupted' || note.status === 'recording' ? (
          <div className="row faint" style={{ fontSize: 13 }}>
            <span className="spinner" /> Transcribing the last part…
          </div>
        ) : null}
      </div>
    );
  }

  const outdated = note.summaryTemplate && note.summaryTemplate !== props.templateId;
  return (
    <>
      <div className="row" style={{ marginBottom: 18 }}>
        <div className="seg seg-sm" role="radiogroup" aria-label="Which notes">
          <button role="radio" aria-checked={view === 'enhanced'} aria-selected={view === 'enhanced'} onClick={() => setView('enhanced')}>
            <IconSparkle size={13} /> Enhanced
          </button>
          <button role="radio" aria-checked={view === 'mine'} aria-selected={view === 'mine'} onClick={() => setView('mine')}>
            My notes
          </button>
        </div>
      </div>
      {view === 'mine' ? (
        <div className="notepad">
          <MyNotes key={note.id} note={note} placeholder="You didn’t type anything during this meeting. Add notes here any time." />
        </div>
      ) : (
        <>
          {outdated && (
            <div className="callout" style={{ marginBottom: 18 }}>
              <div className="callout-body">
                <span>These notes use the {getTemplate(note.summaryTemplate).name} template.</span>
                <div className="callout-actions">
                  <button className="btn btn-sm btn-light" onClick={() => props.onEnhance(props.templateId)}>
                    <IconSparkle size={13} /> Rewrite as {template.name}
                  </button>
                </div>
              </div>
            </div>
          )}
          <Markdown
            text={note.summary}
            onToggleTask={(n) => void store.updateNote(note.id, (cur) => ({ summary: toggleTask(cur.summary ?? '', n) }))}
          />
          <div className="summary-foot">
            <span>
              Enhanced by {note.summaryModel ?? 'AI'}
              {note.summaryTemplate ? ` · ${getTemplate(note.summaryTemplate).name}` : ''}
              {note.summaryAt ? ` · ${timeAgo(note.summaryAt)}` : ''}
            </span>
            <button className="btn btn-sm" onClick={() => props.onEnhance()}>
              <IconRefresh size={13} /> Rewrite
            </button>
          </div>
        </>
      )}
    </>
  );
}

/** Continues "- " bullets on Enter, ends them on an empty one, and indents with Tab. */
function bulletKeys(e: KeyboardEvent<HTMLTextAreaElement>, set: (value: string, caret: number) => void): void {
  const el = e.currentTarget;
  const { value, selectionStart: at, selectionEnd } = el;
  const lineStart = value.lastIndexOf('\n', at - 1) + 1;
  const line = value.slice(lineStart, at);
  if (e.key === 'Enter' && !e.shiftKey && at === selectionEnd && !e.nativeEvent.isComposing) {
    const m = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (!m) return;
    e.preventDefault();
    if (!m[3].trim()) {
      set(value.slice(0, lineStart) + value.slice(at), lineStart); // empty bullet: end the list
      return;
    }
    const next = /^\d+/.test(m[2]) ? `${parseInt(m[2], 10) + 1}${m[2].slice(-1)}` : m[2];
    const insert = `\n${m[1]}${next} `;
    set(value.slice(0, at) + insert + value.slice(at), at + insert.length);
  } else if (e.key === 'Tab' && /^\s*([-*•]|\d+[.)])\s/.test(value.slice(lineStart))) {
    e.preventDefault();
    if (e.shiftKey) {
      if (!value.startsWith('  ', lineStart)) return;
      set(value.slice(0, lineStart) + value.slice(lineStart + 2), Math.max(lineStart, at - 2));
    } else {
      set(value.slice(0, lineStart) + '  ' + value.slice(lineStart), at + 2);
    }
  }
}

function MyNotes({ note, placeholder }: { note: Note; placeholder: string }) {
  const [text, setText] = useState(note.myNotes);
  const focused = useRef(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const caret = useRef<number | null>(null);
  const { schedule, flush, isPending } = useDebouncedSave<string>((value) => {
    store.updateNote(note.id, { myNotes: value }).catch((e) => toast(errorMessage(e), 'error'));
  });

  useEffect(() => {
    if (!focused.current && !isPending()) setText(note.myNotes);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sync only when the stored text changes
  }, [note.myNotes]);

  useLayoutEffect(() => {
    if (caret.current !== null && ref.current) {
      ref.current.selectionStart = ref.current.selectionEnd = caret.current;
      caret.current = null;
    }
  }, [text]);

  useAutosize(ref, text, 260);

  const change = (value: string) => {
    setText(value);
    schedule(value);
  };

  return (
    <textarea
      ref={ref}
      className="my-notes"
      aria-label="My notes"
      placeholder={placeholder}
      value={text}
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false;
        flush();
      }}
      onChange={(e) => change(e.target.value)}
      onKeyDown={(e) =>
        bulletKeys(e, (value, at) => {
          caret.current = at;
          change(value);
        })
      }
    />
  );
}

// -------------------------------------------------------------- transcript

interface Turn {
  key: number;
  speaker: Segment['speaker'];
  startMs: number;
  lines: Segment[];
}

/** Consecutive lines from the same speaker form one turn (one bubble). */
function toTurns(segments: Segment[]): Turn[] {
  const turns: Turn[] = [];
  for (const s of segments) {
    const last = turns.at(-1);
    if (last && last.speaker === s.speaker && !s.echo === !last.lines[0].echo) last.lines.push(s);
    else turns.push({ key: s.index, speaker: s.speaker, startMs: s.startMs, lines: [s] });
  }
  return turns;
}

function TranscriptPanel(props: { note: Note; segments: Segment[] | undefined; live: boolean; paused: boolean; pending: number }) {
  const { note, segments, live, pending } = props;
  const [showEcho, setShowEcho] = useState(false);
  const echoes = segments?.filter((s) => s.echo).length ?? 0;
  const shown = useMemo(() => (segments ?? []).filter((s) => showEcho || !s.echo), [segments, showEcho]);
  const turns = useMemo(() => toTurns(shown), [shown]);
  if (!segments) return <Skeleton lines={4} />;
  const transcribing = !live && pending > 0 && ['processing', 'recording', 'interrupted'].includes(note.status);
  const call = note.sources !== 'mic';

  return (
    <div className={`transcript ${call ? 'transcript-call' : ''}`}>
      {turns.map((t) => {
        const who = speakerLabel(t.speaker, note);
        const echo = !!t.lines[0].echo;
        return call ? (
          <div key={t.key} className={`turn turn-${t.speaker} ${echo ? 'turn-echo' : ''}`}>
            <div className="turn-head">
              <span className="who">{who}</span>
              <span className="ts">{formatClock(t.startMs)}</span>
              {echo && <span className="ts">· echo of the call, not sent to the AI</span>}
            </div>
            <div className="bubble">{t.lines.map((l) => l.text).join(' ')}</div>
          </div>
        ) : (
          t.lines.map((s) => (
            <div className="seg-row" key={s.index}>
              <span className="ts">{formatClock(s.startMs)}</span>
              <div className="text">{s.text}</div>
            </div>
          ))
        );
      })}
      {live && (
        <div className="listening">
          {props.paused ? (
            <span>Paused. Resume to keep transcribing.</span>
          ) : (
            <>
              <LevelBars speaker="me" count={10} height={16} labelled />
              {call && <LevelBars speaker="them" count={10} height={16} labelled />}
              <span>{segments.length ? 'Listening…' : 'Listening… the first lines appear within a few seconds of someone speaking.'}</span>
            </>
          )}
        </div>
      )}
      {transcribing && (
        <div className="listening">
          <span className="spinner" /> Transcribing the last part…
        </div>
      )}
      {!live && !transcribing && !segments.length && (
        <Empty title="No transcript" text={pending ? 'Some audio is waiting to be transcribed.' : 'No speech was picked up in this recording.'} />
      )}
      {echoes > 0 && (
        <p className="field-hint" style={{ marginTop: 14 }}>
          {echoes} line{echoes === 1 ? '' : 's'} from your microphone repeated the call (your mic heard your speakers) and{' '}
          {echoes === 1 ? 'is' : 'are'} left out. Headphones avoid this.{' '}
          <button className="link-quiet" onClick={() => setShowEcho((s) => !s)}>
            {showEcho ? 'Hide' : 'Show'}
          </button>
        </p>
      )}
    </div>
  );
}

// -------------------------------------------------------------------- dock

function RecordingDock(props: { recording: RecordingState; note: Note; segments: Segment[]; onTranscript: () => void }) {
  const { recording, note } = props;
  const now = useNow(!recording.paused);
  const last = [...props.segments].reverse().find((s) => !s.echo);
  const call = note.sources !== 'mic';

  const command = (type: 'PAUSE' | 'RESUME' | 'STOP') =>
    bridge.recorder.call({ type }).then(
      (r) => !r.ok && toast(r.error ?? 'Something went wrong.', 'error'),
      (e) => toast(errorMessage(e), 'error'),
    );

  return (
    <div className="rec-dock" role="region" aria-label="Recording">
      <span className={`rec-dot ${recording.paused ? 'paused' : ''}`} />
      <span className="mono rec-time">{formatClock(elapsedMs(recording, now))}</span>
      {!recording.paused && (
        <span className="row" style={{ gap: 10 }}>
          <LevelBars speaker="me" labelled />
          {call && <LevelBars speaker="them" labelled />}
        </span>
      )}
      <button className="dock-line truncate" onClick={props.onTranscript} title="Show the transcript">
        {recording.paused
          ? 'Paused'
          : last
            ? `${speakerLabel(last.speaker, note) ? `${speakerLabel(last.speaker, note)}: ` : ''}${last.text}`
            : 'Listening…'}
      </button>
      <button className="btn btn-sm" onClick={() => command(recording.paused ? 'RESUME' : 'PAUSE')}>
        {recording.paused ? <IconPlay size={12} /> : <IconPause size={12} />}
        {recording.paused ? 'Resume' : 'Pause'}
      </button>
      <button className="btn btn-sm btn-light" onClick={() => command('STOP')}>
        <IconStop size={12} /> Stop
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ shared

function TitleField({ value, onCommit }: { value: string; onCommit: (title: string) => void }) {
  const [text, setText] = useState(value);
  const focused = useRef(false);
  const cancelled = useRef(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);

  useAutosize(ref, text, 0);

  return (
    <textarea
      ref={ref}
      className="note-title-input"
      rows={1}
      aria-label="Meeting title"
      value={text}
      onFocus={() => {
        focused.current = true;
        cancelled.current = false;
      }}
      onBlur={() => {
        focused.current = false;
        const title = text.replace(/\s+/g, ' ').trim();
        if (!cancelled.current && title && title !== value) onCommit(title);
        else setText(value);
      }}
      onChange={(e) => setText(e.target.value.replace(/\n/g, ''))}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          cancelled.current = true;
          e.currentTarget.blur();
        }
      }}
    />
  );
}

/** Grows a textarea to fit its content (and re-measures on resize). */
function useAutosize(ref: RefObject<HTMLTextAreaElement | null>, content: string, minHeight: number) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.style.height = '0px';
      el.style.height = `${Math.max(minHeight, el.scrollHeight)}px`;
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [ref, content, minHeight]);
}

/** Keeps the newest transcript line in view while recording, unless the user scrolled up. */
function useFollow(count: number, enabled: boolean) {
  const endRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const lastCount = useRef(count);

  useEffect(() => {
    const onScroll = () => {
      const el = document.scrollingElement;
      if (el) nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 240;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const grew = count > lastCount.current;
    lastCount.current = count;
    if (enabled && grew && nearBottom.current) endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [count, enabled]);

  return endRef;
}

export function Skeleton({ lines }: { lines: number }) {
  return (
    <div className="skeleton" aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} style={{ width: `${[92, 78, 85, 64, 88, 72, 50][i % 7]}%` }} />
      ))}
    </div>
  );
}

export function Empty({ title, text, action }: { title: string; text: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <p>{text}</p>
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  );
}

