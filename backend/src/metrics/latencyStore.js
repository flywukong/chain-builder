/**
 * LatencyStore — app-side rolling 24h cache of aggregate insert-latency samples.
 *
 * Instead of asking keter for avg_over_time[24h] (heavy), we sample the current
 * per-instance latency each poll, compute p50/p95/p99 across nodes, and append to
 * a rolling 24h buffer (persisted to disk so the baseline survives restarts).
 * The 24h baseline is just the mean of the buffer.
 */

import fs from "fs";
import path from "path";

function pct(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.round(p * (sorted.length - 1)));
  return sorted[i];
}
function mean(arr) {
  const v = arr.filter((x) => x != null);
  return v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length) : null;
}

export class LatencyStore {
  constructor(file, { windowMs = 24 * 3600 * 1000, viewPoints = 120 } = {}) {
    this.file = file;
    this.windowMs = windowMs;
    this.viewPoints = viewPoints;
    this.samples = [];
    this._load();
  }

  _load() {
    try { if (fs.existsSync(this.file)) this.samples = JSON.parse(fs.readFileSync(this.file, "utf8")) || []; }
    catch { this.samples = []; }
  }
  _save() {
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.samples)); }
    catch { /* non-fatal */ }
  }

  // values: array of per-instance latency numbers (ms)
  addSample(t, values) {
    const vals = (values ?? []).filter((v) => typeof v === "number" && isFinite(v));
    if (!vals.length) return;
    const s = [...vals].sort((a, b) => a - b);
    this.samples.push({ t, p50: pct(s, 0.5), p95: pct(s, 0.95), p99: pct(s, 0.99), avg: mean(vals), n: vals.length });
    const cutoff = t - this.windowMs;
    if (this.samples.length && this.samples[0].t < cutoff) this.samples = this.samples.filter((x) => x.t >= cutoff);
    this._save();
  }

  getView() {
    if (!this.samples.length) return null;
    const recent = this.samples.slice(-this.viewPoints);
    return {
      times: recent.map((s) => s.t),
      p50:   recent.map((s) => s.p50),
      p95:   recent.map((s) => s.p95),
      p99:   recent.map((s) => s.p99),
      baseline24h: { p50: mean(this.samples.map((s) => s.p50)), p95: mean(this.samples.map((s) => s.p95)), p99: mean(this.samples.map((s) => s.p99)) },
      nodes: recent.at(-1)?.n ?? 0,
      spanHours: Math.round(((this.samples.at(-1).t - this.samples[0].t) / 3600000) * 10) / 10,
    };
  }
}
