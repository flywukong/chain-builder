/**
 * ErrGradeBook — ERROR 日志模式的 AI 定级库(等级/根因/影响/处置),持久化累积。
 * 键为去参归并后的 pattern(与 clusterMessages 同源),同一模式只定级一次;
 * 同一条 ERROR 消息,量级不同影响可能不同 —— 定级针对「模式」,量级判断留给页面/总览 AI。
 */

import fs from "fs";
import path from "path";

export const ERR_LEVELS = ["P0", "P1", "P2", "noise"];

// 专家钉死的定级(优先于 AI 学习结果,add() 不可覆盖)。键 = clusterMessages 归并后的 pattern
export const STATIC_GRADES = {
  "BidSimulator: failed to commit tx": {
    level: "noise",
    cause: "该份 builder bid 里有一笔交易模拟执行失败(nonce too low / 余额不足等),整份 bid 按规则作废",
    impact: "对同步与共识无影响;validator 只是少用这一份 MEV 包,该轮改用其他 bid 或本地构建",
    action: "忽略;仅当某 builder 持续全量失败时通知其运营方",
    static: true,
  },
};

export class ErrGradeBook {
  constructor(file) {
    this.file = file;
    this.grades = {};
    try { if (fs.existsSync(file)) this.grades = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch { this.grades = {}; }
  }

  get(pattern) { return STATIC_GRADES[pattern] ?? this.grades[pattern] ?? null; }
  count() { return Object.keys(STATIC_GRADES).length + Object.keys(this.grades).length; }

  // entries: [{pattern, level, cause, impact, action}];非法 level 丢弃,静态条目不可覆盖
  add(entries) {
    let n = 0;
    for (const e of entries ?? []) {
      if (!e?.pattern || !ERR_LEVELS.includes(e.level) || STATIC_GRADES[e.pattern]) continue;
      this.grades[e.pattern] = {
        level: e.level,
        cause: (e.cause || "").slice(0, 200),
        impact: (e.impact || "").slice(0, 200),
        action: (e.action || "").slice(0, 120),
        ai: true, at: Date.now(),
      };
      n++;
    }
    if (n) {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify(this.grades, null, 1));
      } catch {}
    }
    return n;
  }
}
