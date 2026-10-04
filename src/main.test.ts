import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDirs, withTempHome } from './testing/helpers.ts';

const originalArgv = process.argv;
const originalElectronDescriptor = Object.getOwnPropertyDescriptor(process.versions, 'electron');
const originalElectronRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
const originalNested = process.env.MODSEARCH_NESTED;
let restoreHome: (() => void) | undefined;

afterEach(() => {
  process.argv = originalArgv;
  if (originalElectronRunAsNode === undefined) {
    delete process.env.ELECTRON_RUN_AS_NODE;
  } else {
    process.env.ELECTRON_RUN_AS_NODE = originalElectronRunAsNode;
  }
  if (originalNested === undefined) {
    delete process.env.MODSEARCH_NESTED;
  } else {
    process.env.MODSEARCH_NESTED = originalNested;
  }
  if (originalElectronDescriptor) {
    Object.defineProperty(process.versions, 'electron', originalElectronDescriptor);
  } else {
    Reflect.deleteProperty(process.versions, 'electron');
  }
  restoreHome?.();
  restoreHome = undefined;
  cleanupTempDirs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('CLI entry point', () => {
  it('uses Node argv layout when Electron runs as Node', async () => {
    ({ restore: restoreHome } = withTempHome());
    process.env.ELECTRON_RUN_AS_NODE = '1';
    process.argv = [
      process.execPath,
      '/package/dist/main.js',
      'doctor',
      '--json',
    ];
    Object.defineProperty(process.versions, 'electron', {
      value: '43.4.0',
      configurable: true,
    });
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`unexpected process.exit(${code})`);
    });

    await import('./main.ts');

    expect(stdout).toHaveBeenCalledOnce();
    expect(JSON.parse(String(stdout.mock.calls[0][0]))).toMatchObject({
      node: { ok: true },
      roles: expect.any(Array),
    });
  });

  it('refuses to run when spawned from inside an engine', async () => {
    process.env.MODSEARCH_NESTED = '1';
    process.argv = [process.execPath, '/package/dist/main.js', 'doctor', '--json'];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    await expect(import('./main.ts')).rejects.toThrow(/process\.exit\(1\)/);
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(stderr.mock.calls.map((call) => call[0]).join(''))).toContain(
      'modsearch refused to run: it was started from inside an engine that modsearch itself spawned (recursion guard).',
    );
  });
});

describe('search flags', () => {
  async function runCli(args: string[]) {
    const runSearch = vi.fn(async () => ({ mode: 'search', results: [], meta: {} }));
    vi.doMock('./search.ts', () => ({ runSearch }));
    ({ restore: restoreHome } = withTempHome());
    process.argv = [process.execPath, '/package/dist/main.js', ...args];
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await import('./main.ts');
    await vi.waitFor(() => {
      expect(runSearch.mock.calls.length + stderr.mock.calls.length).toBeGreaterThan(0);
    });
    return { runSearch, stderr, exit };
  }

  afterEach(() => {
    vi.doUnmock('./search.ts');
    process.exitCode = undefined;
  });

  it('passes --deadline through as the run-wide budget', async () => {
    const { runSearch } = await runCli([
      '-q',
      'anything',
      '--timeout',
      '40000',
      '--deadline',
      '55000',
    ]);
    // The clock starts at process start: a slow Node boot spends the same
    // budget the caller is holding.
    expect(runSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 40_000,
        deadlineMs: 55_000,
        deadlineStartedAt: performance.timeOrigin,
      }),
    );
  });

  it('leaves the run uncapped without --deadline', async () => {
    const { runSearch } = await runCli(['-q', 'anything']);
    expect(runSearch).toHaveBeenCalledWith(expect.objectContaining({ deadlineMs: undefined }));
  });

  it('rejects a --deadline that is not a positive integer', async () => {
    const { runSearch, stderr, exit } = await runCli(['-q', 'anything', '--deadline', '0']);
    // A failed run sets the exit code and lets the event loop drain rather
    // than exiting on the spot, which would cancel a pending SIGKILL for an
    // engine that ignored SIGTERM.
    expect(process.exitCode).toBe(1);
    expect(exit).not.toHaveBeenCalled();
    expect(runSearch).not.toHaveBeenCalled();
    expect(String(stderr.mock.calls.map((call) => call[0]).join(''))).toContain(
      'Invalid --deadline',
    );
  });
});
