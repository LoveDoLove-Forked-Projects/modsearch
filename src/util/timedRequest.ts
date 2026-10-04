import { redactSecrets } from './redact.ts';

/**
 * One HTTP request to an engine API with its whole body read under a single
 * deadline. The signal stays armed until the body is in memory: aborting only
 * up to the response headers let a server that streams the body slowly hold
 * the run past its timeout.
 *
 * A timeout reads `<label> timed out after <ms> ms.`, which the cooldown layer
 * treats as transient. Any other transport failure reads `<label> request
 * failed: ...` with the secrets scrubbed. An error response whose body cannot
 * be read comes back with empty text, so the caller still reports the status.
 */
export async function requestText(
  label: string,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  timeoutMs: number,
  secrets: ReadonlyArray<string | undefined | null>,
): Promise<{ response: Response; text: string }> {
  const fail = (error: unknown): Error =>
    signal.aborted
      ? new Error(`${label} timed out after ${timeoutMs} ms.`)
      : new Error(
          `${label} request failed: ${redactSecrets(
            error instanceof Error ? error.message : String(error),
            secrets,
          )}`,
        );

  let response: Response;
  try {
    response = await fetch(url, { ...init, signal });
  } catch (error) {
    throw fail(error);
  }
  try {
    return { response, text: await response.text() };
  } catch (error) {
    if (!response.ok && !signal.aborted) {
      return { response, text: '' };
    }
    throw fail(error);
  }
}
