// TORU's main process: windows, tray, global shortcut, meeting detection,
// system-audio capture permissions, the encrypted API key, and the toru://
// protocol the app is served from.
import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  Tray,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import type { AudioSources, RecordingState } from '../src/lib/types';
import { IPC, type MainPrefs, type RecorderCommand, type RecorderReply, type ToruBridge, type WidgetAction, type WidgetState } from '../src/shared/bridge';
import { MeetingWatcher, type MeetingChange } from './meetings';

const TEST = process.env.TORU_TEST === '1';
/** Set by scripts/dev.mjs: load pages from the Vite dev server (hot reload). */
const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const OPENAI_BASE = process.env.TORU_OPENAI_BASE || 'https://api.openai.com/v1';
if (process.env.TORU_USER_DATA) app.setPath('userData', process.env.TORU_USER_DATA);

const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');
const ICONS = DEV_URL ? join(ROOT, 'public', 'icons') : join(DIST, 'icons');
const APP_ORIGIN = 'toru://app';
const SHORTCUT = 'CommandOrControl+Alt+R';
const AUTO_STOP_MS = 15_000;
const PROMPT_TIMEOUT_MS = 120_000;
const DONE_TIMEOUT_MS = 9_000;
const WIDGET_WIDTH = 360;

// The recorder runs hidden and without a click; let its AudioContext start.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.setAppUserModelId('com.toru.desktop');

