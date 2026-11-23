// TORU's main window: sidebar (search, home, folders, live meeting) and the
// pages: home, a folder, a meeting, search results.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { bridge } from '../lib/bridge';
import { subscribe } from '../lib/events';
import { downloadFile, folderToMarkdown, safeFilename } from '../lib/export';
import { dayLabel, errorMessage, formatClock, formatDate, formatDuration, partOfDay } from '../lib/format';
import * as store from '../lib/store';
import type { AudioSources, Folder, Note, RecordingState } from '../lib/types';
import { FolderDot, NoteRow } from '../ui/components/bits';
import { FolderModal } from '../ui/components/FolderModal';
import { Empty, NoteView, Skeleton } from '../ui/components/NoteView';
import { Select } from '../ui/components/Select';
import { SettingsModal } from '../ui/components/SettingsModal';
import { elapsedMs, useDebouncedValue, useFolders, useNote, useNotes, useNow, useRecording, useSettings } from '../ui/hooks';
import { IconDownload, IconHome, IconMic, IconPencil, IconPlus, IconRecord, IconSearch, IconSettings, IconStop, IconUsers, Logo } from '../ui/icons';
import { toast, Toaster } from '../ui/toast';
import { releaseSearchCache, searchNotes, searchTerms, type SearchResult } from './search';

type Route = { name: 'home' } | { name: 'folder'; id: string } | { name: 'note'; id: string };

