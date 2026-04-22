// src/lib/fastpath/handlers/catalog/helpers/catalogScheduleBlock.ts
import {
  extractSchedulesOnly,
  extractStructuredSchedules,
} from "../../../helpers/extractSchedulesOnly";
import { buildScheduleGroupKey } from "../../../../channels/engine/businessInfo/buildScheduleGroupKey";
import { withSectionTitle } from "./catalogReplyBlocks";

export type ScheduleTarget =
  | { type: "none" }
  | { type: "general" }
  | {
      type: "schedule_group";
      serviceId: string;
      serviceName: string;
      scheduleGroupKey: string;
    };

type BuildScheduleBlockInput = {
  idiomaDestino: string;
  infoClave?: string | null;
  scheduleTarget?: ScheduleTarget;
  userInput?: string | null;
};

type StructuredScheduleEntry = {
  rawLine?: string | null;
};

function trimBulletPrefix(value: string): string {
  let out = String(value || "").trimStart();

  while (out.length > 0) {
    const first = out[0];
    if (
      first === "•" ||
      first === "*" ||
      first === "-" ||
      first === "–" ||
      first === "—"
    ) {
      out = out.slice(1).trimStart();
      continue;
    }
    break;
  }

  return out.trim();
}

function findFirstSeparatorIndex(value: string): number {
  const separators = [" – ", " — ", " - ", ": "];
  let best = -1;

  for (const separator of separators) {
    const idx = value.indexOf(separator);
    if (idx === -1) continue;
    if (best === -1 || idx < best) {
      best = idx;
    }
  }

  return best;
}

function extractGroupLabelFromRawLine(rawLine: string): string | null {
  const cleaned = trimBulletPrefix(String(rawLine || "").trim());

  if (!cleaned) {
    return null;
  }

  const separatorIndex = findFirstSeparatorIndex(cleaned);
  if (separatorIndex <= 0) {
    return null;
  }

  const label = cleaned.slice(0, separatorIndex).trim();
  return label || null;
}

function normalizeScheduleTarget(
  target?: ScheduleTarget | null
): ScheduleTarget {
  if (!target || typeof target !== "object") {
    return { type: "general" };
  }

  if (target.type === "none") {
    return { type: "none" };
  }

  if (target.type === "general") {
    return { type: "general" };
  }

  if (
    target.type === "schedule_group" &&
    String(target.serviceId || "").trim() &&
    String(target.serviceName || "").trim() &&
    String(target.scheduleGroupKey || "").trim()
  ) {
    return {
      type: "schedule_group",
      serviceId: String(target.serviceId).trim(),
      serviceName: String(target.serviceName).trim(),
      scheduleGroupKey: String(target.scheduleGroupKey).trim(),
    };
  }

  return { type: "none" };
}

function resolveStructuredLinesByTarget(
  entries: StructuredScheduleEntry[],
  scheduleTarget: ScheduleTarget
): string[] {
  const rawLines = entries
    .map((entry) => String(entry?.rawLine || "").trim())
    .filter(Boolean);

  if (scheduleTarget.type === "general") {
    return rawLines;
  }

  if (scheduleTarget.type !== "schedule_group") {
    return [];
  }

  const wantedKey = buildScheduleGroupKey(scheduleTarget.scheduleGroupKey);
  if (!wantedKey) {
    return [];
  }

  return rawLines.filter((line) => {
    const groupLabel = extractGroupLabelFromRawLine(line);
    if (!groupLabel) {
      return false;
    }

    const lineGroupKey = buildScheduleGroupKey(groupLabel);
    return lineGroupKey === wantedKey;
  });
}

function resolvePlainLines(infoClave?: string | null): string[] {
  return String(extractSchedulesOnly(infoClave) || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function buildScheduleBlock(input: BuildScheduleBlockInput): string {
  const scheduleTarget = normalizeScheduleTarget(input.scheduleTarget);

  if (scheduleTarget.type === "none") {
    return "";
  }

  const structuredEntries = extractStructuredSchedules(
    input.infoClave
  ) as StructuredScheduleEntry[];

  let lines: string[] = [];

  if (Array.isArray(structuredEntries) && structuredEntries.length > 0) {
    lines = resolveStructuredLinesByTarget(structuredEntries, scheduleTarget);
  } else if (scheduleTarget.type === "general") {
    lines = resolvePlainLines(input.infoClave);
  } else {
    lines = [];
  }

  const finalBody = lines.join("\n").trim();

  if (!finalBody) {
    return "";
  }

  return withSectionTitle(
    input.idiomaDestino,
    "Horarios:",
    "Schedules:",
    finalBody
  );
}