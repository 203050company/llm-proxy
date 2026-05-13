import { describe, expect, it } from "vitest";
import { extractCodeAssistUsage, translateCodexToCodeAssistRequest } from "@src/translation/codex-request-to-code-assist.js";
import type { CodexResponsesRequest } from "@src/proxy/codex-types.js";

describe("Code Assist translation", () => {
  it("wraps a Codex request in Code Assist generateContent shape", () => {
    const req: CodexResponsesRequest = {
      model: "gemini-3.1-pro",
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      stream: true,
      store: false,
    };

    const out = translateCodexToCodeAssistRequest(req, {
      projectId: "project-1",
      sessionId: "session-1",
      userPromptId: "prompt-1",
    });

    expect(out.model).toBe("gemini-3.1-pro-preview");
    expect(out.project).toBe("project-1");
    expect(out.user_prompt_id).toBe("prompt-1");
    expect(out.request.session_id).toBe("session-1");
    expect(out.request.contents[0].role).toBe("user");
  });

  it("inlines instructions into contents instead of sending system_instruction", () => {
    const req: CodexResponsesRequest = {
      model: "gemini-3.1-flash-lite",
      instructions: "You are a helpful assistant.",
      input: [{ role: "user", content: "hello" }],
      stream: true,
      store: false,
    };

    const out = translateCodexToCodeAssistRequest(req, {
      projectId: "project-1",
      sessionId: "session-1",
      userPromptId: "prompt-1",
    });

    expect(out.request.system_instruction).toBeUndefined();
    expect(out.request.contents[0]).toEqual({
      role: "user",
      parts: [
        { text: "You are a helpful assistant.\n\nhello" },
      ],
    });
  });

  it("passes max output tokens to Gemini generationConfig", () => {
    const req = {
      model: "gemini-3.1-pro",
      input: [{ role: "user", content: "hello" }],
      stream: true,
      store: false,
      max_output_tokens: 321,
    } as CodexResponsesRequest & { max_output_tokens: number };

    const out = translateCodexToCodeAssistRequest(req, {
      projectId: "project-1",
      sessionId: "session-1",
      userPromptId: "prompt-1",
    });

    expect(out.request.generationConfig).toMatchObject({
      maxOutputTokens: 321,
    });
  });

  it("converts flat Codex tools to Gemini function declarations", () => {
    const req: CodexResponsesRequest = {
      model: "gemini-3.1-pro",
      input: [{ role: "user", content: "hello" }],
      stream: true,
      store: false,
      tools: [
        {
          type: "function",
          name: "read_file",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
      ],
    };

    const out = translateCodexToCodeAssistRequest(req, {
      projectId: "project-1",
      sessionId: "session-1",
      userPromptId: "prompt-1",
    });

    expect(out.request.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: "read_file",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
            },
          },
        ],
      },
    ]);
  });

  it("removes JSON Schema keywords unsupported by Gemini function declarations", () => {
    const req: CodexResponsesRequest = {
      model: "gemini-3.1-pro",
      input: [{ role: "user", content: "hello" }],
      stream: true,
      store: false,
      tools: [
        {
          type: "function",
          name: "run_shell",
          parameters: {
            $schema: "http://json-schema.org/draft-07/schema#",
            type: "object",
            additionalProperties: false,
            properties: {
              timeout: {
                type: "number",
                exclusiveMinimum: 0,
                minimum: 1,
              },
              options: {
                type: "object",
                default: {},
                additionalProperties: false,
                propertyNames: { pattern: "^[a-z_]+$" },
                properties: {
                  cwd: { type: "string" },
                  mode: { const: "safe" },
                },
              },
            },
          },
        },
      ],
    };

    const out = translateCodexToCodeAssistRequest(req, {
      projectId: "project-1",
      sessionId: "session-1",
      userPromptId: "prompt-1",
    });

    expect(out.request.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: "run_shell",
            parameters: {
              type: "object",
              properties: {
                timeout: {
                  type: "number",
                  minimum: 1,
                },
                options: {
                  type: "object",
                  properties: {
                    cwd: { type: "string" },
                    mode: {},
                  },
                },
              },
            },
          },
        ],
      },
    ]);
  });

  it("maps public Gemini aliases to Code Assist preview model IDs", () => {
    const baseReq: CodexResponsesRequest = {
      model: "gemini-3.1-pro",
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      stream: true,
      store: false,
    };

    const context = {
      projectId: "project-1",
      sessionId: "session-1",
      userPromptId: "prompt-1",
    };

    expect(translateCodexToCodeAssistRequest({ ...baseReq, model: "gemini-3.1-pro" }, context).model)
      .toBe("gemini-3.1-pro-preview");
    expect(translateCodexToCodeAssistRequest({ ...baseReq, model: "gemini-3-pro" }, context).model)
      .toBe("gemini-3-pro-preview");
    expect(translateCodexToCodeAssistRequest({ ...baseReq, model: "gemini-3.1-flash-lite" }, context).model)
      .toBe("gemini-3.1-flash-lite-preview");
    expect(translateCodexToCodeAssistRequest({ ...baseReq, model: "gemini-3.1-pro-preview" }, context).model)
      .toBe("gemini-3.1-pro-preview");
  });

  it("extracts usage metadata from Code Assist responses", () => {
    expect(extractCodeAssistUsage({
      response: {
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 5 },
      },
    })).toEqual({ input_tokens: 3, output_tokens: 5 });
  });
});
