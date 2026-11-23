// The floating widget: a small always-on-top window at the side of the screen.
// It offers to take notes when a call starts, shows the recording while
// TORU's own window is in the background, counts down when the call ends,
// and says when the notes are ready.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { bridge } from '../lib/bridge';
import { errorMessage, formatClock } from '../lib/format';
import { speakerLabel } from '../lib/pipeline';
import * as store from '../lib/store';
import type { WidgetState } from '../shared/bridge';
import { LevelBars } from '../ui/components/bits';
import { elapsedMs, useLive, useNote, useNow, useRecording } from '../ui/hooks';
import { IconChevronDown, IconChevronUp, IconExternal, IconGrip, IconMic, IconPause, IconPlay, IconStop, IconX, LogoMark } from '../ui/icons';

function useWidgetState(): WidgetState {
  const [state, setState] = useState<WidgetState>({ mode: 'hidden' });
  useEffect(() => {
    bridge.widget.state().then(setState, () => {});
    return bridge.widget.onState(setState);
  }, []);
  return state;
}

/** Tells the main process how tall the widget's content is, so the window fits it. */
function useFitWindow() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const report = () => bridge.widget.act({ type: 'size', height: Math.ceil(el.getBoundingClientRect().height) + 16 });
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return ref;
}

function call(type: 'PAUSE' | 'RESUME' | 'STOP') {
  void bridge.recorder.call({ type }).catch((e) => console.error(errorMessage(e)));
}

export function Widget() {
  const state = useWidgetState();
  const ref = useFitWindow();
  return (
    <div ref={ref} className="widget-wrap">
      {state.mode === 'prompt' && <Prompt app={state.app} />}
      {state.mode === 'recording' && <Recording />}
      {state.mode === 'ending' && <Ending app={state.app} until={state.until} />}
      {state.mode === 'done' && <Done noteId={state.noteId} />}
    </div>
  );
}

function Prompt({ app }: { app: string }) {
  return (
    <div className="pill pill-card">
      <div className="pill-row">
        <span className="pill-icon">
          <IconMic size={15} />
        </span>
        <div className="pill-text">
          <strong>{app} is using your mic</strong>
          <span>On a call? TORU can take notes.</span>
        </div>
        <button className="wicon" aria-label="Not now" title="Not now" onClick={() => bridge.widget.act({ type: 'dismiss' })}>
          <IconX size={14} />
        </button>
      </div>
      <div className="pill-actions">
        <button className="wbtn wbtn-primary" onClick={() => bridge.widget.act({ type: 'start' })}>
          Take notes
        </button>
      </div>
    </div>
  );
}

function Recording() {
  const recording = useRecording();
  const note = useNote(recording?.noteId ?? '');
  const now = useNow(!!recording && !recording.paused);
  const [open, setOpen] = useState(false);
  // Only the last few lines are shown, so only the last few are read.
  const segments = useLive(
    () => (recording ? store.getRecentSegments(recording.noteId, 10) : Promise.resolve([])),
    [recording?.noteId],
    (e) => e.type === 'segments' && e.noteId === recording?.noteId,
  );
  if (!recording) return null;
  const call2 = recording.sources !== 'mic';
  const lines = (segments ?? []).filter((s) => !s.echo).slice(-4);

  return (
    <div className={`pill pill-rec ${open ? 'open' : ''}`}>
      <div className="pill-row">
        <span className="grip" aria-hidden="true">
          <IconGrip size={14} />
        </span>
        <span className={`rec-dot ${recording.paused ? 'paused' : ''}`} />
        <div className="pill-text">
          <strong className="truncate">{note?.title ?? 'Recording'}</strong>
          <span className="mono">{recording.paused ? 'Paused' : formatClock(elapsedMs(recording, now))}</span>
        </div>
        {!recording.paused && (
          <span className="pill-levels">
            <LevelBars speaker="me" count={6} height={14} />
            {call2 && <LevelBars speaker="them" count={6} height={14} />}
          </span>
        )}
        <button
          className="wicon"
          aria-label={recording.paused ? 'Resume' : 'Pause'}
          title={recording.paused ? 'Resume' : 'Pause'}
          onClick={() => call(recording.paused ? 'RESUME' : 'PAUSE')}
        >
          {recording.paused ? <IconPlay size={13} /> : <IconPause size={13} />}
        </button>
        <button className="wicon wicon-stop" aria-label="Stop" title="Stop recording" onClick={() => call('STOP')}>
          <IconStop size={12} />
        </button>
        <button className="wicon" aria-label={open ? 'Collapse' : 'Show transcript'} title={open ? 'Collapse' : 'Show transcript'} onClick={() => setOpen((o) => !o)}>
          {open ? <IconChevronUp size={15} /> : <IconChevronDown size={15} />}
        </button>
      </div>
      {open && note && (
        <div className="pill-body">
          <div className="pill-lines">
            {lines.length ? (
              lines.map((s) => {
                const who = speakerLabel(s.speaker, note);
                return (
                  <p key={s.index} className={`pill-line line-${s.speaker}`}>
                    {who && <b>{who}</b>} {s.text}
                  </p>
                );
              })
            ) : (
              <p className="pill-line faint">Listening… lines appear a few seconds after someone speaks.</p>
            )}
          </div>
          <QuickNote noteId={note.id} />
          <button className="wbtn" onClick={() => bridge.widget.act({ type: 'open-note', noteId: note.id })}>
            <IconExternal size={12} /> Open the notepad
          </button>
        </div>
      )}
    </div>
  );
}

