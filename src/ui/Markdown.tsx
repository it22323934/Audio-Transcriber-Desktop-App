// A small Markdown renderer that builds React elements directly (no
// innerHTML), so model output can never inject markup into the extension.
import type { ReactNode } from 'react';

interface ListNode {
  ordered: boolean;
  start: number;
  items: { text: string; children: ListNode[] }[];
}

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; list: ListNode }
  | { kind: 'code'; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'hr' };

interface ListLine {
  indent: number;
  ordered: boolean;
  num: number;
  text: string;
}

const LIST_RE = /^(\s*)([-*+•]|\d+[.)])\s+(.*)$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const BLOCK_START_RE = /^\s{0,3}(#{1,6}\s|```|>)/;

function buildList(lines: ListLine[], start: number, indent: number): [ListNode, number] {
  const node: ListNode = { ordered: lines[start].ordered, start: lines[start].num, items: [] };
  let i = start;
  while (i < lines.length && lines[i].indent >= indent) {
    const line = lines[i];
    if (line.indent > indent) {
      const [child, next] = buildList(lines, i, line.indent);
      if (!node.items.length) node.items.push({ text: '', children: [] });
      node.items[node.items.length - 1].children.push(child);
      i = next;
      continue;
    }
    node.items.push({ text: line.text, children: [] });
    i++;
  }
  return [node, i];
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    if (/^\s*```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      blocks.push({ kind: 'code', text: buf.join('\n') });
      continue;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      blocks.push({ kind: 'hr' });
      i++;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push({ kind: 'quote', text: buf.join(' ') });
      continue;
    }

    if (LIST_RE.test(line)) {
      const items: ListLine[] = [];
      while (i < lines.length) {
        const l = lines[i];
        const m = l.match(LIST_RE);
        if (m) {
          items.push({
            indent: m[1].replace(/\t/g, '    ').length,
            ordered: /\d/.test(m[2]),
            num: parseInt(m[2], 10) || 1,
            text: m[3],
          });
          i++;
          continue;
        }
        if (!l.trim()) {
          // A blank line continues the list only if another item follows.
          let j = i + 1;
          while (j < lines.length && !lines[j].trim()) j++;
          if (j < lines.length && LIST_RE.test(lines[j])) {
            i = j;
            continue;
          }
          break;
        }
        if (/^\s+\S/.test(l) && items.length) {
          items[items.length - 1].text += ` ${l.trim()}`; // wrapped continuation line
          i++;
          continue;
        }
        break;
      }
      let k = 0;
      while (k < items.length) {
        const [list, next] = buildList(items, k, items[k].indent);
        blocks.push({ kind: 'list', list });
        k = next;
      }
      continue;
    }

    const buf = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !LIST_RE.test(lines[i]) && !BLOCK_START_RE.test(lines[i])) {
      buf.push(lines[i++].trim());
    }
    blocks.push({ kind: 'paragraph', text: buf.join(' ') });
  }
  return blocks;
}

function renderInline(text: string): ReactNode[] {
  // code | **bold** | __bold__ | *italic* | _italic_ | [link](https://…)
  const re =
    /`([^`]+)`|\*\*(.+?)\*\*|__(.+?)__|\*(?!\s)(.+?)\*(?!\*)|(?<!\w)_(?!\s)(.+?)_(?!\w)|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(<code key={key++}>{m[1]}</code>);
    else if (m[2] !== undefined || m[3] !== undefined) out.push(<strong key={key++}>{renderInline(m[2] ?? m[3])}</strong>);
    else if (m[4] !== undefined || m[5] !== undefined) out.push(<em key={key++}>{renderInline(m[4] ?? m[5])}</em>);
    else if (m[6] !== undefined)
      out.push(
        <a key={key++} href={m[7]} target="_blank" rel="noreferrer">
          {renderInline(m[6])}
        </a>,
      );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const TASK_RE = /^\[( |x|X)\]\s+(.*)$/;

/** Counts task items in document order, so a click can find its line in the source. */
interface RenderContext {
  task: number;
  onToggleTask?: (n: number) => void;
}

function renderList(list: ListNode, key: number, ctx: RenderContext): ReactNode {
  const items = list.items.map((item, i) => {
    const task = TASK_RE.exec(item.text);
    const children = item.children.map((child, j) => renderList(child, j, ctx));
    if (!task) {
      return (
        <li key={i}>
          {renderInline(item.text)}
          {children}
        </li>
      );
    }
    const n = ctx.task++;
    const done = task[1] !== ' ';
    const toggle = ctx.onToggleTask;
    return (
      <li key={i} className={`task ${done ? 'task-done' : ''}`}>
        <button
          type="button"
          className="task-box"
          role="checkbox"
          aria-checked={done}
          aria-label={done ? 'Mark as not done' : 'Mark as done'}
          disabled={!toggle}
          onClick={() => toggle?.(n)}
        >
          {done && (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          )}
        </button>
        <span className="task-text">
          {renderInline(task[2])}
          {children}
        </span>
      </li>
    );
  });
  return list.ordered ? (
    <ol key={key} start={list.start}>
      {items}
    </ol>
  ) : (
    <ul key={key}>{items}</ul>
  );
}

/** Flips the n-th task ("- [ ]" / "- [x]") in the source, counting as the renderer does. */
export function toggleTask(markdown: string, n: number): string {
  const lines = markdown.split('\n');
  let seen = 0;
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) fenced = !fenced;
    if (fenced) continue;
    const m = /^(\s*(?:[-*+•]|\d+[.)])\s+)\[( |x|X)\]/.exec(lines[i]);
    if (!m) continue;
    if (seen++ === n) {
      lines[i] = `${m[1]}[${m[2] === ' ' ? 'x' : ' '}]${lines[i].slice(m[0].length)}`;
      break;
    }
  }
  return lines.join('\n');
}

export function Markdown({
  text,
  className = '',
  onToggleTask,
}: {
  text: string;
  className?: string;
  /** Makes "- [ ]" items clickable checkboxes. */
  onToggleTask?: (n: number) => void;
}) {
  const blocks = parseMarkdown(text);
  const ctx: RenderContext = { task: 0, onToggleTask };
  return (
    <div className={`md ${className}`}>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'heading': {
            const Tag = `h${Math.min(b.level, 4)}` as 'h1' | 'h2' | 'h3' | 'h4';
            return <Tag key={i}>{renderInline(b.text)}</Tag>;
          }
          case 'paragraph':
            return <p key={i}>{renderInline(b.text)}</p>;
          case 'list':
            return renderList(b.list, i, ctx);
          case 'code':
            return (
              <pre key={i}>
                <code>{b.text}</code>
              </pre>
            );
          case 'quote':
            return <blockquote key={i}>{renderInline(b.text)}</blockquote>;
          case 'hr':
            return <hr key={i} />;
        }
      })}
    </div>
  );
}

/** First sentence-ish line of a summary, stripped of Markdown, for list previews. */
export function summaryPreview(summary: string | undefined, max = 220): string {
  if (!summary) return '';
  for (const raw of summary.split('\n')) {
    const line = raw.trim();
    if (!line || HEADING_RE.test(line) || HR_RE.test(line)) continue;
    const plain = line
      .replace(/^([-*+•]|\d+[.)])\s+/, '')
      .replace(/^\[( |x|X)\]\s+/, '')
      .replace(/[*_`]/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .trim();
    if (plain) return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
  }
  return '';
}
