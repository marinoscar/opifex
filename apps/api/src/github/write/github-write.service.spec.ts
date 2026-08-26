import { makeOperatorSettings } from '../../settings/operator-settings/operator-settings.test-double';
import { GitHubHttpService } from '../github-http.service';
import { GitHubNotFoundError } from '../github.errors';
import { GitHubWriteService } from './github-write.service';
import {
  ApprovalRequirement,
  Reversibility,
  WriteAction,
} from './reversibility';

const REPO = { owner: 'acme', name: 'app' };

function httpMock() {
  return {
    request: jest.fn().mockResolvedValue({ data: {} }),
  } as unknown as jest.Mocked<Pick<GitHubHttpService, 'request'>>;
}

function build(http: ReturnType<typeof httpMock>, writesEnabled: boolean) {
  return buildLive(http, writesEnabled).service;
}

/**
 * The same service, with the settings handle kept — so a spec can flip the
 * kill switch while the service is alive, which is #341's whole subject.
 */
function buildLive(http: ReturnType<typeof httpMock>, writesEnabled: boolean) {
  const settings = makeOperatorSettings({
    overrides: { 'github.writesEnabled': writesEnabled },
  });
  return {
    settings,
    service: new GitHubWriteService(
      http as unknown as GitHubHttpService,
      settings,
    ),
  };
}

