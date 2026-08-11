# Token Saver Dashboard — Design

## Problem

5 token saver (RTK, Headroom, Caveman, Ponytail, PXPIPE) berjalan di `open-sse/handlers/chatCore.js` sebelum dispatch. Hanya PXPIPE yang mempersist event (`events.jsonl`). RTK/Headroom/Caveman/Ponytail hanya `console.log` — tanpa data historis. Dashboard "hasil saving token" tidak dapat dibangun tanpa data.

## Scope

Bangun:
1. **Event store terpadu** untuk semua 5 saver (metadata saja, tanpa konten).
2. **Stats API** agregat.
3. **Dashboard UI interaktif** di halaman `/dashboard/token-saver` yang sudah ada.

Non-goal: membandingkan kebenaran algoritma tiap saver; UI konfigurasi (sudah ada di page yang sama); mengubah perilaku saver.

## Data model

Event (JSONL, satu event per request-saver, metadata only):

```js
{
  ts: number,            // Date.now()
  saver: "rtk"|"headroom"|"caveman"|"ponytail"|"pxpipe",
  provider: string|null,
  model: string|null,
  connectionId: string|null,
  applied: boolean,
  reason: string|null,   // headroom/pxpipe skip reason
  bytesBefore: number,   // rtk
  bytesAfter: number,    // rtk
  savedBytes: number,    // rtk
  tokensBefore: number,  // headroom/pxpipe est
  tokensAfter: number,
  tokensSaved: number,
  savedPct: number,
  filters: string[],     // rtk: filter names used
  hits: number,          // rtk: count of compressed blocks
  level: string|null,    // caveman/ponytail
  imageCount: number,    // pxpipe
  durationMs: number,
}
```

## Files

### New
- `src/lib/tokenSaver/events.js` — append/read/aggregate (reuse pola `src/lib/pxpipe/events.js`). Dir `~/.9router/token-saver/`, rotate @5MB.
- `src/app/api/token-saver/stats/route.js` — `GET ?range=&saver=&provider=` → `{ windows, timeline, bySaver, byProvider, byModel, recent }`.
- `src/app/(dashboard)/dashboard/token-saver/stats/page.js` + `TokenSaverStatsClient.js` + `components/` (StatCards, charts, table).

### Modified
- `open-sse/handlers/chatCore.js` — collect summary tiap saver → `onTokenSaverEvent()`. Tambah param `onTokenSaverEvent`.
- `src/sse/handlers/chat.js` — wire `onTokenSaverEvent: appendTokenSaverEvent`.
- `src/dashboardGuard.js` — allow `/api/token-saver/stats`.

### Location decision
Dashboard UI **di halaman yang sudah ada** `/dashboard/token-saver` (page.tsx render `TokenSaverClient`). Namun `TokenSaverClient.js` (1015 baris) adalah page konfigurasi. Tambahkan **tab** "Stats" di page itu: tab default "Settings" (komponen yang ada), tab kedua "Stats" → `TokenSaverStatsClient`. Ini menjaga satu route, tidak menambah entri sidebar, dan memenuhi "halaman di sini dashboard/token-saver".

## Wiring

Di `chatCore.js`, area token saver (baris ~230-260). Setelah tiap saver jalan, bangun event:
- RTK: `{ saver:"rtk", bytesBefore, bytesAfter, savedBytes, filters, hits, applied: hits>0 }`.
- Headroom: dari `headroomStats` (`applied/reason/tokensBefore/tokensAfter/tokensSaved/savedPct`).
- Caveman/Ponytail: `{ saver, level, applied:true }`.
- PXPIPE: dari `pxpipeSummary` (sudah punya `tokensBeforeEst/tokensAfterEst/tokensSavedEst/savedPct/imageCount/durationMs`).

Enrich dengan `provider`, `model`, `connectionId` (sudah di scope). Satu `onTokenSaverEvent(ev)` per saver yang berjalan. Fail-open: `onTokenSaverEvent` dibungkus try/catch, tak pernah break request.

## API response shape

```json
{
  "windows": {
    "all|today|yesterday|last7d|last30d": {
      "requests", "applied", "savedTokens", "savedPct",
      "requestsPerSaver": { "rtk": 0, ... }, "savedTokensPerSaver": { ... }
    }
  },
  "timeline": [ { "date": "2026-08-11", "savedTokens": 0, "applied": 0, "requests": 0 } ],
  "bySaver": [ { "saver": "rtk", "requests", "applied", "savedTokens" } ],
  "byProvider": [ { "provider": "claude", "requests", "applied", "savedTokens" } ],
  "recent": [ ...events desc ]
}
```

## Error handling

- Event store: 100% fail-open — try/catch di append (async, fire-and-forget), read tahan line corrupt, tak pernah blokir request.
- API: tak ada data → windows nol + array kosong; UI render empty state, bukan error.
- NaN guard di agregat (`savedPct` jika `tokensBefore` 0).

## Testing

- `tests/unit/token-saver-events.test.js`: append→read roundtrip, rotate, filter by saver/provider, agregat windows/timeline/bySaver.
- Lint: `npx eslint` pada file baru/ubah.

## Open questions

- Rangkaian event per request: satu event per saver yang jalan (bisa 3-5 event per request bila semua aktif). Fine — volume kecil.
- `recent` cap: 100 event default, `limit` param max 500.