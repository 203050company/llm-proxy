/**
 * Translate Anthropic Messages API request → Codex Responses API request.
 */

import type { AnthropicMessagesRequest } from "../types/anthropic.js";
import type {
  CodexResponsesRequest,
  CodexInputItem,
  CodexContentPart,
} from "../proxy/codex-api.js";
import { parseModelName, getModelInfo } from "../models/model-store.js";
import { getConfig } from "../config.js";
import { buildInstructions, budgetToEffort } from "./shared-utils.js";
import type { ModelConfigOverride } from "./shared-utils.js";
import {
  anthropicToolsToCodex,
  anthropicToolChoiceToCodex,
  type AnthropicToolConversionOptions,
} from "./tool-format.js";
import { toDataImageUrl } from "../utils/data-image-url.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasHostedWebSearchTool(tools: unknown[]): boolean {
  return tools.some((tool) => isRecord(tool) && tool.type === "web_search");
}

/**
 * Map Anthropic thinking budget_tokens to Codex reasoning effort.
 */
function mapThinkingToEffort(
  thinking: AnthropicMessagesRequest["thinking"],
): string | undefined {
  if (!thinking || thinking.type === "disabled") return undefined;
  if (thinking.type === "adaptive") {
    // adaptive: use budget_tokens if provided, otherwise let Codex decide
    return thinking.budget_tokens ? budgetToEffort(thinking.budget_tokens) : undefined;
  }
  return budgetToEffort(thinking.budget_tokens);
}

/**
 * Extract text-only content from Anthropic blocks.
 */
function extractTextContent(
  content: string | Array<Record<string, unknown>>,
): string {
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

const BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";

function normalizeSystemInstructionText(text: string): string {
  const trimmed = text.trim();
  return trimmed.startsWith(BILLING_HEADER_PREFIX) ? "" : trimmed;
}

/**
 * Build multimodal content (text + images) from Anthropic blocks.
 * Returns plain string if text-only, or CodexContentPart[] if images present.
 */
function extractMultimodalContent(
  content: Array<Record<string, unknown>>,
): string | CodexContentPart[] {
  const hasImage = content.some((b) => b.type === "image");
  if (!hasImage) return extractTextContent(content);

  const parts: CodexContentPart[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push({ type: "input_text", text: block.text });
    } else if (block.type === "image") {
      // Anthropic format: source: { type: "base64", media_type: "image/png", data: "..." }
      const source = block.source as
        | { type: string; media_type: string; data: string }
        | undefined;
      if (source?.type === "base64" && source.media_type && source.data) {
        parts.push({
          type: "input_image",
          image_url: toDataImageUrl(source.media_type, source.data),
        });
      }
    }
  }
  return parts.length > 0 ? parts : "";
}

function imageBlockToContentPart(block: Record<string, unknown>): CodexContentPart | null {
  if (block.type !== "image") return null;
  const source = block.source as
    | { type: string; media_type: string; data: string }
    | undefined;
  if (source?.type !== "base64" || !source.media_type || !source.data) return null;
  return {
    type: "input_image",
    image_url: toDataImageUrl(source.media_type, source.data),
  };
}

function toolResultToOutput(
  block: Record<string, unknown>,
): { callId: string; output: string; imageParts: CodexContentPart[] } {
  const callId = typeof block.tool_use_id === "string" ? block.tool_use_id : "unknown";
  let output = "";
  const imageParts: CodexContentPart[] = [];

  if (typeof block.content === "string") {
    output = block.content;
  } else if (Array.isArray(block.content)) {
    const blocks = block.content as Array<Record<string, unknown>>;
    output = blocks
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n");
    for (const b of blocks) {
      const imagePart = imageBlockToContentPart(b);
      if (imagePart) imageParts.push(imagePart);
    }
  }

  if (block.is_error) {
    output = `Error: ${output}`;
  }

  return { callId, output, imageParts };
}

/**
 * Convert Anthropic message content blocks into native Codex input items.
 * Handles text, image, tool_use, and tool_result blocks.
 */
