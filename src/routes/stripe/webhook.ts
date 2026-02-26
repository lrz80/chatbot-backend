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
import { sendCapiEvent } from "../../services/metaCapi";
import crypto from "crypto";

const router = express.Router();

const META_EVENT_SOURCE_URL = "https://aamy.ai/upgrade";

const sha256 = (s: string) =>
  crypto.createHash("sha256").update(String(s || "").trim().toLowerCase()).digest("hex");

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

function buildCapiUserData(params: { tenantId: string; email?: string | null; phoneE164?: string | null }) {
  const { tenantId, email, phoneE164 } = params;

  const ud: any = {
    external_id: sha256(`${tenantId}:${email || phoneE164 || "unknown"}`),
  };

  if (email) ud.em = sha256(email);
  if (phoneE164) ud.ph = sha256(phoneE164);

  return ud;
}

// ✅ UPsert a channel_settings (toggles por tenant)
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

// ✅ NUEVO: UPSERT a tenant_plan_features (plan gate real que usa features.ts)
const upsertTenantPlanFeatures = async (tenantId: string, productId: string | null, flags: ChannelFlags) => {
  // si no hay productId, igual guardamos null
  await pool.query(
    `
    INSERT INTO tenant_plan_features
      (tenant_id, product_id, whatsapp_enabled, meta_enabled, voice_enabled, sms_enabled, email_enabled, updated_at)
    VALUES
      ($1,       $2,         $3,              $4,           $5,            $6,          $7,           NOW())
    ON CONFLICT (tenant_id)
    DO UPDATE SET
      product_id = EXCLUDED.product_id,
      whatsapp_enabled = EXCLUDED.whatsapp_enabled,
      meta_enabled = EXCLUDED.meta_enabled,
      voice_enabled = EXCLUDED.voice_enabled,
      sms_enabled = EXCLUDED.sms_enabled,
      email_enabled = EXCLUDED.email_enabled,
      updated_at = NOW()
    `,
    [
      tenantId,
      productId,
      flags.whatsapp_enabled,
      flags.meta_enabled,
      flags.voice_enabled,
      flags.sms_enabled,
      flags.email_enabled,
    ]
  );
};

