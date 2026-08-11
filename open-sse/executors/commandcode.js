import { randomUUID } from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { commandCodeToOpenAIResponse } from "../translator/response/commandcode-to-openai.js";
import { SSE_DONE } from "../utils/sseConstants.js";

/**
 * CommandCodeExecutor — talks to https://api.commandcode.ai/alpha/generate
 *
 * Auth: Bearer <user_xxx> API key (stored as the connection's apiKey).
 * Adds the per-request `x-session-id` header expected by CommandCode upstream.
 *
 * Upstream returns AI SDK v5 NDJSON (one JSON event per line, no `data:` prefix).
 * We translate each event to an OpenAI chat.completion.chunk and emit it as SSE so
 * both the streaming and non-streaming (forced SSE → JSON) downstream handlers in
 * 9router can consume it without further format translation.
 */
export class CommandCodeExecutor extends BaseExecutor {
  constructor() {
    super("commandcode", PROVIDERS.commandcode);
  }

  transformRequest(model, body, stream, credentials) {
    body.stream = true;
    return body;
  }

  buildHeaders(credentials, stream = true) {
    const headers = {
      "Content-Type": "application/json",
      ...(this.config.headers || {}),
      "x-session-id": randomUUID(),
    };

    const token = credentials?.apiKey || credentials?.accessToken;
    if (token) headers["Authorization"] = `Bearer ${token}`;

    if (stream) headers["Accept"] = "text/event-stream";
    return headers;
  }

  async execute(opts) {
    const result = await super.execute(opts);
    if (!result?.response?.ok || !result.response.body) return result;
    result.response = wrapNdjsonAsOpenAISse(result.response, opts.model);
    return result;
  }

  /**
   * CommandCode has no public usage REST endpoint. When a plan window or
   * monthly pool is exhausted it errors with a message naming the reset, e.g.
   *   "You've reached your 5-hour usage limit. Resets in 2h 41m (3:00 PM)."
   *   "...full credit allocation for your current billing period."
   * Parse that reset as the retry wait so the caller surfaces the real reset
   * time instead of a fixed backoff. Returns null when no reset is named
   * (fall back to default retry), false when the message is a hard limit
   * (do not transparently retry through the window).
   */
  async computeRetryDelay(response, attempt, defaultDelayMs) {
    if (response.status !== 429) return null;

    let bodyText = "";
    try {
      bodyText = await response.clone().text();
    } catch {
      return null;
    }

    const match = bodyText.match(/Resets in (\d+h)?\s*(\d+m)?(?:\s*\([^)]*\))?/i)
      || bodyText.match(/billing period/i);
    if (!match) return null;

    if (match[0] && /billing period/i.test(match[0])) {
      // Monthly pool exhausted — retrying within the window never helps.
      return false;
    }

    let totalMs = 0;
    if (match[1]) totalMs += parseInt(match[1]) * 3600 * 1000;
    if (match[2]) totalMs += parseInt(match[2]) * 60 * 1000;
    return totalMs > 0 ? Math.min(totalMs, 6 * 3600 * 1000) : null;
  }

  // 429 body names the reset window ("Resets in 2h 41m"); expose the exact
  // reset epoch so quota tracking can surface it instead of a fixed cooldown.
  parseError(response, bodyText) {
    if (response.status !== 429 || !bodyText) return null;
    const match = bodyText.match(/Resets in (\d+h)?\s*(\d+m)?/i);
    if (!match) return null;
    let totalMs = 0;
    if (match[1]) totalMs += parseInt(match[1]) * 3600 * 1000;
    if (match[2]) totalMs += parseInt(match[2]) * 60 * 1000;
    if (totalMs <= 0) return null;
    return { status: 429, message: bodyText, resetsAtMs: Date.now() + totalMs };
  }
}

function wrapNdjsonAsOpenAISse(originalResponse, model) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const state = { model };

  const emitChunks = (chunks, controller) => {
    if (!chunks) return;
    const list = Array.isArray(chunks) ? chunks : [chunks];
    for (const c of list) {
      if (c == null) continue;
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(c)}\n\n`));
    }
  };

  const transform = new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // Translate AI SDK v5 NDJSON line to one or more OpenAI chunks
        emitChunks(commandCodeToOpenAIResponse(trimmed, state), controller);
      }
    },
    flush(controller) {
      const trimmed = buffer.trim();
      if (trimmed) {
        emitChunks(commandCodeToOpenAIResponse(trimmed, state), controller);
      }
      controller.enqueue(encoder.encode(SSE_DONE));
    },
  });

  const newBody = originalResponse.body.pipeThrough(transform);
  return new Response(newBody, {
    status: originalResponse.status,
    statusText: originalResponse.statusText,
    headers: originalResponse.headers,
  });
}

export default CommandCodeExecutor;
