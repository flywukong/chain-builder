/**
 * TxpoolStore — app-side rolling 24h cache of dataseed pending-tx, with
 * traffic-anomaly detection (avg pending > threshold).
 *
 * Samples avg/max pending across dataseed nodes each poll, keeps 24h (persisted),
 * and groups consecutive over-threshold samples into anomaly windows.
 */

import fs from "fs";
import path from "path";

const mean = (a) => (a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : 0);

export class TxpoolStore {
  constructor(file, { windowMs = 24 * 3600 * 1000, viewPoints = 120, threshold = 4000 } = {}) {
    this.file = file;
    this.windowMs = windowMs;
    this.viewPoints = viewPoints;
    this.threshold = threshold;
    this.samples = [];
    this._load();
  }
  _load() { try { if (fs.existsSync(this.file)) this.samples = JSON.parse(fs.readFileSync(this.file, "utf8")) || []; } catch { this.samples = []; } }
  _save() { try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.samples)); } catch {} }

  addSample(t, values) {
    const v = (values ?? []).filter((x) => typeof x === "number" && isFinite(x));
    if (!v.length) return;
    this.samples.push({ t, avg: mean(v), max: Math.round(Math.max(...v)), n: v.length });
    const cutoff = t - this.windowMs;
    if (this.samples[0]?.t < cutoff) this.samples = this.samples.filter((s) => s.t >= cutoff);
    this._save();
  }

  getView() {
    if (!this.samples.length) return null;
    // anomaly windows: consecutive samples with avg > threshold
    const windows = [];
    let cur = null;
    for (const s of this.samples) {
      if (s.avg > this.threshold) {
        if (!cur) cur = { start: s.t, end: s.t, peak: s.avg };
        else { cur.end = s.t; cur.peak = Math.max(cur.peak, s.avg); }
      } else if (cur) { windows.push(cur); cur = null; }
    }
    if (cur) windows.push(cur);

    const recent = this.samples.slice(-this.viewPoints);
    return {
      threshold: this.threshold,
      times: recent.map((s) => s.t),
      avg:   recent.map((s) => s.avg),
      max:   recent.map((s) => s.max),
      current: this.samples.at(-1).avg,
      max24h: Math.max(...this.samples.map((s) => s.avg)),
      anomalyCount: windows.length,
      windows: windows.slice(-8),                 // recent anomaly windows
      anomalyNow: this.samples.at(-1).avg > this.threshold,
      spanHours: Math.round(((this.samples.at(-1).t - this.samples[0].t) / 3600000) * 10) / 10,
    };
  }
}
