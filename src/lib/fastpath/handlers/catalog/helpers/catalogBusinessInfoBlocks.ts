//src/lib/fastpath/handlers/catalog/helpers/catalogBusinessInfoBlocks.ts
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

type ParsedSection = {
  rawHeader: string;
  normalizedHeader: string;
  value: string;
};

const SECTION_ALIASES = {
  location: ["Ubicación", "Direccion", "Dirección", "Location", "Address"],
  availability: ["Disponibilidad", "Availability", "Available"],
  services: ["Servicios principales", "Services", "Main services"],
  schedule: ["Horarios", "Schedules", "Schedule"],
  pricing: ["Precios", "Pricing", "Price", "Cómo consultar precio"],
  booking: ["Reserva", "Booking", "CTA principal"],
  phone: ["Telefono", "Teléfono", "Phone"],
  contact: ["Contacto", "Contact"],
  rules: ["Reglas importantes", "Important rules"],

  businessName: ["Nombre del negocio", "Business name", "Nombre"],
  description: ["Qué es", "What is", "Descripción", "Descripcion", "About"],
} as const;

function normalizeLabel(label: string): string {
  return normalizeText(label).replace(/:$/, "");
}

function isHeaderMatch(line: string, labels: readonly string[]): boolean {
  const normalizedLine = normalizeLabel(line);
  return labels.some((label) => normalizeLabel(label) === normalizedLine);
}

function stripInlineHeaderValue(
  line: string,
  labels: readonly string[]
): string {
  const raw = String(line || "").trim();
  const normalizedRaw = normalizeText(raw);

  for (const label of labels) {
    const normalizedLabel = normalizeLabel(label);
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

function isPotentialSectionHeader(line: string): boolean {
  const raw = String(line || "").trim();
  if (!raw) return false;
  if (!raw.endsWith(":")) return false;

  const withoutColon = raw.slice(0, -1).trim();
  if (!withoutColon) return false;

  return true;
}

function parseSections(infoClave: string | null | undefined): ParsedSection[] {
  const lines = cleanLines(String(infoClave || ""));
  if (!lines.length) return [];

  const sections: ParsedSection[] = [];
  let i = 0;

  while (i < lines.length) {
    const raw = String(lines[i] || "").trim();

    if (!isPotentialSectionHeader(raw)) {
      i += 1;
      continue;
    }

    const rawHeader = raw.replace(/:$/, "").trim();
    const normalizedHeader = normalizeLabel(rawHeader);

    const collected: string[] = [];
    let j = i + 1;

    while (j < lines.length) {
      const nextLine = lines[j];
      if (isPotentialSectionHeader(nextLine)) {
        break;
      }
      collected.push(nextLine);
      j += 1;
    }

    sections.push({
      rawHeader,
      normalizedHeader,
      value: collected.join("\n").trim(),
    });

    i = j;
  }

  return sections;
}

function extractSectionValue(
  infoClave: string | null | undefined,
  labels: readonly string[]
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

        if (isPotentialSectionHeader(nextLine)) {
          break;
        }

        collected.push(nextLine);
      }

      return collected.join("\n").trim();
    }
  }

  return "";
}

function isBusinessNameSection(normalizedHeader: string): boolean {
  const aliases = SECTION_ALIASES.businessName.map(normalizeLabel);
  return aliases.includes(normalizedHeader);
}

function isDescriptionSection(normalizedHeader: string): boolean {
  const aliases = SECTION_ALIASES.description.map(normalizeLabel);
  if (aliases.includes(normalizedHeader)) return true;

  return (
    normalizedHeader.startsWith("que es ") ||
    normalizedHeader.startsWith("what is ")
  );
}

function collapseWhitespace(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function tokenizeComparableText(value: string): string[] {
  return normalizeText(value)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function startsWithBusinessReference(
  businessName: string,
  description: string
): boolean {
  const businessTokens = tokenizeComparableText(businessName);
  const descriptionTokens = tokenizeComparableText(description);

  if (!businessTokens.length || !descriptionTokens.length) {
    return false;
  }

  const firstBusinessToken = businessTokens[0];
  const firstDescriptionToken = descriptionTokens[0];

  if (!firstBusinessToken || !firstDescriptionToken) {
    return false;
  }

  return firstBusinessToken === firstDescriptionToken;
}

function composeBusinessIdentityLine(
  businessName: string,
  description: string
): string {
  const cleanBusinessName = collapseWhitespace(businessName);
  const cleanDescription = collapseWhitespace(description);

  if (!cleanBusinessName) return cleanDescription;
  if (!cleanDescription) return cleanBusinessName;

  const normalizedBusinessName = normalizeText(cleanBusinessName);
  const normalizedDescription = normalizeText(cleanDescription);

  if (
    normalizedDescription === normalizedBusinessName ||
    normalizedDescription.startsWith(`${normalizedBusinessName} es `) ||
    normalizedDescription.startsWith(`${normalizedBusinessName} is `) ||
    startsWithBusinessReference(cleanBusinessName, cleanDescription)
  ) {
    return cleanDescription;
  }

  return `${cleanBusinessName} es ${cleanDescription}`;
}

function composeGeneralOverviewForDm(sections: ParsedSection[]): string {
  const businessNameSection = sections.find((section) =>
    isBusinessNameSection(section.normalizedHeader)
  );

  const descriptionSection = sections.find((section) =>
    isDescriptionSection(section.normalizedHeader)
  );

  const parts: string[] = [];

  const identityLine = composeBusinessIdentityLine(
    businessNameSection?.value || "",
    descriptionSection?.value || ""
  );

  if (identityLine) {
    parts.push(identityLine);
  }

  return parts.join("\n\n").trim();
}

export function buildLocationBlockFromInfoClave(
  infoClave?: string | null
): string {
  return extractSectionValue(infoClave, SECTION_ALIASES.location);
}

export function buildAvailabilityBlockFromInfoClave(
  infoClave?: string | null
): string {
  return extractSectionValue(infoClave, SECTION_ALIASES.availability);
}

export function buildServicesBlockFromInfoClave(
  infoClave?: string | null
): string {
  return extractSectionValue(infoClave, SECTION_ALIASES.services);
}

export function buildGeneralOverviewBlockFromInfoClave(
  infoClave?: string | null
): string {
  const sections = parseSections(infoClave);

  if (!sections.length) {
    return "";
  }

  return composeGeneralOverviewForDm(sections);
}