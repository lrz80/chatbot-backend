// src/lib/appointments/getBookingFlow.ts
import pool from "../db";

export type BookingStep = {
  step_key: string;
  step_order: number;
  prompt: string;
  expected_type: string;
  required: boolean;
  enabled: boolean;
  retry_prompt: string | null;
  validation_config: Record<string, unknown> | null;
  prompt_translations: Record<string, string> | null;
  retry_prompt_translations: Record<string, string> | null;
};

type BookingFlowCacheEntry = {
  expiresAt: number;
  steps: BookingStep[];
};

/**
 * Nombre histórico usado actualmente por la tabla
 * appointment_booking_flows.
 *
 * No representa el canal desde el que habla el cliente.
 * Representa el único flujo de booking configurado en el dashboard.
 *
 * Voice, WhatsApp, Facebook e Instagram consumen este mismo flujo.
 */
export const SHARED_BOOKING_FLOW_PROFILE = "voice";

const BOOKING_FLOW_TTL_MS = 30_000;
const bookingFlowCache = new Map<string, BookingFlowCacheEntry>();

function buildBookingFlowCacheKey(
  tenantId: string,
  flowProfile: string
): string {
  return `${tenantId}:${flowProfile}`;
}

export function clearBookingFlowCache(
  tenantId?: string,
  flowProfile = SHARED_BOOKING_FLOW_PROFILE
): void {
  if (!tenantId) {
    bookingFlowCache.clear();
    return;
  }

  bookingFlowCache.delete(
    buildBookingFlowCacheKey(tenantId, flowProfile)
  );
}

/**
 * Acceso canónico al flujo único configurado en el dashboard.
 *
 * Todos los canales deben usar esta función.
 */
export async function getSharedBookingFlow(
  tenantId: string
): Promise<BookingStep[]> {
  return getBookingFlow(
    tenantId,
    SHARED_BOOKING_FLOW_PROFILE
  );
}

/**
 * Lectura de bajo nivel por perfil.
 *
 * Se conserva exportada para migraciones, administración y
 * compatibilidad, pero el runtime conversacional debe usar
 * getSharedBookingFlow().
 */
export async function getBookingFlow(
  tenantId: string,
  flowProfile = SHARED_BOOKING_FLOW_PROFILE
): Promise<BookingStep[]> {
  const normalizedTenantId = String(tenantId || "").trim();
  const normalizedFlowProfile = String(
    flowProfile || SHARED_BOOKING_FLOW_PROFILE
  ).trim();

  if (!normalizedTenantId) {
    throw new Error("BOOKING_FLOW_TENANT_ID_REQUIRED");
  }

  if (!normalizedFlowProfile) {
    throw new Error("BOOKING_FLOW_PROFILE_REQUIRED");
  }

  const cacheKey = buildBookingFlowCacheKey(
    normalizedTenantId,
    normalizedFlowProfile
  );

  const now = Date.now();
  const cached = bookingFlowCache.get(cacheKey);

  if (cached && cached.expiresAt > now) {
    return cached.steps;
  }

  const { rows } = await pool.query(
    `
      SELECT
        step_key,
        step_order,
        prompt,
        expected_type,
        required,
        enabled,
        retry_prompt,
        validation_config,
        prompt_translations,
        retry_prompt_translations
      FROM appointment_booking_flows
      WHERE tenant_id = $1
        AND channel = $2
      ORDER BY step_order ASC
    `,
    [
      normalizedTenantId,
      normalizedFlowProfile,
    ]
  );

  const steps = rows as BookingStep[];

  bookingFlowCache.set(cacheKey, {
    expiresAt: now + BOOKING_FLOW_TTL_MS,
    steps,
  });

  return steps;
}