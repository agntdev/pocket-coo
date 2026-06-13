export interface OcrProvider {
  extractText(imageBuffer: Buffer, mimeType: string): Promise<string>;
}

function createNoopOcrProvider(): OcrProvider {
  return {
    async extractText(
      _imageBuffer: Buffer,
      _mimeType: string,
    ): Promise<string> {
      return "[Image OCR not configured — set OCR_PROVIDER=openai and OCR_API_KEY]";
    },
  };
}

function createOpenAiOcrProvider(): OcrProvider {
  const apiKey = process.env.OCR_API_KEY || process.env.STT_API_KEY || "";

  return {
    async extractText(
      imageBuffer: Buffer,
      mimeType: string,
    ): Promise<string> {
      try {
        const base64 = imageBuffer.toString("base64");
        const dataUrl = `data:${mimeType};base64,${base64}`;

        const response = await fetch(
          "https://api.openai.com/v1/chat/completions",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "gpt-4o",
              messages: [
                {
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: "Extract all visible text from this image. Return only the extracted text, nothing else.",
                    },
                    {
                      type: "image_url",
                      image_url: { url: dataUrl },
                    },
                  ],
                },
              ],
              max_tokens: 500,
            }),
          },
        );

        if (!response.ok) {
          console.error("OCR: OpenAI API error", response.status);
          return "[OCR extraction failed]";
        }

        const data = (await response.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        return (
          data.choices?.[0]?.message?.content?.trim() ||
          "[No text extracted]"
        );
      } catch (err) {
        console.error("OCR: extraction error", err);
        return "[OCR extraction failed]";
      }
    },
  };
}

let cachedProvider: OcrProvider | null = null;

export function getOcrProvider(): OcrProvider {
  if (cachedProvider) return cachedProvider;

  const provider = (process.env.OCR_PROVIDER || "local").toLowerCase();
  if (provider === "openai") {
    cachedProvider = createOpenAiOcrProvider();
  } else {
    cachedProvider = createNoopOcrProvider();
  }
  return cachedProvider;
}

export async function extractTextFromImage(
  imageBuffer: Buffer,
  mimeType: string,
): Promise<string> {
  return getOcrProvider().extractText(imageBuffer, mimeType);
}
