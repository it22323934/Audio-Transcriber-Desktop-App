// The recorder runs in a hidden window that lives as long as TORU does, so a
// meeting keeps recording when the main window is closed. It captures two
// channels: the microphone ("me") and the computer's audio ("them", i.e. the
// call, via Windows loopback capture). Each channel is sliced into chunks at
// natural pauses and fed through one transcription queue.
import { encodeWav, normalizeGain, peak } from '../lib/audio';
import { bridge } from '../lib/bridge';
import { emit, subscribe } from '../lib/events';
import { defaultTitle, errorMessage } from '../lib/format';
import { finalizeNote, retryPendingChunks, transcribeWithRetry } from '../lib/pipeline';
import * as store from '../lib/store';
import type { AudioSources, PendingChunk, RecordingState, Settings, Speaker } from '../lib/types';
import type { MainPrefs, RecorderCommand, RecorderReply } from '../shared/bridge';

/** The worklet delivers 16 kHz mono 16-bit PCM in 50 ms blocks. */
const SAMPLE_RATE = 16_000;
const BLOCK_MS = 50;
const MIN_CHUNK_SEC = 8; // start looking for a pause after this long
const MAX_CHUNK_SEC = 30; // cut regardless after this long
/** A pause this long after at least MIN_TURN_SEC of audio ends a turn, so the two sides interleave. */
const TURN_PAUSE_MS = 1200;
const MIN_TURN_SEC = 3;
/** Block RMS below this is always silence (digital silence from the computer is 0). */
const SPEECH_LEVEL = 0.004;
/**
 * A microphone hisses even when nobody talks (often 0.003–0.01 here), so each
 * channel tracks its own background level and only counts sound this many
 * times louder. Quiet echo of the call through the speakers usually falls
 * below it too.
 */
const NOISE_MARGIN = 2.5;
/** The background estimate never rises above this, so loud rooms can't mute speech. */
const MAX_NOISE_FLOOR = 0.03;
/** Less sound than this (300 ms) isn't worth transcribing. */
const MIN_SOUND_BLOCKS = 6;
/** Silence kept around the speech when a chunk is trimmed. */
const PAD_BLOCKS = 6;
/** Pages showing a level meter ping this often; levels stop flowing without a recent ping. */
const LEVEL_WATCH_TIMEOUT_MS = 5000;

// ------------------------------------------------------------------ chunks

/** Collects one speaker's audio and cuts it into chunks. */
class Channel {
  private blocks: Int16Array[] = [];
  private levels: number[] = [];
  /** Per block: louder than the background? */
  private loud: boolean[] = [];
  private levelSum = 0;
  /** Running estimate of the background level: falls fast, rises slowly (−1 until the first block). */
  private noiseFloor = -1;
  private length = 0;
  private sounding = 0;
  private quietRun = 0;
  /** Recording time at the start of the current chunk; set by the first block. */
  private cursorMs: number | null = null;
  previousText = '';

  constructor(
    readonly speaker: Speaker,
    private readonly session: MeetingSession,
  ) {}

  get recordedMs(): number {
    return (this.cursorMs ?? 0) + (this.length / SAMPLE_RATE) * 1000;
  }

  /** Updates the background estimate and says whether this block stands out from it. */
  private isSound(level: number): boolean {
    if (this.noiseFloor < 0) this.noiseFloor = Math.min(level, MAX_NOISE_FLOOR);
    else if (level < this.noiseFloor) this.noiseFloor += (level - this.noiseFloor) * 0.1; // ~0.5 s to follow a quieter room
    else this.noiseFloor = Math.min(MAX_NOISE_FLOOR, this.noiseFloor + (level - this.noiseFloor) * 0.002); // ~25 s to rise
    return level >= Math.max(SPEECH_LEVEL, this.noiseFloor * NOISE_MARGIN);
  }

