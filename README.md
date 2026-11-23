# TORU for Windows: meeting notes that write themselves

A desktop app that listens to your calls (Teams, Zoom, Slack huddles, Google Meet, Discord, Webex, anything that plays through your computer) and your in-person meetings. It:

1. **hears both sides without joining the call.** Your microphone is **Me**, and everything your computer plays is **Them**.
2. **transcribes live**, with new lines a few seconds after someone stops talking,
3. gives you a **notepad**: jot a few words per point while you talk,
4. when the meeting ends, **enhances your notes**: it writes proper notes around what you typed, using the transcript (summary, discussion, decisions, action items with checkboxes) and gives the meeting a title,
5. **notices calls**: when a call app picks up your microphone, a small prompt offers to take notes. When the call ends, it stops by itself.

Afterwards you can **Ask** about any meeting ("What did I commit to?", "Draft a follow-up email"), search across every transcript, and file meetings in folders.

It's the desktop sibling of the TORU Chrome extension and uses the same design and the same OpenAI pipeline, but it's a separate app with its own data.

Everything stays on your computer. The only server it talks to is `api.openai.com`, with your own key.

---

## Install

**Installer:** download `TORU-Setup-<version>.exe` from the [latest release](https://github.com/it22323934/Audio-Transcriber-Desktop-App/releases/latest) and run it (or build it yourself with `npm run dist`, below). It's not code-signed, so Windows SmartScreen may say "Windows protected your PC". Click **More info → Run anyway**. To update, quit TORU from the tray and run the new installer; your meetings are kept.

**From source** (Node 20+):

```bash
npm install
npm start          # builds and runs
npm run dist       # builds the installer into release/
```

## First run

1. Open **Settings** (bottom left), paste your OpenAI API key, press **Test**, then **Save settings**. The key is encrypted with your Windows account; it's never stored in plain text.
2. Optional: create a **folder** (the **+** next to *Folders*), e.g. "Product team". Add **names and terms** ("Priya, Kubernetes, OKRs") so the transcriber spells them right, and pick a **template**.
3. Make sure Windows lets desktop apps use the mic: **Settings → Privacy & security → Microphone → Let desktop apps access your microphone**. TORU's Settings has a link straight there.

## Taking notes on a call

- **It offers:** join a call as usual. Within a few seconds of the call app using your mic, a prompt slides in at the right of your screen: *"Zoom is using your mic · Take notes"*. Click it.
- **Or start it yourself:** **Start** on the home page, **Ctrl+Alt+R** from anywhere, or the tray icon.

While it records, the meeting page is a notepad. Type short points; bullets continue when you press Enter. The dock at the bottom shows the timer, a level meter for **you** (mic) and **them** (computer audio), the latest line, **Pause** and **Stop**. The **Transcript** tab shows the conversation as Me/Them bubbles.

When you switch to another window, TORU's window gets out of the way and a **floating recorder** stays on top: timer, levels, pause/stop. Click the arrow to see the last few lines and **jot a note** without switching windows. Drag it anywhere by its grip; it remembers where you put it.

When the call app lets go of the microphone (you left the call), the widget asks *"Has the Zoom call ended?"* and stops 15 seconds later, unless you press **Keep recording**. Then the notes are enhanced, and the widget says when they're ready.

### In person

Choose **In person** on the home page, or **Take notes in person** in the tray. Only the microphone is recorded, and lines aren't split into Me/Them.

### When nothing can be heard

- **While recording:** if your microphone sends no signal at all for 8 seconds (muted in Windows or on the headset, or the wrong mic chosen), a warning appears above the dock and in the floating recorder: **Your microphone isn't sending any sound**, with a link to Windows' microphone settings. If nobody has been heard on either side for a minute, it says **Nothing has been heard for a minute** and suggests what to check. The warnings clear as soon as sound comes back.
- **When you stop:** if nothing was said and you typed no notes, TORU doesn't keep an empty meeting. It tells you instead: **Nothing was heard in "…", so it wasn't saved**, in the main window and the floating recorder. If you typed notes, the meeting is kept with them.

### Headphones or speakers

With headphones the two sides stay perfectly separate. With speakers your mic also hears the call. TORU spots those lines (a "Me" line that repeats what "Them" just said), hides them and leaves them out of what the AI reads. The transcript tells you how many it hid; **Show** reveals them.

## After the meeting

- **Enhanced / My notes:** the enhanced notes are shown by default. **My notes** shows exactly what you typed. The AI makes sure every point you typed is covered.
- **Action items** are checkboxes. Tick them off; it's saved.
- **Templates:** *General*, *1:1*, *Stand-up*, *Customer call*, *Interview*, *Lecture or class*, *Brainstorm*. Pick one per meeting (the chip under the title), per folder, or as the default in Settings. Changing it offers **Rewrite as …**.
- **Your instructions** (Settings) and **Extra instructions** (per folder) are added to every summary, e.g. "Write in British English" or "List any Jira ticket numbers".
- **Ask:** questions about this meeting, answered from the transcript with times like **[12:34]**. Follow-ups remember the conversation; long conversations can be compacted. Same context meter as the extension.
- **Export:** copy or download a meeting as Markdown, or a whole folder from its page. Backups are under **Settings → Your data**.

## Languages

TORU transcribes about 80 languages, and can write the notes in a different language from the meeting's.

- **Spoken language** (Settings → Transcription, or per folder). Auto-detect works for many meetings, but pick the language for anything other than English. TORU then tells the transcriber to expect that language plus English, because people often mix in English terms. It also asks for the language's own script, so Sinhala comes back as සිංහල, not romanised or translated. Put names and technical terms in the folder's **Names and terms**; they're sent as keywords.
- **How well it works.** OpenAI's models are strong for about 57 languages, including English, German, French, Hindi and Tamil. Languages marked **less accurate** in the list, Sinhala among them, are understood too, but expect more mistakes, especially with mixed Sinhala–English speech, several people talking at once, or poor audio.
- **Check first.** Settings → **Test** transcribes one second of silence with your model and language, so you know straight away whether OpenAI accepts them.
- **Write notes in** (Settings → Notes and questions, or per folder). Choose **The language that was spoken** (the default) or any other language, for example English notes from a Sinhala meeting.
- **Ask** answers in the language you write your question in.
- **Display and search.** Sinhala, Tamil, Hindi and other scripts display with Windows' Nirmala UI font, and search works in any script.

## The tray and closing the window

Closing the window keeps TORU running in the tray so it can notice calls. **Right-click the tray icon → Quit TORU** to quit. The tray icon gets a red dot while recording. **Start TORU when I sign in** (Settings) starts it in the tray at login (installed app only).

If you quit, or Windows restarts, during a meeting, nothing is lost. The audio that wasn't sent yet is kept, and TORU finishes the transcript and notes the next time it starts.

## Costs (your OpenAI account)

| Part | Default model | Roughly |
|---|---|---|
| Transcription | `gpt-transcribe` | check OpenAI's pricing page; the older `gpt-4o-mini-transcribe` was ~$0.003 per minute of speech per side, so a 30-minute call where both sides talk ≈ 10–15¢ |
| Enhanced notes | `gpt-5-mini` | about 1¢ per meeting |
| Ask | `gpt-5-mini` | well under 1¢ per question for a typical meeting |

Silence isn't sent: each side is only transcribed while someone on it is talking, and TORU learns your mic's background hiss so it doesn't pay to transcribe a quiet room. Check OpenAI's pricing page for current prices.

**Transcription models.** OpenAI shuts down `gpt-4o-mini-transcribe`, `gpt-4o-transcribe` and `whisper-1` on **26 February 2027**. New setups use `gpt-transcribe`, OpenAI's current model. If Settings still names an older one, it shows a **Switch** button, and after that date TORU switches by itself.

## Privacy

- Meetings, notes and transcripts are stored on this computer (in `%APPDATA%\TORU`). The API key is encrypted with Windows DPAPI.
- Audio is kept only until it's transcribed, then deleted. Only text is kept.
- Recording other people may need their consent where you live. Let people know when you're taking notes.
- Call detection only asks Windows' audio system which programs are recording from a microphone right now (the same information as the mic icon in the taskbar). It doesn't look at your screen, listen to other apps, or read their data.

## If something goes wrong

| Symptom | Fix |
|---|---|
| "Windows is blocking the microphone" | Settings → Privacy & security → Microphone → turn on *Let desktop apps access your microphone* |
| Only "Me" lines, no "Them" | Check the meeting is a **Call**, not **In person**, and that the call plays through your default output device |
| Your own voice shows up as "Them" | Turn off "Listen to this device" or sidetone for your headset in Windows sound settings |
| Lots of "Me" lines repeating the other side | Use headphones, or lower the speaker volume. TORU hides most of them anyway |
| A meeting says "Needs attention" | Read the message. **Retry transcription** resends audio that failed; **Try again** rewrites the notes |
| No prompt when a call starts | Settings → *Offer to take notes when a call starts*. TORU recognises Teams, Zoom, Slack, Discord, Webex, Skype, WhatsApp, Telegram, RingCentral, GoTo and browsers (for Meet) |
| The prompt says Teams is using your mic when you're not in a call | Teams sometimes keeps the microphone open in the background (the taskbar shows the mic icon). Press ✕; TORU asks again only when Teams next picks the mic up |
| The same sentences appear twice in a transcript | Older recordings could have this: on quiet audio the transcriber sometimes returned the context TORU gave it. New recordings drop that copied text |
| Ctrl+Alt+R does nothing | Another app has that shortcut. Use the tray icon or the home page |
| "Your microphone isn't sending any sound" | Unmute the mic (Windows, headset button, or the call app's system mute), or pick the right one under Settings → Listening |
| "Nothing was heard … so it wasn't saved" | The recording had no speech on either side. Check the call plays on this computer and the mic is on, then record again |
| Test says OpenAI refused a transcription | Read the message. A language may not be accepted by that model: choose Auto-detect or another model |
| A Sinhala (or other) meeting comes back in English letters or translated | Set the **Spoken language** for the folder or in Settings; Auto-detect can mistake it |

---

## Development

```bash
npm run dev        # Vite dev server with hot reload + Electron (restarts when electron/ changes)
npm run typecheck
npm run test:unit  # call detection, echo and copy detection, templates
npm run test:e2e   # builds, then drives the real app end to end
npm run test:perf  # idle CPU, a two-hour meeting's live updates, memory with the window closed
```

### Releases

Push a version tag and GitHub Actions builds the installer on Windows and publishes it as a release:

```bash
npm version patch          # bumps package.json and creates the tag, e.g. v0.1.1
git push --follow-tags
```

The workflow (`.github/workflows/release.yml`) runs the type checks and unit tests, builds with `npm run dist`, and attaches `TORU-Setup-<version>.exe` to the release for that tag.

The end-to-end suite launches the app with a throwaway profile, a mock OpenAI server and synthetic "voices" for the mic and the call. It goes through setup, a live call with both speakers (including an echo line), the floating widget and quick notes, pause/stop, enhanced notes with an AI title and checkboxes, Ask, a detected Zoom call that auto-stops, an in-person meeting, and quitting mid-meeting then recovering. Screenshots go to `.e2e-out/`. TORU's windows appear on screen while it runs.

VS Code's terminal sets `ELECTRON_RUN_AS_NODE`, which makes Electron behave like plain Node. The scripts clear it; if you run `electron .` yourself from that terminal, clear it first.

### Memory and CPU

- **Audio:** converted to 16 kHz mono 16-bit on the audio thread; at most ~30 s per side is held in memory before it's saved; the screen picture that Windows' loopback capture requires is dropped at once; silence is never sent (each side learns its own background level); audio is deleted once transcribed.
- **Call detection:** Windows' audio sessions are read in-process through `koffi` (about 2 ms every 2 s). No process is started. `reg.exe` is only a fallback if the native library can't load.
- **Long meetings:** change events name the lines that changed, so the meeting page reads only new lines; the floating recorder reads only its last few; the echo check reads only nearby lines. Transcript rows are memoised and off-screen rows skip layout (`content-visibility`).
- **In the tray:** closing the main window destroys it, so its renderer's memory is freed; it reopens at the page you asked for. Started at sign-in, it isn't loaded until you open it.
- **Timers:** level meters run only while recording and while one is on screen.

`npm run test:perf` measures all of this on a 1,500-line (two-hour) meeting. On the development machine: one call check 1.7 ms (was ~100 ms with `reg.exe`), 12 ms of main-thread work per new line (was 45–63 ms), 297 MB with the long meeting open (was 430 MB), 215 MB after closing the window (was 336 MB).

### How it fits together

```
main process (electron/main.ts)
  • serves the pages from toru://app/ (with a strict CSP)
  • getDisplayMedia handler → screen source + Windows loopback audio
  • meeting watcher (electron/meetings.ts): which apps are capturing from a mic (WASAPI, via koffi)
  • tray, Ctrl+Alt+R, floating widget window, encrypted API key
  • relays commands to the recorder (webContents.executeJavaScript)
        │
        ├── main window (src/app)        home, folders, meeting page, search, settings
        ├── widget window (src/widget)   prompt / recording pill / ending / done
        └── recorder window (src/recorder, hidden, never throttled)
              • mic (getUserMedia) → "me"   ┐ AudioWorklet → 16 kHz mono PCM
              • loopback (getDisplayMedia) → "them" ┘
              • per channel: adaptive noise floor, chunks cut at turns and pauses,
                silence trimmed, saved to IndexedDB before sending
              • one queue → OpenAI transcription → segments (+ echo check)
              • on stop: enhanced notes (template) → title

IndexedDB "toru-desktop" ◄── shared by all three windows; changes broadcast over a BroadcastChannel
```

| Path | What's there |
|---|---|
| `electron/` | Main process, preload (the `window.toru` bridge), call detection |
| `src/shared/bridge.ts` | The typed contract between the main process and the windows |
| `src/recorder/` | Capture, chunking, transcription queue, recovery after a crash |
| `src/lib/` | Data store, OpenAI client, pipeline, templates, languages, echo and copy detection, Ask, export |
| `src/ui/` | Design system (`styles.css`), shared components, Markdown renderer |
| `src/app/`, `src/widget/` | The main window and the floating widget |
| `scripts/` | Dev runner, esbuild config, icon generator |
| `tests/` | Unit tests and the end-to-end suite |
