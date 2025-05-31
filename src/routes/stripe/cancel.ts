import express from 'express';
import Stripe from 'stripe';
import pool from '../../lib/db';

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2022-11-15' });

router.post('/', async (req, res) => {
  try {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'No autorizado' });

    const { tenantId } = req.body;
    if (!tenantId) return res.status(400).json({ error: 'Falta tenantId' });

    // Obtener subscriptionId asociado al tenant
    const subscriptionResult = await pool.query(
      `SELECT subscription_id FROM tenants WHERE id = $1`,
      [tenantId]
    );
    const subscriptionId = subscriptionResult.rows[0]?.subscription_id;
    if (!subscriptionId) return res.status(404).json({ error: 'No se encontró la suscripción' });

    // Cancelar suscripción en Stripe
    await stripe.subscriptions.del(subscriptionId);
    console.log(`🛑 Suscripción cancelada en Stripe: ${subscriptionId}`);

    // Actualizar base de datos
    await pool.query(`
      UPDATE tenants
      SET membresia_activa = false, membresia_cancel_date = NOW()
      WHERE id = $1
    `, [tenantId]);

    await pool.query(`
      INSERT INTO uso_mensual (tenant_id, canal, mes, usados, limite)
      VALUES ($1, 'contactos', date_trunc('month', CURRENT_DATE), 0, 500)
      ON CONFLICT (tenant_id, canal, mes)
      DO UPDATE SET limite = 500
    `, [tenantId]);

    res.json({ success: true, message: 'Membresía cancelada exitosamente' });
  } catch (error) {
    console.error('❌ Error al cancelar membresía:', error);
    res.status(500).json({ error: 'Error al cancelar membresía' });
  }
});

export default router;
