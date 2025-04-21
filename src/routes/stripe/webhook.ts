import express from 'express';
import Stripe from 'stripe';
import pool from '../../lib/db';
import bodyParser from 'body-parser';
import { transporter } from '../../lib/mailer';

const router = express.Router();

// ⚠️ IMPORTANTE: usa raw body SOLO para esta ruta
router.post('/webhook', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  const sig = req.headers['stripe-signature'];

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig!, endpointSecret!);
  } catch (err) {
    console.error('⚠️ Webhook error:', err);
    return res.status(400).send(`Webhook Error: ${(err as Error).message}`);
  }

  // Detecta cuando se completa la suscripción
if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const email = session.customer_email;
  
    console.log('✅ Pago exitoso recibido de:', email);
  
    try {
      // Busca el UID del usuario por email
      const userResult = await pool.query('SELECT uid FROM users WHERE email = $1', [email]);
      const user = userResult.rows[0];
  
      if (!user) {
        console.warn('❌ No se encontró el usuario con email:', email);
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }
  
      const uid = user.uid;
      const vigencia = new Date();
      vigencia.setDate(vigencia.getDate() + 30); // o 7 si es prueba
  
      // Verifica si el tenant ya existe
      const tenantResult = await pool.query('SELECT * FROM tenants WHERE uid = $1', [uid]);
  
      if (tenantResult.rows.length === 0) {
        // Crear el tenant si no existe
        await pool.query(`
          INSERT INTO tenants (uid, membresia_activa, membresia_vigencia, used, plan)
          VALUES ($1, true, $2, 0, 'pro')
        `, [uid, vigencia]);
  
        console.log('✅ Tenant creado con membresía activa para:', email);
      } else {
        // Solo actualizar si ya existe
        await pool.query(`
          UPDATE tenants
          SET membresia_activa = true,
              membresia_vigencia = $2
          WHERE uid = $1
        `, [uid, vigencia]);
  
        console.log('🎉 Membresía activada correctamente para:', email);
      }
  
    } catch (err) {
      console.error('❌ Error actualizando la membresía:', err);
    }
  }
  
  // 🔁 Se ejecuta cada mes cuando se paga la factura
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
      
  
    if (!customerEmail) {
      console.warn('⚠️ No se pudo obtener el email del cliente para renovación');
      return res.status(400).json({ error: 'Email no disponible' });
    }
  
    console.log('💰 Renovación automática recibida para:', customerEmail);
  
    try {
      const userResult = await pool.query('SELECT uid FROM users WHERE email = $1', [customerEmail]);
      const user = userResult.rows[0];
  
      if (!user) {
        console.warn('❌ Usuario no encontrado para renovación:', customerEmail);
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }
  
      const uid = user.uid;
      const nuevaVigencia = new Date();
      nuevaVigencia.setDate(nuevaVigencia.getDate() + 30); // o lo que dure tu plan
  
      await pool.query(`
        UPDATE tenants
        SET membresia_activa = true,
            membresia_vigencia = $2
        WHERE uid = $1
      `, [uid, nuevaVigencia]);
  
      console.log('🔁 Membresía extendida hasta:', nuevaVigencia.toISOString());
    } catch (error) {
      console.error('❌ Error al renovar membresía:', error);
    }
  }

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
      console.warn('⚠️ No se pudo obtener el email del cliente desde Stripe:', err);
    }
  
    if (!customerEmail) {
      console.warn('⚠️ Email no disponible para cancelar membresía');
      return res.status(400).json({ error: 'Email no disponible' });
    }
  
    console.log('❌ Suscripción cancelada para:', customerEmail);
  
    try {
      const userResult = await pool.query('SELECT uid FROM users WHERE email = $1', [customerEmail]);
      const user = userResult.rows[0];
  
      if (!user) {
        console.warn('❌ Usuario no encontrado para cancelación:', customerEmail);
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }
  
      const uid = user.uid;
  
      await pool.query(`
        UPDATE tenants
        SET membresia_activa = false
        WHERE uid = $1
      `, [uid]);
  
      console.log('🛑 Membresía desactivada para:', customerEmail);
  
      // ✅ Enviar email al cliente
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
  
    } catch (error) {
      console.error('❌ Error al desactivar membresía o enviar email:', error);
    }
  }
  
  
  res.status(200).json({ received: true });
});

export default router;
