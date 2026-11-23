import { notesLanguageRule } from './languages.ts'; // with the extension, so Node's test runner can load it

// Templates shape the enhanced notes written after a meeting. Each one is a
// list of sections; the rules about speakers, the user's own notes and the
// title line are the same for all of them.

export interface Template {
  id: string;
  name: string;
  description: string;
  sections: string;
}

export const DEFAULT_TEMPLATE_ID = 'meeting';

export const TEMPLATES: Template[] = [
  {
    id: 'meeting',
    name: 'General',
    description: 'Summary, discussion, decisions and action items',
    sections: `## Summary
Two or three sentences: what the meeting was about and where it landed.

## Discussion
The main topics, each under a "### Topic" heading, with short bullets: what was said, by whom when it matters, and why.

## Decisions
What was agreed.

## Action items
One per line as "- [ ] **Owner**: task (due date if one was mentioned)". Use "Me" for the user's own tasks.

## Open questions
Anything left unresolved or to follow up on.`,
  },
  {
    id: 'one-on-one',
    name: '1:1',
    description: 'Updates, blockers, feedback and next steps',
    sections: `## Summary
Two sentences on how things stand.

## Updates
Progress, wins and blockers, grouped by person.

## Feedback
Feedback given and received, with the specifics.

## Growth
Career, learning or goals, if discussed.

## Action items
One per line as "- [ ] **Owner**: task (due date if mentioned)". Use "Me" for the user's own tasks.`,
  },
  {
    id: 'standup',
    name: 'Stand-up',
    description: 'What each person did, plans and blockers',
    sections: `## Updates
A "### Name" heading per person, each with short bullets for **Done**, **Next** and **Blockers**. Use "Me" for the user.

## Blockers and help needed
Everything that's stuck and who can unblock it.

## Action items
One per line as "- [ ] **Owner**: task".`,
  },
  {
    id: 'customer',
    name: 'Customer call',
    description: 'Their needs and pain points, objections, next steps',
    sections: `## Summary
Two or three sentences: who they are and what they want.

## About them
Company, people and roles, current setup and tools, timeline and budget if mentioned.

## Needs and pain points
In their words where possible (short quotes in quotation marks).

## What we showed or proposed

## Objections and concerns

## Next steps
One per line as "- [ ] **Owner**: task (due date if mentioned)".`,
  },
  {
    id: 'interview',
    name: 'Interview',
    description: 'Background, strengths, concerns and answers',
    sections: `## Summary
The candidate, the role and the main takeaways. Stay factual; don't make a hiring decision unless the user's notes state one.

## Background
Experience and context the candidate described.

## Strengths
Each with the evidence from their answers.

## Concerns or gaps

## Questions and answers
The main questions asked and the gist of each answer.

## Follow-ups`,
  },
  {
    id: 'lecture',
    name: 'Lecture or class',
    description: 'Study notes with key concepts and self-test questions',
    sections: `## TL;DR
Two or three sentences: what it covered and why it matters.

## Key concepts
Bullets, each starting with the **term** in bold, then a crisp one- or two-sentence explanation.

## How it works
The main explanations, processes or steps, as short paragraphs or numbered steps. Keep the speaker's examples when they make an idea clearer.

## Worth remembering
Facts, limits, defaults, comparisons and gotchas likely to come up in an exam or in real work.

## Test yourself
Three to five short questions, each followed by the answer in italics on the same line.`,
  },
  {
    id: 'brainstorm',
    name: 'Brainstorm',
    description: 'Ideas grouped by theme, the strongest ones, next steps',
    sections: `## Summary
What the session set out to solve and where it ended up.

## Ideas
Grouped by theme under "### Theme" headings, noting who raised an idea when known.

## Most promising
The ideas with the most support, and why.

## Concerns raised

## Next steps
One per line as "- [ ] **Owner**: task".`,
  },
];

export function getTemplate(id: string | undefined): Template {
  return TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0];
}

const RULES = `Rules:
- The transcript has two sources. "Me" is the user, from their microphone. "Them" is everyone else on the call, from the computer's audio, and may be several people. Use people's names when they're said; otherwise describe them by role or as "they". In an in-person meeting everything comes from the user's microphone and may include several voices.
- The user's own notes, written during the meeting, show what matters to them. Cover every point they wrote, filled in with the details from the transcript.
- Use only information from the transcript and the user's notes. Never invent facts, names, numbers or dates.
- The transcript is machine-generated: silently fix obvious mis-hearings of names and technical terms.
- Be concise: short bullets, no filler, no preamble or closing remarks. Leave out any section that would be empty.`;

/** The system prompt for enhanced notes: template + shared rules + notes language + the user's extra instructions. */
export function summaryPrompt(templateId: string | undefined, notesLanguage: string | undefined, ...instructions: (string | undefined)[]): string {
  const template = getTemplate(templateId);
  const extra = instructions.map((s) => s?.trim()).filter(Boolean);
  return [
    `You turn a meeting transcript and the user's rough notes into clear, well-organised notes in Markdown.`,
    `Start with exactly one line: "# " followed by a short, specific title for the meeting (at most 8 words, no date).`,
    `Then use these sections:\n\n${template.sections}`,
    RULES,
    `Language: ${notesLanguageRule(notesLanguage)}`,
    extra.length ? `The user's own instructions (these take priority):\n${extra.map((s) => `- ${s}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Splits a leading "# Title" line off the model's notes. */
export function splitTitle(markdown: string): { title?: string; body: string } {
  const text = markdown.replace(/^\s+/, '');
  const m = /^#\s+(.+?)\s*#*\s*(?:\n|$)/.exec(text);
  if (!m) return { body: markdown.trim() };
  const title = m[1].replace(/[*_`]/g, '').trim().slice(0, 120);
  return { title: title || undefined, body: text.slice(m[0].length).trim() };
}
