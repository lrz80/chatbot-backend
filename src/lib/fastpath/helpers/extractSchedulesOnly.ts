//src/lib/fastpath/helpers/extractSchedulesOnly.ts
export type ExtractedScheduleEntry = {
  rawLine: string;
  label: string;
  value: string;

  groupLabel: string;
  groupKey: string;

  slotLabel: string;
  slotKey: string;

  times: string[];
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

function findGroupSlotSeparatorIndex(label: string): number {
  const separators = [" – ", " — ", " - "];
  let best = -1;

  for (const separator of separators) {
    const idx = label.indexOf(separator);
    if (idx === -1) continue;
    if (best === -1 || idx < best) {
      best = idx;
    }
  }

  return best;
}

function splitGroupAndSlot(
  label: string
): { groupLabel: string; slotLabel: string } | null {
  const text = String(label || "").trim();
  if (!text) return null;

  const separatorIndex = findGroupSlotSeparatorIndex(text);
  if (separatorIndex <= 0) {
    return null;
  }

  const groupLabel = text.slice(0, separatorIndex).trim();

  let slotLabel = "";
  if (text.includes(" – ")) {
    slotLabel = text.slice(separatorIndex + 3).trim();
  } else if (text.includes(" — ")) {
    slotLabel = text.slice(separatorIndex + 3).trim();
  } else if (text.includes(" - ")) {
    slotLabel = text.slice(separatorIndex + 3).trim();
  }

  if (!groupLabel || !slotLabel) {
    return null;
  }

  return { groupLabel, slotLabel };
}

function buildAsciiKey(value: string): string {
  const normalized = String(value || "")
    .normalize("NFD")
    .split("")
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code < 0x0300 || code > 0x036f;
    })
    .join("")
    .toLowerCase()
    .trim();

  if (!normalized) {
    return "";
  }

  const out: string[] = [];
  let previousWasUnderscore = false;

  for (const ch of normalized) {
    const isAlphaNum =
      (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9");

    if (isAlphaNum) {
      out.push(ch);
      previousWasUnderscore = false;
      continue;
    }

    if (!previousWasUnderscore) {
      out.push("_");
      previousWasUnderscore = true;
    }
  }

  while (out.length > 0 && out[0] === "_") {
    out.shift();
  }

  while (out.length > 0 && out[out.length - 1] === "_") {
    out.pop();
  }

  return out.join("");
}

function splitTimes(value: string): string[] {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
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

      const groupAndSlot = splitGroupAndSlot(parsed.label);
      if (!groupAndSlot) {
        return null;
      }

      const groupKey = buildAsciiKey(groupAndSlot.groupLabel);
      const slotKey = buildAsciiKey(groupAndSlot.slotLabel);
      const times = splitTimes(parsed.value);

      if (!groupKey || !slotKey || times.length === 0) {
        return null;
      }

      return {
        rawLine: line,
        label: parsed.label,
        value: parsed.value,
        groupLabel: groupAndSlot.groupLabel,
        groupKey,
        slotLabel: groupAndSlot.slotLabel,
        slotKey,
        times,
      };
    })
    .filter((item): item is ExtractedScheduleEntry => item !== null);
}

export function extractSchedulesOnly(infoClave?: string | null): string {
  return extractRawScheduleLines(infoClave).join("\n").trim();
}