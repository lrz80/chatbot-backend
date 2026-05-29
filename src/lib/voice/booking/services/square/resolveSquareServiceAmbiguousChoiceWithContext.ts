// src/lib/voice/booking/services/square/resolveSquareServiceAmbiguousChoiceWithContext.ts
import type { VoiceLocale } from "../../../types";
import { getSquareServiceName } from "./squareServiceMatcher";

export type ResolveSquareServiceAmbiguousChoiceWithContextResult =
  | {
      kind: "resolved";
      matchedName: string;
      confidence: number;
      reason: string;
    }
  | {
      kind: "ambiguous";
      candidateNames: string[];
      confidence: number;
      reason: string;
    }
  | {
      kind: "none";
      reason: string;
      confidence?: number;
      matchedName?: string | null;
      candidateNames?: string[];
    };

type ResolveSquareServiceAmbiguousChoiceWithContextParams = {
  tenantId: string;
  input: string;
  currentLocale: VoiceLocale;
  options: any[];
};

type ChoiceEntry = {
  name: string;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function safeJsonParse(value: string): any | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function buildChoiceEntries(options: any[]): ChoiceEntry[] {
  const seen = new Set<string>();

  return options
    .map((option) => clean(getSquareServiceName(option)))
    .filter(Boolean)
    .filter((name) => {
      if (seen.has(name)) return false;
      seen.add(name);
      return true;
    })
    .map((name) => ({ name }));
}

function normalizeCandidateNames(value: unknown, allowedNames: string[]): string[] {
  if (!Array.isArray(value)) return [];

  const allowedSet = new Set(allowedNames);

  return Array.from(
    new Set(
      value
        .map((item) => clean(item))
        .filter(Boolean)
        .filter((name) => allowedSet.has(name))
    )
  ).slice(0, 8);
}

export async function resolveSquareServiceAmbiguousChoiceWithContext(
  params: ResolveSquareServiceAmbiguousChoiceWithContextParams
): Promise<ResolveSquareServiceAmbiguousChoiceWithContextResult> {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    console.warn("[VOICE_BOOKING][SQUARE_AMBIGUOUS_CHOICE_SKIPPED]", {
      tenantId: params.tenantId,
      reason: "OPENAI_API_KEY_MISSING",
    });

    return {
      kind: "none",
      reason: "OPENAI_API_KEY_MISSING",
    };
  }

  const input = clean(params.input);

  if (!input) {
    return {
      kind: "none",
      reason: "EMPTY_INPUT",
    };
  }

  const choiceEntries = buildChoiceEntries(params.options);
  const choiceNames = choiceEntries.map((entry) => entry.name);

  if (choiceEntries.length === 0) {
    return {
      kind: "none",
      reason: "NO_AMBIGUOUS_OPTIONS",
    };
  }

  if (choiceEntries.length === 1) {
    return {
      kind: "resolved",
      matchedName: choiceEntries[0].name,
      confidence: 1,
      reason: "ONLY_ONE_AMBIGUOUS_OPTION",
    };
  }

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_SERVICE_MATCH_MODEL || "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You resolve a customer's follow-up answer against a short list of previously offered booking service choices. " +
              "The customer may speak any language or mix languages. " +
              "Use only the provided choices as the source of truth. " +
              "Do not use outside catalog knowledge. " +
              "Do not invent services. " +
              "Do not choose arbitrarily. " +
              "If exactly one provided choice is clearly compatible with the customer's follow-up answer, return resolution='resolved'. " +
              "If more than one provided choice is compatible, return resolution='ambiguous'. " +
              "If no provided choice is compatible, return resolution='none'. " +
              "matchedName must be exactly one provided choice name or null. " +
              "candidateNames must contain only exact provided choice names. " +
              "Return JSON only.",
          },
          {
            role: "user",
            content: JSON.stringify({
              customerInput: input,
              locale: params.currentLocale,
              offeredChoices: choiceEntries,
              outputShape: {
                resolution: "resolved | ambiguous | none",
                matchedName: "exact offered choice name or null",
                candidateNames: ["exact offered choice names when ambiguous"],
                confidence: "number from 0 to 1",
                reason: "short explanation",
              },
            }),
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();

      console.warn("[VOICE_BOOKING][SQUARE_AMBIGUOUS_CHOICE_HTTP_ERROR]", {
        tenantId: params.tenantId,
        status: response.status,
        errorText,
      });

      return {
        kind: "none",
        reason: "HTTP_ERROR",
      };
    }

    const data = (await response.json()) as any;
    const content = data?.choices?.[0]?.message?.content;

    if (!content) {
      return {
        kind: "none",
        reason: "EMPTY_MODEL_RESPONSE",
      };
    }

    const parsed = safeJsonParse(content) as {
      resolution?: string;
      matchedName?: string | null;
      candidateNames?: string[];
      confidence?: number;
      reason?: string;
    } | null;

    if (!parsed) {
      return {
        kind: "none",
        reason: "INVALID_JSON_RESPONSE",
      };
    }

    const resolution = clean(parsed.resolution).toLowerCase();
    const matchedName = clean(parsed.matchedName);
    const confidence =
      typeof parsed.confidence === "number" ? parsed.confidence : 0;

    const candidateNames = normalizeCandidateNames(
      parsed.candidateNames,
      choiceNames
    );

    console.log("[VOICE_BOOKING][SQUARE_AMBIGUOUS_CHOICE_MODEL_OUTPUT]", {
      tenantId: params.tenantId,
      input,
      resolution,
      matchedName: matchedName || null,
      candidateNames,
      confidence,
      reason: parsed.reason,
    });

    if (resolution === "resolved") {
      if (!matchedName || confidence < 0.72) {
        return {
          kind: "none",
          reason: parsed.reason || "LOW_CONFIDENCE",
          confidence,
          matchedName: matchedName || null,
          candidateNames,
        };
      }

      if (!choiceNames.includes(matchedName)) {
        return {
          kind: "none",
          reason: "MATCH_NOT_IN_OFFERED_CHOICES",
          confidence,
          matchedName,
          candidateNames,
        };
      }

      return {
        kind: "resolved",
        matchedName,
        confidence,
        reason: parsed.reason || "AMBIGUOUS_CHOICE_CONTEXT_MATCH",
      };
    }

    if (resolution === "ambiguous" && candidateNames.length >= 2) {
      return {
        kind: "ambiguous",
        candidateNames,
        confidence,
        reason: parsed.reason || "MULTIPLE_OFFERED_CHOICES_MATCH",
      };
    }

    return {
      kind: "none",
      reason: parsed.reason || "NO_CLEAR_OFFERED_CHOICE_MATCH",
      confidence,
      matchedName: matchedName || null,
      candidateNames,
    };
  } catch (error) {
    console.warn("[VOICE_BOOKING][SQUARE_AMBIGUOUS_CHOICE_FAILED]", {
      tenantId: params.tenantId,
      input,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      kind: "none",
      reason: "MODEL_ERROR",
    };
  }
}