function parseRoute(hash: string): Route {
  const [kind, ...rest] = hash.replace(/^#\/?/, '').split('/');
  const id = decodeURIComponent(rest.join('/'));
  if (kind === 'folder' && id) return { name: 'folder', id };
  if (kind === 'note' && id) return { name: 'note', id };
  return { name: 'home' };
}

function useRoute(): Route {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const onChange = () => {
      setHash(location.hash);
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return useMemo(() => parseRoute(hash), [hash]);
}

const go = (path: string) => {
  location.hash = path;
};

/** Call apps using the microphone right now (from the main process). */
function useMeetingApps(): string[] {
  const [apps, setApps] = useState<string[]>([]);
  useEffect(() => {
    bridge.meetings.active().then(setApps, () => {});
    return bridge.meetings.onChange(setApps);
  }, []);
  return apps;
}

interface StartOptions {
  sources: AudioSources;
  folderId?: string;
  app?: string;
}

type ModalState = null | { kind: 'settings' } | { kind: 'folder'; folder?: Folder };

export function App() {
  const route = useRoute();
  const folders = useFolders();
  const notes = useNotes();
  const recording = useRecording();
  const settings = useSettings();
  const apps = useMeetingApps();
  const [modal, setModal] = useState<ModalState>(null);
  const [query, setQuery] = useState('');
  const [starting, setStarting] = useState(false);
  const searchQuery = useDebouncedValue(query.trim(), 250, (q) => q === '');

  useEffect(() => {
    store.ensureInbox().catch(console.error);
  }, []);

  // The main process navigates here from the tray, the widget and notifications.
  useEffect(
    () =>
      bridge.app.onNavigate((target) => {
        const [path, search] = target.split('?');
        const error = new URLSearchParams(search ?? '').get('error');
        if (error) toast(error, 'error');
        go(path || '/');
      }),
    [],
  );

  useEffect(() => {
    setQuery('');
  }, [route]);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const n of notes ?? []) map.set(n.folderId, (map.get(n.folderId) ?? 0) + 1);
    return map;
  }, [notes]);

  async function start(opts: StartOptions) {
    if (!settings?.apiKey) {
      setModal({ kind: 'settings' });
      toast('Add your OpenAI API key to start taking notes.');
      return;
    }
    setStarting(true);
    try {
      const reply = await bridge.recorder.call({ type: 'START', ...opts });
      if (!reply.ok) toast(reply.error ?? 'Couldn’t start recording.', 'error');
      else if (reply.noteId) go(`/note/${reply.noteId}`);
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setStarting(false);
    }
  }

  const folderById = (id: string) => folders?.find((f) => f.id === id);
  const activeFolderId = route.name === 'folder' ? route.id : undefined;

  let content: ReactNode;
  if (query.trim()) {
    content = <SearchView query={searchQuery} typed={query.trim()} folders={folders ?? []} liveNoteId={recording?.noteId} />;
  } else if (route.name === 'folder') {
    content = (
      <FolderView
        folder={folderById(route.id)}
        loaded={!!folders}
        notes={notes?.filter((n) => n.folderId === route.id)}
        liveNoteId={recording?.noteId}
        onEdit={(folder) => setModal({ kind: 'folder', folder })}
      />
    );
  } else if (route.name === 'note') {
    content = <NoteRoute noteId={route.id} folders={folders ?? []} recording={recording} />;
  } else {
    content = (
      <HomeView
        folders={folders}
        notes={notes}
        settings={settings}
        recording={recording}
        apps={apps}
        starting={starting}
        onStart={start}
        onNewFolder={() => setModal({ kind: 'folder' })}
        onSettings={() => setModal({ kind: 'settings' })}
      />
    );
  }

  return (
    <div className="app">
      <aside className="side">
        <div className="side-top">
          <a href="#/" className="logo-link" aria-label="TORU home">
            <Logo size={24} />
          </a>
        </div>

        <div className="search">
          <IconSearch size={15} />
          <input
            className="input"
            type="search"
            placeholder="Search meetings"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
          />
        </div>

        <nav className="nav">
          <a className={`nav-item ${route.name === 'home' && !query ? 'active' : ''}`} href="#/">
            <IconHome size={15} /> Home
          </a>
        </nav>

        <div>
          <div className="nav-head">
            <span className="eyebrow">Folders</span>
            <button className="icon-btn" style={{ width: 26, height: 26 }} aria-label="New folder" title="New folder" onClick={() => setModal({ kind: 'folder' })}>
              <IconPlus size={14} />
            </button>
          </div>
          <nav className="nav">
            {folders?.map((f) => (
              <a key={f.id} href={`#/folder/${f.id}`} className={`nav-item ${activeFolderId === f.id && !query ? 'active' : ''}`}>
                <FolderDot folder={f} />
                <span className="truncate">{f.name}</span>
                <span className="count">{counts.get(f.id) ?? 0}</span>
              </a>
            ))}
          </nav>
        </div>

        <div className="side-foot">
          {recording && <LiveCard recording={recording} />}
          <button className="nav-item" onClick={() => setModal({ kind: 'settings' })}>
            <IconSettings size={15} /> Settings
          </button>
        </div>
      </aside>

      <main className="main">
        <div className="main-top" />
        {content}
      </main>

      {modal?.kind === 'settings' && settings && <SettingsModal initial={settings} onClose={() => setModal(null)} />}
      {modal?.kind === 'folder' && (
        <FolderModal
          folder={modal.folder}
          onClose={() => setModal(null)}
          onSaved={(f) => !modal.folder && go(`/folder/${f.id}`)}
          onDeleted={() => go('/')}
        />
      )}
      <Toaster />
    </div>
  );
}

function stopRecording() {
  bridge.recorder.call({ type: 'STOP' }).then(
    (r) => !r.ok && toast(r.error ?? 'Couldn’t stop.', 'error'),
    (e) => toast(errorMessage(e), 'error'),
  );
}

function LiveCard({ recording }: { recording: RecordingState }) {
  const note = useNote(recording.noteId);
  const now = useNow(!recording.paused);
  return (
    <div className="live-card">
      <div className="row">
        <span className={`rec-dot ${recording.paused ? 'paused' : ''}`} />
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>{recording.paused ? 'Paused' : 'Recording'}</span>
        <span className="grow" />
        <span className="mono faint" style={{ fontSize: 12.5 }}>
          {formatClock(elapsedMs(recording, now))}
        </span>
      </div>
      <a className="live-title clamp-2" href={`#/note/${recording.noteId}`}>
        {note?.title ?? '…'}
      </a>
      <button className="btn btn-sm btn-light" onClick={stopRecording}>
        <IconStop size={12} /> Stop recording
      </button>
    </div>
  );
}

