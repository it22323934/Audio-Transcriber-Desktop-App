import { useCallback, useEffect, useRef, useState } from 'react';
import { emit, subscribe, type AppEvent } from '../lib/events';
import * as store from '../lib/store';
import type { Folder, Note, RecordingState, Segment, Settings } from '../lib/types';

/** Matching events within this window trigger a single reload. */
const RELOAD_COALESCE_MS = 50;

/**
 * Loads data and reloads it whenever a matching change event arrives from any
 * TORU window. A burst of events (one audio chunk emits notes + chunks +
 * segments) causes one reload, not several. Returns undefined until the first
 * load completes.
 */
export function useLive<T>(load: () => Promise<T>, deps: unknown[], matches: (e: AppEvent) => boolean): T | undefined {
  const [value, setValue] = useState<T>();
  const loadRef = useRef(load);
  const matchRef = useRef(matches);
  loadRef.current = load;
  matchRef.current = matches;

  useEffect(() => {
    let alive = true;
    let seq = 0;
    const run = () => {
      const mine = ++seq;
      loadRef.current().then(
        (v) => {
          if (alive && mine === seq) setValue(v);
        },
        (e) => console.error('[toru] load failed', e),
      );
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      timer ??= setTimeout(() => {
        timer = undefined;
        run();
      }, RELOAD_COALESCE_MS);
    };
    setValue(undefined);
    run();
    const unsubscribe = subscribe((e) => {
      if (e.type !== 'level' && e.type !== 'level-watch' && matchRef.current(e)) schedule();
    });
    return () => {
      alive = false;
      clearTimeout(timer);
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return value;
}

/**
 * A note's transcript in speaking order, kept up to date incrementally: when
 * new lines arrive only those are read, so a two-hour meeting costs the same
 * per update as a two-minute one. Unchanged lines keep their object identity,
 * so memoised rows don't re-render.
 */
export function useSegments(noteId: string): Segment[] | undefined {
  const [list, setList] = useState<Segment[]>();
  useEffect(() => {
    let alive = true;
    const lines = new Map<number, Segment>();
    let pending: Set<number> | 'all' | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const publish = () => {
      if (alive) setList([...lines.values()].sort(store.byTime));
    };
    // Merge rather than replace: lines are never deleted on their own (only with the note).
    const merge = (found: Segment[]) => {
      for (const s of found) lines.set(s.index, s);
      publish();
    };
    const fail = (e: unknown) => console.error('[toru] loading the transcript failed', e);
    setList(undefined);
    store.getSegments(noteId).then(merge, fail);
    const flush = () => {
      timer = undefined;
      const batch = pending;
      pending = null;
      if (batch === 'all') store.getSegments(noteId).then(merge, fail);
      else if (batch) store.getSegmentsByIndex(noteId, [...batch]).then(merge, fail);
    };
    const unsubscribe = subscribe((e) => {
      if (e.type !== 'segments' || e.noteId !== noteId) return;
      if (!e.indexes || pending === 'all') pending = 'all';
      else {
        pending ??= new Set();
        for (const i of e.indexes) pending.add(i);
      }
      timer ??= setTimeout(flush, RELOAD_COALESCE_MS);
    });
    return () => {
      alive = false;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [noteId]);
  return list;
}

export function useSettings(): Settings | undefined {
  return useLive(store.getSettings, [], (e) => e.type === 'settings');
}

export function useFolders(): Folder[] | undefined {
  return useLive(store.listFolders, [], (e) => e.type === 'folders');
}

export function useNotes(folderId?: string): Note[] | undefined {
  return useLive(() => store.listNotes(folderId), [folderId], (e) => e.type === 'notes');
}

/** The note, null if it doesn't exist (deleted), undefined while loading. */
export function useNote(noteId: string): Note | null | undefined {
  return useLive(
    async () => (await store.getNote(noteId)) ?? null,
    [noteId],
    (e) => e.type === 'notes' && (!e.noteId || e.noteId === noteId),
  );
}

/** The live recording (null when idle, undefined while loading). */
export function useRecording(): RecordingState | null | undefined {
  return useLive(store.getRecording, [], (e) => e.type === 'recording');
}

export function elapsedMs(rec: RecordingState, now: number): number {
  return rec.elapsedMs + (rec.runningSince ? now - rec.runningSince : 0);
}

/** Re-renders every `interval` ms while `active`. */
export function useNow(active: boolean, interval = 500): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(t);
  }, [active, interval]);
  return now;
}

export interface Levels {
  me: number[];
  them: number[];
}

/**
 * Recent input levels of both channels, newest last. While mounted it tells
 * the recorder someone is watching; with no meter on screen no levels are sent.
 */
export function useLevels(count: number): Levels {
  const [levels, setLevels] = useState<Levels>(() => ({ me: Array(count).fill(0), them: Array(count).fill(0) }));
  useEffect(() => {
    const unsubscribe = subscribe((e) => {
      if (e.type === 'level') {
        setLevels((prev) => ({ me: [...prev.me.slice(1 - count), e.me], them: [...prev.them.slice(1 - count), e.them] }));
      }
    });
    emit({ type: 'level-watch' });
    const ping = setInterval(() => emit({ type: 'level-watch' }), 2000);
    return () => {
      clearInterval(ping);
      unsubscribe();
    };
  }, [count]);
  return levels;
}

/**
 * The value, but only after it has stopped changing for `delay` ms. Values
 * for which `immediate` returns true (e.g. a cleared search box) apply at once,
 * so a stale value never outlives them.
 */
export function useDebouncedValue<T>(value: T, delay: number, immediate?: (v: T) => boolean): T {
  const [settled, setSettled] = useState(value);
  const now = immediate?.(value) ?? false;
  useEffect(() => {
    if (now) {
      setSettled(value);
      return;
    }
    const t = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(t);
  }, [value, delay, now]);
  return now ? value : settled;
}

/** Debounced saver that also flushes on unmount. */
export function useDebouncedSave<T>(save: (value: T) => void, delay = 600) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pending = useRef<{ value: T } | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    if (pending.current) {
      const { value } = pending.current;
      pending.current = null;
      saveRef.current(value);
    }
  }, []);

  const schedule = useCallback(
    (value: T) => {
      pending.current = { value };
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, delay);
    },
    [delay, flush],
  );

  useEffect(() => flush, [flush]);
  return { schedule, flush, isPending: () => pending.current !== null };
}

/** Closes popovers when clicking outside or pressing Escape. */
export function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}