// Lee metadata del PRODUCTO y produce flags.
const flagsFromProduct = (product: Stripe.Product): ChannelFlags => {
  const md = (product.metadata || {}) as Record<string, string>;

  // defaults: pon aquí lo que SIEMPRE debe venir ON en tu plan base
  const defaults: ChannelFlags = {
    whatsapp_enabled: true,
    meta_enabled:     true,   // ✅ según lo que tú quieres
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

// 🔎 Obtiene todos los productos de una suscripción (por si vendes bundles)
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

    const ins = await pool.query(
      `INSERT INTO stripe_sms_notifications(event_id)
       VALUES ($1)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [params.eventId]
    );
    if (ins.rowCount === 0) return;

    const client = getTwilioClient();
    if (!client) return;

    let fromNumber = process.env.TWILIO_SMS_NUMBER || "";
    let tenantName: string | null = null;

    if (params.tenantId) {
      const t = await pool.query(
        `SELECT name FROM tenants WHERE id = $1 LIMIT 1`,
        [params.tenantId]
      );
      tenantName = t.rows[0]?.name ?? null;
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
  // OJO: asegúrate que tu columna sea tenants.subscription_id (como estás usando en UPDATE)
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
  // 1) CHECKOUT COMPLETED
  // ==========================
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const email = session.customer_email;

    // ==========================
    // 0) Opción A: Setup $399 -> crea suscripción $199 con trial 30d
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

        const subscription = await stripe.subscriptions.create({
          customer: customerId,
          items: [{ price: PRICE_MONTHLY_199 }],
          trial_period_days: 30,
          metadata: { tenant_id: tenantId, plan: 'aamy_24_7' },
        });

        const productsA = await getProductsFromSubscription(stripe, subscription);

        let planLimits: Record<string, number> = {};
        if (productsA.length) {
          for (const p of productsA) {
            const lim = limitsFromProduct(p);
            for (const [k, v] of Object.entries(lim)) {
              planLimits[k] = Math.max(Number(planLimits[k] ?? 0), Number(v ?? 0));
            }
          }
        }

        const vigencia = new Date(subscription.current_period_end * 1000);
        const inicio = new Date((subscription.start_date || Math.floor(Date.now() / 1000)) * 1000);
        const esTrial = subscription.status === 'trialing';
        const hasTrialFlag = Boolean(subscription.trial_end);

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
            'pro', // interno si quieres, pero OJO: gate real vendrá de tenant_plan_features
            subscription.id,
            esTrial,
            hasTrialFlag,
            planLimits,
          ]
        );

        if (email && hasTrialFlag) {
          try {
            await markTrialUsedByEmail(email, customerId);
          } catch (e) {
            console.warn('⚠️ No se pudo marcar trial_registry (Opción A):', e);
          }
        }

        await resetearCanales(tenantId, planLimits);

        // ✅ FLAGS + tenant_plan_features (CRÍTICO)
        try {
          if (productsA.length) {
            const allFlags = productsA.map(p => flagsFromProduct(p));
            const combined = combineFlags(allFlags);
            const productId = productsA[0]?.id || null;

            await upsertChannelFlags(tenantId, combined);
            await upsertTenantPlanFeatures(tenantId, productId, combined);

            console.log('✅ Flags/PlanFeatures (Opción A):', combined, 'tenant:', tenantId, 'product:', productId);
          } else {
            const combined = {
              whatsapp_enabled: true,
              meta_enabled: true,
              voice_enabled: false,
              sms_enabled: false,
              email_enabled: false,
            };
            await upsertChannelFlags(tenantId, combined);
            await upsertTenantPlanFeatures(tenantId, null, combined);
          }
        } catch (e) {
          console.error('❌ Error estableciendo flags/plan_features (Opción A):', e);
        }

        if (email) {
          const tenantNameRes = await pool.query('SELECT name FROM tenants WHERE id = $1', [tenantId]);
          const tenantName = tenantNameRes.rows[0]?.name || 'Usuario';
          try {
            await sendSubscriptionActivatedEmail(email, tenantName);
          } catch (e) {
            console.warn('✉️ fallo correo activación (Opción A):', e);
          }
        }

        console.log('✅ Opción A completada:', subscription.id);

        try {
          const phoneE164 = (session.customer_details?.phone || "").replace(/[^\d+]/g, "").trim();
          await sendCapiEvent({
            tenantId,
            eventName: "Purchase",
            eventId: `purchase:${tenantId}:${session.id}`,
            userData: buildCapiUserData({ tenantId, email: email || null, phoneE164: phoneE164 || null }),
            customData: {
              value: (session.amount_total ?? 0) / 100,
              currency: (session.currency ?? "usd").toUpperCase(),
              source: "stripe_setup_399",
              event_source_url: META_EVENT_SOURCE_URL,
            },
          });
        } catch (e) {
          console.warn("⚠️ Meta CAPI setup $399 falló:", e);
        }

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
        console.error('❌ Error en Opción A:', err);
      }

      return res.status(200).json({ received: true });
    }

    // ==========================
    // Compras de créditos (payment)
    // ==========================
    if (
      session.mode === 'payment' &&
      session.metadata?.tenant_id &&
      session.metadata?.canal &&
      session.metadata?.cantidad
    ) {
      const { tenant_id, canal, cantidad } = session.metadata;
      const cantidadInt = Number.parseInt(String(cantidad), 10) || 0;

      const canalesPermitidos = ['sms', 'email', 'whatsapp', 'contactos', 'tokens_openai', 'voz', 'meta', 'followup'];
      if (!canalesPermitidos.includes(canal)) return res.status(200).json({ received: true });
      if (!cantidadInt || cantidadInt <= 0) return res.status(200).json({ received: true });

      try {
        await pool.query(
          `
          INSERT INTO creditos_comprados
            (tenant_id, canal, cantidad, fecha_compra, fecha_vencimiento, external_id)
          VALUES
            ($1,        $2,    $3,       NOW(),        NOW() + INTERVAL '30 days', $4)
          ON CONFLICT (tenant_id, canal, external_id) DO NOTHING
          `,
          [tenant_id, canal, cantidadInt, session.id]
        );

        try {
          const phoneE164 = (session.customer_details?.phone || "").replace(/[^\d+]/g, "").trim();
          await sendCapiEvent({
            tenantId: tenant_id,
            eventName: "Purchase",
            eventId: `purchase:${tenant_id}:${session.id}`,
            userData: buildCapiUserData({ tenantId: tenant_id, email: email || null, phoneE164: phoneE164 || null }),
            customData: {
              value: (session.amount_total ?? 0) / 100,
              currency: (session.currency ?? "usd").toUpperCase(),
              source: "stripe_credits",
              canal,
              cantidad: cantidadInt,
              event_source_url: META_EVENT_SOURCE_URL,
            },
          });
        } catch (e) {
          console.warn("⚠️ Meta CAPI créditos falló:", e);
        }

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
            console.warn('✉️ fallo correo créditos:', mailErr);
          }
        }
      } catch (error) {
        console.error('❌ Error al agregar créditos comprados:', error);
      }

      return res.status(200).json({ received: true });
    }

    // ==========================
    // Membresías (subscription)
    // ==========================
    if (email && session.subscription) {
      try {
        let tenantId: string | null = session.metadata?.tenant_id ?? null;

        if (!tenantId) {
          const userRes = await pool.query('SELECT tenant_id FROM users WHERE email = $1 LIMIT 1', [email]);
          tenantId = userRes.rows[0]?.tenant_id ?? null;
        }

        if (!tenantId) {
          console.warn('⚠️ No tenantId para la suscripción.');
          return res.status(200).json({ received: true });
        }

        const value = (session.amount_total ?? 0) / 100;
        if (value > 0) {
          try {
            const phoneE164 = (session.customer_details?.phone || "").replace(/[^\d+]/g, "").trim();
            await sendCapiEvent({
              tenantId,
              eventName: "Purchase",
              eventId: `purchase:${tenantId}:${session.id}`,
              userData: buildCapiUserData({ tenantId, email: email || null, phoneE164: phoneE164 || null }),
              customData: {
                value,
                currency: (session.currency ?? "usd").toUpperCase(),
                source: "stripe_subscription_checkout",
                event_source_url: META_EVENT_SOURCE_URL,
              },
            });
          } catch (e) {
            console.warn("⚠️ Meta CAPI subscription checkout falló:", e);
          }
        }

        const subscriptionId = session.subscription as string;
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const vigencia = new Date(subscription.current_period_end * 1000);
        const esTrial = subscription.status === 'trialing';
        const hasTrialFlag = Boolean(subscription.trial_end);

        if (hasTrialFlag && email) {
          try {
            const customerId = typeof subscription.customer === 'string' ? subscription.customer : null;
            await markTrialUsedByEmail(email, customerId || undefined);
          } catch (e) {
            console.warn('⚠️ No se pudo marcar trial_registry:', e);
          }
        }

        // ✅ Product + metadata (source of truth)
        const prod = await getProductFromCheckoutSession(stripe, session.id);
        const flags = prod ? flagsFromProduct(prod) : {
          whatsapp_enabled: true,
          meta_enabled: true,
          voice_enabled: true,
          sms_enabled: true,
          email_enabled: true,
        };

        const planLimits = prod ? limitsFromProduct(prod) : {};

        await pool.query(
          `
          UPDATE tenants
            SET membresia_activa   = true,
                membresia_vigencia = $2,
                membresia_inicio   = $3,
                plan               = $4,
                subscription_id    = $5,
                es_trial           = $6,
                trial_ever_claimed = CASE WHEN $7 THEN true ELSE trial_ever_claimed END,
                plan_limits        = $8
          WHERE id = $1
          `,
          [
            tenantId,
            vigencia,
            new Date(subscription.start_date * 1000),
            'pro', // nombre interno si quieres; PERO gate real viene de tenant_plan_features
            subscriptionId,
            esTrial,
            hasTrialFlag,
            planLimits,
          ]
        );

        await resetearCanales(tenantId, planLimits);

        // ✅ CRÍTICO: guardar plan features por metadata (para features.ts)
        try {
          const productId = prod?.id || null;
          await upsertChannelFlags(tenantId, flags);
          await upsertTenantPlanFeatures(tenantId, productId, flags);
          console.log('✅ channel_settings + tenant_plan_features actualizados:', flags, 'tenant:', tenantId, 'product:', productId);
        } catch (e) {
          console.error('❌ Error estableciendo flags/plan_features post-checkout:', e);
        }

        await notifyAdminPaymentSMS({
          eventId: event.id,
          tenantId,
          kind: 'subscription_checkout',
          amountCents: session.amount_total ?? null,
          currency: session.currency ?? null,
          email,
          plan: 'pro',
        });

        const tenantNameRes = await pool.query('SELECT name FROM tenants WHERE id = $1', [tenantId]);
        const tenantName = tenantNameRes.rows[0]?.name || 'Usuario';
        try {
          await sendSubscriptionActivatedEmail(email, tenantName);
        } catch (e) {
          console.warn('✉️ fallo correo activación:', e);
        }

      } catch (error) {
        console.error('❌ Error activando membresía:', error);
      }
    }
  }

  // ==========================
  // 2) SUBSCRIPTION UPDATED
  // ==========================
  if (event.type === 'customer.subscription.updated') {
    const subscription = event.data.object as Stripe.Subscription;

    // ✅ intenta resolver tenant por subscription_id
    const tenant_id = await getTenantIdBySubscriptionId(subscription.id);

    // ✅ si no se encuentra, intenta por metadata tenant_id (esto depende de que checkout setee subscription.metadata.tenant_id)
    const tenantIdMeta = (subscription.metadata as any)?.tenant_id ? String((subscription.metadata as any).tenant_id) : null;
    const tenantId = tenant_id || tenantIdMeta;

    const customerId = typeof subscription.customer === 'string' ? subscription.customer : null;

    if (subscription.status === 'trialing' || subscription.trial_end) {
      try {
        if (customerId) {
          const customer = await stripe.customers.retrieve(customerId);
          const email = (typeof customer !== 'string' && 'email' in customer) ? (customer.email as string | null) : null;
          if (email) await markTrialUsedByEmail(email, customerId);
        }
      } catch (e) {
        console.warn('⚠️ No se pudo actualizar trial_registry (sub.updated):', e);
      }
    }

    if (tenantId) {
      const esTrial = subscription.status === 'trialing';
      const hasTrialFlag = Boolean(subscription.trial_end);

      // ✅ Product(s) actuales y flags combinados
      try {
        const productsUpdated = await getProductsFromSubscription(stripe, subscription);

        if (productsUpdated.length) {
          const allFlags = productsUpdated.map(p => flagsFromProduct(p));
          const combined = combineFlags(allFlags);
          const productId = productsUpdated[0]?.id || null;

          await upsertChannelFlags(tenantId, combined);
          await upsertTenantPlanFeatures(tenantId, productId, combined);

          console.log('🔄 Flags/PlanFeatures actualizados (sub.updated):', combined, 'tenant:', tenantId, 'product:', productId);
        }
      } catch (e) {
        console.error('❌ Error actualizando flags/plan_features (sub.updated):', e);
      }

      // Plan limits desde producto (si necesitas)
      let planLimits: Record<string, number> = {};
      try {
        const p0 = await getProductFromSubscription(stripe, subscription);
        if (p0) planLimits = limitsFromProduct(p0);
      } catch {}

      await pool.query(
        `
        UPDATE tenants
        SET es_trial           = $1,
            plan               = $2,
            membresia_inicio   = CASE WHEN $1 = false THEN $3 ELSE membresia_inicio END,
            membresia_vigencia = $4,
            trial_ever_claimed = CASE WHEN $5 THEN true ELSE trial_ever_claimed END,
            plan_limits        = $6
        WHERE id = $7
        `,
        [
          esTrial,
          'pro',
          new Date(subscription.current_period_start * 1000),
          new Date(subscription.current_period_end * 1000),
          hasTrialFlag,
          planLimits,
          tenantId,
        ]
      );

      console.log(`🔄 Subscripción actualizada tenant ${tenantId}: es_trial=${esTrial}`);
    }
  }

  // ==========================
  // 3) INVOICE PAYMENT SUCCEEDED (RENOVACIÓN)
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
          }
        } catch (err) {
          console.warn('⚠️ No se pudo obtener email del cliente:', err);
        }
      }
    }

    if (!customerEmail) return res.status(200).json({ received: true });

    const subscriptionId = typeof invoice.subscription === 'string' ? invoice.subscription : null;
    if (!subscriptionId) return res.status(200).json({ received: true });

    const tenantId = await getTenantIdBySubscriptionId(subscriptionId);
    if (!tenantId) return res.status(200).json({ received: true });

    try {
      await sendCapiEvent({
        tenantId,
        eventName: "Purchase",
        eventId: `purchase:${tenantId}:${invoice.id}`,
        userData: buildCapiUserData({ tenantId, email: customerEmail || null, phoneE164: null }),
        customData: {
          value: (invoice.amount_paid ?? 0) / 100,
          currency: (invoice.currency ?? "usd").toUpperCase(),
          source: "stripe_invoice_renewal",
          event_source_url: META_EVENT_SOURCE_URL,
        },
      });
    } catch (e) {
      console.warn("⚠️ Meta CAPI invoice renewal falló:", e);
    }

    try {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      const nuevaVigencia = subscription.current_period_end
        ? new Date(subscription.current_period_end * 1000)
        : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      // ✅ product(s) -> flags/plan_features
      try {
        const productsInvoice = await getProductsFromSubscription(stripe, subscription);
        if (productsInvoice.length) {
          const allFlags = productsInvoice.map(p => flagsFromProduct(p));
          const combined = combineFlags(allFlags);
          const productId = productsInvoice[0]?.id || null;

          await upsertChannelFlags(tenantId, combined);
          await upsertTenantPlanFeatures(tenantId, productId, combined);

          console.log('🔁 Flags/PlanFeatures (invoice.payment_succeeded):', combined, 'tenant:', tenantId, 'product:', productId);
        }
      } catch (e) {
        console.warn('⚠️ No se pudieron actualizar flags/plan_features (invoice):', e);
      }

      // planLimits si quieres mantener
      let planLimits: Record<string, number> = {};
      try {
        const p0 = await getProductFromSubscription(stripe, subscription);
        if (p0) planLimits = limitsFromProduct(p0);
      } catch {}

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
        [tenantId, nuevaVigencia, 'pro', planLimits]
      );

      await resetearCanales(tenantId, planLimits);

      const tenantNameRes = await pool.query('SELECT name FROM tenants WHERE id = $1', [tenantId]);
      const tenantName = tenantNameRes.rows[0]?.name || 'Usuario';
      await sendRenewalSuccessEmail(customerEmail, tenantName);

    } catch (error) {
      console.error('❌ Error renovando membresía:', error);
    }
  }

  // ==========================
  // 4) CANCELACIÓN
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

    // resolve tenant
    const tenant_id = await getTenantIdBySubscriptionId(subscription.id);
    const tenantIdMeta = (subscription.metadata as any)?.tenant_id ? String((subscription.metadata as any).tenant_id) : null;
    const tenantId = tenant_id || tenantIdMeta;

    if (!tenantId) return res.status(200).json({ received: true });

    try {
      await pool.query(
        `
        UPDATE tenants
        SET membresia_activa = false,
            plan = NULL
        WHERE id = $1
        `,
        [tenantId]
      );

      const offFlags: ChannelFlags = {
        whatsapp_enabled: false,
        meta_enabled: false,
        voice_enabled: false,
        sms_enabled: false,
        email_enabled: false,
      };

      await upsertChannelFlags(tenantId, offFlags);
      await upsertTenantPlanFeatures(tenantId, null, offFlags);

      console.log('🛑 Flags/PlanFeatures desactivados por cancelación tenant', tenantId);

      // Email cancelación
      if (customerEmail) {
        const tenantNameRes = await pool.query('SELECT name FROM tenants WHERE id = $1', [tenantId]);
        const tenantName = tenantNameRes.rows[0]?.name || 'Usuario';

        try {
          const skip = !customerEmail || /^(demo|test|no-reply)@aamy\.ai$/i.test(customerEmail);
          if (!skip) await sendCancelationEmail(customerEmail, tenantName);
        } catch (mailErr: any) {
          console.warn('✉️ fallo correo cancelación:', mailErr?.message || mailErr);
        }
      }
    } catch (err) {
      console.error('❌ Error al cancelar membresía:', err);
    }
  }

  return res.status(200).json({ received: true });
});

export default router;
