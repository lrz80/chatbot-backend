//src/lib/voice/realtime/realtimeToolExecutor.ts
import { createAppointmentFromVoice } from "../../appointments/createAppointmentFromVoice";
import { getAppointmentSettings } from "../../appointments/getAppointmentSettings";

type ExecuteRealtimeToolParams = {
  tenantId: string;
  callerPhone: string | null;
  toolName: string;
  args: Record<string, any>;
};

function clean(value: unknown): string {
  return String(value || "").trim();
}

export async function executeRealtimeTool({
  tenantId,
  callerPhone,
  toolName,
  args,
}: ExecuteRealtimeToolParams): Promise<any> {
  switch (toolName) {
    case "create_appointment": {
      const settings = await getAppointmentSettings(tenantId);

      const service = clean(args.service);
      const datetime = clean(args.datetime);
      const datetimeIso = clean(args.datetime_iso);
      const customerName = clean(args.customer_name) || "Cliente Voz";
      const customerPhone = clean(args.customer_phone) || callerPhone || null;
      const customerEmail = clean(args.customer_email) || null;

      if (!service) {
        return {
          ok: false,
          error: "MISSING_SERVICE",
          message: "Service is required before creating an appointment.",
        };
      }

      if (!datetime && !datetimeIso) {
        return {
          ok: false,
          error: "MISSING_DATETIME",
          message: "Date and time are required before creating an appointment.",
        };
      }

      const result = await createAppointmentFromVoice({
        tenantId,
        answersBySlot: {
          service,
          datetime,
          datetime_iso: datetimeIso,
          customer_name: customerName,
          customer_phone: customerPhone,
          customer_email: customerEmail,
        },
        settings,
      });

      return {
        ok: true,
        appointment: {
          id: result.id,
          service: result.service || service,
          customer_name: result.customer_name,
          customer_phone: result.customer_phone,
          start_time: result.start_time,
          end_time: result.end_time,
          status: result.status,
          google_event_link: result.google_event_link || null,
        },
      };
    }

    default:
      return {
        ok: false,
        error: "UNKNOWN_TOOL",
        message: `Unknown realtime tool: ${toolName}`,
      };
  }
}