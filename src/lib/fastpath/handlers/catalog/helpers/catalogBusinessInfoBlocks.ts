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
    const line = lines[i];
    const raw = String(line || "").trim();

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

function isOperationalSection(normalizedHeader: string): boolean {
  const operationalAliases = [
    ...SECTION_ALIASES.location,
    ...SECTION_ALIASES.availability,
    ...SECTION_ALIASES.schedule,
    ...SECTION_ALIASES.pricing,
    ...SECTION_ALIASES.booking,
    ...SECTION_ALIASES.phone,
    ...SECTION_ALIASES.contact,
  ].map(normalizeLabel);

  return operationalAliases.includes(normalizedHeader);
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

function isOverviewExcludedSection(normalizedHeader: string): boolean {
  const excludedAliases = [
    ...SECTION_ALIASES.location,
    ...SECTION_ALIASES.availability,
    ...SECTION_ALIASES.schedule,
    ...SECTION_ALIASES.pricing,
    ...SECTION_ALIASES.booking,
    ...SECTION_ALIASES.phone,
    ...SECTION_ALIASES.contact,
    ...SECTION_ALIASES.rules,
  ].map(normalizeLabel);

  return excludedAliases.includes(normalizedHeader);
}

export function buildServicesBlockFromInfoClave(
  infoClave?: string | null
): string {
  const explicitServices = extractSectionValue(infoClave, SECTION_ALIASES.services);
  if (explicitServices) {
    return explicitServices;
  }

  const sections = parseSections(infoClave);

  const overviewSections = sections.filter((section) => {
    if (!section.value) return false;
    if (isOverviewExcludedSection(section.normalizedHeader)) return false;
    return true;
  });

  if (!overviewSections.length) {
    return "";
  }

  return overviewSections
    .map((section) => `${section.rawHeader}:\n${section.value}`)
    .join("\n\n")
    .trim();
}