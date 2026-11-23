import { useCallback, useState, type ReactNode } from 'react';
import { formatDuration, timeOfDay } from '../../lib/format';
import type { Folder, Note, Speaker } from '../../lib/types';
import { useDismiss, useLevels } from '../hooks';
import { IconMic, IconMore, IconSpeaker } from '../icons';
import { summaryPreview } from '../Markdown';

export function StatusChip({ note, live, paused }: { note: Note; live?: boolean; paused?: boolean }) {
  if (live) {
    return (
      <span className={`chip ${paused ? '' : 'chip-red'}`}>
        <span className={`rec-dot ${paused ? 'paused' : ''}`} /> {paused ? 'Paused' : 'Recording'}
      </span>
    );
  }
  switch (note.status) {
    case 'recording':
    case 'processing':
    case 'interrupted':
      return (
        <span className="chip chip-busy">
          <span className="spinner" /> Transcribing
        </span>
      );
    case 'summarizing':
      return (
        <span className="chip chip-busy">
          <span className="spinner" /> Enhancing notes
        </span>
      );
    case 'error':
      return <span className="chip chip-red">Needs attention</span>;
    default:
      return null;
  }
}

/** A small live meter for one channel ("me" = mic, "them" = computer audio). */
export function LevelBars({
  speaker,
  count = 14,
  height = 18,
  labelled,
}: {
  speaker: Speaker;
  count?: number;
  height?: number;
  labelled?: boolean;
}) {
  const levels = useLevels(count)[speaker];
  const Icon = speaker === 'me' ? IconMic : IconSpeaker;
  return (
    <span className={`level-group level-${speaker}`} title={speaker === 'me' ? 'Your microphone' : 'Computer audio (the call)'}>
      {labelled && <Icon size={14} />}
      <span className="level" style={{ height }} aria-hidden="true">
        {levels.map((l, i) => (
          <span key={i} style={{ height: Math.max(3, Math.min(1, Math.pow(l * 9, 0.7)) * height) }} />
        ))}
      </span>
    </span>
  );
}

export function FolderDot({ folder, size = 8 }: { folder?: Folder; size?: number }) {
  return <span className="dot" style={{ width: size, height: size, background: folder?.color ?? 'var(--text-3)' }} />;
}

export function NoteRow(props: {
  note: Note;
  folder?: Folder;
  showFolder?: boolean;
  liveNoteId?: string;
  onOpen: () => void;
}) {
  const { note } = props;
  const preview = summaryPreview(note.summary) || note.myNotes.trim().split('\n')[0];
  const live = props.liveNoteId === note.id;
  return (
    <button className="note-row" onClick={props.onOpen}>
      <div className="note-row-title">
        <span className="truncate">{note.title}</span>
      </div>
      <div className="note-row-meta">
        <span>
          {[timeOfDay(note.createdAt), note.durationMs > 0 && formatDuration(note.durationMs), note.app, note.sources === 'mic' && 'In person']
            .filter(Boolean)
            .join(' · ')}
        </span>
        {props.showFolder && props.folder && (
          <span className="row" style={{ gap: 6 }}>
            <FolderDot folder={props.folder} size={6} />
            {props.folder.name}
          </span>
        )}
        <StatusChip note={note} live={live} />
      </div>
      {preview && <div className="note-row-preview clamp-2">{preview}</div>}
    </button>
  );
}

export function Menu({
  label,
  children,
  icon,
}: {
  label: string;
  icon?: ReactNode;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="icon-btn" aria-label={label} title={label} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {icon ?? <IconMore />}
      </button>
      {open && (
        <div className="menu" role="menu">
          {children(close)}
        </div>
      )}
    </div>
  );
}
