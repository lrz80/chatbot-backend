import pool from './db';

export async function incrementarUsoPorNumero(numero: string) {
  try {
    await pool.query(
      `UPDATE tenants
       SET used = COALESCE(used, 0) + 1
       WHERE twilio_number = $1 OR twilio_sms_number = $1 OR twilio_voice_number = $1`,
      [numero]
    );
  } catch (error) {
    console.error('❌ Error al incrementar uso:', error);
  }
}

