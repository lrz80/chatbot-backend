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
  | "scheduled";

export type EstimateFlowSlot = {
  startISO: string;
  endISO: string;
  label?: string | null;
};

export type EstimateFlowState = {
  active: boolean;
  step: EstimateFlowStep;

  lang?: "es" | "en" | null;

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
    offeredSlots: [],
    selectedSlot: null,
    startedAt: null,
    updatedAt: null,
  };
}