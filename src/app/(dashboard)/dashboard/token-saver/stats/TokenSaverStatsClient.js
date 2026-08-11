"use client";
import { useState, useCallback, useEffect } from "react";
import { Card, Button } from "@/shared/components";
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip,
  CartesianGrid, BarChart, Bar, Cell,
} from "recharts";
import StatCards from "./components/StatCards";

const WINDOWS = [
  { id: "today", label: "Today" }, { id: "last7d", label: "7d" },
  { id: "last30d", label: "30d" }, { id: "all", label: "All" },
];
const SAVER_COLORS = { rtk: "#10b981", headroom: "#3b82f6", caveman: "#f59e0b", ponytail: "#8b5cf6", pxpipe: "#ef4444" };
const fmtTokens = (n) => (n >= 1e6 ? `${(+n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(+n / 1e3).toFixed(1)}k` : `${n}`);

export default function TokenSaverStatsClient() {
  const [stats, setStats] = useState(null);
  const [windowId, setWindowId] = useState("all");
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/token-saver/stats", { headers: { "Cache-Control": "no-store" } });
      setStats(await res.json());
    } catch { /* render empty */ } finally { setLoading(false); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { const t = setInterval(refresh, 5000); return () => clearInterval(t); }, [refresh]);

  const hasData = stats?.timeline?.some((d) => d.savedTokens > 0);
  const bySaver = (stats?.bySaver || []).map((s) => ({ name: s.saver, saved: s.savedTokens }));
  const byProvider = (stats?.byProvider || []).slice(0, 8).map((b) => ({ name: b.provider, saved: b.savedTokens }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h3 className="font-medium flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">data_saver_on</span>
          Token Savings — Stats
        </h3>
        <div className="flex items-center gap-1 rounded-lg border border-border bg-bg-subtle p-1">
          {WINDOWS.map((tab) => (
            <button key={tab.id} onClick={() => setWindowId(tab.id)}
              className={`px-3 py-1 rounded-md text-xs font-medium ${windowId === tab.id ? "bg-primary text-white" : "text-text-muted hover:text-text"}`}>
              {tab.label}
            </button>
          ))}
        </div>
        <Button size="sm" variant="ghost" onClick={refresh} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</Button>
      </div>

      <StatCards windows={stats?.windows} windowId={windowId} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="p-4">
          <h4 className="text-sm font-medium mb-3">Tokens saved — last 30 days</h4>
          {hasData ? (
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={stats.timeline}>
                <defs><linearGradient id="gradTs" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#10b981" stopOpacity={0.25} /><stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                </linearGradient></defs>
                <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.2} />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(d) => d.slice(5)} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={fmtTokens} width={48} />
                <Tooltip formatter={(v) => [fmtTokens(v), "Tokens saved"]} />
                <Area type="monotone" dataKey="savedTokens" stroke="#10b981" fill="url(#gradTs)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-32 flex items-center justify-center text-text-muted text-sm">
              No savings recorded yet — route requests through the gateway with token savers enabled.
            </div>
          )}
        </Card>

        <Card className="p-4">
          <h4 className="text-sm font-medium mb-3">Saved by saver</h4>
          {bySaver.length ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={bySaver}>
                <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.2} />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={fmtTokens} width={48} />
                <Tooltip formatter={(v) => [fmtTokens(v), "Tokens saved"]} />
                <Bar dataKey="saved" radius={[4, 4, 0, 0]}>
                  {bySaver.map((s) => <Cell key={s.name} fill={SAVER_COLORS[s.name] || "#94a3b8"} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : <div className="h-32 flex items-center justify-center text-text-muted text-sm">No data yet</div>}
        </Card>
      </div>

      <Card className="p-4">
        <h4 className="text-sm font-medium mb-3">Saved by provider</h4>
        {byProvider.length ? (
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={byProvider} layout="vertical" margin={{ left: 8 }}>
              <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={fmtTokens} />
              <YAxis type="category" dataKey="name" width={90} tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v) => [fmtTokens(v), "Tokens saved"]} />
              <Bar dataKey="saved" fill="#3b82f6" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : <p className="text-sm text-text-muted">No data yet</p>}
      </Card>

      <Card className="p-4">
        <h3 className="font-medium mb-3">Recent activity</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-text-muted border-b border-border">
              <th className="py-2 pr-3">Time</th><th className="py-2 pr-3">Saver</th>
              <th className="py-2 pr-3">Provider</th><th className="py-2 pr-3 text-right">Saved</th>
              <th className="py-2 pr-3 text-right">%</th><th className="py-2">Status</th>
            </tr></thead>
            <tbody>
              {(stats?.recent || []).slice(0, 50).map((ev, i) => (
                <tr key={`${ev.ts}-${i}`} className="border-b border-border/50">
                  <td className="py-1.5 pr-3 whitespace-nowrap text-text-muted">{new Date(ev.ts).toLocaleString()}</td>
                  <td className="py-1.5 pr-3"><span className="text-xs px-2 py-0.5 rounded" style={{ background: `${SAVER_COLORS[ev.saver] || "#94a3b8"}22`, color: SAVER_COLORS[ev.saver] || "#94a3b8" }}>{ev.saver}</span></td>
                  <td className="py-1.5 pr-3 font-mono text-xs">{ev.provider ? `${ev.provider}/${ev.model || ""}` : "—"}</td>
                  <td className="py-1.5 pr-3 text-right font-mono text-xs text-success">{ev.applied ? fmtTokens(ev.savedTokens || ev.tokensSaved) : "—"}</td>
                  <td className="py-1.5 pr-3 text-right font-mono text-xs">{ev.applied && ev.savedPct ? `${ev.savedPct}%` : "—"}</td>
                  <td className="py-1.5"><span className={`text-xs px-2 py-0.5 rounded ${ev.applied ? "bg-success/15 text-success" : "bg-warning/15 text-warning"}`}>{ev.applied ? "Saved" : ev.reason || "Skipped"}</span></td>
                </tr>
              ))}
              {(!stats?.recent || stats.recent.length === 0) && (
                <tr><td colSpan={6} className="py-6 text-center text-text-muted text-sm">No activity yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}