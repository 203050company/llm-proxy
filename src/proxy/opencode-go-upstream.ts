import { readFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import type { UpstreamAdapter } from "./upstream-adapter.js";
import type { CodexResponsesRequest, CodexSSEEvent } from "./codex-types.js";
import { CodexApiError } from "./codex-types.js";
import { parseSSEStream } from "./codex-sse.js";
import { translateCodexToAnthropicRequest } from "../translation/codex-request-to-anthropic.js";
import { translateCodexToOpenAIRequest } from "../translation/codex-request-to-openai.js";
import { withFetchDispatcher } from "./fetch-dispatcher.js";

export const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";

export interface OpencodeGoModelAlias {
  id: string;
  alias: string;
  displayName: string;
  aliases?: string[];
}

export const OPENCODE_GO_ALIASES: OpencodeGoModelAlias[] = [
  { id: "kimi-k2.7", alias: "opencode-kimi-k2.7", aliases: ["claude-opencode-kimi-k2.7"], displayName: "opencode-go kimi-k2.7" },
  { id: "kimi-k2.6", alias: "opencode-kimi-k2.6", aliases: ["claude-opencode-kimi-k2.6"], displayName: "opencode-go kimi-k2.6" },
  { id: "deepseek-v4-pro", alias: "opencode-deepseek-v4-pro", aliases: ["claude-opencode-deepseek-v4-pro"], displayName: "opencode-go deepseek-v4-pro" },
  { id: "deepseek-v4-flash", alias: "opencode-deepseek-v4-flash", aliases: ["claude-opencode-deepseek-v4-flash"], displayName: "opencode-go deepseek-v4-flash" },
  { id: "minimax-m2.7", alias: "opencode-minimax-m2.7", aliases: ["claude-opencode-minimax-m2.7"], displayName: "opencode-go minimax-m2.7" },
  { id: "minimax-m2.5", alias: "opencode-minimax-m2.5", aliases: ["claude-opencode-minimax-m2.5"], displayName: "opencode-go minimax-m2.5" },
  { id: "glm-5.1", alias: "opencode-glm-5.1", aliases: ["claude-opencode-glm-5.1"], displayName: "opencode-go glm-5.1" },
  { id: "glm-4.6", alias: "opencode-glm-4.6", aliases: ["claude-opencode-glm-4.6"], displayName: "opencode-go glm-4.6" },
  { id: "qwen3.6-plus", alias: "opencode-qwen3.6-plus", aliases: ["claude-opencode-qwen3.6-plus"], displayName: "opencode-go qwen3.6-plus" },
  { id: "qwen3-coder", alias: "opencode-qwen3-coder", aliases: ["claude-opencode-qwen3-coder"], displayName: "opencode-go qwen3-coder" },
  { id: "mimo-v2.5-pro", alias: "opencode-mimo-v2.5-pro", aliases: ["claude-opencode-mimo-v2.5-pro"], displayName: "opencode-go mimo-v2.5-pro" },
  { id: "mimo-vl", alias: "opencode-mimo-vl", aliases: ["claude-opencode-mimo-vl"], displayName: "opencode-go mimo-vl" },
];

const ALIAS_TO_MODEL = new Map(
  OPENCODE_GO_ALIASES.flatMap((model) => [
    [model.alias, model.id] as const,
    ...(model.aliases ?? []).map((alias) => [alias, model.id] as const),
  ]),
);
const MODEL_TTL_MS = 5 * 60 * 1000;
const MODEL_REFRESH_FAILURE_BACKOFF_MS = 30 * 1000;
let cachedModels: OpencodeGoModelAlias[] = OPENCODE_GO_ALIASES;
let cacheExpiresAt = 0;
let refreshPromise: Promise<void> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "";
}

function redactSecret(secret: string): string {
  if (secret.length <= 8) return "****";
  return `${secret.slice(0, 3)}...${secret.slice(-4)}`;
}

function aliasForModel(modelId: string): string {
  return `claude-opencode-${modelId}`;
}

function normalizeDisplayName(modelId: string): string {
  return `opencode-go ${modelId}`;
}

export interface OpencodeGoAuth {
  apiKey: string | null;
  source: string | null;
  redacted: string | null;
}

