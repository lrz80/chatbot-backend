// src/lib/catalog/normalizeCatalogRole.ts
export function normalizeCatalogRole(
  role: string | null | undefined
): "primary" | "secondary" {
  const v = String(role || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();

  if (
    v === "primary" ||
    v === "servicio principal" ||
    v === "principal" ||
    v === "main"
  ) {
    return "primary";
  }

  if (
    v === "secondary" ||
    v === "complemento" ||
    v === "complemento / extra" ||
    v === "extra" ||
    v === "addon"
  ) {
    return "secondary";
  }

  return "primary";
}