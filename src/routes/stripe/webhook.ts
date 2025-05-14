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
    stripe = new Stripe(key, { apiVersion: '2025-03-31.basil' });
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

  // ✅ Activación inicial por checkout
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const email = session.customer_email;

    // 📦 Créditos por canal (pago único)
    if (
      session.mode === 'payment' &&
      session.metadata?.tenant_id &&
      session.metadata?.canal &&
      session.metadata?.cantidad
    ) {
      const { tenant_id, canal, cantidad } = session.metadata;
      const cantidadInt = parseInt(cantidad, 10);
    
      try {
        if (canal === "contactos") {
          // 👤 Sumar contactos directamente en la tabla tenants
          await pool.query(`
            UPDATE tenants
            SET limite_contactos = COALESCE(limite_contactos, 500) + $1
            WHERE id = $2
          `, [cantidadInt, tenant_id]);
    
          console.log(`✅ Contactos agregados: +${cantidadInt} para tenant ${tenant_id}`);
    
          if (email) {
            await transporter.sendMail({
              from: `"Amy AI" <${process.env.EMAIL_FROM}>`,
              to: email,
              subject: `Contactos adicionales activados`,
              html: `
                <h3>¡Contactos adicionales agregados!</h3>
                <p>Hola,</p>
                <p>Tu compra de <strong>${cantidadInt}</strong> contactos fue procesada exitosamente.</p>
                <p>Ya puedes usar más contactos desde tu dashboard.</p>
                <br />
                <p>Gracias por confiar en <strong>Amy AI</strong> 💜</p>
              `
            });
          }
    
        } else if (["sms", "email", "whatsapp"].includes(canal)) {
          // 💬 Créditos de uso mensual
          await pool.query(`
            INSERT INTO uso_mensual (tenant_id, canal, mes, usados, limite)
            VALUES ($1, $2, date_trunc('month', CURRENT_DATE), 0, $3)
            ON CONFLICT (tenant_id, canal, mes)
            DO UPDATE SET limite = uso_mensual.limite + $3
          `, [tenant_id, canal, cantidadInt]);
    
          console.log(`✅ Créditos agregados: +${cantidadInt} a ${canal.toUpperCase()} para tenant ${tenant_id}`);
    
          if (email) {
            await transporter.sendMail({
              from: `"Amy AI" <${process.env.EMAIL_FROM}>`,
              to: email,
              subject: `Créditos ${canal.toUpperCase()} activados`,
              html: `
                <h3>¡Créditos ${canal.toUpperCase()} agregados!</h3>
                <p>Hola,</p>
                <p>Tu compra de <strong>${cantidadInt}</strong> créditos de <strong>${canal.toUpperCase()}</strong> fue procesada exitosamente.</p>
                <p>Ya puedes usarlos desde tu dashboard.</p>
                <br />
                <p>Gracias por confiar en <strong>Amy AI</strong> 💜</p>
              `
            });
          }
        }
      } catch (error) {
        console.error('❌ Error al agregar créditos o contactos comprados:', error);
      }
    
      return res.status(200).json({ received: true });
    }    

    // 🧾 Membresía por suscripción
    if (email) {
      try {
        const userRes = await pool.query('SELECT uid, owner_name FROM users WHERE email = $1', [email]);
        const user = userRes.rows[0];
        if (!user) return;

        const uid = user.uid;
        const tenantName = user.owner_name || 'Negocio sin nombre';
        const vigencia = new Date();
        vigencia.setDate(vigencia.getDate() + 30);

        const tenantCheck = await pool.query('SELECT * FROM tenants WHERE admin_uid = $1', [uid]);

        if (tenantCheck.rows.length === 0) {
          await pool.query(`
            INSERT INTO tenants (admin_uid, name, membresia_activa, membresia_vigencia, used, plan)
            VALUES ($1, $2, true, $3, 0, 'pro')
          `, [uid, tenantName, vigencia]);
          console.log('✅ Tenant creado con membresía activa para', email);
        } else {
          await pool.query(`
            UPDATE tenants
            SET membresia_activa = true,
                membresia_vigencia = $2
            WHERE admin_uid = $1
          `, [uid, vigencia]);
          console.log('🔁 Membresía activada para', email);
        }
      } catch (error) {
        console.error('❌ Error activando membresía:', error);
      }
    }
  }

  // 🔁 Renovación automática de membresía
  if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object as Stripe.Invoice;
    const customerEmail = invoice.customer_email;
    if (!customerEmail) return;

    try {
      const userRes = await pool.query('SELECT uid FROM users WHERE email = $1', [customerEmail]);
      const user = userRes.rows[0];
      if (!user) return;

      const nuevaVigencia = new Date();
      nuevaVigencia.setDate(nuevaVigencia.getDate() + 30);

      await pool.query(`
        UPDATE tenants
        SET membresia_activa = true,
            membresia_vigencia = $2
        WHERE admin_uid = $1
      `, [user.uid, nuevaVigencia]);

      console.log('🔁 Membresía renovada para', customerEmail);
    } catch (error) {
      console.error('❌ Error renovando membresía:', error);
    }
  }

  // ❌ Cancelación automática
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
      const userRes = await pool.query('SELECT uid FROM users WHERE email = $1', [customerEmail]);
      const user = userRes.rows[0];
      if (!user) return;

      await pool.query(`
        UPDATE tenants
        SET membresia_activa = false
        WHERE admin_uid = $1
      `, [user.uid]);

      console.log('🛑 Membresía cancelada para', customerEmail);

      await transporter.sendMail({
        from: `"Amy AI" <${process.env.EMAIL_FROM}>`,
        to: customerEmail,
        subject: 'Tu membresía ha sido cancelada',
        html: `
          <h3>Tu membresía en Amy AI ha sido cancelada</h3>
          <p>Hola,</p>
          <p>Hemos cancelado tu membresía en <strong>Amy AI</strong>. Ya no tendrás acceso a las funciones del asistente.</p>
          <p>Si deseas reactivarla, puedes hacerlo desde tu <a href="https://www.aamy.ai/upgrade">panel de usuario</a>.</p>
          <br />
          <p>Gracias por haber sido parte de Amy AI 💜</p>
        `
      });
    } catch (err) {
      console.error('❌ Error al cancelar membresía:', err);
    }
  }

  res.status(200).json({ received: true });
});

export default router;
