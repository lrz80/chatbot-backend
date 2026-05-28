//src/lib/voice/booking/services/square/resolveSquareServiceWithCatalogContext.ts
import type { VoiceLocale } from "../../../types";
import { getSquareServiceName } from "./squareServiceMatcher";

export type ResolveSquareServiceWithCatalogContextResult =
  | {
      kind: "resolved";
      matchedName: string;
      confidence: number;
      reason: string;
    }
  | {
      kind: "none";
      reason: string;
      confidence?: number;
      matchedName?: string | null;
    };

type ResolveSquareServiceWithCatalogContextParams = {
  tenantId: string;
  input: string;
  currentLocale: VoiceLocale;
  services: any[];
};

function safeJsonParse(value: string): any | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export async function resolveSquareServiceWithCatalogContext(
  params: ResolveSquareServiceWithCatalogContextParams
): Promise<ResolveSquareServiceWithCatalogContextResult> {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    console.warn("[VOICE_BOOKING][SQUARE_CONTEXT_MATCH_SKIPPED]", {
      tenantId: params.tenantId,
      reason: "OPENAI_API_KEY_MISSING",
    });

    return {
      kind: "none",
      reason: "OPENAI_API_KEY_MISSING",
    };
  }

  const input = String(params.input ?? "").trim();

  if (!input) {
    return {
      kind: "none",
      reason: "EMPTY_INPUT",
    };
  }

  const serviceNames = Array.from(
    new Set(
      params.services
        .map((service) => getSquareServiceName(service))
        .map((name) => String(name ?? "").trim())
        .filter(Boolean)
    )
  ).slice(0, 80);

  if (serviceNames.length === 0) {
    return {
      kind: "none",
      reason: "NO_SERVICE_NAMES",
    };
  }

  console.log("[VOICE_BOOKING][SQUARE_CONTEXT_MATCH_CATALOG]", {
    tenantId: params.tenantId,
    input,
    serviceCount: serviceNames.length,
    sampleServices: serviceNames.slice(0, 20),
  });

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
              "You match a customer booking request to exactly one service from a provider catalog. " +
              "The customer may speak any language. The catalog service names may be in another language. " +
              "Use meaning and business context, not literal word-by-word translation. " +
              "Return JSON only. " +
              "Never invent a service. " +
              "matchedName must be exactly one of the provided catalogServiceNames or null. " +
              "If there is not enough evidence for one clear service, return matchedName as null.",
          },
          {
            role: "user",
            content: JSON.stringify({
              customerInput: input,
              locale: params.currentLocale,
              catalogServiceNames: serviceNames,
              outputShape: {
                matchedName: "exact catalog service name or null",
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

      console.warn("[VOICE_BOOKING][SQUARE_CONTEXT_MATCH_HTTP_ERROR]", {
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
      matchedName?: string | null;
      confidence?: number;
      reason?: string;
    } | null;

    if (!parsed) {
      return {
        kind: "none",
        reason: "INVALID_JSON_RESPONSE",
      };
    }

    const matchedName = String(parsed.matchedName ?? "").trim();
    const confidence =
      typeof parsed.confidence === "number" ? parsed.confidence : 0;

    console.log("[VOICE_BOOKING][SQUARE_CONTEXT_MATCH_MODEL_OUTPUT]", {
      tenantId: params.tenantId,
      input,
      matchedName: matchedName || null,
      confidence,
      reason: parsed.reason,
    });

    if (!matchedName || confidence < 0.72) {
      console.log("[VOICE_BOOKING][SQUARE_CONTEXT_MATCH_NONE]", {
        tenantId: params.tenantId,
        input,
        matchedName: matchedName || null,
        confidence,
        reason: parsed.reason,
      });

      return {
        kind: "none",
        reason: parsed.reason || "LOW_CONFIDENCE",
        confidence,
        matchedName: matchedName || null,
      };
    }

    const existsInCatalog = serviceNames.includes(matchedName);

    if (!existsInCatalog) {
      console.warn("[VOICE_BOOKING][SQUARE_CONTEXT_MATCH_REJECTED_NOT_IN_CATALOG]", {
        tenantId: params.tenantId,
        input,
        matchedName,
        confidence,
      });

      return {
        kind: "none",
        reason: "MATCH_NOT_IN_CATALOG",
        confidence,
        matchedName,
      };
    }

    console.log("[VOICE_BOOKING][SQUARE_CONTEXT_MATCH_RESOLVED]", {
      tenantId: params.tenantId,
      input,
      matchedName,
      confidence,
      reason: parsed.reason,
    });

    return {
      kind: "resolved",
      matchedName,
      confidence,
      reason: parsed.reason || "CATALOG_CONTEXT_MATCH",
    };
  } catch (error) {
    console.warn("[VOICE_BOOKING][SQUARE_CONTEXT_MATCH_FAILED]", {
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