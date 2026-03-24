export function extractSchedulesOnly(infoClave?: string | null): string {
  const text = String(infoClave || "").trim();
  if (!text) return "";

  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const scheduleLines: string[] = [];
  let insideScheduleBlock = false;

  for (const line of lines) {
    const lower = line.toLowerCase();

    const startsScheduleBlock =
      lower === "horarios:" ||
      lower === "schedules:" ||
      lower.includes("horarios") ||
      lower.includes("schedule");

    const startsAnotherBlock =
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
      lower.startsWith("policies:");

    if (startsScheduleBlock) {
      insideScheduleBlock = true;
      continue;
    }

    if (insideScheduleBlock && startsAnotherBlock) {
      break;
    }

    if (insideScheduleBlock) {
      scheduleLines.push(line);
    }
  }

  return scheduleLines.join("\n").trim();
}