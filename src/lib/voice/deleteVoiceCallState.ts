//src/lib/voice/deleteVoiceCallState.ts
import pool from "../db";

export async function deleteVoiceCallState(callSid: string) {
  await pool.query(
    `DELETE FROM voice_call_state WHERE call_sid = $1`,
    [callSid]
  );
}