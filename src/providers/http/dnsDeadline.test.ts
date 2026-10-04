import { afterEach, describe, expect, it, vi } from 'vitest';

// A system resolver that never answers. Only the caller's deadline can end
// the wait, so these prove the DNS step sits inside the engine timeout.
vi.mock('dns/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('dns/promises')>();
  return { ...original, lookup: vi.fn(() => new Promise(() => {})) };
});

const { executeFirecrawl } = await import('../firecrawl.ts');
const { runFetch } = await import('../httpFetch.ts');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a hung DNS lookup stays inside the engine timeout', () => {
  it('firecrawl fetch times out instead of waiting on the resolver', async () => {
    const fetchCalls: unknown[] = [];
    vi.stubGlobal('fetch', async (...args: unknown[]) => {
      fetchCalls.push(args);
      throw new Error('firecrawl must not post once its time is spent');
    });
    await expect(
      executeFirecrawl({
        mode: 'fetch',
        url: 'https://slow-dns.example',
        timeoutMs: 50,
        settings: { apiKey: 'fc-test' },
      }),
    ).rejects.toThrow(/firecrawl timed out after 50 ms/);
    expect(fetchCalls).toHaveLength(0);
  });

  it('the local fetcher times out instead of waiting on the resolver', async () => {
    await expect(runFetch({ url: 'https://slow-dns.example', timeoutMs: 50 })).rejects.toThrow(
      /timed out after 50 ms/,
    );
  });
});
