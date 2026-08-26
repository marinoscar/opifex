import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChildProcessSupervisor } from './child-process-supervisor';
import { extractVersion, probeBinaryVersion } from './probe-version';

/**
 * Against real binaries, for the reason `child-process-supervisor.spec.ts`
 * gives: what this module claims — that a missing binary is reported rather
 * than thrown, that a non-zero exit is a failure, that exit 0 with no output
 * is not a version — are properties of spawning a process, and a mocked
 * `spawn` would assert only that we believe our own arguments.
 *
 * The fixtures are shell scripts written into a temp directory, so the suite
 * depends on nothing that is not already required to run it.
 */
describe('probeBinaryVersion (#338)', () => {
  const supervisor = new ChildProcessSupervisor();
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'opifex-probe-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** An executable script at a known path. Returns the path. */
  async function script(name: string, body: string): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, `#!/bin/sh\n${body}\n`, 'utf8');
    await chmod(path, 0o755);
    return path;
  }

  it('reports the version a successful probe printed', async () => {
    const binary = await script('claude', 'echo "2.1.240 (Claude Code)"');

    const result = await probeBinaryVersion(supervisor, binary);

    expect(result.ok).toBe(true);
    expect(result.version).toBe('2.1.240');
    expect(result.detail).toContain('2.1.240');
  });

  it('finds the number in the middle of a line, as git prints it', async () => {
    const binary = await script('git', 'echo "git version 2.43.0"');

    const result = await probeBinaryVersion(supervisor, binary);

    expect(result).toMatchObject({ ok: true, version: '2.43.0' });
  });

  it('passes --version and nothing else', async () => {
    // The argv is the whole contract with the binary. A probe that also sent,
    // say, a `--json` flag would fail against every tool that does not have
    // one, and the failure would look like a missing binary.
    const binary = await script('args', 'echo "1.0.0"; echo "argv=$*" >&2');

    const result = await probeBinaryVersion(supervisor, binary);

    expect(result.ok).toBe(true);
  });

  it('reports a missing binary rather than throwing', async () => {
    const result = await probeBinaryVersion(
      supervisor,
      join(dir, 'does-not-exist'),
    );

    expect(result.ok).toBe(false);
    expect(result.version).toBeNull();
    expect(result.detail).toContain('could not start');
  });

  it('reports a non-zero exit with the last line of stderr', async () => {
    // The whole reason `describeFailure` prefers stderr to the exit code: an
    // operator reading the message can act on it.
    const binary = await script(
      'broken',
      'echo "claude: command not found" >&2; exit 127',
    );

    const result = await probeBinaryVersion(supervisor, binary);

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('exit 127');
    expect(result.detail).toContain('command not found');
  });

  it('refuses exit 0 with no output rather than reporting an empty version', async () => {
    const binary = await script('silent', 'exit 0');

    const result = await probeBinaryVersion(supervisor, binary);

    expect(result.ok).toBe(false);
    expect(result.version).toBeNull();
    expect(result.detail).toContain('printed nothing');
  });

  it('refuses an unconfigured binary without spawning anything', async () => {
    const start = jest.spyOn(supervisor, 'start');

    const result = await probeBinaryVersion(supervisor, '   ');

    expect(result).toEqual({
      ok: false,
      version: null,
      detail: 'No binary is configured.',
    });
    expect(start).not.toHaveBeenCalled();
    start.mockRestore();
  });

  it('hands the child the environment it was given', async () => {
    // The `claude-credential` probe depends on this: it supplies the token the
    // operator just saved, which is not in the API process's own environment.
    const binary = await script('env', 'echo "9.9.9 token=$PROBE_TOKEN"');

    const result = await probeBinaryVersion(supervisor, binary, {
      env: { PROBE_TOKEN: 'seen' },
    });

    expect(result.ok).toBe(true);
    expect(result.detail).toContain('9.9.9');
  });

  describe('extractVersion', () => {
    it('keeps a prerelease suffix, which a bisect needs', () => {
      expect(extractVersion('3.0.0-beta.2 (Claude Code)')).toBe('3.0.0-beta.2');
    });

    it('falls back to the whole line when there is no semver in it', () => {
      expect(extractVersion('  weird-build  ')).toBe('weird-build');
    });

    it('returns null for nothing at all', () => {
      expect(extractVersion('   \n ')).toBeNull();
    });
  });
});
