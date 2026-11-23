// Notices calls without a calendar. Windows' audio system knows which
// programs are capturing from a microphone right now (that's what drives the
// mic icon in the taskbar); when Teams, Zoom, Slack… start or stop capturing,
// they joined or left a call. Read-only; nothing is changed.
//
// Older Windows builds also recorded this per app in the registry
// (CapabilityAccessManager, LastUsedTimeStop = 0 while in use). Newer builds
// stopped updating those values, so the registry is only a fallback for when
// the native reader can't load.
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';

const MIC_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone';
/** Cheap now that it's in-process, so it can check often: a call is noticed within ~2 s. */
const POLL_MS = 2000;
/** An app must hold the mic this many polls in a row to count (some open it briefly on launch). */
const START_POLLS = 2;

/** Registry key name (exe file name, or packaged app's family name) → app name. */
const KNOWN: [RegExp, string][] = [
  [/^zoom\.exe$/i, 'Zoom'],
  [/^ms-teams\.exe$|^teams\.exe$|^MSTeams_/i, 'Microsoft Teams'],
  [/^slack\.exe$|\.Slack_/i, 'Slack'],
  [/^discord\.exe$/i, 'Discord'],
  [/^webex\.exe$|^ciscocollabhost\.exe$|^atmgr\.exe$|^webexmta\.exe$|^Cisco\.?Webex/i, 'Webex'],
  [/^skype\.exe$|^Microsoft\.SkypeApp_/i, 'Skype'],
  [/^lync\.exe$/i, 'Skype for Business'],
  [/whatsapp/i, 'WhatsApp'],
  [/^telegram\.exe$|TelegramDesktop/i, 'Telegram'],
  [/^ringcentral\.exe$/i, 'RingCentral'],
  [/^g2mcomm\.exe$|^GoTo/i, 'GoTo Meeting'],
  [/^chrome\.exe$/i, 'Chrome'],
  [/^msedge\.exe$/i, 'Edge'],
  [/^firefox\.exe$/i, 'Firefox'],
  [/^brave\.exe$/i, 'Brave'],
  [/^arc\.exe$|TheBrowserCompany/i, 'Arc'],
  [/^opera\.exe$/i, 'Opera'],
];

export function appName(keyName: string): string | undefined {
  const exe = keyName.split('#').pop() ?? keyName; // NonPackaged keys are paths with # for \
  return KNOWN.find(([re]) => re.test(exe))?.[1];
}

/** One app's microphone record: when it last started and stopped using the mic. */
interface MicEntry {
  key: string;
  start: bigint;
  /** Undefined when the app has never released the mic since the record was created. */
  stop: bigint | undefined;
}

/** The known call apps holding the microphone right now (LastUsedTimeStop is 0 while in use). */
function activeApps(entries: MicEntry[], name: (key: string) => string | undefined = appName): string[] {
  const active = new Set<string>();
  for (const e of entries) {
    const app = name(e.key);
    if (app && e.start > 0n && e.stop === 0n) active.add(app);
  }
  return [...active].sort();
}

/** Parses `reg query <MIC_KEY> /s`: the known apps that hold the microphone right now. */
export function parseMicUsage(output: string): string[] {
  const entries: MicEntry[] = [];
  let current: MicEntry | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('HKEY_')) {
      current = { key: line.slice(line.lastIndexOf('\\') + 1).trim(), start: 0n, stop: undefined };
      entries.push(current);
      continue;
    }
    const m = /^\s+(LastUsedTimeStart|LastUsedTimeStop)\s+REG_QWORD\s+0x([0-9a-f]+)/i.exec(line);
    if (!m || !current) continue;
    const value = BigInt(`0x${m[2]}`);
    if (m[1] === 'LastUsedTimeStart') current.start = value;
    else current.stop = value;
  }
  return activeApps(entries);
}

/** Fallback: starts reg.exe for every check (~100 ms of process start-up each time), and is stale on newer Windows. */
function queryRegistry(): Promise<string> {
  return new Promise((resolve) => {
    execFile('reg', ['query', MIC_KEY, '/s'], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? '' : stdout),
    );
  });
}

