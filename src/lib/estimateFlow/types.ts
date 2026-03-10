// backend/src/lib/estimateFlow/types.ts

export type EstimateFlowStep =
  | "idle"
  | "awaiting_name"
  | "awaiting_phone"
  | "awaiting_address"
  | "awaiting_job_type"
  | "awaiting_date"
  | "awaiting_time"
  | "ready_to_schedule"
  | "scheduled";

export type EstimateFlowState = {
  active: boolean;
  step: EstimateFlowStep;

  lang?: "es" | "en" | null;

  name?: string | null;
  phone?: string | null;
  address?: string | null;
  jobType?: string | null;

  preferredDate?: string | null; // YYYY-MM-DD
  preferredTime?: string | null; // HH:MM AM/PM
  calendarEventId?: string | null;
  calendarEventLink?: string | null;

  startedAt?: number | null;
  updatedAt?: number | null;
};

export function createEmptyEstimateFlowState(): EstimateFlowState {
  return {
    active: false,
    step: "idle",
    lang: null,
    name: null,
    phone: null,
    address: null,
    jobType: null,
    preferredDate: null,
    preferredTime: null,
    calendarEventId: null,
    calendarEventLink: null,
    startedAt: null,
    updatedAt: null,
  };
}