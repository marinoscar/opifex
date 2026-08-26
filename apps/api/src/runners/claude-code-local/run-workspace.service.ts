import { Injectable, Logger } from '@nestjs/common';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { OperatorSettingsService } from '../../settings/operator-settings/operator-settings.service';
import { ChildProcessSupervisor } from '../process/child-process-supervisor';
import {
  describeFailure,
  runCommand,
  type CommandResult,
} from '../process/run-command';

/**
 * The directory a run happens in.
 *
 * ## Why the runner owns this
 *
 * A subprocess needs somewhere to work, and "somewhere" is not incidental —
 * it is where VISION §3.4's recovery model becomes real. Recovery is
 * abandon-and-re-run **from the pinned base commit**, never session
 * resumption, and that only means something if the run genuinely starts from
 * what was authorized.
 *
 * So the start point is resolved rather than assumed: the factory branch's tip
 * when #63 has already committed the execution record to it, and `baseCommit`
 * otherwise. Both are pinned — see `startPoint` for why the branch is not a
 * moving target and why checking out `baseCommit` unconditionally would make
 * every agent's push fail.
 *
 * ## Idempotency lives here
 *
 * #18's exit criterion: *"re-running the same work order is idempotent — the
 * runner checks whether its branch already exists before doing anything."*
 * The identity is content-addressed over `(repo, issue, baseCommit, attempt)`
 * (#62), so one identity means one workspace directory, and finding it already
 * present at the right commit is a reuse rather than a second clone.
 */

/** Where a token is read from inside the workspace's credential helper. */
export const GIT_TOKEN_ENV_VAR = 'OPIFEX_GIT_TOKEN';

export interface WorkspaceRequest {
  identity: string;
  repository: { owner: string; name: string };
  baseCommit: string;
  branch: string;
}

export interface ProvisionedWorkspace {
  dir: string;
  /** True when an existing workspace at the right commit was found and kept. */
  reused: boolean;
  headCommit: string;
}

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

@Injectable()
export class RunWorkspaceService {
  private readonly logger = new Logger(RunWorkspaceService.name);
  private readonly supervisor = new ChildProcessSupervisor();

  constructor(private readonly settings: OperatorSettingsService) {}

  private get root(): string {
    // Re-read per call, as before. The registry declares this key `restart`
    // anyway — changing it while runs are live orphans their workspaces where
    // nothing can find or reap them — so the per-call read is not a promise
    // that moving it is safe.
    return resolve(this.settings.get('runners.claudeCodeLocal.workspaceRoot'));
  }

  /** Absolute path for an identity, whether or not it exists yet. */
  directoryFor(identity: string): string {
    // The identity is `wo_<slug>_<issue>_<sha7>_a<n>` and #62's `validate()`
    // rejects anything that would not produce that shape — so it is already
    // filesystem-safe. Re-checked anyway, because this value becomes a path
    // and a path built from an unvalidated string is a traversal waiting for
    // the one caller that skipped validation.
    if (!/^[A-Za-z0-9_-]+$/.test(identity)) {
      throw new WorkspaceError(
        `Refusing to build a workspace path from "${identity}"`,
      );
    }
    return join(this.root, identity);
  }

