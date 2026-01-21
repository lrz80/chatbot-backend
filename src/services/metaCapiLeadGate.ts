import pool from "../lib/db";

export async function shouldSendCapiEvent30d(opts: {
  tenantId: string;
  canal: string;      // "whatsapp"
  contacto: string;   // contactoNorm
  eventName: string;  // "Lead"
  windowDays?: number; // default 30
}): Promise<boolean> {
  const { tenantId, canal, contacto, eventName, windowDays = 30 } = opts;

  // 1) Si nunca se envió → TRUE
  const { rows } = await pool.query(
    `SELECT last_sent_at
       FROM meta_capi_events_sent
      WHERE tenant_id=$1 AND canal=$2 AND contacto=$3 AND event_name=$4
      LIMIT 1`,
    [tenantId, canal, contacto, eventName]
  );

  if (!rows.length) return true;

  // 2) Si han pasado >= windowDays → TRUE
  const last = new Date(rows[0].last_sent_at).getTime();
  const now = Date.now();
  const diffDays = (now - last) / (1000 * 60 * 60 * 24);

  return diffDays >= windowDays;
}

export async function markCapiEventSent(opts: {
  tenantId: string;
  canal: string;
  contacto: string;
  eventName: string;
}): Promise<void> {
  const { tenantId, canal, contacto, eventName } = opts;

  await pool.query(
    `INSERT INTO meta_capi_events_sent (tenant_id, canal, contacto, event_name, last_sent_at)
     VALUES ($1,$2,$3,$4, NOW())
     ON CONFLICT (tenant_id, canal, contacto, event_name)
     DO UPDATE SET last_sent_at = NOW()`,
    [tenantId, canal, contacto, eventName]
  );
}
