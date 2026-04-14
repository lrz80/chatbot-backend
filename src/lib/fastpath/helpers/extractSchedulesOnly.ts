//src/lib/fastpath/helpers/extractSchedulesOnly.ts

export type ExtractedScheduleEntry = {
  rawLine: string;
  label: string;
  value: string;
};

function normalizeText(value: string): string {
  return String(value || "").trim().toLowerCase();
}

function splitLines(infoClave?: string | null): string[] {
  return String(infoClave || "")
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function isScheduleHeader(line: string): boolean {
  const lower = normalizeText(line);

  return (
    lower === "horarios:" ||
    lower === "schedules:" ||
    lower.startsWith("horarios:") ||
    lower.startsWith("schedules:")
  );
}

function isAnotherTopLevelBlock(line: string): boolean {
  const lower = normalizeText(line);

  return (
    lower.startsWith("nombre del negocio:") ||
    lower.startsWith("business name:") ||
    lower.startsWith("tipo de negocio:") ||
    lower.startsWith("business type:") ||
    lower.startsWith("ubicación:") ||
    lower.startsWith("location:") ||
    lower.startsWith("teléfono:") ||
    lower.startsWith("phone:") ||
    lower.startsWith("servicios principales:") ||
    lower.startsWith("main services:") ||
    lower.startsWith("precios:") ||
    lower.startsWith("pricing:") ||
    lower.startsWith("link de precios:") ||
    lower.startsWith("pricing link:") ||
    lower.startsWith("reserva:") ||
    lower.startsWith("booking:") ||
    lower.startsWith("contacto:") ||
    lower.startsWith("contact:") ||
    lower.startsWith("políticas:") ||
    lower.startsWith("policies:")
  );
}

function extractRawScheduleLines(infoClave?: string | null): string[] {
  const lines = splitLines(infoClave);
  const scheduleLines: string[] = [];
  let insideScheduleBlock = false;

  for (const line of lines) {
    if (isScheduleHeader(line)) {
      insideScheduleBlock = true;
      continue;
    }

    if (insideScheduleBlock && isAnotherTopLevelBlock(line)) {
      break;
    }

    if (insideScheduleBlock) {
      scheduleLines.push(line);
    }
  }

  return scheduleLines;
}

function splitScheduleEntry(
  line: string
): { label: string; value: string } | null {
  const text = String(line || "").trim();
  if (!text) return null;

  const colonIndex = text.indexOf(":");
  if (colonIndex <= 0 || colonIndex === text.length - 1) {
    return null;
  }

  const label = text.slice(0, colonIndex).trim();
  const value = text.slice(colonIndex + 1).trim();

  if (!label || !value) {
    return null;
  }

  return { label, value };
}

export function extractStructuredSchedules(
  infoClave?: string | null
): ExtractedScheduleEntry[] {
  const rawLines = extractRawScheduleLines(infoClave);

  return rawLines
    .map((line) => {
      const parsed = splitScheduleEntry(line);

      if (!parsed) {
        return null;
      }

      return {
        rawLine: line,
        label: parsed.label,
        value: parsed.value,
      };
    })
    .filter((item): item is ExtractedScheduleEntry => item !== null);
}

export function extractSchedulesOnly(infoClave?: string | null): string {
  return extractRawScheduleLines(infoClave).join("\n").trim();
}