  push(block: Int16Array, level: number): void {
    // Align the channels: the second capture usually opens a moment after the first.
    this.cursorMs ??= Math.max(0, this.session.elapsedMs() - BLOCK_MS);
    const loud = this.isSound(level);
    this.blocks.push(block);
    this.levels.push(level);
    this.loud.push(loud);
    this.levelSum += level;
    this.length += block.length;
    if (loud) {
      this.sounding++;
      this.quietRun = 0;
    } else {
      this.quietRun++;
    }
    const seconds = this.length / SAMPLE_RATE;
    const endOfTurn = seconds >= MIN_TURN_SEC && this.sounding >= MIN_SOUND_BLOCKS && this.quietRun * BLOCK_MS >= TURN_PAUSE_MS;
    if (seconds >= MAX_CHUNK_SEC || endOfTurn || (seconds >= MIN_CHUNK_SEC && this.atPause())) this.cut();
  }

  /** True when the last ~100 ms are background, or clearly quieter than this chunk's average. */
  private atPause(): boolean {
    const n = this.levels.length;
    if (n < 4) return false;
    if (!this.loud[n - 1] && !this.loud[n - 2]) return true;
    const dip = (this.levelSum / n) * 0.35;
    return this.levels[n - 1] < dip && this.levels[n - 2] < dip;
  }

  /** Closes the current chunk and queues it. Resolves once its audio is saved. */
  cut(): Promise<void> {
    if (!this.length) return Promise.resolve();
    const { blocks, loud, length, sounding } = this;
    const startMs = this.cursorMs ?? 0;
    this.blocks = [];
    this.levels = [];
    this.loud = [];
    this.levelSum = 0;
    this.length = 0;
    this.sounding = 0;
    this.quietRun = 0;
    this.cursorMs = startMs + (length / SAMPLE_RATE) * 1000;
    this.session.touchDuration();

    // Skip silence: it costs money and transcribers tend to hallucinate on it.
    if (sounding < MIN_SOUND_BLOCKS) return Promise.resolve();
    // Trim the silence around the speech, so the timestamps say when it was said.
    let first = loud.indexOf(true);
    let last = loud.lastIndexOf(true);
    first = Math.max(0, first - PAD_BLOCKS);
    last = Math.min(blocks.length - 1, last + PAD_BLOCKS);
    let offset = 0;
    for (let i = 0; i < first; i++) offset += blocks[i].length;
    const kept = blocks.slice(first, last + 1);
    const keptLength = kept.reduce((n, b) => n + b.length, 0);
    const chunkStart = startMs + (offset / SAMPLE_RATE) * 1000;

    const chunk: PendingChunk = {
      noteId: this.session.noteId,
      index: this.session.nextIndex++,
      startMs: Math.round(chunkStart),
      endMs: Math.round(chunkStart + (keptLength / SAMPLE_RATE) * 1000),
      speaker: this.speaker,
      audio: encodeWav(kept, keptLength, SAMPLE_RATE, normalizeGain(peak(kept))),
      attempts: 0,
    };
    const saved = store.addChunk(chunk); // persisted first, so nothing is lost if transcription fails
    this.session.enqueue(async () => {
      await saved;
      await this.session.process(chunk, this);
    });
    return saved;
  }
}