// -------------------------------------------------------------------- home

function groupByDay(notes: Note[]): [string, Note[]][] {
  const groups = new Map<string, Note[]>();
  for (const n of notes) {
    const day = dayLabel(n.createdAt);
    const list = groups.get(day);
    if (list) list.push(n);
    else groups.set(day, [n]);
  }
  return [...groups];
}

function MeetingList(props: { notes: Note[]; folders: Folder[]; showFolder?: boolean; liveNoteId?: string; limit?: number }) {
  const [limit, setLimit] = useState(props.limit ?? 40);
  const shown = props.notes.slice(0, limit);
  return (
    <>
      {groupByDay(shown).map(([day, list]) => (
        <section key={day} className="day">
          <h2 className="day-title">{day}</h2>
          <div className="note-list">
            {list.map((n) => (
              <NoteRow
                key={n.id}
                note={n}
                folder={props.folders.find((f) => f.id === n.folderId)}
                showFolder={props.showFolder}
                liveNoteId={props.liveNoteId}
                onOpen={() => go(`/note/${n.id}`)}
              />
            ))}
          </div>
        </section>
      ))}
      {props.notes.length > shown.length && (
        <button className="btn btn-sm" style={{ marginTop: 18 }} onClick={() => setLimit((l) => l + 40)}>
          Show older meetings
        </button>
      )}
    </>
  );
}

function HomeView(props: {
  folders?: Folder[];
  notes?: Note[];
  settings?: ReturnType<typeof useSettings>;
  recording: RecordingState | null | undefined;
  apps: string[];
  starting: boolean;
  onStart: (opts: StartOptions) => void;
  onNewFolder: () => void;
  onSettings: () => void;
}) {
  const { folders, notes, settings, recording, apps } = props;
  if (!folders || !notes || !settings) return <Skeleton lines={6} />;
  const firstRun = notes.length === 0;
  const total = notes.reduce((sum, n) => sum + n.durationMs, 0);
  const today = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());

  return (
    <div className="page">
      <div className="eyebrow">{today}</div>
      <h1 className="hero">Good {partOfDay()}</h1>
      <p className="lede">
        {firstRun
          ? 'TORU listens to your calls and meetings, transcribes them as they happen, and turns your rough notes into clear ones afterwards. Nothing joins the call.'
          : `${notes.length} ${notes.length === 1 ? 'meeting' : 'meetings'} · ${formatDuration(total)} transcribed`}
      </p>

      {recording ? (
        <LiveBanner recording={recording} />
      ) : (
        <>
          {apps.length > 0 && (
            <div className="detected" role="status">
              <span className="detected-icon">
                <IconMic size={16} />
              </span>
              <div className="grow">
                <strong>{apps.join(' and ')}</strong> {apps.length === 1 ? 'is' : 'are'} using your microphone.
                <span className="muted"> On a call?</span>
              </div>
              <button className="btn btn-primary btn-sm" disabled={props.starting} onClick={() => props.onStart({ sources: 'both', app: apps[0] })}>
                <IconRecord size={11} /> Take notes
              </button>
            </div>
          )}
          <StartCard folders={folders} settings={settings} starting={props.starting} onStart={props.onStart} onNewFolder={props.onNewFolder} />
        </>
      )}

      {firstRun && (
        <div className="steps">
          <Step n={1} title="Add your OpenAI key" done={!!settings.apiKey}>
            Used for transcription and notes, billed to your own account.{' '}
            {!settings.apiKey && (
              <button className="link-btn" onClick={props.onSettings}>
                Open settings
              </button>
            )}
          </Step>
          <Step n={2} title="Join a call">
            Teams, Zoom, Slack, Meet in a browser… When the call app picks up your mic, TORU offers to take notes.
          </Step>
          <Step n={3} title="Jot, then enhance">
            Type a few words per point while you talk. When the call ends, TORU writes the full notes around them.
          </Step>
        </div>
      )}

      {!firstRun && <MeetingList notes={notes} folders={folders} showFolder liveNoteId={recording?.noteId} />}
    </div>
  );
}

