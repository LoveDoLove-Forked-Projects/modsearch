// You.com (https://you.com/docs). In-process fetch engine, search only, in the
// same shape as keenable.ts. It calls the keyless agents endpoint, which You.com
// caps at 100 searches a day per IP and which takes no key and no signup. The
// keyed index endpoint is not wired in yet: its request shape could not be
// verified without a key. Results are ranked pages with snippets and no
// written answer, so the summary is mechanical.
import { requestText } from '../util/timedRequest.ts';
import type { EngineOutput, EngineRequest, SearchEngine } from './index.ts';

const DEFAULT_MAX_RESULTS = 10;
/** The keyless endpoint answers a count above 50 with 402 Payment Required. */
const MAX_RESULTS_CEILING = 50;
const YOUCOM_KEYLESS_ENDPOINT = 'https://api.you.com/v1/agents/search';

interface YoucomWebResult {
  url?: string;
  title?: string;
  description?: string;
  snippets?: string[];
  page_age?: string;
}

interface YoucomResponse {
  results?: { web?: YoucomWebResult[] };
}

export async function executeYoucomSearch(options: EngineRequest): Promise<EngineOutput> {
  if (options.mode === 'fetch') {
    throw new Error('The youcom engine does not support page fetch (-u). It searches only.');
  }
  if (!options.query) {
    throw new Error('Search mode requires a query.');
  }

  const maxResults = Math.min(options.maxResults ?? DEFAULT_MAX_RESULTS, MAX_RESULTS_CEILING);
  const startedAt = Date.now();

  const url = new URL(YOUCOM_KEYLESS_ENDPOINT);
  url.searchParams.set('query', options.query);
  url.searchParams.set('count', String(maxResults));
  const { response, text } = await requestText(
    'youcom',
    url.toString(),
    { method: 'GET', headers: { accept: 'application/json' } },
    AbortSignal.timeout(options.timeoutMs),
    options.timeoutMs,
    [],
  );

  if (!response.ok) {
    const detail = text.trim();
    // The keyless pool is shared by everyone on this IP, so a 429 here is not
    // about anything the user configured. It resets daily, and the next run
    // simply fails over again, so it stays out of the quota cooldown.
    if (response.status === 429) {
      throw new Error(
        "youcom's keyless allowance for this IP is used up for the day (100 searches). Search continues with the next engine.",
      );
    }
    throw new Error(
      `youcom returned ${response.status} ${response.statusText}.${detail ? ` ${detail}` : ''}`,
    );
  }

  const data = JSON.parse(text) as YoucomResponse;

  const items = (data.results?.web ?? []).map((r) => {
    const item: {
      title: string;
      url: string;
      snippet: string;
      source: string | undefined;
      published_at?: string;
    } = {
      title: r.title ?? '',
      url: r.url ?? '',
      // The first snippet is the excerpt matched to the query; the
      // description is the page's own blurb.
      snippet: r.snippets?.[0] || r.description || '',
      source: r.url ? safeHostname(r.url) : undefined,
    };
    if (r.page_age) {
      item.published_at = r.page_age;
    }
    return item;
  });

  const summary =
    items.length > 0
      ? `You.com returned ${items.length} ranked result(s) for "${options.query}". Read items for the sources.`
      : '';

  return {
    result: {
      summary,
      items,
      uncertainty: items.length === 0 ? ['No results found for this query.'] : [],
      warnings: [
        'You.com returns ranked results without an LLM summary, so the summary is mechanical: read items directly for the evidence.',
      ],
    },
    meta: {
      conversationId: null,
      durationSeconds: (Date.now() - startedAt) / 1000,
      usage: { resultCount: items.length },
    },
  };
}

function safeHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

export const youcomProvider: SearchEngine = {
  name: 'youcom',
  roles: ['search'],
  requirement: 'nothing: search works keyless (100 searches/day per IP, no signup)',
  isAvailable: () => true,
  execute: executeYoucomSearch,
};
