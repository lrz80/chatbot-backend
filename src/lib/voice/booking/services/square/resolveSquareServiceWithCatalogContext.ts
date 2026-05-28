// src/lib/voice/booking/services/square/resolveSquareServiceWithCatalogContext.ts
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

function normalizeCandidateNames(value: unknown, catalogNames: string[]): string[] {
  if (!Array.isArray(value)) return [];

  const catalogSet = new Set(catalogNames);

  return Array.from(
    new Set(
      value
        .map((item) => String(item ?? "").trim())
        .filter(Boolean)
        .filter((name) => catalogSet.has(name))
    )
  ).slice(0, 8);
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
              "You classify a customer booking request against a provider catalog. " +
              "The customer may speak any language. The catalog service names may be in another language. " +
              "Use the catalog as the only source of truth. " +
              "Return JSON only. Never invent services. " +
              "Do not choose arbitrarily. " +
              "If the customer request clearly identifies exactly one catalog service, return resolution='resolved'. " +
              "If more than one catalog service is semantically compatible with the customer request, return resolution='ambiguous'. " +
              "If no catalog service is clearly compatible, return resolution='none'. " +
              "matchedName must be exactly one name from catalogServiceNames or null. " +
              "candidateNames must contain only exact names from catalogServiceNames.",
          },
          {
            role: "user",
            content: JSON.stringify({
              customerInput: input,
              locale: params.currentLocale,
              catalogServiceNames: serviceNames,
              outputShape: {
                resolution: "resolved | ambiguous | none",
                matchedName: "exact catalog service name or null",
                candidateNames: ["exact catalog service names when ambiguous"],
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

    const resolution = String(parsed.resolution ?? "")
      .trim()
      .toLowerCase();

    const matchedName = String(parsed.matchedName ?? "").trim();
    const confidence =
      typeof parsed.confidence === "number" ? parsed.confidence : 0;
    const candidateNames = normalizeCandidateNames(
      parsed.candidateNames,
      serviceNames
    );

    if (candidateNames.length >= 2) {
      console.log("[VOICE_BOOKING][SQUARE_CONTEXT_MATCH_AMBIGUOUS_FROM_CANDIDATES]", {
        tenantId: params.tenantId,
        input,
        resolution,
        matchedName: matchedName || null,
        candidateNames,
        confidence,
        reason: parsed.reason,
      });

      return {
        kind: "ambiguous",
        candidateNames,
        confidence,
        reason: parsed.reason || "MULTIPLE_COMPATIBLE_CATALOG_SERVICES",
      };
    }

    console.log("[VOICE_BOOKING][SQUARE_CONTEXT_MATCH_MODEL_OUTPUT]", {
      tenantId: params.tenantId,
      input,
      resolution,
      matchedName: matchedName || null,
      candidateNames,
      confidence,
      reason: parsed.reason,
    });

    if (
      resolution === "ambiguous" &&
      candidateNames.length >= 2 &&
      confidence >= 0.55
    ) {
      console.log("[VOICE_BOOKING][SQUARE_CONTEXT_MATCH_AMBIGUOUS]", {
        tenantId: params.tenantId,
        input,
        candidateNames,
        confidence,
        reason: parsed.reason,
      });

      return {
        kind: "ambiguous",
        candidateNames,
        confidence,
        reason: parsed.reason || "AMBIGUOUS_CATALOG_CONTEXT_MATCH",
      };
    }

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
          candidateNames,
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
    }

    console.log("[VOICE_BOOKING][SQUARE_CONTEXT_MATCH_NONE]", {
      tenantId: params.tenantId,
      input,
      resolution,
      matchedName: matchedName || null,
      candidateNames,
      confidence,
      reason: parsed.reason,
    });

    return {
      kind: "none",
      reason: parsed.reason || "NO_CLEAR_MATCH",
      confidence,
      matchedName: matchedName || null,
      candidateNames,
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