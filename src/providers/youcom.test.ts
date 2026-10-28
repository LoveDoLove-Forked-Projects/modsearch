import { afterEach, describe, expect, it, vi } from 'vitest';
import { isApiKeyFailure } from '../util/apiKeys.ts';
import { resolveEngine } from './index.ts';
import { executeYoucomSearch } from './youcom.ts';

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

function search(extra: Record<string, unknown> = {}) {
  return executeYoucomSearch({
    mode: 'search',
    query: 'node 24 lts',
    timeoutMs: 1000,
    settings: {},
    ...extra,
  });
}

describe('youcom provider', () => {
  it('is a search engine that needs no setup', () => {
    const engine = resolveEngine('youcom');
    expect(engine.name).toBe('youcom');
    expect(engine.roles).toEqual(['search']);
    expect(engine.isAvailable({}, {}, 'search')).toBe(true);
    expect(engine.execute).toBeTypeOf('function');
  });

  it('rejects fetch mode', async () => {
    await expect(
      executeYoucomSearch({
        mode: 'fetch',
        url: 'https://example.com',
        timeoutMs: 1000,
        settings: {},
      }),
    ).rejects.toThrow(/does not support page fetch/);
  });

  it('calls the keyless endpoint with the query and count', async () => {
    const calls = mockFetchJson({ results: { web: [] } });
    await search({ maxResults: 5 });
    const url = new URL(calls[0].url);
    expect(`${url.origin}${url.pathname}`).toBe('https://api.you.com/v1/agents/search');
    expect(url.searchParams.get('query')).toBe('node 24 lts');
    expect(url.searchParams.get('count')).toBe('5');
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it('defaults to 10 results and caps at the keyless ceiling of 50', async () => {
    const calls = mockFetchJson({ results: { web: [] } });
    await search();
    await search({ maxResults: 200 });
    expect(new URL(calls[0].url).searchParams.get('count')).toBe('10');
    expect(new URL(calls[1].url).searchParams.get('count')).toBe('50');
  });

  it('maps web results into the search contract with a mechanical summary', async () => {
    mockFetchJson({
      results: {
        web: [
          {
            url: 'https://nodejs.org/en/about/previous-releases',
            title: 'Node.js Releases',
            description: 'Major Node.js versions enter Current release status.',
            snippets: ['Node.js 24 entered LTS in October 2025.', 'Second excerpt.'],
            page_age: '2026-10-26T09:57:39',
            favicon_url: 'https://you.com/favicon?domain=nodejs.org',
          },
          {
            url: 'https://docs.example/notes',
            title: 'Release notes',
            description: 'Short summary',
          },
        ],
      },
      metadata: { latency: 0.4 },
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
        title: 'Node.js Releases',
        url: 'https://nodejs.org/en/about/previous-releases',
        snippet: 'Node.js 24 entered LTS in October 2025.',
        source: 'nodejs.org',
        published_at: '2026-10-26T09:57:39',
      },
      {
        title: 'Release notes',
        url: 'https://docs.example/notes',
        snippet: 'Short summary',
        source: 'docs.example',
      },
    ]);
    expect(result.summary).toMatch(/You\.com returned 2 ranked result/);
    expect(result.uncertainty).toEqual([]);
    expect(result.warnings.join(' ')).toMatch(/mechanical/);
    expect(output.meta.usage).toEqual({ resultCount: 2 });
  });

  it('reports an empty result set as uncertainty', async () => {
    mockFetchJson({ results: { web: [] } });
    const result = (await search()).result as { summary: string; uncertainty: string[] };
    expect(result.summary).toBe('');
    expect(result.uncertainty).toEqual(['No results found for this query.']);
  });

  it('explains a spent daily allowance without blaming a key or cooling the engine', async () => {
    mockFetchJson({}, { status: 429, text: '{"detail":"Too Many Requests"}' });
    const error = await search().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(isApiKeyFailure(error)).toBe(false);
    expect((error as Error).message).toMatch(/keyless allowance for this IP is used up/);
  });

  it('keeps a server error a plain retryable failure', async () => {
    mockFetchJson({}, { status: 500, text: '{"detail":"Internal server error"}' });
    const error = await search().catch((caught: unknown) => caught);
    expect(isApiKeyFailure(error)).toBe(false);
    expect((error as Error).message).toMatch(/youcom returned 500/);
  });
});
