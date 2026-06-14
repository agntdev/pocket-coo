import { Bot, Context, session, SessionFlavor, InlineKeyboard, InputFile } from "grammy";
import { getDb } from "./db/database";
import {
  intakeTextMessage,
  intakeVoiceMessage,
  intakePhotoMessage,
  intakeDocumentMessage,
  type IntakeResult,
} from "./services/message-intake";
import { categorize, CATEGORY_LABELS } from "./services/categorizer";
import {
  getDigestMarkdown,
  startDigestScheduler,
} from "./services/weekly-digest";
import { startPatternScheduler } from "./services/pattern-detection";

export interface BotSession {
  step: string;
  data: Record<string, unknown>;
  captureText?: string;
  captureMsgId?: number | bigint;
  captureCategory?: string;
  tasksFilter?: string;
  tasksPage?: number;
}

const TASKS_PER_PAGE = 5;

function initialSession(): BotSession {
  return { step: "idle", data: {} };
}

function captureCardKeyboard(msgId: number | bigint): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Task", `cat:task:${msgId}`)
    .text("🧭 Decision", `cat:decision:${msgId}`).row()
    .text("⚠️ Risk", `cat:risk:${msgId}`)
    .text("⏰ Follow-up", `cat:followup:${msgId}`).row()
    .text("🗑 Ignore", `cat:ignore:${msgId}`);
}

async function showTaskConfirm(ctx: BotContext): Promise<void> {
  ctx.session.step = "task:create:confirm";
  const title = ctx.session.data.taskTitle as string;
  const priority = (ctx.session.data.taskPriority as string) || "med";
  const deadline = (ctx.session.data.taskDeadline as string) || "";

  const priorityLabel =
    priority === "high"
      ? "🔴 High"
      : priority === "med"
      ? "🟡 Medium"
      : "🟢 Low";
  const deadlineDisplay = deadline || "No deadline";

  const keyboard = new InlineKeyboard()
    .text("✏️ Edit Title", "tasks:edit:title")
    .text("✏️ Edit Priority", "tasks:edit:priority").row()
    .text("✏️ Edit Deadline", "tasks:edit:deadline")
    .text("💾 Save", "tasks:save").row();

  await ctx.reply(
    `✅ *Task Preview*\n\n` +
      `Title: *${title}*\n` +
      `Priority: ${priorityLabel}\n` +
      `Deadline: ${deadlineDisplay}`,
    { parse_mode: "Markdown", reply_markup: keyboard },
  );
}

function projectPickerKeyboard(userId: number, category: string): InlineKeyboard {
  const db = getDb();
  const projects = db
    .prepare(
      "SELECT id, name FROM projects WHERE user_tg_id = ? AND status = 'active' ORDER BY name",
    )
    .all(userId) as { id: number; name: string }[];

  const keyboard = new InlineKeyboard();
  if (projects.length > 0) {
    for (const p of projects) {
      keyboard.text(p.name, `proj:pick:${p.id}:${category}`).row();
    }
  }
  keyboard.text("📂 No project", `proj:pick:none:${category}`);
  return keyboard;
}

function buildProjectsList(
  userId: number,
): { text: string; keyboard: InlineKeyboard } {
  const db = getDb();
  const projects = db
    .prepare(
      "SELECT id, name, description FROM projects WHERE user_tg_id = ? AND status = 'active' ORDER BY name",
    )
    .all(userId) as { id: number; name: string; description: string }[];

  const keyboard = new InlineKeyboard();

  if (projects.length === 0) {
    keyboard.text("➕ New Project", "proj:new");
    return {
      text: "📂 *Projects*\n\nNo active projects yet.",
      keyboard,
    };
  }

  const lines: string[] = ["📂 *Projects*\n"];

  for (const p of projects) {
    const taskCount = (
      db
        .prepare(
          "SELECT COUNT(*) as cnt FROM tasks WHERE project_id = ? AND status = 'pending'",
        )
        .get(p.id) as { cnt: number }
    ).cnt;
    const decisionCount = (
      db
        .prepare(
          "SELECT COUNT(*) as cnt FROM decisions WHERE project_id = ? AND status = 'open'",
        )
        .get(p.id) as { cnt: number }
    ).cnt;
    const riskCount = (
      db
        .prepare(
          "SELECT COUNT(*) as cnt FROM risks WHERE project_id = ? AND status = 'open'",
        )
        .get(p.id) as { cnt: number }
    ).cnt;
    const followUpCount = (
      db
        .prepare(
          `SELECT COUNT(*) as cnt FROM follow_ups f
           WHERE f.user_tg_id = ? AND f.status = 'pending'
           AND (
             (f.ref_kind = 'task' AND f.ref_id IN (SELECT id FROM tasks WHERE project_id = ?))
             OR (f.ref_kind = 'decision' AND f.ref_id IN (SELECT id FROM decisions WHERE project_id = ?))
             OR (f.ref_kind = 'risk' AND f.ref_id IN (SELECT id FROM risks WHERE project_id = ?))
           )`,
        )
        .get(userId, p.id, p.id, p.id) as { cnt: number }
    ).cnt;

    const desc = p.description ? `\n📝 ${p.description}` : "";
    lines.push(`📁 *${p.name}*${desc}`);
    lines.push(
      `✅ ${taskCount}  🧭 ${decisionCount}  ⚠️ ${riskCount}  ⏰ ${followUpCount}\n`,
    );

    keyboard.text(`📦 ${p.name}`, `proj:archive:${p.id}`).row();
  }

  keyboard.text("➕ New Project", "proj:new");

  return { text: lines.join("\n"), keyboard };
}

function getTasksFilterLabel(filter: string): string {
  switch (filter) {
    case "high": return " · 🔴 High priority";
    case "med": return " · 🟡 Medium priority";
    case "low": return " · 🟢 Low priority";
    case "due:today": return " · 📅 Due today";
    case "due:week": return " · 📅 Due this week";
    case "due:overdue": return " · ⏰ Overdue";
    default:
      if (filter.startsWith("proj:")) {
        const projId = Number(filter.slice(5));
        if (!isNaN(projId)) {
          const db = getDb();
          const proj = db.prepare("SELECT name FROM projects WHERE id = ?").get(projId) as { name: string } | undefined;
          if (proj) return ` · 📁 ${proj.name}`;
        }
      }
      return "";
  }
}