protocol.registerSchemesAsPrivileged([
  { scheme: 'toru', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// ------------------------------------------------------------------- prefs

interface Stored extends MainPrefs {
  widgetPos?: { x: number; y: number };
  theme?: { dark: boolean; background: string; text: string };
  trayHintShown?: boolean;
}

const prefsFile = () => join(app.getPath('userData'), 'prefs.json');
let prefs: Stored = { detectMeetings: true, autoStop: true, widget: true, openAtLogin: false };

function loadPrefs(): void {
  try {
    prefs = { ...prefs, ...JSON.parse(readFileSync(prefsFile(), 'utf8')) };
  } catch {
    // first run
  }
}

function savePrefs(patch: Partial<Stored>): void {
  prefs = { ...prefs, ...patch };
  try {
    mkdirSync(app.getPath('userData'), { recursive: true });
    writeFileSync(prefsFile(), JSON.stringify(prefs, null, 2));
  } catch (e) {
    console.error('[toru] saving prefs failed', e);
  }
}

// ----------------------------------------------------------------- secrets

const keyFile = () => join(app.getPath('userData'), 'openai-key.bin');

function readApiKey(): string {
  try {
    if (!existsSync(keyFile())) return '';
    const data = readFileSync(keyFile());
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(data) : data.toString('utf8');
  } catch {
    return '';
  }
}

function writeApiKey(key: string): void {
  if (!key) {
    if (existsSync(keyFile())) unlinkSync(keyFile());
    return;
  }
  mkdirSync(app.getPath('userData'), { recursive: true });
  // DPAPI on Windows: only this Windows account can decrypt it.
  writeFileSync(keyFile(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(key) : Buffer.from(key, 'utf8'));
}

// ---------------------------------------------------------------- protocol

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: mediastream:",
  `connect-src 'self' ${new URL(OPENAI_BASE).origin}`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

function serveApp(): void {
  protocol.handle('toru', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'app') return new Response('Not found', { status: 404 });
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = normalize(join(DIST, rel));
    if (!file.startsWith(DIST + sep)) return new Response('Forbidden', { status: 403 });
    try {
      const body = await readFile(file);
      return new Response(body, {
        headers: {
          'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
          'Content-Security-Policy': CSP,
          'Cache-Control': 'no-cache',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

const pageUrl = (page: string, hash = '') => (DEV_URL ? `${DEV_URL}/${page}${hash}` : `${APP_ORIGIN}/${page}${hash}`);

function isOwnUrl(url: string | undefined): boolean {
  if (!url) return false;
  if (url.startsWith(`${APP_ORIGIN}/`)) return true;
  return !!DEV_URL && url.startsWith(`${DEV_URL}/`);
}

function isOwnSender(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return isOwnUrl(e.senderFrame?.url);
}

// ----------------------------------------------------------------- windows

let mainWin: BrowserWindow | null = null;
let recorderWin: BrowserWindow | null = null;
let widgetWin: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

function preloadPrefs() {
  return {
    preload: join(__dirname, 'preload.cjs'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  };
}

function icon(name: string) {
  return nativeImage.createFromPath(join(ICONS, name));
}

function themeColors() {
  return prefs.theme ?? (nativeTheme.shouldUseDarkColors
    ? { dark: true, background: '#11110f', text: '#ecebe3' }
    : { dark: false, background: '#fcfcfa', text: '#1f1e1a' });
}

/**
 * The main window exists only while it's open: closing it frees its renderer
 * (tens of MB) while TORU waits in the tray, and opening it loads it again at
 * `route`. The recorder and the widget keep running either way.
 */
function createMainWindow(show: boolean, route = '/'): BrowserWindow {
  const colors = themeColors();
  const win = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 820,
    minHeight: 560,
    show: false,
    title: 'TORU',
    icon: icon('icon256.png'),
    backgroundColor: colors.background,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: colors.background, symbolColor: colors.text, height: 44 },
    webPreferences: { ...preloadPrefs(), spellcheck: true },
  });
  void win.loadURL(pageUrl('index.html', `#${route}`));
  win.once('ready-to-show', () => {
    if (show) win.show();
  });
  win.on('close', () => {
    if (!quitting) trayHint();
  });
  win.on('focus', refreshWidget);
  win.on('blur', refreshWidget);
  win.on('show', refreshWidget);
  win.on('hide', refreshWidget);
  win.on('minimize', refreshWidget);
  win.on('restore', refreshWidget);
  win.on('closed', () => {
    mainWin = null;
    refreshWidget();
  });
  return win;
}

function showMain(route?: string): void {
  if (!mainWin) {
    mainWin = createMainWindow(true, route); // shown once it has loaded, already at the route
    return;
  }
  const win = mainWin;
  if (route) win.webContents.send(IPC.navigate, route);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function trayHint(): void {
  if (prefs.trayHintShown || TEST) return;
  savePrefs({ trayHintShown: true });
  new Notification({
    title: 'TORU is still running',
    body: 'It stays in the tray to notice your calls. Right-click the tray icon to quit.',
    icon: icon('icon256.png'),
    silent: true,
  }).show();
}

// ---------------------------------------------------------------- recorder

let recorderReady: Promise<void>;
let markRecorderReady: () => void = () => {};
let recording: RecordingState | null = null;

function createRecorder(): void {
  recorderReady = new Promise((resolve) => {
    markRecorderReady = resolve;
  });
  recorderWin = new BrowserWindow({
    show: process.env.TORU_SHOW_RECORDER === '1',
    width: 520,
    height: 420,
    title: 'TORU recorder',
    skipTaskbar: true,
    webPreferences: { ...preloadPrefs(), backgroundThrottling: false },
  });
  void recorderWin.loadURL(pageUrl('recorder.html'));
  recorderWin.webContents.on('render-process-gone', (_e, details) => {
    console.error('[toru] recorder stopped:', details.reason);
    if (quitting) return;
    onRecordingState(null);
    recorderWin?.destroy();
    createRecorder(); // it finishes the interrupted meeting from its saved audio
  });
  recorderWin.on('close', (e) => {
    if (!quitting) e.preventDefault();
  });
}

async function callRecorder(cmd: RecorderCommand): Promise<RecorderReply> {
  const ready = await Promise.race([recorderReady.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 20_000))]);
  if (!ready || !recorderWin) return { ok: false, error: 'TORU’s recorder didn’t start. Restart TORU.' };
  try {
    // Runs with a user gesture, so capture APIs behave as if the user clicked.
    return (await recorderWin.webContents.executeJavaScript(`window.__toruRecorder(${JSON.stringify(cmd)})`, true)) as RecorderReply;
  } catch (e) {
    console.error('[toru] recorder call failed', e);
    return { ok: false, error: 'TORU’s recorder isn’t responding. Restart TORU.' };
  }
}

async function startRecording(opts: { app?: string; sources?: AudioSources } = {}): Promise<void> {
  const reply = await callRecorder({ type: 'START', ...opts });
  if (!reply.ok) {
    if (Notification.isSupported() && !mainWin?.isFocused()) {
      new Notification({ title: 'Couldn’t start recording', body: reply.error ?? '', icon: icon('icon256.png') }).show();
    }
    showMain(`/?error=${encodeURIComponent(reply.error ?? 'Couldn’t start recording.')}`);
  }
}

function toggleRecording(): void {
  if (recording) void callRecorder({ type: 'STOP' });
  else void startRecording({ app: meetings.apps[0] });
}

// ------------------------------------------------------- recording + widget

let widgetState: WidgetState = { mode: 'hidden' };
/** The call app this recording belongs to: when it lets go of the mic, the meeting is over. */
let recordingApp: string | undefined;
let autoStopArmed = true;
let endTimer: ReturnType<typeof setTimeout> | null = null;
let modeTimer: ReturnType<typeof setTimeout> | null = null;

function onRecordingState(next: RecordingState | null): void {
  const was = recording;
  recording = next;
  if (next && !was) {
    recordingApp = next.app ?? meetings.apps[0];
    autoStopArmed = true;
    setWidget({ mode: 'recording' });
  } else if (!next && was) {
    clearEndTimer();
    recordingApp = undefined;
    const visible = !!widgetWin?.isVisible();
    setWidget(visible ? { mode: 'done', noteId: was.noteId } : { mode: 'hidden' });
    if (visible) {
      modeTimer = setTimeout(() => {
        if (widgetState.mode === 'done') setWidget({ mode: 'hidden' });
      }, DONE_TIMEOUT_MS);
    }
  }
  updateTray();
}

function clearEndTimer(): void {
  if (endTimer) clearTimeout(endTimer);
  endTimer = null;
}

function setWidget(next: WidgetState): void {
  if (modeTimer) clearTimeout(modeTimer);
  modeTimer = null;
  widgetState = next;
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.widgetChanged, next);
  refreshWidget();
}

function mainInFront(): boolean {
  return !!mainWin && mainWin.isVisible() && !mainWin.isMinimized() && mainWin.isFocused();
}

/** Prompts always show; the recording pill shows only while TORU's own window isn't in front. */
function refreshWidget(): void {
  if (!widgetWin) return;
  let show = false;
  switch (widgetState.mode) {
    case 'prompt':
    case 'ending':
      show = true;
      break;
    case 'done':
      show = widgetWin.isVisible(); // only finish what was already on screen
      break;
    case 'recording':
      show = prefs.widget && !mainInFront();
      break;
  }
  if (show && !widgetWin.isVisible()) widgetWin.showInactive();
  else if (!show && widgetWin.isVisible()) widgetWin.hide();
}

function widgetPosition(height: number): { x: number; y: number } {
  const display = prefs.widgetPos ? screen.getDisplayNearestPoint(prefs.widgetPos) : screen.getPrimaryDisplay();
  const area = display.workArea;
  const pos = prefs.widgetPos ?? { x: area.x + area.width - WIDGET_WIDTH - 20, y: area.y + 72 };
  return {
    x: Math.min(Math.max(pos.x, area.x), area.x + area.width - WIDGET_WIDTH),
    y: Math.min(Math.max(pos.y, area.y), area.y + area.height - height),
  };
}

function createWidget(): void {
  const height = 64;
  const { x, y } = widgetPosition(height);
  const win = new BrowserWindow({
    x,
    y,
    width: WIDGET_WIDTH,
    height,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    title: 'TORU',
    webPreferences: preloadPrefs(),
  });
  win.setAlwaysOnTop(true, 'floating');
  void win.loadURL(pageUrl('widget.html'));
  let moveTimer: ReturnType<typeof setTimeout> | null = null;
  win.on('moved', () => {
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      const [px, py] = win.getPosition();
      savePrefs({ widgetPos: { x: px, y: py } });
    }, 300);
  });
  win.on('blur', refreshWidget);
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  widgetWin = win;
}

function resizeWidget(height: number): void {
  if (!widgetWin) return;
  const h = Math.round(Math.min(Math.max(height, 48), 560));
  const [x, y] = widgetWin.getPosition();
  const area = screen.getDisplayNearestPoint({ x, y }).workArea;
  const top = Math.min(y, area.y + area.height - h);
  widgetWin.setBounds({ x, y: Math.max(area.y, top), width: WIDGET_WIDTH, height: h });
}

function onWidgetAction(action: WidgetAction): void {
  switch (action.type) {
    case 'start':
      if (widgetState.mode === 'prompt') void startRecording({ app: widgetState.app });
      else void startRecording();
      break;
    case 'dismiss':
      setWidget({ mode: 'hidden' });
      break;
    case 'keep-going':
      clearEndTimer();
      autoStopArmed = false; // don't ask again for this meeting
      setWidget({ mode: 'recording' });
      break;
    case 'open-note':
      showMain(`/note/${action.noteId}`);
      if (widgetState.mode === 'done') setWidget({ mode: 'hidden' });
      break;
    case 'size':
      resizeWidget(action.height);
      break;
  }
}

// ---------------------------------------------------------------- meetings

const meetings = new MeetingWatcher(!TEST);

function onMeetingChange({ apps, started, ended }: MeetingChange): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.meetingsChanged, apps);
  if (recording) {
    if (!recordingApp && started.length) recordingApp = started[0];
    if (widgetState.mode === 'ending' && apps.includes(widgetState.app)) {
      clearEndTimer(); // the call app picked the mic up again
      setWidget({ mode: 'recording' });
    } else if (prefs.autoStop && autoStopArmed && recordingApp && ended.includes(recordingApp)) {
      const until = Date.now() + AUTO_STOP_MS;
      setWidget({ mode: 'ending', app: recordingApp, until });
      clearEndTimer();
      endTimer = setTimeout(() => {
        endTimer = null;
        void callRecorder({ type: 'STOP' });
      }, AUTO_STOP_MS);
    }
    return;
  }
  if (widgetState.mode === 'prompt' && !apps.includes(widgetState.app)) {
    setWidget({ mode: 'hidden' }); // the call ended before anyone answered the prompt
  } else if (prefs.detectMeetings && started.length && widgetState.mode !== 'prompt') {
    setWidget({ mode: 'prompt', app: started[0] });
    modeTimer = setTimeout(() => {
      if (widgetState.mode === 'prompt') setWidget({ mode: 'hidden' });
    }, PROMPT_TIMEOUT_MS);
  }
}

// -------------------------------------------------------------------- tray

function updateTray(): void {
  if (!tray) return;
  tray.setImage(icon(recording ? 'tray-rec.png' : 'tray.png'));
  tray.setToolTip(recording ? (recording.paused ? 'TORU · paused' : 'TORU · recording') : 'TORU');
  const items: Electron.MenuItemConstructorOptions[] = recording
    ? [
        { label: recording.paused ? 'Resume recording' : 'Pause recording', click: () => void callRecorder({ type: recording?.paused ? 'RESUME' : 'PAUSE' }) },
        { label: 'Stop recording', click: () => void callRecorder({ type: 'STOP' }) },
        { label: 'Show the meeting', click: () => recording && showMain(`/note/${recording.noteId}`) },
      ]
    : [
        { label: 'Take notes on a call', accelerator: SHORTCUT, click: () => void startRecording({ app: meetings.apps[0], sources: 'both' }) },
        { label: 'Take notes in person (mic only)', click: () => void startRecording({ sources: 'mic' }) },
      ];
  tray.setContextMenu(
    Menu.buildFromTemplate([
      ...items,
      { type: 'separator' },
      { label: 'Open TORU', click: () => showMain() },
      { type: 'separator' },
      { label: 'Quit TORU', click: () => app.quit() },
    ]),
  );
}

// --------------------------------------------------------------------- ipc

function registerIpc(): void {
  ipcMain.on(IPC.env, (e) => {
    const env: ToruBridge['env'] = { openaiBase: OPENAI_BASE, test: TEST, platform: process.platform, version: app.getVersion() };
    e.returnValue = isOwnSender(e) ? env : null;
  });
  ipcMain.handle(IPC.recorderCall, (e, cmd: RecorderCommand) =>
    isOwnSender(e) ? callRecorder(cmd) : { ok: false, error: 'Not allowed.' },
  );
  ipcMain.on(IPC.recorderReady, (e) => {
    if (e.sender === recorderWin?.webContents) markRecorderReady();
  });
  ipcMain.on(IPC.recorderState, (e, state: RecordingState | null) => {
    if (e.sender === recorderWin?.webContents) onRecordingState(state);
  });
  ipcMain.handle(IPC.getApiKey, (e) => (isOwnSender(e) ? readApiKey() : ''));
  ipcMain.handle(IPC.setApiKey, (e, key: string) => {
    if (isOwnSender(e)) writeApiKey(String(key ?? '').trim());
  });
  ipcMain.on(IPC.show, (e, route?: string) => {
    if (isOwnSender(e)) showMain(route);
  });
  ipcMain.on(IPC.theme, (e, theme: Parameters<ToruBridge['app']['setTheme']>[0]) => {
    if (!isOwnSender(e) || !theme || e.sender !== mainWin?.webContents) return;
    const { titleBar, ...colors } = theme;
    if (JSON.stringify(colors) !== JSON.stringify(prefs.theme)) savePrefs({ theme: colors });
    mainWin.setBackgroundColor(colors.background);
    mainWin.setTitleBarOverlay({ color: titleBar || colors.background, symbolColor: colors.text, height: 44 });
  });
  ipcMain.on(IPC.prefs, (e, next: MainPrefs) => {
    if (!isOwnSender(e)) return;
    savePrefs(next);
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: next.openAtLogin, args: ['--hidden'] });
    refreshWidget();
  });
  ipcMain.on(IPC.openExternal, (e, url: string) => {
    if (isOwnSender(e) && /^https:\/\//.test(url)) void shell.openExternal(url);
  });
  ipcMain.on(IPC.openMicSettings, (e) => {
    if (isOwnSender(e)) void shell.openExternal('ms-settings:privacy-microphone');
  });
  ipcMain.handle(IPC.meetingsActive, () => meetings.apps);
  ipcMain.handle(IPC.widgetState, () => widgetState);
  ipcMain.on(IPC.widgetAct, (e, action: WidgetAction) => {
    if (isOwnSender(e)) onWidgetAction(action);
  });
  if (TEST) {
    ipcMain.on(IPC.testMeeting, (_e, name: string, active: boolean) => meetings.simulate(name, active));
  }
}

