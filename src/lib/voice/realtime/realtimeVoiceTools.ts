//src/lib/voice/realtime/realtimeVoiceTools.ts
export type RealtimeToolResult = {
  ok: boolean;
  message: string;
  data?: Record<string, unknown>;
};

export async function getBusinessInfo(): Promise<RealtimeToolResult> {
  return {
    ok: true,
    message:
      "Realtime voice tools are connected, but tenant-specific business info is not enabled yet.",
  };
}

export async function startBooking(): Promise<RealtimeToolResult> {
  return {
    ok: true,
    message:
      "Booking tools are not connected yet. Ask the caller for the service, date, time, name, and phone only as a test.",
  };
}

export async function checkAvailability(): Promise<RealtimeToolResult> {
  return {
    ok: false,
    message:
      "Availability checking is not connected yet. This will be wired to Aamy booking providers in the next phase.",
  };
}

export async function createAppointment(): Promise<RealtimeToolResult> {
  return {
    ok: false,
    message:
      "Appointment creation is not connected yet. This will be wired to Aamy booking engine in the next phase.",
  };
}

export async function sendBookingSms(): Promise<RealtimeToolResult> {
  return {
    ok: false,
    message:
      "SMS sending is not connected yet. This will be wired to Aamy SMS runtime in the next phase.",
  };
}