function buildTasksList(
  userId: number,
  filter: string,
  page: number,
): { text: string; keyboard: InlineKeyboard } {
  const db = getDb();
  const normalizedFilter = filter === "all" ? "" : filter;
  const params: unknown[] = [userId];
  const conditions: string[] = ["t.user_tg_id = ?", "t.status = 'pending'"];

  if (normalizedFilter === "high" || normalizedFilter === "med" || normalizedFilter === "low") {
    conditions.push("t.priority = ?");
    params.push(normalizedFilter);
  } else if (normalizedFilter === "due:today") {
    conditions.push("t.deadline = date('now')");
  } else if (normalizedFilter === "due:week") {
    conditions.push("t.deadline >= date('now') AND t.deadline <= date('now', '+7 days')");
  } else if (normalizedFilter === "due:overdue") {
    conditions.push("t.deadline < date('now') AND t.deadline IS NOT NULL AND t.deadline != ''");
  } else if (normalizedFilter.startsWith("proj:")) {
    const projId = Number(normalizedFilter.slice(5));
    if (!isNaN(projId)) {
      conditions.push("t.project_id = ?");
      params.push(projId);
    }
  }

  const where = conditions.join(" AND ");

  const total = (
    db
      .prepare(`SELECT COUNT(*) as cnt FROM tasks t WHERE ${where}`)
      .get(...params) as { cnt: number }
  ).cnt;
  const totalPages = Math.ceil(total / TASKS_PER_PAGE) || 1;
  const safePage = Math.max(0, Math.min(page, totalPages - 1));

  const tasks = db
    .prepare(
      `SELECT t.id, t.title, t.priority, t.deadline, p.name as project_name
       FROM tasks t
       LEFT JOIN projects p ON t.project_id = p.id
       WHERE ${where}
       ORDER BY
         CASE t.priority WHEN 'high' THEN 0 WHEN 'med' THEN 1 ELSE 2 END,
         CASE WHEN t.deadline IS NULL OR t.deadline = '' THEN 1 ELSE 0 END,
         t.deadline ASC,
         t.created_at ASC
       LIMIT ? OFFSET ?`,
    )
    .all(
      ...params,
      TASKS_PER_PAGE,
      safePage * TASKS_PER_PAGE,
    ) as { id: number; title: string; priority: string; deadline: string | null; project_name: string | null }[];

  const filterLabel = getTasksFilterLabel(filter);
  const lines: string[] = [`✅ *Tasks*${filterLabel}\n`];

  if (tasks.length === 0) {
    lines.push("No pending tasks.");
  } else {
    for (const t of tasks) {
      const prio =
        t.priority === "high"
          ? "🔴"
          : t.priority === "med"
            ? "🟡"
            : "🟢";
      const projStr = t.project_name ? ` · 📁 ${t.project_name}` : "";
      const dlStr = t.deadline ? ` · ⏰ ${t.deadline}` : "";
      lines.push(`${prio} *${t.title}*${projStr}${dlStr}`);
    }
  }

  if (total > 0) {
    lines.push(`\n_Page ${safePage + 1}/${totalPages}_`);
  }

  const keyboard = new InlineKeyboard();

  for (const t of tasks) {
    keyboard.text(`✅ Done #${t.id}`, `tasks:done:${t.id}`).row();
  }

  if (filter !== "high") keyboard.text("🔴 High", "tasks:filter:high");
  if (filter !== "med") keyboard.text("🟡 Med", "tasks:filter:med");
  if (filter !== "low") keyboard.text("🟢 Low", "tasks:filter:low");
  if (filter !== "" && filter !== "all") {
    keyboard.text("All", "tasks:filter:all");
  }
  keyboard.row();

  if (filter !== "due:today") keyboard.text("📅 Today", "tasks:filter:due:today");
  if (filter !== "due:week") keyboard.text("📅 Week", "tasks:filter:due:week");
  if (filter !== "due:overdue") keyboard.text("⏰ Overdue", "tasks:filter:due:overdue");
  keyboard.row();

  const projects = db
    .prepare(
      "SELECT id, name FROM projects WHERE user_tg_id = ? AND status = 'active' ORDER BY name",
    )
    .all(userId) as { id: number; name: string }[];
  for (const p of projects) {
    keyboard.text(`📁 ${p.name}`, `tasks:filter:proj:${p.id}`).row();
  }

  if (totalPages > 1) {
    if (safePage > 0) keyboard.text("◀️ Prev", `tasks:page:${safePage - 1}`);
    keyboard.text(`${safePage + 1}/${totalPages}`, "tasks:noop");
    if (safePage < totalPages - 1) keyboard.text("Next ▶️", `tasks:page:${safePage + 1}`);
    keyboard.row();
  }

  keyboard.text("➕ New Task", "tasks:new");

  return { text: lines.join("\n"), keyboard };
}

async function showCaptureCard(
  ctx: BotContext,
  result: IntakeResult,
): Promise<void> {
  ctx.session.captureText = result.rawText;
  ctx.session.captureMsgId = result.msgId;
  ctx.session.captureCategory = undefined;

  const rawText = result.rawText;
  const truncated = rawText.length > 200
    ? rawText.slice(0, 200) + "…"
    : rawText;

  const kindLabel: Record<string, string> = {
    text: "📝",
    voice: "🎙",
    image: "🖼",
    document: "📎",
  };

  let header = `${kindLabel[result.kind] || "📥"} Got: ${truncated}`;

  const suggestion = await categorize(rawText);
  if (suggestion?.category) {
    header += `\n\n💡 Suggested: ${CATEGORY_LABELS[suggestion.category]} (${suggestion.source})`;
  }

  await ctx.reply(header, { reply_markup: captureCardKeyboard(result.msgId) });
}

export type BotContext = Context & SessionFlavor<BotSession>;

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("BOT_TOKEN environment variable is required");
  process.exit(1);
}

export const bot = new Bot<BotContext>(token);

bot.use(session({ initial: initialSession }));

// === Command: /start ===
bot.command("start", async (ctx) => {
  const mainKeyboard = new InlineKeyboard()
    .text("➕ Capture", "cat:new").row()
    .text("📂 Projects", "proj:list")
    .text("✅ Tasks", "tasks:list").row()
    .text("🧭 Decisions", "dec:list")
    .text("⚠️ Risks", "risks:list").row()
    .text("⏰ Follow-ups", "followups:list")
    .text("🔍 Patterns", "patterns:list").row()
    .text("📊 Digest", "digest:now");

  await ctx.reply(
    "👋 Welcome to Pocket COO!\n\n" +
      "I help you turn chaotic chats into structured projects and tasks. " +
      "Just forward me any message, voice note, or screenshot — I'll ask where it goes.",
    { reply_markup: mainKeyboard },
  );
});

// === Command: /help ===
bot.command("help", async (ctx) => {
  await ctx.reply(
    "*Pocket COO — Command Reference*\n\n" +
      "/start — Show main menu\n" +
      "/capture — Categorize a forwarded message\n" +
      "/projects — List active projects\n" +
      "/newproject \<name\> — Create a new project\n" +
      "/tasks — List pending tasks\n" +
      "/decisions — List open decisions\n" +
      "/risks — List open risks\n" +
      "/followups — List pending follow-ups\n" +
      "/digest — Show this week's digest\n" +
      "/patterns — Show detected recurring phrases\n" +
      "/export — Export all your data as JSON",
    { parse_mode: "Markdown" },
  );
});

