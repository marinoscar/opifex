import { EtagCacheService } from '../etag-cache.service';
import {
  GitHubAuthError,
  GitHubNotFoundError,
  GitHubRateLimitError,
  GitHubRequestError,
  GitHubTransientError,
} from '../github.errors';
import { GitHubHttpService } from '../github-http.service';
import { RateLimitService } from '../rate-limit.service';
import { GitHubReadService } from '../read/github-read.service';
import { makeOperatorSettings } from '../../settings/operator-settings/operator-settings.test-double';
import {
  assertDeclaredLabel,
  LabelProvisioningService,
  type LabelProvisioningReport,
} from './label-provisioning.service';
import { PROVISIONED_LABELS } from './label-taxonomy';

/**
 * #415: `factory:ready` is the whole eligibility signal, GitHub's label picker
 * only offers labels that exist, and registering a repository created none of
 * them. These exercise the surface that fixes it — including every way it can
 * fail, because the failure that mattered on the live deployment was silent.
 */

const REPO = { owner: 'acme', name: 'app' };

/** A label as GitHub's `GET /labels` reports it, correct by default. */
function onGitHub(name: string, overrides: Record<string, unknown> = {}) {
  const declared = PROVISIONED_LABELS.find((label) => label.name === name);
  if (!declared) throw new Error(`${name} is not declared`);
  return {
    name: declared.name,
    color: declared.color,
    description: declared.description,
    ...overrides,
  };
}

/** Every declared label, present and correct. */
function allOnGitHub() {
  return PROVISIONED_LABELS.map((label) => onGitHub(label.name));
}

