import * as fs from 'fs';
import { execFileSync } from 'child_process';
import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { runCommand, waitForPendingKills } from './subprocess.ts';
import { cleanupTempDirs, SPAWNS_FAKE_CLI, tempDir } from './testing/helpers.ts';

afterAll(cleanupTempDirs);

/** Poll `check` until it returns true or the deadline passes. */
async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

// Unix-only: this spawns a POSIX shell script and drives SIGTERM-then-SIGKILL
// escalation. On Windows child.kill always calls TerminateProcess (there is no
// ignorable SIGTERM to escalate from) and a shell script is not a runnable image.
describe.runIf(SPAWNS_FAKE_CLI)('runCommand timeout handling', () => {
  it('SIGKILLs a child that ignores SIGTERM, so its PID goes away', async () => {
    const dir = tempDir('modsearch-sigkill-');
    const pidFile = path.join(dir, 'pid');
    const bin = path.join(dir, 'stubborn');
    // Install the SIGTERM-ignoring trap BEFORE anything else, so a SIGTERM that
    // races the startup cannot kill the child on the default handler. Then it
    // records its PID and sits there: only SIGKILL can end it.
    fs.writeFileSync(bin, `#!/bin/sh\ntrap '' TERM\necho $$ > "${pidFile}"\nsleep 30\n`, {
      mode: 0o755,
    });

    // A comfortably long timeout so the child is certain to spawn and write its
    // PID before SIGKILL lands (timeout + 2s grace). Under the full parallel
    // suite a busy machine can be slow to schedule the new process, and a tight
    // timeout would SIGKILL it before it ever ran.
    const promise = runCommand('stubborn', { command: bin, args: [], cwd: dir }, 3_000);
    await expect(promise).rejects.toThrow(/timed out/);

    // The child wrote its PID at startup (before the SIGTERM-ignoring trap even
    // matters). Wait for it to land on disk.
    await waitFor(() => {
      try {
        return fs.readFileSync(pidFile, 'utf-8').trim().length > 0;
      } catch {
        return false;
      }
    }, 15_000);
    const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    expect(Number.isFinite(pid)).toBe(true);

    // SIGKILL follows the ignored SIGTERM after the 2s grace: the PID must
    // vanish. The window is wide so scheduling jitter under load cannot flake it.
    expect(await waitFor(() => processGone(pid), 20_000)).toBe(true);
  }, 45_000);
});

describe.runIf(SPAWNS_FAKE_CLI)('runCommand kill escalation outlives the caller', () => {
  it('still SIGKILLs a SIGTERM-ignoring child when the caller has nothing left to do', async () => {
    // A caller that times the engine out and then simply ends, as the CLI does
    // after reporting a failed run. A SIGKILL timer that does not hold the
    // event loop would die with the caller and leave the child running.
    const dir = tempDir('modsearch-orphan-');
    const pidFile = path.join(dir, 'pid');
    const bin = path.join(dir, 'stubborn');
    fs.writeFileSync(bin, `#!/bin/sh\ntrap '' TERM\necho $$ > "${pidFile}"\nsleep 30\n`, {
      mode: 0o755,
    });
    const script = path.join(dir, 'caller.mjs');
    const subprocessUrl = new URL('./subprocess.ts', import.meta.url).href;
    fs.writeFileSync(
      script,
      [
        `import { runCommand } from ${JSON.stringify(subprocessUrl)};`,
        `await runCommand('stubborn', { command: ${JSON.stringify(bin)}, args: [], cwd: ${JSON.stringify(dir)} }, 3000).catch(() => {});`,
      ].join('\n'),
    );

    execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', script], {
      timeout: 20_000,
    });

    const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    expect(Number.isFinite(pid)).toBe(true);
    expect(await waitFor(() => processGone(pid), 10_000)).toBe(true);
  }, 30_000);
});

describe.runIf(SPAWNS_FAKE_CLI)('runCommand pending kills', () => {
  it('arms no kill for an engine that already exited while its pipe drains', async () => {
    // The engine exits at once, but a descendant keeps stdout open, so the run
    // is still draining when the 200ms timeout lands. The engine is gone:
    // there is nothing to escalate, and nothing should hold the caller.
    // The descendant keeps writing, so the drain window never closes and the
    // timeout lands after the engine itself is long gone.
    const dir = tempDir('modsearch-exited-');
    const bin = path.join(dir, 'exited');
    fs.writeFileSync(
      bin,
      '#!/bin/sh\n(for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do echo x; sleep 0.1; done) &\nexit 0\n',
      { mode: 0o755 },
    );
    await expect(runCommand('exited', { command: bin, args: [], cwd: dir }, 1_000)).rejects.toThrow(
      /timed out/,
    );
    const startedAt = Date.now();
    await waitForPendingKills();
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it('lets a caller wait until a SIGTERM-ignoring child is SIGKILLed', async () => {
    const dir = tempDir('modsearch-pending-kill-');
    const pidFile = path.join(dir, 'pid');
    const bin = path.join(dir, 'stubborn');
    fs.writeFileSync(bin, `#!/bin/sh\ntrap '' TERM\necho $$ > "${pidFile}"\nsleep 30\n`, {
      mode: 0o755,
    });
    // Long enough for the child to install its trap and write its PID before
    // the SIGTERM lands, even on a loaded machine.
    await expect(
      runCommand('stubborn', { command: bin, args: [], cwd: dir }, 3_000),
    ).rejects.toThrow(/timed out/);
    await waitForPendingKills();
    const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    expect(await waitFor(() => processGone(pid), 2_000)).toBe(true);
  }, 20_000);
});

describe.runIf(SPAWNS_FAKE_CLI)('runCommand child environment', () => {
  it('sets MODSEARCH_NESTED=1 on the child and keeps inherited env', async () => {
    const dir = tempDir('modsearch-nested-env-');
    const bin = path.join(dir, 'echo-env');
    fs.writeFileSync(
      bin,
      '#!/bin/sh\nprintf "NESTED=%s\\nSENTINEL=%s\\n" "$MODSEARCH_NESTED" "$MODSEARCH_TEST_SENTINEL"\n',
      { mode: 0o755 },
    );
    const previous = process.env.MODSEARCH_TEST_SENTINEL;
    process.env.MODSEARCH_TEST_SENTINEL = 'keep-me';
    try {
      const result = await runCommand('echo-env', { command: bin, args: [], cwd: dir }, 5_000);
      expect(result.stdout).toContain('NESTED=1');
      expect(result.stdout).toContain('SENTINEL=keep-me');
    } finally {
      if (previous === undefined) {
        delete process.env.MODSEARCH_TEST_SENTINEL;
      } else {
        process.env.MODSEARCH_TEST_SENTINEL = previous;
      }
    }
  });
});