function LiveBanner({ recording }: { recording: RecordingState }) {
  const note = useNote(recording.noteId);
  const now = useNow(!recording.paused);
  return (
    <div className="start-card live">
      <div className="row" style={{ gap: 10 }}>
        <span className={`rec-dot ${recording.paused ? 'paused' : ''}`} />
        <span className="eyebrow">{recording.paused ? 'Paused' : 'Recording'}</span>
        <span className="mono faint">{formatClock(elapsedMs(recording, now))}</span>
      </div>
      <h2 className="start-title">{note?.title ?? '…'}</h2>
      <div className="row">
        <a className="btn btn-primary" href={`#/note/${recording.noteId}`}>
          Open the notepad
        </a>
        <button className="btn" onClick={stopRecording}>
          <IconStop size={12} /> Stop
        </button>
      </div>
    </div>
  );
}

function StartCard(props: {
  folders: Folder[];
  settings: NonNullable<ReturnType<typeof useSettings>>;
  starting: boolean;
  onStart: (opts: StartOptions) => void;
  onNewFolder: () => void;
}) {
  const { folders, settings } = props;
  const [sources, setSources] = useState<AudioSources>(settings.sources);
  const folderId = folders.some((f) => f.id === settings.lastFolderId) ? settings.lastFolderId! : store.INBOX_ID;
  return (
    <section className="start-card">
      <div>
        <h2 className="start-title">New meeting notes</h2>
        <p className="muted" style={{ margin: '4px 0 0' }}>
          {sources === 'both'
            ? 'Listens to your microphone (Me) and everything your computer plays (Them): Teams, Zoom, Slack, Meet…'
            : 'Listens to your microphone only: for meetings in the room, lectures and interviews.'}
        </p>
      </div>
      <div className="start-controls">
        <div className="seg" role="radiogroup" aria-label="What to listen to">
          <button role="radio" aria-checked={sources === 'both'} aria-selected={sources === 'both'} onClick={() => setSources('both')}>
            <IconUsers size={14} /> Call
          </button>
          <button role="radio" aria-checked={sources === 'mic'} aria-selected={sources === 'mic'} onClick={() => setSources('mic')}>
            <IconMic size={14} /> In person
          </button>
        </div>
        <Select
          variant="pill"
          ariaLabel="Folder"
          title="Save to folder"
          value={folderId}
          options={folders.map((f) => ({ value: f.id, label: f.name, dot: f.color }))}
          onChange={(id) => void store.saveSettings({ lastFolderId: id })}
          action={{ label: 'New folder…', icon: <IconPlus size={14} />, onSelect: props.onNewFolder }}
        />
        <span className="grow" />
        <button className="btn btn-primary btn-lg" disabled={props.starting} onClick={() => props.onStart({ sources, folderId })}>
          <IconRecord size={13} /> {props.starting ? 'Starting…' : 'Start'}
        </button>
      </div>
      <p className="hint">
        Or press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>R</kbd> anywhere. Headphones give the cleanest transcript.
      </p>
    </section>
  );
}

