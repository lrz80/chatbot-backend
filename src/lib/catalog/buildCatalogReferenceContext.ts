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
  return value
    .filter((item): item is AnyRecord => Boolean(item) && typeof item === "object");
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
  const ids = planObjects
    .map((item) => asString(item.id ?? item.serviceId ?? item.service_id))
    .filter((value): value is string => Boolean(value));

  return ids;
}

function extractPresentedFamilyKeys(source: AnyRecord): string[] {
  const direct = pickFirstStringArray(source, [
    "lastPresentedFamilyKeys",
    "last_presented_family_keys",
    "presentedFamilyKeys",
    "presented_family_keys",
    "lastCatalogFamilyKeys",
    "last_catalog_family_keys",
  ]);

  if (direct.length > 0) return direct;

  const planObjects = asObjectArray(source["last_catalog_plans"]);
  const familyKeys = planObjects
    .map((item) =>
      asString(
        item.familyKey ??
          item.family_key ??
          item.category ??
          item.tipo ??
          item.catalogRole ??
          item.catalog_role
      )
    )
    .filter((value): value is string => Boolean(value));

  return Array.from(new Set(familyKeys));
}

export function buildCatalogReferenceContext(
  convoCtx: unknown
): CatalogReferenceContext {
  const ctx = asRecord(convoCtx);

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

  return {
    lastEntityId,
    lastEntityName: lastEntityId ? rawLastEntityName : null,
    lastFamilyKey,
    lastPresentedEntityIds,
    lastPresentedFamilyKeys,
    expectingVariantForEntityId,
  };
}