/** One meeting: both channels, one transcription queue. */
class MeetingSession {
  nextIndex = 0;
  private channels = new Map<Speaker, Channel>();
  private queue: Promise<void> = Promise.resolve();
  private processed = new Set<number>();
  /** Set after a non-retryable error (e.g. bad API key): audio is kept, not sent. */
  private blocked = false;
  private durationTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly noteId: string,
    readonly elapsedMs: () => number,
  ) {}

  channel(speaker: Speaker): Channel {
    let c = this.channels.get(speaker);
    if (!c) {
      c = new Channel(speaker, this);
      this.channels.set(speaker, c);
    }
    return c;
  }

  push(speaker: Speaker, block: Int16Array, level: number): void {
    this.channel(speaker).push(block, level);
  }

  cutAll(): Promise<void> {
    return Promise.all([...this.channels.values()].map((c) => c.cut())).then(() => {});
  }

  /** Saves the recorded length now and then (not on every chunk of both channels). */
  touchDuration(): void {
    if (this.durationTimer) return;
    this.durationTimer = setTimeout(() => {
      this.durationTimer = null;
      const ms = Math.max(0, ...[...this.channels.values()].map((c) => c.recordedMs));
      store.updateNote(this.noteId, { durationMs: Math.round(ms) }).catch(console.error);
    }, 500);
  }

  enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((e) => console.error('[toru] chunk task failed', e));
  }

  async process(chunk: PendingChunk, channel: Channel): Promise<void> {
    if (this.blocked || this.processed.has(chunk.index)) return;
    const result = await transcribeWithRetry(chunk, channel.previousText);
    if (result.ok) {
      this.processed.add(chunk.index);
      if (result.text) channel.previousText = `${channel.previousText} ${result.text}`.slice(-2000);
      return;
    }
    if (result.fatal) this.blocked = true;
    await store.updateNote(this.noteId, { error: result.error });
  }

  /** After the settings change (e.g. a fixed API key), send the audio that was held back. */
  retryHeldBack(): void {
    if (!this.blocked) return;
    this.blocked = false;
    this.enqueue(async () => {
      await store.updateNote(this.noteId, { error: undefined });
      for (const chunk of await store.getChunks(this.noteId)) {
        if (this.blocked) break;
        await this.process(chunk, this.channel(chunk.speaker));
      }
    });
  }

  /** Flushes the last audio, waits for the queue, then writes the enhanced notes. */
  async finish(): Promise<void> {
    await this.cutAll();
    await store.updateNote(this.noteId, { status: 'processing' });
    await this.queue;
    await finalizeNote(this.noteId, { deleteIfEmpty: true });
  }
}

// ----------------------------------------------------------------- capture

interface Source {
  speaker: Speaker;
  node: AudioNode;
  stream?: MediaStream;
}

interface Capture {
  ctx: AudioContext;
  sources: Source[];
  worklets: AudioWorkletNode[];
}

let capture: Capture | null = null;
let session: MeetingSession | null = null;
let state: RecordingState | null = null;
const finishing = new Set<Promise<void>>();
const levels: Record<Speaker, number> = { me: 0, them: 0 };
let levelWatchedAt = 0;

function micError(e: unknown): Error {
  const name = e instanceof DOMException ? e.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new Error(
      'Windows is blocking the microphone. Turn on “Let desktop apps access your microphone” in Settings → Privacy & security → Microphone, then try again.',
    );
  }
  if (name === 'NotFoundError') return new Error('No microphone was found. Plug one in, or pick another in Settings.');
  if (name === 'NotReadableError') return new Error('The microphone couldn’t be opened. Another app may be using it exclusively.');
  return new Error(`The microphone couldn’t be opened: ${errorMessage(e)}`);
}

async function openMic(deviceId: string): Promise<MediaStream> {
  const constraints = (id?: string): MediaStreamConstraints => ({
    audio: {
      ...(id ? { deviceId: { exact: id } } : {}),
      channelCount: 1,
      // Cancels what's played by this app only; echo of the call is handled by the echo check.
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });
  try {
    return await navigator.mediaDevices.getUserMedia(constraints(deviceId || undefined));
  } catch (e) {
    // The chosen microphone was unplugged: fall back to the default one.
    if (deviceId && e instanceof DOMException && e.name === 'OverconstrainedError') {
      try {
        return await navigator.mediaDevices.getUserMedia(constraints());
      } catch (e2) {
        throw micError(e2);
      }
    }
    throw micError(e);
  }
}

/** Everything the computer plays (the call), via the main process's loopback handler. */
async function openSystemAudio(): Promise<MediaStream> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
  } catch (e) {
    throw new Error(`The computer’s audio couldn’t be captured: ${errorMessage(e)}`);
  }
  // Loopback audio needs a screen source, but TORU never looks at the picture.
  for (const t of stream.getVideoTracks()) {
    t.stop();
    stream.removeTrack(t);
  }
  if (!stream.getAudioTracks().length) {
    throw new Error('The computer’s audio couldn’t be captured. Try “Mic only” for this meeting.');
  }
  return stream;
}

/** Test stand-in for a voice: a tone that "talks" on and off. */
function fakeVoice(ctx: AudioContext, opts: { freq: number; on: number; off: number; delay: number }): AudioNode {
  const osc = ctx.createOscillator();
  osc.frequency.value = opts.freq;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  let t = ctx.currentTime + opts.delay;
  while (t < ctx.currentTime + 900) {
    gain.gain.setValueAtTime(0.25, t);
    t += opts.on;
    gain.gain.setValueAtTime(0, t);
    t += opts.off;
  }
  osc.connect(gain);
  osc.start();
  return gain;
}

