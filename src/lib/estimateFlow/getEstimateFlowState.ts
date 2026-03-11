// backend/src/lib/estimateFlow/getEstimateFlowState.ts

import type { EstimateFlowState } from "./types";
import { createEmptyEstimateFlowState } from "./types";

const ESTIMATE_FLOW_TTL_MS = 30 * 60 * 1000; // 30 minutos

export function getEstimateFlowState(convoCtx: any): EstimateFlowState {
  const raw = convoCtx?.estimateFlow;

  if (!raw || typeof raw !== "object") {
    return createEmptyEstimateFlowState();
  }

  const updatedAt = typeof raw.updatedAt === "number" ? raw.updatedAt : null;
  const active = Boolean(raw.active);

  const expired =
    active &&
    updatedAt &&
    Number.isFinite(updatedAt) &&
    (Date.now() - updatedAt) > ESTIMATE_FLOW_TTL_MS;

  if (expired) {
    return createEmptyEstimateFlowState();
  }

  return {
    active,
    step: raw.step || "idle",
    lang: raw.lang ?? null,
    name: raw.name ?? null,
    phone: raw.phone ?? null,
    address: raw.address ?? null,
    jobType: raw.jobType ?? null,
    preferredDate: raw.preferredDate ?? null,
    preferredTime: raw.preferredTime ?? null,
    calendarEventId: raw.calendarEventId ?? null,
    calendarEventLink: raw.calendarEventLink ?? null,
    offeredSlots: Array.isArray(raw.offeredSlots) ? raw.offeredSlots : [],
    selectedSlot: raw.selectedSlot ?? null,
    startedAt: raw.startedAt ?? null,
    updatedAt,
  };
}