// Fast checks for the pure logic: node --test tests/unit.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appName, nativeMicReader, parseMicUsage } from '../electron/meetings.ts';
import { isEcho, stripPromptCopy } from '../src/lib/echo.ts';
import { languageLabel, getLanguage, LANGUAGES, notesLanguageRule, scriptHint, transcriptionLanguages } from '../src/lib/languages.ts';
import { tokensPerCharFor } from '../src/lib/models.ts';
import { cleanKeywords, effectiveTranscribeModel, isDeprecatedTranscribeModel, takesLanguageList } from '../src/lib/transcribeModels.ts';
import { splitTitle, summaryPrompt } from '../src/lib/templates.ts';

const REG = String.raw`
HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone
    Value    REG_SZ    Allow

HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\MSTeams_8wekyb3d8bbwe
    Value    REG_SZ    Allow
    LastUsedTimeStart    REG_QWORD    0x1dd647f032bd634
    LastUsedTimeStop    REG_QWORD    0x0

HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\NonPackaged\C:#Users#me#AppData#Roaming#Zoom#bin#Zoom.exe
    LastUsedTimeStart    REG_QWORD    0x1dad39c6ca0481a
    LastUsedTimeStop    REG_QWORD    0x1dad3a1948cd55c

HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\NonPackaged\C:#Program Files#Google#Chrome#Application#chrome.exe
    LastUsedTimeStart    REG_QWORD    0x1dd623e636bc73b
    LastUsedTimeStop    REG_QWORD    0x0

HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\NonPackaged\C:#Windows#System32#VoiceAccess.exe
    LastUsedTimeStart    REG_QWORD    0x1dce362177e2c9a
    LastUsedTimeStop    REG_QWORD    0x0
`;

test('reads which call apps hold the microphone', () => {
  // Teams and Chrome are active (stop = 0); Zoom stopped; Voice Access isn't a call app.
  assert.deepEqual(parseMicUsage(REG), ['Chrome', 'Microsoft Teams']);
  assert.deepEqual(parseMicUsage(REG.replace(/\r?\n/g, '\r\n')), ['Chrome', 'Microsoft Teams']);
  assert.deepEqual(parseMicUsage(''), []);
});

test('names call apps from registry keys', () => {
  assert.equal(appName('C:#Users#x#AppData#Local#Microsoft#Teams#current#Teams.exe'), 'Microsoft Teams');
  assert.equal(appName('C:#Users#x#AppData#Local#slack#app-4.41.105#slack.exe'), 'Slack');
  assert.equal(appName('C:#Users#x#AppData#Local#Discord#app-1.0.9034#Discord.exe'), 'Discord');
  assert.equal(appName('5319275A.WhatsAppDesktop_cv1g1gvanyjgm'), 'WhatsApp');
  assert.equal(appName('C:#Program Files#obs-studio#bin#64bit#obs64.exe'), undefined);
});

test('reads live microphone sessions from Windows', { skip: process.platform !== 'win32' }, async () => {
  const everything = await nativeMicReader((exe) => exe);
  assert.ok(everything, 'the native reader loads');
  assert.ok(Array.isArray(everything()));
  const calls = await nativeMicReader();
  assert.ok(calls!().every((app) => typeof app === 'string'));
});

const them = (startMs: number, text: string) => ({ startMs, endMs: startMs + 6000, speaker: 'them' as const, text });
const me = (startMs: number, text: string) => ({ startMs, endMs: startMs + 4000, speaker: 'me' as const, text });

test('flags a mic line that repeats the call', () => {
  const lines = [them(0, 'So the plan is to ship the beta to customers on Friday, okay?')];
  assert.equal(isEcho(me(1500, 'the plan is to ship the beta to customers on Friday'), lines), true);
  // Picked up through speakers, transcribed slightly differently: still an echo.
  assert.equal(isEcho(me(2000, 'So the plan is to ship the beta customers on Friday.'), lines), true);
});

test('keeps genuine replies', () => {
  const lines = [them(0, 'So the plan is to ship the beta to customers on Friday, okay?')];
  assert.equal(isEcho(me(6500, 'Friday works, but we need the release notes first.'), lines), false);
  assert.equal(isEcho(me(1500, 'Okay, sounds good.'), lines), false); // too short to judge
  // Same words, but long after: not an echo.
  assert.equal(isEcho(me(60_000, 'the plan is to ship the beta to customers on Friday'), lines), false);
});

test('drops text the transcriber copied from its prompt', () => {
  // The context TORU sent: the end of the previous lines (here cut mid-word, as it is).
  const prompt = "nd we'll be, in regards to the database side, we'll be using something like Postgres as well as MongoDB. So unstructured data. And yeah, so those are some of the main things.";
  const leaked = "And we'll be, in regards to the database side, we'll be using something like Postgres as well as MongoDB. So unstructured data. And yeah, so those are some of the main things.";
  assert.equal(stripPromptCopy(leaked, prompt), 'So unstructured data.'); // only a short fragment survives
  assert.equal(
    stripPromptCopy(`${leaked} Next we'll set up Kafka topics for the order service.`, prompt),
    "So unstructured data. Next we'll set up Kafka topics for the order service.",
  );
  const fresh = 'Now open the Docker compose file and start the containers.';
  assert.equal(stripPromptCopy(fresh, prompt), fresh);
  assert.equal(stripPromptCopy('Yeah. That is it.', prompt), 'Yeah. That is it.');
  assert.equal(stripPromptCopy(fresh, ''), fresh);
});

