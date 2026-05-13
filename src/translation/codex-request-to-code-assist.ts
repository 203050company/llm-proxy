import type { CodexResponsesRequest } from "../proxy/codex-types.js";
import { translateCodexToGeminiRequest } from "./codex-request-to-gemini.js";

export interface CodeAssistContext {
  projectId: string | null;
  sessionId: string;
  userPromptId: string;
}

export interface CodeAssistGenerateContentRequest {
  model: string;
  project: string | null;
  user_prompt_id: string;
  request: Record<string, unknown>;
  enabled_credit_types?: string[];
}

export function translateCodexToCodeAssistRequest(
  req: CodexResponsesRequest,
  context: CodeAssistContext,
): CodeAssistGenerateContentRequest {
  const geminiRequest = translateCodexToGeminiRequest(req) as unknown as Record<string, unknown>;
  inlineSystemInstruction(geminiRequest);
  return {
    model: toCodeAssistModelId(req.model),
    project: context.projectId,
    user_prompt_id: context.userPromptId,
    request: {
      ...geminiRequest,
      session_id: context.sessionId,
    },
  };
}

function inlineSystemInstruction(request: Record<string, unknown>): void {
  const systemInstruction = isRecord(request.system_instruction)
    ? request.system_instruction
    : null;
  if (!systemInstruction) return;

  delete request.system_instruction;
  const systemParts = Array.isArray(systemInstruction.parts)
    ? systemInstruction.parts
    : [];
  const systemText = systemParts
    .filter(isRecord)
    .map((part) => typeof part.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("\n\n");
  if (!systemText) return;

  const contents = Array.isArray(request.contents)
    ? request.contents
    : [];
  const first = contents[0];
  if (isRecord(first) && first.role === "user" && Array.isArray(first.parts)) {
    const firstPart = first.parts[0];
    if (isRecord(firstPart) && typeof firstPart.text === "string") {
      firstPart.text = firstPart.text
        ? `${systemText}\n\n${firstPart.text}`
        : systemText;
    } else {
      first.parts.unshift({ text: systemText });
    }
    return;
  }

  contents.unshift({ role: "user", parts: [{ text: systemText }] });
  request.contents = contents;
}

const CODE_ASSIST_MODEL_ALIASES: Record<string, string> = {
  "gemini-3.1-pro": "gemini-3.1-pro-preview",
  "gemini-3-pro": "gemini-3-pro-preview",
  "gemini-3.1-flash-lite": "gemini-3.1-flash-lite-preview",
};

function toCodeAssistModelId(model: string): string {
  return CODE_ASSIST_MODEL_ALIASES[model] ?? model;
}

export function extractCodeAssistUsage(payload: unknown): { input_tokens: number; output_tokens: number } {
  const record = isRecord(payload) ? payload : {};
  const response = isRecord(record.response) ? record.response : {};
  const usage = isRecord(response.usageMetadata) ? response.usageMetadata : {};
  return {
    input_tokens: typeof usage.promptTokenCount === "number" ? usage.promptTokenCount : 0,
    output_tokens: typeof usage.candidatesTokenCount === "number" ? usage.candidatesTokenCount : 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
