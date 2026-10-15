import { afterEach, describe, expect, it, vi } from 'vitest';
import { isApiKeyFailure } from '../util/apiKeys.ts';
import { resolveEngine } from './index.ts';
import { executeKeenableSearch } from './keenable.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Mock the global fetch with a JSON response, capturing the request. */
function mockFetchJson(body: unknown, init: { status?: number; text?: string } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const status = init.status ?? 200;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, requestInit: RequestInit) => {
      calls.push({ url, init: requestInit });
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? 'OK' : 'Error',
        text: async () => init.text ?? JSON.stringify(body),
      } as unknown as Response;
    }),
  );
  return calls;
}

function search(settings: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
  return executeKeenableSearch({
    mode: 'search',
    query: 'node 24 lts',
    timeoutMs: 1000,
    settings,
    ...extra,
  });
}

describe('keenable provider', () => {
  it('is a search engine that needs no setup', () => {
    const engine = resolveEngine('keenable');
    expect(engine.name).toBe('keenable');
    expect(engine.roles).toEqual(['search']);
    expect(engine.isAvailable({}, {}, 'search')).toBe(true);
    expect(engine.execute).toBeTypeOf('function');
  });

  it('rejects fetch mode', async () => {
    await expect(
      executeKeenableSearch({
        mode: 'fetch',
        url: 'https://example.com',
        timeoutMs: 1000,
        settings: {},
      }),
    ).rejects.toThrow(/does not support page fetch/);
  });

  it('calls the keyless endpoint with the app identifier when no key is set', async () => {
    const calls = mockFetchJson({ results: [] });
    await search({}, { maxResults: 5 });
    expect(calls[0].url).toBe('https://api.keenable.ai/v1/search/public');
    expect(calls[0].init.method).toBe('POST');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['x-keenable-title']).toBe('modsearch');
    expect(headers['x-api-key']).toBeUndefined();
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      query: 'node 24 lts',
      max_results: 5,
    });
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it('calls the keyed endpoint with only the first configured key', async () => {
    const calls = mockFetchJson({ results: [] });
    await search({ apiKey: 'keen_one, keen_two' });
    expect(calls[0].url).toBe('https://api.keenable.ai/v1/search');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('keen_one');
    expect(headers['x-keenable-title']).toBeUndefined();
  });

  it('posts to a configured baseURL', async () => {
    const calls = mockFetchJson({ results: [] });
    await search({ baseURL: 'https://gateway.example/keen/' });
    expect(calls[0].url).toBe('https://gateway.example/keen/v1/search/public');
  });

  it('defaults to 10 results and caps at the API ceiling of 50', async () => {
    const calls = mockFetchJson({ results: [] });
    await search();
    await search({}, { maxResults: 200 });
    expect(JSON.parse(calls[0].init.body as string).max_results).toBe(10);
    expect(JSON.parse(calls[1].init.body as string).max_results).toBe(50);
  });

  it('maps results into the search contract with a mechanical summary', async () => {
    mockFetchJson({
      query: 'node 24 lts',
      mode: 'pro',
      results: [
        {
          title: 'Node.js 24 LTS',
          url: 'https://releaserun.com/versions/nodejs/24',
          description: '',
          snippet: 'Node.js 24 entered LTS in October 2025.',
          published_at: '2025-05-06T00:00:00Z',
          acquired_at: '2026-07-15T01:02:21Z',
        },
        {
          title: 'Release notes',
          url: 'https://docs.example/notes',
          description: 'Short summary',
        },
      ],
    });
    const output = await search();
    const result = output.result as {
      summary: string;
      items: Array<Record<string, unknown>>;
      uncertainty: string[];
      warnings: string[];
    };
    expect(result.items).toEqual([
      {
        title: 'Node.js 24 LTS',
        url: 'https://releaserun.com/versions/nodejs/24',
        snippet: 'Node.js 24 entered LTS in October 2025.',
        source: 'releaserun.com',
        published_at: '2025-05-06T00:00:00Z',
      },
      {
        title: 'Release notes',
        url: 'https://docs.example/notes',
        snippet: 'Short summary',
        source: 'docs.example',
      },
    ]);
    expect(result.summary).toMatch(/Keenable returned 2 ranked result/);
    expect(result.uncertainty).toEqual([]);
    expect(result.warnings.join(' ')).toMatch(/mechanical/);
    expect(output.meta.usage).toEqual({ resultCount: 2, mode: 'pro' });
  });

  it('reports an empty result set as uncertainty', async () => {
    mockFetchJson({ results: [] });
    const result = (await search()).result as { summary: string; uncertainty: string[] };
    expect(result.summary).toBe('');
    expect(result.uncertainty).toEqual(['No results found for this query.']);
  });

  it('explains a spent keyless pool without blaming a key', async () => {
    mockFetchJson({}, { status: 429, text: '{"error":"Too Many Requests"}' });
    const error = await search().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(isApiKeyFailure(error)).toBe(false);
    expect((error as Error).message).toMatch(/keyless pool.*config set keenable\.apiKey/s);
  });

  it('treats 401 with a key as a key problem with a config-set fix', async () => {
    mockFetchJson({}, { status: 401, text: '{"error":"Invalid API key"}' });
    const error = await search({ apiKey: 'keen_bad' }).catch((caught: unknown) => caught);
    expect(isApiKeyFailure(error)).toBe(true);
    expect((error as Error).message).toMatch(/rejected the API key \(401\).*config set keenable/);
  });

  it('reads 402 as the spent monthly allowance', async () => {
    mockFetchJson({}, { status: 402, text: '{"error":"No credits available"}' });
    const error = await search({ apiKey: 'keen_ok' }).catch((caught: unknown) => caught);
    expect(isApiKeyFailure(error)).toBe(true);
    expect((error as Error).message).toMatch(/out of credits \(HTTP 402\)/);
  });

  it('redacts every configured key from an echoed error body', async () => {
    mockFetchJson({}, { status: 403, text: 'key keen_one and keen_two are revoked' });
    const error = await search({ apiKey: 'keen_one,keen_two' }).catch((caught: unknown) => caught);
    const message = (error as Error).message;
    expect(message).not.toContain('keen_one');
    expect(message).not.toContain('keen_two');
  });

  it('keeps a server error retryable rather than a key failure', async () => {
    mockFetchJson({}, { status: 500, text: '{"error":"Internal server error"}' });
    const error = await search({ apiKey: 'keen_ok' }).catch((caught: unknown) => caught);
    expect(isApiKeyFailure(error)).toBe(false);
    expect((error as Error).message).toMatch(/keenable returned 500/);
  });
});
