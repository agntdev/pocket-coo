import type { Context } from "grammy";
import { getDb } from "../db/database";
import { storeMedia } from "./media-storage";
import { transcribeAudio } from "./stt";
import { extractTextFromImage } from "./ocr";

export interface IntakeResult {
  msgId: number | bigint;
  rawText: string;
  kind: "text" | "voice" | "image" | "document";
  mediaUrl: string | null;
}

async function upsertUser(tgId: number, name: string): Promise<void> {
  const db = getDb();
  db.prepare(
    "INSERT INTO users (tg_id, name) VALUES (?, ?) ON CONFLICT(tg_id) DO UPDATE SET name = excluded.name",
  ).run(tgId, name);
}

function forwardedFrom(ctx: Context): string | null {
  const fwd = ctx.message?.forward_origin;
  if (!fwd) return null;
  if ("chat" in fwd && fwd.chat) {
    const c = fwd.chat as { title?: string; username?: string };
    return c.title || c.username || null;
  }
  if ("sender_user_name" in fwd) {
    return `user:${(fwd as { sender_user_name?: string }).sender_user_name}`;
  }
  return null;
}

function insertMessage(
  userTgId: number,
  kind: string,
  rawText: string | null,
  mediaUrl: string | null,
  fwdFromChat: string | null,
): number | bigint {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO messages (user_tg_id, kind, raw_text, media_url, forwarded_from_chat)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(userTgId, kind, rawText, mediaUrl, fwdFromChat);
  return result.lastInsertRowid;
}

export async function intakeTextMessage(
  ctx: Context,
): Promise<IntakeResult | null> {
  const userId = ctx.from?.id;
  if (!userId || !ctx.message) return null;

  await upsertUser(userId, ctx.from?.username || ctx.from?.first_name || `user${userId}`);

  const rawText = ctx.message.text || ctx.message.caption || "";
  if (!rawText.trim()) return null;

  const fwd = forwardedFrom(ctx);
  const msgId = insertMessage(userId, "text", rawText, null, fwd);

  return { msgId, rawText, kind: "text", mediaUrl: null };
}

export async function intakeVoiceMessage(
  ctx: Context,
): Promise<IntakeResult | null> {
  const userId = ctx.from?.id;
  if (!userId || !ctx.message?.voice) return null;

  await upsertUser(userId, ctx.from?.username || ctx.from?.first_name || `user${userId}`);

  const voice = ctx.message.voice;
  const mediaUrl = await storeMedia(ctx.api, voice.file_id);

  let rawText: string;
  try {
    const fileUrl = `https://api.telegram.org/file/bot${ctx.api.token}/${(await ctx.api.getFile(voice.file_id)).file_path}`;
    const response = await fetch(fileUrl);
    if (response.ok) {
      const buffer = Buffer.from(await response.arrayBuffer());
      const mimeType = voice.mime_type || "audio/ogg";
      rawText = await transcribeAudio(buffer, mimeType);
    } else {
      rawText = "[Failed to download voice file]";
    }
  } catch {
    rawText = "[Failed to transcribe voice]";
  }

  const fwd = forwardedFrom(ctx);
  const msgId = insertMessage(userId, "voice", rawText, mediaUrl, fwd);

  return { msgId, rawText, kind: "voice", mediaUrl };
}

export async function intakePhotoMessage(
  ctx: Context,
): Promise<IntakeResult | null> {
  const userId = ctx.from?.id;
  if (!userId || !ctx.message?.photo) return null;

  await upsertUser(userId, ctx.from?.username || ctx.from?.first_name || `user${userId}`);

  const photos = ctx.message.photo;
  const largest = photos[photos.length - 1];
  const mediaUrl = await storeMedia(ctx.api, largest.file_id);

  let rawText: string;
  try {
    const file = await ctx.api.getFile(largest.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`;
    const response = await fetch(fileUrl);
    if (response.ok) {
      const buffer = Buffer.from(await response.arrayBuffer());
      const mimeType = "image/jpeg";
      rawText = await extractTextFromImage(buffer, mimeType);
    } else {
      rawText = "[Failed to download image]";
    }
  } catch {
    rawText = "[Failed to extract text from image]";
  }

  const caption = ctx.message.caption || "";
  if (caption.trim()) {
    rawText = `${caption}\n\n[Image text: ${rawText}]`;
  }

  const fwd = forwardedFrom(ctx);
  const msgId = insertMessage(userId, "image", rawText, mediaUrl, fwd);

  return { msgId, rawText, kind: "image", mediaUrl };
}

export async function intakeDocumentMessage(
  ctx: Context,
): Promise<IntakeResult | null> {
  const userId = ctx.from?.id;
  if (!userId || !ctx.message?.document) return null;

  await upsertUser(userId, ctx.from?.username || ctx.from?.first_name || `user${userId}`);

  const doc = ctx.message.document;
  const mediaUrl = await storeMedia(ctx.api, doc.file_id);

  let rawText = doc.file_name || `document_${doc.file_id}`;
  const caption = ctx.message.caption || "";
  if (caption.trim()) {
    rawText = `${rawText}\n\nCaption: ${caption}`;
  }

  const fwd = forwardedFrom(ctx);
  const msgId = insertMessage(userId, "document", rawText, mediaUrl, fwd);

  return { msgId, rawText, kind: "document", mediaUrl };
}
