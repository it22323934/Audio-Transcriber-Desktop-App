import { useState } from 'react';
import { errorMessage } from '../../lib/format';
import * as store from '../../lib/store';
import { TEMPLATES } from '../../lib/templates';
import type { Folder } from '../../lib/types';
import { toast } from '../toast';
import { languageOptions } from '../../lib/languages';
import { Modal, useConfirm } from './Modal';
import { Select } from './Select';

/** Create a folder (no `folder`) or edit an existing one. */
export function FolderModal(props: {
  folder?: Folder;
  onClose: () => void;
  onSaved?: (folder: Folder) => void;
  onDeleted?: () => void;
}) {
  const editing = props.folder;
  const isInbox = editing?.id === store.INBOX_ID;
  const [name, setName] = useState(editing?.name ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [vocabulary, setVocabulary] = useState(editing?.vocabulary ?? '');
  const [language, setLanguage] = useState(editing?.language ?? '');
  const [templateId, setTemplateId] = useState(editing?.templateId ?? '');
  const [notesLanguage, setNotesLanguage] = useState(editing?.notesLanguage ?? '');
  const [instructions, setInstructions] = useState(editing?.instructions ?? '');
  const [color, setColor] = useState(editing?.color ?? '');
  const [saving, setSaving] = useState(false);
  const { confirm, element: confirmEl } = useConfirm();

  async function save() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const fields = {
        name: name.trim(),
        description: description.trim(),
        vocabulary: vocabulary.trim(),
        language,
        templateId,
        notesLanguage,
        instructions: instructions.trim(),
        ...(color ? { color } : {}),
      };
      if (editing) {
        await store.updateFolder(editing.id, fields);
        props.onSaved?.({ ...editing, ...fields });
      } else {
        props.onSaved?.(await store.createFolder(fields));
      }
      props.onClose();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!editing) return;
    const ok = await confirm({
      title: `Delete “${editing.name}”?`,
      message: 'The folder is removed and its meetings move to the Inbox. Nothing else is deleted.',
      confirmLabel: 'Delete folder',
      danger: true,
    });
    if (!ok) return;
    await store.deleteFolder(editing.id);
    props.onDeleted?.();
    props.onClose();
  }

  return (
    <>
      <Modal
        title={editing ? 'Edit folder' : 'New folder'}
        subtitle={editing ? undefined : 'Group related meetings, e.g. one per team, client or course.'}
        onClose={props.onClose}
        footer={
          <>
            {editing && !isInbox && (
              <button className="btn btn-danger btn-sm" onClick={remove}>
                Delete
              </button>
            )}
            <span className="spacer" />
            <button className="btn btn-ghost" onClick={props.onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={save} disabled={!name.trim() || saving}>
              {editing ? 'Save' : 'Create folder'}
            </button>
          </>
        }
      >
        <div className="field">
          <label htmlFor="fname">Name</label>
          <input
            id="fname"
            className="input"
            placeholder="Product team"
            value={name}
            disabled={isInbox}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && save()}
          />
        </div>
        <div className="field">
          <label htmlFor="fdesc">What is it about?</label>
          <input
            id="fdesc"
            className="input"
            placeholder="Weekly syncs with the mobile app team"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <div className="field-hint">Given to the AI as context when it writes the notes.</div>
        </div>
        <div className="field">
          <label htmlFor="fvocab">Names and terms</label>
          <textarea
            id="fvocab"
            className="input"
            rows={2}
            placeholder="Priya, Tomasz, Kubernetes, OKRs, Figma, Q3 roadmap"
            value={vocabulary}
            onChange={(e) => setVocabulary(e.target.value)}
          />
          <div className="field-hint">People, products and jargon the transcriber should spell correctly, separated by commas.</div>
        </div>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="ftemplate">Notes template</label>
            <Select
              id="ftemplate"
              ariaLabel="Notes template"
              value={templateId}
              options={[
                { value: '', label: 'Use default', description: 'The template chosen in Settings' },
                ...TEMPLATES.map((t) => ({ value: t.id, label: t.name, description: t.description })),
              ]}
              onChange={setTemplateId}
              listMinWidth={280}
            />
          </div>
          <div className="field">
            <label htmlFor="flang">Spoken language</label>
            <Select
              id="flang"
              ariaLabel="Spoken language"
              value={language}
              options={languageOptions([{ value: '', label: 'Use default' }])}
              onChange={setLanguage}
              listMinWidth={300}
            />
          </div>
        </div>
        <div className="field">
          <label htmlFor="fnotes">Write notes in</label>
          <Select
            id="fnotes"
            ariaLabel="Write notes in"
            value={notesLanguage}
            options={languageOptions([
              { value: '', label: 'Use default', description: 'The choice in Settings' },
              { value: 'spoken', label: 'The language that was spoken' },
            ])}
            onChange={setNotesLanguage}
            listMinWidth={300}
          />
        </div>
        <div className="field">
          <label htmlFor="finstr">Extra instructions</label>
          <textarea
            id="finstr"
            className="input"
            rows={3}
            placeholder="e.g. List any Jira ticket numbers mentioned. Call the client “Acme”."
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
          />
          <div className="field-hint">Added to every summary in this folder.</div>
        </div>
        {!isInbox && (
          <div className="field">
            <span className="field-label">Colour</span>
            <div className="swatches" style={{ height: 30, alignItems: 'center' }}>
              {store.FOLDER_COLORS.map((c) => (
                <button
                  key={c}
                  className="swatch"
                  style={{ background: c }}
                  aria-label={`Colour ${c}`}
                  aria-pressed={(color || editing?.color) === c}
                  onClick={() => setColor(c)}
                />
              ))}
            </div>
          </div>
        )}
      </Modal>
      {confirmEl}
    </>
  );
}