export function resolveOpencodeGoAuth(): OpencodeGoAuth {
  const envKey = process.env.OPENCODE_GO_API_KEY?.trim();
  if (envKey) {
    return { apiKey: envKey, source: "OPENCODE_GO_API_KEY", redacted: redactSecret(envKey) };
  }

  const authPath = join(homeDir(), ".local/share/opencode/auth.json");
  try {
    const parsed = JSON.parse(readFileSync(authPath, "utf8")) as unknown;
    const key = isRecord(parsed) && isRecord(parsed["opencode-go"]) && typeof parsed["opencode-go"].key === "string"
      ? parsed["opencode-go"].key.trim()
      : "";
    if (key) {
      return { apiKey: key, source: `${authPath}:opencode-go.key`, redacted: redactSecret(key) };
    }
  } catch {
    // Missing or malformed auth.json just means opencode-go is unavailable.
  }

  return { apiKey: null, source: null, redacted: null };
}

export function resolveOpencodeGoBaseUrl(): string {
  return (process.env.OPENCODE_GO_BASE_URL?.trim() || OPENCODE_GO_BASE_URL).replace(/\/$/, "");
}

export function getOpencodeGoModelAlias(model: string): OpencodeGoModelAlias | undefined {
  const trimmed = model.trim();
  const staticModelId = ALIAS_TO_MODEL.get(trimmed);
  if (staticModelId) return OPENCODE_GO_ALIASES.find((alias) => alias.id === staticModelId);
  return cachedModels.find((alias) => alias.alias === trimmed || (alias.aliases ?? []).includes(trimmed));
}

export function resolveOpencodeGoModel(model: string): string {
  const trimmed = model.trim();
  const alias = getOpencodeGoModelAlias(trimmed);
  if (alias) return alias.id;
  if (trimmed.startsWith("opencode-go:")) return trimmed.slice("opencode-go:".length);
  if (trimmed.startsWith("opencode-go/")) return trimmed.slice("opencode-go/".length);
  return trimmed;
}

export function isOpencodeGoModel(model: string): boolean {
  const trimmed = model.trim();
  return !!getOpencodeGoModelAlias(trimmed) || trimmed.startsWith("opencode-go:") || trimmed.startsWith("opencode-go/");
}

export function shouldUseOpencodeMessagesEndpoint(modelId: string): boolean {
  return modelId === "minimax-m2.7" || modelId === "minimax-m2.5";
}

function shouldOmitForcedToolChoice(modelId: string): boolean {
  return /^(kimi-|deepseek-|qwen)/.test(modelId);
}

function shouldBackfillReasoningContent(modelId: string): boolean {
  return modelId.startsWith("kimi-") || modelId.startsWith("deepseek-");
}

function backfillReasoningContent(body: unknown): unknown {
  if (!isRecord(body) || !Array.isArray(body.messages)) return body;
  return {
    ...body,
    messages: body.messages.map((message) => {
      if (!isRecord(message)) return message;
      const reasoningContent = message.reasoning_content;
      if (message.role === "assistant" && Array.isArray(message.tool_calls) && (typeof reasoningContent !== "string" || reasoningContent.length === 0)) {
        return { ...message, reasoning_content: " " };
      }
      return message;
    }),
  };
}

export function getOpencodeGoModelAliases(): OpencodeGoModelAlias[] {
  if (Date.now() >= cacheExpiresAt && !refreshPromise) {
    refreshPromise = refreshOpencodeGoModels()
      .catch(() => undefined)
      .finally(() => {
        refreshPromise = null;
      });
  }
  return cachedModels;
}

async function refreshOpencodeGoModels(): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`${resolveOpencodeGoBaseUrl()}/models`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      cacheExpiresAt = Date.now() + MODEL_REFRESH_FAILURE_BACKOFF_MS;
      return;
    }
    const parsed = await response.json() as unknown;
    const rawModels = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.data)
        ? parsed.data
        : isRecord(parsed) && Array.isArray(parsed.models)
          ? parsed.models
          : [];
    const models = rawModels
      .map(extractModelId)
      .filter((id): id is string => !!id)
      .map((id) => ({
        id,
        alias: aliasForModel(id),
        displayName: normalizeDisplayName(id),
      }));
    if (models.length > 0) {
      cachedModels = mergeStaticAliases(models);
      cacheExpiresAt = Date.now() + MODEL_TTL_MS;
    } else {
      cacheExpiresAt = Date.now() + MODEL_REFRESH_FAILURE_BACKOFF_MS;
    }
  } catch {
    cacheExpiresAt = Date.now() + MODEL_REFRESH_FAILURE_BACKOFF_MS;
  } finally {
    clearTimeout(timeout);
  }
}