describe('GitHubWriteService', () => {
  let http: ReturnType<typeof httpMock>;

  beforeEach(() => {
    http = httpMock();
  });

  describe('the kill switch', () => {
    it('defaults OFF when nothing is configured', () => {
      // VISION §12's observation week is the default posture, not an opt-in.
      // No override and no environment, so this asserts the REGISTRY's default
      // rather than a `?? false` at the call site.
      const service = new GitHubWriteService(
        http as unknown as GitHubHttpService,
        makeOperatorSettings(),
      );

      expect(service.enabled).toBe(false);
    });

    it('issues no HTTP request at all while disabled', async () => {
      await build(http, false).addLabel(REPO, 312, 'factory/dispatched');

      expect(http.request).not.toHaveBeenCalled();
    });

    it('still returns a fully-formed result, because the diff log IS the deliverable', async () => {
      // With writes off the calling path must be the REAL one, exercised for a
      // week — not a branch that has never run. A suppressed write therefore
      // produces a record as complete as a performed one.
      const result = await build(http, false).addLabel(
        REPO,
        312,
        'factory/dispatched',
      );

      expect(result).toMatchObject({
        action: WriteAction.AddLabel,
        reversibility: Reversibility.Reversible,
        performed: false,
      });
      expect(result.description).toContain('factory/dispatched');
      expect(result.description).toContain('acme/app#312');
    });

    it('suppresses pre-authorized record-writing too', async () => {
      // The carve-out is about APPROVAL, not about the kill switch. During the
      // observation week nothing reaches GitHub, mandated or not.
      const result = await build(http, false).postRunSummary(
        REPO,
        9,
        'summary',
      );

      expect(result.performed).toBe(false);
      expect(http.request).not.toHaveBeenCalled();
    });

    it('performs the write when enabled', async () => {
      const result = await build(http, true).addLabel(
        REPO,
        312,
        'factory/dispatched',
      );

      expect(result.performed).toBe(true);
      expect(http.request).toHaveBeenCalledWith(
        '/repos/acme/app/issues/312/labels',
        expect.objectContaining({
          method: 'POST',
          body: { labels: ['factory/dispatched'] },
        }),
      );
    });
  });

  /**
   * #341. A kill switch you have to restart to pull is not a kill switch: the
   * flag was frozen at construction and `enabled` returned the frozen copy, so
   * flipping GitHub writes in the Control Center would have appeared to work
   * and changed nothing.
   */
  describe('the kill switch is read per call (#341)', () => {
    it('stops writing when it is turned off mid-flight', async () => {
      const { settings, service } = buildLive(http, true);

      await service.addLabel(REPO, 312, 'factory/dispatched');
      expect(http.request).toHaveBeenCalledTimes(1);

      settings.setOverride('github.writesEnabled', false);

      const result = await service.addLabel(REPO, 312, 'factory/dispatched');

      // COMPLETE, not truncated. The diff log is the deliverable of the
      // observation week (VISION §12), not a debugging aid — a suppressed
      // write must produce a record as full as a performed one, so this is an
      // exhaustive equality rather than a `toMatchObject` that would pass with
      // half the fields missing.
      expect(result).toEqual({
        action: WriteAction.AddLabel,
        reversibility: Reversibility.Reversible,
        approval: ApprovalRequirement.Gated,
        performed: false,
        noop: false,
        url: null,
        description: "Add 'factory/dispatched' to acme/app#312",
      });
      expect(http.request).toHaveBeenCalledTimes(1);
    });

    it('starts writing when it is turned on mid-flight', async () => {
      // The other direction, and the reason it is safe: a write performed here
      // is one an operator authorised seconds earlier.
      const { settings, service } = buildLive(http, false);

      expect((await service.addLabel(REPO, 312, 'x')).performed).toBe(false);

      settings.setOverride('github.writesEnabled', true);

      expect((await service.addLabel(REPO, 312, 'x')).performed).toBe(true);
      expect(http.request).toHaveBeenCalledTimes(1);
    });

    it('reports `enabled` as of now, not as of construction', () => {
      const { settings, service } = buildLive(http, false);

      expect(service.enabled).toBe(false);
      settings.setOverride('github.writesEnabled', true);
      expect(service.enabled).toBe(true);
    });

    it('counts a write already in flight when the switch is pulled', async () => {
      // #317's counter is incremented BEFORE the await and outside any try,
      // because from that point a request is on its way out. Turning writes off
      // while it is in flight cannot un-issue it: the number's job is to catch
      // a window that was supposed to be read-only, so it must not lose the
      // one write that escaped.
      const { settings, service } = buildLive(http, true);
      let release: () => void = () => undefined;
      http.request.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () =>
              resolve({
                data: {},
                status: 200,
                fromCache: false,
                link: null,
                etag: null,
              });
          }),
      );

      const inFlight = service.addLabel(REPO, 312, 'factory/dispatched');
      settings.setOverride('github.writesEnabled', false);
      release();

      expect((await inFlight).performed).toBe(true);
      expect(service.writesIssued).toBe(1);

      // And the next call, decided after the flip, does not move it.
      await service.addLabel(REPO, 312, 'factory/dispatched');
      expect(service.writesIssued).toBe(1);
    });

    it('resumes counting when the switch goes back on', async () => {
      const { settings, service } = buildLive(http, true);

      await service.addLabel(REPO, 312, 'a');
      settings.setOverride('github.writesEnabled', false);
      await service.addLabel(REPO, 312, 'b');
      settings.setOverride('github.writesEnabled', true);
      await service.addLabel(REPO, 312, 'c');

      // Two, not three: the suppressed write never touched GitHub.
      expect(service.writesIssued).toBe(2);
      expect(http.request).toHaveBeenCalledTimes(2);
    });
  });

  describe('every result carries its classification', () => {
    it.each([
      [
        'addLabel',
        () => build(http, true).addLabel(REPO, 1, 'x'),
        Reversibility.Reversible,
        ApprovalRequirement.Gated,
      ],
      [
        'removeLabel',
        () => build(http, true).removeLabel(REPO, 1, 'x'),
        Reversibility.Reversible,
        ApprovalRequirement.Gated,
      ],
      [
        'postGeneralComment',
        () => build(http, true).postGeneralComment(REPO, 1, 'x'),
        Reversibility.Irreversible,
        ApprovalRequirement.Gated,
      ],
      [
        'postRunSummary',
        () => build(http, true).postRunSummary(REPO, 1, 'x'),
        Reversibility.Irreversible,
        ApprovalRequirement.PreAuthorizedRecord,
      ],
      [
        'postAuthorizationRecord',
        () => build(http, true).postAuthorizationRecord(REPO, 1, {}),
        Reversibility.Irreversible,
        ApprovalRequirement.PreAuthorizedRecord,
      ],
      [
        'postEscalationNote',
        () => build(http, true).postEscalationNote(REPO, 1, 'x'),
        Reversibility.Irreversible,
        ApprovalRequirement.PreAuthorizedRecord,
      ],
    ])('%s', async (_name, call, reversibility, approval) => {
      // The approval engine in epic #22 consumes this. Establishing it at the
      // adapter means it is a decision made here, not one guessed later by
      // whoever writes that engine.
      const result = await call();

      expect(result.reversibility).toBe(reversibility);
      expect(result.approval).toBe(approval);
    });
  });

  describe('idempotency', () => {
    it('does not check before adding a label, since GitHub accepts a duplicate', async () => {
      // Checking first would cost one request per tick to avoid an error that
      // does not occur — the add-labels endpoint returns 200 for a label
      // already present.
      await build(http, true).addLabel(REPO, 312, 'bug');

      expect(http.request).toHaveBeenCalledTimes(1);
    });

    it('treats "label does not exist" on removal as the end state already holding', async () => {
      // A reconciler computing "this label should be absent" must not fail
      // every tick after the first one that removed it.
      http.request.mockRejectedValue(
        new GitHubNotFoundError(
          'Label does not exist (DELETE /x)',
          404,
          'DELETE',
          '/x',
        ),
      );

      const result = await build(http, true).removeLabel(
        REPO,
        312,
        'factory/dispatched',
      );

      expect(result.noop).toBe(true);
      expect(result.performed).toBe(true);
    });

    it('does NOT swallow a 404 for a wrong issue number', async () => {
      // GitHub answers 404 for both cases and only the message separates them.
      // Swallowing this one hides a wrong issue number for weeks.
      http.request.mockRejectedValue(
        new GitHubNotFoundError('Not Found (DELETE /x)', 404, 'DELETE', '/x'),
      );

      await expect(
        build(http, true).removeLabel(REPO, 999, 'bug'),
      ).rejects.toBeInstanceOf(GitHubNotFoundError);
    });

    it('URL-encodes a label name on removal', async () => {
      // `factory:clear-quarantine` and anything with a slash or space would
      // otherwise change the path rather than the label.
      await build(http, true).removeLabel(REPO, 312, 'factory/dispatched');

      expect(http.request).toHaveBeenCalledWith(
        '/repos/acme/app/issues/312/labels/factory%2Fdispatched',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  describe('the authorization record', () => {
    it('posts the work order as tagged, fenced JSON', async () => {
      // VISION §5's premise is that the GitHub graph extracts into a knowledge
      // graph. An unfenced blob of JSON in prose does not extract, and an HTML
      // marker is what lets a later reader find it without guessing.
      await build(http, true).postAuthorizationRecord(REPO, 312, {
        id: 'wo_app_312_a3f91c2_a1',
      });

      const [, options] = http.request.mock.calls[0] as [
        string,
        { body: { body: string } },
      ];
      expect(options.body.body).toContain(
        '<!-- opifex:authorization-record -->',
      );
      expect(options.body.body).toContain('```json');
      expect(options.body.body).toContain('"wo_app_312_a3f91c2_a1"');
    });

    it('marks the run summary and escalation notes too', async () => {
      const service = build(http, true);
      await service.postRunSummary(REPO, 9, 'ran fine');
      await service.postEscalationNote(REPO, 312, 'stalled');

      const bodies = http.request.mock.calls.map(
        ([, options]) => (options as { body: { body: string } }).body.body,
      );
      expect(bodies[0]).toContain('<!-- opifex:run-summary -->');
      expect(bodies[1]).toContain('<!-- opifex:escalation -->');
    });

    it('leaves a general comment unmarked', async () => {
      // Only the records VISION mandates are machine-extractable markers; a
      // marker on an ordinary comment would make it look like one.
      await build(http, true).postGeneralComment(REPO, 312, 'just a note');

      const [, options] = http.request.mock.calls[0] as [
        string,
        { body: { body: string } },
      ];
      expect(options.body.body).toBe('just a note');
    });
  });

  /**
   * #317: the reconcile log's `actionsExecuted` was a literal `0`, so the
   * observation week's only safety check could not fail. The counter lives
   * here, at the one place every GitHub write must pass through, so that it
   * is closed under write paths that do not exist yet.
   */
  describe('the issued-writes counter', () => {
    it('starts at zero', () => {
      expect(build(http, true).writesIssued).toBe(0);
    });

    it('does NOT move while the kill switch is off', async () => {
      // The load-bearing assertion. This is what makes "actionsExecuted is 0
      // for the whole observation week" a measurement instead of an assertion.
      const service = build(http, false);

      await service.addLabel(REPO, 312, 'factory/dispatched');
      await service.postGeneralComment(REPO, 312, 'a note');
      await service.postAuthorizationRecord(REPO, 312, { id: 'wo' });

      expect(service.writesIssued).toBe(0);
    });

    it('counts every kind of write, not just labels', async () => {
      // A tick reaches GitHub through four paths and only two of them report
      // a tally. Counting here is what stops the dispatch writes going unseen.
      const service = build(http, true);

      await service.addLabel(REPO, 312, 'factory/dispatched');
      await service.postAuthorizationRecord(REPO, 312, { id: 'wo' });
      await service.postRunSummary(REPO, 9, 'done');

      expect(service.writesIssued).toBe(3);
    });

    it('counts a write that changed nothing, because it still touched GitHub', async () => {
      // A removal of a label that is not there sends the DELETE and spends
      // rate-limit budget. It is a touch, and the week's rule is about touches.
      const service = build(http, true);
      http.request.mockRejectedValueOnce(
        new GitHubNotFoundError('Label does not exist', 404, 'DELETE', '/x'),
      );

      const result = await service.removeLabel(REPO, 312, 'factory/dispatched');

      expect(result.noop).toBe(true);
      expect(service.writesIssued).toBe(1);
    });

    it('counts a write that THREW, because its effect is unknown', async () => {
      // A mutation that answers 500 may still have landed. Dropping it here
      // would report a clean window that was not one.
      const service = build(http, true);
      http.request.mockRejectedValueOnce(new Error('502 from GitHub'));

      await expect(
        service.addLabel(REPO, 312, 'factory/dispatched'),
      ).rejects.toThrow('502');
      expect(service.writesIssued).toBe(1);
    });
  });

  describe('what this service cannot do', () => {
    it('exposes no member outside the classified set', () => {
      // If a method is added without a `WriteAction`, it shows up here. The
      // never-trustable list is enforced by ABSENCE (see reversibility.spec),
      // and this is the guard that the absence stays true as the class grows:
      // a new adapter has to be added to this list deliberately.
      const members = Object.getOwnPropertyNames(
        GitHubWriteService.prototype,
      ).filter((name) => name !== 'constructor');

      expect(members.sort()).toEqual([
        'addLabel',
        // The kill-switch getter, not a write.
        'enabled',
        // The single kill-switch check. Public so the issue-creation gate
        // (#108) routes its own write through it rather than around it.
        'guardedWrite',
        'postAuthorizationRecord',
        // The shared comment poster the four comment adapters route through.
        'postComment',
        'postEscalationNote',
        'postGeneralComment',
        'postRunSummary',
        'removeLabel',
        // The issued-writes counter (#317), a read-only getter. Here rather
        // than exempted, because the point of this list is that anything new
        // on the class is added to it deliberately.
        'writesIssued',
      ]);
    });
  });
});
