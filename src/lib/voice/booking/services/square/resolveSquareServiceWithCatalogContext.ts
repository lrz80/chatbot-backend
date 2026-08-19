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
      clarificationPrompt: string;
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

function looksLikeOpaqueProviderIdentifier(value: string): boolean {
  const text = String(value ?? "").trim();

  if (!text) return false;

  if (/^\d+$/.test(text)) {
    return true;
  }

  if (
    text.length >= 18 &&
    /^[A-Z0-9_-]+$/.test(text) &&
    !/\s/.test(text)
  ) {
    return true;
  }

  return false;
}

function collectSearchableText(value: unknown, depth = 0): string[] {
  if (depth > 4 || value == null) return [];

  if (typeof value === "string") {
    const text = value.trim();

    if (!text) return [];

    if (text.length > 180) return [];

    if (
      text.startsWith("http://") ||
      text.startsWith("https://")
    ) {
      return [];
    }

    if (looksLikeOpaqueProviderIdentifier(text)) {
      return [];
    }

    return [text];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) =>
      collectSearchableText(item, depth + 1)
    );
  }

  if (typeof value === "object") {
    const objectValue = value as Record<string, unknown>;

    return Object.entries(objectValue).flatMap(
      ([key, nestedValue]) => {
        const normalizedKey = key.toLowerCase();

        if (
          normalizedKey.includes("token") ||
          normalizedKey.includes("secret") ||
          normalizedKey.includes("password") ||
          normalizedKey.includes("authorization") ||
          normalizedKey.includes("access") ||
          normalizedKey.includes("version") ||
          normalizedKey === "id" ||
          normalizedKey.endsWith("_id") ||
          normalizedKey.endsWith("id")
        ) {
          return [];
        }

        return collectSearchableText(
          nestedValue,
          depth + 1
        );
      }
    );
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

function normalizeCandidateNames(
  value: unknown,
  catalogNames: string[]
): string[] {
  if (!Array.isArray(value)) return [];

  const catalogSet = new Set(catalogNames);

  return Array.from(
    new Set(
      value
        .map((item) => String(item ?? "").trim())
        .filter(Boolean)
        .filter((name) => catalogSet.has(name))
    )
  );
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
              "If the customer's request is compatible with more than one catalog entry, resolution MUST be 'ambiguous'. " +
              "candidateNames must contain EVERY catalog entry that remains compatible with everything the customer has said so far. " +
              "Do not return only examples, representative entries, or the best few matches. " +
              "Evaluate every provided catalog entry independently for compatibility with the customer's request. " +
              "Do not discard a catalog entry merely because another entry is a stronger semantic match. " +
              "Return resolution='resolved' only when exactly one catalog entry remains compatible with all information the customer has provided. " +
              "If multiple compatible entries differ by style, full service versus refill, maintenance interval, level, package, duration, variation, or any other meaningful attribute, keep all of them in candidateNames and ask for the missing distinction. " +
              "Return resolution='none' only when the requested service is genuinely unrelated to every catalog entry. " +
              "matchedName and candidateNames must use exact catalog entry names. " +
              "When resolution='ambiguous', also return clarificationPrompt. " +
              "clarificationPrompt must be one short natural spoken question in the customer's language. " +
              "It must help the customer provide the missing distinguishing information. " +
              "Do not read or enumerate the full catalog. " +
              "Do not use numbered menus. " +
              "Do not mention internal provider terminology, IDs, or technical metadata. " +
              "You may mention a few short human-friendly distinctions or examples derived only from the compatible catalog entries, when that helps the customer answer. " +
              "If compatible entries differ mainly by style, ask which style. " +
              "If they differ mainly by full service versus refill or maintenance, ask that distinction. " +
              "If the narrowed subset still contains multiple variants, ask another clarification question instead of resolving prematurely. " +
              "Never invent a distinction that is not supported by the provided catalog entries. " +
              "Treat the currently provided catalog entries as the complete pending candidate set from the previous clarification step. " +
              "The customer's latest answer MUST narrow that pending set; it must never broaden it. " +
              "Explicit information in the latest customer answer has priority over weaker semantic similarity. " +
              "If the customer says they want maintenance, refill, touch-up, follow-up, or another non-initial service concept, exclude entries that clearly represent a full, initial, new, or complete service unless the catalog metadata indicates otherwise. " +
              "If the customer says they want a full, initial, new, or complete service, exclude refill or maintenance entries. " +
              "If the customer specifies a style, interval, duration, package, level, or other distinguishing attribute, exclude entries that contradict that attribute. " +
              "Do not keep a candidate merely because it belongs to the same broad service family. " +
              "candidateNames must contain only entries still compatible with ALL explicit information in the customer's latest answer and the already narrowed pending set. " +
              "If exactly one compatible entry remains after narrowing, return resolution='resolved'. " +
              "If two or more compatible entries remain, return resolution='ambiguous' and ask only about the next unresolved distinction. " +
              "Return JSON only.",
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
                clarificationPrompt:
                  "one short natural question in the customer's language when ambiguous, otherwise empty string",
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
      clarificationPrompt?: string;
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

    const clarificationPrompt = String(
      parsed.clarificationPrompt ?? ""
    ).trim();

    console.log("[VOICE_BOOKING][SQUARE_CONTEXT_MATCH_MODEL_OUTPUT]", {
      tenantId: params.tenantId,
      input,
      resolution,
      matchedName: matchedName || null,
      candidateNames,
      confidence,
      reason: parsed.reason,
      clarificationPrompt,
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
        clarificationPrompt,
      };
    }

    if (resolution === "ambiguous" && candidateNames.length >= 2) {
      return {
        kind: "ambiguous",
        candidateNames,
        confidence,
        reason: parsed.reason || "AMBIGUOUS_CATALOG_CONTEXT_MATCH",
        clarificationPrompt,
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