async function openCapture(sources: AudioSources, settings: Settings): Promise<Capture> {
  const ctx = new AudioContext();
  const opened: Source[] = [];
  try {
    await ctx.audioWorklet.addModule(new URL('pcm-worklet.js', location.href).toString());
    if (bridge.env.test && localStorage.getItem('toru-fake-audio') === '1') {
      opened.push({ speaker: 'me', node: fakeVoice(ctx, { freq: 330, on: 1.6, off: 3.4, delay: 2.4 }) });
      if (sources === 'both') opened.push({ speaker: 'them', node: fakeVoice(ctx, { freq: 220, on: 3, off: 2, delay: 0.2 }) });
    } else {
      const mic = await openMic(settings.micDeviceId);
      opened.push({ speaker: 'me', node: ctx.createMediaStreamSource(mic), stream: mic });
      if (sources === 'both') {
        const system = await openSystemAudio();
        opened.push({ speaker: 'them', node: ctx.createMediaStreamSource(system), stream: system });
      }
    }
    // The worklets are pulled by the graph through a muted output: nothing is played back.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    mute.connect(ctx.destination);
    const worklets = opened.map((source) => {
      const worklet = new AudioWorkletNode(ctx, 'pcm-capture');
      source.node.connect(worklet);
      worklet.connect(mute);
      worklet.port.onmessage = (e: MessageEvent<{ pcm: Int16Array; level: number }>) =>
        onBlock(source.speaker, e.data.pcm, e.data.level);
      return worklet;
    });
    await ctx.resume();
    return { ctx, sources: opened, worklets };
  } catch (e) {
    for (const s of opened) s.stream?.getTracks().forEach((t) => t.stop());
    await ctx.close().catch(() => {});
    throw e;
  }
}

async function closeCapture(c: Capture): Promise<void> {
  for (const w of c.worklets) {
    w.port.onmessage = null;
    w.disconnect();
  }
  for (const s of c.sources) s.stream?.getTracks().forEach((t) => t.stop());
  await c.ctx.close().catch(() => {});
}

function onBlock(speaker: Speaker, pcm: Int16Array, level: number): void {
  levels[speaker] = state?.paused ? 0 : level;
  if (session && state && !state.paused) session.push(speaker, pcm, level);
}

// Level meters update ~10x a second, and only while something shows one.
setInterval(() => {
  if (!capture || Date.now() - levelWatchedAt > LEVEL_WATCH_TIMEOUT_MS) return;
  emit({ type: 'level', me: levels.me, them: levels.them });
}, 100);

// ---------------------------------------------------------------- commands

function elapsed(): number {
  if (!state) return 0;
  return state.elapsedMs + (state.runningSince ? Date.now() - state.runningSince : 0);
}

async function publishState(next: RecordingState | null): Promise<void> {
  state = next;
  await store.setRecording(next);
  bridge.recorder.publish(next);
}

async function start(cmd: Extract<RecorderCommand, { type: 'START' }>): Promise<RecorderReply> {
  if (capture) throw new Error('Already recording. Stop the current meeting first.');
  const settings = await store.getSettings();
  if (!settings.apiKey) throw new Error('Add your OpenAI API key in Settings to start taking notes.');
  const sources = cmd.sources ?? settings.sources;
  await store.ensureInbox();
  const wanted = cmd.folderId ?? settings.lastFolderId;
  const folderId = wanted && (await store.getFolder(wanted)) ? wanted : store.INBOX_ID;

  capture = await openCapture(sources, settings);
  for (const s of capture.sources) {
    // A track ends when its device goes away (e.g. a headset unplugged). Stop
    // cleanly so what was said so far is transcribed.
    s.stream?.getAudioTracks()[0]?.addEventListener('ended', () => {
      void serial(stop);
    });
  }

  const note = await store.createNote({
    folderId,
    title: cmd.title?.trim() || defaultTitle(cmd.app),
    status: 'recording',
    sources,
    autoSummary: settings.autoSummarize,
    ...(cmd.app ? { app: cmd.app } : {}),
  });
  session = new MeetingSession(note.id, elapsed);
  await publishState({
    noteId: note.id,
    folderId,
    sources,
    ...(cmd.app ? { app: cmd.app } : {}),
    paused: false,
    elapsedMs: 0,
    runningSince: Date.now(),
  });
  return { ok: true, noteId: note.id };
}

