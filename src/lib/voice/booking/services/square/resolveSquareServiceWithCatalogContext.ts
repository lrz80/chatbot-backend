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

type CatalogEntry = {
  name: string;
  searchText: string;
};

function safeJsonParse(value: string): any | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function collectSearchableText(value: unknown, depth = 0): string[] {
  if (depth > 4 || value == null) return [];

  if (typeof value === "string") {
    const text = value.trim();

    if (!text) return [];

    if (text.length > 180) return [];

    if (text.startsWith("http://") || text.startsWith("https://")) return [];

    return [text];
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectSearchableText(item, depth + 1));
  }

  if (typeof value === "object") {
    const objectValue = value as Record<string, unknown>;

    return Object.entries(objectValue).flatMap(([key, nestedValue]) => {
      const normalizedKey = key.toLowerCase();

      if (
        normalizedKey.includes("token") ||
        normalizedKey.includes("secret") ||
        normalizedKey.includes("password") ||
        normalizedKey.includes("authorization") ||
        normalizedKey.includes("access")
      ) {
        return [];
      }

      return collectSearchableText(nestedValue, depth + 1);
    });
  }

  return [];
}

function buildCatalogEntries(services: any[]): CatalogEntry[] {
  const entries = services
    .map((service) => {
      const name = String(getSquareServiceName(service) ?? "").trim();

      if (!name) return null;

      const searchableParts = collectSearchableText(service);

      const searchText = Array.from(
        new Set([name, ...searchableParts].map((item) => item.trim()).filter(Boolean))
      )
        .slice(0, 40)
        .join(" | ");

      return {
        name,
        searchText,
      };
    })
    .filter((entry): entry is CatalogEntry => Boolean(entry));

  const seen = new Set<string>();

  return entries.filter((entry) => {
    if (seen.has(entry.name)) return false;
    seen.add(entry.name);
    return true;
  });
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

  const catalogEntries = buildCatalogEntries(params.services).slice(0, 80);
  const serviceNames = catalogEntries.map((entry) => entry.name);

  if (catalogEntries.length === 0) {
    return {
      kind: "none",
      reason: "NO_SERVICE_NAMES",
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
              "You classify a customer booking request against a provider service catalog. " +
              "The customer may speak any language. First infer the customer's meaning in English internally, then compare it to the catalog. " +
              "Use only the provided catalog entries as the source of truth. " +
              "Each catalog entry has an exact name and searchable provider metadata. " +
              "Return JSON only. Never invent services. " +
              "Do not choose arbitrarily. " +
              "If exactly one catalog entry is clearly compatible with the customer request, return resolution='resolved'. " +
              "If more than one catalog entry is compatible with the customer request, return resolution='ambiguous'. " +
              "If no catalog entry is compatible, return resolution='none'. " +
              "matchedName must be exactly one catalog entry name or null. " +
              "candidateNames must contain only exact catalog entry names.",
          },
          {
            role: "user",
            content: JSON.stringify({
              customerInput: input,
              locale: params.currentLocale,
              catalogEntries,
              outputShape: {
                resolution: "resolved | ambiguous | none",
                matchedName: "exact catalog entry name or null",
                candidateNames: ["exact catalog entry names when ambiguous"],
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

    console.log("[VOICE_BOOKING][SQUARE_CONTEXT_MATCH_MODEL_OUTPUT]", {
      tenantId: params.tenantId,
      input,
      resolution,
      matchedName: matchedName || null,
      candidateNames,
      confidence,
      reason: parsed.reason,
    });

    if (candidateNames.length >= 2 && confidence >= 0.45) {
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
        reason: parsed.reason || "MULTIPLE_COMPATIBLE_CATALOG_SERVICES",
      };
    }

    if (resolution === "ambiguous" && candidateNames.length >= 2) {
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

      if (!serviceNames.includes(matchedName)) {
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