function harden(): void {
  const ses = session.defaultSession;
  const allowed = new Set(['media', 'display-capture', 'clipboard-sanitized-write', 'clipboard-read', 'notifications', 'fullscreen']);
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(isOwnUrl(details.requestingUrl) && allowed.has(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => isOwnUrl(`${origin}/`) && allowed.has(permission));
  // getDisplayMedia from the recorder → the whole screen as the (unused) video
  // source, plus Windows loopback audio: everything the computer plays.
  ses.setDisplayMediaRequestHandler((request, callback) => {
    if (!isOwnUrl(request.frame?.url)) {
      callback({});
      return;
    }
    desktopCapturer.getSources({ types: ['screen'] }).then(
      ([source]) => callback(source ? { video: source, audio: 'loopback' } : {}),
      () => callback({}),
    );
  });
}

app.on('web-contents-created', (_e, contents: WebContents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (e, url) => {
    if (isOwnUrl(url)) return;
    e.preventDefault();
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });
});

// --------------------------------------------------------------- lifecycle

app.on('second-instance', () => showMain());

app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  void (async () => {
    const status = await callRecorder({ type: 'STATUS' });
    if (!TEST && (status.recording || status.busy)) {
      const { response } = await dialog.showMessageBox({
        type: 'question',
        buttons: [status.recording ? 'Stop and quit' : 'Quit anyway', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'TORU',
        message: status.recording ? 'A meeting is being recorded.' : 'TORU is still writing up a meeting.',
        detail: 'What was captured is kept and finished the next time TORU starts.',
      });
      if (response !== 0) return;
    }
    quitting = true;
    clearEndTimer();
    await callRecorder({ type: 'QUIT' });
    meetings.stop();
    globalShortcut.unregisterAll();
    app.quit();
  })();
});

app.on('window-all-closed', () => {
  // Stay in the tray.
});

void app.whenReady().then(() => {
  loadPrefs();
  harden();
  if (!DEV_URL) serveApp();
  registerIpc();
  Menu.setApplicationMenu(null);

  createRecorder();
  createWidget();
  // Started at sign-in: wait in the tray without loading the main window at all.
  if (!process.argv.includes('--hidden')) mainWin = createMainWindow(true);

  tray = new Tray(icon('tray.png'));
  tray.on('click', () => showMain());
  updateTray();

  if (!globalShortcut.register(SHORTCUT, toggleRecording)) {
    console.warn(`[toru] ${SHORTCUT} is taken by another app`);
  }

  meetings.on('change', onMeetingChange);
  meetings.start();
});
