import { getDb } from "../db/database";
import type { Bot } from "grammy";
import type { BotContext } from "../bot";

async function sweepReminders(bot: Bot<BotContext>): Promise<void> {
  const db = getDb();

  const due = db
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
    .all() as {
    id: number;
    user_tg_id: number;
    ref_kind: string;
    ref_id: number;
    deadline: string;
    priority: string;
    ref_title: string | null;
  }[];

  const markNotified = db.prepare(
    "UPDATE follow_ups SET notified_at = datetime('now') WHERE id = ?",
  );

  for (const f of due) {
    const refKindIcon =
      f.ref_kind === "task" ? "✅" : f.ref_kind === "decision" ? "🧭" : "⚠️";
    const priorityIcon =
      f.priority === "high"
        ? "🔴"
        : f.priority === "med"
        ? "🟡"
        : "🟢";
    const refTitle = f.ref_title ? f.ref_title.slice(0, 60) : `#${f.ref_id}`;

    const message =
      `⏰ *Reminder: Follow-up is due!*\n\n` +
      `${refKindIcon} ${refTitle}\n` +
      `${priorityIcon} Priority: ${f.priority}\n` +
      `📅 Deadline: ${f.deadline}`;

    try {
      await bot.api.sendMessage(f.user_tg_id, message, {
        parse_mode: "Markdown",
      });
      markNotified.run(f.id);
      console.log(`Reminder sent for follow-up #${f.id} to user ${f.user_tg_id}`);
    } catch (err) {
      console.error(
        `Failed to send reminder for follow-up #${f.id} to user ${f.user_tg_id}:`,
        err,
      );
    }
  }
}

let schedulerInterval: ReturnType<typeof setInterval> | null = null;

export function startReminderSweep(bot: Bot<BotContext>): void {
  if (schedulerInterval) return;

  schedulerInterval = setInterval(() => {
    sweepReminders(bot).catch((err) => {
      console.error("Reminder sweep failed:", err);
    });
  }, 60_000);
}

export function stopReminderSweep(): void {
  if (schedulerInterval !== null) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
}