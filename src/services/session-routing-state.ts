export interface SessionRoutingRecordInput {
  sessionId?: string | null;
  provider: string;
  requestedModel: string;
  actualModel: string;
  accountId?: string | null;
  accountEmail?: string | null;
  status?: number | null;
}

export interface SessionRoutingRecord extends SessionRoutingRecordInput {
  sessionId: string | null;
  updatedAt: string;
}

const MAX_RECORDS = 100;

let recentRecords: SessionRoutingRecord[] = [];
const recordsBySession = new Map<string, SessionRoutingRecord>();

export function recordSessionRouting(input: SessionRoutingRecordInput): SessionRoutingRecord {
  const record: SessionRoutingRecord = {
    ...input,
    sessionId: input.sessionId ?? null,
    updatedAt: new Date().toISOString(),
  };

  recentRecords.push(record);
  if (record.sessionId) recordsBySession.set(record.sessionId, record);

  while (recentRecords.length > MAX_RECORDS) {
    const removed = recentRecords.shift();
    if (removed?.sessionId && recordsBySession.get(removed.sessionId) === removed) {
      recordsBySession.delete(removed.sessionId);
    }
  }

  return record;
}

export function getLatestSessionRouting(options: {
  sessionId?: string | null;
  provider?: string | null;
} = {}): SessionRoutingRecord | null {
  const provider = normalizeFilter(options.provider);
  const sessionId = normalizeFilter(options.sessionId);

  if (sessionId) {
    const exact = recordsBySession.get(sessionId);
    if (exact && providerMatches(exact.provider, provider)) return exact;
  }

  for (let i = recentRecords.length - 1; i >= 0; i--) {
    const record = recentRecords[i];
    if (providerMatches(record.provider, provider)) return record;
  }

  return null;
}

export function clearSessionRoutingRecords(): void {
  recentRecords = [];
  recordsBySession.clear();
}

function normalizeFilter(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function providerMatches(provider: string, filter: string | null): boolean {
  if (!filter) return true;
  if (filter === "gemini") return provider === "gemini" || provider.startsWith("gemini-");
  return provider === filter;
}
