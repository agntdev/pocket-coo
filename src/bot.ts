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

async function showCaptureCard(
  ctx: BotContext,
  result: IntakeResult,
): Promise<void> {
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
  await ctx.reply(`📂 Project "${name}" created!`);
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
  await ctx.reply("🧭 *Decisions*\n\nNo open decisions.", {
    parse_mode: "Markdown",
  });
});

// === Command: /risks ===
bot.command("risks", async (ctx) => {
  await ctx.reply("⚠️ *Risks*\n\nNo open risks.", {
    parse_mode: "Markdown",
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
  ctx.session.step = "task:create:title";
  await ctx.reply("✅ Task creation — what's the title?");
});

bot.callbackQuery(/^cat:decision:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "decision:create:context";
  await ctx.reply("🧭 Decision — what's the context?");
});

bot.callbackQuery(/^cat:risk:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "risk:create:description";
  await ctx.reply("⚠️ Risk — describe the risk:");
});

bot.callbackQuery(/^cat:followup:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "followup:create:deadline";
  await ctx.reply("⏰ Follow-up — when is the deadline?");
});

bot.callbackQuery(/^cat:ignore:/, async (ctx) => {
  await ctx.answerCallbackQuery();
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

bot.callbackQuery(/^proj:archive:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply("📦 Project archived.");
});

bot.callbackQuery(/^proj:open:/, async (ctx) => {
  await ctx.answerCallbackQuery();
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
bot.callbackQuery(/^dec:resolve:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "decision:resolve:outcome";
  await ctx.reply("🧭 What was the outcome?");
});

// === Callback routing: risks ===
bot.callbackQuery(/^risk:close:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply("📦 Risk closed.");
});

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
      ctx.session.step = "idle";
      await ctx.reply(`📂 Project "${projectName}" created!`);
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

    if (step === "risk:create:description") {
      const description = ctx.message.text.trim();
      ctx.session.data.riskDescription = description;
      ctx.session.step = "idle";
      await ctx.reply(`⚠️ Risk logged: "${description}"`);
      return;
    }

    if (step === "followup:create:deadline") {
      const deadline = ctx.message.text.trim();
      ctx.session.data.followupDeadline = deadline;
      ctx.session.step = "idle";
      await ctx.reply(`⏰ Follow-up set for: ${deadline}`);
      return;
    }

    if (step === "decision:resolve:outcome") {
      const outcome = ctx.message.text.trim();
      ctx.session.step = "idle";
      await ctx.reply(`🧭 Decision resolved: "${outcome}"`);
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
