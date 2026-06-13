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

export interface BotSession {
  step: string;
  data: Record<string, unknown>;
  captureText?: string;
  captureMsgId?: number | bigint;
  captureCategory?: string;
}

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
  const keyboard = new InlineKeyboard().text("➕ New Project", "proj:new");
  await ctx.reply("📂 *Projects*\n\nNo active projects yet.", {
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
  const keyboard = new InlineKeyboard()
    .text("All", "tasks:filter:all")
    .text("High Priority", "tasks:filter:high").row()
    .text("➕ New Task", "tasks:new");

  await ctx.reply("✅ *Tasks*\n\nNo pending tasks.", {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
});

// === Command: /decisions ===
bot.command("decisions", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply("Could not identify your user account.");
    return;
  }
  const db = getDb();
  const decisions = db.prepare(
    "SELECT id, context, choice, outcome, status, made_at FROM decisions WHERE user_tg_id = ? AND status = 'open' ORDER BY made_at DESC LIMIT 20",
  ).all(userId) as { id: number; context: string; choice: string; outcome: string | null; status: string; made_at: string }[];

  if (decisions.length === 0) {
    await ctx.reply("🧭 *Decisions*\n\nNo open decisions.", {
      parse_mode: "Markdown",
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

  await ctx.reply(lines.join("\n"), {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
});

// === Command: /risks ===
bot.command("risks", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply("Could not identify your user account.");
    return;
  }
  const db = getDb();
  const risks = db.prepare(
    "SELECT id, description, severity, mitigation, status FROM risks WHERE user_tg_id = ? AND status = 'open' ORDER BY id DESC LIMIT 20",
  ).all(userId) as { id: number; description: string; severity: string; mitigation: string | null; status: string }[];

  if (risks.length === 0) {
    await ctx.reply("⚠️ *Risks*\n\nNo open risks.", {
      parse_mode: "Markdown",
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

  await ctx.reply(lines.join("\n"), {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
});

// === Command: /followups ===
bot.command("followups", async (ctx) => {
  await ctx.reply("⏰ *Follow-ups*\n\nNo pending follow-ups.", {
    parse_mode: "Markdown",
  });
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
bot.command("patterns", async (ctx) => {
  await ctx.reply("🔍 *Patterns*\n\nNo recurring phrases detected yet.", {
    parse_mode: "Markdown",
  });
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
  const keyboard = new InlineKeyboard().text("➕ New Project", "proj:new");
  await ctx.reply("📂 *Projects*\n\nNo active projects yet.", {
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
  await ctx.reply("📦 Project archived.");
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
  await ctx.reply("📋 Project opened.");
});

// === Callback routing: tasks ===
bot.callbackQuery("tasks:list", async (ctx) => {
  await ctx.answerCallbackQuery();
  const keyboard = new InlineKeyboard()
    .text("All", "tasks:filter:all")
    .text("High Priority", "tasks:filter:high").row()
    .text("➕ New Task", "tasks:new");
  await ctx.reply("✅ *Tasks*\n\nNo pending tasks.", {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
});

bot.callbackQuery("tasks:new", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "task:create:title";
  await ctx.reply("✅ Task creation — what's the title?");
});

bot.callbackQuery(/^tasks:done:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply("✅ Task marked as done.");
});

bot.callbackQuery(/^tasks:filter:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply("✅ Filter applied (to be implemented).");
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
      const taskInfo = db
        .prepare(
          `INSERT INTO tasks (project_id, user_tg_id, title, source_message_id)
           VALUES (?, ?, ?, ?)`,
        )
        .run(projectId, userId, captureText, Number(captureMsgId) || null);
      ctx.session.data.followupRefTaskId = taskInfo.lastInsertRowid;
      ctx.session.step = "followup:create:deadline";
      await ctx.reply(
        `✅ Task #${taskInfo.lastInsertRowid} created as ref. ⏰ When is the deadline?`,
      );
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
      ctx.session.step = "idle";
      await ctx.reply(`✅ Task "${title}" created!`);
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

    if (step === "followup:create:deadline") {
      const deadline = ctx.message.text.trim();
      const db = getDb();
      const refTaskId = ctx.session.data.followupRefTaskId as number;
      const userId = ctx.from?.id;
      if (refTaskId && userId) {
        db.prepare(
          `INSERT INTO follow_ups (user_tg_id, ref_kind, ref_id, deadline)
           VALUES (?, 'task', ?, ?)`,
        ).run(userId, refTaskId, deadline);
      }
      ctx.session.data.followupRefTaskId = undefined;
      ctx.session.step = "idle";
      await ctx.reply(`⏰ Follow-up set for: ${deadline}`);
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
bot.start({
  onStart(info) {
    console.log(`Bot started as @${info.username}`);
  },
});
