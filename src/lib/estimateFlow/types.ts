// backend/src/lib/estimateFlow/types.ts

export type EstimateFlowStep =
  | "idle"
  | "awaiting_name"
  | "awaiting_phone"
  | "awaiting_address"
  | "awaiting_job_type"
  | "ready_to_schedule";

export type EstimateFlowState = {
  active: boolean;
  step: EstimateFlowStep;

  name?: string | null;
  phone?: string | null;
  address?: string | null;
  jobType?: string | null;

  startedAt?: number | null;
  updatedAt?: number | null;
};

export function createEmptyEstimateFlowState(): EstimateFlowState {
  return {
    active: false,
    step: "idle",
    name: null,
    phone: null,
    address: null,
    jobType: null,
    startedAt: null,
    updatedAt: null,
  };
}