// === Command: /capture ===
bot.command("capture", async (ctx) => {
  const rawText = ctx.match?.trim();
  let content: string;
  if (rawText && rawText.length > 0) {
    content = rawText;
  } else {
    content = "_".repeat(0);
    await ctx.reply(
      "📥 Forward a message, voice note, or image to capture it. " +
        "You can also type `/capture <your text>`.",
    );
    return;
  }

  ctx.session.captureText = content;
  ctx.session.captureMsgId = 0;
  ctx.session.captureCategory = undefined;

  const keyboard = new InlineKeyboard()
    .text("✅ Task", `cat:task:0`)
    .text("🧭 Decision", `cat:decision:0`).row()
    .text("⚠️ Risk", `cat:risk:0`)
    .text("⏰ Follow-up", `cat:followup:0`).row()
    .text("🗑 Ignore", `cat:ignore:0`);

  await ctx.reply(`📥 Got: ${content}`, { reply_markup: keyboard });
});

// === Command: /projects ===
bot.command("projects", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  const { text, keyboard } = buildProjectsList(userId);
  await ctx.reply(text, {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
});

// === Command: /newproject ===
bot.command("newproject", async (ctx) => {
  const name = ctx.match?.trim();
  if (!name) {
    ctx.session.step = "project:create:name";
    await ctx.reply("📂 What should the project be called?");
    return;
  }
  const userId = ctx.from?.id;
  if (!userId) return;
  const db = getDb();
  db.prepare(
    "INSERT INTO users (tg_id, name) VALUES (?, ?) ON CONFLICT(tg_id) DO UPDATE SET name = excluded.name",
  ).run(userId, ctx.from?.username || ctx.from?.first_name || `user${userId}`);
  const info = db
    .prepare("INSERT INTO projects (user_tg_id, name) VALUES (?, ?)")
    .run(userId, name);
  await ctx.reply(`📂 Project "${name}" created! (#${info.lastInsertRowid})`);
});

// === Command: /tasks ===
bot.command("tasks", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  ctx.session.tasksFilter = "";
  ctx.session.tasksPage = 0;
  const { text, keyboard } = buildTasksList(userId, "", 0);
  await ctx.reply(text, {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
});

// === Command: /decisions ===
async function renderDecisionsScreen(ctx: BotContext, userId: number): Promise<void> {
  const db = getDb();
  const decisions = db.prepare(
    "SELECT id, context, choice, outcome, status, made_at FROM decisions WHERE user_tg_id = ? AND status = 'open' ORDER BY made_at DESC LIMIT 20",
  ).all(userId) as { id: number; context: string; choice: string; outcome: string | null; status: string; made_at: string }[];

  if (decisions.length === 0) {
    const keyboard = new InlineKeyboard().text("📋 Main Menu", "menu:main");
    await ctx.reply("🧭 *Decisions*\n\nNo open decisions.", {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
    return;
  }

  const lines: string[] = ["🧭 *Decisions*"];
  for (const d of decisions) {
    lines.push("");
    lines.push(`*#${d.id}* — ${d.context}`);
    if (d.choice) lines.push(`  ↳ Choice: ${d.choice}`);
    lines.push(`  _${d.made_at.slice(0, 16)}_`);
  }

  const keyboard = new InlineKeyboard();
  for (const d of decisions) {
    keyboard.text(`Resolve #${d.id}`, `dec:resolve:${d.id}`).row();
  }
  keyboard.text("📋 Main Menu", "menu:main");

  await ctx.reply(lines.join("\n"), {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
}

bot.command("decisions", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply("Could not identify your user account.");
    return;
  }
  await renderDecisionsScreen(ctx, userId);
});

// === Command: /risks ===
async function renderRisksScreen(ctx: BotContext, userId: number): Promise<void> {
  const db = getDb();
  const risks = db.prepare(
    "SELECT id, description, severity, mitigation, status FROM risks WHERE user_tg_id = ? AND status = 'open' ORDER BY id DESC LIMIT 20",
  ).all(userId) as { id: number; description: string; severity: string; mitigation: string | null; status: string }[];

  if (risks.length === 0) {
    const keyboard = new InlineKeyboard().text("📋 Main Menu", "menu:main");
    await ctx.reply("⚠️ *Risks*\n\nNo open risks.", {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
    return;
  }

  const lines: string[] = ["⚠️ *Risks*"];
  for (const r of risks) {
    const sevLabel = r.severity === "high" ? "🔴" : r.severity === "med" ? "🟡" : "🟢";
    lines.push("");
    lines.push(`*#${r.id}* ${sevLabel} ${r.description}`);
    if (r.mitigation) lines.push(`  ↳ Mitigation: ${r.mitigation}`);
  }

  const keyboard = new InlineKeyboard();
  for (const r of risks) {
    keyboard.text(`Mitigate #${r.id}`, `risk:close:${r.id}`).row();
  }
  keyboard.text("📋 Main Menu", "menu:main");

  await ctx.reply(lines.join("\n"), {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
}

bot.command("risks", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply("Could not identify your user account.");
    return;
  }
  await renderRisksScreen(ctx, userId);
});

// === Command: /followups ===
async function renderFollowupsScreen(ctx: BotContext, userId: number): Promise<void> {
  const db = getDb();
  const followUps = db
    .prepare(
      `SELECT f.id, f.ref_kind, f.ref_id, f.deadline, f.priority, f.status, f.created_at,
              CASE f.ref_kind
                WHEN 'task' THEN (SELECT title FROM tasks WHERE id = f.ref_id)
                WHEN 'decision' THEN (SELECT context FROM decisions WHERE id = f.ref_id)
                WHEN 'risk' THEN (SELECT description FROM risks WHERE id = f.ref_id)
              END as ref_title
       FROM follow_ups f
       WHERE f.user_tg_id = ? AND f.status = 'pending'
       ORDER BY f.deadline ASC LIMIT 20`,
    )
    .all(userId) as {
    id: number;
    ref_kind: string;
    ref_id: number;
    deadline: string;
    priority: string;
    status: string;
    created_at: string;
    ref_title: string | null;
  }[];

  if (followUps.length === 0) {
    const keyboard = new InlineKeyboard()
      .text("➕ New Follow-up", "followups:new").row()
      .text("📋 Main Menu", "menu:main");
    await ctx.reply("⏰ *Follow-ups*\n\nNo pending follow-ups.", {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
    return;
  }

  const lines: string[] = ["⏰ *Follow-ups*"];
  const keyboard = new InlineKeyboard();
  for (const f of followUps) {
    const refKindIcon =
      f.ref_kind === "task" ? "✅" : f.ref_kind === "decision" ? "🧭" : "⚠️";
    const priorityIcon =
      f.priority === "high"
        ? "🔴"
        : f.priority === "med"
        ? "🟡"
        : "🟢";
    const refTitle = f.ref_title ? f.ref_title.slice(0, 60) : `#${f.ref_id}`;
    lines.push("");
    lines.push(
      `*#${f.id}* ${priorityIcon} — ${refKindIcon} ${refTitle}`,
    );
    lines.push(`  ⏰ Deadline: ${f.deadline}`);
    keyboard.text(`✅ Done #${f.id}`, `fw:done:${f.id}`);
    keyboard.text(`❌ Dismiss #${f.id}`, `fw:dismiss:${f.id}`).row();
  }
  keyboard.text("➕ New Follow-up", "followups:new").row();
  keyboard.text("📋 Main Menu", "menu:main");

  await ctx.reply(lines.join("\n"), {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
}

bot.command("followups", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply("Could not identify your user account.");
    return;
  }
  await renderFollowupsScreen(ctx, userId);
});

// === Command: /digest ===
bot.command("digest", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply("Could not identify your user account.");
    return;
  }
  const digestMd = getDigestMarkdown(userId);
  try {
    await ctx.reply(digestMd, { parse_mode: "Markdown" });
  } catch {
    await ctx.reply(digestMd);
  }
});

// === Command: /patterns ===
async function renderPatternsScreen(ctx: BotContext, userId: number): Promise<void> {
  const db = getDb();
  const patterns = db.prepare(
    "SELECT phrase, occurrences FROM patterns WHERE user_tg_id = ? ORDER BY occurrences DESC LIMIT 10",
  ).all(userId) as { phrase: string; occurrences: number }[];

  const keyboard = new InlineKeyboard().text("📋 Main Menu", "menu:main");

  if (patterns.length === 0) {
    await ctx.reply("🔍 *Patterns*\n\nNo recurring phrases detected yet.", {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
    return;
  }

  const lines: string[] = ["🔍 *Recurring Phrases*"];
  for (const p of patterns) {
    lines.push(`  • "${p.phrase}" — ${p.occurrences}×`);
  }

  await ctx.reply(lines.join("\n"), {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
}

bot.command("patterns", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply("Could not identify your user account.");
    return;
  }
  await renderPatternsScreen(ctx, userId);
});

// === Command: /export ===
bot.command("export", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply("Could not identify your user account.");
    return;
  }

  const db = getDb();

  const user = db.prepare("SELECT * FROM users WHERE tg_id = ?").get(userId);

  const projects = db.prepare(
    "SELECT * FROM projects WHERE user_tg_id = ?",
  ).all(userId);

  const tasks = db.prepare(
    "SELECT * FROM tasks WHERE user_tg_id = ?",
  ).all(userId);

  const decisions = db.prepare(
    "SELECT * FROM decisions WHERE user_tg_id = ?",
  ).all(userId);

  const risks = db.prepare(
    "SELECT * FROM risks WHERE user_tg_id = ?",
  ).all(userId);

  const followUps = db.prepare(
    "SELECT * FROM follow_ups WHERE user_tg_id = ?",
  ).all(userId);

  const messages = db.prepare(
    "SELECT * FROM messages WHERE user_tg_id = ?",
  ).all(userId);

  const summaries = db.prepare(
    "SELECT * FROM summaries WHERE user_tg_id = ? ORDER BY week_start DESC LIMIT 4",
  ).all(userId);

  const patterns = db.prepare(
    "SELECT * FROM patterns WHERE user_tg_id = ?",
  ).all(userId);

  const exportData = {
    exported_at: new Date().toISOString(),
    user,
    projects,
    tasks,
    decisions,
    risks,
    follow_ups: followUps,
    messages,
    summaries,
    patterns,
  };

  const json = JSON.stringify(exportData, null, 2);
  const dateStr = new Date().toISOString().slice(0, 10);
  const filename = `pocket-coo-export-${dateStr}.json`;

  await ctx.replyWithDocument(
    new InputFile(Buffer.from(json, "utf-8"), filename),
    { caption: "📤 Here is your exported data." },
  );
});

// === Callback routing: capture categories ===
bot.callbackQuery(/^cat:task:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.captureCategory = "task";
  const userId = ctx.from?.id;
  if (!userId) return;
  await ctx.reply("✅ Task — select a project:", {
    reply_markup: projectPickerKeyboard(userId, "task"),
  });
});

bot.callbackQuery(/^cat:decision:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.captureCategory = "decision";
  const userId = ctx.from?.id;
  if (!userId) return;
  await ctx.reply("🧭 Decision — select a project:", {
    reply_markup: projectPickerKeyboard(userId, "decision"),
  });
});

bot.callbackQuery(/^cat:risk:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.captureCategory = "risk";
  const userId = ctx.from?.id;
  if (!userId) return;
  await ctx.reply("⚠️ Risk — select a project:", {
    reply_markup: projectPickerKeyboard(userId, "risk"),
  });
});

bot.callbackQuery(/^cat:followup:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.captureCategory = "followup";
  const userId = ctx.from?.id;
  if (!userId) return;
  await ctx.reply("⏰ Follow-up — select a project:", {
    reply_markup: projectPickerKeyboard(userId, "followup"),
  });
});

bot.callbackQuery(/^cat:ignore:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.captureText = undefined;
  ctx.session.captureMsgId = undefined;
  ctx.session.captureCategory = undefined;
  await ctx.editMessageReplyMarkup(undefined);
  await ctx.reply("🗑 Message ignored.");
});

bot.callbackQuery("cat:new", async (ctx) => {
  await ctx.answerCallbackQuery();
  const keyboard = new InlineKeyboard()
    .text("✅ Task", "cat:task:0")
    .text("🧭 Decision", "cat:decision:0").row()
    .text("⚠️ Risk", "cat:risk:0")
    .text("⏰ Follow-up", "cat:followup:0").row()
    .text("🗑 Ignore", "cat:ignore:0");
  await ctx.reply("📥 Send or forward your message:", {
    reply_markup: keyboard,
  });
});

// === Callback routing: projects ===
bot.callbackQuery("proj:list", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from?.id;
  if (!userId) return;
  const { text, keyboard } = buildProjectsList(userId);
  await ctx.reply(text, {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
});

bot.callbackQuery("proj:new", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "project:create:name";
  await ctx.reply("📂 What should the project be called?");
});

bot.callbackQuery(/^proj:archive:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const projId = Number(ctx.match[1]);
  const userId = ctx.from?.id;
  if (!userId) return;
  const db = getDb();
  db.prepare(
    "UPDATE projects SET status = 'archived' WHERE id = ? AND user_tg_id = ?",
  ).run(projId, userId);
  const { text, keyboard } = buildProjectsList(userId);
  await ctx.reply(text, {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
});

bot.callbackQuery(/^proj:open:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const projId = Number(ctx.match[1]);
  const userId = ctx.from?.id;
  if (!userId) return;
  const db = getDb();
  db.prepare(
    "UPDATE projects SET status = 'active' WHERE id = ? AND user_tg_id = ?",
  ).run(projId, userId);
  const { text, keyboard } = buildProjectsList(userId);
  await ctx.reply(text, {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
});

// === Callback routing: tasks ===
bot.callbackQuery("tasks:list", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from?.id;
  if (!userId) return;
  ctx.session.tasksFilter = "";
  ctx.session.tasksPage = 0;
  const { text, keyboard } = buildTasksList(userId, "", 0);
  await ctx.reply(text, {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
});

bot.callbackQuery("tasks:new", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "task:create:title";
  await ctx.reply("✅ Task creation — what's the title?");
});

bot.callbackQuery(/^tasks:done:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const taskId = Number(ctx.match[1]);
  const userId = ctx.from?.id;
  if (!userId) return;
  const db = getDb();
  db.prepare(
    "UPDATE tasks SET status = 'completed', completed_at = datetime('now') WHERE id = ? AND user_tg_id = ?",
  ).run(taskId, userId);
  const filter = ctx.session.tasksFilter || "";
  const page = ctx.session.tasksPage || 0;
  const { text, keyboard } = buildTasksList(userId, filter, page);
  await ctx.reply(text, {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
});

bot.callbackQuery(/^tasks:filter:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from?.id;
  if (!userId) return;
  const filterVal = ctx.match[1];
  ctx.session.tasksFilter = filterVal;
  ctx.session.tasksPage = 0;
  const { text, keyboard } = buildTasksList(userId, filterVal, 0);
  await ctx.reply(text, {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
});

// === Task creation: priority selection ===
bot.callbackQuery(/^tasks:pri:(high|med|low)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const priority = ctx.match[1] as "high" | "med" | "low";
  ctx.session.data.taskPriority = priority;
  ctx.session.step = "task:create:deadline";

  const title = ctx.session.data.taskTitle as string;
  const priorityLabel =
    priority === "high"
      ? "🔴 High"
      : priority === "med"
      ? "🟡 Medium"
      : "🟢 Low";

  await ctx.reply(
    `✅ Task: *${title}* (${priorityLabel})\n\n⏰ What's the deadline? (e.g. "tomorrow", "Friday", "2026-07-01", or send "-" to skip)`,
    { parse_mode: "Markdown" },
  );
});

// === Task creation: inline editing from confirmation screen ===
bot.callbackQuery("tasks:edit:title", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "task:create:title_edit";
  const currentTitle = ctx.session.data.taskTitle as string;
  await ctx.reply(
    `✅ Editing title.\n\nCurrent: *${currentTitle}*\n\nSend the new title:`,
    { parse_mode: "Markdown" },
  );
});

bot.callbackQuery("tasks:edit:priority", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "task:create:priority";
  const currentPriority = (ctx.session.data.taskPriority as string) || "med";
  const priorityLabel =
    currentPriority === "high"
      ? "🔴 High"
      : currentPriority === "med"
      ? "🟡 Medium"
      : "🟢 Low";

  const priorityKeyboard = new InlineKeyboard()
    .text("🔴 High", "tasks:pri:high")
    .text("🟡 Medium", "tasks:pri:med")
    .text("🟢 Low", "tasks:pri:low");

  await ctx.reply(
    `✅ Editing priority.\n\nCurrent: ${priorityLabel}\n\nPick a new priority:`,
    { reply_markup: priorityKeyboard },
  );
});

bot.callbackQuery("tasks:edit:deadline", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "task:create:deadline_edit";
  const currentDeadline = (ctx.session.data.taskDeadline as string) || "";
  const deadlineDisplay = currentDeadline || "None set";
  await ctx.reply(
    `✅ Editing deadline.\n\nCurrent: ${deadlineDisplay}\n\nSend the new deadline (or "-" to clear):`,
  );
});

// === Task creation: save ===
bot.callbackQuery("tasks:save", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from?.id;
  if (!userId) return;

  const title = ctx.session.data.taskTitle as string;
  const priority = (ctx.session.data.taskPriority as string) || "med";
  const deadline = (ctx.session.data.taskDeadline as string) || null;
  const projectId = ctx.session.data.taskProjectId as number | undefined;

  if (!title) {
    ctx.session.step = "idle";
    await ctx.reply("⚠️ Something went wrong. Please try again.");
    return;
  }

  const db = getDb();
  db.prepare(
    "INSERT INTO users (tg_id, name) VALUES (?, ?) ON CONFLICT(tg_id) DO UPDATE SET name = excluded.name",
  ).run(userId, ctx.from?.username || ctx.from?.first_name || `user${userId}`);

  const info = db
    .prepare(
      `INSERT INTO tasks (project_id, user_tg_id, title, priority, deadline, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
    )
    .run(projectId != null ? projectId : null, userId, title, priority, deadline);

  const priorityLabel =
    priority === "high"
      ? "🔴 High"
      : priority === "med"
      ? "🟡 Medium"
      : "🟢 Low";
  const deadlineDisplay = deadline || "No deadline";

  ctx.session.data.taskTitle = undefined;
  ctx.session.data.taskPriority = undefined;
  ctx.session.data.taskDeadline = undefined;
  ctx.session.data.taskProjectId = undefined;
  ctx.session.step = "idle";

  await ctx.reply(
    `✅ Task #${info.lastInsertRowid} created!\n\n` +
      `Title: *${title}*\n` +
      `Priority: ${priorityLabel}\n` +
      `Deadline: ${deadlineDisplay}`,
    { parse_mode: "Markdown" },
  );
});

