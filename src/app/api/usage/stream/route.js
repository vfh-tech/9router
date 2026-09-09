import { statsEmitter, getActiveRequests } from "@/lib/usageDb";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const encoder = new TextEncoder();
  const state = { closed: false, keepalive: null, send: null, sendPending: null, cachedStats: null };

  // Idempotent: safe to call from request.signal abort, cancel(), or enqueue failure.
  const cleanup = () => {
    if (state.closed) return;
    state.closed = true;
    if (state.send) statsEmitter.off("update", state.send);
    if (state.sendPending) statsEmitter.off("pending", state.sendPending);
    if (state.keepalive) clearInterval(state.keepalive);
  };

  // request.signal fires reliably on client disconnect; ReadableStream.cancel()
  // is not always invoked in Next.js, which caused listeners to accumulate.
  request.signal.addEventListener("abort", cleanup, { once: true });

  const stream = new ReadableStream({
    async start(controller) {
      // Lightweight-only push: the SSE client (UsageStats.js) merges just
      // activeRequests/recentRequests/errorProvider/pending — the full breakdown
      // comes from GET /api/usage/stats. Running the heavy getUsageStats() scan
      // here re-scanned the whole usageHistory table per update for data the
      // client discarded, interleaving with stream chunk processing.
      const push = async () => {
        if (state.closed) return;
        try {
          const { activeRequests, recentRequests, errorProvider } = await getActiveRequests();
          const stats = { ...state.cachedStats, activeRequests, recentRequests, errorProvider };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(stats)}\n\n`));
        } catch {
          cleanup();
        }
      };

      state.send = push;
      // sendPending: same lightweight payload; skip before first push (no cache yet)
      state.sendPending = () => (state.cachedStats ? push() : Promise.resolve());

      // Seed cache with the 4 mergeable fields only (no heavy stats scan)
      try {
        const live = await getActiveRequests();
        state.cachedStats = {
          activeRequests: live.activeRequests,
          recentRequests: live.recentRequests,
          errorProvider: live.errorProvider,
        };
      } catch { /* first push will retry */ }
      await push();

      statsEmitter.on("update", state.send);
      statsEmitter.on("pending", state.sendPending);

      state.keepalive = setInterval(() => {
        if (state.closed) { clearInterval(state.keepalive); return; }
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          cleanup();
        }
      }, 25000);
    },

    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}