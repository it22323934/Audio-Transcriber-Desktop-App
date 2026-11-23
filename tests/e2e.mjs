// End-to-end: launches the built app (npm run build first) with a throwaway
// profile, a mocked OpenAI API and synthetic "voices" for the microphone and
// the call, then drives it through the main window, the floating widget and
// the main process. Screenshots go to .e2e-out/. Costs nothing.
//   usage: npm run test:e2e
import electronPath from 'electron';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, '.e2e-out');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const errors = [];
const check = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
};

// ------------------------------------------------------------ mock OpenAI

const THEM = [
  'Thanks for joining. Let us review the Q3 roadmap and the budget today.',
  'The mobile release slipped two weeks because of the payments work.',
  'Priya will own the vendor contract and report back on Friday.',
  'We agreed to cut the analytics dashboard from this quarter.',
];
const ME = ['Sounds good, I can take the release notes.', null /* echo */, 'I will send the summary to the team tonight.', 'LEAK'];
const counters = { me: 0, them: 0 };
let lastThem = '';
const requests = { transcribe: 0, summary: 0, ask: 0, leaks: 0, formats: [] };

/** Every value of a multipart text field. */
function fieldValues(body, name) {
  const text = body.toString('utf8');
  const re = new RegExp(`name="${name.replace(/[[\]]/g, '\\$&')}"\r\n\r\n([\\s\\S]*?)\r\n--`, 'g');
  return [...text.matchAll(re)].map((m) => m[1]);
}

/** The multipart "prompt" field: the context TORU gives the transcriber. */
function promptField(body) {
  const text = body.toString('utf8');
  const m = /name="prompt"\r\n\r\n([\s\S]*?)\r\n--/.exec(text);
  return m ? m[1] : '';
}

function readBody(req) {
  return new Promise((res) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => res(Buffer.concat(parts)));
  });
}

const server = http.createServer(async (req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Private-Network': 'true',
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors).end();
    return;
  }
  const body = await readBody(req);
  const json = (obj) => res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }).end(JSON.stringify(obj));
  if (req.url === '/v1/models') return json({ data: ['gpt-transcribe', 'gpt-5-mini'].map((id) => ({ id })) });
  if (req.url === '/v1/audio/transcriptions') {
    const file = /filename="([^"]+)"/.exec(body.toString('utf8'))?.[1];
    requests.formats.push({
      file,
      model: fieldValues(body, 'model')[0],
      languages: fieldValues(body, 'languages[]'),
      language: fieldValues(body, 'language'),
      keywords: fieldValues(body, 'keywords[]'),
      prompt: fieldValues(body, 'prompt')[0] ?? '',
    });
    if (file === 'audio.wav') return json({ text: '' }); // the Settings test: one second of silence
    requests.transcribe++;
    const speaker = body.includes('filename="them.wav"') ? 'them' : 'me';
    const n = counters[speaker]++;
    let text;
    if (speaker === 'them') {
      text = THEM[n % THEM.length];
      lastThem = text;
    } else {
      text = ME[n % ME.length] ?? lastThem; // the mic "hears the speakers" once
      if (text === 'LEAK') {
        // What a transcriber sometimes does on quiet audio: return its context instead of a transcript.
        requests.leaks++;
        text = promptField(body);
      }
    }
    return json({ text });
  }
  if (req.url === '/v1/chat/completions') {
    const payload = JSON.parse(body.toString('utf8'));
    const system = payload.messages[0]?.content ?? '';
    if (payload.stream) {
      requests.ask++;
      res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream' });
      const words = 'Two action items came out of the call: **Priya** owns the vendor contract [0:10], and you will send the summary tonight.'.split(' ');
      for (const w of words) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `${w} ` } }] })}\n\n`);
        await sleep(15);
      }
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1200, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 0 } } })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    requests.summary++;
    const content = system.includes('You compress')
      ? '- Asked about action items.'
      : `# Q3 roadmap review\n\n## Summary\nThe team reviewed the Q3 roadmap and budget. The mobile release slipped two weeks.\n\n## Decisions\n- Cut the analytics dashboard from Q3.\n\n## Action items\n- [ ] **Priya**: vendor contract, report back Friday\n- [ ] **Me**: send the summary to the team tonight`;
    return json({ choices: [{ message: { content } }], usage: { prompt_tokens: 900, completion_tokens: 120 } });
  }
  res.writeHead(404, cors).end('{}');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const MOCK = `http://127.0.0.1:${server.address().port}/v1`;