// Live microphone sessions, read in-process (via koffi) from Windows' audio
// system: every program with an open capture stream on an active microphone,
// and whether it's capturing right now. This is the same information behind
// the taskbar's mic icon. One check takes a few milliseconds and starts no
// process. Read-only.

const CLSID_MMDeviceEnumerator = 'BCDE0395-E52F-467C-8E3D-C4579291692E';
const IID_IMMDeviceEnumerator = 'A95664D2-9614-4F35-A746-DE8DB63617E6';
const IID_IAudioSessionManager2 = '77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F';
const IID_IAudioSessionControl2 = 'BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D';
const CLSCTX_ALL = 0x17;
const COINIT_APARTMENTTHREADED = 0x2;
const E_CAPTURE = 1;
const DEVICE_STATE_ACTIVE = 1;
const SESSION_ACTIVE = 1;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

/** Vtable slots of the COM interfaces used (IUnknown takes 0–2). */
const SLOT = {
  QueryInterface: 0,
  Release: 2,
  EnumAudioEndpoints: 3, // IMMDeviceEnumerator
  CollectionCount: 3, // IMMDeviceCollection::GetCount
  CollectionItem: 4, // IMMDeviceCollection::Item
  Activate: 3, // IMMDevice
  GetSessionEnumerator: 5, // IAudioSessionManager2
  SessionCount: 3, // IAudioSessionEnumerator::GetCount
  GetSession: 4, // IAudioSessionEnumerator
  GetState: 3, // IAudioSessionControl
  GetProcessId: 14, // IAudioSessionControl2
};

function parseGuid(s: string) {
  const h = s.replace(/-/g, '');
  return {
    Data1: parseInt(h.slice(0, 8), 16),
    Data2: parseInt(h.slice(8, 12), 16),
    Data3: parseInt(h.slice(12, 16), 16),
    Data4: Array.from({ length: 8 }, (_, i) => parseInt(h.slice(16 + i * 2, 18 + i * 2), 16)),
  };
}

let captureReader: Promise<(() => string[]) | null> | null = null;

/**
 * Returns a function that lists the call apps capturing from a microphone
 * right now, or null if native access isn't available. `name` maps an exe
 * file name to an app name (undefined = not a call app); tests pass their own.
 */
export async function nativeMicReader(name: (exe: string) => string | undefined = appName): Promise<(() => string[]) | null> {
  captureReader ??= loadCaptureReader(); // the native bindings are set up once per process
  const exes = await captureReader;
  if (!exes) return null;
  return () => [...new Set(exes().map(name).filter((app): app is string => !!app))].sort();
}