  /**
   * A checkout at `baseCommit`, on `branch`, ready for the agent.
   *
   * Reuses an existing workspace that is already at the right commit. Anything
   * else — a directory at a different commit, a half-finished clone, a
   * corrupted `.git` — is removed and redone: a workspace whose state cannot
   * be confirmed is worse than no workspace, because the run would start from
   * a base nobody chose.
   */
  async provision(request: WorkspaceRequest): Promise<ProvisionedWorkspace> {
    const dir = this.directoryFor(request.identity);

    const existing = await this.inspect(dir, request);
    if (existing) {
      this.logger.log(
        `Reusing workspace for ${request.identity} at ${existing.headCommit}`,
      );
      return existing;
    }

    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });

    try {
      const headCommit = await this.clone(dir, request);
      return { dir, reused: false, headCommit };
    } catch (error) {
      // A failed provision leaves nothing behind. Otherwise the next attempt
      // finds a directory, fails to confirm it, and pays for a delete it
      // could have been spared — and a debugging operator finds a tree that
      // looks like a run rather than like a failure.
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  /** Removes a workspace. Safe to call for one that was never created. */
  async dispose(identity: string): Promise<void> {
    await rm(this.directoryFor(identity), { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------

  /**
   * Is there already a usable workspace here?
   *
   * Checks HEAD is on the expected branch AND that the branch points at the
   * base commit. Branch-name-only would accept a workspace from a previous
   * attempt that had already committed work — reusing that would silently
   * resume a run rather than re-running it, which is the one thing VISION
   * §3.4 forbids.
   */
  private async inspect(
    dir: string,
    request: WorkspaceRequest,
  ): Promise<ProvisionedWorkspace | null> {
    if (!(await this.isDirectory(dir))) return null;

    const branch = await this.git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!branch.ok || branch.stdout.trim() !== request.branch) return null;

    const head = await this.git(dir, ['rev-parse', 'HEAD']);
    if (!head.ok) return null;

    // Reusable only if HEAD is still where provisioning would put it. That is
    // the base commit for a branch that does not exist yet, and the branch tip
    // once the execution record is on it (#63) — so the check asks the remote
    // rather than assuming either.
    const expected = await this.startPoint(dir, request);
    if (head.stdout.trim() !== expected.commit) return null;

    return { dir, reused: true, headCommit: head.stdout.trim() };
  }

  private async clone(dir: string, request: WorkspaceRequest): Promise<string> {
    const url = this.remoteUrl(request.repository);

    await this.expect(
      dir,
      ['init', '--quiet', '--initial-branch=main'],
      'initialise a repository',
    );
    await this.expect(
      dir,
      ['remote', 'add', 'origin', url],
      'add the origin remote',
    );

    await this.configureCredentials(dir);
    await this.configureCommitter(dir);

    // Fetch BY SHA rather than by ref name: whichever commit `startPoint`
    // resolves to, it is fetched as a fixed object, so nothing moves under the
    // run between resolving it and checking it out.
    //
    // `--depth 1` because none of the history before the start point is part
    // of the work, and a full clone of a real repository is minutes of wall
    // clock on every attempt.
    const start = await this.startPoint(dir, request);

    const shallow = await this.git(dir, [
      'fetch',
      '--quiet',
      '--depth',
      '1',
      'origin',
      start.commit,
    ]);

    if (!shallow.ok) {
      // Fetching an arbitrary sha requires the server to allow it. GitHub
      // allows any commit reachable from a ref; a plain git daemon or a local
      // mirror may not. Falling back to a full fetch keeps this runner usable
      // against those without pretending the shallow path is universal.
      this.logger.warn(
        `Shallow fetch of ${start.commit} failed (${describeFailure(shallow)}); ` +
          'retrying as a full fetch',
      );
      await this.expect(
        dir,
        ['fetch', '--quiet', 'origin'],
        'fetch the repository',
      );
    }

    await this.expect(
      dir,
      ['checkout', '--quiet', '-b', request.branch, start.commit],
      `check out ${start.commit} as ${request.branch}`,
    );

    return start.commit;
  }

  /**
   * Where this workspace should start: the branch tip, or the base commit.
   *
   * ## Why this is not simply the base commit
   *
   * #63 writes the EXECUTION RECORD as the branch's first commit, so by the
   * time a runner is handed the work the remote branch is already one commit
   * ahead of `baseCommit`. A workspace checked out at `baseCommit` would
   * therefore be behind its own remote, and the agent's push would be rejected
   * as a non-fast-forward — after the whole run had been paid for.
   *
   * That failure only appears once dispatch actually joins #63 to #61, which
   * is why it survived both of their test suites.
   *
   * ## And why it does not weaken the pin
   *
   * Fetching a BRANCH whose tip is whatever it happens to be now would be a
   * different run from the one that was authorized. This is narrower: the
   * branch is `factory/<issue>-<sha7>-a<attempt>`, which is content-addressed
   * over the same coordinates as the identity (#62), so its only legitimate
   * contents are the execution record for THIS work order. The commit named by
   * `baseCommit` is still its parent.
   */
  private async startPoint(
    dir: string,
    request: WorkspaceRequest,
  ): Promise<{ commit: string; fromBranch: boolean }> {
    const remote = await this.git(dir, [
      'ls-remote',
      '--exit-code',
      'origin',
      request.branch,
    ]);
    if (!remote.ok) return { commit: request.baseCommit, fromBranch: false };

    const sha = remote.stdout.trim().split(/\s+/)[0];
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      // Unparseable rather than absent. Falling back to the base commit would
      // reintroduce the push rejection silently, so this says so out loud.
      this.logger.warn(
        `Could not read the tip of ${request.branch} from origin; starting from ` +
          `${request.baseCommit}, and a push may be rejected`,
      );
      return { commit: request.baseCommit, fromBranch: false };
    }

    return { commit: sha, fromBranch: true };
  }

  /**
   * A credential helper that reads the token from the environment.
   *
   * The token is never an argv element and never a literal on disk. Both
   * matter: argv is world-readable through `ps`, and a token written into
   * `.git/config` outlives the run in a directory the agent itself can read
   * and could be induced to print.
   *
   * What lands in `.git/config` is a shell snippet naming an environment
   * variable, and the value only exists in the child's environment for as
   * long as the child does.
   */
  private async configureCredentials(dir: string): Promise<void> {
    const token = this.settings.get('github.token');
    if (!token) {
      // Not fatal. A public repository clones anonymously, and pushing is the
      // step that will fail — visibly, with a git error — rather than this
      // refusing to start a run that might not have needed a token.
      this.logger.warn(
        'No GITHUB_TOKEN configured; workspace will use anonymous git access',
      );
      return;
    }

    await this.expect(
      dir,
      [
        'config',
        '--local',
        'credential.helper',
        `!f() { echo username=x-access-token; echo "password=$${GIT_TOKEN_ENV_VAR}"; }; f`,
      ],
      'configure git credentials',
    );
  }

  /**
   * An identity for commits the agent makes.
   *
   * Without one `git commit` fails outright, and it fails deep inside the
   * agent where the reason arrives as an opaque non-zero exit. The identity is
   * the FACTORY's, not any person's: VISION §5 puts attribution in the commit
   * trailers (#26), which are structured, queryable and cannot be confused
   * with a human having written the code.
   */
  private async configureCommitter(dir: string): Promise<void> {
    const name = this.settings.get('runners.claudeCodeLocal.committerName');
    const email = this.settings.get('runners.claudeCodeLocal.committerEmail');
    await this.expect(
      dir,
      ['config', '--local', 'user.name', name],
      'configure the commit author',
    );
    await this.expect(
      dir,
      ['config', '--local', 'user.email', email],
      'configure the commit email',
    );
  }

  private remoteUrl(repository: { owner: string; name: string }): string {
    const base = this.settings
      .get('runners.claudeCodeLocal.gitRemoteBaseUrl')
      .replace(/\/+$/, '');
    return `${base}/${repository.owner}/${repository.name}.git`;
  }

  private async git(cwd: string, args: string[]): Promise<CommandResult> {
    return runCommand(this.supervisor, {
      command: this.settings.get('runners.claudeCodeLocal.gitBinary'),
      args,
      cwd,
      env: {
        // Git must never open an editor, a pager, or a terminal prompt in a
        // context with no terminal. Each of those is a hang that presents as
        // a silent run, which is the failure mode VISION §9 spends the most
        // effort making visible — so it is worth not creating one here.
        GIT_TERMINAL_PROMPT: '0',
        GIT_PAGER: 'cat',
        GIT_OPTIONAL_LOCKS: '0',
        [GIT_TOKEN_ENV_VAR]: this.settings.get('github.token'),
      },
    });
  }

  private async expect(
    cwd: string,
    args: string[],
    what: string,
  ): Promise<CommandResult> {
    const result = await this.git(cwd, args);
    if (!result.ok) {
      throw new WorkspaceError(`Could not ${what}: ${describeFailure(result)}`);
    }
    return result;
  }

  private async isDirectory(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  }
}
