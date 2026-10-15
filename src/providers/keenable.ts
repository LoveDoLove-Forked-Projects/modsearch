// Keenable (https://docs.keenable.ai). In-process fetch engine, search only,
// in the same shape as exa.ts. With no key it calls the keyless `/public`
// twin of the endpoint, which Keenable caps at 1,000 requests an hour per IP
// and which needs an `X-Keenable-Title` header naming the calling app. A key
// moves the call to the authenticated path: no hourly cap, 100,000 free
// requests a month per organization. Results are ranked pages with snippets
// and no written answer, so the summary is mechanical.
import { ApiKeyFailureError, isQuotaFailureMessage, splitApiKeys } from '../util/apiKeys.ts';
import { redactSecrets } from '../util/redact.ts';
import { requestText } from '../util/timedRequest.ts';
import { resolveEndpoint } from './endpoint.ts';
import type { EngineOutput, EngineRequest, SearchEngine } from './index.ts';

const DEFAULT_MAX_RESULTS = 10;
/** Keenable rejects max_results outside 1-50. */
const MAX_RESULTS_CEILING = 50;
const KEENABLE_DEFAULT_BASE = 'https://api.keenable.ai';
/** Required on keyless calls: how Keenable attributes anonymous traffic. */
const APP_TITLE = 'modsearch';

interface KeenableResult {
  title?: string;
  url?: string;
  description?: string;
  snippet?: string;
  published_at?: string;
}

interface KeenableResponse {
  mode?: string;
  results?: KeenableResult[];
}

export async function executeKeenableSearch(options: EngineRequest): Promise<EngineOutput> {
  if (options.mode === 'fetch') {
    throw new Error('The keenable engine does not support page fetch (-u). It searches only.');
  }
  if (!options.query) {
    throw new Error('Search mode requires a query.');
  }

  const apiKeys = splitApiKeys(options.settings.apiKey);
  const apiKey = apiKeys[0] ?? null;
  const apiKeySecrets = [...new Set([...apiKeys, ...(options.apiKeySecrets ?? [])])];
  const maxResults = Math.min(options.maxResults ?? DEFAULT_MAX_RESULTS, MAX_RESULTS_CEILING);
  const startedAt = Date.now();

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) {
    headers['x-api-key'] = apiKey;
  } else {
    headers['x-keenable-title'] = APP_TITLE;
  }
  const { response, text } = await requestText(
    'keenable',
    resolveEndpoint(
      options.settings.baseURL,
      KEENABLE_DEFAULT_BASE,
      apiKey ? '/v1/search' : '/v1/search/public',
    ),
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: options.query, max_results: maxResults }),
    },
    AbortSignal.timeout(options.timeoutMs),
    options.timeoutMs,
    [...apiKeySecrets, options.settings.baseURL],
  );

  if (!response.ok) {
    // The gateway's error body is foreign text; scrub it before it travels
    // into messages.
    const detail = redactSecrets(text.trim(), [...apiKeySecrets, options.settings.baseURL]);
    const message = `keenable returned ${response.status} ${response.statusText}.${detail ? ` ${detail}` : ''}`;
    if (response.status >= 500) {
      throw new Error(message);
    }
    if (!apiKey) {
      // The keyless pool is shared by everyone on this IP, so a 429 here is
      // not about anything the user configured.
      throw new Error(
        response.status === 429
          ? `keenable's keyless pool for this IP is used up for the hour (1,000 requests). Set a free key for your own quota: modsearch config set keenable.apiKey <key> (100,000 requests/month, https://app.keenable.ai)`
          : message,
      );
    }
    // 402 is the spent monthly allowance: the quota class the cooldown layer
    // holds for a day rather than re-hitting.
    if (response.status === 402 || isQuotaFailureMessage(detail)) {
      throw new ApiKeyFailureError(
        `keenable is out of credits (HTTP ${response.status}).${detail ? ` ${detail}` : ''} Buy credits at https://app.keenable.ai/console, wait for the monthly reset, or search with another engine.`,
      );
    }
    if (response.status === 401 || response.status === 403 || response.status === 429) {
      throw new ApiKeyFailureError(
        response.status === 429
          ? message
          : `keenable rejected the API key (${response.status}). Fix it: modsearch config set keenable.apiKey <key>${detail ? ` (${detail})` : ''}`,
      );
    }
    throw new Error(message);
  }

  const data = JSON.parse(text) as KeenableResponse;

  const items = (data.results ?? []).map((r) => {
    const item: {
      title: string;
      url: string;
      snippet: string;
      source: string | undefined;
      published_at?: string;
    } = {
      title: r.title ?? '',
      url: r.url ?? '',
      // The snippet is the page excerpt; the description is often empty.
      snippet: r.snippet || r.description || '',
      source: r.url ? safeHostname(r.url) : undefined,
    };
    if (r.published_at) {
      item.published_at = r.published_at;
    }
    return item;
  });

  const summary =
    items.length > 0
      ? `Keenable returned ${items.length} ranked result(s) for "${options.query}". Read items for the sources.`
      : '';

  return {
    result: {
      summary,
      items,
      uncertainty: items.length === 0 ? ['No results found for this query.'] : [],
      warnings: [
        'Keenable returns ranked results without an LLM summary, so the summary is mechanical: read items directly for the evidence.',
      ],
    },
    meta: {
      conversationId: null,
      durationSeconds: (Date.now() - startedAt) / 1000,
      usage: { resultCount: items.length, mode: data.mode ?? null },
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

export const keenableProvider: SearchEngine = {
  name: 'keenable',
  roles: ['search'],
  requirement:
    'nothing: search works keyless (1,000 requests/hour per IP, no signup). A free key lifts the hourly cap (100,000 requests/month)',
  // Keyless search needs nothing, so it is always available. A key only
  // changes which endpoint the call goes to.
  isAvailable: () => true,
  execute: executeKeenableSearch,
};
