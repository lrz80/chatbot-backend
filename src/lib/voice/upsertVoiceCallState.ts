//src/lib/voice/upsertVoiceCallState.ts
import pool from "../db";

type UpsertVoiceCallStateInput = {
  callSid: string;
  tenantId: string;
  lang?: string | null;
  turn?: number;
  awaiting?: boolean;
  pendingType?: "reservar" | "comprar" | "soporte" | "web" | null;
  awaitingNumber?: boolean;
  altDest?: string | null;
  smsSent?: boolean;
  bookingStepIndex?: number | null;
  bookingData?: Record<string, string>;
};

export async function upsertVoiceCallState(input: UpsertVoiceCallStateInput) {
  await pool.query(
    `
    INSERT INTO voice_call_state (
      call_sid,
      tenant_id,
      lang,
      turn,
      awaiting,
      pending_type,
      awaiting_number,
      alt_dest,
      sms_sent,
      booking_step_index,
      booking_data,
      updated_at
    )
    VALUES (
      $1, $2, $3, COALESCE($4, 0), COALESCE($5, false), $6,
      COALESCE($7, false), $8, COALESCE($9, false), $10,
      COALESCE($11, '{}'::jsonb), NOW()
    )
    ON CONFLICT (call_sid)
    DO UPDATE SET
      tenant_id = EXCLUDED.tenant_id,
      lang = EXCLUDED.lang,
      turn = EXCLUDED.turn,
      awaiting = EXCLUDED.awaiting,
      pending_type = EXCLUDED.pending_type,
      awaiting_number = EXCLUDED.awaiting_number,
      alt_dest = EXCLUDED.alt_dest,
      sms_sent = EXCLUDED.sms_sent,
      booking_step_index = EXCLUDED.booking_step_index,
      booking_data = EXCLUDED.booking_data,
      updated_at = NOW()
    `,
    [
      input.callSid,
      input.tenantId,
      input.lang ?? null,
      input.turn ?? 0,
      input.awaiting ?? false,
      input.pendingType ?? null,
      input.awaitingNumber ?? false,
      input.altDest ?? null,
      input.smsSent ?? false,
      input.bookingStepIndex ?? null,
      JSON.stringify(input.bookingData ?? {}),
    ]
  );
}