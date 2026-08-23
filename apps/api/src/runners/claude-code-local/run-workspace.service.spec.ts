import { ConfigService } from '@nestjs/config';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  GIT_TOKEN_ENV_VAR,
  RunWorkspaceService,
  WorkspaceError,
} from './run-workspace.service';

const exec = promisify(execFile);

/**
 * Against real git, against a real repository.
 *
 * What this file asserts is that a checkout ends up at the pinned base commit
 * and nowhere else — and "nowhere else" is a claim about git's behaviour, not
 * about ours. Mocking git would assert that we compose the argv we believe is
 * right, which is the belief under test.
 *
 * The origin is a local repository, so nothing here touches the network.
 */
describe('RunWorkspaceService', () => {
  let scratch: string;
  let origin: string;
  let workspaceRoot: string;
  let baseCommit: string;
  let laterCommit: string;
  let service: RunWorkspaceService;

  async function git(cwd: string, ...args: string[]): Promise<string> {
    const { stdout } = await exec('git', args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout.trim();
  }

  function build(overrides: Record<string, unknown> = {}): RunWorkspaceService {
    const values: Record<string, unknown> = {
      'runners.claudeCodeLocal.workspaceRoot': workspaceRoot,
      'runners.claudeCodeLocal.gitBinary': 'git',
      'runners.claudeCodeLocal.gitRemoteBaseUrl': `file://${scratch}`,
      'runners.claudeCodeLocal.committerName': 'Opifex Factory',
      'runners.claudeCodeLocal.committerEmail': 'factory@opifex.local',
      'github.token': 'ghp_fake_token_for_tests',
      ...overrides,
    };
    const config = {
      get: (key: string) => values[key],
    } as unknown as ConfigService;
    return new RunWorkspaceService(config);
  }

  const request = () => ({
    identity: 'wo_acme-widgets_42_abc1234_a1',
    repository: { owner: 'acme', name: 'widgets' },
    baseCommit,
    branch: 'factory/42-abc1234-a1',
  });

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'opifex-ws-'));
    workspaceRoot = join(scratch, 'workspaces');

    // The origin lives at <scratch>/acme/widgets.git so `file://<scratch>` +
    // `/acme/widgets.git` — the exact URL the service composes — resolves.
    origin = join(scratch, 'acme', 'widgets.git');
    await exec('git', ['init', '--bare', '--initial-branch=main', origin]);

    const seed = join(scratch, 'seed');
    await exec('git', ['clone', origin, seed]);
    await git(seed, 'config', 'user.email', 'seed@opifex.local');
    await git(seed, 'config', 'user.name', 'Seed');

    await writeFile(join(seed, 'README.md'), '# base\n');
    await git(seed, 'add', '.');
    await git(seed, 'commit', '-m', 'base commit');
    baseCommit = await git(seed, 'rev-parse', 'HEAD');

    // A commit AFTER the base, so a test can prove the workspace pins the
    // base rather than following the branch tip.
    await writeFile(join(seed, 'README.md'), '# moved on\n');
    await git(seed, 'commit', '-am', 'a later commit');
    laterCommit = await git(seed, 'rev-parse', 'HEAD');
    await git(seed, 'push', 'origin', 'main');
  }, 60_000);

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
    service = build();
  });

  describe('provision', () => {
    it('checks out the pinned base commit on the work order branch', async () => {
      const workspace = await service.provision(request());

      expect(workspace.reused).toBe(false);
      expect(workspace.headCommit).toBe(baseCommit);
      expect(await git(workspace.dir, 'rev-parse', 'HEAD')).toBe(baseCommit);
      expect(
        await git(workspace.dir, 'rev-parse', '--abbrev-ref', 'HEAD'),
      ).toBe('factory/42-abc1234-a1');
    }, 30_000);

    it('pins the base commit rather than following the branch tip', async () => {
      // The property VISION §3.4's recovery model rests on. The origin's main
      // has moved on; the run must still start from what was authorized.
      const workspace = await service.provision(request());

      expect(await git(workspace.dir, 'rev-parse', 'HEAD')).not.toBe(
        laterCommit,
      );
      expect(await readFile(join(workspace.dir, 'README.md'), 'utf8')).toBe(
        '# base\n',
      );
    }, 30_000);

    it('reuses an existing workspace at the same commit', async () => {
      // #18: "re-running the same work order is idempotent — the runner checks
      // whether its branch already exists before doing anything."
      const first = await service.provision(request());
      await writeFile(join(first.dir, 'marker.txt'), 'left by the first run\n');

      const second = await service.provision(request());

      expect(second.reused).toBe(true);
      expect(second.dir).toBe(first.dir);
      expect(await readFile(join(second.dir, 'marker.txt'), 'utf8')).toContain(
        'first run',
      );
    }, 30_000);

    it('rebuilds a workspace whose HEAD has moved off the base commit', async () => {
      // A previous attempt that committed work must NOT be resumed: VISION
      // §3.4 makes recovery abandon-and-re-run from the pinned base, and
      // reusing a tree with commits on it would quietly be resumption.
      const first = await service.provision(request());
      await writeFile(join(first.dir, 'work.txt'), 'half-finished\n');
      await git(first.dir, 'add', '.');
      await git(first.dir, 'commit', '-m', 'partial work from a dead run');
      expect(await git(first.dir, 'rev-parse', 'HEAD')).not.toBe(baseCommit);

      const second = await service.provision(request());

      expect(second.reused).toBe(false);
      expect(await git(second.dir, 'rev-parse', 'HEAD')).toBe(baseCommit);
      await expect(
        readFile(join(second.dir, 'work.txt'), 'utf8'),
      ).rejects.toThrow();
    }, 30_000);

    it('rebuilds a workspace that is not a git repository at all', async () => {
      const dir = service.directoryFor(request().identity);
      await exec('mkdir', ['-p', dir]);
      await writeFile(join(dir, 'junk.txt'), 'left over from something\n');

      const workspace = await service.provision(request());

      expect(workspace.headCommit).toBe(baseCommit);
      await expect(readFile(join(dir, 'junk.txt'), 'utf8')).rejects.toThrow();
    }, 30_000);

    it('falls back to a full fetch when the server refuses a sha fetch', async () => {
      // A plain git daemon or an internal mirror may not allow fetching an
      // arbitrary commit. Falling back keeps the runner usable there rather
      // than pretending the shallow path is universal.
      //
      // Forced with a wrapper binary rather than `uploadpack.allowAnySHA1InWant`
      // because git's local transport serves a sha regardless of that setting
      // — a test that toggled it would pass down the fast path and never
      // touch the fallback it claims to cover.
      const wrapper = join(scratch, 'git-refusing-sha-fetch');
      await writeFile(
        wrapper,
        [
          '#!/bin/sh',
          // `fetch --quiet --depth 1 origin <sha>` — the shallow attempt only.
          'if [ "$1" = "fetch" ] && [ "$3" = "--depth" ]; then',
          '  echo "fatal: remote error: upload-pack: not our ref" >&2',
          '  exit 128',
          'fi',
          'exec git "$@"',
          '',
        ].join('\n'),
        { mode: 0o755 },
      );

      const refusing = build({ 'runners.claudeCodeLocal.gitBinary': wrapper });
      const workspace = await refusing.provision(request());

      expect(workspace.headCommit).toBe(baseCommit);
      expect(await git(workspace.dir, 'rev-parse', 'HEAD')).toBe(baseCommit);
    }, 60_000);

    it('leaves nothing behind when provisioning fails', async () => {
      // Otherwise the next attempt finds a directory, fails to confirm it, and
      // a debugging operator finds a tree that looks like a run rather than
      // like a failure.
      const doomed = { ...request(), baseCommit: 'f'.repeat(40) };

      await expect(service.provision(doomed)).rejects.toThrow(WorkspaceError);
      await expect(
        exec('test', ['-d', service.directoryFor(doomed.identity)]),
      ).rejects.toThrow();
    }, 60_000);
  });

  describe('when the execution record is already on the branch (#63)', () => {
    let staged = 0;

    /**
     * Puts a factory branch on the origin, one commit ahead of the base — the
     * exact state `WorkOrderRecordsService.write()` leaves behind.
     *
     * Returns the record commit and the base it was built on, read from a full
     * clone: the workspace itself is shallow, so it has no parent to inspect.
     */
    async function pushExecutionRecord(branch: string) {
      staged += 1;
      const staging = join(scratch, `staging-${staged}`);
      await exec('git', ['clone', '--quiet', origin, staging]);
      await git(staging, 'config', 'user.email', 'factory@opifex.local');
      await git(staging, 'config', 'user.name', 'Opifex Factory');
      await git(staging, 'checkout', '--quiet', '-b', branch, baseCommit);
      await writeFile(
        join(staging, 'work-order.json'),
        '{"identity":"probe"}\n',
      );
      await git(staging, 'add', '.');
      await git(
        staging,
        'commit',
        '-m',
        'chore(factory): record the work order',
      );
      await git(staging, 'push', '--quiet', 'origin', branch);

      return {
        commit: await git(staging, 'rev-parse', 'HEAD'),
        parent: await git(staging, 'rev-parse', 'HEAD~1'),
      };
    }

    afterEach(async () => {
      // The origin is shared across the whole file. A factory branch left
      // behind would change where every later test starts from, which is
      // exactly the pollution that made three of these fail while they were
      // being written.
      await exec('git', [
        'push',
        '--quiet',
        origin,
        '--delete',
        request().branch,
      ]).catch(() => {});
      await exec('git', [
        'push',
        '--quiet',
        origin,
        '--delete',
        'factory/99-abc1234-a1',
      ]).catch(() => {});
    });

    it('starts from the branch tip so the agent can actually push', async () => {
      // The bug this test exists for: #63 commits the execution record as the
      // branch's FIRST commit, so a workspace checked out at baseCommit is
      // behind its own remote and every push is rejected as a non-fast-forward
      // — after the whole run has been paid for. It survived both #61's and
      // #63's suites because it only appears once dispatch joins them.
      const record = await pushExecutionRecord(request().branch);
      expect(record.parent).toBe(baseCommit); // the pin is intact upstream

      const workspace = await service.provision(request());

      expect(workspace.headCommit).toBe(record.commit);
      expect(await git(workspace.dir, 'rev-parse', 'HEAD')).toBe(record.commit);
      // The record is present in the tree, which is what "at the record
      // commit" means locally — the clone is shallow, so there is no parent
      // to walk to.
      expect(
        await readFile(join(workspace.dir, 'work-order.json'), 'utf8'),
      ).toContain('probe');
    }, 60_000);

    it('leaves a push able to fast-forward', async () => {
      // The property the checkout exists to preserve, asserted end to end
      // rather than inferred from the sha. This is the assertion that would
      // have failed before the fix.
      await pushExecutionRecord(request().branch);
      const workspace = await service.provision(request());

      await writeFile(
        join(workspace.dir, 'agent-work.txt'),
        'what the agent did\n',
      );
      await git(workspace.dir, 'add', '.');
      await git(workspace.dir, 'commit', '-m', 'feat: the agent did something');

      await expect(
        git(workspace.dir, 'push', 'origin', request().branch),
      ).resolves.toBeDefined();
    }, 60_000);

    it('reuses a workspace already at the branch tip', async () => {
      // The reuse check compares HEAD against wherever provisioning WOULD put
      // it. Comparing against baseCommit unconditionally would rebuild the
      // workspace on every dispatch once the record existed.
      await pushExecutionRecord(request().branch);

      const first = await service.provision(request());
      const second = await service.provision(request());

      expect(second.reused).toBe(true);
      expect(second.headCommit).toBe(first.headCommit);
    }, 60_000);

    it('still starts from the base commit when the branch does not exist yet', async () => {
      // Writes disabled, or the records step not reached. Nothing to
      // fast-forward onto, so the pinned base is the only correct start.
      const fresh = {
        ...request(),
        branch: 'factory/99-abc1234-a1',
        identity: 'wo_acme-widgets_99_abc1234_a1',
      };

      const workspace = await service.provision(fresh);

      expect(workspace.headCommit).toBe(baseCommit);
    }, 30_000);
  });

  describe('git configuration', () => {
    it('sets a factory commit identity, so the agent can commit at all', async () => {
      // Without one `git commit` fails deep inside the agent, where the reason
      // arrives as an opaque non-zero exit.
      const workspace = await service.provision(request());

      expect(await git(workspace.dir, 'config', '--local', 'user.name')).toBe(
        'Opifex Factory',
      );
      expect(await git(workspace.dir, 'config', '--local', 'user.email')).toBe(
        'factory@opifex.local',
      );
    }, 30_000);

    it('never writes the token to disk, only the name of an env var', async () => {
      // argv is world-readable through `ps`, and a token written into
      // .git/config outlives the run in a directory the agent itself reads.
      const workspace = await service.provision(request());
      const gitConfig = await readFile(
        join(workspace.dir, '.git', 'config'),
        'utf8',
      );

      expect(gitConfig).not.toContain('ghp_fake_token_for_tests');
      expect(gitConfig).toContain(`$${GIT_TOKEN_ENV_VAR}`);
    }, 30_000);

    it('provisions anonymously when no token is configured', async () => {
      // A public repository clones without one, and pushing is the step that
      // should fail visibly — not this, refusing to start a run that might
      // never have needed a token.
      const anonymous = build({ 'github.token': undefined });
      const workspace = await anonymous.provision(request());

      expect(workspace.headCommit).toBe(baseCommit);
      const gitConfig = await readFile(
        join(workspace.dir, '.git', 'config'),
        'utf8',
      );
      expect(gitConfig).not.toContain('credential');
    }, 30_000);

    it('points the origin remote at the configured base URL', async () => {
      const workspace = await service.provision(request());
      expect(await git(workspace.dir, 'remote', 'get-url', 'origin')).toBe(
        `file://${scratch}/acme/widgets.git`,
      );
    }, 30_000);
  });

  describe('paths', () => {
    it('refuses an identity that could escape the workspace root', async () => {
      // #62's validate() already rejects these, so this is the second lock on
      // the same door — and it is the one that holds for the caller who
      // skipped the first.
      expect(() => service.directoryFor('../../etc')).toThrow(WorkspaceError);
      expect(() => service.directoryFor('wo_a/../../b')).toThrow(
        WorkspaceError,
      );
    });

    it('gives one identity one directory', () => {
      expect(service.directoryFor('wo_acme_1_abcdef0_a1')).toBe(
        join(workspaceRoot, 'wo_acme_1_abcdef0_a1'),
      );
    });
  });

  describe('dispose', () => {
    it('removes the workspace', async () => {
      const workspace = await service.provision(request());
      await service.dispose(request().identity);

      await expect(exec('test', ['-d', workspace.dir])).rejects.toThrow();
    }, 30_000);

    it('is a no-op for a workspace that never existed', async () => {
      await expect(
        service.dispose('wo_never_1_0000000_a1'),
      ).resolves.toBeUndefined();
    });
  });
});