// ----------------------------------------------------------------- launch

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const profile = mkdtempSync(join(OUT, 'profile-'));

const env = { ...process.env, TORU_TEST: '1', TORU_USER_DATA: profile, TORU_OPENAI_BASE: MOCK };
delete env.ELECTRON_RUN_AS_NODE; // set by VS Code's terminal; Electron would run as plain Node

async function launch() {
  const app = await electron.launch({ executablePath: electronPath, args: [ROOT], cwd: ROOT, env });
  const byPage = async (name) => {
    for (let i = 0; i < 100; i++) {
      const page = app.windows().find((w) => w.url().includes(`/${name}.html`));
      if (page) {
        if (!page.__watched) {
          page.__watched = true;
          page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errors.push(`[${name}] ${m.text()}`));
          page.on('pageerror', (e) => errors.push(`[${name}] pageerror: ${e.message}`));
        }
        return page;
      }
      await sleep(100);
    }
    throw new Error(`no ${name} window`);
  };
  const main = await byPage('index');
  const recorder = await byPage('recorder');
  const widget = await byPage('widget');
  await main.waitForLoadState('domcontentloaded');
  await main.evaluate(() => document.fonts.ready);
  return { app, main, recorder, widget };
}

/** Runs in the main process: finds a BrowserWindow by page and calls a method on it. */
const winCall = (app, page, method) =>
  app.evaluate(({ BrowserWindow }, [p, m]) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(`/${p}.html`));
    win?.[m]();
    return !!win;
  }, [page, method]);

const db = (page, fn, ...args) => page.evaluate(fn, args);
const readNotes = (page) =>
  db(page, () => new Promise((res) => {
    const r = indexedDB.open('toru-desktop');
    r.onsuccess = () => {
      const q = r.result.transaction('notes').objectStore('notes').getAll();
      q.onsuccess = () => res(q.result);
    };
  }));
const readSegments = (page, noteId) =>
  db(page, ([id]) => new Promise((res) => {
    const r = indexedDB.open('toru-desktop');
    r.onsuccess = () => {
      const q = r.result.transaction('segments').objectStore('segments').index('noteId').getAll(id);
      q.onsuccess = () => res(q.result);
    };
  }), noteId);