// === Callback routing: decisions ===
bot.callbackQuery(/^dec:resolve:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const decisionId = Number(ctx.match[1]);
  ctx.session.data.resolvingDecisionId = decisionId;
  ctx.session.step = "decision:resolve:outcome";
  await ctx.reply("🧭 What was the outcome of this decision?");
});

// === Callback routing: risks ===
bot.callbackQuery(/^risk:close:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const riskId = Number(ctx.match[1]);
  const userId = ctx.from?.id;
  if (!userId) return;
  const db = getDb();
  db.prepare(
    "UPDATE risks SET status = 'mitigated' WHERE id = ? AND user_tg_id = ?",
  ).run(riskId, userId);
  await ctx.reply(`⚠️ Risk #${riskId} mitigated.`);
});

bot.callbackQuery(/^risk:severity:(\d+):(low|med|high)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const riskId = Number(ctx.match[1]);
  const severity = ctx.match[2];
  const userId = ctx.from?.id;
  if (!userId) return;
  const db = getDb();
  db.prepare(
    "UPDATE risks SET severity = ? WHERE id = ? AND user_tg_id = ?",
  ).run(severity, riskId, userId);
  ctx.session.data.pendingRiskId = riskId;
  ctx.session.step = "risk:create:mitigation";
  const sevLabel = severity === "high" ? "🔴 High" : severity === "med" ? "🟡 Med" : "🟢 Low";
  await ctx.reply(
    `⚠️ Severity set to ${sevLabel}.\n\nWhat mitigation do you have in mind? (send "-" to skip)`,
  );
});

