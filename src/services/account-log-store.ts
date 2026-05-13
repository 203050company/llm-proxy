import { sanitizeLogMessage, sanitizeRequestId } from "../utils/sanitize-log.js";

export type AccountLogLevel = "info" | "warn" | "error";
export type AccountLogCategory = "proxy" | "auth";

export type AccountLogEventType =
  | `proxy.${string}`
  | `auth.${string}`;

export interface AccountLogUsage {
  input_tokens?: number;
  output_tokens?: number;
  cached_tokens?: number;
  reasoning_tokens?: number;
}

export interface AccountLogEvent {
  id: string;
  seq: number;
  timestamp: string;
  accountId: string;
  category: AccountLogCategory;
  level: AccountLogLevel;
  eventType: AccountLogEventType;
  requestId?: string;
  message?: string;
  routeTag?: string;
  model?: string;
  streaming?: boolean;
  attempt?: number;
  statusCode?: number;
  errorClass?: string;
  durationMs?: number;
  proxyMode?: string;
  proxyId?: string | null;
  proxyName?: string | null;
  fallbackReason?: string;
  usage?: AccountLogUsage;
  trigger?: string;
  expiresAt?: string | null;
  nextRefreshAt?: string | null;
  lastSuccessAt?: string | null;
  failureCode?: string;
  backoffMs?: number;
}

export type AccountLogInput = Omit<AccountLogEvent, "id" | "seq" | "timestamp" | "accountId"> & {
  timestamp?: string;
};

export interface AccountLogListOptions {
  limit?: number;
  since?: number;
  level?: AccountLogLevel;
  category?: AccountLogCategory;
}

const DEFAULT_ACCOUNT_LIMIT = 300;
const DEFAULT_GLOBAL_LIMIT = 10_000;

export interface AccountLogStoreOptions {
  perAccountLimit?: number;
  globalLimit?: number;
}

export class AccountLogStore {
  private readonly perAccountLimit: number;
  private readonly globalLimit: number;
  private readonly byAccount = new Map<string, AccountLogEvent[]>();
  private readonly globalOrder: Array<{ accountId: string; seq: number }> = [];
  private seq = 0;

  constructor(options: AccountLogStoreOptions = {}) {
    this.perAccountLimit = options.perAccountLimit ?? DEFAULT_ACCOUNT_LIMIT;
    this.globalLimit = options.globalLimit ?? DEFAULT_GLOBAL_LIMIT;
  }

  append(accountId: string, input: AccountLogInput): AccountLogEvent {
    const seq = ++this.seq;
    const event: AccountLogEvent = {
      ...input,
      id: String(seq),
      seq,
      timestamp: input.timestamp ?? new Date().toISOString(),
      accountId,
      requestId: sanitizeRequestId(input.requestId),
      message: input.message == null ? undefined : sanitizeLogMessage(input.message),
    };

    const logs = this.byAccount.get(accountId) ?? [];
    logs.push(event);
    while (logs.length > this.perAccountLimit) logs.shift();
    this.byAccount.set(accountId, logs);

    this.globalOrder.push({ accountId, seq });
    this.trimGlobal();
    return event;
  }

  list(accountId: string, options: AccountLogListOptions = {}): { logs: AccountLogEvent[]; nextSince: number } {
    const limit = options.limit ?? 100;
    const since = options.since ?? 0;
    const logs = (this.byAccount.get(accountId) ?? [])
      .filter((event) => event.seq > since)
      .filter((event) => !options.level || event.level === options.level)
      .filter((event) => !options.category || event.category === options.category)
      .slice(-limit);
    const nextSince = logs.length > 0 ? logs[logs.length - 1].seq : since;
    return { logs, nextSince };
  }

  clear(accountId: string): void {
    this.byAccount.delete(accountId);
    for (let i = this.globalOrder.length - 1; i >= 0; i--) {
      if (this.globalOrder[i].accountId === accountId) this.globalOrder.splice(i, 1);
    }
  }

  clearAll(): void {
    this.byAccount.clear();
    this.globalOrder.length = 0;
  }

  private trimGlobal(): void {
    while (this.globalOrder.length > this.globalLimit) {
      const oldest = this.globalOrder.shift();
      if (!oldest) return;
      const logs = this.byAccount.get(oldest.accountId);
      if (!logs) continue;
      const index = logs.findIndex((event) => event.seq === oldest.seq);
      if (index >= 0) logs.splice(index, 1);
      if (logs.length === 0) this.byAccount.delete(oldest.accountId);
    }
  }
}
