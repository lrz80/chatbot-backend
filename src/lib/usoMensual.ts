import pool from "./db"; // ajusta si estás en otra ruta

export async function obtenerUsoActual(tenantId: string, canal: string) {
  const res = await pool.query(
    `SELECT usados, limite FROM uso_mensual
     WHERE tenant_id = $1 AND canal = $2 AND mes = date_trunc('month', CURRENT_DATE)`,
    [tenantId, canal]
  );

  return res.rows[0] || { usados: 0, limite: canal === 'sms' ? 500 : 1000 }; // puedes ajustar límites por defecto
}
