import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  NO_CHAT_SPEND_CEILING_REASON,
  assessChatSpend,
} from './chat-spend-gate';

/**
 * The chat's spend decision (#425).
 *
 * One branch, tested as one branch. The point of this file is not coverage —
 * it is that the refusal is a DECISION with a name and a sentence, so that
 * removing it is a visible diff rather than a quietly deleted `if`.
 */
describe('assessChatSpend', () => {
  it('refuses, because there is no ledger to bound a metered consumer with', () => {
    const verdict = assessChatSpend();

    expect(verdict.admit).toBe(false);
    expect(verdict).toMatchObject({ refusal: 'no-chat-spend-ledger' });
  });

  it('says why, in a sentence naming what a ceiling would need', () => {
    // An operator who reads "no model was asked" and then configures
    // `chat.model.name` must not be left wondering why nothing changed.
    expect(NO_CHAT_SPEND_CEILING_REASON).toContain('spend ceiling');
    expect(NO_CHAT_SPEND_CEILING_REASON).toContain('durable tally');
    expect(NO_CHAT_SPEND_CEILING_REASON).toContain('refuses');
  });

  it('says the deterministic path is unaffected', () => {
    // The refusal must not read as "steering is off". Explicit issue numbers
    // are parsed in code and never touch this gate.
    expect(NO_CHAT_SPEND_CEILING_REASON).toContain('parsed in code');
  });

  it('is the ONLY thing in the steering path that admits a model call', () => {
    // If a second gate appears, the day someone builds the ledger they will
    // flip this one and find the model still silent — or worse, flip the other
    // and run unbounded. The service must reach exactly this function.
    const service = readFileSync(
      join(__dirname, 'steering.service.ts'),
      'utf8',
    );

    expect(service).toContain('assessChatSpend');
    // No adapter and no `ask(` anywhere in the steering service. The class
    // doc's prose mention of the port is stripped first, so the assertion is
    // about the CODE rather than about a comment nobody can call.
    const code = service.replace(/\/\*\*[\s\S]*?\*\//g, '');
    expect(code).not.toContain('SupervisorModel');
    expect(code).not.toMatch(/\.ask\(/);
  });
});