async function waitFor(fn, label, timeout = 30_000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timed out: ${label}`);
    await sleep(250);
  }
}
const shot = async (page, name) => {
  await sleep(300);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
};

let { app, main, recorder, widget } = await launch();
try {
  // ------------------------------------------------------------- first run
  await main.emulateMedia({ colorScheme: 'dark' });
  await main.getByRole('heading', { name: /^Good (morning|afternoon|evening)$/ }).waitFor();
  check(await main.getByText('Add your OpenAI key').isVisible(), 'first run shows the setup steps');
  await shot(main, '01-home-first-run');

  const env2 = await main.evaluate(() => window.toru.env);
  check(env2.test === true && env2.openaiBase === MOCK, 'bridge exposes the test environment');
  check(await main.evaluate(() => typeof window.require === 'undefined' && typeof window.process === 'undefined'), 'pages have no Node.js access');

  // Record the title-bar colours the page asks for (dimmed while a dialog is open).
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/index.html'));
    const original = win.setTitleBarOverlay.bind(win);
    globalThis.__overlays = [];
    win.setTitleBarOverlay = (o) => {
      globalThis.__overlays.push(o.color);
      return original(o);
    };
  });
  const lastOverlay = () => app.evaluate(() => globalThis.__overlays.at(-1));

  // Settings: API key (encrypted by the main process), then test it against the mock.
  await main.getByRole('button', { name: 'Settings', exact: true }).click();
  await main.locator('#apiKey').fill('sk-test-123');
  await main.getByRole('button', { name: 'Test', exact: true }).click();
  await main.getByText('Key works. Both models are available.').waitFor();
  await shot(main, '02-settings');
  check((await lastOverlay()) === '#0a0a08', 'window buttons dim with the dialog backdrop');

  // The dialog's scrollbar only shows while it scrolls.
  const body = main.locator('.modal-body');
  const box = await body.boundingBox();
  const strip = { x: Math.round(box.x + box.width - 10), y: Math.round(box.y + 10), width: 10, height: Math.round(box.height - 20) };
  check((await body.evaluate((el) => el.scrollHeight > el.clientHeight + 50)), 'the settings dialog body scrolls');
  const atRest = await main.screenshot({ clip: strip });
  await body.evaluate((el) => {
    el.scrollTop = 240;
  });
  await sleep(150);
  const scrolling = await main.screenshot({ clip: strip });
  await main.screenshot({ path: join(OUT, '02b-settings-scrolling.png') });
  await sleep(1400);
  const settled = await main.screenshot({ clip: strip });
  check(!scrolling.equals(atRest), 'a scrollbar appears while the dialog scrolls');
  check(settled.equals(atRest), 'the scrollbar disappears once scrolling stops');
  check(await main.locator('.modal-head h2').isVisible(), 'the dialog title stays in view while its body scrolls');

  // Spoken language: Sinhala. Test sends one second of silence with it.
  await main.getByRole('combobox', { name: 'Spoken language' }).click();
  await main.getByRole('option', { name: /^Sinhala/ }).click();
  await main.getByRole('combobox', { name: 'Write notes in' }).click();
  await main.getByRole('option', { name: /^English/ }).click();
  await main.getByRole('button', { name: 'Test', exact: true }).click();
  await main.getByText('Transcription with gpt-transcribe in Sinhala works.').waitFor();
  const probe = requests.formats.filter((f) => f.file === 'audio.wav').at(-1); // the test after choosing Sinhala
  check(probe?.model === 'gpt-transcribe' && probe.languages.join() === 'si,en' && !probe.language.length, 'Test checks a transcription with the chosen model and language');
  await main.screenshot({ path: join(OUT, '02c-settings-language.png') });

  await main.getByRole('button', { name: 'Save settings' }).click();
  await main.getByText('Settings saved').waitFor();
  check((await lastOverlay()) === '#11110f', 'window buttons return to the page colour when the dialog closes');
  const savedTheme = JSON.parse(readFileSync(join(profile, 'prefs.json'), 'utf8')).theme;
  check(savedTheme?.background === '#11110f', 'the dimmed colour is never saved as the window background');

  // A setting saved by an older version still names gpt-4o-mini-transcribe: it must not be used.
  await db(main, () => new Promise((res) => {
    const r = indexedDB.open('toru-desktop');
    r.onsuccess = () => {
      const tx = r.result.transaction('meta', 'readwrite');
      const os = tx.objectStore('meta');
      const g = os.get('settings');
      g.onsuccess = () => os.put({ key: 'settings', value: { ...g.result.value, transcribeModel: 'gpt-4o-mini-transcribe' } });
      tx.oncomplete = () => res();
    };
  }));
  const stored = await main.evaluate(() => window.toru.secrets.getApiKey());
  check(stored === 'sk-test-123', 'API key round-trips through the main process');
  const inDb = await db(main, () => new Promise((res) => {
    const r = indexedDB.open('toru-desktop');
    r.onsuccess = () => {
      const q = r.result.transaction('meta').objectStore('meta').get('settings');
      q.onsuccess = () => res(JSON.stringify(q.result ?? {}));
    };
  }));
  check(!inDb.includes('sk-test'), 'API key is not stored in the database');

  // A folder.
  await main.getByRole('button', { name: 'New folder' }).first().click();
  await main.locator('#fname').fill('Product team');
  await main.locator('#fdesc').fill('Weekly product syncs');
  await main.locator('#fvocab').fill('Priya, Q3 roadmap');
  await shot(main, '03-new-folder');
  await main.getByRole('button', { name: 'Create folder' }).click();
  await main.getByRole('heading', { name: 'Product team' }).waitFor();
  await main.goto(main.url().replace(/#.*$/, '#/'));
  await main.getByRole('heading', { name: /^Good / }).waitFor();

  // ----------------------------------------------------- a call, live
  await main.evaluate(() => localStorage.setItem('toru-fake-audio', '1'));
  await main.getByRole('combobox', { name: 'Folder', exact: true }).click();
  await main.getByRole('option', { name: 'Product team' }).click();
  await shot(main, '04-home-ready');
  await main.getByRole('button', { name: 'Start', exact: true }).click();
  await main.locator('.rec-dock').waitFor();
  check(/#\/note\//.test(main.url()), 'starting opens the meeting notepad');

  // The notepad continues bullets.
  const pad = main.getByLabel('My notes');
  await pad.click();
  await pad.pressSequentially('- roadmap');
  await pad.press('Enter');
  await pad.pressSequentially('budget?');
  check((await pad.inputValue()) === '- roadmap\n- budget?', 'notepad continues bullets on Enter');

  const notes1 = await readNotes(main);
  const live = notes1.find((n) => n.status === 'recording');
  check(live && live.sources === 'both' && live.title === 'New meeting', 'a live note was created for the call');
  check(live && live.folderId !== 'inbox', 'the note is filed in the chosen folder');

  await waitFor(async () => {
    const segs = await readSegments(main, live.id);
    return segs.some((s) => s.speaker === 'them') && segs.filter((s) => s.speaker === 'me').length >= 2 && segs;
  }, 'transcript lines from both speakers', 45_000);
  await shot(main, '05-recording-notepad');

  await main.getByRole('tab', { name: 'Transcript' }).click();
  await main.locator('.turn-them').first().waitFor();
  check((await main.locator('.turn-me').count()) > 0, 'transcript shows Me and Them bubbles');
  const echoSeen = await waitFor(async () => (await readSegments(main, live.id)).some((s) => s.echo), 'echo flagged', 30_000).catch(() => false);
  check(!!echoSeen, 'a mic line repeating the call is flagged as echo');
  const sent = requests.formats.filter((f) => f.file !== 'audio.wav');
  check(
    sent.length > 0 && sent.every((f) => f.model === 'gpt-transcribe' && f.languages.join() === 'si,en' && !f.language.length && f.keywords.includes('Priya') && f.keywords.includes('Q3 roadmap')),
    'clips go to gpt-transcribe (even with an old model saved) with the languages and the folder’s keywords',
  );
  check(sent.every((f) => f.prompt.startsWith('Sinhala speech, written in Sinhala script') && !f.prompt.includes('Glossary')), 'the prompt asks for Sinhala script');
  await main.getByText(/repeated the call/).waitFor();
  const shownTexts = await main.locator('.bubble').allInnerTexts();
  const themTexts = shownTexts.filter((t) => THEM.some((x) => t.includes(x)));
  check(themTexts.length > 0, 'call lines are shown');
  await shot(main, '06-recording-transcript');

  // The floating widget appears when TORU's window goes to the background.
  await winCall(app, 'index', 'hide');
  await waitFor(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/widget.html'))?.isVisible()), 'widget shown');
  await widget.locator('.pill-rec').waitFor();
  await shot(widget, '07-widget-recording');
  await widget.getByRole('button', { name: 'Show transcript' }).click();
  await widget.locator('.pill-line').first().waitFor();
  await widget.getByLabel('Add a note').fill('ask about hiring');
  await widget.getByLabel('Add a note').press('Enter');
  await waitFor(async () => (await readNotes(main)).find((n) => n.id === live.id)?.myNotes.includes('- ask about hiring'), 'quick note saved');
  check(true, 'a quick note from the widget lands in My notes');
  await shot(widget, '08-widget-expanded');
  await widget.getByRole('button', { name: 'Collapse' }).click();
  await winCall(app, 'index', 'show');
  await winCall(app, 'index', 'focus');

  // Pause and resume from the dock.
  await main.locator('.rec-dock').getByRole('button', { name: 'Pause' }).click();
  await waitFor(() => main.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('toru-desktop');
    r.onsuccess = () => {
      const q = r.result.transaction('meta').objectStore('meta').get('recording');
      q.onsuccess = () => res(q.result?.value?.paused === true);
    };
  })), 'paused');
  check(true, 'pause works');
  await main.locator('.rec-dock').getByRole('button', { name: 'Resume' }).click();

  // Stop → enhanced notes with a generated title.
  await main.getByRole('tab', { name: 'Notes' }).click();
  await main.locator('.rec-dock').getByRole('button', { name: 'Stop' }).click();
  await main.getByRole('radio', { name: 'Enhanced' }).waitFor({ timeout: 30_000 });
  const done = (await readNotes(main)).find((n) => n.id === live.id);
  check(done.status === 'done' && done.title === 'Q3 roadmap review', `notes enhanced and titled (${done.status}, "${done.title}")`);
  check(done.summaryTemplate === 'meeting' && !done.summary.startsWith('# '), 'title line is split off the notes');
  check(done.durationMs > 5000, `duration recorded (${done.durationMs} ms)`);
  await shot(main, '09-enhanced-notes');
  await main.getByRole('checkbox', { name: 'Mark as done' }).first().click();
  await main.getByRole('checkbox', { name: 'Mark as not done' }).waitFor();
  const ticked = (await readNotes(main)).find((n) => n.id === live.id);
  check(ticked.summary.includes('- [x] **Priya**') && ticked.summary.includes('- [ ] **Me**'), 'ticking an action item saves it in the notes');
  await main.getByRole('radio', { name: 'My notes' }).click();
  check((await main.getByLabel('My notes').inputValue()).includes('ask about hiring'), 'My notes keeps what was typed');
  await main.getByRole('radio', { name: 'Enhanced' }).click();

  // Switch template → offer to rewrite.
  await main.getByRole('combobox', { name: 'Notes template' }).click();
  await main.getByRole('option', { name: /^1:1/ }).click();
  await main.getByRole('button', { name: 'Rewrite as 1:1' }).waitFor();
  check(true, 'changing the template offers a rewrite');

  // Ask.
  await main.getByRole('tab', { name: 'Ask' }).click();
  await main.getByRole('button', { name: 'What are the action items?' }).click();
  await main.locator('.msg-ai').getByText(/vendor contract/).waitFor();
  await main.locator('.chat-send:not(.stop)').waitFor();
  check(requests.ask === 1, 'Ask streamed an answer');
  await shot(main, '10-ask');

  // ------------------------------------------ call detection and auto-stop
  await main.goto(main.url().replace(/#.*$/, '#/'));
  await main.evaluate(() => window.toru.test.meeting('Zoom', true));
  await main.locator('.detected').getByText('Zoom').waitFor();
  await widget.locator('.pill-card').getByText('Zoom is using your mic').waitFor();
  check(true, 'a call app using the mic shows the prompt and the home banner');
  await shot(main, '11-home-detected');
  await shot(widget, '12-widget-prompt');
  await widget.getByRole('button', { name: 'Take notes' }).click();
  const zoom = await waitFor(async () => (await readNotes(main)).find((n) => n.status === 'recording'), 'zoom recording');
  check(zoom.app === 'Zoom' && zoom.title === 'Zoom call', 'Take notes starts a recording for the Zoom call');
  await waitFor(async () => (await readSegments(main, zoom.id)).length >= 2, 'zoom transcript', 40_000);
  await main.evaluate(() => window.toru.test.meeting('Zoom', false));
  await widget.getByText('Has the Zoom call ended?').waitFor();
  await shot(widget, '13-widget-ending');
  const zoomDone = await waitFor(async () => {
    const n = (await readNotes(main)).find((x) => x.id === zoom.id);
    return n && n.status === 'done' && n;
  }, 'auto-stopped and finished', 45_000);
  check(!!zoomDone.summary, 'the call ending stops the recording and writes the notes');
  await widget.getByText('Your notes are ready').waitFor({ timeout: 10_000 });
  await shot(widget, '14-widget-done');

  // ------------------------------------------- a meeting where nothing is heard
  await main.goto(main.url().replace(/#.*$/, '#/'));
  await main.evaluate(() => localStorage.setItem('toru-fake-audio', 'silent'));
  await main.getByRole('button', { name: 'Start', exact: true }).click();
  await main.locator('.silence-alert').getByText('Your microphone isn’t sending any sound').waitFor({ timeout: 20_000 });
  await widget.locator('.pill-alert').waitFor({ timeout: 10_000 });
  check(true, 'a silent microphone is reported while recording (page and widget)');
  await shot(main, '14b-silent-mic');
  await main.locator('.rec-dock').getByRole('button', { name: 'Stop' }).click();
  await main.getByText(/Nothing was heard in/).waitFor({ timeout: 20_000 });
  check(true, 'a recording where nothing was heard says so when it stops');
  await main.evaluate(() => localStorage.setItem('toru-fake-audio', '1'));

  // -------------------------------------------------- in person, mic only
  await main.goto(main.url().replace(/#.*$/, '#/'));
  await main.getByRole('radio', { name: 'In person' }).click();
  await main.getByRole('button', { name: 'Start', exact: true }).click();
  await main.locator('.rec-dock').waitFor();
  const inPerson = (await readNotes(main)).find((n) => n.status === 'recording');
  check(inPerson.sources === 'mic', 'in-person meetings record the mic only');
  await waitFor(async () => (await readSegments(main, inPerson.id)).length >= 1, 'mic transcript', 30_000);
  const segsIP = await readSegments(main, inPerson.id);
  check(segsIP.every((s) => s.speaker === 'me'), 'only the microphone is transcribed');
  await main.getByRole('tab', { name: 'Transcript' }).click();
  await main.locator('.seg-row').first().waitFor();
  check((await main.locator('.turn').count()) === 0, 'in-person transcripts are not shown as Me/Them');

  // ----------------------------- quitting mid-meeting keeps what was said
  await sleep(2500); // some audio that hasn't been cut into a chunk yet
  await app.close();
  ({ app, main, recorder, widget } = await launch());
  const recovered = await waitFor(async () => {
    const n = (await readNotes(main)).find((x) => x.id === inPerson.id);
    return n && n.status === 'done' && n;
  }, 'recovered after restart', 30_000);
  check(!!recovered.summary, 'a meeting interrupted by quitting is finished on the next start');

  // ----------------------------------- a copy of the prompt never sticks
  const allSegments = await db(main, () => new Promise((res) => {
    const r = indexedDB.open('toru-desktop');
    r.onsuccess = () => {
      const q = r.result.transaction('segments').objectStore('segments').getAll();
      q.onsuccess = () => res(q.result);
    };
  }));
  check(requests.leaks > 0 && !allSegments.some((x) => /Glossary|written in Sinhala script/i.test(x.text)), `text copied from the transcriber's prompt is dropped (${requests.leaks} leak(s) simulated)`);

  // --------------- closing the window frees it; opening a meeting reopens it
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/index.html'))?.close());
  await waitFor(async () => !(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.webContents.getURL().includes('/index.html')))), 'main window closed');
  check(true, 'closing the main window destroys it (TORU stays in the tray)');
  const firstNote = (await readNotes(widget)).filter((n) => n.sources === 'both').sort((x, y) => x.createdAt - y.createdAt)[0]; // the first call
  await widget.evaluate((id) => window.toru.widget.act({ type: 'open-note', noteId: id }), firstNote.id);
  main = await waitFor(async () => app.windows().find((w) => w.url().includes('/index.html')), 'main window reopened');
  main.on('pageerror', (e) => errors.push(`[index] pageerror: ${e.message}`));
  await main.getByRole('radio', { name: 'Enhanced' }).waitFor();
  check(main.url().includes(`#/note/${firstNote.id}`), 'opening a meeting brings the window back at that meeting');

  // ---------------------------------------------------- home, light theme
  await main.goto(main.url().replace(/#.*$/, '#/'));
  await main.getByRole('heading', { name: 'Today' }).waitFor();
  check((await main.locator('.note-row').count()) === 3, 'home lists the three meetings under Today');
  await shot(main, '15-home-list');
  await main.getByText('Q3 roadmap review').first().click();
  await main.emulateMedia({ colorScheme: 'light' });
  await main.getByRole('radio', { name: 'Enhanced' }).waitFor();
  await shot(main, '16-note-light');
  await main.emulateMedia({ colorScheme: 'dark' });
  await main.goto(main.url().replace(/#.*$/, `#/note/${firstNote.id}`));
  await main.getByRole('tab', { name: 'Transcript' }).click();
  await main.locator('.turn-them .bubble').first().waitFor();
  check((await main.locator('.turn-them .bubble').count()) >= 2 || (await main.locator('.turn').count()) >= 2, 'a conversation shows a bubble per line');
  await shot(main, '16b-transcript-conversation');
  await main.emulateMedia({ colorScheme: 'light' });

  // Search across transcripts.
  await main.getByPlaceholder('Search meetings').fill('vendor contract');
  await main.getByText('“vendor contract”').waitFor();
  await main.locator('.note-row mark').first().waitFor();
  check((await main.locator('.note-row').count()) >= 1, 'search finds meetings by transcript text');
  await shot(main, '17-search');

  // ------------------------------------------------- a meeting in Sinhala
  await main.getByPlaceholder('Search meetings').fill('');
  await main.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('toru-desktop');
    r.onsuccess = () => {
      const tx = r.result.transaction(['notes', 'segments'], 'readwrite');
      const now = Date.now();
      tx.objectStore('notes').put({
        id: 'si-note', folderId: 'inbox', title: 'Spring Boot පරිසරය සැකසීම', titleEdited: true, createdAt: now, updatedAt: now, durationMs: 22_000,
        status: 'done', sources: 'both', myNotes: '- Kafka ගැන අහන්න', summaryModel: 'gpt-5-mini', summaryAt: now, summaryTemplate: 'meeting',
        summary: '## සාරාංශය\nමෙම පාඩමේදී Java Spring Boot සමඟ microservice පරිසරයක් සකසන ආකාරය පෙන්වා දෙන ලදී.\n\n## ප්‍රධාන කරුණු\n- **Kafka**: සිදුවීම් ප්‍රවාහනය (event streaming) සඳහා\n- **Postgres සහ MongoDB**: දත්ත ගබඩා කිරීම සඳහා\n\n## කළ යුතු දේ\n- [ ] **Me**: GitHub repository එක පරීක්ෂා කරන්න',
      });
      [
        ['them', 0, 'හැමෝටම ආයුබෝවන්, අද අපි Java Spring Boot පාවිච්චි කරලා microservice එකක් හදනවා.'],
        ['me', 6000, 'Kafka සහ Postgres දෙකම අපිට ඕනද?'],
        ['them', 11000, 'ඔව්, event streaming වලට Kafka, දත්ත වලට Postgres සහ MongoDB.'],
        ['me', 17000, 'හරි, මම GitHub repository එක බලන්නම්.'],
      ].forEach(([speaker, startMs, text], index) => tx.objectStore('segments').put({ noteId: 'si-note', index, startMs, endMs: startMs + 4000, speaker, text }));
      tx.oncomplete = () => res();
    };
  }));
  await main.goto(main.url().replace(/#.*$/, '#/note/si-note'));
  await main.getByRole('radio', { name: 'Enhanced' }).waitFor();
  await shot(main, '19-sinhala-notes');
  await main.getByRole('tab', { name: 'Transcript' }).click();
  await main.locator('.turn-them .bubble').first().waitFor();
  await shot(main, '19b-sinhala-transcript');
  const fontOk = await main.evaluate(() => document.fonts.check('16px "Nirmala UI"') || document.fonts.check('16px "Noto Sans Sinhala"'));
  check(true, `Sinhala meeting renders (screenshots 19, 19b; a Sinhala-capable font is ${fontOk ? '' : 'not '}installed)`);
} catch (e) {
  failures++;
  console.error('FAIL ', e.message);
  await main?.screenshot({ path: join(OUT, 'zz-failure-main.png') }).catch(() => {});
} finally {
  await app.close().catch(() => {});
  server.close();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true }); // keep only the screenshots
}

const relevant = errors.filter((e) => !/Electron Security Warning|Autofill|DevTools/.test(e));
check(relevant.length === 0, `no console errors${relevant.length ? `:\n  ${relevant.join('\n  ')}` : ''}`);
console.log(`\nOpenAI mock: ${requests.transcribe} transcriptions, ${requests.summary} summaries, ${requests.ask} answers`);
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
