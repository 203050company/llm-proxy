/**
 * Translate CodexResponsesRequest → Google Gemini generateContent request body.
 *
 * Key differences:
 *   - System prompt uses `system_instruction` (separate field)
 *   - Messages use `contents[]` with `role: "user"/"model"` (not "assistant")
 *   - Tool calls use `functionCall` / `functionResponse` part types
 *   - Images use `inlineData` or `fileData`
 */

import type { CodexInputItem, CodexContentPart, CodexResponsesRequest } from "../proxy/codex-types.js";

interface GeminiTextPart { text: string }
interface GeminiInlineDataPart { inlineData: { mimeType: string; data: string } }
interface GeminiFunctionCallPart { functionCall: { name: string; args: unknown } }
interface GeminiFunctionResponsePart { functionResponse: { name: string; response: unknown } }

type GeminiPart =
  | GeminiTextPart
  | GeminiInlineDataPart
  | GeminiFunctionCallPart
  | GeminiFunctionResponsePart;

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiTool {
  functionDeclarations: Array<{
    name: string;
    description?: string;
    parameters?: unknown;
  }>;
}

export interface GeminiGenerateContentRequest {
  contents: GeminiContent[];
  system_instruction?: { parts: [{ text: string }] };
  tools?: GeminiTool[];
  generationConfig?: {
    maxOutputTokens?: number;
    responseMimeType?: string;
    responseSchema?: unknown;
    thinkingConfig?: { thinkingBudget: number };
  };
}

function codexPartToGemini(part: CodexContentPart): GeminiPart {
  if (part.type === "input_text") return { text: part.text };
  // input_image — treat as external URL reference via text (Gemini Files API not used here)
  return { text: `[Image: ${part.image_url}]` };
}

function inputItemsToGeminiContents(input: CodexInputItem[]): GeminiContent[] {
  const contents: GeminiContent[] = [];
  const functionNamesByCallId = new Map<string, string>();

  for (const item of input) {
    if ("role" in item) {
      const role = item.role;
      if (role === "system") continue; // handled by system_instruction
      const geminiRole = role === "assistant" ? "model" as const : "user" as const;

      if (typeof item.content === "string") {
        contents.push({ role: geminiRole, parts: [{ text: item.content }] });
      } else {
        contents.push({ role: geminiRole, parts: item.content.map(codexPartToGemini) });
      }
    } else if (item.type === "function_call") {
      functionNamesByCallId.set(item.call_id, item.name);
      const fnCallPart: GeminiFunctionCallPart = {
        functionCall: {
          name: item.name,
          args: (() => {
            try { return JSON.parse(item.arguments) as unknown; } catch { return {}; }
          })(),
        },
      };
      const last = contents.at(-1);
      if (last?.role === "model") {
        last.parts.push(fnCallPart);
      } else {
        contents.push({ role: "model", parts: [fnCallPart] });
      }
    } else if (item.type === "function_call_output") {
      const fnRespPart: GeminiFunctionResponsePart = {
        functionResponse: {
          name: functionNamesByCallId.get(item.call_id) ?? fallbackFunctionResponseName(item.call_id),
          response: { output: item.output },
        },
      };
      const last = contents.at(-1);
      if (last?.role === "user") {
        last.parts.push(fnRespPart);
      } else {
        contents.push({ role: "user", parts: [fnRespPart] });
      }
    }
  }

  return contents;
}

function fallbackFunctionResponseName(callId: string): string {
  const cleaned = callId.replace(/[^A-Za-z0-9_.-]/g, "_");
  if (!cleaned) return "tool_result";
  if (/^[A-Za-z_]/.test(cleaned)) return cleaned;
  return `tool_${cleaned}`;
}

function convertToolsToGemini(tools: unknown[]): GeminiTool[] {
  const declarations: GeminiTool["functionDeclarations"] = [];
  for (const tool of tools) {
    if (!isRecord(tool) || tool.type !== "function") continue;

    if (isRecord(tool.function)) {
      const fn = tool.function;
      if (typeof fn.name !== "string") continue;
      const declaration: GeminiTool["functionDeclarations"][number] = { name: fn.name };
      if (typeof fn.description === "string") declaration.description = fn.description;
      const parameters = sanitizeGeminiSchema(fn.parameters);
      if (parameters !== undefined) declaration.parameters = parameters;
      declarations.push(declaration);
    } else if (typeof tool.name === "string") {
      const declaration: GeminiTool["functionDeclarations"][number] = { name: tool.name };
      if (typeof tool.description === "string") declaration.description = tool.description;
      const parameters = sanitizeGeminiSchema(tool.parameters);
      if (parameters !== undefined) declaration.parameters = parameters;
      declarations.push(declaration);
    }
  }
  return declarations.length ? [{ functionDeclarations: declarations }] : [];
}

const REASONING_BUDGET: Record<string, number> = {
  low: 1024,
  medium: 8192,
  high: 16000,
  xhigh: 32000,
};

export function translateCodexToGeminiRequest(
  req: CodexResponsesRequest,
): GeminiGenerateContentRequest {
  const contents = inputItemsToGeminiContents(req.input);

  const body: GeminiGenerateContentRequest = { contents };

  if (req.instructions) {
    body.system_instruction = { parts: [{ text: req.instructions }] };
  }

  if (req.tools?.length) {
    body.tools = convertToolsToGemini(req.tools);
  }

  if (req.max_output_tokens || req.text?.format || req.reasoning?.effort) {
    body.generationConfig = {};
    if (req.max_output_tokens) {
      body.generationConfig.maxOutputTokens = req.max_output_tokens;
    }
    if (req.text?.format?.type === "json_object") {
      body.generationConfig.responseMimeType = "application/json";
    } else if (req.text?.format?.type === "json_schema" && req.text.format.schema) {
      body.generationConfig.responseMimeType = "application/json";
      body.generationConfig.responseSchema = req.text.format.schema;
    }
    if (req.reasoning?.effort) {
      const budget = REASONING_BUDGET[req.reasoning.effort] ?? 8192;
      body.generationConfig.thinkingConfig = { thinkingBudget: budget };
    }
  }

  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const GEMINI_UNSUPPORTED_SCHEMA_KEYS = new Set([
  "additionalProperties",
  "const",
  "default",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "propertyNames",
]);

function sanitizeGeminiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeGeminiSchema);
  if (!isRecord(value)) return value;

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith("$") || GEMINI_UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
    result[key] = sanitizeGeminiSchema(child);
  }
  return result;
}
