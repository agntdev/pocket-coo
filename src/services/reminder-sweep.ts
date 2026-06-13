import type { Bot } from "grammy";
import { getDb } from "../db/database";
import type { BotContext } from "../bot";

interface OverdueFollowUp {
  id: number;
  user_tg_id: number;
  ref_kind: string;
  ref_id: number;
  deadline: string;
  priority: string;
  ref_title: string | null;
}

function sweepOverdueFollowUps(): OverdueFollowUp[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT f.id, f.user_tg_id, f.ref_kind, f.ref_id, f.deadline, f.priority,
              CASE f.ref_kind
                WHEN 'task' THEN (SELECT title FROM tasks WHERE id = f.ref_id)
                WHEN 'decision' THEN (SELECT context FROM decisions WHERE id = f.ref_id)
                WHEN 'risk' THEN (SELECT description FROM risks WHERE id = f.ref_id)
              END as ref_title
       FROM follow_ups f
       WHERE f.status = 'pending'
         AND f.deadline <= datetime('now')
         AND f.notified_at IS NULL`,
    )
    .all() as OverdueFollowUp[];
}

function buildReminderMessage(f: OverdueFollowUp): string {
  const kindLabel =
    f.ref_kind === "task"
      ? "✅ Task"
      : f.ref_kind === "decision"
        ? "🧭 Decision"
        : "⚠️ Risk";
  const priorityLabel =
    f.priority === "high" ? "🔴" : f.priority === "med" ? "🟡" : "🟢";
  const refTitle = f.ref_title
    ? f.ref_title.slice(0, 80)
    : `#${f.ref_id}`;
  return (
    `⏰ *Reminder* — Follow-up #${f.id} is due!\n\n` +
    `${kindLabel}: ${refTitle}\n` +
    `Deadline: ${f.deadline}\n` +
    `Priority: ${priorityLabel} ${f.priority}`
  );
}

function markNotified(followUpId: number): void {
  const db = getDb();
  db.prepare(
    `UPDATE follow_ups SET notified_at = datetime('now') WHERE id = ?`,
  ).run(followUpId);
}

export async function notifyOverdueFollowUps(
  bot: Bot<BotContext>,
): Promise<void> {
  const overdue = sweepOverdueFollowUps();

  for (const f of overdue) {
    const message = buildReminderMessage(f);
    try {
      await bot.api.sendMessage(f.user_tg_id, message, {
        parse_mode: "Markdown",
      });
      markNotified(f.id);
      console.log(`Reminder sent for follow-up #${f.id} to user ${f.user_tg_id}`);
    } catch (err) {
      console.error(
        `Failed to send reminder for follow-up #${f.id} to user ${f.user_tg_id}:`,
        err,
      );
    }
  }
}

let sweepInterval: ReturnType<typeof setInterval> | null = null;

export function startReminderSweep(bot: Bot<BotContext>): void {
  if (sweepInterval) return;

  sweepInterval = setInterval(() => {
    notifyOverdueFollowUps(bot).catch((err) => {
      console.error("Reminder sweep failed:", err);
    });
  }, 60_000);
}

export function stopReminderSweep(): void {
  if (sweepInterval !== null) {
    clearInterval(sweepInterval);
    sweepInterval = null;
  }
}
