// src/lib/catalog/isExplicitCatalogBrowseIntent.ts

export function isExplicitCatalogBrowseIntent(
  detectedIntent: string | null | undefined
): boolean {
  const value = String(detectedIntent || "").trim();

  return (
    value === "precio" ||
    value === "planes_precios" ||
    value === "catalogo" ||
    value === "catalog" ||
    value === "other_plans" ||
    value === "catalog_alternatives"
  );
}