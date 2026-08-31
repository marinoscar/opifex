/**
 * Does `apps/web` still name settings the API actually serves? (#422, #417)
 *
 * ## The failure this exists for
 *
 * #422 deleted `supervisor.model.apiKey` and `supervisor.model.baseUrl` from
 * the operator settings registry and replaced them with one slot per provider.
 * The frontend went on naming both, so the Credentials tab told an operator
 * that their deployment "does not publish supervisor.model.apiKey" and offered
 * no key field at all — and every web suite stayed green, because the web
 * mocks its own view of the API and the mock had been updated to nothing. That
 * is #417's finding in its purest form: a fixture is not evidence about the
 * API, it is evidence about the fixture.
 *
 * So this suite compares the frontend's declared keys against the API's OWN
 * SOURCE, read off disk. Not against the fixture, not against a hand-copied
 * list, and not against `apps/api/openapi.json` — that artefact is generated
 * and git-ignored, it is absent on a clean checkout, and its operator-settings
 * schema publishes the SHAPE of a setting rather than the key names, so it
 * could not answer this question even when it is present.
 *
 * ## Why it reads the source as text rather than importing it
 *
 * Importing `operator-settings.registry.ts` into a vitest run would drag the
 * NestJS service it types against into `apps/web`'s TypeScript project, which
 * is the coupling the two-app split exists to prevent. Reading the file and
 * matching the key literals costs nothing and couples nothing —
 * `__tests__/config/destinations.test.ts` reads the live `App.tsx` the same
 * way, for the same reason, and takes the same precaution against a regex that
 * has silently stopped matching: every derived list is asserted non-trivial
 * before it is used, so a broken extraction fails loudly instead of passing
 * vacuously over an empty set.
 *
 * ## What it cannot catch
 *
 * A key that exists with a different TYPE, a `secret` flag that flipped, or a
 * group that moved. Those change how a row renders, not whether it exists, and
 * the fixture is the right place to pin them — which is why the fixture is now
 * type-checked (`tsconfig.fixtures.json`) rather than only transpiled.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { credentialProbes } from '../../config/credentialProbes';
import { CLAUDE_OAUTH_TOKEN_KEY } from '../../config/claudeAuth';
import { CEILING_DEFINITIONS } from '../../config/spendCeilings';
import {
  SUPERVISOR_MODEL_NAME_KEY,
  SUPERVISOR_PROVIDER_KEY,
  modelApiKeySettingKey,
  modelBaseUrlSettingKey,
} from '../../config/supervisorModel';
import { PROPOSAL_TTL_MINUTES } from '../../config/steeringChat';
import { OPERATOR_SETTINGS_FIXTURE } from '../mocks/operatorSettings';
import type { OperatorSetting } from '../../types/operatorSettings';

const HERE = dirname(fileURLToPath(import.meta.url));
const API_SRC = resolve(HERE, '../../../../api/src');

const REGISTRY = resolve(
  API_SRC,
  'settings/operator-settings/operator-settings.registry.ts',
);
const MODEL_CONFIG = resolve(
  API_SRC,
  'supervisor/invocation/supervisor-model.config.ts',
);
/** The steering contract (#425), consumed by the chat surface (#426). */
const STEERING_DTO = resolve(API_SRC, 'steering/dto/steering.dto.ts');
/** Where `src/types/steering.ts` mirrors it, read as text for the same reason. */
const WEB_STEERING_TYPES = resolve(HERE, '../../types/steering.ts');
/**
 * Rate-limit history (#476): `RATE_LIMIT_REASONS` and `EPISODE_DISPOSITIONS`
 * are declared here as `as const` arrays, not `z.enum([...])` calls.
 */
const QUOTA_HISTORY = resolve(API_SRC, 'quota/quota-history.ts');
/** `quotaPressureSchema` — the one member of the trio that IS a `z.enum`. */
const QUOTA_DTO = resolve(API_SRC, 'quota/dto/quota.dto.ts');
/** Where `src/types/quota.ts` mirrors all three, read as text for the same reason. */
const WEB_QUOTA_TYPES = resolve(HERE, '../../types/quota.ts');

function apiSource(path: string): string {
  // A missing file is a failure, not a skip. The alternative — quietly passing
  // when the API is not on disk — is the same vacuum this suite exists to
  // close, and CI runs the web suite from the repository root where both
  // files are present.
  expect(existsSync(path), `${path} is readable`).toBe(true);
  return readFileSync(path, 'utf8');
}

/**
 * The keys written out literally in the registry object.
 *
 * Matched at the registry's own indentation and required to contain a dot, so
 * that helper objects elsewhere in the file cannot widen the set.
 */
