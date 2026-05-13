import { randomUUID } from "crypto";
import type { GeminiAccountEntry } from "../auth/gemini-types.js";
import type { UpstreamAdapter, UpstreamRoutingInfo } from "./upstream-adapter.js";
import type { CodexResponsesRequest, CodexSSEEvent } from "./codex-types.js";
import { CodexApiError } from "./codex-types.js";
import { parseSSEStream } from "./codex-sse.js";
import {
  extractCodeAssistUsage,
  translateCodexToCodeAssistRequest,
} from "../translation/codex-request-to-code-assist.js";
import { unwrapCodeAssistResponse } from "../translation/code-assist-to-codex.js";

type MaybePromise<T> = T | Promise<T>;

export interface GeminiCodeAssistAttemptEvent {
  accountId: string;
  email: string;
  model: string;
  status: number;
  durationMs: number;
  outcome: "success" | "http_error";
}

export interface GeminiCodeAssistFailureEvent {
  accountId: string;
  email: string;
  model: string;
  status: number;
  body: string;
}

export interface GeminiCodeAssistRateLimitEvent extends GeminiCodeAssistFailureEvent {
  retryAfterMs: number;
}

export interface GeminiCodeAssistOptions {
  account: GeminiAccountEntry;
  endpoint: string;
  apiVersion: string;
  rateLimitBackoffMs?: number;
  ensureFreshAccount?: (accountId: string) => Promise<GeminiAccountEntry>;
  pickFallbackAccount?: (
    model: string,
    attemptedAccountIds: ReadonlySet<string>,
  ) => GeminiAccountEntry | undefined;
  onUsage?: (
    accountId: string,
    model: string,
    usage: { input_tokens: number; output_tokens: number },
  ) => void;
  onAttempt?: (event: GeminiCodeAssistAttemptEvent) => MaybePromise<void>;
  onRequestFailure?: (event: GeminiCodeAssistFailureEvent) => MaybePromise<void>;
  onRateLimit?: (event: GeminiCodeAssistRateLimitEvent) => MaybePromise<void>;
}

export class GeminiCodeAssistUpstream implements UpstreamAdapter {
  readonly tag = "gemini-oauth" as const;
  private currentModel: string | null = null;
  private currentAccountId: string | null = null;
  private currentAccountEmail: string | null = null;
  private readonly emptyResponseAccountIds = new Set<string>();

  constructor(private readonly options: GeminiCodeAssistOptions) {}

