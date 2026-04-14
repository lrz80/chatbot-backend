// src/lib/fastpath/handlers/catalog/helpers/catalogScheduleBlock.ts

import {
  extractSchedulesOnly,
  extractStructuredSchedules,
} from "../../../helpers/extractSchedulesOnly";
import { withSectionTitle } from "./catalogReplyBlocks";

export type ScheduleTarget =
  | { type: "none" }
  | { type: "general" };

type BuildScheduleBlockInput = {
  idiomaDestino: string;
  infoClave?: string | null;
  scheduleTarget?: ScheduleTarget;
};

function normalizeScheduleTarget(
  target?: ScheduleTarget | null
): ScheduleTarget {
  if (!target || typeof target !== "object") {
    return { type: "general" };
  }

  if (target.type === "none") {
    return { type: "none" };
  }

  return { type: "general" };
}

export function buildScheduleBlock(input: BuildScheduleBlockInput): string {
  const scheduleTarget = normalizeScheduleTarget(input.scheduleTarget);

  if (scheduleTarget.type === "none") {
    return "";
  }

  // Dejamos el extractor estructurado evaluado para que este helper
  // dependa de una fuente preparada para evolución futura, pero sin
  // introducir todavía filtrado frágil por texto.
  const structuredEntries = extractStructuredSchedules(input.infoClave);
  const schedulesOnly =
    structuredEntries.length > 0
      ? structuredEntries.map((entry) => entry.rawLine).join("\n").trim()
      : extractSchedulesOnly(input.infoClave);

  if (!String(schedulesOnly || "").trim()) {
    return "";
  }

  return withSectionTitle(
    input.idiomaDestino,
    "Horarios:",
    "Schedules:",
    schedulesOnly
  );
}