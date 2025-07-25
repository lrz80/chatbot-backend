import express from 'express';
import Stripe from 'stripe';
import pool from '../../lib/db';
import { sendCancelationEmail } from '../../lib/mailer';

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2022-11-15' });

const resetearCanales = async (tenantId: string) => {
  const canales = ['contactos', 'whatsapp', 'sms', 'email', 'voz', 'meta', 'followup', 'tokens_openai'];
  for (const canal of canales) {
    await pool.query(`
      INSERT INTO uso_mensual (tenant_id, canal, mes, usados, limite)
      VALUES ($1, $2, date_trunc('month', CURRENT_DATE), 0, 500)
      ON CONFLICT (tenant_id, canal, mes)
      DO UPDATE SET usados = 0, limite = 500
    `, [tenantId, canal]);
  }
};

router.post('/', async (req, res) => {
  try {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'No autorizado' });

    const { tenantId } = req.body;
    if (!tenantId) return res.status(400).json({ error: 'Falta tenantId' });

    const subscriptionResult = await pool.query(
      `SELECT subscription_id, name FROM tenants WHERE id = $1`,
      [tenantId]
    );
    const subscriptionId = subscriptionResult.rows[0]?.subscription_id;
    const tenantName = subscriptionResult.rows[0]?.name || 'Usuario';
    if (!subscriptionId) return res.status(404).json({ error: 'No se encontró la suscripción' });

    try {
      await stripe.subscriptions.del(subscriptionId);
      console.log(`🛑 Suscripción cancelada en Stripe: ${subscriptionId}`);
    } catch (error: any) {
      if (error?.raw?.code === 'resource_missing') {
        console.warn(`⚠️ Suscripción ya estaba cancelada en Stripe: ${subscriptionId}`);
      } else {
        console.error('❌ Error cancelando en Stripe:', error);
        return res.status(500).json({ error: 'Error cancelando en Stripe' });
      }
    }

    // 🔄 Actualizar plan, es_trial, y membresia
    await pool.query(`
      UPDATE tenants
      SET membresia_activa = false, plan = NULL, es_trial = false, membresia_cancel_date = NOW()
      WHERE id = $1
    `, [tenantId]);

    await resetearCanales(tenantId);
    console.log(`🔄 Límites y uso mensual reiniciados para todos los canales del tenant ${tenantId}`);

    // 🔥 Enviar correo de cancelación
    const userRes = await pool.query(`SELECT email FROM users WHERE tenant_id = $1 LIMIT 1`, [tenantId]);
    const customerEmail = userRes.rows[0]?.email;
    if (customerEmail) {
      await sendCancelationEmail(customerEmail, tenantName);
      console.log('📧 Correo de cancelación enviado a', customerEmail);
    }

    return res.json({ success: true, message: 'Membresía cancelada exitosamente' });
  } catch (error) {
    console.error('❌ Error al cancelar membresía:', error);
    return res.status(500).json({ error: 'Error al cancelar membresía' });
  }
});

export default router;
