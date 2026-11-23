// Performance check: idle CPU, live updates in a long meeting, and memory with
// the window closed to the tray. Runs the built app with a throwaway profile.
//   usage: npm run build && node tests/perf.mjs
import electronPath from 'electron';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';

const ROOT = resolve(import.meta.dirname, '..');
const SEGMENTS = 1500; // about two hours of conversation
const APPENDS = 40;
const IDLE_SEC = 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** CPU seconds and private memory of every TORU process (main, GPU, network, renderers). */
function procStats() {
  const ps = `Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" | Where-Object { $_.CommandLine -like '*${ROOT.replace(/'/g, "''")}*' } | ForEach-Object { $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if ($p) { [pscustomobject]@{ cpu = $p.CPU; mem = $p.PrivateMemorySize64 } } } | ConvertTo-Json -Compress`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim();
  const list = out ? [].concat(JSON.parse(out)) : [];
  return { count: list.length, cpu: list.reduce((s, p) => s + p.cpu, 0), mem: list.reduce((s, p) => s + p.mem, 0) };
}

const MB = (b) => `${Math.round(b / 1048576)} MB`;
const results = {};

// ------------------------------------------- call detection, one check
{
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone';
  const runs = 15;
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) await new Promise((r) => execFile('reg', ['query', key, '/s'], { windowsHide: true }, r));
  results.regExeMs = (performance.now() - t0) / runs;
  try {
    const { nativeMicReader } = await import('../electron/meetings.ts');
    const read = await nativeMicReader();
    if (read) {
      read();
      const t1 = performance.now();
      for (let i = 0; i < 200; i++) read();
      results.nativeMs = (performance.now() - t1) / 200;
    }
  } catch {
    // no native reader in this version
  }
}