function contentToInputItems(
  role: "user" | "assistant",
  content: string | Array<Record<string, unknown>>,
): CodexInputItem[] {
  if (typeof content === "string") {
    return [{ role, content }];
  }

  const items: CodexInputItem[] = [];

  // Build content (text or multimodal) for the message itself
  const hasToolBlocks = content.some((b) => b.type === "tool_use" || b.type === "tool_result");
  if (role === "user" && hasToolBlocks) {
    const followUpText: string[] = [];
    const followUpImages: CodexContentPart[] = [];

    for (const block of content) {
      if (block.type === "tool_result") {
        const result = toolResultToOutput(block);
        items.push({
          type: "function_call_output",
          call_id: result.callId,
          output: result.output,
        });
        followUpImages.push(...result.imageParts);
      } else if (block.type === "text" && typeof block.text === "string") {
        followUpText.push(block.text);
      } else {
        const imagePart = imageBlockToContentPart(block);
        if (imagePart) followUpImages.push(imagePart);
      }
    }

    if (followUpImages.length > 0) {
      items.push({
        role: "user",
        content: [
          ...followUpText.map((text) => ({ type: "input_text" as const, text })),
          ...followUpImages,
        ],
      });
    } else if (followUpText.length > 0) {
      items.push({ role: "user", content: followUpText.join("\n") });
    }

    return items;
  }

  if (role === "user") {
    const extracted = extractMultimodalContent(content);
    if (extracted || !hasToolBlocks) {
      items.push({ role: "user", content: extracted || "" });
    }
  } else {
    // Assistant messages: text-only (Codex doesn't support structured assistant content)
    const text = extractTextContent(content);
    if (text || !hasToolBlocks) {
      items.push({ role: "assistant", content: text });
    }
  }

  for (const block of content) {
    if (block.type === "tool_use") {
      const name = typeof block.name === "string" ? block.name : "unknown";
      const id = typeof block.id === "string" ? block.id : `tc_${name}`;
      let args: string;
      try {
        args = JSON.stringify(block.input ?? {});
      } catch {
        args = "{}";
      }
      items.push({
        type: "function_call",
        call_id: id,
        name,
        arguments: args,
      });
    } else if (block.type === "tool_result") {
      const result = toolResultToOutput(block);
      items.push({
        type: "function_call_output",
        call_id: result.callId,
        output: result.output,
      });
      // Codex function_call_output is string-only; inject images as a
      // subsequent user message so the model can still see them.
      if (result.imageParts.length > 0) {
        items.push({ role: "user", content: result.imageParts });
      }
    }
  }

  return items;
}

/**
 * Smart Truncation Guard to prevent 400k context overflow errors.
 * Ensures total character length (system instructions + message input content)
 * stays safely under the 400k token limit (using 1 token ≈ 3 characters estimation).
 */
function applySmartTruncationGuard(
  input: CodexInputItem[],
  instructions: string,
  maxContextTokens: number = 400000
): CodexInputItem[] {
  // 1 token = 3 characters estimation (highly conservative to prevent overflow)
  // 400k tokens ≈ 1,200,000 characters limit.
  // We keep a safety buffer of 50,000 tokens (150,000 chars) so the hard limit is 350,000 tokens.
  const safetyTokens = maxContextTokens - 50000;
  const charLimit = safetyTokens * 3;
  let currentLength = instructions.length;
  
  const retainedInput: CodexInputItem[] = [];
  
  // Iterate backwards from the most recent messages
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i];
    let itemLength = 0;
    
    if ("role" in item) {
      if (typeof item.content === "string") {
        itemLength += item.content.length;
      } else if (Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part.type === "input_text" && part.text) {
            itemLength += part.text.length;
          }
        }
      }
    } else if ("type" in item) {
      if (item.type === "function_call") {
        itemLength += item.arguments.length;
      } else if (item.type === "function_call_output") {
        itemLength += item.output.length;
      }
    }
    
    // If adding this message exceeds our safe budget, stop sliding window and discard older history
    if (currentLength + itemLength > charLimit) {
      break;
    }
    
    currentLength += itemLength;
    retainedInput.unshift(item); // Keep original order
  }
  
  // Fallback to guarantee at least one message is returned
  if (retainedInput.length === 0 && input.length > 0) {
    retainedInput.push(input[input.length - 1]);
  }
  
  return retainedInput;
}

