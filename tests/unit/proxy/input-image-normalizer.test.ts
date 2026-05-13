import { describe, expect, it } from "vitest";

import { normalizeRequestInputImages } from "@src/proxy/input-image-normalizer.js";
import type { CodexResponsesRequest } from "@src/proxy/codex-types.js";

const GRAY_ALPHA_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+Vr9cAAAAASUVORK5CYII=";

function makeRequest(imageUrl: string): CodexResponsesRequest {
  return {
    model: "gpt-5.4",
    instructions: "describe image",
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: "Describe this image." },
        { type: "input_image", image_url: imageUrl },
      ],
    }],
    stream: true,
    store: false,
  };
}

describe("normalizeRequestInputImages", () => {
  it("re-encodes inline image data URLs to a backend-safe PNG", async () => {
    const request = makeRequest(GRAY_ALPHA_PNG);

    const normalized = await normalizeRequestInputImages(request);
    const message = normalized.input[0];
    if (!("role" in message) || typeof message.content === "string") {
      throw new Error("expected user message with content parts");
    }

    expect(message.content[1]).toMatchObject({ type: "input_image" });
    const part = message.content[1];
    if (part.type !== "input_image") {
      throw new Error("expected input_image part");
    }
    expect(part.image_url).toMatch(/^data:image\/png;base64,/);
    expect(part.image_url).not.toBe(GRAY_ALPHA_PNG);
  });

  it("leaves remote image URLs untouched", async () => {
    const remoteUrl = "https://example.com/image.jpg";
    const request = makeRequest(remoteUrl);

    const normalized = await normalizeRequestInputImages(request);

    expect(normalized).toEqual(request);
  });

  it("unwraps nested data URLs before normalizing", async () => {
    const nestedDataUrl =
      "data:image/png;base64,data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
    const request = makeRequest(nestedDataUrl);

    const normalized = await normalizeRequestInputImages(request);
    const message = normalized.input[0];
    if (!("role" in message) || typeof message.content === "string") {
      throw new Error("expected user message with content parts");
    }

    const part = message.content[1];
    if (part.type !== "input_image") {
      throw new Error("expected input_image part");
    }
    expect(part.image_url).toMatch(/^data:image\/png;base64,/);
    expect(part.image_url).not.toContain("data:image/png;base64,data:image/png;base64,");
  });

  it("drops unreadable image data URLs and substitutes a placeholder text part", async () => {
    // Valid base64, but the decoded bytes are not a real image — sharp will throw.
    const badDataUrl = "data:image/png;base64," + Buffer.from("not really an image").toString("base64");
    const request = makeRequest(badDataUrl);

    const normalized = await normalizeRequestInputImages(request);
    const message = normalized.input[0];
    if (!("role" in message) || typeof message.content === "string") {
      throw new Error("expected user message with content parts");
    }

    const part = message.content[1];
    expect(part.type).toBe("input_text");
    if (part.type !== "input_text") throw new Error("expected input_text");
    expect(part.text).toMatch(/could not decode/i);
  });

  it("unwraps base64-encoded data URL strings before normalizing", async () => {
    const encodedDataUrl =
      "data:image/png;base64," +
      Buffer.from(
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
        "utf8",
      ).toString("base64");
    const request = makeRequest(encodedDataUrl);

    const normalized = await normalizeRequestInputImages(request);
    const message = normalized.input[0];
    if (!("role" in message) || typeof message.content === "string") {
      throw new Error("expected user message with content parts");
    }

    const part = message.content[1];
    if (part.type !== "input_image") {
      throw new Error("expected input_image part");
    }
    expect(part.image_url).toMatch(/^data:image\/png;base64,/);
    expect(part.image_url).not.toContain(Buffer.from("data:image/png;base64", "utf8").toString("base64"));
  });
});
