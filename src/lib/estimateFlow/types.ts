//src/lib/estimateFlow/types.ts
import type { LangCode } from "../i18n/lang";

export type EstimateFlowStep =
  | "idle"
  | "awaiting_name"
  | "awaiting_phone"
  | "awaiting_address"
  | "awaiting_job_type"
  | "awaiting_date"
  | "offering_slots"
  | "awaiting_slot_choice"
  | "manage_existing"
  | "ready_to_schedule"
  | "ready_to_cancel"
  | "scheduled"
  | "cancelled";

export type EstimateFlowSlot = {
  startISO: string;
  endISO: string;
  label?: string | null;
};

export type EstimateFlowState = {
  active: boolean;
  step: EstimateFlowStep;

  lang?: LangCode | null;

  name?: string | null;
  phone?: string | null;
  address?: string | null;
  jobType?: string | null;

  preferredDate?: string | null; // YYYY-MM-DD
  preferredTime?: string | null; // label visible del slot elegido
  calendarEventId?: string | null;
  calendarEventLink?: string | null;

  offeredSlots?: EstimateFlowSlot[] | null;
  selectedSlot?: EstimateFlowSlot | null;

  startedAt?: number | null;
  updatedAt?: number | null;

  action?: "cancel" | "reschedule" | null;
};

export function createEmptyEstimateFlowState(): EstimateFlowState {
  return {
    active: false,
    step: "idle",
    lang: null,
    action: null,
    name: null,
    phone: null,
    address: null,
    jobType: null,
    preferredDate: null,
    preferredTime: null,
    calendarEventId: null,
    calendarEventLink: null,
    offeredSlots: [],
    selectedSlot: null,
    startedAt: null,
    updatedAt: null,
  };
}