describe('LabelProvisioningService', () => {
  let http: { request: jest.Mock };
  let github: {
    credentialConfigured: boolean;
    listRepositoryLabels: jest.Mock;
  };
  let service: LabelProvisioningService;

  beforeEach(() => {
    http = { request: jest.fn().mockResolvedValue({ data: {} }) };
    github = {
      credentialConfigured: true,
      listRepositoryLabels: jest.fn().mockResolvedValue([]),
    };
    service = new LabelProvisioningService(
      http as unknown as GitHubHttpService,
      github as unknown as GitHubReadService,
    );
  });

  /** The paths of every write this call made, in order. */
  function writes(): Array<{ method: string; path: string; body: unknown }> {
    return http.request.mock.calls.map(([path, options]) => ({
      path: path as string,
      method: (options as { method: string }).method,
      body: (options as { body: unknown }).body,
    }));
  }

  describe('the repository has no factory labels — the state #415 found', () => {
    it('creates every declared label', async () => {
      const report = await service.provision(REPO);

      expect(report.status).toBe('ok');
      expect(report.ok).toBe(true);
      expect(report.created).toBe(PROVISIONED_LABELS.length);
      expect(report.present).toBe(PROVISIONED_LABELS.length);
      expect(report.missing).toBe(0);
      expect(writes()).toHaveLength(PROVISIONED_LABELS.length);
    });

    it('creates them with the declared colour and description', async () => {
      // Not cosmetic. GitHub would create a missing label on first write with
      // a RANDOM colour and no description, which destroys the warm/cool
      // palette carrying the input/mirror distinction — and the description is
      // the only place an operator reads what a label MEANS at the moment they
      // are applying it.
      await service.provision(REPO);

      const ready = writes().find(
        (write) => (write.body as { name?: string }).name === 'factory:ready',
      );
      expect(ready).toEqual({
        method: 'POST',
        path: '/repos/acme/app/labels',
        body: {
          name: 'factory:ready',
          color: 'd93f0b',
          description:
            'Human intent: this issue is authorized for dispatch. Obeyed by the reconciler.',
        },
      });
    });

    it('creates the mirror and routing labels too, not only the inputs', async () => {
      await service.provision(REPO);

      const created = writes().map(
        (write) => (write.body as { name: string }).name,
      );
      expect(created).toContain('factory/dispatched');
      expect(created).toContain('tier:large');
      expect(created).toContain('needs:cost-reporting');
    });

    it('reports every label by name, so the UI can say WHICH are missing', async () => {
      const report = await service.inspect(REPO);

      expect(report.labels).toHaveLength(PROVISIONED_LABELS.length);
      expect(
        report.labels.every((label) => label.stateBefore === 'missing'),
      ).toBe(true);
      expect(report.labels.map((label) => label.name)).toContain(
        'factory:ready',
      );
    });
  });

  describe('idempotence', () => {
    it('writes nothing when every label is already present and correct', async () => {
      github.listRepositoryLabels.mockResolvedValue(allOnGitHub());

      const report = await service.provision(REPO);

      expect(http.request).not.toHaveBeenCalled();
      expect(report.status).toBe('ok');
      expect(report.created).toBe(0);
      expect(report.updated).toBe(0);
      expect(report.failed).toBe(0);
    });

    it('reports an already-correct label as a no-op, distinguishably', async () => {
      // "Created" and "was already there" are different news to an operator
      // who just pressed a repair button, and a count that conflated them
      // would say the repair did something when it did nothing.
      github.listRepositoryLabels.mockResolvedValue(allOnGitHub());

      const report = await service.provision(REPO);

      expect(report.unchanged).toBe(PROVISIONED_LABELS.length);
      expect(report.labels.every((label) => label.action === 'none')).toBe(
        true,
      );
    });

    it('creates nothing on a second run', async () => {
      // The acceptance criterion, exercised as a sequence rather than asserted
      // about one call: run once against an empty repository, then again
      // against the repository that first run produced.
      const first = await service.provision(REPO);
      expect(first.created).toBe(PROVISIONED_LABELS.length);

      http.request.mockClear();
      github.listRepositoryLabels.mockResolvedValue(allOnGitHub());

      const second = await service.provision(REPO);

      expect(http.request).not.toHaveBeenCalled();
      expect(second.created).toBe(0);
      expect(second.status).toBe('ok');
      expect(second.ok).toBe(true);
    });
  });

  describe('some present, some missing', () => {
    beforeEach(() => {
      github.listRepositoryLabels.mockResolvedValue([
        onGitHub('factory:ready'),
        onGitHub('factory:hold'),
      ]);
    });

    it('creates only the missing ones', async () => {
      const report = await service.provision(REPO);

      expect(report.created).toBe(PROVISIONED_LABELS.length - 2);
      expect(report.unchanged).toBe(2);

      const created = writes().map(
        (write) => (write.body as { name: string }).name,
      );
      expect(created).not.toContain('factory:ready');
      expect(created).not.toContain('factory:hold');
    });

    it('answers the "N of M" the ladder renders, without writing', async () => {
      const report = await service.inspect(REPO);

      expect(report.present).toBe(2);
      expect(report.declared).toBe(PROVISIONED_LABELS.length);
      expect(report.ok).toBe(false);
      expect(report.status).toBe('incomplete');
      expect(report.attempted).toBe(false);
      expect(http.request).not.toHaveBeenCalled();
      expect(report.detail).toContain(
        `2 of ${PROVISIONED_LABELS.length} factory labels`,
      );
    });
  });

  describe('drift', () => {
    it('updates a label whose colour has moved, and says what moved', async () => {
      github.listRepositoryLabels.mockResolvedValue([
        onGitHub('factory:ready', { color: 'ededed' }),
      ]);

      const report = await service.provision(REPO);
      const ready = report.labels.find(
        (label) => label.name === 'factory:ready',
      );

      expect(ready?.stateBefore).toBe('drifted');
      expect(ready?.differences).toEqual(['color ededed -> d93f0b']);
      expect(ready?.action).toBe('updated');
      expect(report.updated).toBe(1);
    });

    it('updates a label whose description has moved', async () => {
      // Weighted at least as heavily as colour: the description is the only
      // place the input/mirror distinction is written where an operator reads
      // it, in the label picker, at the moment they apply it.
      github.listRepositoryLabels.mockResolvedValue([
        onGitHub('factory/dispatched', { description: 'something else' }),
      ]);

      const report = await service.provision(REPO);
      const dispatched = report.labels.find(
        (label) => label.name === 'factory/dispatched',
      );

      expect(dispatched?.differences).toEqual(['description']);
      expect(dispatched?.action).toBe('updated');
    });

    it('PATCHes colour and description, and never a new name', async () => {
      // Renaming a label moves it on every issue that carries it. This service
      // has no reason to want that, so `new_name` is never sent.
      github.listRepositoryLabels.mockResolvedValue([
        onGitHub('factory:ready', { color: 'ededed' }),
        ...PROVISIONED_LABELS.filter(
          (label) => label.name !== 'factory:ready',
        ).map((label) => onGitHub(label.name)),
      ]);

      await service.provision(REPO);

      expect(writes()).toEqual([
        {
          method: 'PATCH',
          path: '/repos/acme/app/labels/factory%3Aready',
          body: {
            color: 'd93f0b',
            description:
              'Human intent: this issue is authorized for dispatch. Obeyed by the reconciler.',
          },
        },
      ]);
    });

    it('treats a null description on GitHub as an empty one, not as a match', async () => {
      // GitHub returns `null` for a label created without a description —
      // exactly what happens when a mirror write auto-creates one. Reading
      // that as "matches" would leave the picker text permanently blank.
      github.listRepositoryLabels.mockResolvedValue([
        { name: 'factory:ready', color: 'd93f0b', description: null },
      ]);

      const report = await service.provision(REPO);
      const ready = report.labels.find(
        (label) => label.name === 'factory:ready',
      );

      expect(ready?.stateBefore).toBe('drifted');
      expect(ready?.action).toBe('updated');
    });
  });

  describe('never deletes', () => {
    it('leaves a label that is not in the taxonomy alone', async () => {
      // Deleting a label strips it from every issue carrying it, and that is
      // not recoverable from a declaration that knows names and colours but
      // not which issues had them. An unrecognised label is far more likely to
      // be a human's than a mistake.
      github.listRepositoryLabels.mockResolvedValue([
        ...allOnGitHub(),
        { name: 'wontfix', color: 'ffffff', description: 'ours' },
        { name: 'phase:4', color: '5b7fde', description: 'ours too' },
      ]);

      const report = await service.provision(REPO);

      expect(http.request).not.toHaveBeenCalled();
      expect(report.status).toBe('ok');
      expect(report.labels.map((label) => label.name)).not.toContain('wontfix');
    });

    it('issues no DELETE, whatever the repository looks like', async () => {
      github.listRepositoryLabels.mockResolvedValue([
        { name: 'factory:redy', color: '000000', description: 'a typo' },
      ]);

      await service.provision(REPO);

      expect(writes().every((write) => write.method !== 'DELETE')).toBe(true);
    });
  });

  describe('the taxonomy guard', () => {
    it('refuses a label it did not declare, before any request', () => {
      expect(() => assertDeclaredLabel('wontfix')).toThrow(
        /Refusing to touch "wontfix"/,
      );
    });

    it('refuses a near-miss on a declared name', () => {
      expect(() => assertDeclaredLabel('factory:read')).toThrow(
        /may only create labels declared in PROVISIONED_LABELS/,
      );
    });

    it('admits every declared label', () => {
      for (const label of PROVISIONED_LABELS) {
        expect(() => assertDeclaredLabel(label.name)).not.toThrow();
      }
    });

    it('touches no path outside this repository label collection', async () => {
      await service.provision(REPO);

      for (const write of writes()) {
        expect(write.path.startsWith('/repos/acme/app/labels')).toBe(true);
      }
    });
  });

  describe('failure, told apart', () => {
    async function failingWith(
      error: unknown,
    ): Promise<LabelProvisioningReport> {
      github.listRepositoryLabels.mockRejectedValue(error);
      return service.provision(REPO);
    }

    it('reports a refused token as `refused`, naming the permission', async () => {
      // The likeliest failure and the one #415 turns on: ADR-0001's
      // fine-grained PAT can read a repository it cannot write labels to, and
      // emits no `x-oauth-scopes` header, so this is unknowable in advance.
      const report = await failingWith(
        new GitHubAuthError(
          'GitHub refused the request: Resource not accessible',
          403,
          'GET',
          '/labels',
        ),
      );

      expect(report.status).toBe('refused');
      expect(report.ok).toBe(false);
      expect(report.detail).toContain('Issues: Read and write');
      expect(report.labels).toEqual([]);
    });

    it('reports a rejected token as `invalid_credential`, which is a different remedy', async () => {
      const report = await failingWith(
        new GitHubAuthError(
          'GitHub rejected the credential',
          401,
          'GET',
          '/labels',
        ),
      );

      expect(report.status).toBe('invalid_credential');
    });

    it('reports a missing repository as `not_found`, naming all three causes', async () => {
      const report = await failingWith(
        new GitHubNotFoundError('Not Found', 404, 'GET', '/labels'),
      );

      expect(report.status).toBe('not_found');
      expect(report.detail).toContain('renamed');
    });

    it('reports an exhausted budget as `rate_limited`, with the reset', async () => {
      const report = await failingWith(
        new GitHubRateLimitError(
          'Rate limit exhausted',
          403,
          'GET',
          '/labels',
          new Date('2026-08-28T04:00:00Z'),
          false,
        ),
      );

      expect(report.status).toBe('rate_limited');
      expect(report.detail).toContain('2026-08-28T04:00:00.000Z');
    });

    it('reports a network failure as `unreachable`, saying nothing about the token', async () => {
      const report = await failingWith(
        new GitHubTransientError('fetch failed', null, 'GET', '/labels'),
      );

      expect(report.status).toBe('unreachable');
      expect(report.detail).toContain('says nothing about the credential');
    });

    it('reports anything else as `failed`, with GitHub own words', async () => {
      const report = await failingWith(new Error('something unmodelled'));

      expect(report.status).toBe('failed');
      expect(report.detail).toContain('something unmodelled');
    });

    it('reports a missing credential without asking GitHub anything', async () => {
      github.credentialConfigured = false;

      const report = await service.provision(REPO);

      expect(report.status).toBe('no_credential');
      expect(github.listRepositoryLabels).not.toHaveBeenCalled();
      expect(http.request).not.toHaveBeenCalled();
    });

    it('NULLS every count when the labels were never read', async () => {
      // The trap this rule exists to close: `present: 0` reads as "the
      // repository has none of them" and the truth is "we never found out".
      // A token that cannot read a repository's labels establishes nothing
      // about what is on it, so a consumer rendering "0 of 15 present" would
      // be stating a fact nobody obtained. Null cannot be rendered as a count
      // by accident; a documented zero can, and was.
      const report = await failingWith(
        new GitHubAuthError('refused', 403, 'GET', '/labels'),
      );

      expect(report.declared).toBeNull();
      expect(report.present).toBeNull();
      expect(report.missing).toBeNull();
      expect(report.created).toBeNull();
      expect(report.updated).toBeNull();
      expect(report.unchanged).toBeNull();
      expect(report.failed).toBeNull();
      expect(report.labels).toEqual([]);
    });

    it('nulls the counts for every unread status, not just the refused one', async () => {
      // All seven arms, so a future arm added without the null is caught here
      // rather than by whichever screen renders it.
      const unread = [
        new GitHubAuthError('rejected', 401, 'GET', '/labels'),
        new GitHubAuthError('refused', 403, 'GET', '/labels'),
        new GitHubNotFoundError('gone', 404, 'GET', '/labels'),
        new GitHubRateLimitError(
          'spent',
          403,
          'GET',
          '/labels',
          new Date('2026-08-28T04:00:00Z'),
          false,
        ),
        new GitHubTransientError('down', null, 'GET', '/labels'),
        new Error('unmodelled'),
      ];

      for (const error of unread) {
        const report = await failingWith(error);
        expect({ status: report.status, present: report.present }).toEqual({
          status: report.status,
          present: null,
        });
      }
    });

    it('nulls the counts when no credential is configured either', async () => {
      github.credentialConfigured = false;

      const report = await service.provision(REPO);

      expect(report.status).toBe('no_credential');
      expect(report.present).toBeNull();
      expect(report.declared).toBeNull();
    });

    it('never throws — a registration must survive any of these', async () => {
      for (const error of [
        new GitHubAuthError('nope', 403, 'GET', '/labels'),
        new GitHubNotFoundError('gone', 404, 'GET', '/labels'),
        new GitHubTransientError('down', null, 'GET', '/labels'),
        new Error('unmodelled'),
      ]) {
        await expect(failingWith(error)).resolves.toBeDefined();
      }
    });
  });

  describe('a write that fails part way through', () => {
    it('carries on after a per-label rejection rather than half-applying', async () => {
      // #197's lesson: the first real run created four labels and died on the
      // fifth, and half-applied is the worst state — the drift report shrinks
      // and nothing says the run did not finish.
      http.request.mockImplementation(
        (path: string, options: { body: { name?: string } }) => {
          if (options.body?.name === 'factory:ready') {
            throw new GitHubRequestError(
              'GitHub rejected POST: description is too long',
              422,
              'POST',
              path,
            );
          }
          return Promise.resolve({ data: {} });
        },
      );

      const report = await service.provision(REPO);

      expect(report.created).toBe(PROVISIONED_LABELS.length - 1);
      expect(report.failed).toBe(1);
      expect(report.status).toBe('incomplete');
      expect(report.detail).toContain('factory:ready');
      expect(report.detail).toContain('description is too long');

      const ready = report.labels.find((l) => l.name === 'factory:ready');
      expect(ready?.action).toBe('failed');
      expect(ready?.detail).toContain('description is too long');
    });

    it('stops on a repository-wide refusal instead of spending fourteen more requests', async () => {
      // A 403 on the first create is not about that label. The remaining
      // attempts would spend the budget to be told the same thing.
      http.request.mockRejectedValue(
        new GitHubAuthError(
          'GitHub refused the request',
          403,
          'POST',
          '/labels',
        ),
      );

      const report = await service.provision(REPO);

      expect(http.request).toHaveBeenCalledTimes(1);
      expect(report.status).toBe('refused');
      expect(report.detail).toContain('could not be created');
    });

    it('KEEPS its counts when the write is refused but the read succeeded', async () => {
      // The reason the null is keyed on "were the labels read" rather than on
      // `status`. Here we know exactly what is on the repository — the list
      // came back — and only the write that followed was refused. Nulling
      // these would throw away a real observation to satisfy a rule about a
      // status, and would leave the ladder unable to say "0 of 15, and here is
      // why" when that is precisely the situation.
      http.request.mockRejectedValue(
        new GitHubAuthError('refused', 403, 'POST', '/labels'),
      );

      const report = await service.provision(REPO);

      expect(report.status).toBe('refused');
      expect(report.declared).toBe(PROVISIONED_LABELS.length);
      expect(report.present).toBe(0);
      expect(report.missing).toBe(PROVISIONED_LABELS.length);
      expect(report.labels).toHaveLength(PROVISIONED_LABELS.length);
    });
  });

  describe('the field names say what the fields mean', () => {
    it('reports `attempted` for a POST that wrote nothing because it was refused', async () => {
      // `applied: true` on a call that applied nothing was the objection.
      // `attempted` is a claim about what this call TRIED, and the outcome
      // lives in `status`, `created` and `failed`.
      http.request.mockRejectedValue(
        new GitHubAuthError('refused', 403, 'POST', '/labels'),
      );

      const report = await service.provision(REPO);

      expect(report.attempted).toBe(true);
      expect(report.created).toBe(0);
      expect(report.status).toBe('refused');
    });

    it('reports `attempted: false` for an inspection', async () => {
      expect((await service.inspect(REPO)).attempted).toBe(false);
    });

    it('keeps `stateBefore` in the past tense after a successful write', async () => {
      // The field is deliberately NOT updated: it is the only record that
      // anything happened, and a UI needs to say "created" rather than "was
      // already fine". The name carries the tense so no consumer has to
      // remember that `state` would be false the moment the POST succeeds.
      const report = await service.provision(REPO);
      const ready = report.labels.find((l) => l.name === 'factory:ready');

      expect(ready?.stateBefore).toBe('missing');
      expect(ready?.action).toBe('created');
      expect(ready).not.toHaveProperty('state');
    });
  });

  describe('checkedAt', () => {
    it('stamps the answer, because this is an observation and not a stored fact', async () => {
      class Frozen extends LabelProvisioningService {
        protected override now(): number {
          return Date.parse('2026-08-28T02:00:00Z');
        }
      }
      const frozen = new Frozen(
        http as unknown as GitHubHttpService,
        github as unknown as GitHubReadService,
      );

      const report = await frozen.inspect(REPO);

      expect(report.checkedAt).toBe('2026-08-28T02:00:00.000Z');
      expect(report.repository).toBe('acme/app');
    });
  });
});