// === Callback routing: project picker for capture flow ===
bot.callbackQuery(
  /^proj:pick:(.+):(task|decision|risk|followup)$/,
  async (ctx) => {
    await ctx.answerCallbackQuery();
    const [, projIdRaw, category] = ctx.match;
    const userId = ctx.from?.id;
    if (!userId) return;

    const captureText = ctx.session.captureText || "";
    const captureMsgId = ctx.session.captureMsgId;
    const db = getDb();

    const projectId: number | null =
      projIdRaw === "none" ? null : Number(projIdRaw);

    if (category === "task") {
      const info = db
        .prepare(
          `INSERT INTO tasks (project_id, user_tg_id, title, source_message_id)
           VALUES (?, ?, ?, ?)`,
        )
        .run(projectId, userId, captureText, Number(captureMsgId) || null);
      await ctx.reply(`✅ Task #${info.lastInsertRowid} created: "${captureText}"`);
    } else if (category === "decision") {
      const info = db
        .prepare(
          `INSERT INTO decisions (project_id, user_tg_id, context)
           VALUES (?, ?, ?)`,
        )
        .run(projectId, userId, captureText);
      ctx.session.data.pendingDecisionId = info.lastInsertRowid;
      ctx.session.step = "decision:create:choice";
      await ctx.reply(
        `🧭 Context logged: "${captureText}"\n\nWhat was the decision / which choice was made?`,
      );
      ctx.session.captureText = undefined;
      ctx.session.captureMsgId = undefined;
      ctx.session.captureCategory = undefined;
      return;
    } else if (category === "risk") {
      const info = db
        .prepare(
          `INSERT INTO risks (project_id, user_tg_id, description)
           VALUES (?, ?, ?)`,
        )
        .run(projectId, userId, captureText);
      ctx.session.data.pendingRiskId = info.lastInsertRowid;
      ctx.session.step = "risk:create:severity";
      const severityKeyboard = new InlineKeyboard()
        .text("🟢 Low", `risk:severity:${info.lastInsertRowid}:low`)
        .text("🟡 Med", `risk:severity:${info.lastInsertRowid}:med`)
        .text("🔴 High", `risk:severity:${info.lastInsertRowid}:high`);
      await ctx.reply(
        `⚠️ Risk #${info.lastInsertRowid} logged: "${captureText}"\n\nHow severe is this risk?`,
        { reply_markup: severityKeyboard },
      );
      ctx.session.captureText = undefined;
      ctx.session.captureMsgId = undefined;
      ctx.session.captureCategory = undefined;
      return;
    } else if (category === "followup") {
      const title = captureText || (ctx.session.data.followupTitle as string) || "";
      ctx.session.data.followupProjectId = projectId;
      ctx.session.data.followupTitle = title;
      ctx.session.step = "followup:create:refkind";
      const refKindKeyboard = new InlineKeyboard()
        .text("✅ Task", "fw:refkind:task")
        .text("🧭 Decision", "fw:refkind:decision")
        .text("⚠️ Risk", "fw:refkind:risk");
      await ctx.reply("⏰ Follow-up — what does this reference?", {
        reply_markup: refKindKeyboard,
      });
      ctx.session.captureText = undefined;
      ctx.session.captureMsgId = undefined;
      ctx.session.captureCategory = undefined;
      return;
    }

    ctx.session.captureText = undefined;
    ctx.session.captureMsgId = undefined;
    ctx.session.captureCategory = undefined;
  },
);