function literalKeys(): string[] {
  const source = apiSource(REGISTRY);
  return [
    ...source.matchAll(/^ {2}'([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+)':/gm),
  ].map((match) => match[1]);
}

/** The providers the API declares adapters for. */
function apiProviders(): string[] {
  const source = apiSource(MODEL_CONFIG);
  const declaration = /SUPERVISOR_MODEL_PROVIDERS = \[([^\]]*)\]/.exec(source);
  expect(declaration, 'SUPERVISOR_MODEL_PROVIDERS is declared').not.toBeNull();
  return [...(declaration?.[1] ?? '').matchAll(/'([a-z0-9-]+)'/g)].map(
    (match) => match[1],
  );
}

/**
 * The credential keys the registry GENERATES, one per provider.
 *
 * `modelCredentialSettings()` builds them from the two template literals in
 * `supervisor-model.config.ts`, so they never appear as literals anywhere and
 * a text scan of the registry alone would report them missing.
 */
function generatedKeys(): string[] {
  const source = apiSource(MODEL_CONFIG);
  const suffixes = [
    ...new Set(
      [...source.matchAll(/`models\.\$\{provider\}\.(\w+)`/g)].map(
        (match) => match[1],
      ),
    ),
  ];

  expect(suffixes.sort()).toEqual(['apiKey', 'baseUrl']);

  return apiProviders().flatMap((provider) =>
    suffixes.map((suffix) => `models.${provider}.${suffix}`),
  );
}

/** Every operator setting key this deployment's API serves. */
function apiKeys(): Set<string> {
  return new Set([...literalKeys(), ...generatedKeys()]);
}

/** The fixture's provider row, with one provider selected. */
function selecting(provider: string): OperatorSetting[] {
  return OPERATOR_SETTINGS_FIXTURE.map((entry) =>
    entry.key === SUPERVISOR_PROVIDER_KEY
      ? ({ ...entry, value: provider } as OperatorSetting)
      : entry,
  );
}

/**
 * Every setting key `apps/web` names, gathered from the modules that name any.
 *
 * The four `config/*` modules below are the complete set — the Configuration
 * section is generated from the response and names none, which is #348's
 * acceptance criterion. Each of them says in its own header why it is an
 * exception, and each one is an exception because it encodes an edge the API
 * does not publish: which keys are one decision, which probe reads what, which
 * pair of keys is a ceiling, which credential has a guided sign-in.
 */
function frontendKeys(): Map<string, string> {
  const named = new Map<string, string>();
  const add = (key: string, where: string) => {
    if (!named.has(key)) named.set(key, where);
  };

  add(SUPERVISOR_PROVIDER_KEY, 'supervisorModel.ts');
  add(SUPERVISOR_MODEL_NAME_KEY, 'supervisorModel.ts');
  add(CLAUDE_OAUTH_TOKEN_KEY, 'claudeAuth.ts');

  for (const ceiling of CEILING_DEFINITIONS) {
    add(ceiling.usdKey, `spendCeilings.ts (${ceiling.id})`);
    add(ceiling.windowKey, `spendCeilings.ts (${ceiling.id})`);
  }

  // The credential slots are built from the provider, so every provider the
  // API declares is asked for — including one this build has never been run
  // against, which is the case a hard-coded pair would miss.
  for (const provider of apiProviders()) {
    add(modelApiKeySettingKey(provider), `supervisorModel.ts (${provider})`);
    add(modelBaseUrlSettingKey(provider), `supervisorModel.ts (${provider})`);

    // A probe's subject and dependencies are also a function of the provider.
    for (const probe of credentialProbes(selecting(provider))) {
      add(probe.subject, `credentialProbes.ts (${probe.name} subject)`);
      for (const dependency of probe.dependsOn) {
        add(dependency, `credentialProbes.ts (${probe.name} dependsOn)`);
      }
    }
  }

  return named;
}

