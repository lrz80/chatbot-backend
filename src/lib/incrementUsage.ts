// src/lib/incrementUsage.ts

import pool from './db';
import { cycleStartForNow } from '../utils/billingCycle';

// 👇 ya existirá algo como esto
// export async function incrementarUsoPorNumero(...) { ... }

// ✅ NUEVO: sumar 1 al uso_mensual por canal (whatsapp, facebook, instagram, etc.)
export async function incrementarUsoPorCanal(
  tenantId: string,
  canal: string
) {
  try {
    const { rows } = await pool.query(
      `SELECT membresia_inicio
         FROM tenants
        WHERE id = $1`,
      [tenantId]
    );

    const membresiaInicio = rows[0]?.membresia_inicio;
    if (!membresiaInicio) return;

    const cicloMes = cycleStartForNow(membresiaInicio);

    await pool.query(
      `INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
       VALUES ($1, $2, $3, 1)
       ON CONFLICT (tenant_id, canal, mes)
       DO UPDATE SET usados = uso_mensual.usados + 1`,
      [tenantId, canal, cicloMes]
    );
  } catch (e) {
    console.error('❌ Error incrementando uso_mensual por canal:', e);
  }
}

export async function incrementarUsoPorNumero(
  numero: string,
  canal: string = 'whatsapp'
) {
  try {
    const tenantRes = await pool.query(
      `SELECT id, membresia_inicio, plan_limits
        FROM tenants
        WHERE twilio_number = $1 OR twilio_sms_number = $1 OR twilio_voice_number = $1
        LIMIT 1`,
      [numero]
    );

    const tenant = tenantRes.rows[0];
    const tenantId = tenant?.id;

    const membresiaInicio = tenant?.membresia_inicio;
    if (!membresiaInicio) return;

    const cicloMes = cycleStartForNow(membresiaInicio);

    const canalNormalizado =
      canal === 'facebook' || canal === 'instagram' ? 'meta' : canal;

    // ✅ límite base desde plan_limits (jsonb)
    // si no existe o no es número, cae a 0
    const planLimits = (tenant?.plan_limits || {}) as Record<string, any>;
    const limiteBase = Number(planLimits?.[canalNormalizado] ?? 0) || 0;

    if (!tenantId) return;

    await pool.query(
      `
      INSERT INTO uso_mensual (tenant_id, canal, mes, usados, limite)
      VALUES ($1, $2, $3::date, 1, $4)
      ON CONFLICT (tenant_id, canal, mes)
      DO UPDATE SET
        usados = uso_mensual.usados + 1,
        limite = EXCLUDED.limite
      `,
      [tenantId, canalNormalizado, cicloMes, limiteBase]
    );

  } catch (error) {
    console.error('❌ Error al incrementar uso mensual:', error);
  }
}
