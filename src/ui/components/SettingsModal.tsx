import { useEffect, useRef, useState } from 'react';
import { bridge } from '../../lib/bridge';
import { downloadFile } from '../../lib/export';
import { errorMessage, formatBytes } from '../../lib/format';
import { listModels } from '../../lib/openai';
import { isDeprecatedTranscribeModel, RECOMMENDED_TRANSCRIBE_MODEL } from '../../lib/transcribeModels';
import { discardAudio, testTranscription } from '../../lib/pipeline';
import * as store from '../../lib/store';
import { TEMPLATES } from '../../lib/templates';
import type { Settings, ThemePreference } from '../../lib/types';
import { IconCheck, IconDownload, IconEye, IconEyeOff, IconUpload } from '../icons';
import { toast } from '../toast';
import { applyTheme } from '../theme';
import { getLanguage, languageOptions } from '../../lib/languages';
import { Modal, useConfirm } from './Modal';
import { ComboInput, Select } from './Select';

const TRANSCRIBE_MODELS = [
  { value: 'gpt-transcribe', description: 'OpenAI’s current model (default)' },
  { value: 'gpt-4o-mini-transcribe', description: 'Older, low cost · shuts down 26 Feb 2027' },
  { value: 'gpt-4o-transcribe', description: 'Older · shuts down 26 Feb 2027' },
  { value: 'whisper-1', description: 'The original Whisper · shuts down 26 Feb 2027' },
];
const SUMMARY_MODELS = [
  { value: 'gpt-5-mini', description: 'Balanced quality and cost (default)' },
  { value: 'gpt-5', description: 'Best notes, slower and pricier' },
  { value: 'gpt-5-nano', description: 'Cheapest, fine for short meetings' },
  { value: 'gpt-4.1-mini', description: 'Fast, no reasoning step' },
  { value: 'gpt-4.1', description: 'Strong, no reasoning step' },
];
const THEMES: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

function useMicrophones() {
  const [mics, setMics] = useState<{ value: string; label: string }[]>([]);
  useEffect(() => {
    const load = () =>
      navigator.mediaDevices.enumerateDevices().then(
        (devices) =>
          setMics(
            devices
              .filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
              .map((d, i) => ({ value: d.deviceId, label: d.label || `Microphone ${i + 1}` })),
          ),
        () => setMics([]),
      );
    void load();
    navigator.mediaDevices.addEventListener('devicechange', load);
    return () => navigator.mediaDevices.removeEventListener('devicechange', load);
  }, []);
  return mics;
}

function Switch(props: { checked: boolean; onChange: (v: boolean) => void; title: string; hint: string }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      <span className="switch-text">
        <strong>{props.title}</strong>
        <span className="field-hint">{props.hint}</span>
      </span>
    </label>
  );
}

