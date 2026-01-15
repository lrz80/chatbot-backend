// src/routes/stripe/webhook.ts
import express from 'express';
import Stripe from 'stripe';
import pool from '../../lib/db';
import { transporter } from '../../lib/mailer';
import { sendSubscriptionActivatedEmail } from '../../lib/mailer';
import { sendRenewalSuccessEmail } from '../../lib/mailer';
import { sendCancelationEmail } from '../../lib/mailer';
import { markTrialUsedByEmail } from '../../lib/trial';
import twilio from 'twilio';

const router = express.Router();

let stripe: Stripe;
let STRIPE_WEBHOOK_SECRET: string;

type ChannelFlags = {
  whatsapp_enabled: boolean;
  meta_enabled: boolean;
  voice_enabled: boolean;
  sms_enabled: boolean;
  email_enabled: boolean;
};

const bool = (v: any, fallback = false) =>
  String(v ?? '').toLowerCase() === 'true' ? true : (v === true ? true : fallback);

// ✅ UPsert a channel_settings
const upsertChannelFlags = async (tenantId: string, flags: ChannelFlags) => {
  await pool.query(
    `
    INSERT INTO channel_settings
      (tenant_id, whatsapp_enabled, meta_enabled, voice_enabled, sms_enabled, email_enabled)
    VALUES
      ($1,        $2,               $3,          $4,            $5,          $6)
    ON CONFLICT (tenant_id)
    DO UPDATE SET
      whatsapp_enabled = EXCLUDED.whatsapp_enabled,
      meta_enabled     = EXCLUDED.meta_enabled,
      voice_enabled    = EXCLUDED.voice_enabled,
      sms_enabled      = EXCLUDED.sms_enabled,
      email_enabled    = EXCLUDED.email_enabled
    `,
    [
      tenantId,
      flags.whatsapp_enabled,
      flags.meta_enabled,
      flags.voice_enabled,
      flags.sms_enabled,
      flags.email_enabled,
    ]
  );
};

// Lee metadata del PRODUCTO y produce flags.
// ⚠️ Si el producto NO tiene metadata, por defecto TODO EN FALSE
// (si tu plan Starter incluye WhatsApp, déjalo true aquí)
const flagsFromProduct = (product: Stripe.Product): ChannelFlags => {
  const md = (product.metadata || {}) as Record<string, string>;

const defaults: ChannelFlags = {
  whatsapp_enabled: true,
  meta_enabled:     true,   // ✅ tu plan incluye IG/FB
  voice_enabled:    false,
  sms_enabled:      false,
  email_enabled:    false,
};

  return {
    whatsapp_enabled: bool(md.whatsapp_enabled, defaults.whatsapp_enabled),
    meta_enabled:     bool(md.meta_enabled,     defaults.meta_enabled),
    voice_enabled:    bool(md.voice_enabled,    defaults.voice_enabled),
    sms_enabled:      bool(md.sms_enabled,      defaults.sms_enabled),
    email_enabled:    bool(md.email_enabled,    defaults.email_enabled),
  };
};

type PlanLimits = Record<string, number>;

const limitsFromProduct = (product: Stripe.Product): PlanLimits => {
  const raw = (product.metadata || {}).plan_limits;
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return {};
    // fuerza valores numéricos
    const out: PlanLimits = {};
    for (const [k, v] of Object.entries(obj)) out[k] = Number(v) || 0;
    return out;
  } catch {
    return {};
  }
};

// 🔎 Obtiene el product de Stripe desde la Checkout Session (modo subscription)
const getProductFromCheckoutSession = async (stripe: Stripe, sessionId: string) => {
  const items = await stripe.checkout.sessions.listLineItems(sessionId, { limit: 1 });
  const price = items.data?.[0]?.price;
  if (!price) return null;
  const productId = typeof price.product === 'string' ? price.product : undefined;
  if (!productId) return null;
  return await stripe.products.retrieve(productId);
};