test('Sinhala words survive echo and copy detection', () => {
  // Sinhala puts vowel signs (combining marks) inside words; they must not split them.
  const line = 'අද අපි Java Spring Boot පාවිච්චි කරලා microservice එකක් හදනවා';
  const lines = [{ startMs: 0, endMs: 6000, speaker: 'them' as const, text: `${line}.` }];
  assert.equal(isEcho({ startMs: 1000, endMs: 5000, speaker: 'me', text: line }, lines), true);
  assert.equal(isEcho({ startMs: 1000, endMs: 5000, speaker: 'me', text: 'Kafka සහ Postgres දෙකම අපිට ඕනද කියලා මට කියන්න' }, lines), false);
  assert.equal(stripPromptCopy(`${line}. හරි, මම GitHub repository එක බලන්නම්.`, line), 'හරි, මම GitHub repository එක බලන්නම්.');
});

test('language list and hints', () => {
  assert.ok(LANGUAGES.length >= 75);
  assert.equal(new Set(LANGUAGES.map((l) => l.code)).size, LANGUAGES.length, 'no duplicate codes');
  assert.ok(LANGUAGES.every((l) => /^[a-z]{2}$/.test(l.code)), 'ISO-639-1 codes');
  assert.equal(languageLabel(getLanguage('si')!), 'Sinhala · සිංහල');
  assert.equal(languageLabel(getLanguage('de')!), 'German · Deutsch');
  assert.deepEqual(transcriptionLanguages('si'), ['si', 'en']); // Sinhala speakers mix in English
  assert.deepEqual(transcriptionLanguages('en'), ['en']);
  assert.deepEqual(transcriptionLanguages(''), []);
  assert.match(scriptHint('si'), /Sinhala script/);
  assert.match(scriptHint('ta'), /Tamil script/);
  assert.equal(scriptHint('de'), ''); // Latin script: nothing to say
  assert.match(notesLanguageRule('en'), /^Write in English/);
  assert.match(notesLanguageRule('si'), /Sinhala \(සිංහල\)/);
  assert.match(notesLanguageRule('spoken'), /language that was spoken/);
});

test('token estimates follow the script', () => {
  const english = tokensPerCharFor('So the plan for the next sprint is to finish the payments work.');
  const sinhala = tokensPerCharFor('හැමෝටම ආයුබෝවන්, අද අපි පාඩම පටන් ගන්නවා.');
  const mixed = tokensPerCharFor('හැමෝටම ආයුබෝවන්, අද අපි Java Spring Boot පාවිච්චි කරලා microservice එකක් හදනවා.');
  assert.ok(english > 0.2 && english < 0.35, `english ${english}`);
  assert.ok(sinhala > 0.6, `sinhala ${sinhala}`);
  assert.ok(mixed > english * 1.6 && mixed < sinhala, `mixed ${mixed}`);
});

test('transcription models: old ones are replaced once shut down', () => {
  const before = Date.UTC(2027, 0, 10);
  const after = Date.UTC(2027, 2, 1);
  assert.equal(effectiveTranscribeModel('gpt-4o-mini-transcribe', before), 'gpt-4o-mini-transcribe');
  assert.equal(effectiveTranscribeModel('gpt-4o-mini-transcribe', after), 'gpt-transcribe');
  assert.equal(effectiveTranscribeModel('gpt-transcribe', after), 'gpt-transcribe');
  assert.ok(isDeprecatedTranscribeModel('whisper-1'));
  assert.ok(takesLanguageList('gpt-transcribe') && !takesLanguageList('gpt-4o-transcribe'));
  assert.deepEqual(cleanKeywords([' Priya ', 'priya', 'Q3 <roadmap>', '', 'line\nbreak']), ['Priya', 'Q3 roadmap', 'line break']);
});

test('splits the title line off enhanced notes', () => {
  assert.deepEqual(splitTitle('# Q3 roadmap review\n\n## Summary\nText'), { title: 'Q3 roadmap review', body: '## Summary\nText' });
  assert.deepEqual(splitTitle('## Summary\nText'), { body: '## Summary\nText' });
  assert.equal(splitTitle('  \n# **Hiring** sync #\n\nBody').title, 'Hiring sync');
});

test('builds the notes prompt from template and instructions', () => {
  const p = summaryPrompt('standup', 'en', 'Write in British English.', '', undefined);
  assert.match(p, /Language: Write in English/);
  assert.match(p, /## Updates/);
  assert.match(p, /- Write in British English\./);
  assert.match(summaryPrompt('nope'), /## Decisions/); // unknown → default template
});
