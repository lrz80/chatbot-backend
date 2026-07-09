// src/lib/voice/realtime/voiceCallRecorder.ts
import pool from "../../db";

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

async function upsertVoiceContactFromCallStart(params: {
  tenantId: string;
  fromNumber: string | null;
  countCall: boolean;
}): Promise<void> {
  const tenantId = clean(params.tenantId);
  const phone = clean(params.fromNumber);

  if (!tenantId || !phone) {
    return;
  }

  try {
    await pool.query(
      `
      WITH updated AS (
        UPDATE contactos
        SET
          ultima_llamada = NOW(),
          primera_llamada = COALESCE(primera_llamada, NOW()),
          llamadas = llamadas + CASE WHEN $3::boolean THEN 1 ELSE 0 END,
          ultimo_canal = 'voice',
          origen = COALESCE(origen, 'voice')
        WHERE tenant_id = $1
          AND telefono = $2
        RETURNING id
      )
      INSERT INTO contactos (
        tenant_id,
        telefono,
        segmento,
        fecha_creacion,
        origen,
        ultimo_canal,
        primera_llamada,
        ultima_llamada,
        llamadas
      )
      SELECT
        $1,
        $2,
        'lead',
        NOW(),
        'voice',
        'voice',
        NOW(),
        NOW(),
        CASE WHEN $3::boolean THEN 1 ELSE 0 END
      WHERE NOT EXISTS (SELECT 1 FROM updated)
      `,
      [tenantId, phone, params.countCall]
    );

    console.log("[CONTACTOS][VOICE_CONTACT_UPSERTED]", {
      tenantId,
      phone,
      countCall: params.countCall,
    });
  } catch (error) {
    console.error("[CONTACTOS][VOICE_CONTACT_UPSERT_ERROR]", {
      tenantId,
      phone,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function recordVoiceCallStarted(params: {
  tenantId: string | null;
  callSid: string | null;
  fromNumber: string | null;
  toNumber: string | null;
}): Promise<void> {
  const tenantId = clean(params.tenantId);
  const callSid = clean(params.callSid);
  const fromNumber = clean(params.fromNumber) || null;
  const toNumber = clean(params.toNumber) || null;

  if (!tenantId || !callSid) {
    return;
  }

  try {
    const { rows } = await pool.query(
      `
      WITH updated AS (
        UPDATE voice_calls
        SET
          from_number = COALESCE($3, from_number),
          to_number = COALESCE($4, to_number),
          updated_at = NOW()
        WHERE tenant_id = $1
          AND call_sid = $2
        RETURNING id
      ),
      inserted AS (
        INSERT INTO voice_calls (
          tenant_id,
          call_sid,
          from_number,
          to_number,
          started_at,
          duration_sec,
          total_tokens,
          created_at,
          updated_at
        )
        SELECT
          $1,
          $2,
          $3,
          $4,
          NOW(),
          0,
          0,
          NOW(),
          NOW()
        WHERE NOT EXISTS (SELECT 1 FROM updated)
          AND NOT EXISTS (
            SELECT 1
            FROM voice_calls
            WHERE tenant_id = $1
              AND call_sid = $2
          )
        RETURNING id
      )
      SELECT EXISTS(SELECT 1 FROM inserted) AS inserted
      `,
      [tenantId, callSid, fromNumber, toNumber]
    );

    const inserted = rows[0]?.inserted === true;

    await upsertVoiceContactFromCallStart({
      tenantId,
      fromNumber,
      countCall: inserted,
    });

    console.log("[VOICE_CALLS][START_RECORDED]", {
      tenantId,
      callSid,
      fromNumber,
      toNumber,
      inserted,
    });
  } catch (error) {
    console.error("[VOICE_CALLS][START_RECORD_ERROR]", {
      tenantId,
      callSid,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function recordVoiceCallEnded(params: {
  tenantId: string | null;
  callSid: string | null;
  source: string;
}): Promise<void> {
  const tenantId = clean(params.tenantId);
  const callSid = clean(params.callSid);
  const source = clean(params.source);

  if (!callSid) {
    return;
  }

  try {
    const query = tenantId
      ? {
          text: `
            UPDATE voice_calls
            SET
              ended_at = COALESCE(ended_at, NOW()),
              duration_sec = CASE
                WHEN ended_at IS NULL THEN
                  GREATEST(
                    0,
                    FLOOR(EXTRACT(EPOCH FROM (NOW() - started_at)))::int
                  )
                ELSE duration_sec
              END,
              updated_at = NOW()
            WHERE tenant_id = $1
              AND call_sid = $2
            RETURNING id, duration_sec
          `,
          values: [tenantId, callSid],
        }
      : {
          text: `
            UPDATE voice_calls
            SET
              ended_at = COALESCE(ended_at, NOW()),
              duration_sec = CASE
                WHEN ended_at IS NULL THEN
                  GREATEST(
                    0,
                    FLOOR(EXTRACT(EPOCH FROM (NOW() - started_at)))::int
                  )
                ELSE duration_sec
              END,
              updated_at = NOW()
            WHERE call_sid = $1
            RETURNING id, duration_sec
          `,
          values: [callSid],
        };

    const { rows } = await pool.query(query.text, query.values);

    if (rows.length === 0) {
      console.warn("[VOICE_CALLS][END_RECORD_SKIPPED_NO_ROW]", {
        tenantId,
        callSid,
        source,
      });

      return;
    }

    console.log("[VOICE_CALLS][END_RECORDED]", {
      tenantId,
      callSid,
      source,
      durationSec: rows[0]?.duration_sec,
    });
  } catch (error) {
    console.error("[VOICE_CALLS][END_RECORD_ERROR]", {
      tenantId,
      callSid,
      source,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}