//src/lib/voice/realtime/dashboardVoiceResolvedContent.ts
import type { RealtimeToolResult } from "./toolTypes";

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeKey(value: unknown): string {
  return clean(value).toLowerCase();
}

function stepLabel(stepKey: string): string {
  const key = normalizeKey(stepKey);

  const labels: Record<string, string> = {
    service: "servicio",
    staff: "profesional",
    datetime: "fecha/hora",
    date: "fecha",
    time: "hora",
    customer_name: "nombre",
    name: "nombre",
    customer_phone: "teléfono",
    phone: "teléfono",
    service_address: "dirección",
    address: "dirección",
    pet_weight: "peso de la mascota",
    customer_email: "email",
    email: "email",
    confirm: "confirmación",
    confirmation: "confirmación",
    offer_booking_sms: "SMS de confirmación",
  };

  return labels[key] || key || "dato solicitado";
}

function safeValue(value: unknown): string {
  const text = clean(value);

  if (!text) return "";

  if (text.length > 120) {
    return `${text.slice(0, 117)}...`;
  }

  return text;
}

export function resolveDashboardVoiceToolContent(params: {
  toolName: string;
  effectiveToolArgs: Record<string, any>;
  toolResult: RealtimeToolResult | any;
}): string | undefined {
  const toolName = normalizeKey(params.toolName);
  const args = params.effectiveToolArgs || {};
  const result = params.toolResult || {};

  if (result.ok === false) {
    return undefined;
  }

  if (toolName === "get_booking_flow") {
    return "Cliente solicitó agendar una cita.";
  }

  if (toolName === "create_appointment") {
    return "Cliente confirmó la reserva.";
  }

  if (toolName === "submit_booking_step") {
    const stepKey = clean(args.step_key);
    const value = safeValue(args.value);

    const normalizedValue = normalizeKey(value);

    if (stepKey === "confirm" || stepKey === "confirmation") {
      if (normalizedValue === "confirm") {
        return "Cliente confirmó la reserva.";
      }

      if (normalizedValue === "cancel") {
        return "Cliente canceló la reserva.";
      }

      return "Cliente respondió a la confirmación.";
    }

    const label = stepLabel(stepKey);

    if (value) {
      return `Cliente respondió ${label}: ${value}.`;
    }

    return `Cliente respondió ${label}.`;
  }

  if (toolName === "send_booking_sms") {
    return "Cliente aceptó recibir confirmación por SMS.";
  }

  if (toolName === "end_call") {
    return "Cliente finalizó la llamada.";
  }

  return undefined;
}