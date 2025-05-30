// src/routes/stripe/webhook.ts

import express from 'express';
import Stripe from 'stripe';
import pool from '../../lib/db';
import { transporter } from '../../lib/mailer';

const router = express.Router();

let stripe: Stripe;
let STRIPE_WEBHOOK_SECRET: string;

function initStripe() {
  if (!stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('❌ STRIPE_SECRET_KEY no está definida.');
    STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;
    if (!STRIPE_WEBHOOK_SECRET) throw new Error('❌ STRIPE_WEBHOOK_SECRET no está definida.');
    stripe = new Stripe(key, { apiVersion: '2022-11-15' }); // más segura
  }
}

router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  initStripe();
  const sig = req.headers['stripe-signature'];
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig!, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('⚠️ Webhook signature error:', err);
    return res.status(400).send(`Webhook Error: ${(err as Error).message}`);
  }

  // ✅ Créditos individuales por canal
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const email = session.customer_email;

    if (
      session.mode === 'payment' &&
      session.metadata?.tenant_id &&
      session.metadata?.canal &&
      session.metadata?.cantidad
    ) {
      const { tenant_id, canal, cantidad } = session.metadata;
      const cantidadInt = parseInt(cantidad, 10);
      const canalesPermitidos = ["sms", "email", "whatsapp", "contactos", "tokens_openai", "voz", "meta", "followup"];
      if (!canalesPermitidos.includes(canal)) return;

      try {
        await pool.query(`
          INSERT INTO uso_mensual (tenant_id, canal, mes, usados, limite)
          VALUES ($1, $2, date_trunc('month', CURRENT_DATE), 0, $3)
          ON CONFLICT (tenant_id, canal, mes)
          DO UPDATE SET limite = uso_mensual.limite + $3
        `, [tenant_id, canal, cantidadInt]);

        console.log(`✅ Créditos agregados: +${cantidadInt} a ${canal.toUpperCase()} para tenant ${tenant_id}`);

        if (email) {
          // 🔍 Obtenemos el nombre del tenant para personalizar el saludo
          const tenantNameRes = await pool.query(
            `SELECT name FROM tenants WHERE id = $1`,
            [tenant_id]
          );
          const tenantName = tenantNameRes.rows[0]?.name || "Usuario";
        
          await transporter.sendMail({
            from: `"Amy AI" <${process.env.EMAIL_FROM}>`,
            to: email,
            subject: `Créditos ${canal.toUpperCase()} activados`,
            html: `
              <div style="text-align: center;">
                <img src="https://aamy.ai/avatar-amy.png" alt="Amy AI Avatar" style="width: 100px; height: 100px; border-radius: 50%;" />
                <h3>Hola ${tenantName} 👋</h3>
                <p>¡Créditos de <strong>${canal.toUpperCase()}</strong> agregados!</p>
                <p>Tu compra de <strong>${cantidadInt}</strong> créditos de <strong>${canal.toUpperCase()}</strong> fue procesada exitosamente.</p>
                <p>Ya puedes usarlos desde tu dashboard.</p>
                <br />
                <p>Gracias por confiar en <strong>Amy AI</strong> 💜</p>
              </div>
            `
          });
        }
        
      } catch (error) {
        console.error('❌ Error al agregar créditos comprados:', error);
      }

      return res.status(200).json({ received: true });
    }

    // 🧾 Activación de membresía por suscripción
    if (email && session.subscription) {
      try {
        const userRes = await pool.query('SELECT uid FROM users WHERE email = $1', [email]);
        const user = userRes.rows[0];
        if (!user) return;

        const subscriptionId = session.subscription as string;
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);

        const vigencia = subscription.current_period_end
          ? new Date(subscription.current_period_end * 1000)
          : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // fallback

          await pool.query(`
            UPDATE tenants
            SET membresia_activa = true,
                membresia_vigencia = $2,
                membresia_inicio = COALESCE(membresia_inicio, NOW()),  -- ✅ Solo si está NULL
                plan = 'pro'
            WHERE id = $1
          `, [user.uid, vigencia]);
          
        console.log(`🔁 Membresía activada para ${email}, vigencia hasta ${vigencia.toISOString()}`);
      } catch (error) {
        console.error('❌ Error activando membresía:', error);
      }
    }
  }

  // 🔁 Renovación automática de membresía
  if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object as Stripe.Invoice;
    let customerEmail = invoice.customer_email;

    // 🔍 Si no viene el email, intenta obtenerlo con customerId
    if (!customerEmail) {
      const customerId = invoice.customer;
      if (typeof customerId === 'string') {
        try {
          const customer = await stripe.customers.retrieve(customerId);
          if (typeof customer !== 'string' && 'email' in customer && customer.email) {
            customerEmail = customer.email;
            console.log('📧 Email recuperado del customerId:', customerEmail);
          }
        } catch (err) {
          console.warn('⚠️ No se pudo obtener email del cliente:', err);
        }
      }
    }

    if (!customerEmail) {
      console.warn('⚠️ No se pudo obtener email del invoice ni del customerId.');
      return res.status(200).json({ received: true });
    }

    const subscriptionId = typeof invoice.subscription === 'string' ? invoice.subscription : null;
    if (!subscriptionId) {
      console.warn('⚠️ Subscription ID no encontrado en invoice.');
      return res.status(200).json({ received: true });
    }

    try {
      console.log('📄 Invoice recibido:', JSON.stringify(invoice, null, 2));
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);

      const nuevaVigencia = subscription.current_period_end
        ? new Date(subscription.current_period_end * 1000)
        : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // fallback

      const userRes = await pool.query('SELECT uid FROM users WHERE email = $1', [customerEmail]);
      const user = userRes.rows[0];
      if (!user) return;

      await pool.query(`
        UPDATE tenants
        SET membresia_activa = true,
            membresia_vigencia = $2,
            membresia_inicio = COALESCE(membresia_inicio, NOW()),
            plan = 'pro'
        WHERE id = $1
      `, [user.uid, nuevaVigencia]);

      console.log('🔁 Membresía renovada para', customerEmail);
    } catch (error) {
      console.error('❌ Error renovando membresía:', error);
    }
}

  // ❌ Cancelación de suscripción
  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object as Stripe.Subscription;

    let customerEmail: string | null = null;

    try {
      const customerId = subscription.customer;
      if (typeof customerId === 'string') {
        const customer = await stripe.customers.retrieve(customerId);
        if (typeof customer !== 'string' && 'email' in customer && customer.email) {
          customerEmail = customer.email;
        }
      }
    } catch (err) {
      console.warn('⚠️ No se pudo obtener email del cliente:', err);
    }

    if (!customerEmail) return;

    try {
      const userRes = await pool.query('SELECT uid, tenant_id FROM users WHERE email = $1', [customerEmail]);
      const user = userRes.rows[0];
      if (!user) return;

      await pool.query(`
        UPDATE tenants
        SET membresia_activa = false
        WHERE id = $1
      `, [user.uid]);

      await pool.query(`
        INSERT INTO uso_mensual (tenant_id, canal, mes, usados, limite)
        VALUES ($1, 'contactos', date_trunc('month', CURRENT_DATE), 0, 500)
        ON CONFLICT (tenant_id, canal, mes)
        DO UPDATE SET limite = 500
      `, [user.tenant_id]);

      console.log('🛑 Suscripción cancelada y contactos reiniciados para', customerEmail);

      await transporter.sendMail({
        from: `"Amy AI" <${process.env.EMAIL_FROM}>`,
        to: customerEmail,
        subject: 'Suscripción cancelada',
        html: `
          <div style="text-align: center;">
            <img src="https://aamy.ai/avatar-amy.png" alt="Amy AI Avatar" style="width: 100px; height: 100px; border-radius: 50%;" />
            <h3>Hola ${user.tenant_id ? (await pool.query('SELECT name FROM tenants WHERE id = $1', [user.tenant_id])).rows[0]?.name || 'Usuario' : 'Usuario'} 👋</h3>
            <p>Tu suscripción ha sido cancelada en <strong>Amy AI</strong>.</p>
            <p>Tu límite de contactos ha sido reiniciado a 500.</p>
            <br />
            <p>Gracias por haber sido parte de <strong>Amy AI</strong> 💜</p>
          </div>
        `
      });
      
    } catch (err) {
      console.error('❌ Error al cancelar membresía:', err);
    }
  }

  res.status(200).json({ received: true });
});

export default router;