// === Callback routing: digest ===
bot.callbackQuery("digest:now", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply("Could not identify your user account.");
    return;
  }
  const digestMd = getDigestMarkdown(userId);
  try {
    await ctx.reply(digestMd, { parse_mode: "Markdown" });
  } catch {
    await ctx.reply(digestMd);
  }
});

// === Callback routing: follow-up ref_kind selection ===
bot.callbackQuery(/^fw:refkind:(task|decision|risk)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const refKind = ctx.match[1] as "task" | "decision" | "risk";
  const userId = ctx.from?.id;
  if (!userId) return;

  const title = ctx.session.data.followupTitle as string;
  const projectId = ctx.session.data.followupProjectId as number | null;
  const captureMsgId = ctx.session.captureMsgId;
  const db = getDb();

  let refId: number;
  if (refKind === "task") {
    const info = db
      .prepare(
        `INSERT INTO tasks (project_id, user_tg_id, title, source_message_id)
         VALUES (?, ?, ?, ?)`,
      )
      .run(projectId, userId, title, Number(captureMsgId) || null);
    refId = Number(info.lastInsertRowid);
  } else if (refKind === "decision") {
    const info = db
      .prepare(
        `INSERT INTO decisions (project_id, user_tg_id, context)
         VALUES (?, ?, ?)`,
      )
      .run(projectId, userId, title);
    refId = Number(info.lastInsertRowid);
  } else {
    const info = db
      .prepare(
        `INSERT INTO risks (project_id, user_tg_id, description)
         VALUES (?, ?, ?)`,
      )
      .run(projectId, userId, title);
    refId = Number(info.lastInsertRowid);
  }

  ctx.session.data.followupRefKind = refKind;
  ctx.session.data.followupRefId = refId;
  ctx.session.data.followupTitle = undefined;
  ctx.session.step = "followup:create:deadline";

  const kindLabel =
    refKind === "task"
      ? "✅ Task"
      : refKind === "decision"
      ? "🧭 Decision"
      : "⚠️ Risk";
  await ctx.reply(
    `${kindLabel} #${refId} created as reference.\n\n⏰ When is the deadline? (e.g. "tomorrow", "Friday", "2026-07-01")`,
  );
});

// === Callback routing: follow-up priority selection ===
bot.callbackQuery(/^fw:pri:(high|med|low)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const priority = ctx.match[1] as "high" | "med" | "low";
  const userId = ctx.from?.id;
  if (!userId) return;

  const refKind = ctx.session.data.followupRefKind as string;
  const refId = ctx.session.data.followupRefId as number;
  const deadline = ctx.session.data.followupDeadline as string;
  if (!refKind || !refId || !deadline) {
    ctx.session.step = "idle";
    await ctx.reply("⚠️ Something went wrong. Please try again.");
    return;
  }

  const db = getDb();
  db.prepare(
    `INSERT INTO follow_ups (user_tg_id, ref_kind, ref_id, deadline, priority)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(userId, refKind, refId, deadline, priority);

  const info = db.prepare("SELECT last_insert_rowid() as id").get() as {
    id: number;
  };
  const priorityLabel =
    priority === "high"
      ? "🔴 High"
      : priority === "med"
      ? "🟡 Medium"
      : "🟢 Low";

  ctx.session.data.followupRefKind = undefined;
  ctx.session.data.followupRefId = undefined;
  ctx.session.data.followupDeadline = undefined;
  ctx.session.data.followupProjectId = undefined;
  ctx.session.step = "idle";

  await ctx.reply(
    `⏰ Follow-up #${info.id} created! Deadline: ${deadline}, Priority: ${priorityLabel}`,
  );
});

// === Callback routing: follow-up standalone creation ===
bot.callbackQuery("followups:new", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "followup:create:title";
  await ctx.reply("⏰ New follow-up — what do you need to follow up on?");
});

