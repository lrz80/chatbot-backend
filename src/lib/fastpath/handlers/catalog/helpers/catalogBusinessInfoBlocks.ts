// src/lib/fastpath/handlers/catalog/helpers/catalogBusinessInfoBlocks.ts

function cleanLines(text: string): string[] {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizeText(value: string): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function lineLooksLikeLocation(line: string): boolean {
  const t = normalizeText(line);

  return (
    t.includes("direccion") ||
    t.includes("ubicacion") ||
    t.includes("address") ||
    t.includes("location") ||
    t.includes("located at") ||
    t.includes("estamos en") ||
    t.includes("nos ubicamos en") ||
    t.includes("we are located") ||
    t.includes("visit us at")
  );
}

function lineLooksLikeAvailability(line: string): boolean {
  const t = normalizeText(line);

  return (
    t.includes("disponibilidad") ||
    t.includes("available") ||
    t.includes("availability") ||
    t.includes("cupos") ||
    t.includes("slots") ||
    t.includes("appointments available") ||
    t.includes("spaces available")
  );
}

export function buildLocationBlockFromInfoClave(
  infoClave?: string | null
): string {
  const lines = cleanLines(String(infoClave || ""));
  const match = lines.find(lineLooksLikeLocation);
  return match || "";
}

export function buildAvailabilityBlockFromInfoClave(
  infoClave?: string | null
): string {
  const lines = cleanLines(String(infoClave || ""));
  const match = lines.find(lineLooksLikeAvailability);
  return match || "";
}