// Notices calls without a calendar: Windows records, per app, when it last
// started and stopped using the microphone (that's what drives the mic icon
// in the taskbar). While an app holds the mic, its LastUsedTimeStop is 0.
// Polling those registry values tells us when Teams, Zoom, Slack… join or
// leave a call. Read-only; nothing is changed.
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';

const MIC_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone';
const POLL_MS = 3000;
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

/** Parses `reg query <MIC_KEY> /s`: the known apps that hold the microphone right now. */
export function parseMicUsage(output: string): string[] {
  const active = new Set<string>();
  let key = '';
  let start = 0n;
  let stop = 0n;
  let hasStop = false;
  const flush = () => {
    const app = key && appName(key);
    if (app && start > 0n && hasStop && stop === 0n) active.add(app);
  };
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('HKEY_')) {
      flush();
      key = line.slice(line.lastIndexOf('\\') + 1).trim();
      start = 0n;
      stop = 0n;
      hasStop = false;
      continue;
    }
    const m = /^\s+(LastUsedTimeStart|LastUsedTimeStop)\s+REG_QWORD\s+0x([0-9a-f]+)/i.exec(line);
    if (!m) continue;
    const value = BigInt(`0x${m[2]}`);
    if (m[1] === 'LastUsedTimeStart') start = value;
    else {
      stop = value;
      hasStop = true;
    }
  }
  flush();
  return [...active].sort();
}

function queryRegistry(): Promise<string> {
  return new Promise((resolve) => {
    execFile('reg', ['query', MIC_KEY, '/s'], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? '' : stdout),
    );
  });
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

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const real = this.useRegistry && process.platform === 'win32' ? parseMicUsage(await queryRegistry()) : [];
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
