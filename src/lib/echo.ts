// Speaker echo. Without headphones the microphone also picks up the call, so
// the "me" channel transcribes what "them" just said. A "me" line counts as an
// echo when most of its word pairs were spoken by "them" at about the same
// time. Word pairs (not single words) keep genuine replies that reuse a few of
// the same words from being flagged. No imports, so it can be unit-tested
// directly with Node.

interface Line {
  startMs: number;
  endMs: number;
  speaker: 'me' | 'them';
  text: string;
}

/** How far apart in time an echo and its source may be (chunks are cut at different moments). */
const SLACK_MS = 5000;
/** Shorter lines ("yes", "thanks") can't be told apart from a genuine reply. */
const MIN_WORDS = 4;
/** Share of the line's word pairs that must appear in "them" to count as an echo. */
const ECHO_SHARE = 0.5;

function words(text: string): string[] {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .match(/[\p{L}\p{N}]+(?:'[\p{L}]+)?/gu) ?? []
  );
}

function pairs(w: string[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < w.length; i++) out.push(`${w[i - 1]} ${w[i]}`);
  return out;
}

export function overlaps(a: { startMs: number; endMs: number }, b: { startMs: number; endMs: number }, slack = SLACK_MS): boolean {
  return a.startMs < b.endMs + slack && a.endMs > b.startMs - slack;
}

/** True when `me` mostly repeats what was said in the "them" lines around it. */
export function isEcho(me: Line, lines: Line[]): boolean {
  if (me.speaker !== 'me') return false;
  const mine = words(me.text);
  if (mine.length < MIN_WORDS) return false;
  const near = lines.filter((l) => l.speaker === 'them' && overlaps(l, me));
  if (!near.length) return false;
  const pool = new Set(near.flatMap((l) => pairs(words(l.text))));
  const grams = pairs(mine);
  const hits = grams.filter((g) => pool.has(g)).length;
  return hits / grams.length >= ECHO_SHARE;
}
