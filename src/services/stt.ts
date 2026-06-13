export interface SttProvider {
  transcribe(audioBuffer: Buffer, mimeType: string): Promise<string>;
}

function createNoopSttProvider(): SttProvider {
  return {
    async transcribe(_audioBuffer: Buffer, _mimeType: string): Promise<string> {
      return "[Voice transcription not configured — set STT_PROVIDER=openai and STT_API_KEY]";
    },
  };
}

function createOpenAiSttProvider(): SttProvider {
  const apiKey = process.env.STT_API_KEY || "";
  const model = process.env.STT_MODEL || "whisper-1";

  return {
    async transcribe(audioBuffer: Buffer, mimeType: string): Promise<string> {
      try {
        const boundary = "stt-boundary-" + Date.now();
        const filename = mimeType.includes("ogg") ? "audio.ogg" : "audio.mp3";

        const parts: Buffer[] = [];
        parts.push(
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`,
          ),
        );
        parts.push(
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
          ),
        );
        parts.push(audioBuffer);
        parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

        const body = Buffer.concat(parts);

        const response = await fetch(
          "https://api.openai.com/v1/audio/transcriptions",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": `multipart/form-data; boundary=${boundary}`,
            },
            body,
          },
        );

        if (!response.ok) {
          console.error("STT: OpenAI API error", response.status);
          return "[Transcription failed]";
        }

        const data = (await response.json()) as { text?: string };
        return data.text || "[No transcription returned]";
      } catch (err) {
        console.error("STT: transcription error", err);
        return "[Transcription failed]";
      }
    },
  };
}

let cachedProvider: SttProvider | null = null;

export function getSttProvider(): SttProvider {
  if (cachedProvider) return cachedProvider;

  const provider = (process.env.STT_PROVIDER || "local").toLowerCase();
  if (provider === "openai") {
    cachedProvider = createOpenAiSttProvider();
  } else {
    cachedProvider = createNoopSttProvider();
  }
  return cachedProvider;
}

export async function transcribeAudio(
  audioBuffer: Buffer,
  mimeType: string,
): Promise<string> {
  return getSttProvider().transcribe(audioBuffer, mimeType);
}
