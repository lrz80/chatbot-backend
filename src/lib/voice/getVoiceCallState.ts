//src/lib/voice/getVoiceCallState.ts
import pool from "../db";

export type VoiceCallStateRow = {
  call_sid: string;
  tenant_id: string;
  lang: string | null;
  turn: number;
  awaiting: boolean;
  pending_type: "reservar" | "comprar" | "soporte" | "web" | null;
  awaiting_number: boolean;
  alt_dest: string | null;
  sms_sent: boolean;
  booking_step_index: number | null;
  booking_data: Record<string, string>;
};

export async function getVoiceCallState(callSid: string) {
  const { rows } = await pool.query(
    `
    SELECT
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
      booking_data
    FROM voice_call_state
    WHERE call_sid = $1
    LIMIT 1
    `,
    [callSid]
  );

  return (rows[0] as VoiceCallStateRow | undefined) || null;
}