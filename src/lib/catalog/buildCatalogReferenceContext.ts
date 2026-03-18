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

export function buildCatalogReferenceContext(
  convoCtx: unknown
): CatalogReferenceContext {
  const ctx = asRecord(convoCtx);

  return {
    lastEntityId: pickFirstString(ctx, [
      "lastEntityId",
      "last_entity_id",
      "selectedServiceId",
      "selected_service_id",
      "lastServiceId",
      "last_service_id",
    ]),

    lastEntityName: pickFirstString(ctx, [
      "lastEntityName",
      "last_entity_name",
      "selectedServiceName",
      "selected_service_name",
      "lastServiceName",
      "last_service_name",
    ]),

    lastFamilyKey: pickFirstString(ctx, [
      "lastFamilyKey",
      "last_family_key",
      "familyKey",
      "family_key",
      "lastCategory",
      "last_category",
    ]),

    lastPresentedEntityIds: pickFirstStringArray(ctx, [
      "lastPresentedEntityIds",
      "last_presented_entity_ids",
      "presentedEntityIds",
      "presented_entity_ids",
      "lastCatalogCandidateIds",
      "last_catalog_candidate_ids",
    ]),

    lastPresentedFamilyKeys: pickFirstStringArray(ctx, [
      "lastPresentedFamilyKeys",
      "last_presented_family_keys",
      "presentedFamilyKeys",
      "presented_family_keys",
      "lastCatalogFamilyKeys",
      "last_catalog_family_keys",
    ]),

    expectingVariantForEntityId: pickFirstString(ctx, [
      "expectingVariantForEntityId",
      "expecting_variant_for_entity_id",
      "expectedVariantOfEntityId",
      "expected_variant_of_entity_id",
    ]),
  };
}