/**
 * Convert an AnthropicMessagesRequest to a CodexResponsesRequest.
 *
 * Mapping:
 *   - system (top-level) → instructions field
 *   - messages → input array
 *   - model → resolved model ID
 *   - thinking → reasoning.effort
 */
export function translateAnthropicToCodexRequest(
  req: AnthropicMessagesRequest,
  modelConfig?: ModelConfigOverride,
  options?: { injectHostedWebSearch?: boolean; mapClaudeCodeWebSearch?: boolean },
): CodexResponsesRequest {
  // Extract system instructions
  let userInstructions: string;
  if (req.system) {
    if (typeof req.system === "string") {
      userInstructions = normalizeSystemInstructionText(req.system);
    } else {
      userInstructions = req.system
        .map((b) => normalizeSystemInstructionText(b.text))
        .filter(Boolean)
        .join("\n\n");
    }
  } else {
    userInstructions = "You are a helpful assistant.";
  }
  const cfg = modelConfig ?? getConfig().model;
  const instructions = buildInstructions(userInstructions, cfg);

  // Build input items from messages
  const input: CodexInputItem[] = [];
  for (const msg of req.messages) {
    const items = contentToInputItems(
      msg.role as "user" | "assistant",
      msg.content as string | Array<Record<string, unknown>>,
    );
    input.push(...items);
  }

  // Ensure at least one input message
  if (input.length === 0) {
    input.push({ role: "user", content: "" });
  }

  // Resolve model (suffix parsing extracts service_tier and reasoning_effort)
  const parsed = parseModelName(req.model);
  const modelId = parsed.modelId;
  const modelInfo = getModelInfo(modelId);

  // Convert tools to Codex format
  const toolConversionOptions: AnthropicToolConversionOptions | undefined =
    options?.mapClaudeCodeWebSearch === true ? { mapClaudeCodeWebSearch: true } : undefined;
  const codexTools = req.tools?.length
    ? toolConversionOptions
      ? anthropicToolsToCodex(req.tools, toolConversionOptions)
      : anthropicToolsToCodex(req.tools)
    : [];
  // Claude Code 在非 Anthropic 官方 base URL 下会禁用自身 ToolSearch。
  // 只有走本地 Codex 后端时才默认交给 Codex hosted web_search。
  if (options?.injectHostedWebSearch === true && !hasHostedWebSearchTool(codexTools)) {
    codexTools.push({ type: "web_search" });
  }
  const codexToolChoice = toolConversionOptions
    ? anthropicToolChoiceToCodex(req.tool_choice, req.tools, toolConversionOptions)
    : anthropicToolChoiceToCodex(req.tool_choice, req.tools);

  // Build request
  const request: CodexResponsesRequest = {
    model: modelId,
    instructions,
    input: applySmartTruncationGuard(input, instructions),
    stream: true,
    store: false,
    max_output_tokens: req.max_tokens,
    tools: codexTools,
  };

  // Add tool_choice if specified
  if (codexToolChoice) {
    request.tool_choice = codexToolChoice;
  }

  // Reasoning effort: thinking config > suffix > config default
  const thinkingEffort = mapThinkingToEffort(req.thinking);
  const effort =
    thinkingEffort ??
    parsed.reasoningEffort ??
    cfg.default_reasoning_effort;
  if (effort) {
    request.reasoning = { effort, summary: "auto" };
  }

  // Service tier: suffix > config default
  const serviceTier =
    parsed.serviceTier ??
    cfg.default_service_tier ??
    null;
  if (serviceTier) {
    request.service_tier = serviceTier;
  }

  return request;
}