export function SettingsModal({ initial, onClose }: { initial: Settings; onClose: () => void }) {
  const [draft, setDraft] = useState<Settings>(initial);
  const [showKey, setShowKey] = useState(false);
  const [test, setTest] = useState<{ state: 'idle' | 'testing' | 'ok' | 'fail'; message?: string }>({ state: 'idle' });
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const usage = useStorageUsage();
  const mics = useMicrophones();
  const { confirm, element: confirmEl } = useConfirm();

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setDraft((d) => ({ ...d, [key]: value }));

  /** Checks the key, then transcribes one second of silence with the chosen model and language. */
  async function testKey() {
    setTest({ state: 'testing' });
    const key = draft.apiKey.trim();
    const model = draft.transcribeModel.trim() || store.DEFAULT_SETTINGS.transcribeModel;
    const lang = getLanguage(draft.language);
    const inLang = lang ? ` in ${lang.name}` : '';
    try {
      const models = await listModels(key);
      const missing = [model, draft.summaryModel].filter((m) => !models.includes(m));
      try {
        await testTranscription(key, model, draft.language);
      } catch (e) {
        setTest({ state: 'fail', message: `The key works, but OpenAI refused a test transcription with ${model}${inLang}: ${errorMessage(e)}` });
        return;
      }
      setTest({
        state: 'ok',
        message: `${missing.length ? `Key works, but this account can’t see: ${missing.join(', ')}.` : 'Key works. Both models are available.'} Transcription with ${model}${inLang} works.`,
      });
    } catch (e) {
      setTest({ state: 'fail', message: errorMessage(e) });
    }
  }

  async function save() {
    setSaving(true);
    try {
      await store.saveSettings({
        ...draft,
        apiKey: draft.apiKey.trim(),
        transcribeModel: draft.transcribeModel.trim() || store.DEFAULT_SETTINGS.transcribeModel,
        summaryModel: draft.summaryModel.trim() || store.DEFAULT_SETTINGS.summaryModel,
      });
      toast('Settings saved');
      onClose();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setSaving(false);
    }
  }

  async function exportData() {
    const backup = await store.exportBackup();
    const date = new Date().toISOString().slice(0, 10);
    downloadFile(`toru-backup-${date}.json`, JSON.stringify(backup, null, 2), 'application/json');
  }

  async function importData(file: File) {
    try {
      const result = await store.importBackup(JSON.parse(await file.text()));
      toast(`Imported ${result.notes} meetings in ${result.folders} folders`);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  }

  async function discardWaiting() {
    if (!usage) return;
    const ok = await confirm({
      title: 'Discard all waiting audio?',
      message: `${formatBytes(usage.backlog.bytes)} of audio from ${usage.backlog.noteIds.length} meeting(s) couldn’t be transcribed yet. Their existing transcripts are kept; the audio can’t be retried afterwards. A recording in progress isn’t touched.`,
      confirmLabel: 'Discard audio',
      danger: true,
    });
    if (!ok) return;
    try {
      const n = await discardAudio();
      toast(`Discarded waiting audio from ${n} meeting${n === 1 ? '' : 's'}`);
      usage.refresh();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  }

  return (
    <>
      <Modal
        title="Settings"
        subtitle="Everything stays on this computer. Only audio and text for your notes are sent to OpenAI."
        onClose={onClose}
        width={620}
        footer={
          <>
            <button className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save settings'}
            </button>
          </>
        }
      >
        <section className="modal-section">
          <h3>OpenAI</h3>
          <div className="field">
            <label htmlFor="apiKey">API key</label>
            <div className="row">
              <div className="grow" style={{ position: 'relative' }}>
                <input
                  id="apiKey"
                  className="input mono"
                  type={showKey ? 'text' : 'password'}
                  placeholder="sk-…"
                  autoComplete="off"
                  spellCheck={false}
                  value={draft.apiKey}
                  onChange={(e) => {
                    set('apiKey', e.target.value);
                    setTest({ state: 'idle' });
                  }}
                  style={{ paddingRight: 40 }}
                />
                <button
                  className="icon-btn"
                  style={{ position: 'absolute', right: 3, top: 3 }}
                  onClick={() => setShowKey((s) => !s)}
                  aria-label={showKey ? 'Hide key' : 'Show key'}
                >
                  {showKey ? <IconEyeOff /> : <IconEye />}
                </button>
              </div>
              <button className="btn" onClick={testKey} disabled={!draft.apiKey.trim() || test.state === 'testing'}>
                {test.state === 'testing' ? 'Testing…' : 'Test'}
              </button>
            </div>
            {test.message && (
              <div className={`callout ${test.state === 'ok' ? 'callout-lime' : 'callout-error'}`}>
                {test.state === 'ok' && <IconCheck />}
                <div className="callout-body">{test.message}</div>
              </div>
            )}
            <div className="field-hint">
              Create one at{' '}
              <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">
                platform.openai.com/api-keys
              </a>
              . It’s encrypted with your Windows account and only sent to api.openai.com. Test also transcribes one
              second of silence with your model and language (a fraction of a cent).
            </div>
          </div>
        </section>

        <section className="modal-section">
          <h3>Listening</h3>
          <div className="grid-2">
            <div className="field">
              <span className="field-label">New meetings listen to</span>
              <div className="seg" role="radiogroup" aria-label="Audio sources" style={{ justifySelf: 'start' }}>
                <button role="radio" aria-selected={draft.sources === 'both'} aria-checked={draft.sources === 'both'} onClick={() => set('sources', 'both')}>
                  Mic + computer
                </button>
                <button role="radio" aria-selected={draft.sources === 'mic'} aria-checked={draft.sources === 'mic'} onClick={() => set('sources', 'mic')}>
                  Mic only
                </button>
              </div>
            </div>
            <div className="field">
              <label htmlFor="mic">Microphone</label>
              <Select
                id="mic"
                ariaLabel="Microphone"
                value={draft.micDeviceId}
                options={[{ value: '', label: 'System default' }, ...mics]}
                onChange={(v) => set('micDeviceId', v)}
                listMinWidth={280}
              />
            </div>
          </div>
          <div className="field-hint">
            “Mic + computer” is for calls: your microphone is labelled <strong>Me</strong> and everything your computer plays
            (Teams, Zoom, Slack, Meet…) is <strong>Them</strong>. No bot joins the call. Use “Mic only” in person.
            Headphones give the cleanest transcript.
          </div>
          <Switch
            checked={draft.detectMeetings}
            onChange={(v) => set('detectMeetings', v)}
            title="Offer to take notes when a call starts"
            hint="When Teams, Zoom, Slack, Discord, Webex or a browser starts using your microphone, a small prompt appears at the side of the screen."
          />
          <Switch
            checked={draft.autoStop}
            onChange={(v) => set('autoStop', v)}
            title="Stop when the call ends"
            hint="15 seconds after the call app lets go of the microphone, unless you press Keep recording."
          />
          <Switch
            checked={draft.widget}
            onChange={(v) => set('widget', v)}
            title="Floating recorder"
            hint="While recording, a small bar with the timer and live transcript stays on top of other windows. It hides while TORU is in front."
          />
          <Switch
            checked={draft.openAtLogin}
            onChange={(v) => set('openAtLogin', v)}
            title="Start TORU when I sign in"
            hint="It waits in the tray so it can notice your calls. (Only for the installed app.)"
          />
          <div className="field-hint">
            Start or stop from anywhere with <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>R</kbd>, or from the tray icon.{' '}
            <button className="link-btn" onClick={() => bridge.app.openMicSettings()}>
              Windows microphone settings
            </button>
          </div>
        </section>

        <section className="modal-section">
          <h3>Transcription</h3>
          <div className="grid-2">
            <div className="field">
              <label htmlFor="tmodel">Model</label>
              <ComboInput id="tmodel" value={draft.transcribeModel} onChange={(v) => set('transcribeModel', v)} suggestions={TRANSCRIBE_MODELS} />
            </div>
            <div className="field">
              <label htmlFor="lang">Spoken language</label>
              <Select
                id="lang"
                ariaLabel="Spoken language"
                value={draft.language}
                options={languageOptions([{ value: '', label: 'Auto-detect' }])}
                onChange={(v) => {
                  set('language', v);
                  setTest({ state: 'idle' });
                }}
                listMinWidth={300}
              />
            </div>
          </div>
          {isDeprecatedTranscribeModel(draft.transcribeModel) && (
            <div className="callout callout-warn">
              <div className="callout-body">
                <span>
                  OpenAI shuts down {draft.transcribeModel} on 26 February 2027. After that date TORU uses {RECOMMENDED_TRANSCRIBE_MODEL} instead.
                </span>
                <div className="callout-actions">
                  <button className="btn btn-sm btn-light" onClick={() => set('transcribeModel', RECOMMENDED_TRANSCRIBE_MODEL)}>
                    Switch to {RECOMMENDED_TRANSCRIBE_MODEL} now
                  </button>
                </div>
              </div>
            </div>
          )}
          <div className="field-hint">
            For anything other than English, choose the language: TORU asks for its own script (සිංහල, தமிழ், हिन्दी…) and
            keeps English words in English, as people often mix them in. Languages marked “less accurate” work, but expect more
            mistakes. Silence isn’t sent, so quiet stretches cost nothing.
          </div>
        </section>

        <section className="modal-section">
          <h3>Notes and questions</h3>
          <div className="grid-2">
            <div className="field">
              <label htmlFor="template">Default template</label>
              <Select
                id="template"
                ariaLabel="Default template"
                value={draft.templateId}
                options={TEMPLATES.map((t) => ({ value: t.id, label: t.name, description: t.description }))}
                onChange={(v) => set('templateId', v)}
                listMinWidth={280}
              />
            </div>
            <div className="field">
              <label htmlFor="smodel">Model</label>
              <ComboInput id="smodel" value={draft.summaryModel} onChange={(v) => set('summaryModel', v)} suggestions={SUMMARY_MODELS} />
            </div>
          </div>
          <div className="field-hint">Folders and single meetings can pick their own template. The model also answers your questions in Ask.</div>
          <div className="field">
            <label htmlFor="nlang">Write notes in</label>
            <Select
              id="nlang"
              ariaLabel="Write notes in"
              value={draft.notesLanguage}
              options={languageOptions([{ value: 'spoken', label: 'The language that was spoken' }])}
              onChange={(v) => set('notesLanguage', v)}
              listMinWidth={300}
            />
            <div className="field-hint">For example English notes from a Sinhala meeting. Folders can choose their own.</div>
          </div>
          <div className="field">
            <label htmlFor="instructions">Your instructions</label>
            <textarea
              id="instructions"
              className="input"
              rows={3}
              placeholder="e.g. Write in British English. I’m the engineering lead, so flag anything that needs my decision."
              value={draft.instructions}
              onChange={(e) => set('instructions', e.target.value)}
            />
            <div className="field-hint">Added to every set of enhanced notes.</div>
          </div>
          <Switch
            checked={draft.autoSummarize}
            onChange={(v) => set('autoSummarize', v)}
            title="Enhance notes when a meeting ends"
            hint="The default for new meetings; you can switch it per meeting while recording. Each costs about 1¢ on your OpenAI account."
          />
          <Switch
            checked={draft.autoCompact}
            onChange={(v) => set('autoCompact', v)}
            title="Compact long conversations automatically"
            hint="When older Ask messages no longer fit what’s sent with a question, summarise them first (one small extra request) so TORU keeps their gist."
          />
        </section>

        <section className="modal-section">
          <h3>Appearance</h3>
          <div className="seg" role="radiogroup" aria-label="Theme" style={{ justifySelf: 'start' }}>
            {THEMES.map((t) => (
              <button
                key={t.value}
                role="radio"
                aria-selected={draft.theme === t.value}
                aria-checked={draft.theme === t.value}
                onClick={() => {
                  // Applies straight away, so you can see it before saving the rest.
                  set('theme', t.value);
                  applyTheme(t.value);
                  void store.saveSettings({ theme: t.value });
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
        </section>

        <section className="modal-section">
          <h3>Your data</h3>
          {usage && (
            <div className="callout">
              <div className="callout-body">
                <span>
                  TORU is using <strong>{formatBytes(usage.bytes)}</strong> on this computer.{' '}
                  {usage.backlog.chunks
                    ? `${formatBytes(usage.backlog.bytes)} of that is audio from ${usage.backlog.noteIds.length} meeting${usage.backlog.noteIds.length === 1 ? '' : 's'} still waiting to be transcribed.`
                    : 'No audio is waiting. Audio is deleted as soon as it has been transcribed; only the text is kept.'}
                </span>
                {usage.backlog.chunks > 0 && (
                  <div className="callout-actions">
                    <button className="btn btn-sm btn-danger" onClick={discardWaiting}>
                      Discard waiting audio
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
          <div className="row">
            <button className="btn btn-sm" onClick={exportData}>
              <IconDownload size={14} /> Export backup
            </button>
            <button className="btn btn-sm" onClick={() => fileRef.current?.click()}>
              <IconUpload size={14} /> Import backup
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void importData(file);
                e.target.value = '';
              }}
            />
          </div>
          <div className="field-hint">Backups leave out your API key. TORU {bridge.env.version}</div>
        </section>
      </Modal>
      {confirmEl}
    </>
  );
}

function useStorageUsage() {
  const [usage, setUsage] = useState<{ bytes: number; backlog: Awaited<ReturnType<typeof store.audioBacklog>> }>();
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let alive = true;
    Promise.all([navigator.storage.estimate(), store.audioBacklog()]).then(
      ([estimate, backlog]) => alive && setUsage({ bytes: estimate.usage ?? 0, backlog }),
      console.error,
    );
    return () => {
      alive = false;
    };
  }, [version]);
  return usage && { ...usage, refresh: () => setVersion((v) => v + 1) };
}
