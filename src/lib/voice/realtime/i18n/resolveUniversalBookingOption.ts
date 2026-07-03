//src/lib/voice/realtime/i18n/resolveUniversalBookingOption.ts

import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

type UniversalBookingOption = {
  value: string;
  aliases: string[];
};

export type UniversalBookingOptionResolution =
  | {
      matched: true;
      value: string;
      confidence: number;
      reason: string;
    }
  | {
      matched: false;
      confidence: number;
      reason: string;
    };

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function parseVoiceBookingConfig(rawConfig: string): UniversalBookingOption[] {
  return String(rawConfig || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [canonicalRaw, aliasesRaw = ""] = line.split("|");

      const value = clean(canonicalRaw);
      if (!value) return null;

      const aliases = aliasesRaw
        .split(",")
        .map((item) => clean(item))
        .filter(Boolean);

      return {
        value,
        aliases,
      };
    })
    .filter((item): item is UniversalBookingOption => Boolean(item));
}

function safeJsonParse(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;

    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

export async function resolveUniversalBookingOption(params: {
  userInput: string;
  rawConfig: string;
}): Promise<UniversalBookingOptionResolution> {
  const userInput = clean(params.userInput);
  const options = parseVoiceBookingConfig(params.rawConfig);

  if (!userInput || !options.length) {
    return {
      matched: false,
      confidence: 0,
      reason: "Missing user input or options.",
    };
  }

  const compactOptions = options.map((option) => ({
    value: option.value,
    aliases: option.aliases,
  }));

  const prompt = `
You are matching a customer's spoken booking request to one configured booking option.

The customer may speak any language.
The configured options may be in any language.
Match semantically, not literally.

Rules:
- Return ONLY valid JSON.
- The returned value MUST be exactly one of the configured option "value" strings.
- Do not invent a value.
- If the customer request is too vague or matches multiple options, return matched=false.
- Use high confidence only when the match is clear.

Customer input:
${userInput}

Configured options:
${JSON.stringify(compactOptions, null, 2)}

Return JSON in this shape:
{
  "matched": true,
  "value": "exact configured value",
  "confidence": 0.0,
  "reason": "short reason"
}

or:
{
  "matched": false,
  "confidence": 0.0,
  "reason": "short reason"
}
`.trim();

  const response = await client.responses.create({
    model: "gpt-4.1-mini",
    input: prompt,
  });

  const parsed = safeJsonParse(response.output_text || "");

  if (!parsed || typeof parsed !== "object") {
    return {
      matched: false,
      confidence: 0,
      reason: "Model returned invalid JSON.",
    };
  }

  const matched = parsed.matched === true;
  const value = clean(parsed.value);
  const confidence = Number(parsed.confidence);
  const safeConfidence = Number.isFinite(confidence) ? confidence : 0;

  if (!matched || safeConfidence < 0.75) {
    return {
      matched: false,
      confidence: safeConfidence,
      reason: clean(parsed.reason) || "No confident match.",
    };
  }

  const allowedValues = new Set(options.map((option) => option.value));

  if (!allowedValues.has(value)) {
    return {
      matched: false,
      confidence: safeConfidence,
      reason: "Matched value is not a configured option.",
    };
  }

  return {
    matched: true,
    value,
    confidence: safeConfidence,
    reason: clean(parsed.reason) || "Semantic match.",
  };
}