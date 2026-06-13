import type { Bot } from "grammy";
import { getDb } from "../db/database";
import type { BotContext } from "../bot";

function weekStartDate(now: Date = new Date()): string {
  const d = new Date(now);
  const day = d.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + mondayOffset);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

function weekEndDate(weekStart: string): string {
  const d = new Date(weekStart + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString().slice(0, 10);
}

function generateDigestMarkdown(userTgId: number, weekStart: string): string {
  const db = getDb();
  const weekEnd = weekEndDate(weekStart);

  const weekStartTs = `${weekStart} 00:00:00`;
  const weekEndTs = `${weekEnd} 00:00:00`;

  const tasksCreated = db.prepare(
    "SELECT COUNT(*) as cnt FROM tasks WHERE user_tg_id = ? AND created_at >= ? AND created_at < ?",
  ).get(userTgId, weekStartTs, weekEndTs) as { cnt: number };

  const tasksCompleted = db.prepare(
    "SELECT COUNT(*) as cnt FROM tasks WHERE user_tg_id = ? AND status = 'completed' AND completed_at >= ? AND completed_at < ?",
  ).get(userTgId, weekStartTs, weekEndTs) as { cnt: number };

  const totalTasks = db.prepare(
    "SELECT COUNT(*) as cnt FROM tasks WHERE user_tg_id = ?",
  ).get(userTgId) as { cnt: number };

  const decisionsMade = db.prepare(
    "SELECT COUNT(*) as cnt FROM decisions WHERE user_tg_id = ? AND made_at >= ? AND made_at < ?",
  ).get(userTgId, weekStartTs, weekEndTs) as { cnt: number };

  const totalOpenDecisions = db.prepare(
    "SELECT COUNT(*) as cnt FROM decisions WHERE user_tg_id = ? AND status = 'open'",
  ).get(userTgId) as { cnt: number };

  const risksOpen = db.prepare(
    "SELECT COUNT(*) as cnt FROM risks WHERE user_tg_id = ? AND status = 'open'",
  ).get(userTgId) as { cnt: number };

  const risksMitigated = db.prepare(
    "SELECT COUNT(*) as cnt FROM risks WHERE user_tg_id = ? AND status = 'mitigated'",
  ).get(userTgId) as { cnt: number };

  const overdueFollowUps = db.prepare(
    "SELECT COUNT(*) as cnt FROM follow_ups WHERE user_tg_id = ? AND status = 'pending' AND deadline <= datetime('now')",
  ).get(userTgId) as { cnt: number };

  const totalPendingFollowUps = db.prepare(
    "SELECT COUNT(*) as cnt FROM follow_ups WHERE user_tg_id = ? AND status = 'pending'",
  ).get(userTgId) as { cnt: number };

  const topPatterns = db.prepare(
    "SELECT phrase, occurrences FROM patterns WHERE user_tg_id = ? ORDER BY occurrences DESC LIMIT 5",
  ).all(userTgId) as { phrase: string; occurrences: number }[];

  const lines: string[] = [];
  lines.push(`📊 *Weekly Digest*`);
  lines.push(`_${weekStart} → ${weekEnd}_`);
  lines.push("");

  lines.push("*Tasks*");
  lines.push(`  • Created this week: ${tasksCreated.cnt}`);
  lines.push(`  • Completed this week: ${tasksCompleted.cnt}`);
  lines.push(`  • Total tracked: ${totalTasks.cnt}`);
  lines.push("");

  lines.push("*Decisions*");
  lines.push(`  • Made this week: ${decisionsMade.cnt}`);
  lines.push(`  • Still open: ${totalOpenDecisions.cnt}`);
  lines.push("");

  lines.push("*Risks*");
  lines.push(`  • Open: ${risksOpen.cnt}`);
  lines.push(`  • Mitigated: ${risksMitigated.cnt}`);
  lines.push("");

  lines.push("*Follow-ups*");
  lines.push(`  • Overdue: ${overdueFollowUps.cnt}`);
  lines.push(`  • Pending total: ${totalPendingFollowUps.cnt}`);

  if (topPatterns.length > 0) {
    lines.push("");
    lines.push("*Top Patterns*");
    for (const p of topPatterns) {
      lines.push(`  • "${p.phrase}" — ${p.occurrences}×`);
    }
  }

  return lines.join("\n");
}

export async function generateAndSendDigest(
  bot: Bot<BotContext>,
  userTgId: number,
): Promise<boolean> {
  const db = getDb();

  const ws = weekStartDate();
  const existing = db.prepare(
    "SELECT id FROM summaries WHERE user_tg_id = ? AND week_start = ?",
  ).get(userTgId, ws);

  if (existing) return false;

  const bodyMd = generateDigestMarkdown(userTgId, ws);

  db.prepare(
    "INSERT INTO summaries (user_tg_id, week_start, body_md) VALUES (?, ?, ?)",
  ).run(userTgId, ws, bodyMd);

  try {
    await bot.api.sendMessage(userTgId, bodyMd, { parse_mode: "Markdown" });
  } catch {
    await bot.api.sendMessage(userTgId, bodyMd);
  }

  return true;
}

export function getDigestMarkdown(userTgId: number): string {
  const ws = weekStartDate();

  const existing = getDb().prepare(
    "SELECT body_md FROM summaries WHERE user_tg_id = ? AND week_start = ? ORDER BY id DESC LIMIT 1",
  ).get(userTgId, ws) as { body_md: string } | undefined;

  if (existing) return existing.body_md;

  return generateDigestMarkdown(userTgId, ws);
}

export function getWeekStart(): string {
  return weekStartDate();
}

function isUserSunday1800(user: { tg_id: number; tz_offset_min: number }): boolean {
  const now = new Date();
  const utcMs = now.getTime();
  const userMs = utcMs + user.tz_offset_min * 60 * 1000;
  const userDate = new Date(userMs);

  const day = userDate.getUTCDay();
  const hours = userDate.getUTCHours();
  const minutes = userDate.getUTCMinutes();

  return day === 0 && hours === 18 && minutes >= 0 && minutes < 2;
}

let schedulerInterval: ReturnType<typeof setInterval> | null = null;

export function startDigestScheduler(bot: Bot<BotContext>): void {
  if (schedulerInterval) return;

  schedulerInterval = setInterval(() => {
    const db = getDb();
    const users = db.prepare(
      "SELECT tg_id, tz_offset_min FROM users",
    ).all() as { tg_id: number; tz_offset_min: number }[];

    for (const user of users) {
      if (isUserSunday1800(user)) {
        generateAndSendDigest(bot, user.tg_id).then((sent) => {
          if (sent) {
            console.log(
              `Weekly digest sent to user ${user.tg_id}`,
            );
          }
        }).catch((err) => {
          console.error(
            `Failed to send weekly digest to user ${user.tg_id}:`,
            err,
          );
        });
      }
    }
  }, 60_000);
}

export function stopDigestScheduler(): void {
  if (schedulerInterval !== null) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
}
