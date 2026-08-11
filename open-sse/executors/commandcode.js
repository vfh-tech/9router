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
    result.response = await inspectAndWrapCommandCodeResponse(result.response, opts.model);
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

  parseError(response, bodyText) {
    let parsed = null;
    try {
      parsed = JSON.parse(bodyText || "{}");
    } catch {
      parsed = null;
    }
    const errObj = parsed?.error || parsed;
    const msg = errObj?.message || parsed?.message || bodyText || response.statusText;
    const status = Number(errObj?.code || errObj?.statusCode || response.status) || response.status;
    // 429 body names the reset window ("Resets in 2h 41m"); expose the exact
    // reset epoch so quota tracking can surface it instead of a fixed cooldown.
    let resetsAtMs;
    if (status === 429 && msg) {
      const match = msg.match(/Resets in (\d+h)?\s*(\d+m)?/i);
      if (match) {
        let totalMs = 0;
        if (match[1]) totalMs += parseInt(match[1]) * 3600 * 1000;
        if (match[2]) totalMs += parseInt(match[2]) * 60 * 1000;
        if (totalMs > 0) resetsAtMs = Date.now() + totalMs;
      }
    }
    return {
      status,
      message: msg || `CommandCode upstream error: ${response.status}`,
      ...(resetsAtMs ? { resetsAtMs } : {}),
    };
  }
}

export function parseCommandCodeError(event) {
  if (!event || typeof event !== "object") {
    return {
      statusCode: 503,
      message: "CommandCode upstream error",
      type: "server_error",
    };
  }

  const errVal = event.error ?? event.message ?? "unknown";
  let message = "";
  let statusCode = null;
  let type = "server_error";

  if (typeof errVal === "object" && errVal !== null) {
    message = errVal.message || errVal.error || JSON.stringify(errVal);
    if (errVal.statusCode && Number.isInteger(Number(errVal.statusCode))) {
      statusCode = Number(errVal.statusCode);
    } else if (errVal.status && Number.isInteger(Number(errVal.status))) {
      statusCode = Number(errVal.status);
    }
    if (errVal.type) type = errVal.type;
  } else if (typeof errVal === "string") {
    message = errVal;
  } else {
    message = JSON.stringify(errVal);
  }

  if (event.statusCode && Number.isInteger(Number(event.statusCode))) {
    statusCode = Number(event.statusCode);
  }

  if (!statusCode || statusCode < 400 || statusCode > 599) {
    const lower = message.toLowerCase();
    if (lower.includes("rate limit") || lower.includes("too many requests")) {
      statusCode = 429;
      type = "rate_limit_error";
    } else if (lower.includes("unauthorized") || lower.includes("invalid api key") || lower.includes("authentication")) {
      statusCode = 401;
      type = "authentication_error";
    } else if (lower.includes("payment required") || lower.includes("billing")) {
      statusCode = 402;
      type = "billing_error";
    } else if (lower.includes("quota") || lower.includes("forbidden") || lower.includes("permission")) {
      statusCode = 403;
      type = "permission_error";
    } else if (lower.includes("not found")) {
      statusCode = 404;
      type = "invalid_request_error";
    } else if (lower.includes("unavailable") || lower.includes("overloaded") || lower.includes("server error")) {
      statusCode = 503;
      type = "server_error";
    } else {
      statusCode = 503;
    }
  }

  return { statusCode, message, type };
}

export async function inspectAndWrapCommandCodeResponse(originalResponse, model) {
  const reader = originalResponse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const bufferedLines = [];
  let detectedError = null;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        const trimmed = buffer.trim();
        if (trimmed) {
          try {
            const jsonStr = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
            const parsed = JSON.parse(jsonStr);
            if (parsed?.type === "error") {
              detectedError = parsed;
            } else {
              bufferedLines.push(trimmed);
            }
          } catch {
            bufferedLines.push(trimmed);
          }
        }
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      let stopLoop = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const jsonStr = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
        if (!jsonStr || jsonStr === "[DONE]") {
          bufferedLines.push(trimmed);
          stopLoop = true;
          break;
        }

        let event;
        try {
          event = JSON.parse(jsonStr);
        } catch {
          bufferedLines.push(trimmed);
          continue;
        }

        if (event?.type === "error") {
          detectedError = event;
          stopLoop = true;
          break;
        }

        bufferedLines.push(trimmed);

        if (
          event?.type === "text-delta" ||
          event?.type === "reasoning-delta" ||
          event?.type === "tool-input-start" ||
          event?.type === "tool-call" ||
          event?.type === "finish" ||
          event?.type === "finish-step"
        ) {
          stopLoop = true;
          break;
        }
      }

      if (stopLoop) break;
    }
  } catch {
    try { reader.releaseLock(); } catch { /* ignore */ }
    return originalResponse;
  }

  if (detectedError) {
    try { await reader.cancel(); } catch { /* ignore */ }
    const { statusCode, message, type } = parseCommandCodeError(detectedError);
    return new Response(
      JSON.stringify({
        error: {
          message: `[CommandCode error: ${message}]`,
          type,
          code: statusCode,
        },
      }),
      {
        status: statusCode,
        statusText: statusCode === 503 ? "Service Unavailable" : (statusCode === 429 ? "Too Many Requests" : "Bad Gateway"),
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  const combinedStream = createReplayedStream(bufferedLines, buffer, reader);
  return wrapNdjsonAsOpenAISse(combinedStream, model, originalResponse);
}

function createReplayedStream(bufferedLines, remainingBuffer, reader) {
  const encoder = new TextEncoder();
  let replayed = false;

  return new ReadableStream({
    async pull(controller) {
      if (!replayed) {
        replayed = true;
        let prefix = bufferedLines.join("\n");
        if (prefix && remainingBuffer) {
          prefix += "\n" + remainingBuffer;
        } else if (remainingBuffer) {
          prefix = remainingBuffer;
        } else if (prefix) {
          prefix += "\n";
        }
        if (prefix) {
          controller.enqueue(encoder.encode(prefix));
        }
      }

      try {
        const { value, done } = await reader.read();
        if (done) {
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } catch {
        /* ignore */
      }
    },
  });
}

function wrapNdjsonAsOpenAISse(streamBody, model, originalResponse = null) {
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

  const newBody = streamBody.pipeThrough(transform);
  return new Response(newBody, {
    status: originalResponse?.status || 200,
    statusText: originalResponse?.statusText || "OK",
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      ...(originalResponse?.headers ? Object.fromEntries(originalResponse.headers.entries()) : {}),
      "content-type": "text/event-stream",
    },
  });
}

export default CommandCodeExecutor;
