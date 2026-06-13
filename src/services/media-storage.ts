import { Api } from "grammy";
import * as fs from "fs";
import * as path from "path";

const MEDIA_DIR = process.env.MEDIA_DIR || path.join(process.cwd(), "media");
const MEDIA_BUCKET = process.env.MEDIA_BUCKET || "";

function ensureMediaDir(): string {
  if (!fs.existsSync(MEDIA_DIR)) {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
  }
  return MEDIA_DIR;
}

function s3Enabled(): boolean {
  return MEDIA_BUCKET.length > 0;
}

export async function storeMedia(
  api: Api,
  fileId: string,
): Promise<string | null> {
  try {
    if (s3Enabled()) {
      return storeToS3(api, fileId);
    }
    return storeLocal(api, fileId);
  } catch (err) {
    console.error("media-storage: failed to store media", err);
    return null;
  }
}

async function storeLocal(api: Api, fileId: string): Promise<string> {
  const file = await api.getFile(fileId);
  const ext = path.extname(file.file_path || "") || ".bin";
  const filename = `${fileId}${ext}`;
  const dest = path.join(ensureMediaDir(), filename);

  const url = `https://api.telegram.org/file/bot${api.token}/${file.file_path}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(dest, buffer);

  return dest;
}

async function storeToS3(api: Api, fileId: string): Promise<string> {
  const file = await api.getFile(fileId);
  const ext = path.extname(file.file_path || "") || ".bin";
  const key = `media/${fileId}${ext}`;

  const url = `https://api.telegram.org/file/bot${api.token}/${file.file_path}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());

  const localPath = path.join(ensureMediaDir(), `${fileId}${ext}`);
  fs.writeFileSync(localPath, buffer);

  return `s3://${MEDIA_BUCKET}/${key}`;
}
