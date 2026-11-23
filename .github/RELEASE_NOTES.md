TORU for Windows takes notes on your calls and meetings. It listens to your microphone ("Me") and to everything your computer plays ("Them"), so it works with Teams, Zoom, Slack, Google Meet, Discord and Webex without a bot joining the call. It transcribes as people talk, and when the meeting ends it turns your rough notes into proper ones.

## Install

1. Download **`TORU-Setup-<version>.exe`** below and run it.
2. The installer isn't code-signed yet, so Windows SmartScreen may say "Windows protected your PC". Click **More info → Run anyway**.
3. Open TORU, go to **Settings**, paste your own [OpenAI API key](https://platform.openai.com/api-keys), and press **Test**.

To update, quit TORU from its tray icon and run the new installer. Your meetings and settings are kept.

**Needs:** Windows 10 or 11 (64-bit), a microphone, and an OpenAI API key. Transcription and notes are billed to your OpenAI account, usually a few cents a meeting.

## What it does

- **Notices calls.** When a call app starts using your microphone, a small prompt offers to take notes. When the call ends, recording stops by itself.
- **Live transcript** with Me and Them shown as a chat. Lines picked up through your speakers are spotted and hidden.
- **Notepad, then enhanced notes.** Type a few words per point during the call. Afterwards TORU writes the summary, decisions and action items (with checkboxes) around them, using templates: General, 1:1, Stand-up, Customer call, Interview, Lecture, Brainstorm.
- **About 80 languages**, including Sinhala (සිංහල) and Tamil (தமிழ்), written in their own script. Notes can be written in another language, for example English notes from a Sinhala meeting.
- **Warns when it can't hear anything**, such as a muted microphone, and says so when a recording had no speech.
- **Ask** questions about any meeting, search every transcript, and file meetings in folders. A floating recorder, a tray icon and **Ctrl+Alt+R** work from anywhere.

Everything stays on your computer. TORU talks only to `api.openai.com`, with your key, which is encrypted with your Windows account.
