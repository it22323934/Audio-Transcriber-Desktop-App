// Fast checks for the pure logic: node --test tests/unit.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appName, parseMicUsage } from '../electron/meetings.ts';
import { isEcho } from '../src/lib/echo.ts';
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

test('splits the title line off enhanced notes', () => {
  assert.deepEqual(splitTitle('# Q3 roadmap review\n\n## Summary\nText'), { title: 'Q3 roadmap review', body: '## Summary\nText' });
  assert.deepEqual(splitTitle('## Summary\nText'), { body: '## Summary\nText' });
  assert.equal(splitTitle('  \n# **Hiring** sync #\n\nBody').title, 'Hiring sync');
});

test('builds the notes prompt from template and instructions', () => {
  const p = summaryPrompt('standup', 'Write in British English.', '', undefined);
  assert.match(p, /## Updates/);
  assert.match(p, /- Write in British English\./);
  assert.match(summaryPrompt('nope'), /## Decisions/); // unknown → default template
});
