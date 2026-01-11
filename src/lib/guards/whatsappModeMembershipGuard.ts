// backend/src/lib/guards/whatsappModeMembershipGuard.ts

import type { Canal } from '../../lib/detectarIntencion';

type Origen = "twilio" | "meta";
type WhatsAppMode = "twilio" | "cloudapi";
type WhatsAppStatus = "enabled" | "disabled" | string;

export type GuardResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "whatsapp_disabled"
        | "mode_mismatch_twilio"
        | "mode_mismatch_meta"
        | "membership_inactive";
    };

export async function whatsappModeMembershipGuard(opts: {
  tenant: any; // si tienes tipo Tenant, úsalo
  tenantId: string;
  canal: Canal;
  origen: Origen;
  mode: WhatsAppMode;
  status: WhatsAppStatus;
  requireMembershipActive?: boolean; // default true
}): Promise<GuardResult> {
  const {
    tenant,
    tenantId,
    origen,
    mode,
    status,
    requireMembershipActive = true,
  } = opts;

  // 1) WhatsApp habilitado?
  if (status !== "enabled") {
    console.log("⛔ WhatsApp deshabilitado para tenant:", tenantId, "status=", status);
    return { ok: false, reason: "whatsapp_disabled" };
  }

  // 2) Anti-doble respuesta por modo
  // Si llega por Twilio pero el tenant está en Cloud API → ignorar
  if (origen === "twilio" && mode !== "twilio") {
    console.log("⏭️ Ignoro webhook Twilio: tenant en cloudapi. tenantId=", tenantId);
    return { ok: false, reason: "mode_mismatch_twilio" };
  }

  // Si llega por Meta pero el tenant está en Twilio → ignorar
  if (origen === "meta" && mode !== "cloudapi") {
    console.log("⏭️ Ignoro webhook Meta: tenant en twilio. tenantId=", tenantId);
    return { ok: false, reason: "mode_mismatch_meta" };
  }

  // 3) Membresía activa? (por defecto: sí, si no hay membresía no respondas)
  if (requireMembershipActive && !tenant?.membresia_activa) {
    console.log(`⛔ Membresía inactiva para tenant ${tenant?.name || tenantId}. No se responderá.`);
    return { ok: false, reason: "membership_inactive" };
  }

  return { ok: true };
}