describe('the kill switch does not reach this surface', () => {
  /**
   * `github.writesEnabled` governs whether the factory ACTS ON ISSUES DURING A
   * TICK. Creating the label taxonomy is operator setup — the same category as
   * registering a repository — and it happens before the loop has anything to
   * say. `scripts/sync-labels.mjs` states the consequence of getting this
   * wrong: the observation week could not be set up without turning on the
   * very writes the switch exists to withhold.
   *
   * Asserted through the REAL HTTP pipeline with a real settings service, so
   * the switch genuinely is off and genuinely is not consulted — a mocked
   * `GitHubHttpService` would prove nothing about a kill switch that lives
   * inside `GitHubWriteService`.
   */
  it('creates labels with github.writesEnabled false', async () => {
    const settings = makeOperatorSettings({
      overrides: {
        'github.writesEnabled': false,
        'github.token': 'ghp_test',
        'github.maxRetries': 0,
      },
    });
    expect(settings.get('github.writesEnabled')).toBe(false);

    const posted: string[] = [];
    const fetchMock = jest
      .fn()
      .mockImplementation(
        async (url: string, init: { method?: string; body?: string }) => {
          if ((init.method ?? 'GET') === 'GET') {
            return new Response('[]', {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          posted.push(String(JSON.parse(init.body ?? '{}').name));
          return new Response('{}', {
            status: 201,
            headers: { 'content-type': 'application/json' },
          });
        },
      );
    const originalFetch = global.fetch;
    global.fetch = fetchMock as unknown as typeof fetch;

    try {
      const http = new GitHubHttpService(
        settings,
        new RateLimitService(),
        new EtagCacheService(10),
      );
      const service = new LabelProvisioningService(
        http,
        new GitHubReadService(http),
      );

      const report = await service.provision(REPO);

      expect(report.status).toBe('ok');
      expect(report.created).toBe(PROVISIONED_LABELS.length);
      expect(posted).toContain('factory:ready');
    } finally {
      global.fetch = originalFetch;
    }
  });
});
