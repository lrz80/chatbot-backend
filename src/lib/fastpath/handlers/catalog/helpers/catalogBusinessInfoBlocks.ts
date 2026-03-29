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

function isHeaderMatch(line: string, labels: string[]): boolean {
  const normalizedLine = normalizeText(line).replace(/:$/, "");

  return labels.some((label) => {
    const normalizedLabel = normalizeText(label).replace(/:$/, "");
    return normalizedLine === normalizedLabel;
  });
}

function stripInlineHeaderValue(line: string, labels: string[]): string {
  const raw = String(line || "").trim();
  const normalizedRaw = normalizeText(raw);

  for (const label of labels) {
    const normalizedLabel = normalizeText(label).replace(/:$/, "");
    if (!normalizedLabel) continue;

    if (normalizedRaw === normalizedLabel) {
      return "";
    }

    if (normalizedRaw.startsWith(`${normalizedLabel}:`)) {
      const idx = raw.indexOf(":");
      if (idx >= 0) {
        return raw.slice(idx + 1).trim();
      }
    }
  }

  return "";
}

function isAnyKnownSectionHeader(line: string): boolean {
  const normalized = normalizeText(line).replace(/:$/, "");

  return [
    "nombre del negocio",
    "tipo de negocio",
    "ubicacion",
    "direccion",
    "location",
    "address",
    "telefono",
    "phone",
    "servicios principales",
    "services",
    "main services",
    "contacto",
    "contact",
    "idioma de las clases",
    "class language",
    "politicas",
    "policies",
    "precios",
    "pricing",
    "price",
    "reserva",
    "booking",
    "horarios",
    "schedules",
    "schedule",
    "disponibilidad",
    "availability",
    "available",
  ].includes(normalized);
}

function extractSectionValue(
  infoClave: string | null | undefined,
  labels: string[]
): string {
  const lines = cleanLines(String(infoClave || ""));
  if (!lines.length) return "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const inlineValue = stripInlineHeaderValue(line, labels);
    if (inlineValue) {
      return inlineValue;
    }

    if (isHeaderMatch(line, labels)) {
      const collected: string[] = [];

      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j];

        if (isAnyKnownSectionHeader(nextLine)) {
          break;
        }

        collected.push(nextLine);
      }

      return collected.join("\n").trim();
    }
  }

  return "";
}

export function buildLocationBlockFromInfoClave(
  infoClave?: string | null
): string {
  return extractSectionValue(infoClave, [
    "Ubicación",
    "Direccion",
    "Dirección",
    "Location",
    "Address",
  ]);
}

export function buildAvailabilityBlockFromInfoClave(
  infoClave?: string | null
): string {
  return extractSectionValue(infoClave, [
    "Disponibilidad",
    "Availability",
    "Available",
  ]);
}

export function buildServicesBlockFromInfoClave(
  infoClave?: string | null
): string {
  return extractSectionValue(infoClave, [
    "Servicios principales",
    "Services",
    "Main services",
  ]);
}