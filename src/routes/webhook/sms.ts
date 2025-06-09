import { Router, Request, Response } from 'express';
import pool from '../../lib/db';
import { incrementarUsoPorNumero } from '../../lib/incrementUsage';

const router = Router();

// 🔧 Función para normalizar números al formato E.164
function normalizarNumero(numero: string): string {
  const limpio = numero.replace(/\D/g, '');
  if (limpio.length === 10) return `+1${limpio}`; // EE.UU.
  if (limpio.length > 10 && limpio.startsWith('1')) return `+${limpio}`;
  return `+${limpio}`;
}

router.post('/', async (req: Request, res: Response) => {
  const from = req.body.From || '';
  const to = req.body.To || '';
  const userInput = req.body.Body || '';

  const fromNumber = normalizarNumero(from.replace('tel:', ''));
  const toNumber = normalizarNumero(to.replace('tel:', ''));

  try {
    const tenantRes = await pool.query(
      'SELECT * FROM tenants WHERE twilio_sms_number = $1',
      [toNumber]
    );
    const tenant = tenantRes.rows[0];
    if (!tenant) return res.sendStatus(404);

    if (!tenant.membresia_activa) {
      console.log(`🚫 SMS bloqueado: membresía inactiva para ${tenant.name}`);
      return res.type('text/xml').send(`<Response><Message>Tu membresía está inactiva. Por favor actívala para continuar.</Message></Response>`);
    }    

    console.log(`📩 SMS recibido de ${fromNumber} para tenant ${tenant.name}`);

    // 💾 Guardar mensaje del usuario
    await pool.query(
      `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number)
       VALUES ($1, 'user', $2, NOW(), 'sms', $3)`,
      [tenant.id, userInput, fromNumber]
    );

    // 📊 Guardar interacción en tabla de estadísticas
    await pool.query(
      `INSERT INTO interactions (tenant_id, canal, created_at)
       VALUES ($1, 'sms', NOW())`,
      [tenant.id]
    );

    // 🔢 Incrementar uso
    await incrementarUsoPorNumero(toNumber);

    // 📩 Respuesta de confirmación a Twilio
    res.type('text/xml');
    res.send(`<Response><Message>Recibido por SMS ✅</Message></Response>`);
  } catch (err) {
    console.error('❌ Error SMS Webhook:', err);
    res.sendStatus(500);
  }
});

export default router;