function extractModelId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return null;
  const id = value.id ?? value.name ?? value.slug;
  return typeof id === "string" ? id : null;
}

function mergeStaticAliases(discovered: OpencodeGoModelAlias[]): OpencodeGoModelAlias[] {
  const byId = new Map<string, OpencodeGoModelAlias>();
  for (const model of discovered) byId.set(model.id, model);
  for (const model of OPENCODE_GO_ALIASES) byId.set(model.id, model);
  return [...byId.values()];
}

export class OpencodeGoUpstream implements UpstreamAdapter {
  readonly tag = "opencode-go" as const;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(apiKey = resolveOpencodeGoAuth().apiKey, baseUrl = resolveOpencodeGoBaseUrl()) {
    if (!apiKey) {
      throw new Error("opencode-go upstream requires OPENCODE_GO_API_KEY or ~/.local/share/opencode/auth.json opencode-go.key");
    }
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async createResponse(req: CodexResponsesRequest, signal: AbortSignal): Promise<Response> {
    const modelId = resolveOpencodeGoModel(req.model);
    const upstreamReq = shouldOmitForcedToolChoice(modelId) && req.tool_choice !== undefined
      ? { ...req, tool_choice: undefined }
      : req;
    const useMessages = shouldUseOpencodeMessagesEndpoint(modelId);
    const body = useMessages
      ? translateCodexToAnthropicRequest(upstreamReq, modelId)
      : shouldBackfillReasoningContent(modelId)
        ? backfillReasoningContent(translateCodexToOpenAIRequest(upstreamReq, modelId, upstreamReq.stream))
        : translateCodexToOpenAIRequest(upstreamReq, modelId, upstreamReq.stream);
    const path = useMessages ? "/messages" : "/chat/completions";

    const response = await fetch(`${this.baseUrl}${path}`, withFetchDispatcher({
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal,
    }));

    if (!response.ok) {
      const errorText = await response.text().catch(() => `HTTP ${response.status}`);
      throw new CodexApiError(response.status, errorText);
    }

    return response;
  }

  async *parseStream(response: Response): AsyncGenerator<CodexSSEEvent> {
    const responseId = `opencode-go-${randomUUID().slice(0, 8)}`;
    const streamState = { messageId: responseId };
    let sentCreated = false;
    let sentCompleted = false;
    let finishReason: string | null = null;
    const usage = { input_tokens: 0, output_tokens: 0, cached_tokens: 0 };
    const toolCalls = new Map<number, { id: string; name: string; argBuffer: string }>();

    for await (const raw of parseSSEStream(response)) {
      if (!isRecord(raw.data)) continue;
      const data = raw.data;

      if (raw.event) {
        for await (const event of parseAnthropicEvent(raw.event, data, toolCalls, usage, streamState)) {
          if (event.event === "response.created") sentCreated = true;
          if (event.event === "response.completed") sentCompleted = true;
          yield event;
        }
        continue;
      }

      if (!sentCreated) {
        yield { event: "response.created", data: { response: { id: typeof data.id === "string" ? data.id : responseId } } };
        sentCreated = true;
      }

      if (isRecord(data.usage)) {
        usage.input_tokens = typeof data.usage.prompt_tokens === "number" ? data.usage.prompt_tokens : 0;
        usage.output_tokens = typeof data.usage.completion_tokens === "number" ? data.usage.completion_tokens : 0;
      }

      const choices = Array.isArray(data.choices) ? data.choices : [];
      for (const choice of choices) {
        if (!isRecord(choice)) continue;
        if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
        const delta = isRecord(choice.delta) ? choice.delta : null;
        if (!delta) continue;
        if (typeof delta.content === "string" && delta.content.length > 0) {
          yield { event: "response.output_text.delta", data: { delta: delta.content } };
        }
        const deltaToolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
        for (const tc of deltaToolCalls) {
          if (!isRecord(tc)) continue;
          const index = typeof tc.index === "number" ? tc.index : 0;
          const fn = isRecord(tc.function) ? tc.function : null;
          if (!toolCalls.has(index)) {
            const id = typeof tc.id === "string" ? tc.id : `call_${randomUUID().slice(0, 8)}`;
            const name = fn && typeof fn.name === "string" ? fn.name : "";
            toolCalls.set(index, { id, name, argBuffer: "" });
            yield {
              event: "response.output_item.added",
              data: { output_index: index, item: { type: "function_call", id: `item_${index}`, call_id: id, name } },
            };
          }
          if (fn && typeof fn.arguments === "string" && fn.arguments.length > 0) {
            const info = toolCalls.get(index)!;
            info.argBuffer += fn.arguments;
            yield {
              event: "response.function_call_arguments.delta",
              data: { call_id: info.id, delta: fn.arguments, output_index: index },
            };
          }
        }
      }
    }

    if (sentCompleted) return;

    for (const [index, info] of toolCalls) {
      yield {
        event: "response.function_call_arguments.done",
        data: { call_id: info.id, name: info.name, arguments: info.argBuffer, output_index: index },
      };
    }
    yield {
      event: "response.completed",
      data: {
        response: {
          id: responseId,
          status: finishReason === "stop" || finishReason === "tool_calls" || !finishReason ? "completed" : finishReason,
          usage: {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            input_tokens_details: usage.cached_tokens > 0 ? { cached_tokens: usage.cached_tokens } : {},
            output_tokens_details: {},
          },
        },
      },
    };
  }
}

async function* parseAnthropicEvent(
  event: string,
  data: Record<string, unknown>,
  toolBlocks: Map<number, { id: string; name: string; argBuffer: string }>,
  usage: { input_tokens: number; output_tokens: number; cached_tokens: number },
  state: { messageId: string },
): AsyncGenerator<CodexSSEEvent> {
  switch (event) {
    case "message_start": {
      const message = isRecord(data.message) ? data.message : null;
      const id = typeof message?.id === "string" ? message.id : state.messageId;
      state.messageId = id;
      const startUsage = isRecord(message?.usage) ? message.usage : null;
      usage.input_tokens = typeof startUsage?.input_tokens === "number" ? startUsage.input_tokens : usage.input_tokens;
      yield { event: "response.created", data: { response: { id } } };
      break;
    }
    case "content_block_start": {
      const block = isRecord(data.content_block) ? data.content_block : null;
      const index = typeof data.index === "number" ? data.index : 0;
      if (block?.type === "tool_use") {
        const id = typeof block.id === "string" ? block.id : `call_${randomUUID().slice(0, 8)}`;
        const name = typeof block.name === "string" ? block.name : "";
        toolBlocks.set(index, { id, name, argBuffer: "" });
        yield {
          event: "response.output_item.added",
          data: { output_index: index, item: { type: "function_call", id: `item_${index}`, call_id: id, name } },
        };
      }
      break;
    }
    case "content_block_delta": {
      const delta = isRecord(data.delta) ? data.delta : null;
      const index = typeof data.index === "number" ? data.index : 0;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        yield { event: "response.output_text.delta", data: { delta: delta.text } };
      } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
        const tool = toolBlocks.get(index);
        if (tool) {
          tool.argBuffer += delta.partial_json;
          yield {
            event: "response.function_call_arguments.delta",
            data: { call_id: tool.id, delta: delta.partial_json, output_index: index },
          };
        }
      }
      break;
    }
    case "content_block_stop": {
      const index = typeof data.index === "number" ? data.index : -1;
      const tool = toolBlocks.get(index);
      if (tool) {
        yield {
          event: "response.function_call_arguments.done",
          data: { call_id: tool.id, name: tool.name, arguments: tool.argBuffer, output_index: index },
        };
      }
      break;
    }
    case "message_delta": {
      const deltaUsage = isRecord(data.usage) ? data.usage : null;
      usage.output_tokens = typeof deltaUsage?.output_tokens === "number" ? deltaUsage.output_tokens : usage.output_tokens;
      break;
    }
    case "message_stop": {
      yield {
        event: "response.completed",
        data: {
          response: {
            id: state.messageId,
            status: "completed",
            usage: {
              input_tokens: usage.input_tokens,
              output_tokens: usage.output_tokens,
              input_tokens_details: {},
              output_tokens_details: {},
            },
          },
        },
      };
      break;
    }
  }
}
