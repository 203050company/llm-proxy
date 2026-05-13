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
  type CodexModelInfo,
} from "../models/model-store.js";
import { triggerImmediateRefresh } from "../models/model-fetcher.js";
import { getConfig } from "../config.js";
import type { ApiKeyPool } from "../auth/api-key-pool.js";
import { getOpencodeGoModelAliases } from "../proxy/opencode-go-upstream.js";

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

function toModelInfoResponse(info: CodexModelInfo, id = info.id): ModelInfoResponse {
  return {
    ...info,
    id,
    type: "model",
    display_name: info.displayName,
    ...(info.contextWindow !== undefined ? { context_window: info.contextWindow, max_input_tokens: info.contextWindow } : {}),
    ...(info.inputContextWindow !== undefined ? { input_context_window: info.inputContextWindow } : {}),
    ...(info.maxOutputTokens !== undefined ? { max_output_tokens: info.maxOutputTokens, max_tokens: info.maxOutputTokens } : {}),
    ...(info.maxContextWindow !== undefined ? { max_context_window: info.maxContextWindow } : {}),
  };
}

function toOpenAIModel(info: CodexModelInfo): OpenAIModel {
  return {
    id: info.id,
    object: "model",
    type: "model",
    display_name: info.displayName,
    created: MODEL_CREATED_TIMESTAMP,
    owned_by: "openai",
    ...(info.contextWindow !== undefined ? { context_window: info.contextWindow, max_input_tokens: info.contextWindow } : {}),
    ...(info.inputContextWindow !== undefined ? { input_context_window: info.inputContextWindow } : {}),
    ...(info.maxOutputTokens !== undefined ? { max_output_tokens: info.maxOutputTokens, max_tokens: info.maxOutputTokens } : {}),
    ...(info.maxContextWindow !== undefined ? { max_context_window: info.maxContextWindow } : {}),
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
  return { ...toOpenAIModel(info), id };
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
  return ids;
}

function resolveCatalogModelInfo(modelId: string): CodexModelInfo | undefined {
  const directInfo = getModelInfo(modelId);
  if (directInfo) return directInfo;

  const aliases = getModelAliases();
  const aliasInfo = getModelInfo(aliases[modelId] ?? "");
  if (aliasInfo) return aliasInfo;

  for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh"]) {
    if (modelId.endsWith(`-${effort}`)) {
      return getModelInfo(modelId.slice(0, -(effort.length + 1)));
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
    for (const alias of Object.keys(aliases)) {
      modelsById.set(alias, toRuntimeOpenAIModel(alias));
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
    if (info) return c.json({ ...toOpenAIModel(info), id: modelId });

    if (apiKeyPool?.hasActiveModel(modelId)) {
      return c.json(toRuntimeOpenAIModel(modelId));
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
