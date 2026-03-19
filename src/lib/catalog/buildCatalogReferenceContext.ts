import type { CatalogReferenceContext } from "./types";

type AnyRecord = Record<string, unknown>;

function asRecord(value: unknown): AnyRecord {
  return value && typeof value === "object" ? (value as AnyRecord) : {};
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return v ? v : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item): item is string => Boolean(item));
}

function asObjectArray(value: unknown): AnyRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is AnyRecord => Boolean(item) && typeof item === "object"
  );
}

function pickFirstString(source: AnyRecord, keys: string[]): string | null {
  for (const key of keys) {
    const value = asString(source[key]);
    if (value) return value;
  }
  return null;
}

function pickFirstStringArray(source: AnyRecord, keys: string[]): string[] {
  for (const key of keys) {
    const value = asStringArray(source[key]);
    if (value.length > 0) return value;
  }
  return [];
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function extractPresentedEntityIds(source: AnyRecord): string[] {
  const direct = pickFirstStringArray(source, [
    "lastPresentedEntityIds",
    "last_presented_entity_ids",
    "presentedEntityIds",
    "presented_entity_ids",
    "lastCatalogCandidateIds",
    "last_catalog_candidate_ids",
  ]);

  if (direct.length > 0) return direct;

  const planObjects = asObjectArray(source["last_catalog_plans"]);
  const objectIds = planObjects
    .map((item) => asString(item.id ?? item.serviceId ?? item.service_id))
    .filter((value): value is string => Boolean(value));

  if (objectIds.length > 0) return Array.from(new Set(objectIds));

  return [];
}

function extractPresentedFamilyKeys(source: AnyRecord): string[] {
  return pickFirstStringArray(source, [
    "lastPresentedFamilyKeys",
    "last_presented_family_keys",
    "presentedFamilyKeys",
    "presented_family_keys",
    "lastCatalogFamilyKeys",
    "last_catalog_family_keys",
  ]);
}

function extractPresentedVariantOptions(source: AnyRecord) {
  const raw = source["presentedVariantOptions"] 
    ?? source["presented_variant_options"]
    ?? null;

  if (!Array.isArray(raw)) return null;

  const cleaned = raw
    .map((item) => {
      if (!item || typeof item !== "object") return null;

      const rec = item as AnyRecord;

      const index = asNumber(rec.index);
      const variantId = asString(rec.variantId ?? rec.variant_id);
      const label = asString(rec.label);
      const aliases = asStringArray(rec.aliases);

      if (!index || !variantId || !label) return null;

      return {
        index,
        variantId,
        label,
        aliases
      };
    })
    .filter((x): x is { index: number; variantId: string; label: string; aliases: string[] } => Boolean(x));

  return cleaned.length > 0 ? cleaned : null;
}

export function buildCatalogReferenceContext(
  convoCtx: unknown
): CatalogReferenceContext {
  const ctx = asRecord(convoCtx);

  const now = Date.now();
  const entityTtlMs = 10 * 60 * 1000;

  const lastEntityAt = asNumber(
    ctx["last_entity_at"] ??
      ctx["lastEntityAt"] ??
      ctx["last_service_at"] ??
      ctx["lastServiceAt"]
  );

  const entityContextFresh =
    Number.isFinite(lastEntityAt as number) &&
    (lastEntityAt as number) > 0 &&
    now - (lastEntityAt as number) <= entityTtlMs;

  const lastEntityId = pickFirstString(ctx, [
    "lastEntityId",
    "last_entity_id",
    "selectedServiceId",
    "selected_service_id",
    "lastServiceId",
    "last_service_id",
  ]);

  const rawLastEntityName = pickFirstString(ctx, [
    "lastEntityName",
    "last_entity_name",
    "selectedServiceName",
    "selected_service_name",
    "lastServiceName",
    "last_service_name",
  ]);

  const lastFamilyKey = pickFirstString(ctx, [
    "lastFamilyKey",
    "last_family_key",
    "familyKey",
    "family_key",
    "lastCategory",
    "last_category",
  ]);

  const lastPresentedEntityIds = extractPresentedEntityIds(ctx);
  const lastPresentedFamilyKeys = extractPresentedFamilyKeys(ctx);

  const expectingVariantForEntityId = pickFirstString(ctx, [
    "expectingVariantForEntityId",
    "expecting_variant_for_entity_id",
    "expectedVariantOfEntityId",
    "expected_variant_of_entity_id",
  ]);

  const presentedVariantOptions = extractPresentedVariantOptions(ctx);

  return {
    lastEntityId: entityContextFresh ? lastEntityId : null,
    lastEntityName: entityContextFresh && lastEntityId ? rawLastEntityName : null,
    lastFamilyKey,
    lastPresentedEntityIds,
    lastPresentedFamilyKeys,
    expectingVariantForEntityId,
    presentedVariantOptions, // 🔥 ESTE ES EL FIX
  };
}