// 🔎 Obtiene el product de Stripe desde la Subscription
const getProductFromSubscription = async (stripe: Stripe, subscription: Stripe.Subscription) => {
  const price = subscription.items?.data?.[0]?.price;
  const productId = typeof price?.product === 'string' ? price?.product : undefined;
  if (!productId) return null;
  return await stripe.products.retrieve(productId);
};

// 🔎 Obtiene todos los productos de una suscripción (por si vendes bundles con varios precios)
const getProductsFromSubscription = async (stripe: Stripe, sub: Stripe.Subscription) => {
  const prods: Stripe.Product[] = [];
  for (const it of sub.items.data) {
    const pid = typeof it.price.product === 'string' ? it.price.product : undefined;
    if (pid) prods.push(await stripe.products.retrieve(pid));
  }
  return prods;
};

// 🔗 Combina múltiples conjuntos de flags (si un cliente tiene varios productos activos)
const combineFlags = (all: ChannelFlags[]) => ({
  whatsapp_enabled: all.some(f => f.whatsapp_enabled),
  meta_enabled:     all.some(f => f.meta_enabled),
  voice_enabled:    all.some(f => f.voice_enabled),
  sms_enabled:      all.some(f => f.sms_enabled),
  email_enabled:    all.some(f => f.email_enabled),
});

// Nombre/alias del plan desde la Subscription (lee el Product)
const getPlanNameFromSubscription = async (stripe: Stripe, sub: Stripe.Subscription): Promise<string> => {
  const price = sub.items?.data?.[0]?.price;
  const productId = typeof price?.product === 'string' ? price.product : undefined;
  if (!productId) return 'pro';
  try {
    const product = await stripe.products.retrieve(productId);
    const name = (product.name || 'pro').toLowerCase();
    return name;
  } catch {
    return 'pro';
  }
};

function initStripe() {
  if (!stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('❌ STRIPE_SECRET_KEY no está definida.');
    STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;
    if (!STRIPE_WEBHOOK_SECRET) throw new Error('❌ STRIPE_WEBHOOK_SECRET no está definida.');
    stripe = new Stripe(key, { apiVersion: '2022-11-15' });
  }
}

function getTwilioClient() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  return twilio(sid, token);
}

