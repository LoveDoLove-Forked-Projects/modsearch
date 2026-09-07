import { describe, expect, it } from 'vitest';
import { grokSalvageEnvelope } from '../fixtures/index.ts';
import { searchResultSchemaJson } from '../schema.ts';
import {
  GROK_DISALLOWED_TOOLS,
  buildGrokInvocation,
  buildXSearchPrompt,
  grokAvailable,
  parseGrokOutput,
} from './grok.ts';
import { resolveEngine } from './index.ts';

describe('grok engine', () => {
  it('is registered for the social role only', () => {
    const engine = resolveEngine('grok-cli');
    expect(engine.roles).toEqual(['social']);
    expect(resolveEngine('grok').name).toBe('grok-cli');
  });

  it('builds a headless run with json output and the schema in the prompt', () => {
    const invocation = buildGrokInvocation({
      mode: 'search',
      query: 'grok build feedback',
      maxResults: 4,
      timeoutMs: 60_000,
      settings: {},
    });
    expect(invocation.command).toBe('grok');
    expect(invocation.args).toContain('--always-approve');
    expect(invocation.args).not.toContain('--json-schema');
    expect(invocation.args[invocation.args.indexOf('--output-format') + 1]).toBe('json');
    expect(invocation.args[invocation.args.indexOf('--disallowed-tools') + 1]).toBe(
      GROK_DISALLOWED_TOOLS,
    );
    const prompt = invocation.args[invocation.args.indexOf('-p') + 1];
    expect(prompt).toContain('Search X (formerly Twitter) for: grok build feedback');
    expect(prompt).toContain('up to 4 items');
    expect(prompt).toContain(searchResultSchemaJson());
    expect(prompt).toMatch(/Do not run modsearch or any other CLI or skill to search/i);
    expect(prompt).toContain('Use the built-in X search tools only.');
  });

  it('falls back to the shared default post count when none is given', () => {
    const invocation = buildGrokInvocation({
      mode: 'search',
      query: 'x',
      timeoutMs: 1000,
      settings: {},
    });
    const prompt = invocation.args[invocation.args.indexOf('-p') + 1];
    expect(prompt).toContain('up to 8 items');
  });

  it('takes its binary from engine settings', () => {
    const invocation = buildGrokInvocation({
      mode: 'search',
      query: 'x',
      timeoutMs: 1000,
      settings: { bin: '/opt/grok' },
    });
    expect(invocation.command).toBe('/opt/grok');
  });

  it('rejects page fetch', () => {
    expect(() =>
      buildGrokInvocation({ mode: 'fetch', url: 'https://e.com', timeoutMs: 1000, settings: {} }),
    ).toThrow(/does not support page fetch/);
  });

  it('needs both a binary and a signed-in state', () => {
    expect(grokAvailable('definitely-not-a-real-binary')).toBe(false);
  });

  it('instructs the x.com item mapping', () => {
    expect(buildXSearchPrompt('anything', 3)).toContain('source is "x.com"');
  });

  it('salvages the last valid object when grok validates the schema too late', () => {
    const parsed = parseGrokOutput(grokSalvageEnvelope('real'));
    expect((parsed.result as { summary: string }).summary).toBe('real');
  });

  it('prefers structuredOutput and keeps usage', () => {
    const parsed = parseGrokOutput(
      JSON.stringify({
        structuredOutput: { summary: 'ok', items: [], uncertainty: [] },
        sessionId: 'sid',
        modelUsage: { m: 1 },
      }),
    );
    expect((parsed.result as { summary: string }).summary).toBe('ok');
    expect(parsed.meta.conversationId).toBe('sid');
    expect(parsed.meta.usage).toEqual({ m: 1 });
  });

  it('throws for garbage and for nothing salvageable', () => {
    expect(() => parseGrokOutput('not json')).toThrow('Failed to parse Grok Build JSON output.');
    expect(() =>
      parseGrokOutput(JSON.stringify({ structuredOutput: null, text: 'no objects' })),
    ).toThrow('no structured result');
  });

  it('throws when the chosen result is an in-progress placeholder', () => {
    expect(() =>
      parseGrokOutput(
        JSON.stringify({
          structuredOutput: {
            summary: '正在检索…',
            items: [],
            uncertainty: ['检索进行中'],
          },
          text: '正在检索…',
          stopReason: 'end_turn',
        }),
      ),
    ).toThrow(/Grok Build stopped before searching X \(placeholder result\)/);
  });

  it('keeps a finished result with no posts, even when it mentions searching', () => {
    const parsed = parseGrokOutput(
      JSON.stringify({
        structuredOutput: null,
        text: '{"summary":"Searching X for this handle returned no posts this week.","items":[],"uncertainty":["Nothing matched the query."]}',
        stopReason: 'end_turn',
      }),
    );
    expect((parsed.result as { items: unknown[] }).items).toEqual([]);
  });

  it('salvages a trailing JSON object after prose in text', () => {
    const resultJson = {
      summary: 'This week on X, Claude Code news came from official accounts.',
      items: [
        {
          title: '@ClaudeDevs on Function Hooks',
          url: 'https://x.com/ClaudeDevs/status/2095572891941351550',
          snippet: 'Function Hooks has not shipped yet.',
          source: 'x.com',
          published_at: '2026-09-03T18:01:25Z',
        },
      ],
      uncertainty: ['Function Hooks is a preview, not GA.'],
    };
    const parsed = parseGrokOutput(
      JSON.stringify({
        structuredOutput: null,
        text: `先搜本周 X 上关于 Claude Code 的真实帖子，再按你给的 JSON 结构整理。${JSON.stringify(resultJson)}`,
        stopReason: 'end_turn',
        sessionId: '01a07db6-507d-77b1-8f09-c6a615519f89',
      }),
    );
    const result = parsed.result as typeof resultJson;
    expect(result.summary).toBe(resultJson.summary);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].url).toBe(resultJson.items[0].url);
    expect(parsed.meta.conversationId).toBe('01a07db6-507d-77b1-8f09-c6a615519f89');
  });
});
