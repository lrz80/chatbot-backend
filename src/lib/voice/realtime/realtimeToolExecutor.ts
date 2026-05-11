//src/lib/voice/realtime/realtimeToolExecutor.ts
import { createAppointmentFromVoice } from "../../appointments/createAppointmentFromVoice";
import { getAppointmentSettings } from "../../appointments/getAppointmentSettings";
import { getBookingFlow } from "../../appointments/getBookingFlow";

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
    case "get_booking_flow": {
      const steps = await getBookingFlow(tenantId, "voice");

      return {
        ok: true,
        steps: steps
          .filter((step) => step.enabled)
          .map((step) => ({
            step_key: step.step_key,
            step_order: step.step_order,
            prompt: step.prompt,
            expected_type: step.expected_type,
            required: step.required,
            retry_prompt: step.retry_prompt,
            validation_config: step.validation_config || null,
            prompt_translations: step.prompt_translations || null,
            retry_prompt_translations: step.retry_prompt_translations || null,
        })),
      };
    }

    case "create_appointment": {
      const settings = await getAppointmentSettings(tenantId);

      if (args.customer_confirmed !== true) {
        return {
          ok: false,
          error: "MISSING_FINAL_CONFIRMATION",
          message:
            "The appointment cannot be created until the caller explicitly confirms the final appointment details.",
        };
      }
      const rawService = clean(args.service);

      const service = rawService
        .replace(/\s+para\s+.*$/i, "")
        .replace(/\s+for\s+.*$/i, "")
        .trim();

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