async function notifyAdminPaymentSMS(params: {
  eventId: string;
  tenantId?: string | null;
  kind: 'setup' | 'subscription_checkout';
  amountCents?: number | null;
  currency?: string | null;
  email?: string | null;
  plan?: string | null;
  canal?: string | null;
  cantidad?: number | null;
}) {
  try {
    const adminPhone = process.env.ADMIN_PHONE;
    if (!adminPhone) return;

    // Idempotencia: si ya notificamos este event_id, no enviar SMS
    const ins = await pool.query(
      `INSERT INTO stripe_sms_notifications(event_id)
       VALUES ($1)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [params.eventId]
    );
    if (ins.rowCount === 0) return; // ya notificado

    const client = getTwilioClient();
    if (!client) return;

    // From: preferimos twilio_sms_number del tenant si existe, sino un número global
    let fromNumber = process.env.TWILIO_SMS_NUMBER || '';
    let tenantName: string | null = null;

    if (params.tenantId) {
      const t = await pool.query(
        `SELECT name, twilio_sms_number FROM tenants WHERE id = $1 LIMIT 1`,
        [params.tenantId]
      );
      tenantName = t.rows[0]?.name ?? null;
      const tenantFrom = t.rows[0]?.twilio_sms_number ?? null;
      if (tenantFrom) fromNumber = tenantFrom;
    }

    if (!fromNumber) return;

    const amount =
      params.amountCents != null
        ? (params.amountCents / 100).toFixed(2)
        : null;

    const cur = (params.currency || '').toUpperCase() || 'USD';

    const lines: string[] = [];
    lines.push('Pago recibido (Aamy)');
    if (tenantName) lines.push(`Negocio: ${tenantName}`);
    if (params.email) lines.push(`Email: ${params.email}`);
    if (params.plan) lines.push(`Plan: ${params.plan}`);
    if (params.canal && params.cantidad) lines.push(`Créditos: ${params.cantidad} ${params.canal}`);
    if (amount) lines.push(`Monto: ${amount} ${cur}`);
    lines.push(`Tipo: ${params.kind}`);

    const body = lines.join('\n');

    await client.messages.create({
      to: adminPhone,
      from: fromNumber,
      body,
    });
  } catch (e) {
    // Nunca romper el webhook por fallo de SMS
    console.warn('⚠️ SMS admin no enviado (se ignora):', e);
  }
}

const resetearCanales = async (tenantId: string, planLimits: Record<string, number>) => {
  const canales = ['contactos', 'whatsapp', 'sms', 'email', 'voz', 'meta', 'followup', 'tokens_openai'];

  for (const canal of canales) {
    const limite = Number(planLimits?.[canal] ?? 0);

    await pool.query(
      `
      INSERT INTO uso_mensual (tenant_id, canal, mes, usados, limite)
      VALUES ($1, $2, date_trunc('month', CURRENT_DATE), 0, $3)
      ON CONFLICT (tenant_id, canal, mes)
      DO UPDATE SET usados = 0, limite = EXCLUDED.limite
      `,
      [tenantId, canal, limite]
    );
  }
};

const getTenantIdBySubscriptionId = async (subscriptionId: string): Promise<string | null> => {
  const res = await pool.query('SELECT id FROM tenants WHERE subscription_id = $1 LIMIT 1', [subscriptionId]);
  return res.rows[0]?.id || null;
};

// ⚠️ IMPORTANTE: este endpoint usa express.raw para validar la firma
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

  // ==========================
  // 1) COMPRAS DE CRÉDITOS
  // ==========================
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const email = session.customer_email;

    // ==========================
    // 0) NUEVO: Opción A (Setup $399 payment -> crea suscripción $199 con trial 30d)
    // ==========================
    if (
      session.mode === 'payment' &&
      session.metadata?.purpose === 'aamy_initial_399' &&
      session.metadata?.tenant_id
    ) {
      const tenantId = session.metadata.tenant_id as string;
      const customerId = typeof session.customer === 'string' ? session.customer : null;

      if (!customerId) {
        console.warn('⚠️ Opción A: Checkout $399 completado pero no hay customerId.');
        return res.status(200).json({ received: true });
      }

      const PRICE_MONTHLY_199 = process.env.STRIPE_PRICE_MONTHLY_199;
      if (!PRICE_MONTHLY_199) {
        console.error('❌ Falta STRIPE_PRICE_MONTHLY_199 en env.');
        return res.status(200).json({ received: true });
      }

      try {
        // 1) Obtener PaymentMethod del payment intent del checkout y setearlo como default
        const paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : null;
        if (paymentIntentId) {
          const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
          const paymentMethodId = typeof pi.payment_method === 'string' ? pi.payment_method : null;

          if (paymentMethodId) {
            await stripe.customers.update(customerId, {
              invoice_settings: { default_payment_method: paymentMethodId },
            });
          }
        }

        // 2) Crear suscripción $199/mes con trial 30 días
        const subscription = await stripe.subscriptions.create({
          customer: customerId,
          items: [{ price: PRICE_MONTHLY_199 }],
          trial_period_days: 30,
          metadata: { tenant_id: tenantId, plan: 'aamy_24_7' },
        });

        const productsA = await getProductsFromSubscription(stripe, subscription);

        // ✅ Plan limits desde productos (si hay varios, combina por MAX por canal)
        let planLimits: Record<string, number> = {};
        if (productsA.length) {
          for (const p of productsA) {
            const lim = limitsFromProduct(p);
            for (const [k, v] of Object.entries(lim)) {
              planLimits[k] = Math.max(Number(planLimits[k] ?? 0), Number(v ?? 0));
            }
          }
        }

        // 3) Vigencias (si está en trial, current_period_end igual viene bien como referencia)
        const vigencia = new Date(subscription.current_period_end * 1000);
        const inicio = new Date((subscription.start_date || Math.floor(Date.now() / 1000)) * 1000);
        const esTrial = subscription.status === 'trialing';
        const hasTrialFlag = Boolean(subscription.trial_end);

        // 4) Guardar en DB (mismo esquema que ya usas)
        await pool.query(
          `
          UPDATE tenants
          SET membresia_activa     = true,
              membresia_vigencia   = $2,
              membresia_inicio     = $3,
              plan                 = $4,
              subscription_id      = $5,
              es_trial             = $6,
              trial_ever_claimed   = CASE WHEN $7 THEN true ELSE trial_ever_claimed END,
              plan_limits          = $8
          WHERE id = $1
          `,
          [
            tenantId,
            vigencia,
            inicio,
            'pro',                 // o 'aamy_24_7' si prefieres fijo en tu sistema
            subscription.id,
            esTrial,
            hasTrialFlag,
            planLimits,
          ]
        );

        // 5) Registrar trial por email (para bloquear trials futuros)
        if (email && hasTrialFlag) {
          try {
            await markTrialUsedByEmail(email, customerId);
          } catch (e) {
            console.warn('⚠️ No se pudo marcar trial_registry (Opción A):', e);
          }
        }

        // 6) Resetear usos (como ya haces)
        await resetearCanales(tenantId, planLimits);

        // 7) Flags de canales (leer producto de la suscripción o fallback)
        try {
          if (productsA.length) {
            const allFlags = productsA.map(p => flagsFromProduct(p));
            const combined = combineFlags(allFlags);
            await upsertChannelFlags(tenantId, combined);
            console.log('✅ Channel flags (Opción A) desde productos:', combined, 'tenant:', tenantId);
          } else {
            await upsertChannelFlags(tenantId, {
              whatsapp_enabled: true,
              meta_enabled: true,
              voice_enabled: false,
              sms_enabled: false,
              email_enabled: false,
            });
          }
        } catch (e) {
          console.error('❌ Error estableciendo channel flags (Opción A):', e);
        }

        // 8) Correo activación
        if (email) {
          const tenantNameRes = await pool.query('SELECT name FROM tenants WHERE id = $1', [tenantId]);
          const tenantName = tenantNameRes.rows[0]?.name || 'Usuario';
          try {
            await sendSubscriptionActivatedEmail(email, tenantName);
          } catch (e) {
            console.warn('✉️ Aviso: fallo enviando correo de activación (Opción A):', e);
          }
        }

        console.log('✅ Opción A completada: $399 pagado y suscripción $199 creada:', subscription.id);
        await notifyAdminPaymentSMS({
          eventId: event.id,
          tenantId,
          kind: 'setup',
          amountCents: session.amount_total ?? null,
          currency: session.currency ?? null,
          email: email ?? null,
          plan: 'pro',
        });

      } catch (err) {
        console.error('❌ Error en Opción A (crear suscripción $199 tras $399):', err);
      }

      return res.status(200).json({ received: true });
    }

    // Modo "payment" con metadata para créditos unitarios (sms, contactos, etc.)
    if (
      session.mode === 'payment' &&
      session.metadata?.tenant_id &&
      session.metadata?.canal &&
      session.metadata?.cantidad
    ) {
      const { tenant_id, canal, cantidad } = session.metadata;
      const cantidadInt = Number.parseInt(String(cantidad), 10) || 0;

      // Canales permitidos
      const canalesPermitidos = ['sms', 'email', 'whatsapp', 'contactos', 'tokens_openai', 'voz', 'meta', 'followup'];
      if (!canalesPermitidos.includes(canal)) {
        console.warn(`⚠️ Canal no permitido en créditos: ${canal}`);
        return res.status(200).json({ received: true });
      }
      if (!cantidadInt || cantidadInt <= 0) {
        console.warn(`⚠️ Cantidad inválida en créditos: ${cantidad}`);
        return res.status(200).json({ received: true });
      }

      try {
        // ⏰ Vencimiento EXACTO a la misma hora/min/seg de compra (+30 días)
        await pool.query(
          `
          INSERT INTO creditos_comprados
            (tenant_id, canal, cantidad, fecha_compra, fecha_vencimiento, external_id)
          VALUES
            ($1,        $2,    $3,       NOW(),        NOW() + INTERVAL '30 days', $4)
          ON CONFLICT (tenant_id, canal, external_id) DO NOTHING
          `,
          [tenant_id, canal, cantidadInt, session.id] // session.id = external_id idempotente
        );

        if (email) {
          const tenantNameRes = await pool.query('SELECT name FROM tenants WHERE id = $1', [tenant_id]);
          const tenantName = tenantNameRes.rows[0]?.name || 'Usuario';
          try {
            await transporter.sendMail({
              from: `"Amy AI" <${process.env.EMAIL_FROM}>`,
              to: email,
              subject: `Créditos ${canal.toUpperCase()} activados`,
              html: `
                <div style="text-align: center;">
                  <img src="https://aamy.ai/avatar-amy.png" alt="Amy AI Avatar" style="width: 100px; height: 100px; border-radius: 50%;" />
                  <h3>Hola ${tenantName} 👋</h3>
                  <p>¡Créditos de <strong>${canal.toUpperCase()}</strong> agregados!</p>
                  <p>Tu compra de <strong>${cantidadInt}</strong> créditos fue procesada exitosamente.</p>
                  <br />
                  <p>Gracias por confiar en <strong>Amy AI</strong> 💜</p>
                </div>
              `,
            });
          } catch (mailErr) {
            // No bloquear el flujo por timeout SMTP
            console.warn('✉️ Aviso: fallo enviando correo de créditos (se ignora):', mailErr);
          }
        }
      } catch (error) {
        console.error('❌ Error al agregar créditos comprados:', error);
      }

      return res.status(200).json({ received: true });
    }

    // Modo "subscription" (membresías)
    if (email && session.subscription) {
      try {
        // 1) Obtén el tenantId de metadata si vino en el Checkout; si no, busca por email
        let tenantId: string | null = session.metadata?.tenant_id ?? null;

        if (!tenantId) {
          const userRes = await pool.query('SELECT tenant_id FROM users WHERE email = $1 LIMIT 1', [email]);
          tenantId = userRes.rows[0]?.tenant_id ?? null;
        }

        if (!tenantId) {
          console.warn('⚠️ No se encontró tenantId para la suscripción (ni por metadata ni por email).');
          return res.status(200).json({ received: true });
        }

        // 2) Datos de la suscripción
        const subscriptionId = session.subscription as string;
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const vigencia = new Date(subscription.current_period_end * 1000);
        const esTrial = subscription.status === 'trialing';
        const hasTrialFlag = Boolean(subscription.trial_end); // hubo trial si existe trial_end

        // 🔎 Lee el nombre del plan desde Stripe automáticamente
        const product = subscription.items.data[0]?.price?.product;
        let planValue = 'pro'; // valor por defecto

        if (hasTrialFlag && email) {
          try {
            // Guarda también el customerId si quieres
            const customerId = typeof subscription.customer === 'string' ? subscription.customer : null;
            await markTrialUsedByEmail(email, customerId || undefined);
          } catch (e) {
            console.warn('⚠️ No se pudo marcar trial en trial_registry:', e);
          }
        }
        if (typeof product === 'string') {
          try {
            const stripeProduct = await stripe.products.retrieve(product);
            planValue = (stripeProduct.name || 'pro').toLowerCase(); // usa el nombre del producto en Stripe
          } catch (e) {
            console.warn('⚠️ No se pudo leer el nombre del producto:', e);
          }
        }

        // ✅ Plan limits desde Stripe product (source of truth)
        let planLimits: Record<string, number> = {};
        if (typeof product === 'string') {
          try {
            const stripeProduct = await stripe.products.retrieve(product);
            planLimits = limitsFromProduct(stripeProduct);
          } catch (e) {
            console.warn('⚠️ No se pudo leer plan_limits del producto:', e);
          }
        }

        // 3) Activa membresía y guarda subscription_id (+ marca trial_ever_claimed si aplicó)
        await pool.query(
          `
          UPDATE tenants
            SET membresia_activa     = true,
            membresia_vigencia   = $2,
            membresia_inicio     = $3,
            plan                 = $4,
            subscription_id      = $5,
            es_trial             = $6,
            trial_ever_claimed   = CASE WHEN $7 THEN true ELSE trial_ever_claimed END,
            plan_limits          = $8
          WHERE id = $1
          `,
          [
            tenantId,
            vigencia,
            new Date(subscription.start_date * 1000),
            planValue,
            subscriptionId,
            esTrial,
            hasTrialFlag,
            planLimits,
          ]
        );

        // 4) Reinicia usos
        await resetearCanales(tenantId, planLimits);

        // 5) Lee el producto y aplica flags de canales
        try {
          const productFromCheckout = await getProductFromCheckoutSession(stripe, session.id);
          if (productFromCheckout) {
            const flags = flagsFromProduct(productFromCheckout);
            await upsertChannelFlags(tenantId, flags);
            console.log('✅ Channel flags actualizados por checkout:', flags, 'tenant:', tenantId);
          } else {
            // fallback: todos true
            await upsertChannelFlags(tenantId, {
              whatsapp_enabled: true,
              meta_enabled: true,
              voice_enabled: true,
              sms_enabled: true,
              email_enabled: true,
            });
            console.log('ℹ️ No se obtuvo product; activados todos los canales por defecto.');

          }
        } catch (e) {
          console.error('❌ Error estableciendo channel flags post-checkout:', e);
        }

           await notifyAdminPaymentSMS({
              eventId: event.id,
              tenantId,
              kind: 'subscription_checkout',
              amountCents: session.amount_total ?? null,
              currency: session.currency ?? null,
              email,
              plan: planValue,
            });

        // 6) Email de bienvenida/activación
        const tenantNameRes = await pool.query('SELECT name FROM tenants WHERE id = $1', [tenantId]);
        const tenantName = tenantNameRes.rows[0]?.name || 'Usuario';
        try {
          await sendSubscriptionActivatedEmail(email, tenantName);
        } catch (e) {
          console.warn('✉️ Aviso: fallo enviando correo de activación (se ignora):', e);
        }
      } catch (error) {
        console.error('❌ Error activando membresía:', error);
      }
    }
  }

  // ==========================
  // 2) SUBSCRIPCIÓN ACTUALIZADA
  // ==========================
  if (event.type === 'customer.subscription.updated') {
    const subscription = event.data.object as Stripe.Subscription;
    const tenant_id = await getTenantIdBySubscriptionId(subscription.id);
    const customerId = typeof subscription.customer === 'string' ? subscription.customer : null;
    if (subscription.status === 'trialing' || subscription.trial_end) {
      try {
        if (customerId) {
          const customer = await stripe.customers.retrieve(customerId);
          const email = (typeof customer !== 'string' && 'email' in customer) ? (customer.email as string | null) : null;
          if (email) {
            await markTrialUsedByEmail(email, customerId);
          }
        }
      } catch (e) {
        console.warn('⚠️ No se pudo actualizar trial_registry en subscription.updated:', e);
      }
    }
    if (tenant_id) {
      const esTrial = subscription.status === 'trialing';
      const hasTrialFlag = Boolean(subscription.trial_end); // hubo trial alguna vez

      // 🔎 Lee el nombre del plan desde Stripe automáticamente
      const product = subscription.items.data[0]?.price?.product;
      let planValue = 'pro'; // valor por defecto

      if (typeof product === 'string') {
        try {
          const stripeProduct = await stripe.products.retrieve(product);
          planValue = (stripeProduct.name || 'pro').toLowerCase(); // usa el nombre del producto en Stripe
        } catch (e) {
          console.warn('⚠️ No se pudo leer el nombre del producto:', e);
        }
      }

      // ✅ Plan limits desde Stripe product
      let planLimits: Record<string, number> = {};
      if (typeof product === 'string') {
        try {
          const stripeProduct = await stripe.products.retrieve(product);
          planLimits = limitsFromProduct(stripeProduct);
        } catch (e) {
          console.warn('⚠️ No se pudo leer plan_limits del producto (sub.updated):', e);
        }
      }

      await pool.query(
        `
        UPDATE tenants
        SET es_trial             = $1,
            plan                 = $2,
            membresia_inicio     = CASE WHEN $1 = false THEN $3 ELSE membresia_inicio END,
            membresia_vigencia   = $4,
            trial_ever_claimed   = CASE WHEN $5 THEN true ELSE trial_ever_claimed END,
            plan_limits          = $6
        WHERE id = $7
        `,
        [
          esTrial,
          planValue,
          new Date(subscription.current_period_start * 1000),
          new Date(subscription.current_period_end * 1000),
          hasTrialFlag,
          planLimits,
          tenant_id,
        ]
      );

      try {
        const productsUpdated = await getProductsFromSubscription(stripe, subscription);
        if (productsUpdated.length && tenant_id) {
          const allFlags = productsUpdated.map(p => flagsFromProduct(p));
          const combined = combineFlags(allFlags);
          await upsertChannelFlags(tenant_id, combined);
          console.log('🔄 Channel flags actualizados (multi-product):', combined, 'tenant:', tenant_id);
        }
      } catch (e) {
        console.error('❌ Error actualizando channel flags en subscription.updated:', e);
      }

      console.log(`🔄 Subscripción actualizada para tenant ${tenant_id}: plan=${planValue}, es_trial=${esTrial}`);
    }
  }

  // ==========================
  // 3) RENOVACIÓN DE MEMBRESÍA
  // ==========================
  if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object as Stripe.Invoice;
    let customerEmail = invoice.customer_email;

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

      // nombre de plan real desde Stripe
      const priceProd = subscription.items.data[0]?.price?.product;
      let planValue = 'pro';
      if (typeof priceProd === 'string') {
        try {
          const stripeProduct = await stripe.products.retrieve(priceProd);
          planValue = (stripeProduct.name || 'pro').toLowerCase();
        } catch (e) {
          console.warn('⚠️ No se pudo leer el nombre del producto (invoice):', e);
        }
      }

      // ✅ Plan limits desde Stripe product (invoice)
      let planLimits: Record<string, number> = {};
      if (typeof priceProd === 'string') {
        try {
          const stripeProduct = await stripe.products.retrieve(priceProd);
          planLimits = limitsFromProduct(stripeProduct);
        } catch (e) {
          console.warn('⚠️ No se pudo leer plan_limits del producto (invoice):', e);
        }
      }

      const userRes = await pool.query('SELECT tenant_id FROM users WHERE email = $1 LIMIT 1', [customerEmail]);
      const user = userRes.rows[0];
      if (!user?.tenant_id) return res.status(200).json({ received: true });

      await pool.query(
        `
        UPDATE tenants
        SET membresia_activa   = true,
            membresia_vigencia = $2,
            membresia_inicio   = NOW(),
            plan               = $3,
            plan_limits        = $4
        WHERE id = $1
        `,
        [user.tenant_id, nuevaVigencia, planValue, planLimits]
      );

      // 🔁 Sincroniza flags de canales al renovar (por si cambió de plan)
      try {
        const productsInvoice = await getProductsFromSubscription(stripe, subscription);
        if (productsInvoice.length) {
          const allFlags = productsInvoice.map(p => flagsFromProduct(p));
          const combined = combineFlags(allFlags);
          await upsertChannelFlags(user.tenant_id, combined);
          console.log('🔁 Channel flags actualizados (invoice.payment_succeeded):', combined, 'tenant:', user.tenant_id);
        }
      } catch (e) {
        console.warn('⚠️ No se pudieron actualizar channel flags en invoice.payment_succeeded:', e);
      }

      console.log('🔁 Membresía renovada para', customerEmail, 'tenant', user.tenant_id);

      await resetearCanales(user.tenant_id, planLimits);

      const tenantNameRes = await pool.query('SELECT name FROM tenants WHERE id = $1', [user.tenant_id]);
      const tenantName = tenantNameRes.rows[0]?.name || 'Usuario';

      await sendRenewalSuccessEmail(customerEmail, tenantName);
      console.log('📧 Correo de renovación enviado');
    } catch (error) {
      console.error('❌ Error renovando membresía:', error);
    }
  }

  // ==========================
  // 4) CANCELACIÓN DE SUSCRIPCIÓN
  // ==========================
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

    if (!customerEmail) {
      console.warn('⚠️ No se pudo obtener email del cliente para enviar la cancelación.');
      return res.status(200).json({ received: true });
    }

    try {
      const userRes = await pool.query('SELECT uid, tenant_id FROM users WHERE email = $1', [customerEmail]);
      const user = userRes.rows[0];
      if (!user) return res.status(200).json({ received: true });

      await pool.query(
        `
        UPDATE tenants
        SET membresia_activa = false,
            plan = NULL
        WHERE id = $1
        `,
        [user.tenant_id]
      );

      await upsertChannelFlags(user.tenant_id, {
        whatsapp_enabled: false,
        meta_enabled: false,
        voice_enabled: false,
        sms_enabled: false,
        email_enabled: false,
      });
      console.log('🛑 Channel flags desactivados por cancelación para tenant', user.tenant_id);

      console.log('🛑 Cancelando plan para', customerEmail, 'con UID', user.uid);

      await pool.query(
        `
        INSERT INTO uso_mensual (tenant_id, canal, mes, usados, limite)
        VALUES ($1, 'contactos', date_trunc('month', CURRENT_DATE), 0, 0)
        ON CONFLICT (tenant_id, canal, mes)
        DO UPDATE SET limite = 0
        `,
        [user.tenant_id]
      );

      console.log('🛑 Suscripción cancelada y contactos reiniciados para', customerEmail);

      const tenantNameRes = await pool.query('SELECT name FROM tenants WHERE id = $1', [user.tenant_id]);
      const tenantName = tenantNameRes.rows[0]?.name || 'Usuario';

      // Enviar correo de cancelación (no bloquear si falla)
      try {
        // Evita enviar a buzones de prueba/bloqueados
        const skip = !customerEmail ||
                    /^(demo|test|no-reply)@aamy\.ai$/i.test(customerEmail);
        if (!skip) {
          await sendCancelationEmail(customerEmail, tenantName);
          console.log('📧 Correo de cancelación enviado a', customerEmail);
        } else {
          console.log('✉️ Salteado envío de cancelación a', customerEmail);
        }
      } catch (mailErr: any) {
        console.warn('✉️ Aviso: fallo enviando correo de cancelación (se ignora):',
          mailErr?.responseCode, mailErr?.response || mailErr?.message || mailErr);
      }
    } catch (err) {
      console.error('❌ Error al cancelar membresía:', err);
    }
  }

  res.status(200).json({ received: true });
});

export default router;
