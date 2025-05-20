// src/lib/incrementUsage.ts

import pool from './db';

export async function incrementarUsoPorNumero(numero: string, canal: string = 'whatsapp') {
  try {
    const tenantRes = await pool.query(
      `SELECT id FROM tenants
       WHERE twilio_number = $1 OR twilio_sms_number = $1 OR twilio_voice_number = $1
       LIMIT 1`,
      [numero]
    );

    const tenantId = tenantRes.rows[0]?.id;
    if (!tenantId) return;

    await pool.query(
      `INSERT INTO uso_mensual (tenant_id, canal, mes, usados, limite)
       VALUES ($1, $2, date_trunc('month', CURRENT_DATE), 1, 500)
       ON CONFLICT (tenant_id, canal, mes)
       DO UPDATE SET usados = uso_mensual.usados + 1`,
      [tenantId, canal]
    );

  } catch (error) {
    console.error('❌ Error al incrementar uso mensual:', error);
  }
}
