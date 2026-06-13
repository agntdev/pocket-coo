import Database from "better-sqlite3";
import path from "path";
import { initializeSchema } from "./schema";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    const dbPath =
      process.env.SQLITE_PATH ||
      path.join(__dirname, "..", "pocket-coo.db");
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    initializeSchema(db);
  }
  return db;
}