/** Loads the bindings; the returned function lists the exe names capturing right now. */
async function loadCaptureReader(): Promise<(() => string[]) | null> {
  if (process.platform !== 'win32') return null;
  try {
    const koffi = (await import('koffi')).default;
    const ole32 = koffi.load('ole32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const GUID = koffi.struct('TORU_GUID', { Data1: 'uint32_t', Data2: 'uint16_t', Data3: 'uint16_t', Data4: koffi.array('uint8_t', 8) });
    const PGUID = koffi.pointer(GUID);
    const OutPtr = koffi.out(koffi.pointer('void *'));
    const OutU32 = koffi.out(koffi.pointer('uint32_t'));
    const OutI32 = koffi.out(koffi.pointer('int32_t'));

    const CoInitializeEx = ole32.func('__stdcall', 'CoInitializeEx', 'long', ['void *', 'uint32_t']);
    const CoCreateInstance = ole32.func('__stdcall', 'CoCreateInstance', 'long', [PGUID, 'void *', 'uint32_t', PGUID, OutPtr]);
    const OpenProcess = kernel32.func('__stdcall', 'OpenProcess', 'void *', ['uint32_t', 'bool', 'uint32_t']);
    const QueryFullProcessImageNameW = kernel32.func('__stdcall', 'QueryFullProcessImageNameW', 'bool', ['void *', 'uint32_t', 'void *', koffi.inout(koffi.pointer('uint32_t'))]);
    const CloseHandle = kernel32.func('__stdcall', 'CloseHandle', 'bool', ['void *']);

    const proto = {
      Release: koffi.proto('__stdcall', 'TORU_Release', 'uint32_t', ['void *']),
      QueryInterface: koffi.proto('__stdcall', 'TORU_QueryInterface', 'long', ['void *', PGUID, OutPtr]),
      EnumAudioEndpoints: koffi.proto('__stdcall', 'TORU_EnumAudioEndpoints', 'long', ['void *', 'int32_t', 'uint32_t', OutPtr]),
      CollectionCount: koffi.proto('__stdcall', 'TORU_CollectionCount', 'long', ['void *', OutU32]),
      CollectionItem: koffi.proto('__stdcall', 'TORU_CollectionItem', 'long', ['void *', 'uint32_t', OutPtr]),
      Activate: koffi.proto('__stdcall', 'TORU_Activate', 'long', ['void *', PGUID, 'uint32_t', 'void *', OutPtr]),
      GetSessionEnumerator: koffi.proto('__stdcall', 'TORU_GetSessionEnumerator', 'long', ['void *', OutPtr]),
      SessionCount: koffi.proto('__stdcall', 'TORU_SessionCount', 'long', ['void *', OutI32]),
      GetSession: koffi.proto('__stdcall', 'TORU_GetSession', 'long', ['void *', 'int32_t', OutPtr]),
      GetState: koffi.proto('__stdcall', 'TORU_GetState', 'long', ['void *', OutI32]),
      GetProcessId: koffi.proto('__stdcall', 'TORU_GetProcessId', 'long', ['void *', OutU32]),
    };
    const PTR = koffi.sizeof('void *');
    type Com = unknown;
    /** Calls a COM method: the function pointer is read from the object's vtable. */
    const call = (obj: Com, slot: number, type: unknown, ...args: unknown[]): number => {
      const vtable = koffi.decode(obj, 'void *');
      return koffi.call(koffi.decode(vtable, slot * PTR, 'void *'), type as never, obj, ...args) as number;
    };
    const release = (obj: Com | null) => {
      if (obj) call(obj, SLOT.Release, proto.Release);
    };
    /** Runs `fn` with a COM object from an out-parameter call, then releases it. */
    const using = <T>(fill: (out: [Com | null]) => number, fn: (obj: Com) => T): T | undefined => {
      const out: [Com | null] = [null];
      if (fill(out) !== 0 || !out[0]) return undefined;
      try {
        return fn(out[0]);
      } finally {
        release(out[0]);
      }
    };

    CoInitializeEx(null, COINIT_APARTMENTTHREADED); // already initialised in Electron's main thread: harmless
    const enumOut: [Com | null] = [null];
    const hr = CoCreateInstance(parseGuid(CLSID_MMDeviceEnumerator), null, CLSCTX_ALL, parseGuid(IID_IMMDeviceEnumerator), enumOut);
    if (hr !== 0 || !enumOut[0]) throw new Error(`MMDeviceEnumerator unavailable (0x${(hr >>> 0).toString(16)})`);
    const enumerator = enumOut[0];
    const iidManager = parseGuid(IID_IAudioSessionManager2);
    const iidControl2 = parseGuid(IID_IAudioSessionControl2);
    const pathBuf = Buffer.alloc(2048);

    const exeOf = (pid: number): string | undefined => {
      const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
      if (!handle) return undefined;
      try {
        const len = [pathBuf.length / 2];
        if (!QueryFullProcessImageNameW(handle, 0, pathBuf, len)) return undefined;
        return pathBuf.toString('utf16le', 0, len[0] * 2).split('\\').pop();
      } finally {
        CloseHandle(handle);
      }
    };

    /** Process ids with a capture session that is capturing right now. */
    const capturingPids = (): Set<number> => {
      const pids = new Set<number>();
      using(
        (out) => call(enumerator, SLOT.EnumAudioEndpoints, proto.EnumAudioEndpoints, E_CAPTURE, DEVICE_STATE_ACTIVE, out),
        (devices) => {
          const count = [0];
          call(devices, SLOT.CollectionCount, proto.CollectionCount, count);
          for (let d = 0; d < count[0]; d++) {
            using(
              (out) => call(devices, SLOT.CollectionItem, proto.CollectionItem, d, out),
              (device) =>
                using(
                  (out) => call(device, SLOT.Activate, proto.Activate, iidManager, CLSCTX_ALL, null, out),
                  (manager) =>
                    using(
                      (out) => call(manager, SLOT.GetSessionEnumerator, proto.GetSessionEnumerator, out),
                      (sessions) => {
                        const n = [0];
                        call(sessions, SLOT.SessionCount, proto.SessionCount, n);
                        for (let i = 0; i < n[0]; i++) {
                          using(
                            (out) => call(sessions, SLOT.GetSession, proto.GetSession, i, out),
                            (control) => {
                              const state = [0];
                              if (call(control, SLOT.GetState, proto.GetState, state) !== 0 || state[0] !== SESSION_ACTIVE) return;
                              using(
                                (out) => call(control, SLOT.QueryInterface, proto.QueryInterface, iidControl2, out),
                                (control2) => {
                                  const pid = [0];
                                  if (call(control2, SLOT.GetProcessId, proto.GetProcessId, pid) === 0 && pid[0]) pids.add(pid[0]);
                                },
                              );
                            },
                          );
                        }
                      },
                    ),
                ),
            );
          }
        },
      );
      return pids;
    };

    const read = (): string[] => {
      const exes: string[] = [];
      for (const pid of capturingPids()) {
        const exe = exeOf(pid);
        if (exe) exes.push(exe);
      }
      return exes;
    };
    read(); // fail here, not later, if anything about the bindings is wrong
    return read;
  } catch (e) {
    console.warn('[toru] reading microphone sessions failed; falling back to the registry', e);
    return null;
  }
}

export interface MeetingChange {
  /** Call apps holding the microphone now. */
  apps: string[];
  started: string[];
  ended: string[];
}

/** Emits 'change' (MeetingChange) whenever the set of call apps using the mic changes. */
export class MeetingWatcher extends EventEmitter {
  private streak = new Map<string, number>();
  private current: string[] = [];
  private simulated = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private readonly useRegistry: boolean;
  /** In-process reader once loaded; null means use reg.exe. */
  private reader: Promise<(() => string[]) | null> | null = null;

  /** `useRegistry: false` (tests) only reports simulated apps. */
  constructor(useRegistry: boolean) {
    super();
    this.useRegistry = useRegistry;
  }

  get apps(): string[] {
    return this.current;
  }

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Tests only: pretend an app started or stopped using the microphone. */
  simulate(app: string, active: boolean): void {
    if (active) this.simulated.add(app);
    else this.simulated.delete(app);
    this.update([...this.simulated], true);
  }

  private async read(): Promise<string[]> {
    if (!this.useRegistry || process.platform !== 'win32') return [];
    this.reader ??= nativeMicReader();
    const native = await this.reader;
    if (native) {
      try {
        return native();
      } catch (e) {
        console.warn('[toru] reading microphone sessions failed; switching to the registry', e);
        this.reader = Promise.resolve(null);
      }
    }
    return parseMicUsage(await queryRegistry());
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const real = await this.read();
      this.update([...new Set([...real, ...this.simulated])]);
    } finally {
      this.polling = false;
    }
  }

  private update(seen: string[], immediate = false): void {
    for (const app of [...this.streak.keys()]) if (!seen.includes(app)) this.streak.delete(app);
    for (const app of seen) this.streak.set(app, (this.streak.get(app) ?? 0) + 1);
    const apps = seen.filter((app) => immediate || this.simulated.has(app) || (this.streak.get(app) ?? 0) >= START_POLLS || this.current.includes(app)).sort();
    const started = apps.filter((a) => !this.current.includes(a));
    const ended = this.current.filter((a) => !apps.includes(a));
    if (!started.length && !ended.length) return;
    this.current = apps;
    this.emit('change', { apps, started, ended } satisfies MeetingChange);
  }
}
