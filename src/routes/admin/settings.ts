import { Hono, type Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { z } from "zod";
import type { AccountPool } from "../../auth/account-pool.js";
import { validateSession } from "../../auth/dashboard-session.js";
import { getConfig, getLocalConfigPath, reloadAllConfigs, ROTATION_STRATEGIES } from "../../config.js";
import { logStore } from "../../logs/store.js";
import type { ProxyPool } from "../../proxy/proxy-pool.js";
import { batchWarmupSessions } from "../../services/account-session-warmup.js";
import { parseSessionCookie } from "../../utils/parse-cookie.js";
import { mutateYaml } from "../../utils/yaml-mutate.js";
import { isLocalhostRequest } from "../../utils/is-localhost.js";

const WarmupSessionsSchema = z.object({
  ids: z.array(z.string()).min(1).optional(),
  concurrency: z.number().int().min(1).max(20).optional(),
  stagger_ms: z.number().int().min(0).max(60_000).optional(),
}).optional();

const GeneralSettingsSchema = z.object({
  port: z.number().int().min(1).max(65535).optional(),
  proxy_url: z.string().nullable().optional(),
  force_http11: z.boolean().optional(),
  inject_desktop_context: z.boolean().optional(),
  suppress_desktop_directives: z.boolean().optional(),
  default_model: z.string().trim().min(1).optional(),
  default_reasoning_effort: z.string().trim().nullable().optional(),
  refresh_enabled: z.boolean().optional(),
  refresh_margin_seconds: z.number().int().min(0).optional(),
  refresh_concurrency: z.number().int().min(1).optional(),
  max_concurrent_per_account: z.number().int().min(1).nullable().optional(),
  request_interval_ms: z.number().int().min(0).nullable().optional(),
  auto_update: z.boolean().optional(),
  auto_download: z.boolean().optional(),
  show_update_dialog: z.boolean().optional(),
  logs_enabled: z.boolean().optional(),
  logs_capacity: z.number().int().min(1).optional(),
  logs_capture_body: z.boolean().optional(),
  logs_llm_only: z.boolean().optional(),
  usage_history_retention_days: z.number().int().min(1).nullable().optional(),
});

type GeneralSettingsPatch = z.infer<typeof GeneralSettingsSchema>;

const QuotaSettingsSchema = z.object({
  refresh_interval_minutes: z.number().int().min(0).optional(),
  concurrency: z.number().int().min(1).optional(),
  warning_thresholds: z.object({
    primary: z.array(z.number().int().min(1).max(100)).optional(),
    secondary: z.array(z.number().int().min(1).max(100)).optional(),
  }).optional(),
  skip_exhausted: z.boolean().optional(),
});

type QuotaSettingsPatch = z.infer<typeof QuotaSettingsSchema>;

function formatZodError(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join(", ");
}

function getGeneralSettingsData() {
  const config = getConfig();
  return {
    port: config.server.port,
    proxy_url: config.tls.proxy_url,
    force_http11: config.tls.force_http11,
    inject_desktop_context: config.model.inject_desktop_context,
    suppress_desktop_directives: config.model.suppress_desktop_directives,
    default_model: config.model.default,
    default_reasoning_effort: config.model.default_reasoning_effort,
    refresh_enabled: config.auth.refresh_enabled,
    refresh_margin_seconds: config.auth.refresh_margin_seconds,
    refresh_concurrency: config.auth.refresh_concurrency,
    max_concurrent_per_account: config.auth.max_concurrent_per_account,
    request_interval_ms: config.auth.request_interval_ms,
    auto_update: config.update.auto_update,
    auto_download: config.update.auto_download,
    show_update_dialog: config.update.show_update_dialog,
    logs_enabled: config.logs.enabled,
    logs_capacity: config.logs.capacity,
    logs_capture_body: config.logs.capture_body,
    logs_llm_only: config.logs.llm_only,
    usage_history_retention_days: config.usage_stats.history_retention_days,
  };
}

function getQuotaSettingsData() {
  const config = getConfig();
  return {
    refresh_interval_minutes: config.quota.refresh_interval_minutes,
    warning_thresholds: config.quota.warning_thresholds,
    skip_exhausted: config.quota.skip_exhausted,
    concurrency: config.quota.concurrency,
  };
}

function updateGeneralSettings(data: Record<string, unknown>, patch: GeneralSettingsPatch): void {
  if (patch.port !== undefined) {
    if (!data.server) data.server = {};
    (data.server as Record<string, unknown>).port = patch.port;
  }
  if (patch.proxy_url !== undefined || patch.force_http11 !== undefined) {
    if (!data.tls) data.tls = {};
    const tls = data.tls as Record<string, unknown>;
    if (patch.proxy_url !== undefined) tls.proxy_url = patch.proxy_url;
    if (patch.force_http11 !== undefined) tls.force_http11 = patch.force_http11;
  }
  if (
    patch.default_model !== undefined ||
    patch.default_reasoning_effort !== undefined ||
    patch.inject_desktop_context !== undefined ||
    patch.suppress_desktop_directives !== undefined
  ) {
    if (!data.model) data.model = {};
    const model = data.model as Record<string, unknown>;
    if (patch.default_model !== undefined) model.default = patch.default_model;
    if (patch.default_reasoning_effort !== undefined) model.default_reasoning_effort = patch.default_reasoning_effort;
    if (patch.inject_desktop_context !== undefined) model.inject_desktop_context = patch.inject_desktop_context;
    if (patch.suppress_desktop_directives !== undefined) model.suppress_desktop_directives = patch.suppress_desktop_directives;
  }
  if (
    patch.refresh_enabled !== undefined ||
    patch.refresh_margin_seconds !== undefined ||
    patch.refresh_concurrency !== undefined ||
    patch.max_concurrent_per_account !== undefined ||
    patch.request_interval_ms !== undefined
  ) {
    if (!data.auth) data.auth = {};
    const auth = data.auth as Record<string, unknown>;
    if (patch.refresh_enabled !== undefined) auth.refresh_enabled = patch.refresh_enabled;
    if (patch.refresh_margin_seconds !== undefined) auth.refresh_margin_seconds = patch.refresh_margin_seconds;
    if (patch.refresh_concurrency !== undefined) auth.refresh_concurrency = patch.refresh_concurrency;
    if (patch.max_concurrent_per_account !== undefined) auth.max_concurrent_per_account = patch.max_concurrent_per_account;
    if (patch.request_interval_ms !== undefined) auth.request_interval_ms = patch.request_interval_ms;
  }
  if (patch.auto_update !== undefined || patch.auto_download !== undefined || patch.show_update_dialog !== undefined) {
    if (!data.update) data.update = {};
    const update = data.update as Record<string, unknown>;
    if (patch.auto_update !== undefined) update.auto_update = patch.auto_update;
    if (patch.auto_download !== undefined) update.auto_download = patch.auto_download;
    if (patch.show_update_dialog !== undefined) update.show_update_dialog = patch.show_update_dialog;
  }
  if (patch.logs_enabled !== undefined || patch.logs_capacity !== undefined || patch.logs_capture_body !== undefined || patch.logs_llm_only !== undefined) {
    if (!data.logs) data.logs = {};
    const logs = data.logs as Record<string, unknown>;
    if (patch.logs_enabled !== undefined) logs.enabled = patch.logs_enabled;
    if (patch.logs_capacity !== undefined) logs.capacity = patch.logs_capacity;
    if (patch.logs_capture_body !== undefined) logs.capture_body = patch.logs_capture_body;
    if (patch.logs_llm_only !== undefined) logs.llm_only = patch.logs_llm_only;
  }
  if (patch.usage_history_retention_days !== undefined) {
    if (!data.usage_stats) data.usage_stats = {};
    (data.usage_stats as Record<string, unknown>).history_retention_days = patch.usage_history_retention_days;
  }
}

function updateQuotaSettings(data: Record<string, unknown>, patch: QuotaSettingsPatch): void {
  if (!data.quota) data.quota = {};
  const quota = data.quota as Record<string, unknown>;
  if (patch.refresh_interval_minutes !== undefined) quota.refresh_interval_minutes = patch.refresh_interval_minutes;
  if (patch.concurrency !== undefined) quota.concurrency = patch.concurrency;
  if (patch.skip_exhausted !== undefined) quota.skip_exhausted = patch.skip_exhausted;
  if (patch.warning_thresholds !== undefined) {
    const existing = quota.warning_thresholds && typeof quota.warning_thresholds === "object"
      ? quota.warning_thresholds as Record<string, unknown>
      : {};
    if (patch.warning_thresholds.primary !== undefined) existing.primary = patch.warning_thresholds.primary;
    if (patch.warning_thresholds.secondary !== undefined) existing.secondary = patch.warning_thresholds.secondary;
    quota.warning_thresholds = existing;
  }
}

function hasAdminWriteAuth(c: Context): boolean {
  const currentKey = getConfig().server.proxy_api_key;
  if (!currentKey) return true;

  const authHeader = c.req.header("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (token === currentKey) return true;

  const sessionId = parseSessionCookie(c.req.header("Cookie") ?? c.req.header("cookie"));
  return Boolean(sessionId && validateSession(sessionId));
}

export function createSettingsRoutes(accountPool?: AccountPool, proxyPool?: ProxyPool): Hono {
  const app = new Hono();

  // --- Rotation settings ---

  app.get("/admin/rotation-settings", (c) => {
    const config = getConfig();
    return c.json({
      rotation_strategy: config.auth.rotation_strategy,
    });
  });

  app.post("/admin/rotation-settings", async (c) => {
    if (!hasAdminWriteAuth(c)) {
      c.status(401);
      return c.json({ error: "Invalid current API key" });
    }

    const body = await c.req.json() as { rotation_strategy?: string };
    const valid: readonly string[] = ROTATION_STRATEGIES;
    if (!body.rotation_strategy || !valid.includes(body.rotation_strategy)) {
      c.status(400);
      return c.json({ error: `rotation_strategy must be one of: ${ROTATION_STRATEGIES.join(", ")}` });
    }

    mutateYaml(getLocalConfigPath(), (data) => {
      if (!data.auth) data.auth = {};
      (data.auth as Record<string, unknown>).rotation_strategy = body.rotation_strategy;
    });
    reloadAllConfigs();

    const updated = getConfig();
    return c.json({
      success: true,
      rotation_strategy: updated.auth.rotation_strategy,
    });
  });

  // --- General settings ---

  app.get("/admin/general-settings", (c) => {
    return c.json(getGeneralSettingsData());
  });

  app.post("/admin/general-settings", async (c) => {
    if (!hasAdminWriteAuth(c)) {
      c.status(401);
      return c.json({ error: "Invalid current API key" });
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      c.status(400);
      return c.json({ error: "Invalid JSON body" });
    }

    const parsed = GeneralSettingsSchema.safeParse(body);
    if (!parsed.success) {
      c.status(400);
      return c.json({ error: formatZodError(parsed.error) });
    }

    const patch = parsed.data;
    const restartRequired = patch.port !== undefined || patch.proxy_url !== undefined || patch.force_http11 !== undefined;
    mutateYaml(getLocalConfigPath(), (data) => updateGeneralSettings(data, patch));
    reloadAllConfigs();

    if (patch.logs_enabled !== undefined || patch.logs_capacity !== undefined) {
      const logState: { enabled?: boolean; capacity?: number } = {};
      if (patch.logs_enabled !== undefined) logState.enabled = patch.logs_enabled;
      if (patch.logs_capacity !== undefined) logState.capacity = patch.logs_capacity;
      logStore.setState(logState);
    }

    return c.json({
      success: true,
      restart_required: restartRequired,
      ...getGeneralSettingsData(),
    });
  });

  app.get("/admin/quota-settings", (c) => {
    return c.json(getQuotaSettingsData());
  });

  app.post("/admin/quota-settings", async (c) => {
    if (!hasAdminWriteAuth(c)) {
      c.status(401);
      return c.json({ error: "Invalid current API key" });
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      c.status(400);
      return c.json({ error: "Invalid JSON body" });
    }

    const parsed = QuotaSettingsSchema.safeParse(body);
    if (!parsed.success) {
      c.status(400);
      return c.json({ error: formatZodError(parsed.error) });
    }

    mutateYaml(getLocalConfigPath(), (data) => updateQuotaSettings(data, parsed.data));
    reloadAllConfigs();

    return c.json({
      success: true,
      ...getQuotaSettingsData(),
    });
  });

  app.get("/admin/settings", (c) => {
    const config = getConfig();
    return c.json({ proxy_api_key: config.server.proxy_api_key });
  });

  app.post("/admin/settings", async (c) => {
    const config = getConfig();
    const currentKey = config.server.proxy_api_key;

    if (!hasAdminWriteAuth(c)) {
      c.status(401);
      return c.json({ error: "Invalid current API key" });
    }

    const body = await c.req.json() as { proxy_api_key?: string | null };
    const newKey = body.proxy_api_key === undefined ? currentKey : (body.proxy_api_key || null);

    // Prevent remote sessions from clearing the key (would disable login gate)
    if (currentKey && !newKey) {
      const remoteAddr = getConnInfo(c).remote.address ?? "";
      if (!isLocalhostRequest(remoteAddr)) {
        c.status(403);
        return c.json({ error: "Cannot clear API key from remote session — this would disable the login gate" });
      }
    }

    mutateYaml(getLocalConfigPath(), (data) => {
      if (!data.server) data.server = {};
      (data.server as Record<string, unknown>).proxy_api_key = newKey;
    });
    reloadAllConfigs();

    return c.json({ success: true, proxy_api_key: newKey });
  });

  app.post("/admin/accounts/warmup-sessions", async (c) => {
    if (!hasAdminWriteAuth(c)) {
      c.status(401);
      return c.json({ error: "Invalid current API key" });
    }
    if (!accountPool) {
      c.status(503);
      return c.json({ error: "Account pool unavailable" });
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = undefined;
    }
    const parsed = WarmupSessionsSchema.safeParse(body);
    if (!parsed.success) {
      c.status(400);
      return c.json({ error: "Invalid request", details: parsed.error.issues });
    }

    const options = parsed.data ?? {};
    const results = await batchWarmupSessions(
      accountPool,
      {
        ids: options.ids,
        concurrency: options.concurrency,
        staggerMs: options.stagger_ms,
      },
      proxyPool,
    );
    const summary = {
      total: results.length,
      warmed: results.filter((result) => result.result === "warmed").length,
      failed: results.filter((result) => result.result === "failed").length,
      skipped: results.filter((result) => result.result === "skipped").length,
    };
    return c.json({ summary, results });
  });

  return app;
}
