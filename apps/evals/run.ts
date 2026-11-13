/**
 * Runs the single-step scenarios against the real model and reports how often the first guide
 * step points at the right element.
 *
 *   pnpm eval            all scenarios
 *   pnpm eval tab        only scenarios whose name contains "tab"
 *
 * The model comes from the repository's root .env (see .env.example). Run it after changing the
 * prompt, the snapshot format or the model.
 */
import { existsSync } from 'node:fs';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { DEFAULT_ERROR_SELECTORS, buildScreen } from '@doccue/bridge';
import { PROTOCOL_VERSION, createModelFromEnv, respond, withRetry, type GuideStep } from '@doccue/core';
import { Window } from 'happy-dom';
import { scenarios, type Scenario } from './scenarios.js';

// Node gives each address of a host only 250 ms to connect before trying the next one; on a slow
// link every attempt times out and the request fails with ETIMEDOUT. Give them longer.
setDefaultAutoSelectFamilyAttemptTimeout(2000);

const ENV_FILE = new URL('../../.env', import.meta.url);
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
const model = withRetry(createModelFromEnv(process.env));

interface Outcome {
  pass: boolean;
  /** What the model did, for the report. */
  detail: string;
}

async function run(scenario: Scenario): Promise<Outcome> {
  const window = new Window({ url: `https://app.example${scenario.path}` });
  const document = window.document as unknown as Document;
  document.title = scenario.title;
  document.body.innerHTML = scenario.html;
  const { screen, elements } = buildScreen(document, { errorSelectors: DEFAULT_ERROR_SELECTORS });

  let steps: GuideStep[] | undefined;
  let text = '';
  let failure: string | undefined;
  const request = { v: PROTOCOL_VERSION, locale: scenario.locale, conversation: [{ type: 'user' as const, text: scenario.question, perception: { at: Date.now(), screen, actions: [] } }] };
  for await (const event of respond(request, { model, instructions: scenario.app })) {
    if (event.type === 'text') text += event.delta;
    if (event.type === 'guide') steps = event.steps;
    if (event.type === 'end' && event.error) failure = event.error.message;
  }
  const outcome = judge(scenario, steps, text, elements, failure);
  await window.happyDOM.close();
  return outcome;
}

function judge(scenario: Scenario, steps: GuideStep[] | undefined, text: string, elements: Map<number, Element>, failure: string | undefined): Outcome {
  if (failure) return { pass: false, detail: `error: ${failure}` };
  const first = steps?.[0];
  if (!first) return { pass: scenario.expect === null, detail: `no guide; said: ${text.replace(/\s+/g, ' ').slice(0, 80)}` };
  const target = typeof first.target === 'number' ? elements.get(first.target) : undefined;
  const pointed = `[${String(first.target)}] ${target ? `<${target.tagName.toLowerCase()}${target.id ? `#${target.id}` : ''}>` : '?'} — ${first.text}`;
  if (scenario.expect === null) return { pass: false, detail: `guide not wanted, pointed at ${pointed}` };
  return { pass: target?.matches(scenario.expect) ?? false, detail: `${steps!.length} step(s), first: ${pointed}` };
}

const filter = process.argv[2];
const selected = scenarios.filter((scenario) => !filter || scenario.name.includes(filter));
console.log(`[${model.provider} / ${model.model}] ${selected.length} scenario(s)\n`);
let passed = 0;
for (const scenario of selected) {
  const outcome = await run(scenario);
  if (outcome.pass) passed++;
  console.log(`${outcome.pass ? 'PASS' : 'FAIL'}  ${scenario.name}\n      ${scenario.question}\n      ${outcome.detail}`);
}
console.log(`\n${passed} / ${selected.length} passed`);
process.exitCode = passed === selected.length ? 0 : 1;