function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children: ReactNode }) {
  return (
    <div className={`step ${done ? 'done' : ''}`}>
      <span className="step-n">{done ? '✓' : n}</span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

// ------------------------------------------------------------------ folder

function FolderView(props: { folder?: Folder; loaded: boolean; notes?: Note[]; liveNoteId?: string; onEdit: (f: Folder) => void }) {
  const { folder, notes } = props;
  if (!props.loaded || !notes) return <Skeleton lines={6} />;
  if (!folder) return <Empty title="Folder not found" text="It may have been deleted." />;
  const total = notes.reduce((sum, n) => sum + n.durationMs, 0);

  return (
    <div className="page">
      <div className="row eyebrow" style={{ gap: 8 }}>
        <FolderDot folder={folder} /> Folder
      </div>
      <h1 className="hero">{folder.name}</h1>
      {folder.description && <p className="lede">{folder.description}</p>}
      <div className="project-bar">
        <div className="meta-row">
          <span className="chip">
            {notes.length} {notes.length === 1 ? 'meeting' : 'meetings'}
          </span>
          {total > 0 && <span className="chip">{formatDuration(total)}</span>}
        </div>
        <div className="row">
          <button className="btn btn-sm" onClick={() => props.onEdit(folder)}>
            <IconPencil size={13} /> Edit
          </button>
          <button
            className="btn btn-sm"
            disabled={!notes.length}
            onClick={() => downloadFile(`${safeFilename(folder.name)} — notes.md`, folderToMarkdown(folder, notes))}
          >
            <IconDownload size={13} /> Export notes
          </button>
        </div>
      </div>
      {notes.length === 0 ? (
        <Empty title="No meetings here yet" text="Pick this folder on the home page before you start, or move a meeting here from its page." />
      ) : (
        <MeetingList notes={notes} folders={[folder]} liveNoteId={props.liveNoteId} />
      )}
    </div>
  );
}

function NoteRoute({ noteId, folders, recording }: { noteId: string; folders: Folder[]; recording: RecordingState | null | undefined }) {
  const note = useNote(noteId);
  const folder = note ? folders.find((f) => f.id === note.folderId) : undefined;
  return (
    <div className="page page-note">
      <NoteView
        noteId={noteId}
        recording={recording}
        back={
          folder && (
            <a className="btn btn-ghost btn-sm back" href={`#/folder/${folder.id}`}>
              ← {folder.name}
            </a>
          )
        }
        onDeleted={() => go(folder ? `/folder/${folder.id}` : '/')}
      />
    </div>
  );
}

// ------------------------------------------------------------------ search

function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>;
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return <>{text.split(re).map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : part))}</>;
}

/** Runs the search when the (debounced) query changes, keeping the previous results on screen meanwhile. */
function useSearch(query: string): SearchResult[] | undefined {
  const [results, setResults] = useState<SearchResult[]>();
  const latest = useRef(query);
  latest.current = query;

  useEffect(() => {
    if (!query) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = () =>
      searchNotes(query).then(
        (r) => alive && latest.current === query && setResults(r),
        (e) => console.error('[toru] search failed', e),
      );
    run();
    // Refresh when notes change (e.g. a live meeting gets new lines), at most every 400 ms.
    const unsubscribe = subscribe((e) => {
      if (e.type !== 'notes' && e.type !== 'segments') return;
      timer ??= setTimeout(() => {
        timer = undefined;
        run();
      }, 400);
    });
    return () => {
      alive = false;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [query]);

  return query ? results : undefined;
}

function SearchView(props: { query: string; typed: string; folders: Folder[]; liveNoteId?: string }) {
  const { query, folders, liveNoteId } = props;
  const results = useSearch(query);
  const terms = searchTerms(query);
  useEffect(() => releaseSearchCache, []); // give the memory back when search closes
  return (
    <div className="page">
      <div className="eyebrow">Search</div>
      <h1 className="hero" style={{ fontSize: 'clamp(34px, 4vw, 48px)' }}>
        “{props.typed}”
      </h1>
      {!results ? (
        <Skeleton lines={4} />
      ) : results.length === 0 ? (
        <Empty title="No matches" text="Try fewer or different words. Titles, notes and transcripts are searched." />
      ) : (
        <>
          <p className="lede">
            {results.length} {results.length === 1 ? 'meeting' : 'meetings'}
          </p>
          <div className="note-list">
            {results.map(({ note, snippet }) => {
              const folder = folders.find((f) => f.id === note.folderId);
              return (
                <button key={note.id} className="note-row" onClick={() => go(`/note/${note.id}`)}>
                  <div className="note-row-title">
                    <span className="truncate">
                      <Highlight text={note.title} terms={terms} />
                    </span>
                  </div>
                  <div className="note-row-meta">
                    {folder && (
                      <span className="row" style={{ gap: 6 }}>
                        <FolderDot folder={folder} size={6} /> {folder.name}
                      </span>
                    )}
                    <span>{formatDate(note.createdAt)}</span>
                    {liveNoteId === note.id && <span className="chip chip-red">Recording</span>}
                  </div>
                  {snippet && (
                    <div className="note-row-preview clamp-2">
                      <Highlight text={snippet} terms={terms} />
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
