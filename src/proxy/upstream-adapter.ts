/**
 * UpstreamAdapter — abstract interface for all upstream API backends.
 *
 * Both the existing CodexApi and new API-key-based adapters (OpenAI,
 * Anthropic) implement this interface so the proxy handler can
 * treat them uniformly.
 */

import type { CodexResponsesRequest, CodexSSEEvent } from "./codex-types.js";

export interface UpstreamRoutingInfo {
  model?: string | null;
  accountId?: string | null;
  accountEmail?: string | null;
}

export interface UpstreamAdapter {
  /** Short identifier used in logs (e.g. "codex", "openai", "anthropic"). */
  readonly tag: string;
  /**
   * Send a Codex-format request to the upstream API.
   * Returns a raw HTTP Response whose body is an SSE stream.
   * Throws on HTTP error (non-2xx).
   */
  createResponse(
    req: CodexResponsesRequest,
    signal: AbortSignal,
  ): Promise<Response>;
  /**
   * Optional retry hint for adapters that can switch credentials/accounts
   * after an HTTP 200 response produced no model output.
   */
  recordEmptyResponse?(): void;
  /** Optional hook to clear retry hints after a response produced content. */
  recordSuccessfulResponse?(): void;
  /** Optional diagnostic hook describing the last concrete upstream route. */
  getRoutingInfo?(): UpstreamRoutingInfo;
  /**
   * Parse the upstream SSE response into a stream of Codex-normalized events.
   * Each adapter normalizes its native event format to CodexSSEEvent.
   */
  parseStream(response: Response): AsyncGenerator<CodexSSEEvent>;
}
