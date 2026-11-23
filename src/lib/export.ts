import { formatClock, formatDate, formatDuration } from './format';
import { speakerLabel } from './pipeline';
import type { ChatMessage, Folder, Note, Segment } from './types';

function header(note: Note, folder?: Folder): string {
  const meta = [folder?.name, formatDate(note.createdAt), note.durationMs ? formatDuration(note.durationMs) : '', note.app]
    .filter(Boolean)
    .join(' · ');
  return [`# ${note.title}`, '', `_${meta}_`].join('\n');
}

export function noteToMarkdown(note: Note, folder: Folder | undefined, segments: Segment[], chat: ChatMessage[] = []): string {
  const parts = [header(note, folder)];
  if (note.summary) parts.push(note.summary.trim());
  if (note.myNotes.trim()) parts.push(`## My notes\n\n${note.myNotes.trim()}`);
  const qa = chat.filter((m) => !m.error && m.content.trim() && m.kind !== 'compaction');
  if (qa.length) {
    const turns = qa.map((m) => (m.role === 'user' ? `**Q:** ${m.content.trim()}` : m.content.trim()));
    parts.push(`## Questions and answers\n\n${turns.join('\n\n')}`);
  }
  const lines = segments.filter((s) => !s.echo);
  if (lines.length) {
    const body = lines.map((s) => {
      const who = speakerLabel(s.speaker, note);
      return `**[${formatClock(s.startMs)}]**${who ? ` **${who}:**` : ''} ${s.text}`;
    });
    parts.push(`## Transcript\n\n${body.join('\n\n')}`);
  }
  return parts.join('\n\n') + '\n';
}

/** Every meeting's notes in a folder, oldest first. */
export function folderToMarkdown(folder: Folder, notes: Note[]): string {
  const ordered = [...notes].sort((a, b) => a.createdAt - b.createdAt);
  const parts = [`# ${folder.name}`];
  if (folder.description) parts.push(folder.description);
  for (const note of ordered) {
    const body = [header(note).replace(/^# /, '## ')];
    // Demote the notes' headings one level so they nest under the meeting.
    if (note.summary) body.push(note.summary.trim().replace(/^(#{1,5}) /gm, '#$1 '));
    if (note.myNotes.trim()) body.push(`### My notes\n\n${note.myNotes.trim()}`);
    if (!note.summary && !note.myNotes.trim()) body.push('_No notes yet._');
    parts.push(body.join('\n\n'));
  }
  return parts.join('\n\n---\n\n') + '\n';
}

export function safeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'toru';
}

/** Saves through Electron's download flow, which asks where to put the file. */
export function downloadFile(filename: string, content: string, type = 'text/markdown'): void {
  const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