  async createResponse(req: CodexResponsesRequest, signal: AbortSignal): Promise<Response> {
    this.currentModel = req.model;
    const attemptedAccountIds = new Set(this.emptyResponseAccountIds);
    let account = await this.resolveInitialAccount(req.model, attemptedAccountIds);

    for (;;) {
      attemptedAccountIds.add(account.id);
      this.currentAccountId = account.id;
      this.currentAccountEmail = account.email;

      const url = `${this.options.endpoint.replace(/\/+$/, "")}/${this.options.apiVersion}:streamGenerateContent?alt=sse`;
      const body = translateCodexToCodeAssistRequest(req, {
        projectId: account.projectId,
        sessionId: `llm-proxy-${account.id}`,
        userPromptId: randomUUID(),
      });
      const startedAt = Date.now();

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Authorization: `${account.tokenType || "Bearer"} ${account.accessToken}`,
        },
        body: JSON.stringify(body),
        signal,
      });
      const durationMs = Date.now() - startedAt;

      if (response.ok) {
        await this.options.onAttempt?.({
          accountId: account.id,
          email: account.email,
          model: req.model,
          status: response.status,
          durationMs,
          outcome: "success",
        });
        return response;
      }

      const text = await response.text().catch(() => `HTTP ${response.status}`);
      await this.options.onAttempt?.({
        accountId: account.id,
        email: account.email,
        model: req.model,
        status: response.status,
        durationMs,
        outcome: "http_error",
      });
      const failureEvent = {
        accountId: account.id,
        email: account.email,
        model: req.model,
        status: response.status,
        body: text,
      };
      await this.options.onRequestFailure?.(failureEvent);
      if (response.status === 429) {
        await this.options.onRateLimit?.({
          ...failureEvent,
          retryAfterMs: parseRetryAfterMs(
            response.headers.get("retry-after"),
            text,
            this.options.rateLimitBackoffMs ?? 60_000,
          ),
        });
      }
      if (response.status === 429 && this.options.pickFallbackAccount) {
        const fallback = this.options.pickFallbackAccount(req.model, attemptedAccountIds);
        if (fallback && !attemptedAccountIds.has(fallback.id)) {
          account = await this.resolveFreshAccount(fallback);
          continue;
        }
      }
      throw new CodexApiError(response.status, text);
    }
  }

  recordEmptyResponse(): void {
    if (this.currentAccountId) {
      this.emptyResponseAccountIds.add(this.currentAccountId);
    }
  }

  recordSuccessfulResponse(): void {
    this.emptyResponseAccountIds.clear();
  }

  getRoutingInfo(): UpstreamRoutingInfo {
    return {
      model: this.currentModel,
      accountId: this.currentAccountId,
      accountEmail: this.currentAccountEmail,
    };
  }

  private async resolveInitialAccount(
    model: string,
    attemptedAccountIds: ReadonlySet<string>,
  ): Promise<GeminiAccountEntry> {
    const initialAccount = this.options.account;
    if (
      !attemptedAccountIds.has(initialAccount.id) &&
      accountSupportsRequestedModel(initialAccount, model)
    ) {
      return this.resolveFreshAccount(initialAccount);
    }

    const fallback = this.options.pickFallbackAccount?.(model, attemptedAccountIds);
    if (fallback && !attemptedAccountIds.has(fallback.id)) {
      return this.resolveFreshAccount(fallback);
    }

    return this.resolveFreshAccount(initialAccount);
  }

  private async resolveFreshAccount(account: GeminiAccountEntry): Promise<GeminiAccountEntry> {
    return this.options.ensureFreshAccount
      ? this.options.ensureFreshAccount(account.id)
      : account;
  }

  async *parseStream(response: Response): AsyncGenerator<CodexSSEEvent> {
    const responseId = `gemini-oauth-${randomUUID().slice(0, 8)}`;
    let sentCreated = false;
    let inputTokens = 0;
    let outputTokens = 0;
    let toolIndex = 0;
    let sawOutput = false;
    const payloadSummaries: string[] = [];
    const finishReasons: string[] = [];

    for await (const raw of parseSSEStream(response)) {
      for (const payload of expandCodeAssistSsePayload(raw.data)) {
        if (payloadSummaries.length < 3) {
          payloadSummaries.push(summarizeCodeAssistPayload(payload));
        }
        const unwrapped = unwrapCodeAssistResponse(payload);
        if (!isRecord(unwrapped)) continue;

        if (!sentCreated) {
          yield {
            event: "response.created",
            data: { response: { id: responseId } },
          };
          sentCreated = true;
        }

        const usage = extractCodeAssistUsage(payload);
        if (usage.input_tokens > 0) inputTokens = usage.input_tokens;
        if (usage.output_tokens > 0) outputTokens = usage.output_tokens;

        const candidates = Array.isArray(unwrapped.candidates) ? unwrapped.candidates : [];
        for (const candidate of candidates) {
          if (!isRecord(candidate)) continue;
          if (typeof candidate.finishReason === "string") {
            finishReasons.push(candidate.finishReason);
          }
          const content = isRecord(candidate.content) ? candidate.content : null;
          if (!content) continue;

          const parts = Array.isArray(content.parts) ? content.parts : [];
          for (const part of parts) {
            if (!isRecord(part)) continue;

            if (typeof part.text === "string" && part.text.length > 0) {
              sawOutput = true;
              yield {
                event: "response.output_text.delta",
                data: { delta: part.text },
              };
            } else if (isRecord(part.functionCall)) {
              sawOutput = true;
              const fc = part.functionCall;
              const toolId = `call_${randomUUID().slice(0, 8)}`;
              const toolName = typeof fc.name === "string" ? fc.name : "";
              const toolArgs = fc.args !== undefined ? JSON.stringify(fc.args) : "{}";

              yield {
                event: "response.output_item.added",
                data: {
                  output_index: toolIndex,
                  item: {
                    type: "function_call",
                    id: `item_${toolIndex}`,
                    call_id: toolId,
                    name: toolName,
                  },
                },
              };
              yield {
                event: "response.function_call_arguments.delta",
                data: { call_id: toolId, delta: toolArgs, output_index: toolIndex },
              };
              yield {
                event: "response.function_call_arguments.done",
                data: { call_id: toolId, name: toolName, arguments: toolArgs, output_index: toolIndex },
              };
              toolIndex++;
            }
          }
        }
      }
    }

    const usage = { input_tokens: inputTokens, output_tokens: outputTokens };
    if (!sawOutput && inputTokens === 0 && outputTokens === 0) {
      console.warn(
        `[GeminiDirect] empty_sse account=${this.currentAccountId ?? this.options.account.id}` +
        ` model=${this.currentModel ?? "unknown"}` +
        ` finishReasons=${finishReasons.length ? finishReasons.join(",") : "none"}` +
        ` payloads=${payloadSummaries.join(" | ")}`,
      );
    }
    if (this.currentModel) {
      this.options.onUsage?.(this.currentAccountId ?? this.options.account.id, this.currentModel, usage);
    }

    yield {
      event: "response.completed",
      data: {
        response: {
          id: responseId,
          status: "completed",
          usage: {
            ...usage,
            input_tokens_details: {},
            output_tokens_details: {},
          },
        },
      },
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function accountSupportsRequestedModel(account: GeminiAccountEntry, model: string): boolean {
  if (account.models.length === 0) return true;
  const clean = model.replace(/\[1m\]$/i, "").trim();
  return account.models.includes(clean);
}

function parseRetryAfterMs(header: string | null, body: string, fallbackMs: number): number {
  if (header) {
    const seconds = Number.parseFloat(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    const dateMs = Date.parse(header);
    if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  }

  const bodyMatch = body.match(/reset after\s+(\d+)s/i);
  if (bodyMatch) {
    const seconds = Number.parseInt(bodyMatch[1], 10);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  }

  return fallbackMs;
}

function expandCodeAssistSsePayload(payload: unknown): unknown[] {
  if (typeof payload !== "string") return [payload];

  const lines = payload
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  const parsed: unknown[] = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      parsed.push(line);
    }
  }
  return parsed;
}

function summarizeCodeAssistPayload(payload: unknown): string {
  const unwrapped = unwrapCodeAssistResponse(payload);
  if (!isRecord(unwrapped)) {
    return `${typeof payload}(len=${String(payload).length})`;
  }

  const candidates = Array.isArray(unwrapped.candidates) ? unwrapped.candidates : [];
  const usage = isRecord(unwrapped.usageMetadata) ? unwrapped.usageMetadata : {};
  const partKeys: string[] = [];
  for (const candidate of candidates) {
    if (!isRecord(candidate) || !isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) {
      continue;
    }
    for (const part of candidate.content.parts) {
      if (!isRecord(part)) continue;
      partKeys.push(Object.keys(part).sort().join("+"));
    }
  }
  return [
    `candidates=${candidates.length}`,
    `parts=${partKeys.length ? partKeys.join(",") : "none"}`,
    `prompt=${typeof usage.promptTokenCount === "number" ? usage.promptTokenCount : "?"}`,
    `output=${typeof usage.candidatesTokenCount === "number" ? usage.candidatesTokenCount : "?"}`,
  ].join(" ");
}
