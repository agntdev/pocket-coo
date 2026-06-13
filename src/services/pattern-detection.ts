import { getDb } from "../db/database";
import type { Bot } from "grammy";
import type { BotContext } from "../bot";

const STOPLIST = new Set([
  "meeting", "today", "tomorrow", "yeah", "okay", "yes", "no",
  "thanks", "thank", "please", "hello", "hi", "hey", "morning",
  "good", "great", "nice", "well", "just", "also", "still",
  "really", "very", "much", "many", "some", "any", "all",
  "this", "that", "these", "those", "there", "here",
  "have", "has", "had", "will", "would", "could", "should",
  "can", "may", "might", "must", "shall", "need", "want",
  "get", "got", "go", "went", "going", "do", "did", "does",
  "say", "said", "see", "saw", "know", "knew", "think",
  "make", "made", "come", "came", "take", "took",
  "give", "gave", "use", "used", "find", "found",
  "tell", "told", "ask", "asked", "work", "try", "tried",
  "call", "called", "keep", "put", "let", "look",
  "like", "about", "the", "for", "but", "and",
  "doesn", "don", "didn", "isn", "wasn", "been",
  "was", "are", "were", "am", "is", "be", "being",
  "we", "you", "i", "he", "she", "it", "they", "me",
  "him", "her", "us", "them", "my", "your", "our", "their",
  "with", "from", "into", "over", "back", "after",
  "before", "one", "two", "first", "the", "a", "an",
  "what", "which", "who", "how", "when", "where",
  "more", "then", "now", "not", "so", "if", "or",
  "than", "too", "other", "out", "up", "its",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim().replace(/^['-]+|['-]+$/g, ""))
    .filter((t) => t.length > 0 && !/^\d+$/.test(t));
}

function extractPhrases(tokens: string[]): string[] {
  const phrases = new Set<string>();
  for (let len = 2; len <= 4; len++) {
    for (let i = 0; i <= tokens.length - len; i++) {
      const slice = tokens.slice(i, i + len);
      if (slice.every((t) => !STOPLIST.has(t))) {
        phrases.add(slice.join(" "));
      }
    }
  }
  return Array.from(phrases);
}

export function detectPatternsForUser(userTgId: number): void {
  const db = getDb();

  const user = db.prepare(
    "SELECT tz_offset_min FROM users WHERE tg_id = ?",
  ).get(userTgId) as { tz_offset_min: number } | undefined;

  if (!user) return;

  const now = new Date();
  const userMs = now.getTime() + user.tz_offset_min * 60 * 1000;
  const userNow = new Date(userMs);
  const sevenDaysAgo = new Date(userNow);
  sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 7);
  sevenDaysAgo.setUTCHours(0, 0, 0, 0);

  const utcCutoff = new Date(
    sevenDaysAgo.getTime() - user.tz_offset_min * 60 * 1000,
  );
  const cutoffTs = utcCutoff.toISOString().replace("T", " ").slice(0, 19);

  const messages = db.prepare(
    "SELECT raw_text FROM messages WHERE user_tg_id = ? AND received_at >= ? AND raw_text IS NOT NULL",
  ).all(userTgId, cutoffTs) as { raw_text: string }[];

  const phraseCounts = new Map<string, { count: number; firstSeen: Date; lastSeen: Date }>();

  for (const msg of messages) {
    const tokens = tokenize(msg.raw_text);
    const phrases = extractPhrases(tokens);
    for (const phrase of phrases) {
      const existing = phraseCounts.get(phrase);
      if (existing) {
        existing.count++;
      } else {
        phraseCounts.set(phrase, { count: 1, firstSeen: new Date(), lastSeen: new Date() });
      }
    }
  }

  const recurringPhrases: Map<string, number> = new Map();
  for (const [phrase, data] of phraseCounts) {
    if (data.count >= 3) {
      recurringPhrases.set(phrase, data.count);
    }
  }

  const existingPatterns = db.prepare(
    "SELECT phrase FROM patterns WHERE user_tg_id = ?",
  ).all(userTgId) as { phrase: string }[];

  const existingSet = new Set(existingPatterns.map((p) => p.phrase));
  const nowIso = new Date().toISOString().replace("T", " ").slice(0, 19);

  const upsertExisting = db.prepare(
    "UPDATE patterns SET occurrences = ?, last_seen = ? WHERE user_tg_id = ? AND phrase = ?",
  );

  const upsertNew = db.prepare(
    `INSERT INTO patterns (user_tg_id, phrase, occurrences, window_days, first_seen, last_seen)
     VALUES (?, ?, ?, 7, ?, ?)`,
  );

  const deleteStale = db.prepare(
    "DELETE FROM patterns WHERE user_tg_id = ? AND phrase = ?",
  );

  const transaction = db.transaction(() => {
    for (const phrase of existingSet) {
      if (!recurringPhrases.has(phrase)) {
        deleteStale.run(userTgId, phrase);
      }
    }

    for (const [phrase, count] of recurringPhrases) {
      if (existingSet.has(phrase)) {
        upsertExisting.run(count, nowIso, userTgId, phrase);
      } else {
        upsertNew.run(userTgId, phrase, count, nowIso, nowIso);
      }
    }
  });

  transaction();
}

function isUserLocal0300(user: { tg_id: number; tz_offset_min: number }): boolean {
  const now = new Date();
  const utcMs = now.getTime();
  const userMs = utcMs + user.tz_offset_min * 60 * 1000;
  const userDate = new Date(userMs);

  const hours = userDate.getUTCHours();
  const minutes = userDate.getUTCMinutes();

  return hours === 3 && minutes >= 0 && minutes < 2;
}

let schedulerInterval: ReturnType<typeof setInterval> | null = null;

export function startPatternScheduler(bot: Bot<BotContext>): void {
  if (schedulerInterval) return;

  schedulerInterval = setInterval(() => {
    const db = getDb();
    const users = db.prepare(
      "SELECT tg_id, tz_offset_min FROM users",
    ).all() as { tg_id: number; tz_offset_min: number }[];

    for (const user of users) {
      if (isUserLocal0300(user)) {
        try {
          detectPatternsForUser(user.tg_id);
          console.log(`Pattern detection ran for user ${user.tg_id}`);
        } catch (err) {
          console.error(
            `Pattern detection failed for user ${user.tg_id}:`,
            err,
          );
        }
      }
    }
  }, 60_000);
}

export function stopPatternScheduler(): void {
  if (schedulerInterval !== null) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
}