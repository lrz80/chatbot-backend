// backend/src/lib/estimateFlow/updateEstimateFlowState.ts

import type { EstimateFlowState } from "./types";

export function updateEstimateFlowState(
  prev: any,
  patch: Partial<EstimateFlowState>
): EstimateFlowState {
  const now = Date.now();

  return {
    active: patch.active ?? prev?.active ?? false,
    step: patch.step ?? prev?.step ?? "idle",

    lang: patch.lang ?? prev?.lang ?? null,

    action: patch.action ?? prev?.action ?? null,

    name: patch.name ?? prev?.name ?? null,
    phone: patch.phone ?? prev?.phone ?? null,
    address: patch.address ?? prev?.address ?? null,
    jobType: patch.jobType ?? prev?.jobType ?? null,
    preferredDate: patch.preferredDate ?? prev?.preferredDate ?? null,
    preferredTime: patch.preferredTime ?? prev?.preferredTime ?? null,

    offeredSlots: patch.offeredSlots ?? prev?.offeredSlots ?? [],
    selectedSlot: patch.selectedSlot ?? prev?.selectedSlot ?? null,

    calendarEventId: patch.calendarEventId ?? prev?.calendarEventId ?? null,
    calendarEventLink: patch.calendarEventLink ?? prev?.calendarEventLink ?? null,

    startedAt: prev?.startedAt ?? patch.startedAt ?? now,
    updatedAt: now,
  };
}