const profile = mkdtempSync(join(tmpdir(), 'toru-perf-'));
writeFileSync(join(profile, 'prefs.json'), JSON.stringify({ trayHintShown: true, detectMeetings: true, autoStop: true, widget: true, openAtLogin: false }));
const env = { ...process.env, TORU_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TORU_TEST; // real call detection, as users run it

const app = await electron.launch({ executablePath: electronPath, args: [ROOT], cwd: ROOT, env });
const page = async (name) => {
  for (let i = 0; i < 100; i++) {
    const p = app.windows().find((w) => w.url().includes(`/${name}.html`));
    if (p) return p;
    await sleep(100);
  }
  throw new Error(`no ${name} window`);
};
try {
  const main = await page('index');
  const recorder = await page('recorder');
  await main.getByRole('heading', { name: /^Good / }).waitFor();
  await sleep(3000); // let start-up settle

  // ---------------------------------------------------------- idle CPU
  const a = procStats();
  await sleep(IDLE_SEC * 1000);
  const b = procStats();
  results.processes = b.count;
  results.idleCpuPct = ((b.cpu - a.cpu) / IDLE_SEC) * 100;
  results.memOpen = b.mem;

  // ---------------------------------------------- a two-hour meeting
  await main.evaluate(
    ([n]) =>
      new Promise((res, rej) => {
        const words = 'so the plan for the next sprint is to finish the payments work and then we can look at the mobile release and the analytics dashboard'.split(' ');
        const r = indexedDB.open('toru-desktop');
        r.onsuccess = () => {
          const tx = r.result.transaction(['notes', 'segments'], 'readwrite');
          const now = Date.now();
          tx.objectStore('notes').put({ id: 'perf', folderId: 'inbox', title: 'Two-hour planning call', createdAt: now, updatedAt: now, durationMs: n * 4800, status: 'done', sources: 'both', myNotes: '' });
          let speaker = 'them';
          for (let i = 0; i < n; i++) {
            if (i % 3 === 0) speaker = speaker === 'me' ? 'them' : 'me';
            const text = Array.from({ length: 28 }, (_, k) => words[(i * 7 + k) % words.length]).join(' ') + '.';
            tx.objectStore('segments').put({ noteId: 'perf', index: i, startMs: i * 4800, endMs: i * 4800 + 4500, speaker, text });
          }
          tx.oncomplete = () => res();
          tx.onerror = () => rej(tx.error);
        };
      }),
    [SEGMENTS],
  );
  await main.goto(main.url().replace(/#.*$/, '#/note/perf'));
  await main.getByRole('tab', { name: 'Transcript' }).waitFor();
  const cdp = await app.context().newCDPSession(main);
  await cdp.send('Performance.enable');
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));

  const m0 = await metrics();
  await main.getByRole('tab', { name: 'Transcript' }).click();
  await main.getByText('Listening').or(main.locator('.transcript > :last-child')).first().waitFor();
  await sleep(1500);
  const m1 = await metrics();
  results.openTranscriptMs = (m1.TaskDuration - m0.TaskDuration) * 1000;
  results.domNodes = m1.Nodes;

  // New lines arrive the way the recorder writes them: saved, then announced.
  for (let k = 0; k < APPENDS; k++) {
    await recorder.evaluate(
      ([i]) =>
        new Promise((res) => {
          const r = indexedDB.open('toru-desktop');
          r.onsuccess = () => {
            const tx = r.result.transaction('segments', 'readwrite');
            tx.objectStore('segments').put({ noteId: 'perf', index: i, startMs: i * 4800, endMs: i * 4800 + 4500, speaker: i % 2 ? 'me' : 'them', text: `A new line number ${i} arrives while the meeting goes on.` });
            tx.oncomplete = () => {
              new BroadcastChannel('toru-desktop-events').postMessage({ type: 'segments', noteId: 'perf', indexes: [i] });
              res();
            };
          };
        }),
      [SEGMENTS + k],
    );
    await sleep(250);
  }
  await sleep(1500);
  const m2 = await metrics();
  results.perLineMs = ((m2.TaskDuration - m1.TaskDuration) * 1000) / APPENDS;
  results.heapMb = m2.JSHeapUsedSize / 1048576;

  // The echo check's read of the transcript per clip: whole meeting vs. the lines around the clip.
  results.echoRead = await recorder.evaluate(
    ([n]) =>
      new Promise((res) => {
        const r = indexedDB.open('toru-desktop');
        r.onsuccess = async () => {
          const db = r.result;
          const time = (fn) =>
            new Promise((done) => {
              const t = performance.now();
              const q = fn(db.transaction('segments').objectStore('segments'));
              q.onsuccess = () => done(performance.now() - t);
            });
          const all = [];
          const near = [];
          for (let i = 0; i < 5; i++) {
            all.push(await time((os) => os.index('noteId').getAll('perf')));
            near.push(await time((os) => os.getAll(IDBKeyRange.bound(['perf', n - 24], ['perf', n + 24]))));
          }
          const med = (xs) => xs.sort((x, y) => x - y)[2];
          res({ allMs: med(all), nearMs: med(near) });
        };
      }),
    [SEGMENTS],
  );

  // ----------------------------------------- memory with the window closed
  await sleep(2000);
  results.memLoaded = procStats().mem;
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/index.html'))?.close());
  await sleep(5000);
  results.memClosed = procStats().mem;
} finally {
  await app.close().catch(() => {});
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
}

const f = (n, d = 1) => (n === undefined ? '—' : n.toFixed(d));
console.log(`
call detection, one check   reg.exe ${f(results.regExeMs)} ms${results.nativeMs !== undefined ? ` · in-process ${f(results.nativeMs, 3)} ms` : ''}
idle CPU (${IDLE_SEC} s)             ${f(results.idleCpuPct, 2)}% of one core  (${results.processes} processes, not counting reg.exe)
memory, idle at start       ${MB(results.memOpen)}
memory, long meeting open   ${MB(results.memLoaded)}
  …after closing the window ${MB(results.memClosed)}
two-hour meeting (${SEGMENTS} lines):
  open the transcript       ${f(results.openTranscriptMs, 0)} ms of main-thread work, ${results.domNodes} DOM nodes
  each new line             ${f(results.perLineMs)} ms of main-thread work
  JS heap                   ${f(results.heapMb)} MB
  echo check read per clip  ${f(results.echoRead.allMs)} ms (whole meeting) vs ${f(results.echoRead.nearMs)} ms (nearby lines)
`);
