/**
 * The `guide` tool: the model points at elements of the user's screen and says what to do there.
 * It runs in the page, not here: the frontend shows the steps and sends back what the user did.
 */
import type { GuideStep, Item, Screen, ScreenNode } from '@doccue/protocol';
import type { Tool } from '../loop/types.js';
import { isLocale } from '../protocol/parse.js';
import { mostlyInLocale, otherLanguage } from '../render/render.js';

export const GUIDE_TOOL = 'guide';

const DESCRIPTION = `Shows the user where things are on their screen. Each step highlights one element and shows your text in a bubble next to it; when the user has done that step, the next one is shown.
- "target" is the number in brackets of an element in the latest screen. Only point at elements listed there.
- Keep to what the user asked: the fewest steps that get it done. Don't walk them through fields that are unrelated or already fine.
- Give those steps for the current screen in one call, in order. For anything that only appears later (another page, a dialog that opens), stop there and continue in a new call once you get the result.
- "text" is one short instruction, e.g. what to type or why to click, written in the language of the user's latest message even when the screen is in another one; quote the screen's words as they appear there.
- "expect" is "ack" for a step that only explains something (the user presses Next); leave it out when the user has to do anything with the element: click it, switch or tick it, pick from it or fill it in.
The result tells you how it went (completed, deviated: the user did something else, not_found: an element was gone, interrupted: the user asked something, exited: the user closed it), which steps the user skipped, what the user did meanwhile, and the screen as it is now.`;

/** The numbers of all numbered nodes in a screen. */
function refsOf(nodes: readonly ScreenNode[], out = new Set<number>()): Set<number> {
  for (const node of nodes) {
    if (node.ref !== undefined) out.add(node.ref);
    if (node.children) refsOf(node.children, out);
  }
  return out;
}

/** The screen the model saw last: the one of the latest question or guide result. */
export function latestScreen(conversation: readonly Item[]): Screen | undefined {
  for (let i = conversation.length - 1; i >= 0; i--) {
    const item = conversation[i];
    if (item?.type === 'user') return item.perception.screen;
    if (item?.type === 'guide_result') return item.result.perception.screen;
  }
  return undefined;
}

/**
 * The steps of a `guide` call. Models sometimes send the array as a JSON string; that is read as
 * the array it spells. Anything else that is not a list of steps comes back as a problem for the
 * model, saying what was wrong.
 */
export function readSteps(args: unknown): { steps: GuideStep[] } | { problem: string } {
  let steps = (args as { steps?: unknown }).steps;
  if (typeof steps === 'string') {
    try {
      steps = JSON.parse(steps);
    } catch {
      return { problem: 'steps: send a JSON array of {"target", "text"} objects, not a string; this string is not even valid JSON (double quotes inside a text must be escaped, or write 「」 or “” instead)' };
    }
  }
  if (!Array.isArray(steps) || steps.length === 0) return { problem: 'steps: send a non-empty JSON array of {"target", "text"} objects' };
  for (const [index, step] of (steps as Array<Partial<GuideStep>>).entries()) {
    if (typeof step?.text !== 'string' || !step.text) return { problem: `steps[${index}].text: expected a non-empty string` };
    if (typeof step.target !== 'number') return { problem: `steps[${index}].target: expected the number of an element, like 3` };
  }
  return { steps: steps as GuideStep[] };
}

/** The user's latest message, the language the steps must be in. */
export function latestQuestion(conversation: readonly Item[]): string | undefined {
  for (let i = conversation.length - 1; i >= 0; i--) {
    const item = conversation[i];
    if (item?.type === 'user') return item.text;
  }
  return undefined;
}

/**
 * The tool for one request. Calls that point at elements not on `screen` are sent back to the
 * model, and so are steps in the screen's language when the user wrote in another one (models
 * slip into the language of the screen they quote from).
 */
export function guideTool(screen: Screen | undefined, language: { question?: string; locale?: string } = {}): Tool {
  const { question, locale } = language;
  const foreign = question !== undefined && isLocale(locale) && otherLanguage(question, locale) ? locale : undefined;
  const refs = refsOf(screen?.nodes ?? []);
  return {
    name: GUIDE_TOOL,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              target: { type: 'integer', description: 'Number of the element in the latest screen.' },
              text: { type: 'string', description: "Shown next to the element. In the language of the user's latest message." },
              expect: { type: 'string', enum: ['ack'], description: 'Only for steps that just explain something.' },
            },
            required: ['target', 'text'],
          },
        },
      },
      required: ['steps'],
    },
    validate(args) {
      const read = readSteps(args);
      if ('problem' in read) return read.problem;
      const missing = read.steps.findIndex((step) => !refs.has(step.target as number));
      if (missing >= 0) return `steps[${missing}].target: there is no element [${String(read.steps[missing]!.target)}] on the latest screen`;
      const wrong = foreign ? read.steps.findIndex((step) => mostlyInLocale(step.text, foreign)) : -1;
      if (wrong >= 0) return `steps[${wrong}].text is in the screen's language, but the user wrote in another one: write every step in the language of the user's latest message, quoting the screen's words as they appear`;
      return undefined;
    },
  };
}
