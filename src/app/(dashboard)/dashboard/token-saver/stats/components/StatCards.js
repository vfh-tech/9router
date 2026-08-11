function fmt(n) {
  return n >= 1e6 ? `${(+n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(+n / 1e3).toFixed(1)}k` : `${n}`;
}

export default function StatCards({ windows, windowId }) {
  const w = windows?.[windowId];
  const items = [
    { label: "Requests", value: w ? fmt(w.requests) : "—", tone: "" },
    { label: "Applied", value: w ? fmt(w.applied) : "—", tone: "text-success" },
    { label: "Tokens saved", value: w ? fmt(w.savedTokens) : "—", tone: "text-success" },
    { label: "Savers active", value: w ? Object.keys(w.requestsPerSaver || {}).length : "—", tone: "" },
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {items.map((it) => (
        <div key={it.label} className="rounded-lg border border-border bg-bg-subtle p-4">
          <p className="text-xs text-text-muted">{it.label}</p>
          <p className={`text-2xl font-semibold ${it.tone}`}>{it.value}</p>
        </div>
      ))}
    </div>
  );
}