import { describe, it, expect } from "vitest";
import { translateCodexToOpenAIRequest } from "@src/translation/codex-request-to-openai.js";
import type { CodexResponsesRequest } from "@src/proxy/codex-types.js";

function makeBaseRequest(overrides: Partial<CodexResponsesRequest> = {}): CodexResponsesRequest {
  return {
    model: "gpt-4o",
    input: [],
    stream: true,
    store: false,
    ...overrides,
  };
}

describe("translateCodexToOpenAIRequest", () => {
  it("maps basic user message to messages array", () => {
    const req = makeBaseRequest({
      input: [{ role: "user", content: "Hello" }],
    });
    const result = translateCodexToOpenAIRequest(req, "gpt-4o", true);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual({ role: "user", content: "Hello" });
  });

  it("prepends instructions as system message", () => {
    const req = makeBaseRequest({
      instructions: "You are helpful.",
      input: [{ role: "user", content: "Hi" }],
    });
    const result = translateCodexToOpenAIRequest(req, "gpt-4o", false);
    expect(result.messages[0]).toEqual({ role: "system", content: "You are helpful." });
    expect(result.messages[1]).toEqual({ role: "user", content: "Hi" });
  });

  it("converts function_call to assistant tool_calls", () => {
    const req = makeBaseRequest({
      input: [
        { role: "user", content: "Call the function" },
        {
          type: "function_call",
          call_id: "call_123",
          name: "my_func",
          arguments: '{"x":1}',
        },
      ],
    });
    const result = translateCodexToOpenAIRequest(req, "gpt-4o", false);
    const assistantMsg = result.messages.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg?.tool_calls).toHaveLength(1);
    expect(assistantMsg?.tool_calls![0]).toMatchObject({
      id: "call_123",
      type: "function",
      function: { name: "my_func", arguments: '{"x":1}' },
    });
  });

  it("converts function_call_output to tool role message", () => {
    const req = makeBaseRequest({
      input: [
        {
          type: "function_call",
          call_id: "call_abc",
          name: "fn",
          arguments: "{}",
        },
        {
          type: "function_call_output",
          call_id: "call_abc",
          output: "result data",
        },
      ],
    });
    const result = translateCodexToOpenAIRequest(req, "gpt-4o", false);
    const toolMsg = result.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.tool_call_id).toBe("call_abc");
    expect(toolMsg?.content).toBe("result data");
  });

  it("adds stream_options.include_usage when streaming", () => {
    const req = makeBaseRequest({ input: [{ role: "user", content: "hi" }] });
    const streaming = translateCodexToOpenAIRequest(req, "gpt-4o", true);
    expect(streaming.stream_options).toEqual({ include_usage: true });

    const nonStreaming = translateCodexToOpenAIRequest(req, "gpt-4o", false);
    expect(nonStreaming.stream_options).toBeUndefined();
  });

  it("maps reasoning.effort to reasoning_effort", () => {
    const req = makeBaseRequest({
      input: [{ role: "user", content: "think" }],
      reasoning: { effort: "high" },
    });
    const result = translateCodexToOpenAIRequest(req, "o3", false);
    expect(result.reasoning_effort).toBe("high");
  });

  it("passes tools and tool_choice through", () => {
    const tools = [{ type: "function" as const, function: { name: "fn", parameters: {} } }];
    const req = makeBaseRequest({
      input: [{ role: "user", content: "use tool" }],
      tools,
      tool_choice: "auto",
    });
    const result = translateCodexToOpenAIRequest(req, "gpt-4o", false);
    expect(result.tools).toEqual(tools);
    expect(result.tool_choice).toBe("auto");
  });

  it("maps text.format to response_format", () => {
    const req = makeBaseRequest({
      input: [{ role: "user", content: "json" }],
      text: { format: { type: "json_object" } },
    });
    const result = translateCodexToOpenAIRequest(req, "gpt-4o", false);
    expect(result.response_format).toEqual({ type: "json_object" });
  });

  it("validates tool_calls ordering - drops orphaned tool messages", () => {
    const req = makeBaseRequest({
      input: [
        {
          type: "function_call",
          call_id: "call_1",
          name: "func_a",
          arguments: "{}",
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "result",
        },
        // Orphaned tool message without matching assistant tool_call
        {
          type: "function_call_output",
          call_id: "call_orphan",
          output: "orphan result",
        },
      ],
    });
    const result = translateCodexToOpenAIRequest(req, "gpt-4o", false);
    const toolMessages = result.messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0].tool_call_id).toBe("call_1");
  });

  it("validates tool_calls ordering - handles multiple assistant turns", () => {
    const req = makeBaseRequest({
      input: [
        {
          type: "function_call",
          call_id: "call_1",
          name: "func_a",
          arguments: "{}",
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "result",
        },
        { role: "user", content: "next" },
        {
          type: "function_call",
          call_id: "call_2",
          name: "func_b",
          arguments: "{}",
        },
        {
          type: "function_call_output",
          call_id: "call_2",
          output: "result2",
        },
      ],
    });
    const result = translateCodexToOpenAIRequest(req, "gpt-4o", false);
    const assistantMessages = result.messages.filter((m) => m.role === "assistant");
    const toolMessages = result.messages.filter((m) => m.role === "tool");
    expect(assistantMessages).toHaveLength(2);
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0].tool_call_id).toBe("call_1");
    expect(toolMessages[1].tool_call_id).toBe("call_2");
  });
});