/** Adds a bullet to the meeting's notes without opening TORU. */
function QuickNote({ noteId }: { noteId: string }) {
  const [text, setText] = useState('');
  const [saved, setSaved] = useState(false);
  const add = async () => {
    const line = text.trim();
    if (!line) return;
    setText('');
    await store.updateNote(noteId, (n) => ({ myNotes: `${n.myNotes.replace(/\s+$/, '')}${n.myNotes.trim() ? '\n' : ''}- ${line}` }));
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };
  return (
    <form
      className="quick-note"
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder={saved ? 'Added to your notes ✓' : 'Jot a note… (Enter)'} aria-label="Add a note" />
    </form>
  );
}

function Ending({ app, until }: { app: string; until: number }) {
  const now = useNow(true, 250);
  const left = Math.max(0, Math.ceil((until - now) / 1000));
  return (
    <div className="pill pill-card">
      <div className="pill-row">
        <span className="pill-icon">
          <IconStop size={12} />
        </span>
        <div className="pill-text">
          <strong>Has the {app} call ended?</strong>
          <span>TORU stops recording in {left} s.</span>
        </div>
      </div>
      <div className="pill-actions">
        <button className="wbtn wbtn-primary" onClick={() => call('STOP')}>
          Stop now
        </button>
        <button className="wbtn" onClick={() => bridge.widget.act({ type: 'keep-going' })}>
          Keep recording
        </button>
      </div>
    </div>
  );
}

function Done({ noteId }: { noteId: string }) {
  const note = useNote(noteId);
  if (note === undefined) return null;
  const text =
    note === null
      ? 'Nothing was said, so nothing was saved.'
      : note.status === 'summarizing'
        ? 'Enhancing your notes…'
        : note.status === 'processing'
          ? 'Transcribing the last part…'
          : note.status === 'error'
            ? 'Needs attention'
            : note.summary
              ? 'Your notes are ready'
              : 'Transcript saved';
  const busy = note && (note.status === 'summarizing' || note.status === 'processing');
  return (
    <div className="pill pill-prompt">
      <span className="pill-icon pill-logo">
        <LogoMark size={22} />
      </span>
      <div className="pill-text">
        <strong className="truncate">{note?.title ?? 'Meeting'}</strong>
        <span className="row" style={{ gap: 6 }}>
          {busy && <span className="spinner" />} {text}
        </span>
      </div>
      {note && (
        <button className="wbtn wbtn-primary" onClick={() => bridge.widget.act({ type: 'open-note', noteId })}>
          Open
        </button>
      )}
      <button className="wicon" aria-label="Close" onClick={() => bridge.widget.act({ type: 'dismiss' })}>
        <IconX size={14} />
      </button>
    </div>
  );
}
