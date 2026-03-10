// backend/src/lib/estimateFlow/getEstimateFlowState.ts

import type { EstimateFlowState } from "./types";
import { createEmptyEstimateFlowState } from "./types";

export function getEstimateFlowState(convoCtx: any): EstimateFlowState {
  const raw = convoCtx?.estimateFlow;

  if (!raw || typeof raw !== "object") {
    return createEmptyEstimateFlowState();
  }

  return {
    active: Boolean(raw.active),
    step: raw.step || "idle",
    name: raw.name ?? null,
    phone: raw.phone ?? null,
    address: raw.address ?? null,
    jobType: raw.jobType ?? null,
    startedAt: raw.startedAt ?? null,
    updatedAt: raw.updatedAt ?? null,
  };
}