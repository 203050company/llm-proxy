/**
 * Model routes — pure route handlers reading from model-store singleton.
 */

import { Hono } from "hono";
import type { OpenAIModel, OpenAIModelList } from "../types/openai.js";
import {
  getModelCatalog,
  getModelAliases,
  getModelInfo,
  getModelStoreDebug,
  parseModelName,
  buildDisplayModelName,
  type CodexModelInfo,
  stripClaudeCodeContextSuffix,
} from "../models/model-store.js";
import { triggerImmediateRefresh } from "../models/model-fetcher.js";
import { getConfig } from "../config.js";
import type { ApiKeyPool } from "../auth/api-key-pool.js";
import { getOpencodeGoModelAlias, getOpencodeGoModelAliases } from "../proxy/opencode-go-upstream.js";

// --- Routes ---

/** Stable timestamp used for all model `created` fields (2023-11-14T22:13:20Z). */
const MODEL_CREATED_TIMESTAMP = 1700000000;

type ModelInfoResponse = CodexModelInfo & {
  type?: "model";
  display_name?: string;
  context_window?: number;
  input_context_window?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  max_tokens?: number;
  max_context_window?: number;
};

function getCustomContextLimit(id: string): number | undefined {
  const normalizedId = id.toLowerCase();
  if (normalizedId.endsWith("[200k]")) return 200000;
  if (normalizedId.endsWith("[250k]")) return 250000;
  if (normalizedId.endsWith("[300k]")) return 300000;
  if (normalizedId.endsWith("[400k]")) return 400000;
  if (normalizedId.endsWith("[1m]")) return 400000;
  return undefined;
}

function getContextMetadata(info: CodexModelInfo, id: string): {
  contextLimit?: number;
  maxContextLimit?: number;
} {
  const customLimit = getCustomContextLimit(id);
  const contextLimit = customLimit ?? info.contextWindow;
  if (contextLimit === undefined) return {};

  const maxContextLimit = customLimit !== undefined
    ? Math.min(info.maxContextWindow ?? contextLimit, contextLimit)
    : info.maxContextWindow;

  return { contextLimit, maxContextLimit };
}

function getResponseDisplayName(info: CodexModelInfo, id: string): string {
  const strippedId = stripClaudeCodeContextSuffix(id);
  if (strippedId === info.id) return info.displayName;
  return buildDisplayModelName(parseModelName(strippedId));
}

function toModelInfoResponse(info: CodexModelInfo, id = info.id): ModelInfoResponse {
  const { contextLimit, maxContextLimit } = getContextMetadata(info, id);
  const displayName = getResponseDisplayName(info, id);
  return {
    ...info,
    id,
    displayName,
    type: "model",
    display_name: displayName,
    ...(contextLimit !== undefined ? {
      contextWindow: contextLimit,
      context_window: contextLimit,
      max_input_tokens: contextLimit,
    } : {}),
    ...(info.inputContextWindow !== undefined ? { input_context_window: info.inputContextWindow } : {}),
    ...(info.maxOutputTokens !== undefined ? { max_output_tokens: info.maxOutputTokens, max_tokens: info.maxOutputTokens } : {}),
    ...(maxContextLimit !== undefined ? {
      maxContextWindow: maxContextLimit,
      max_context_window: maxContextLimit,
    } : {}),
  };
}

function toOpenAIModel(info: CodexModelInfo, id = info.id): OpenAIModel {
  const { contextLimit, maxContextLimit } = getContextMetadata(info, id);
  return {
    id,
    object: "model",
    type: "model",
    display_name: getResponseDisplayName(info, id),
    created: MODEL_CREATED_TIMESTAMP,
    owned_by: "openai",
    ...(contextLimit !== undefined ? { context_window: contextLimit, max_input_tokens: contextLimit } : {}),
    ...(info.inputContextWindow !== undefined ? { input_context_window: info.inputContextWindow } : {}),
    ...(info.maxOutputTokens !== undefined ? { max_output_tokens: info.maxOutputTokens, max_tokens: info.maxOutputTokens } : {}),
    ...(maxContextLimit !== undefined ? { max_context_window: maxContextLimit } : {}),
  };
}

function toRuntimeOpenAIModel(id: string): OpenAIModel {
  return {
    id,
    object: "model",
    created: MODEL_CREATED_TIMESTAMP,
    owned_by: "openai",
  };
}

function toOpencodeGoOpenAIModel(model: { alias: string; displayName: string }): OpenAIModel & { created_at: string } {
  return {
    id: model.alias,
    object: "model",
    type: "model",
    display_name: model.displayName,
    created: MODEL_CREATED_TIMESTAMP,
    created_at: new Date(MODEL_CREATED_TIMESTAMP * 1000).toISOString(),
    owned_by: "opencode-go",
  };
}

function toListedModel(info: CodexModelInfo, id = info.id): OpenAIModel {
  return { ...toOpenAIModel(info, id), id };
}