describe('the API source this suite reads', () => {
  it('yields a registry key list that is obviously real', () => {
    // The guard against a regex that has stopped matching: without it every
    // assertion below would pass over an empty set and this file would be a
    // decorative green tick.
    const keys = literalKeys();

    expect(keys.length).toBeGreaterThan(30);
    expect(keys).toContain('github.token');
    expect(keys).toContain('supervisor.model.provider');
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('yields the providers and their generated credential slots', () => {
    const providers = apiProviders();

    expect(providers.length).toBeGreaterThanOrEqual(2);
    expect(providers).toContain('anthropic');
    expect(generatedKeys()).toContain(`models.${providers[0]}.apiKey`);
  });

  it('proves the two deleted keys are really gone', () => {
    // The regression itself, pinned. If a later change reinstated
    // `supervisor.model.apiKey`, the assertions below would keep passing for
    // the wrong reason and this file would stop describing anything.
    const keys = apiKeys();

    expect(keys.has('supervisor.model.apiKey')).toBe(false);
    expect(keys.has('supervisor.model.baseUrl')).toBe(false);
    expect(keys.has('models.anthropic.apiKey')).toBe(true);
  });
});

describe('no frontend module names a setting the API does not serve', () => {
  it('finds the frontend naming keys at all', () => {
    const named = frontendKeys();

    expect(named.size).toBeGreaterThan(8);
    expect([...named.keys()]).toContain('github.token');
  });

  it('resolves every one of them in the registry', () => {
    const served = apiKeys();
    const missing = [...frontendKeys()].filter(([key]) => !served.has(key));

    // Named, not counted: the useful failure says which module names what.
    expect(missing.map(([key, where]) => `${key} — named by ${where}`)).toEqual(
      [],
    );
  });

  it('resolves every key the operator-settings fixture claims to serve', () => {
    // The mock is the thing that made the outage invisible. A fixture that
    // carries a key the registry does not is a lie the whole web suite then
    // asserts against.
    const served = apiKeys();
    const invented = OPERATOR_SETTINGS_FIXTURE.map((entry) => entry.key).filter(
      (key) => !served.has(key),
    );

    expect(invented).toEqual([]);
  });

  it('offers a credential slot for every provider the API declares', () => {
    // The other direction, for the slots specifically: a provider added to
    // the API must reach the Credentials tab. The panel discovers slots from
    // the response, so this only has to hold for the key builders.
    const served = apiKeys();

    for (const provider of apiProviders()) {
      expect(served.has(modelApiKeySettingKey(provider)), provider).toBe(true);
      expect(served.has(modelBaseUrlSettingKey(provider)), provider).toBe(true);
    }
  });
});

/**
 * The steering vocabulary, in both places it is written down (#426).
 *
 * `apps/web` mirrors `steering.dto.ts` by hand — importing it would drag
 * NestJS into this TypeScript project — so the mirror can drift, and the two
 * things that would drift SILENTLY are here.
 *
 * The TTL is the sharper of the two. `config/steeringChat.ts` restates it only
 * to warn an operator before a proposal goes stale; the server is still the
 * authority and answers 409 either way. So a change to the API's constant
 * would not break anything visibly — the screen would simply promise thirty
 * minutes on a proposal that had twenty, which is the kind of wrong that gets
 * discovered by somebody losing a confirmation they had already read.
 *
 * The reason enums drift the same way: the frontend renders `reason` verbatim
 * today, so a value it has never heard of renders fine — right up until
 * somebody adds a `switch` over the union and it silently misses an arm.
 */
describe('the steering contract the chat surface mirrors', () => {
  function enumValues(source: string, name: string): string[] {
    const declaration = new RegExp(`${name} = z\\.enum\\(\\[([^\\]]*)\\]`).exec(
      source,
    );
    expect(declaration, `${name} is declared as a z.enum`).not.toBeNull();
    return [...(declaration?.[1] ?? '').matchAll(/'([a-z-]+)'/g)]
      .map((match) => match[1])
      .sort();
  }

  /** The members of a string-literal union in the web's mirror. */
  function unionMembers(source: string, name: string): string[] {
    const declaration = new RegExp(
      `export type ${name} =([\\s\\S]*?);\\n`,
    ).exec(source);
    expect(declaration, `${name} is declared in the web mirror`).not.toBeNull();
    return [...(declaration?.[1] ?? '').matchAll(/'([a-z-]+)'/g)]
      .map((match) => match[1])
      .sort();
  }

  it('reads a steering DTO that is obviously real', () => {
    // The guard against a regex that has quietly stopped matching, without
    // which every assertion below would pass over an empty set.
    const source = apiSource(STEERING_DTO);

    expect(enumValues(source, 'unresolvedReasonSchema')).toContain(
      'needs-interpretation',
    );
    expect(enumValues(source, 'skippedReasonSchema')).toContain('drift');
  });

  it('states the same proposal TTL the API enforces', () => {
    const declared = /PROPOSAL_TTL_MINUTES = (\d+)/.exec(
      apiSource(STEERING_DTO),
    );

    expect(declared, 'PROPOSAL_TTL_MINUTES is declared').not.toBeNull();
    expect(PROPOSAL_TTL_MINUTES).toBe(Number(declared?.[1]));
  });

  it('knows every reason a reference can go unresolved', () => {
    expect(
      unionMembers(apiSource(WEB_STEERING_TYPES), 'UnresolvedReason'),
    ).toEqual(enumValues(apiSource(STEERING_DTO), 'unresolvedReasonSchema'));
  });

  it('knows every reason an operation can be skipped', () => {
    expect(
      unionMembers(apiSource(WEB_STEERING_TYPES), 'SkippedReason'),
    ).toEqual(enumValues(apiSource(STEERING_DTO), 'skippedReasonSchema'));
  });
});

/**
 * The quota history vocabulary, in both places it is written down (#476,
 * #417).
 *
 * `apps/web/src/types/quota.ts` mirrors `apps/api/src/quota/quota-history.ts`
 * by hand — importing it would drag NestJS into this TypeScript project, the
 * same reason the steering suite above gives. What is different here is the
 * SHAPE of the API's declaration: `RATE_LIMIT_REASONS` and
 * `EPISODE_DISPOSITIONS` are `as const` arrays, not `z.enum([...])` calls —
 * the history DTO builds its zod schemas FROM them
 * (`z.enum(RATE_LIMIT_REASONS)`, `z.enum(EPISODE_DISPOSITIONS)`), so there is
 * no `z.enum([...])` call anywhere in `quota-history.ts` naming the members
 * literally for the steering suite's `enumValues` to find. `arrayMembers`
 * below is that extractor's sibling for an `as const` array.
 *
 * `QuotaPressure` is the one member of the trio that IS a literal
 * `z.enum([...])` — `quotaPressureSchema` in `quota.dto.ts` — so it is read
 * with `enumValues` against that file instead, exactly like the steering
 * enums above.
 *
 * A silent divergence here is #417's finding all over again: every web quota
 * test mocks the hooks or the network, so a web-only reason or disposition
 * would render fine locally and disagree with the API in production, with
 * both suites green throughout.
 */
describe('the quota history vocabulary the web mirrors (#476)', () => {
  /** `enumValues`'s sibling: `NAME = [...] as const`, not a `z.enum` call. */
  function arrayMembers(source: string, name: string): string[] {
    const declaration = new RegExp(
      `${name} = \\[([\\s\\S]*?)\\]\\s*as const`,
    ).exec(source);
    expect(
      declaration,
      `${name} is declared as an \`as const\` array`,
    ).not.toBeNull();
    return [...(declaration?.[1] ?? '').matchAll(/'([a-z-]+)'/g)]
      .map((match) => match[1])
      .sort();
  }

  /** A `z.enum([...])` call, read literally — the steering suite's own helper. */
  function enumValues(source: string, name: string): string[] {
    const declaration = new RegExp(`${name} = z\\.enum\\(\\[([^\\]]*)\\]`).exec(
      source,
    );
    expect(declaration, `${name} is declared as a z.enum`).not.toBeNull();
    return [...(declaration?.[1] ?? '').matchAll(/'([a-z-]+)'/g)]
      .map((match) => match[1])
      .sort();
  }

  /** The members of a string-literal union in the web's mirror. */
  function unionMembers(source: string, name: string): string[] {
    const declaration = new RegExp(
      `export type ${name} =([\\s\\S]*?);\\n`,
    ).exec(source);
    expect(declaration, `${name} is declared in the web mirror`).not.toBeNull();
    return [...(declaration?.[1] ?? '').matchAll(/'([a-z-]+)'/g)]
      .map((match) => match[1])
      .sort();
  }

  it('reads an `as const` array the same way a `z.enum` call is read', () => {
    // The guard against a regex that has quietly stopped matching, extended
    // to the new shape: without it, every assertion below would pass over an
    // empty set and this file would be a decorative green tick.
    const source = apiSource(QUOTA_HISTORY);

    const reasons = arrayMembers(source, 'RATE_LIMIT_REASONS');
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons).toContain('quota-exhausted');

    const dispositions = arrayMembers(source, 'EPISODE_DISPOSITIONS');
    expect(dispositions.length).toBeGreaterThan(0);
    expect(dispositions).toContain('unknown');
  });

  it('knows both reasons the API files under quota, never a flattened "rate limited"', () => {
    expect(unionMembers(apiSource(WEB_QUOTA_TYPES), 'RateLimitReason')).toEqual(
      arrayMembers(apiSource(QUOTA_HISTORY), 'RATE_LIMIT_REASONS'),
    );
  });

  it('knows every disposition the API can hand back, including `unknown`', () => {
    expect(
      unionMembers(apiSource(WEB_QUOTA_TYPES), 'EpisodeDisposition'),
    ).toEqual(arrayMembers(apiSource(QUOTA_HISTORY), 'EPISODE_DISPOSITIONS'));
  });

  it('knows every pressure ordinal the vendor can report', () => {
    expect(unionMembers(apiSource(WEB_QUOTA_TYPES), 'QuotaPressure')).toEqual(
      enumValues(apiSource(QUOTA_DTO), 'quotaPressureSchema'),
    );
  });
});