// === Callback routing: follow-up mark done ===
bot.callbackQuery(/^fw:done:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const fwId = Number(ctx.match[1]);
  const userId = ctx.from?.id;
  if (!userId) return;
  const db = getDb();
  db.prepare(
    `UPDATE follow_ups SET status = 'done', notified_at = datetime('now') WHERE id = ? AND user_tg_id = ?`,
  ).run(fwId, userId);
  await ctx.reply(`✅ Follow-up #${fwId} marked as done.`);
});

// === Callback routing: follow-up dismiss ===
bot.callbackQuery(/^fw:dismiss:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const fwId = Number(ctx.match[1]);
  const userId = ctx.from?.id;
  if (!userId) return;
  const db = getDb();
  db.prepare(
    `UPDATE follow_ups SET status = 'dismissed', notified_at = datetime('now') WHERE id = ? AND user_tg_id = ?`,
  ).run(fwId, userId);
  await ctx.reply(`❌ Follow-up #${fwId} dismissed.`);
});

// === Callback routing: tasks pagination ===
bot.callbackQuery(/^tasks:page:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from?.id;
  if (!userId) return;
  const page = Number(ctx.match[1]);
  ctx.session.tasksPage = page;
  const filter = ctx.session.tasksFilter || "";
  const { text, keyboard } = buildTasksList(userId, filter, page);
  await ctx.reply(text, {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
});

bot.callbackQuery("tasks:noop", async (ctx) => {
  await ctx.answerCallbackQuery();
});

// === Callback routing: navigation screens ===
bot.callbackQuery("dec:list", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from?.id;
  if (!userId) return;
  await renderDecisionsScreen(ctx, userId);
});

bot.callbackQuery("risks:list", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from?.id;
  if (!userId) return;
  await renderRisksScreen(ctx, userId);
});

bot.callbackQuery("followups:list", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from?.id;
  if (!userId) return;
  await renderFollowupsScreen(ctx, userId);
});

bot.callbackQuery("patterns:list", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from?.id;
  if (!userId) return;
  await renderPatternsScreen(ctx, userId);
});

bot.callbackQuery("menu:main", async (ctx) => {
  await ctx.answerCallbackQuery();
  const mainKeyboard = new InlineKeyboard()
    .text("➕ Capture", "cat:new").row()
    .text("📂 Projects", "proj:list")
    .text("✅ Tasks", "tasks:list").row()
    .text("🧭 Decisions", "dec:list")
    .text("⚠️ Risks", "risks:list").row()
    .text("⏰ Follow-ups", "followups:list")
    .text("🔍 Patterns", "patterns:list").row()
    .text("📊 Digest", "digest:now");

  await ctx.reply(
    "👋 Welcome to Pocket COO!\n\n" +
      "I help you turn chaotic chats into structured projects and tasks. " +
      "Just forward me any message, voice note, or screenshot — I'll ask where it goes.",
    { reply_markup: mainKeyboard },
  );
});

// === Fallback for unrecognized callback data ===
bot.callbackQuery(/.*/, async (ctx) => {
  await ctx.answerCallbackQuery();
  console.warn(`Unhandled callback data: ${ctx.callbackQuery.data}`);
});

