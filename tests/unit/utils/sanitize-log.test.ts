import { describe, expect, it } from "vitest";
import { extractFailureCode, sanitizeLogMessage, sanitizeRequestId, summarizeError } from "@src/utils/sanitize-log.js";

describe("sanitizeLogMessage", () => {
  it("redacts bearer tokens, API keys, OpenAI session tokens, and refresh tokens", () => {
    const message = sanitizeLogMessage(
      "Bearer access.secret sk-project-secret oaistb_sessionsecret oaistb_rt_refreshsecret",
    );

    expect(message).not.toContain("access.secret");
    expect(message).not.toContain("sk-project-secret");
    expect(message).not.toContain("oaistb_sessionsecret");
    expect(message).not.toContain("oaistb_rt_refreshsecret");
    expect(message).toContain("Bearer [REDACTED]");
  });

  it("redacts token-like query and header values without preserving secrets", () => {
    const message = sanitizeLogMessage(
      "authorization=BearerToken123&refresh_token=rt_secret&access_token=at_secret&id_token=id_secret&cookie=sid_secret",
    );

    expect(message).toContain("authorization=[REDACTED]");
    expect(message).toContain("refresh_token=[REDACTED]");
    expect(message).toContain("access_token=[REDACTED]");
    expect(message).toContain("id_token=[REDACTED]");
    expect(message).toContain("cookie=[REDACTED]");
    expect(message).not.toContain("BearerToken123");
    expect(message).not.toContain("rt_secret");
    expect(message).not.toContain("at_secret");
    expect(message).not.toContain("id_secret");
    expect(message).not.toContain("sid_secret");
  });

  it("redacts proxy credentials from URLs", () => {
    const message = sanitizeLogMessage("proxy failed: https://user:password@example.com:8080/path");

    expect(message).toBe("proxy failed: https://user:[REDACTED]@example.com:8080/path");
    expect(message).not.toContain("password");
  });

  it("normalizes whitespace and truncates long messages", () => {
    const message = sanitizeLogMessage(`first\nsecond\t${"x".repeat(300)}`);

    expect(message).toMatch(/^first second/);
    expect(message).toHaveLength(240);
    expect(message.endsWith("…")).toBe(true);
  });

  it("uses fallback for nullish or blank values", () => {
    expect(sanitizeLogMessage(null, "fallback message")).toBe("fallback message");
    expect(sanitizeLogMessage("\n\t", "fallback message")).toBe("fallback message");
  });
});

describe("sanitizeRequestId", () => {
  it("keeps only safe request id characters and clamps length", () => {
    const sanitized = sanitizeRequestId(`req-1:abc.DEF_234/evil\n${"x".repeat(200)}`);

    expect(sanitized).toMatch(/^[A-Za-z0-9._:-]+$/);
    expect(sanitized).not.toContain("/");
    expect(sanitized).toHaveLength(96);
  });

  it("returns undefined for non-string or empty ids", () => {
    expect(sanitizeRequestId(123)).toBeUndefined();
    expect(sanitizeRequestId("!!!")).toBeUndefined();
  });
});

describe("summarizeError", () => {
  it("returns sanitized error class, status code, failure code, and message", () => {
    const summary = summarizeError(
      new Error("invalid_grant refresh_token=rt_secret"),
      401,
    );

    expect(summary.errorClass).toBe("Error");
    expect(summary.statusCode).toBe(401);
    expect(summary.failureCode).toBe("invalid_grant");
    expect(summary.message).toBe("invalid_grant refresh_token=[REDACTED]");
  });

  it("extracts refresh-token failure codes before truncating sanitized messages", () => {
    const summary = summarizeError(
      new Error(
        `Token refresh failed (401): {"error":{"message":"${"x".repeat(300)}","code":"refresh_token_reused"}}`,
      ),
      401,
    );

    expect(summary.message).toHaveLength(240);
    expect(summary.failureCode).toBe("refresh_token_reused");
  });
});

describe("extractFailureCode", () => {
  it("detects known failure codes case-insensitively", () => {
    expect(extractFailureCode("OAuth INVALID_TOKEN response")).toBe("invalid_token");
    expect(extractFailureCode("quota_exhausted for account")).toBe("quota_exhausted");
    expect(extractFailureCode("refresh_token_invalidated from oauth")).toBe("refresh_token_invalidated");
  });
});
