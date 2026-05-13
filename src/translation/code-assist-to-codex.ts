export function unwrapCodeAssistResponse(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const record = payload as Record<string, unknown>;
  return record.response ?? payload;
}
