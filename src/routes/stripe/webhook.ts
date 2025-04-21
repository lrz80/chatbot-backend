import express from 'express';
import Stripe from 'stripe';
import pool from '../../lib/db';
import bodyParser from 'body-parser';
import { sendCancelationEmail, sendRenewalSuccessEmail } from '../../lib/mailer';

const router = express.Router();

// ⚠️ RAW BODY solo para Stripe
router.post('/webhook', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET!;
  const sig = req.headers['stripe-signature'];

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig!, endpointSecret);
  } catch (err) {
    console.error('⚠️ Webhook error:', err);
    return res.status(400).send(`Webhook Error: ${(err as Error).message}`);
  }

  // ✅ Activación inicial tras pago exitoso
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const email = session.customer_email;

    console.log('✅ Pago exitoso recibido de:', email);

    try {
      const userResult = await pool.query('SELECT uid FROM users WHERE email = $1', [email]);
      const user = userResult.rows[0];
      if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

      const uid = user.uid;
      const vigencia = new Date();
      vigencia.setDate(vigencia.getDate() + 30);

      const tenantResult = await pool.query('SELECT * FROM tenants WHERE uid = $1', [uid]);

      if (tenantResult.rows.length === 0) {
        await pool.query(`
          INSERT INTO tenants (uid, membresia_activa, membresia_vigencia, used, plan)
          VALUES ($1, true, $2, 0, 'pro')
        `, [uid, vigencia]);
        console.log('✅ Tenant creado con membresía activa para:', email);
      } else {
        await pool.query(`
          UPDATE tenants
          SET membresia_activa = true,
              membresia_vigencia = $2
          WHERE uid = $1
        `, [uid, vigencia]);
        console.log('🎉 Membresía activada correctamente para:', email);
      }
    } catch (err) {
      console.error('❌ Error activando membresía:', err);
    }
  }

  // ✅ Renovación automática mensual
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

    if (!customerEmail) return res.status(400).json({ error: 'Email no disponible' });

    try {
      const userResult = await pool.query('SELECT uid, idioma FROM users WHERE email = $1', [customerEmail]);
      const user = userResult.rows[0];
      if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

      const uid = user.uid;
      const idioma = user.idioma || 'es';

      const nuevaVigencia = new Date();
      nuevaVigencia.setDate(nuevaVigencia.getDate() + 30);

      await pool.query(`
        UPDATE tenants
        SET membresia_activa = true,
            membresia_vigencia = $2
        WHERE uid = $1
      `, [uid, nuevaVigencia]);

      await sendRenewalSuccessEmail(customerEmail, idioma);
      console.log('🔁 Membresía renovada y correo enviado a:', customerEmail);
    } catch (error) {
      console.error('❌ Error renovando membresía:', error);
    }
  }

  // ✅ Cancelación de suscripción
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
      console.warn('⚠️ No se pudo obtener el email del cliente:', err);
    }

    if (!customerEmail) return res.status(400).json({ error: 'Email no disponible' });

    try {
      const userResult = await pool.query('SELECT uid, idioma FROM users WHERE email = $1', [customerEmail]);
      const user = userResult.rows[0];
      if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

      const uid = user.uid;
      const idioma = user.idioma || 'es';

      await pool.query(`
        UPDATE tenants
        SET membresia_activa = false
        WHERE uid = $1
      `, [uid]);

      await sendCancelationEmail(customerEmail, idioma);
      console.log('🛑 Membresía cancelada y correo enviado a:', customerEmail);
    } catch (error) {
      console.error('❌ Error cancelando membresía:', error);
    }
  }

  res.status(200).json({ received: true });
});

export default router;
