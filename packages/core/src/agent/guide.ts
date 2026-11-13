/**
 * The `guide` tool: the model points at elements of the user's screen and says what to do there.
 * It runs in the page, not here: the frontend shows the steps and sends back what the user did.
 */
import type { GuideStep, Item, Screen, ScreenNode } from '@doccue/protocol';
import type { Tool } from '../loop/types.js';

export const GUIDE_TOOL = 'guide';

const DESCRIPTION = `Shows the user where things are on their screen. Each step highlights one element and shows your text in a bubble next to it; when the user has done that step, the next one is shown.
- "target" is the number in brackets of an element in the latest screen. Only point at elements listed there.
- Keep to what the user asked: the fewest steps that get it done. Don't walk them through fields that are unrelated or already fine.
- Give those steps for the current screen in one call, in order. For anything that only appears later (another page, a dialog that opens), stop there and continue in a new call once you get the result.
- "text" is one short instruction in the user's language, e.g. what to type or why to click.
- "expect" is "ack" for a step that only explains something (the user presses Next); leave it out when the user has to click or fill in the element.
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

/** The tool for one request. Calls that point at elements not on `screen` are sent back to the model. */
export function guideTool(screen: Screen | undefined): Tool {
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
              text: { type: 'string', description: 'Shown next to the element.' },
              expect: { type: 'string', enum: ['ack'], description: 'Only for steps that just explain something.' },
            },
            required: ['target', 'text'],
          },
        },
      },
      required: ['steps'],
    },
    validate(args) {
      const steps = (args as { steps?: unknown }).steps;
      if (!Array.isArray(steps) || steps.length === 0) return 'steps: expected a non-empty array';
      for (const [index, step] of (steps as Array<Partial<GuideStep>>).entries()) {
        if (typeof step?.text !== 'string' || !step.text) return `steps[${index}].text: expected a string`;
        if (typeof step.target !== 'number' || !refs.has(step.target)) {
          return `steps[${index}].target: there is no element [${String(step.target)}] on the latest screen`;
        }
      }
      return undefined;
    },
  };
}
