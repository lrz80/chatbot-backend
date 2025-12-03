// src/lib/incrementUsage.ts

import pool from './db';
import { getLimitesPorPlan } from './usageLimits';  // 👈 importamos límites

export async function incrementarUsoPorNumero(
  numero: string,
  canal: string = 'whatsapp'
) {
  try {
    const tenantRes = await pool.query(
      `SELECT id, plan FROM tenants
       WHERE twilio_number = $1 OR twilio_sms_number = $1 OR twilio_voice_number = $1
       LIMIT 1`,
      [numero]
    );

    const tenant = tenantRes.rows[0];
    const tenantId = tenant?.id;

    if (!tenantId) return;

    // 🔢 Límites según plan
    const limites = getLimitesPorPlan(tenant?.plan);
    const canalNormalizado =
      canal === 'facebook' || canal === 'instagram' ? 'meta' : canal;

    const limiteBase = (limites as any)[canalNormalizado] ?? 0;

    await pool.query(
      `INSERT INTO uso_mensual (tenant_id, canal, mes, usados, limite)
       VALUES ($1, $2, date_trunc('month', CURRENT_DATE), 1, $3)
       ON CONFLICT (tenant_id, canal, mes)
       DO UPDATE SET usados = uso_mensual.usados + 1`,
      [tenantId, canal, limiteBase]
    );

  } catch (error) {
    console.error('❌ Error al incrementar uso mensual:', error);
  }
}
