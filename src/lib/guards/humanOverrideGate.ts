// backend/src/lib/guards/humanOverrideGate.ts
import type { TurnEvent } from "../conversation/stateMachine";
import type { GateResult } from "../conversation/stateMachine";

/**
 * Reglas:
 * - Si human_override está activo:
 *    - si expiró human_override_until -> lo apaga y deja continuar
 *    - si el user escribe "volver al bot"/"no gracias"/etc -> lo apaga y deja continuar
 *    - si NO -> "silence" (no responde el bot)
 *
 * Nota: NO hardcodea negocios. Solo estado.
 */

function normalize(s: string) {
  return String(s || "").trim().toLowerCase();
}

function wantsDisableHumanOverride(text: string) {
  const t = normalize(text);

  // Frases simples y seguras (puedes ampliar luego)
  return /^(volver al bot|reactivar bot|reactivar|automatico|automático|resume|seguir|continua|continuar|no gracias|cancelar|ya no|stop|parar)$/i.test(
    t
  );
}

async function clearHumanOverrideDB(opts: {
  pool: any;
  tenantId: string;
  canal: string;
  contacto: string;
}) {
  const { pool, tenantId, canal, contacto } = opts;

  await pool.query(
    `UPDATE clientes
        SET human_override = false,
            human_override_until = NULL,
            updated_at = NOW()
      WHERE tenant_id = $1 AND canal = $2 AND contacto = $3`,
    [tenantId, canal, contacto]
  );

  // Best-effort: limpia señales de ctx si existen
  try {
    await pool.query(
      `UPDATE conversation_state
          SET context = COALESCE(context,'{}'::jsonb)
                        - 'human_handoff'
                        - 'handoff_reason'
                        - 'needs_clarify'
                        - 'ready_to_close',
              updated_at = NOW()
        WHERE tenant_id = $1 AND canal = $2 AND sender_id = $3`,
      [tenantId, canal, contacto]
    );
  } catch {
    // No bloqueamos si no existe o no aplica
  }
}

async function getHumanOverrideRow(opts: {
  pool: any;
  tenantId: string;
  canal: string;
  contacto: string;
}) {
  const { pool, tenantId, canal, contacto } = opts;

  const { rows } = await pool.query(
    `SELECT human_override, human_override_until
       FROM clientes
      WHERE tenant_id = $1 AND canal = $2 AND contacto = $3
      LIMIT 1`,
    [tenantId, canal, contacto]
  );

  const ho = rows[0]?.human_override === true;

  const untilMs = rows[0]?.human_override_until
    ? Date.parse(rows[0].human_override_until)
    : NaN;

  return { ho, untilMs };
}

export async function humanOverrideGate(event: TurnEvent): Promise<GateResult> {
  const { pool, tenantId, canal, senderId, userInput } = event as any;

  // Lee estado actual
  let row: { ho: boolean; untilMs: number };
  try {
    row = await getHumanOverrideRow({
      pool,
      tenantId,
      canal,
      contacto: senderId,
    });
  } catch {
    // Si no podemos leer clientes, no bloqueamos el pipeline
    return { action: "continue" };
  }

  if (!row.ho) return { action: "continue" };

  // 1) Expiró -> auto-clear y continuar
  if (Number.isFinite(row.untilMs) && Date.now() > row.untilMs) {
    await clearHumanOverrideDB({
      pool,
      tenantId,
      canal,
      contacto: senderId,
    });
    return { action: "continue" };
  }

  // 2) El usuario pidió volver al bot -> clear y continuar
  if (wantsDisableHumanOverride(userInput)) {
    await clearHumanOverrideDB({
      pool,
      tenantId,
      canal,
      contacto: senderId,
    });
    return { action: "continue" };
  }

  // 3) Sigue override -> silencio
  return { action: "silence", reason: "human_override" } as any;
}
