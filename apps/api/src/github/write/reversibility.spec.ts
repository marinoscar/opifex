import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ApprovalRequirement,
  NEVER_TRUSTABLE,
  RECORD_WRITING_ACTIONS,
  Reversibility,
  WRITE_ACTIONS,
  WriteAction,
} from './reversibility';

const writeServiceSource = readFileSync(
  join(__dirname, 'github-write.service.ts'),
  'utf8',
);

describe('write action classification', () => {
  it('classifies every action — a missing one would be an action nobody decided about', () => {
    for (const action of Object.values(WriteAction)) {
      expect(WRITE_ACTIONS[action]).toBeDefined();
      expect(WRITE_ACTIONS[action].action).toBe(action);
      expect(WRITE_ACTIONS[action].summary).not.toHaveLength(0);
    }
  });

  it('treats labels as reversible and comments as not', () => {
    // VISION §3.5's actual line: a label can be removed and the issue is where
    // it was; a comment can be deleted only after everyone subscribed has been
    // emailed it. VISION's own irreversible examples include "a Slack post".
    expect(WRITE_ACTIONS[WriteAction.AddLabel].reversibility).toBe(
      Reversibility.Reversible,
    );
    expect(WRITE_ACTIONS[WriteAction.RemoveLabel].reversibility).toBe(
      Reversibility.Reversible,
    );
    expect(WRITE_ACTIONS[WriteAction.PostComment].reversibility).toBe(
      Reversibility.Irreversible,
    );
    expect(WRITE_ACTIONS[WriteAction.CreateIssue].reversibility).toBe(
      Reversibility.Irreversible,
    );
  });

  describe('the pre-authorized carve-out', () => {
    it('covers exactly the three records VISION mandates, and nothing else', () => {
      // The carve-out exists because VISION §4 and §5 REQUIRE these to be
      // posted unattended while §3.5 gates irreversible actions. Widening it
      // by one entry would turn "the control plane records what it did" into
      // "comments are fine", which is the whole thing §3.5 prevents.
      expect([...RECORD_WRITING_ACTIONS].sort()).toEqual(
        [
          WriteAction.PostAuthorizationRecord,
          WriteAction.PostRunSummary,
          WriteAction.PostEscalationNote,
        ].sort(),
      );
    });

    it('does NOT cover a general comment', () => {
      // A supervisor arguing for a decomposition is an ordinary irreversible
      // action and gets gated like one.
      expect(WRITE_ACTIONS[WriteAction.PostComment].approval).toBe(
        ApprovalRequirement.Gated,
      );
    });

    it('does NOT cover issue creation', () => {
      expect(WRITE_ACTIONS[WriteAction.CreateIssue].approval).toBe(
        ApprovalRequirement.Gated,
      );
    });

    it('applies only to irreversible actions, since a reversible one needs no carve-out', () => {
      for (const action of RECORD_WRITING_ACTIONS) {
        expect(WRITE_ACTIONS[action].reversibility).toBe(
          Reversibility.Irreversible,
        );
      }
    });
  });

  describe('the never-trustable list', () => {
    /**
     * The real enforcement is that no method exists. This asserts it against
     * the source, because a unit test can only call methods that are there —
     * the failure mode being guarded is somebody ADDING one, which no
     * behavioural test can see.
     */
    const forbiddenMethodNames = [
      'forcePush',
      'push',
      'deleteBranch',
      'deleteIssue',
      'deletePullRequest',
      'mergePullRequest',
      'merge',
      'updateWorkflow',
      'setSecret',
      'getSecret',
      'updateBranchProtection',
    ];

    it.each(forbiddenMethodNames)('has no %s adapter', (name) => {
      // An adapter that does not exist cannot be called by a future mistake,
      // by a misconfigured trust grant, or by a supervisor that has talked
      // itself into something.
      expect(writeServiceSource).not.toMatch(
        new RegExp(`\\b(async\\s+)?${name}\\s*\\(`),
      );
    });

    it('issues no request with a method that could destroy something', () => {
      // DELETE appears exactly once, for removing a label, which is reversible.
      const deletes = writeServiceSource.match(/method: 'DELETE'/g) ?? [];
      expect(deletes).toHaveLength(1);

      expect(writeServiceSource).not.toContain("method: 'PUT'");
    });

    it('touches no path that would reach a protected resource', () => {
      // Still true, and deliberately narrow in scope: it is about THIS
      // service. `GitBranchService` may create `factory/*` refs and nothing
      // else, under its own guards (ADR-0005, git-branch.service.spec.ts).
      // Read this as "the general write path cannot reach these", not as
      // "nothing in Opifex can".
      for (const forbidden of [
        '/git/refs',
        '/branches',
        '/actions/',
        '/merge',
        '/secrets',
      ]) {
        expect(writeServiceSource).not.toContain(forbidden);
      }
    });

    it('keeps the list itself non-empty and documented', () => {
      // Guards against the list being emptied in a refactor and the tests
      // above still passing vacuously.
      expect(NEVER_TRUSTABLE.length).toBeGreaterThanOrEqual(9);
      expect(NEVER_TRUSTABLE).toContain('force-push');
      expect(NEVER_TRUSTABLE).toContain('modify CI workflows');
    });
  });
});
