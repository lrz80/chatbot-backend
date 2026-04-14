// src/lib/fastpath/handlers/catalog/helpers/catalogScheduleBlock.ts

import { extractSchedulesOnly } from "../../../helpers/extractSchedulesOnly";
import { withSectionTitle } from "./catalogReplyBlocks";

export type ScheduleTarget =
  | { type: "none" }
  | { type: "general" }
  | {
      type: "service";
      serviceId: string;
      serviceName: string | null;
    };

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

  if (target.type === "service") {
    const serviceId = String(target.serviceId || "").trim();
    const serviceName = String(target.serviceName || "").trim() || null;

    if (!serviceId) {
      return { type: "general" };
    }

    return {
      type: "service",
      serviceId,
      serviceName,
    };
  }

  if (target.type === "none") {
    return { type: "none" };
  }

  return { type: "general" };
}

export function buildScheduleBlock(input: BuildScheduleBlockInput): string {
  const scheduleTarget = normalizeScheduleTarget(input.scheduleTarget);
  const schedulesOnly = extractSchedulesOnly(input.infoClave);

  if (!String(schedulesOnly || "").trim()) {
    return "";
  }

  // Este helper sigue siendo renderer puro.
  // No interpreta userInput ni hace matching semántico.
  // Si más adelante existe un extractor estructurado de horarios por servicio,
  // el filtrado específico se hace antes o sobre esa estructura, no aquí.
  if (scheduleTarget.type === "none") {
    return "";
  }

  return withSectionTitle(
    input.idiomaDestino,
    "Horarios:",
    "Schedules:",
    schedulesOnly
  );
}