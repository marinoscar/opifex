import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { GitHubHttpService } from '../github-http.service';
import { GitHubReadService } from '../read/github-read.service';
import { PrismaService } from '../../prisma/prisma.service';
import { makeOperatorSettings } from '../../settings/operator-settings/operator-settings.test-double';
import { GitHubWriteService } from './github-write.service';
import {
  GitHubIssueGateService,
  type IssueCandidate,
} from './issue-gate.service';

const REPO = { owner: 'acme', name: 'app' };

const GOOD_CANDIDATE: IssueCandidate = {
  kind: 'feature',
  title: 'Add CSV export to the reports page',
  body: [
    '## Problem statement\n\nOperators export reports by hand, twenty minutes a time.',
    '## Proposed solution\n\nAdd a CSV export endpoint behind the existing auth.',
    '## Affected component\n\napi',
    '## Priority\n\nP2 medium',
    '## Acceptance criteria\n\n- [ ] Given a signed-in user, when they GET /export, then a CSV downloads',
  ].join('\n\n'),
  proposedBy: 'supervisor:decomposition',
};

function openIssue(number: number, title: string, body: string) {
  return { number, title, body };
}

describe('GitHubIssueGateService', () => {
  let http: { request: jest.Mock };
  let read: { listIssues: jest.Mock };
  let writes: GitHubWriteService;
  let prisma: { auditEvent: { create: jest.Mock } };
  let service: GitHubIssueGateService;

  function build(writesEnabled = true) {
    writes = new GitHubWriteService(
      http as unknown as GitHubHttpService,
      makeOperatorSettings({
        overrides: { 'github.writesEnabled': writesEnabled },
      }),
    );

    return new GitHubIssueGateService(
      http as unknown as GitHubHttpService,
      read as unknown as GitHubReadService,
      writes,
      prisma as unknown as PrismaService,
    );
  }

  beforeEach(() => {
    http = {
      request: jest
        .fn()
        .mockResolvedValue({ data: { number: 400, html_url: 'u' } }),
    };
    read = { listIssues: jest.fn().mockResolvedValue({ issues: [] }) };
    prisma = { auditEvent: { create: jest.fn().mockResolvedValue({}) } };
    service = build();
  });

  describe('a conformant, non-duplicate candidate', () => {
    it('is accepted and opened', async () => {
      const outcome = await service.createIssue(REPO, GOOD_CANDIDATE);

      expect(outcome.accepted).toBe(true);
      expect(http.request).toHaveBeenCalledWith(
        '/repos/acme/app/issues',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('returns the new issue number', async () => {
      const outcome = await service.createIssue(REPO, GOOD_CANDIDATE);

      expect(outcome.accepted && outcome.issueNumber).toBe(400);
    });

    it('applies the template label, deduplicated against any extras', async () => {
      await service.createIssue(REPO, {
        ...GOOD_CANDIDATE,
        labels: ['feature', 'api'],
      });

      const [, options] = http.request.mock.calls[0] as [
        string,
        { body: { labels: string[] } },
      ];
      expect([...options.body.labels].sort()).toEqual(['api', 'feature']);
    });

    it('records the acceptance', async () => {
      await service.createIssue(REPO, GOOD_CANDIDATE);

      const [{ data }] = prisma.auditEvent.create.mock.calls[0] as [
        { data: { action: string; meta: Record<string, unknown> } },
      ];
      expect(data.action).toBe('issue_creation.accepted');
      expect(data.meta).toMatchObject({
        proposedBy: 'supervisor:decomposition',
        issueNumber: 400,
      });
    });
  });

  describe('template conformance', () => {
    it('refuses a candidate missing a required section, naming it', async () => {
      const outcome = await service.createIssue(REPO, {
        ...GOOD_CANDIDATE,
        body: '## Priority\n\nP2 medium',
      });

      expect(outcome.accepted).toBe(false);
      expect(!outcome.accepted && outcome.refusal.reason).toBe('template');
      expect(
        !outcome.accepted &&
          outcome.refusal.reason === 'template' &&
          outcome.refusal.failures.map((f) => f.section),
      ).toContain('Problem statement');
    });

    it('opens nothing when it refuses', async () => {
      await service.createIssue(REPO, {
        ...GOOD_CANDIDATE,
        body: 'nothing here',
      });

      expect(http.request).not.toHaveBeenCalled();
    });

    it('checks conformance BEFORE spending a request on the dedupe read', async () => {
      // The dedupe check reads every open issue in the repository. Refusing a
      // malformed candidate before spending that budget is the difference
      // between a cheap gate and one an operator turns off.
      await service.createIssue(REPO, {
        ...GOOD_CANDIDATE,
        body: 'nothing here',
      });

      expect(read.listIssues).not.toHaveBeenCalled();
    });

    it('records the refusal', async () => {
      await service.createIssue(REPO, {
        ...GOOD_CANDIDATE,
        body: 'nothing here',
      });

      const [{ data }] = prisma.auditEvent.create.mock.calls[0] as [
        { data: { action: string } },
      ];
      // #108: "an agent repeatedly proposing duplicate issues is itself a
      // signal." A refusal that only travels back to the caller is invisible.
      expect(data.action).toBe('issue_creation.refused');
    });
  });

  describe('dedupe', () => {
    it('refuses a near-duplicate and names the matched issue', async () => {
      read.listIssues.mockResolvedValue({
        issues: [
          openIssue(
            312,
            'Add CSV export to the reports page',
            'Operators currently export reports by hand; add a CSV download button.',
          ),
        ],
      });

      const outcome = await service.createIssue(REPO, GOOD_CANDIDATE);

      expect(outcome.accepted).toBe(false);
      expect(!outcome.accepted && outcome.refusal).toMatchObject({
        reason: 'duplicate',
        issueNumber: 312,
      });
      expect(http.request).not.toHaveBeenCalled();
    });

    it('accepts against unrelated open issues', async () => {
      read.listIssues.mockResolvedValue({
        issues: [
          openIssue(
            1,
            'Rotate the JWT signing secret',
            'It has never changed.',
          ),
        ],
      });

      expect((await service.createIssue(REPO, GOOD_CANDIDATE)).accepted).toBe(
        true,
      );
    });

    it('compares against OPEN issues only', async () => {
      // A closed duplicate is not noise. Refusing against closed issues would
      // make a genuinely recurring bug unreportable.
      await service.createIssue(REPO, GOOD_CANDIDATE);

      expect(read.listIssues).toHaveBeenCalledWith(REPO, { state: 'open' });
    });

    it('reports the closest match when several are similar', async () => {
      read.listIssues.mockResolvedValue({
        issues: [
          openIssue(
            100,
            'Add CSV export somewhere',
            'unrelated body text entirely here',
          ),
          openIssue(
            312,
            'Add CSV export to the reports page',
            'Operators export reports by hand, twenty minutes a time.',
          ),
        ],
      });

      const outcome = await service.createIssue(REPO, GOOD_CANDIDATE);

      expect(!outcome.accepted && outcome.refusal).toMatchObject({
        issueNumber: 312,
      });
    });

    it('records the duplicate refusal with its score', async () => {
      read.listIssues.mockResolvedValue({
        issues: [openIssue(312, GOOD_CANDIDATE.title, GOOD_CANDIDATE.body)],
      });

      await service.createIssue(REPO, GOOD_CANDIDATE);

      const [{ data }] = prisma.auditEvent.create.mock.calls[0] as [
        { data: { meta: { refusal: { score: number; issueNumber: number } } } },
      ];
      expect(data.meta.refusal.issueNumber).toBe(312);
      expect(data.meta.refusal.score).toBeGreaterThan(0.65);
    });

    it('tolerates an open issue with an empty body', async () => {
      read.listIssues.mockResolvedValue({
        issues: [{ number: 5, title: 'x', body: null }],
      });

      expect((await service.createIssue(REPO, GOOD_CANDIDATE)).accepted).toBe(
        true,
      );
    });
  });

  describe('the observation-week kill switch', () => {
    it('runs the full gate but opens nothing while writes are disabled', async () => {
      // The gate's verdict is the interesting output during the week: a
      // conformant candidate must be RECORDED as "would have opened" so the
      // diff log shows what the proposer was doing.
      service = build(false);

      const outcome = await service.createIssue(REPO, GOOD_CANDIDATE);

      expect(outcome.accepted).toBe(true);
      expect(outcome.accepted && outcome.result.performed).toBe(false);
      expect(http.request).not.toHaveBeenCalled();
      expect(prisma.auditEvent.create).toHaveBeenCalled();
    });
  });

  describe('this is the ONLY path that can open an issue', () => {
    /**
     * The guarantee #108 actually asks for: "No code path in the system can
     * create an issue except through this adapter."
     *
     * Asserted against the source for the same reason the never-trustable list
     * is — the failure mode is somebody ADDING a second path, which no
     * behavioural test can observe. A grep is the check that sees it.
     */
    const SRC = join(__dirname, '..', '..');

    function allSourceFiles(dir: string): string[] {
      return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return allSourceFiles(path);
        return entry.isFile() &&
          entry.name.endsWith('.ts') &&
          !entry.name.endsWith('.spec.ts')
          ? [path]
          : [];
      });
    }

    /**
     * The issues COLLECTION path, followed by a POST within the same call.
     *
     * Both halves are load-bearing. The path alone matches the read adapter's
     * `listIssues`, which is a GET and perfectly fine — an earlier version of
     * this test flagged it. The method alone matches every comment and label
     * write. Only the two together are issue creation.
     */
    const CREATES_AN_ISSUE =
      /`\/repos\/\$\{[^}]+\}\/\$\{[^}]+\}\/issues`[\s\S]{0,200}?method: 'POST'/;

    it('is the only file that posts to the issues collection', () => {
      const offenders = allSourceFiles(SRC)
        .filter((path) => CREATES_AN_ISSUE.test(readFileSync(path, 'utf8')))
        .map((path) => path.replace(SRC, ''));

      expect(offenders).toEqual(['/github/write/issue-gate.service.ts']);
    });

    it('does not flag the read adapter, which GETs the same path', () => {
      // Guards the guard: a regex that matched everything would make the
      // assertion above pass vacuously the day a second creation path appears.
      const readService = readFileSync(
        join(__dirname, '..', 'read', 'github-read.service.ts'),
        'utf8',
      );

      expect(readService).toContain('/issues`');
      expect(CREATES_AN_ISSUE.test(readService)).toBe(false);
    });

    it('is not on the write service, so there is no ungated adapter to reach for', () => {
      const writeService = readFileSync(
        join(__dirname, 'github-write.service.ts'),
        'utf8',
      );

      expect(writeService).not.toMatch(/\bcreateIssue\s*\(/);
    });

    it('routes its own write through the kill switch rather than around it', () => {
      const source = readFileSync(
        join(__dirname, 'issue-gate.service.ts'),
        'utf8',
      );

      expect(source).toContain('guardedWrite');
    });
  });
});
