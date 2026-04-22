// src/lib/fastpath/handlers/catalog/helpers/catalogScheduleBlock.ts
import {
  extractSchedulesOnly,
  extractStructuredSchedules,
} from "../../../helpers/extractSchedulesOnly";
import { withSectionTitle } from "./catalogReplyBlocks";

export type ScheduleTarget =
  | { type: "none" }
  | { type: "general" }
  | { type: "service"; serviceId: string; serviceName: string };

type BuildScheduleBlockInput = {
  idiomaDestino: string;
  infoClave?: string | null;
  scheduleTarget?: ScheduleTarget;
  userInput?: string | null;
};

function normalizeText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
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

  if (
    target.type === "service" &&
    String(target.serviceId || "").trim() &&
    String(target.serviceName || "").trim()
  ) {
    return {
      type: "service",
      serviceId: String(target.serviceId).trim(),
      serviceName: String(target.serviceName).trim(),
    };
  }

  return { type: "general" };
}

function lineMatchesService(line: string, serviceName: string): boolean {
  const lineNorm = normalizeText(line);
  const serviceNorm = normalizeText(serviceName);

  if (!lineNorm || !serviceNorm) return false;

  return lineNorm.includes(serviceNorm);
}

function tokenizeMeaningfulWords(value: unknown): string[] {
  const normalized = normalizeText(value);
  if (!normalized) return [];

  return normalized
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4);
}

function lineMatchesUserIntent(line: string, userInput?: string | null): boolean {
  const lineNorm = normalizeText(line);
  const tokens = tokenizeMeaningfulWords(userInput);

  if (!lineNorm || tokens.length === 0) return false;

  return tokens.some((token) => lineNorm.includes(token));
}

export function buildScheduleBlock(input: BuildScheduleBlockInput): string {
  const scheduleTarget = normalizeScheduleTarget(input.scheduleTarget);

  if (scheduleTarget.type === "none") {
    return "";
  }

  const structuredEntries = extractStructuredSchedules(input.infoClave);

  let lines: string[] = [];

  if (structuredEntries.length > 0) {
    const rawLines = structuredEntries
      .map((entry) => String(entry?.rawLine || "").trim())
      .filter(Boolean);

    if (scheduleTarget.type === "service") {
      const matchedByService = rawLines.filter((line) =>
        lineMatchesService(line, scheduleTarget.serviceName)
      );

      if (matchedByService.length > 0) {
        lines = matchedByService;
      } else {
        const matchedByUserIntent = rawLines.filter((line) =>
          lineMatchesUserIntent(line, input.userInput)
        );

        lines = matchedByUserIntent.length > 0 ? matchedByUserIntent : rawLines;
      }
    } else {
      const matchedByUserIntent = rawLines.filter((line) =>
        lineMatchesUserIntent(line, input.userInput)
      );

      lines = matchedByUserIntent.length > 0 ? matchedByUserIntent : rawLines;
    }
  } else {
    const schedulesOnly = extractSchedulesOnly(input.infoClave);
    const rawLines = String(schedulesOnly || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    if (scheduleTarget.type === "service") {
      const matchedByService = rawLines.filter((line) =>
        lineMatchesService(line, scheduleTarget.serviceName)
      );

      if (matchedByService.length > 0) {
        lines = matchedByService;
      } else {
        const matchedByUserIntent = rawLines.filter((line) =>
          lineMatchesUserIntent(line, input.userInput)
        );

        lines = matchedByUserIntent.length > 0 ? matchedByUserIntent : rawLines;
      }
    } else {
      const matchedByUserIntent = rawLines.filter((line) =>
        lineMatchesUserIntent(line, input.userInput)
      );

      lines = matchedByUserIntent.length > 0 ? matchedByUserIntent : rawLines;
    }
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