export type Category = "task" | "decision" | "risk" | "followup" | "ignore";

export interface CategorizerResult {
  category: Category | null;
  confidence: number;
  source: "rule" | "nlp";
  reason: string;
}

interface Rule {
  name: string;
  pattern: RegExp;
  category: Category;
  confidence: number;
}

const RULES: Rule[] = [
  {
    name: "explicit-decision",
    pattern: /\b(?:decide|decision|should\s+(?:I|we|they)|(?:what|which)\s+(?:should|do\s+you\s+think)|pick\s+(?:between|one)|choose|choice|option\s+(?:A|B|1|2)|either\s+[^.]+\s+or\b|proposal|propose|thoughts\s+on\b)/i,
    category: "decision",
    confidence: 0.85,
  },
  {
    name: "explicit-risk",
    pattern: /\b(?:risk|issue|problem|bug|error|failure|concern|warning|alert|critical|urgent|blocker|might\s+break|could\s+fail|potential\s+(?:problem|issue)|(?:something|this)\s+(?:is|went|seems)\s+wrong|broken|doesn['’]t\s+work|not\s+working)\b/i,
    category: "risk",
    confidence: 0.85,
  },
  {
    name: "explicit-followup",
    pattern: /\b(?:follow[\s-]*up|followup|remind\s+me|reminder|ping\s+me|circle\s+back|revisit|check\s+back\s+on|by\s+(?:tomorrow|next\s+week|Friday|Monday|Tuesday|Wednesday|Thursday|Saturday|Sunday)|in\s+\d+\s+(?:hours?|days?|weeks?)|schedule(?:\s+(?:a|the)\s+follow|d\s+follow)|calendar|deadline\s+(?:is|:)|due\s+by\b)/i,
    category: "followup",
    confidence: 0.8,
  },
  {
    name: "explicit-task",
    pattern: /\b(?:to[\s-]*do|todo|action(?:\s+item)?|must\s+do|need\s+to|should\s+(?:do|implement|fix|build|create|update|write|send|call|check|review|prepare|complete|finish|handle|add|remove|delete|install|configure|setup|set\s+up|deploy|release|publish|run|test|migrate|refactor)|please\s+(?:do|implement|fix|build|create|update|write|send|call|check|review|prepare|complete|finish|handle|add|remove|delete|install|configure|setup|set\s+up|deploy|release|publish|run|test|migrate|refactor))\b/i,
    category: "task",
    confidence: 0.8,
  },
  {
    name: "question-decision",
    pattern: /\b(?:should\s+(?:I|we|they|he|she)|(?:what|which|where|how)\s+(?:should|do\s+you\s+think|would\s+you)|do\s+you\s+think\s+(?:I|we)\s+should|is\s+it\s+(?:better|worth|ok|okay|fine|good)\s+to|(?:would|will)\s+you\s+(?:agree|approve))\b/i,
    category: "decision",
    confidence: 0.75,
  },
  {
    name: "deadline-language",
    pattern: /\b(?:due\s+(?:date|on|by|in)|deadline|ETA|timeline|urgency|ASAP|as\s+soon\s+as\s+possible|time[\s-]*sensitive|pressing|overdue)\b/i,
    category: "followup",
    confidence: 0.7,
  },
  {
    name: "verb-start-task",
    pattern: /^(?:create|implement|build|fix|update|write|send|call|check|review|prepare|complete|finish|handle|add|remove|delete|install|configure|setup|set\s+up|deploy|release|publish|run|test|migrate|refactor|investigate|research|analyze|design|draft|schedule|organize|coordinate|contact|reach\s+out|follow\s+up)\b/im,
    category: "task",
    confidence: 0.6,
  },
  {
    name: "issue-risk",
    pattern: /\b(?:not\s+(?:working|responding|showing|loading|connecting|displaying|saving)|failed|crash(?:ed|ing)?|timeout|outage|down|offline|(?:throwing|getting)\s+(?:an?\s+)?error|exception|rollback|revert|recovery)\b/i,
    category: "risk",
    confidence: 0.7,
  },
];

const NLP_MODEL = process.env.NLP_MODEL || "gpt-4o-mini";

export function nlpEnabled(): boolean {
  return process.env.ENABLE_NLP === "1";
}

function applyRules(text: string): CategorizerResult | null {
  for (const rule of RULES) {
    if (rule.pattern.test(text)) {
      return {
        category: rule.category,
        confidence: rule.confidence,
        source: "rule",
        reason: `Matched rule: ${rule.name}`,
      };
    }
  }
  return null;
}

async function applyNLP(text: string): Promise<CategorizerResult> {
  const provider = (process.env.NLP_PROVIDER || "openai").toLowerCase();
  const apiKey = process.env.NLP_API_KEY || process.env.STT_API_KEY || process.env.OCR_API_KEY || "";

  if (provider === "openai" && apiKey) {
    return classifyViaOpenAI(text, apiKey);
  }

  return {
    category: null,
    confidence: 0,
    source: "nlp",
    reason: "NLP provider not configured or no API key",
  };
}

async function classifyViaOpenAI(
  text: string,
  apiKey: string,
): Promise<CategorizerResult> {
  try {
    const response = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: NLP_MODEL,
          messages: [
            {
              role: "system",
              content:
                "Classify the user's message into exactly one category: task, decision, risk, followup, or ignore. " +
                "Respond with a JSON object: {\"category\": \"<category>\", \"confidence\": <0-1>, \"reason\": \"<brief explanation>\"}. " +
                "Use task for actionable to-do items, decision for choices that need to be made, risk for problems or issues, " +
                "followup for reminders or time-sensitive items, ignore for non-actionable chat.",
            },
            { role: "user", content: text },
          ],
          max_tokens: 200,
          temperature: 0,
        }),
      },
    );

    if (!response.ok) {
      console.error("Categorizer: OpenAI API error", response.status);
      return {
        category: null,
        confidence: 0,
        source: "nlp",
        reason: `OpenAI API error: ${response.status}`,
      };
    }

    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      return { category: null, confidence: 0, source: "nlp", reason: "Empty response" };
    }

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { category: null, confidence: 0, source: "nlp", reason: "Unparseable response" };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const validCategories: Category[] = ["task", "decision", "risk", "followup", "ignore"];
    return {
      category: validCategories.includes(parsed.category) ? parsed.category : null,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      source: "nlp",
      reason: parsed.reason || "NLP classification",
    };
  } catch (err) {
    console.error("Categorizer: NLP error", err);
    return {
      category: null,
      confidence: 0,
      source: "nlp",
      reason: "NLP classification failed",
    };
  }
}

export async function categorize(text: string): Promise<CategorizerResult | null> {
  if (!text || !text.trim()) return null;

  const ruleResult = applyRules(text);
  if (ruleResult) return ruleResult;

  if (nlpEnabled()) {
    return applyNLP(text);
  }

  return { category: null, confidence: 0, source: "rule", reason: "No rules matched" };
}

export const CATEGORY_LABELS: Record<Category, string> = {
  task: "✅ Task",
  decision: "🧭 Decision",
  risk: "⚠️ Risk",
  followup: "⏰ Follow-up",
  ignore: "🗑 Ignore",
};
