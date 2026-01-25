// src/lib/appointments/booking/types.ts

export type BookingCtx = {
  booking?: {
    step?:
      | "idle"
      | "ask_purpose"
      | "ask_daypart"
      | "offer_slots"
      | "ask_contact"
      | "confirm"
      | "ask_all"
      | "ask_name"
      | "ask_email"
      | "ask_datetime"
      | "ask_phone";

    start_time?: string | null;
    end_time?: string | null;
    timeZone?: string | null;

    name?: string | null;
    email?: string | null;
    phone?: string | null;
    purpose?: string | null;

    date_only?: string | null;
    slots?: Array<{ startISO: string; endISO: string }>;
    daypart?: "morning" | "afternoon" | null;
    picked_start?: string | null;
    picked_end?: string | null;
  };

  // ✅ POST-BOOKING GUARD (lo usas en bookingFlow.ts)
  booking_last_done_at?: number | null;
  booking_last_event_link?: string | null;

  // ✅ compat/legacy (los seteas al final del confirm)
  last_appointment_id?: string | number | null;
  booking_completed?: boolean;
  booking_completed_at?: string | null;
};

export type DayHours = { start: string; end: string }; // "09:00" - "18:00"

export type HoursByWeekday = {
  mon?: DayHours | null;
  tue?: DayHours | null;
  wed?: DayHours | null;
  thu?: DayHours | null;
  fri?: DayHours | null;
  sat?: DayHours | null;
  sun?: DayHours | null;
};

export type Slot = {
  startISO: string;
  endISO: string;
};
