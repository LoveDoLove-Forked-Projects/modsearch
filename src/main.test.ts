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
