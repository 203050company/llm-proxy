const TOKEN_PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]"],
  [/oaistb_rt_[A-Za-z0-9._~+/=-]+/g, "[REDACTED]"],
  [/oaistb_[A-Za-z0-9._~+/=-]+/g, "[REDACTED]"],
  [/sk-[A-Za-z0-9._-]+/g, "[REDACTED]"],
  [/(authorization|cookie|set-cookie|refresh_token|access_token|id_token|token)=([^\s&]+)/gi, "$1=[REDACTED]"],
  [/(https?:\/\/[^\s/@:]+:)[^\s/@]+(@)/gi, "$1[REDACTED]$2"],
];

const MAX_MESSAGE_LENGTH = 240;
const MAX_REQUEST_ID_LENGTH = 96;

function toLogMessage(value: unknown, fallback = "Unexpected error"): string {
  return typeof value === "string"
    ? value
    : value instanceof Error
      ? value.message
      : value == null
        ? fallback
        : String(value);
}

export interface SanitizedErrorSummary {
  errorClass: string;
  statusCode?: number;
  failureCode?: string;
  message: string;
}

export function sanitizeLogMessage(value: unknown, fallback = "Unexpected error"): string {
  const raw = toLogMessage(value, fallback);

  let sanitized = raw.replace(/[\r\n\t]+/g, " ").trim();
  for (const [pattern, replacement] of TOKEN_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }
  if (!sanitized) return fallback;
  if (sanitized.length > MAX_MESSAGE_LENGTH) {
    return `${sanitized.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
  }
  return sanitized;
}

export function sanitizeRequestId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const sanitized = value.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, MAX_REQUEST_ID_LENGTH);
  return sanitized || undefined;
}

export function summarizeError(error: unknown, statusCode?: number): SanitizedErrorSummary {
  const errorClass = error instanceof Error ? error.constructor.name : typeof error;
  const failureCode = extractFailureCode(toLogMessage(error));
  const message = sanitizeLogMessage(error);
  return {
    errorClass,
    ...(statusCode != null ? { statusCode } : {}),
    ...(failureCode ? { failureCode } : {}),
    message,
  };
}

export function extractFailureCode(message: string): string | undefined {
  const normalized = message.toLowerCase();
  const known = [
    "invalid_grant",
    "invalid_token",
    "access_denied",
    "refresh_token_expired",
    "refresh_token_invalidated",
    "refresh_token_reused",
    "account has been deactivated",
    "rate_limit_exceeded",
    "quota_exhausted",
  ];
  return known.find((code) => normalized.includes(code));
}