function getListedModelIds(info: CodexModelInfo): string[] {
  const efforts = new Set([
    ...info.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  const ids = [info.id];
  for (const effort of efforts) {
    const suffixedId = `${info.id}-${effort}`;
    if (suffixedId !== info.id) ids.push(suffixedId);
  }

  // Add suffix variations if the model supports large context
  const context = Math.max(info.contextWindow ?? 0, info.maxContextWindow ?? 0);
  const contextSuffixes: string[] = [];
  if (context >= 400000) {
    contextSuffixes.push("[200k]", "[250k]", "[300k]", "[400k]", "[1m]");
  }

  if (contextSuffixes.length > 0) {
    const baseIds = [...ids];
    for (const baseId of baseIds) {
      for (const suffix of contextSuffixes) {
        ids.push(`${baseId}${suffix}`);
      }
    }
  }

  return ids;
}

function getListedAliasIds(alias: string, info: CodexModelInfo): string[] {
  return getListedModelIds({ ...info, id: alias });
}

function resolveCatalogModelInfo(modelId: string): CodexModelInfo | undefined {
  const strippedId = stripClaudeCodeContextSuffix(modelId);
  const directInfo = getModelInfo(strippedId);
  if (directInfo) return directInfo;

  const aliases = getModelAliases();
  const aliasInfo = getModelInfo(aliases[strippedId] ?? "");
  if (aliasInfo) return aliasInfo;

  for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh"]) {
    if (strippedId.endsWith(`-${effort}`)) {
      const baseId = strippedId.slice(0, -(effort.length + 1));
      const resolvedId = aliases[baseId] ?? baseId;
      return getModelInfo(resolvedId);
    }
  }

  return undefined;
}

export function createModelRoutes(apiKeyPool?: ApiKeyPool): Hono {
  const app = new Hono();

  app.get("/v1/models", (c) => {
    const catalog = getModelCatalog();
    const aliases = getModelAliases();
    const modelsById = new Map<string, OpenAIModel>();

    for (const model of catalog) {
      for (const modelId of getListedModelIds(model)) {
        modelsById.set(modelId, toListedModel(model, modelId));
      }
    }
    for (const [alias, resolvedId] of Object.entries(aliases)) {
      const info = getModelInfo(stripClaudeCodeContextSuffix(resolvedId));
      if (!info) {
        modelsById.set(alias, toRuntimeOpenAIModel(alias));
        continue;
      }
      for (const aliasId of getListedAliasIds(alias, info)) {
        modelsById.set(aliasId, toListedModel(info, aliasId));
      }
    }
    for (const modelId of apiKeyPool?.getActiveModels() ?? []) {
      modelsById.set(modelId, toRuntimeOpenAIModel(modelId));
    }
    for (const model of getOpencodeGoModelAliases()) {
      modelsById.set(model.alias, toOpencodeGoOpenAIModel(model));
    }

    const response: OpenAIModelList = { object: "list", data: [...modelsById.values()] };
    return c.json(response);
  });

  // Full catalog with reasoning efforts (for dashboard UI)
  // Must be before :modelId to avoid being matched as a model ID
  app.get("/v1/models/catalog", (c) => {
    // Default outputModalities to ["text"] for chat-family entries that don't
    // set it explicitly, matching the interface's documented default.
    return c.json(
      getModelCatalog().map((m) => ({
        ...toModelInfoResponse(m),
        outputModalities: m.outputModalities ?? ["text"],
      })),
    );
  });

  app.get("/v1/models/:modelId", (c) => {
    const modelId = c.req.param("modelId");
    const info = resolveCatalogModelInfo(modelId);
    if (info) return c.json(toOpenAIModel(info, modelId));

    if (apiKeyPool?.hasActiveModel(modelId)) {
      return c.json(toRuntimeOpenAIModel(modelId));
    }

    const opencodeModel = getOpencodeGoModelAlias(modelId);
    if (opencodeModel) {
      return c.json(toOpencodeGoOpenAIModel({ ...opencodeModel, alias: modelId }));
    }

    c.status(404);
    return c.json({
      error: {
        message: `Model '${modelId}' not found`,
        type: "invalid_request_error",
        param: "model",
        code: "model_not_found",
      },
    });
  });

  // Extended endpoint: model details with reasoning efforts
  app.get("/v1/models/:modelId/info", (c) => {
    const modelId = c.req.param("modelId");
    const info = resolveCatalogModelInfo(modelId);
    if (!info) {
      c.status(404);
      return c.json({ error: `Model '${modelId}' not found` });
    }
    return c.json(toModelInfoResponse(info, modelId));
  });

  // Debug endpoint: model store internals
  app.get("/debug/models", (c) => {
    return c.json(getModelStoreDebug());
  });

  // Admin endpoint: trigger immediate model refresh
  app.post("/admin/refresh-models", (c) => {
    const config = getConfig();
    const configKey = config.server.proxy_api_key;
    if (configKey) {
      const authHeader = c.req.header("Authorization") ?? "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (token !== configKey) {
        c.status(401);
        return c.json({ error: "Unauthorized" });
      }
    }
    triggerImmediateRefresh();
    return c.json({ ok: true, message: "Model refresh triggered" });
  });

  return app;
}