async function stop(): Promise<RecorderReply> {
  if (!capture) return { ok: true };
  const c = capture;
  capture = null;
  await closeCapture(c);
  const ended = session;
  session = null;
  levels.me = levels.them = 0;
  emit({ type: 'level', me: 0, them: 0 });
  await publishState(null);
  if (ended) track(ended.finish());
  return { ok: true, noteId: ended?.noteId };
}

async function pause(): Promise<RecorderReply> {
  if (!state || state.paused) return { ok: true };
  void session?.cutAll(); // transcribe what we have so far
  await publishState({ ...state, paused: true, elapsedMs: elapsed(), runningSince: null });
  return { ok: true };
}

async function resume(): Promise<RecorderReply> {
  if (!state || !state.paused) return { ok: true };
  await publishState({ ...state, paused: false, runningSince: Date.now() });
  return { ok: true };
}

/** TORU is quitting: save the unsent audio; it's transcribed the next time TORU starts. */
async function quit(): Promise<RecorderReply> {
  if (capture) {
    const c = capture;
    capture = null;
    await closeCapture(c);
    const ended = session;
    session = null;
    if (ended) {
      await ended.cutAll();
      await store.updateNote(ended.noteId, { status: 'interrupted' });
    }
    await publishState(null);
  }
  return { ok: true };
}

function track(work: Promise<void>): void {
  const tracked: Promise<void> = work
    .catch((e) => console.error('[toru] finishing a meeting failed', e))
    .finally(() => finishing.delete(tracked));
  finishing.add(tracked);
}

// Commands run one at a time so START/STOP/PAUSE can't interleave.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}

/** Called by the main process (webContents.executeJavaScript). Never throws. */
async function handle(cmd: RecorderCommand): Promise<RecorderReply> {
  try {
    switch (cmd.type) {
      case 'STATUS':
        return { ok: true, recording: !!capture, busy: finishing.size > 0, noteId: state?.noteId };
      case 'START':
        return await serial(() => start(cmd));
      case 'STOP':
        return await serial(stop);
      case 'PAUSE':
        return await serial(pause);
      case 'RESUME':
        return await serial(resume);
      case 'QUIT':
        return await serial(quit);
    }
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

// ------------------------------------------------------------------ set-up

function prefsOf(s: Settings): MainPrefs {
  return { detectMeetings: s.detectMeetings, autoStop: s.autoStop, widget: s.widget, openAtLogin: s.openAtLogin };
}

let lastPrefs = '';
async function syncPrefs(): Promise<void> {
  const prefs = prefsOf(await store.getSettings());
  const json = JSON.stringify(prefs);
  if (json === lastPrefs) return;
  lastPrefs = json;
  bridge.app.syncPrefs(prefs);
}

/** Finishes meetings left half-done when TORU last closed: transcribes their saved audio and writes the notes. */
async function recover(): Promise<void> {
  const stale = await store.getRecording();
  if (stale) await store.setRecording(null);
  const unfinished = (await store.listNotes()).filter((n) =>
    ['recording', 'processing', 'summarizing', 'interrupted'].includes(n.status),
  );
  for (const note of unfinished) {
    try {
      await retryPendingChunks(note.id);
    } catch (e) {
      console.error('[toru] recovering a meeting failed', e);
    }
  }
  await store.sweepOrphans();
}

subscribe((e) => {
  if (e.type === 'settings') {
    session?.retryHeldBack();
    void syncPrefs();
  }
  if (e.type === 'level-watch') levelWatchedAt = Date.now();
});

(window as unknown as { __toruRecorder: typeof handle }).__toruRecorder = handle;

void (async () => {
  try {
    await store.ensureInbox();
    await publishState(null);
    await syncPrefs();
  } finally {
    bridge.recorder.ready();
  }
  track(recover());
})();