// === Plain text message handler for FSM-driven flows ===
bot.on("message:text", async (ctx) => {
  const step = ctx.session.step;
  if (step && step !== "idle") {
    if (step === "project:create:name") {
      const projectName = ctx.message.text.trim();
      ctx.session.data.projectName = projectName;
      ctx.session.step = "project:create:description";
      await ctx.reply(
        `📂 Project: *${projectName}*\n\nAdd a description? (or send "-" to skip)`,
        { parse_mode: "Markdown" },
      );
      return;
    }

    if (step === "project:create:description") {
      const description = ctx.message.text.trim();
      const projectName = ctx.session.data.projectName as string;
      const finalDescription = description === "-" ? "" : description;
      const userId = ctx.from?.id;
      if (!userId) return;
      const db = getDb();
      db.prepare(
        "INSERT INTO users (tg_id, name) VALUES (?, ?) ON CONFLICT(tg_id) DO UPDATE SET name = excluded.name",
      ).run(userId, ctx.from?.username || ctx.from?.first_name || `user${userId}`);
      const info = db
        .prepare(
          "INSERT INTO projects (user_tg_id, name, description) VALUES (?, ?, ?)",
        )
        .run(userId, projectName, finalDescription);
      ctx.session.data.projectName = undefined;
      ctx.session.step = "idle";
      const descSuffix = finalDescription
        ? `\n📝 ${finalDescription}`
        : "";
      await ctx.reply(
        `📂 Project *${projectName}* created! (#${info.lastInsertRowid})${descSuffix}`,
        { parse_mode: "Markdown" },
      );
      return;
    }

    if (step === "task:create:title") {
      const title = ctx.message.text.trim();
      ctx.session.data.taskTitle = title;
      ctx.session.step = "task:create:priority";

      const priorityKeyboard = new InlineKeyboard()
        .text("🔴 High", "tasks:pri:high")
        .text("🟡 Medium", "tasks:pri:med")
        .text("🟢 Low", "tasks:pri:low");

      await ctx.reply(
        `✅ Task title: *${title}*\n\nWhat's the priority?`,
        { parse_mode: "Markdown", reply_markup: priorityKeyboard },
      );
      return;
    }

    if (step === "task:create:priority") {
      const priorityRaw = ctx.message.text.trim().toLowerCase();
      const validPriorities = ["high", "med", "medium", "low"] as const;
      let priority: "high" | "med" | "low" | null = null;
      if (validPriorities.includes(priorityRaw as typeof validPriorities[number])) {
        priority = (priorityRaw === "medium" ? "med" : priorityRaw) as
          | "high"
          | "med"
          | "low";
        ctx.session.data.taskPriority = priority;
        ctx.session.step = "task:create:deadline";
        const title = ctx.session.data.taskTitle as string;
        const priorityLabel =
          priority === "high"
            ? "🔴 High"
            : priority === "med"
            ? "🟡 Medium"
            : "🟢 Low";
        await ctx.reply(
          `✅ Task: *${title}* (${priorityLabel})\n\n⏰ What's the deadline? (e.g. "tomorrow", "Friday", "2026-07-01", or send "-" to skip)`,
          { parse_mode: "Markdown" },
        );
        return;
      }
      await ctx.reply(
        'Please pick a priority by clicking one of the buttons, or type "high", "med", or "low".',
      );
      return;
    }

    if (step === "task:create:deadline") {
      const deadlineRaw = ctx.message.text.trim();
      const deadline = deadlineRaw === "-" ? "" : deadlineRaw;
      ctx.session.data.taskDeadline = deadline;
      await showTaskConfirm(ctx);
      return;
    }

    if (step === "task:create:title_edit") {
      const title = ctx.message.text.trim();
      ctx.session.data.taskTitle = title;
      await showTaskConfirm(ctx);
      return;
    }

    if (step === "task:create:deadline_edit") {
      const deadlineRaw = ctx.message.text.trim();
      const deadline = deadlineRaw === "-" ? "" : deadlineRaw;
      ctx.session.data.taskDeadline = deadline;
      await showTaskConfirm(ctx);
      return;
    }

    if (step === "decision:create:context") {
      const context = ctx.message.text.trim();
      ctx.session.data.decisionContext = context;
      ctx.session.step = "idle";
      await ctx.reply(`🧭 Decision logged: "${context}"`);
      return;
    }

    if (step === "decision:create:choice") {
      const choice = ctx.message.text.trim();
      const decisionId = ctx.session.data.pendingDecisionId as number;
      const userId = ctx.from?.id;
      if (decisionId && userId) {
        const db = getDb();
        db.prepare(
          `UPDATE decisions SET choice = ? WHERE id = ? AND user_tg_id = ?`,
        ).run(choice, decisionId, userId);
        await ctx.reply(
          `🧭 Decision #${decisionId} confirmed: "${choice}"`,
        );
      }
      ctx.session.step = "idle";
      ctx.session.data.pendingDecisionId = undefined;
      return;
    }

    if (step === "risk:create:description") {
      const description = ctx.message.text.trim();
      const userId = ctx.from?.id;
      if (!userId) return;
      const db = getDb();
      const info = db
        .prepare(
          `INSERT INTO risks (user_tg_id, description)
           VALUES (?, ?)`,
        )
        .run(userId, description);
      ctx.session.data.pendingRiskId = info.lastInsertRowid;
      ctx.session.step = "risk:create:severity";
      const severityKeyboard = new InlineKeyboard()
        .text("🟢 Low", `risk:severity:${info.lastInsertRowid}:low`)
        .text("🟡 Med", `risk:severity:${info.lastInsertRowid}:med`)
        .text("🔴 High", `risk:severity:${info.lastInsertRowid}:high`);
      await ctx.reply(
        `⚠️ Risk #${info.lastInsertRowid} logged: "${description}"\n\nHow severe is this risk?`,
        { reply_markup: severityKeyboard },
      );
      return;
    }

    if (step === "risk:create:mitigation") {
      const mitigationText = ctx.message.text.trim();
      const mitigation = mitigationText === "-" ? "" : mitigationText;
      const riskId = ctx.session.data.pendingRiskId as number;
      const userId = ctx.from?.id;
      if (riskId && userId) {
        const db = getDb();
        db.prepare(
          `UPDATE risks SET mitigation = ? WHERE id = ? AND user_tg_id = ?`,
        ).run(mitigation, riskId, userId);
      }
      ctx.session.step = "idle";
      ctx.session.data.pendingRiskId = undefined;
      const mitSuffix = mitigation ? `\n🛡 Mitigation: ${mitigation}` : " (no mitigation yet)";
      await ctx.reply(`⚠️ Risk #${riskId} fully logged.${mitSuffix}`);
      return;
    }

    if (step === "followup:create:title") {
      const title = ctx.message.text.trim();
      ctx.session.data.followupTitle = title;
      ctx.session.step = "followup:create:project";
      const userId = ctx.from?.id;
      if (!userId) return;
      await ctx.reply("⏰ Follow-up — select a project:", {
        reply_markup: projectPickerKeyboard(userId, "followup"),
      });
      return;
    }

    if (step === "followup:create:deadline") {
      const deadline = ctx.message.text.trim();
      ctx.session.data.followupDeadline = deadline;
      ctx.session.step = "followup:create:priority";
      const priorityKeyboard = new InlineKeyboard()
        .text("🔴 High", "fw:pri:high")
        .text("🟡 Medium", "fw:pri:med")
        .text("🟢 Low", "fw:pri:low");
      await ctx.reply("⏰ Deadline set. What's the priority?", {
        reply_markup: priorityKeyboard,
      });
      return;
    }

    if (step === "followup:create:priority") {
      const priorityRaw = ctx.message.text.trim().toLowerCase();
      const validPriorities = ["high", "med", "medium", "low"] as const;
      let priority: "high" | "med" | "low" = "med";
      if (validPriorities.includes(priorityRaw as typeof validPriorities[number])) {
        priority = (priorityRaw === "medium" ? "med" : priorityRaw) as
          | "high"
          | "med"
          | "low";
      } else {
        await ctx.reply(
          'Please pick a priority by clicking one of the buttons, or type "high", "med", or "low".',
        );
        return;
      }

      const userId = ctx.from?.id;
      if (!userId) return;
      const refKind = ctx.session.data.followupRefKind as string;
      const refId = ctx.session.data.followupRefId as number;
      const deadline = ctx.session.data.followupDeadline as string;
      if (!refKind || !refId || !deadline) {
        ctx.session.step = "idle";
        await ctx.reply("⚠️ Something went wrong. Please try again.");
        return;
      }

      const db = getDb();
      db.prepare(
        `INSERT INTO follow_ups (user_tg_id, ref_kind, ref_id, deadline, priority)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(userId, refKind, refId, deadline, priority);

      const info = db.prepare("SELECT last_insert_rowid() as id").get() as {
        id: number;
      };
      const priorityLabel =
        priority === "high"
          ? "🔴 High"
          : priority === "med"
          ? "🟡 Medium"
          : "🟢 Low";

      ctx.session.data.followupRefKind = undefined;
      ctx.session.data.followupRefId = undefined;
      ctx.session.data.followupDeadline = undefined;
      ctx.session.data.followupProjectId = undefined;
      ctx.session.step = "idle";

      await ctx.reply(
        `⏰ Follow-up #${info.id} created! Deadline: ${deadline}, Priority: ${priorityLabel}`,
      );
      return;
    }

    if (step === "decision:resolve:outcome") {
      const outcome = ctx.message.text.trim();
      const decisionId = ctx.session.data.resolvingDecisionId as number;
      const userId = ctx.from?.id;
      if (decisionId && userId) {
        const db = getDb();
        db.prepare(
          `UPDATE decisions SET outcome = ?, status = 'resolved' WHERE id = ? AND user_tg_id = ?`,
        ).run(outcome, decisionId, userId);
        await ctx.reply(
          `🧭 Decision #${decisionId} resolved: "${outcome}"`,
        );
      }
      ctx.session.step = "idle";
      ctx.session.data.resolvingDecisionId = undefined;
      return;
    }
    return;
  }

  const result = await intakeTextMessage(ctx);
  if (result) {
    await showCaptureCard(ctx, result);
  }
});

// === Voice message handler ===
bot.on("message:voice", async (ctx) => {
  const result = await intakeVoiceMessage(ctx);
  if (result) {
    await showCaptureCard(ctx, result);
  }
});

// === Photo message handler ===
bot.on("message:photo", async (ctx) => {
  const result = await intakePhotoMessage(ctx);
  if (result) {
    await showCaptureCard(ctx, result);
  }
});

// === Document message handler ===
bot.on("message:document", async (ctx) => {
  const result = await intakeDocumentMessage(ctx);
  if (result) {
    await showCaptureCard(ctx, result);
  }
});

// === Start long polling ===
startDigestScheduler(bot);
startPatternScheduler(bot);
bot.start({
  onStart(info) {
    console.log(`Bot started as @${info.username}`);
  },
});
