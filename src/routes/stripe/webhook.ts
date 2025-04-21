import express from 'express';
import Stripe from 'stripe';
import pool from '../../lib/db';
import { transporter } from '../../lib/mailer'; // si quieres enviar email al cancelar
import bodyParser from 'body-parser';

const router = express.Router();

// ⚠️ SOLO este endpoint usa raw body
router.post('/', async (req, res) => {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: '2025-03-31.basil',
    });
  
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
    const sig = req.headers['stripe-signature'];
  
    if (!endpointSecret) {
      console.error('❌ Falta STRIPE_WEBHOOK_SECRET en .env');
      return res.status(500).json({ error: 'Configuración incompleta' });
    }
  
    let event: Stripe.Event;
  
    try {
      event = stripe.webhooks.constructEvent(req.body, sig!, endpointSecret);
    } catch (err) {
      console.error('⚠️ Webhook error:', err);
      return res.status(400).send(`Webhook Error: ${(err as Error).message}`);
    }
  
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      const email = session.customer_email;
  
      try {
        const userResult = await pool.query('SELECT uid FROM users WHERE email = $1', [email]);
        const user = userResult.rows[0];
        if (!user) return;
  
        const uid = user.uid;
        const vigencia = new Date();
        vigencia.setDate(vigencia.getDate() + 30);
  
        const tenantCheck = await pool.query('SELECT * FROM tenants WHERE uid = $1', [uid]);
  
        if (tenantCheck.rows.length === 0) {
          await pool.query(
            `INSERT INTO tenants (uid, membresia_activa, membresia_vigencia, used, plan)
             VALUES ($1, true, $2, 0, 'pro')`,
            [uid, vigencia]
          );
        } else {
          await pool.query(
            `UPDATE tenants
             SET membresia_activa = true,
                 membresia_vigencia = $2
             WHERE uid = $1`,
            [uid, vigencia]
          );
        }
  
        console.log('✅ Membresía activada para', email);
      } catch (error) {
        console.error('❌ Error activando membresía:', error);
      }
    }

  // ✅ Activación inicial por checkout
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const email = session.customer_email;

    try {
      const userResult = await pool.query('SELECT uid FROM users WHERE email = $1', [email]);
      const user = userResult.rows[0];

      if (!user) return;

      const uid = user.uid;
      const vigencia = new Date();
      vigencia.setDate(vigencia.getDate() + 30);

      const tenantCheck = await pool.query('SELECT * FROM tenants WHERE uid = $1', [uid]);

      if (tenantCheck.rows.length === 0) {
        await pool.query(`
          INSERT INTO tenants (uid, membresia_activa, membresia_vigencia, used, plan)
          VALUES ($1, true, $2, 0, 'pro')
        `, [uid, vigencia]);
      } else {
        await pool.query(`
          UPDATE tenants
          SET membresia_activa = true,
              membresia_vigencia = $2
          WHERE uid = $1
        `, [uid, vigencia]);
      }

      console.log('✅ Membresía activada para', email);
    } catch (error) {
      console.error('❌ Error activando membresía:', error);
    }
  }

  // 🔁 Renovación mensual automática
  if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object as Stripe.Invoice;
    let customerEmail = invoice.customer_email;

    if (
      !customerEmail &&
      invoice.customer &&
      typeof invoice.customer === 'object' &&
      'email' in invoice.customer
    ) {
      customerEmail = (invoice.customer as Stripe.Customer).email!;
    }

    if (!customerEmail) return;

    try {
      const userResult = await pool.query('SELECT uid FROM users WHERE email = $1', [customerEmail]);
      const user = userResult.rows[0];
      if (!user) return;

      const uid = user.uid;
      const nuevaVigencia = new Date();
      nuevaVigencia.setDate(nuevaVigencia.getDate() + 30);

      await pool.query(`
        UPDATE tenants
        SET membresia_activa = true,
            membresia_vigencia = $2
        WHERE uid = $1
      `, [uid, nuevaVigencia]);

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
      console.warn('⚠️ No se pudo obtener email del cliente para cancelación');
    }

    if (!customerEmail) return;

    try {
      const userResult = await pool.query('SELECT uid FROM users WHERE email = $1', [customerEmail]);
      const user = userResult.rows[0];
      if (!user) return;

      const uid = user.uid;

      await pool.query(`
        UPDATE tenants
        SET membresia_activa = false
        WHERE uid = $1
      `, [uid]);

      console.log('🛑 Membresía cancelada para', customerEmail);

      // ✉️ Enviar email al cliente
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
      console.error('❌ Error desactivando membresía:', err);
    }
  }

  res.status(200).json({ received: true });
});

export default router;
