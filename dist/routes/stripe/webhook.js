"use strict";
// src/routes/stripe/webhook.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const stripe_1 = __importDefault(require("stripe"));
const db_1 = __importDefault(require("../../lib/db"));
const mailer_1 = require("../../lib/mailer");
const router = express_1.default.Router();
let stripe;
let STRIPE_WEBHOOK_SECRET;
function initStripe() {
    if (!stripe) {
        const key = process.env.STRIPE_SECRET_KEY;
        if (!key)
            throw new Error('❌ STRIPE_SECRET_KEY no está definida.');
        STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
        if (!STRIPE_WEBHOOK_SECRET)
            throw new Error('❌ STRIPE_WEBHOOK_SECRET no está definida.');
        stripe = new stripe_1.default(key, { apiVersion: '2022-11-15' }); // más segura
    }
}
router.post('/', express_1.default.raw({ type: 'application/json' }), async (req, res) => {
    initStripe();
    const sig = req.headers['stripe-signature'];
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    }
    catch (err) {
        console.error('⚠️ Webhook signature error:', err);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    // ✅ Créditos individuales por canal
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const email = session.customer_email;
        if (session.mode === 'payment' &&
            session.metadata?.tenant_id &&
            session.metadata?.canal &&
            session.metadata?.cantidad) {
            const { tenant_id, canal, cantidad } = session.metadata;
            const cantidadInt = parseInt(cantidad, 10);
            if (!["sms", "email", "whatsapp", "contactos"].includes(canal))
                return;
            try {
                await db_1.default.query(`
          INSERT INTO uso_mensual (tenant_id, canal, mes, usados, limite)
          VALUES ($1, $2, date_trunc('month', CURRENT_DATE), 0, $3)
          ON CONFLICT (tenant_id, canal, mes)
          DO UPDATE SET limite = uso_mensual.limite + $3
        `, [tenant_id, canal, cantidadInt]);
                console.log(`✅ Créditos agregados: +${cantidadInt} a ${canal.toUpperCase()} para tenant ${tenant_id}`);
                if (email) {
                    await mailer_1.transporter.sendMail({
                        from: `"Amy AI" <${process.env.EMAIL_FROM}>`,
                        to: email,
                        subject: `Créditos ${canal.toUpperCase()} activados`,
                        html: `
              <h3>¡Créditos de ${canal.toUpperCase()} agregados!</h3>
              <p>Tu compra de <strong>${cantidadInt}</strong> créditos de <strong>${canal.toUpperCase()}</strong> fue procesada exitosamente.</p>
              <p>Ya puedes usarlos desde tu dashboard.</p>
              <br />
              <p>Gracias por confiar en <strong>Amy AI</strong> 💜</p>
            `
                    });
                }
            }
            catch (error) {
                console.error('❌ Error al agregar créditos comprados:', error);
            }
            return res.status(200).json({ received: true });
        }
        // 🧾 Activación de membresía por suscripción
        if (email && session.subscription) {
            try {
                const userRes = await db_1.default.query('SELECT uid FROM users WHERE email = $1', [email]);
                const user = userRes.rows[0];
                if (!user)
                    return;
                const subscriptionId = session.subscription;
                const subscription = await stripe.subscriptions.retrieve(subscriptionId);
                const vigencia = subscription.current_period_end
                    ? new Date(subscription.current_period_end * 1000)
                    : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // fallback
                await db_1.default.query(`
          UPDATE tenants
          SET membresia_activa = true,
              membresia_vigencia = $2,
              plan = 'pro'
          WHERE id = $1
        `, [user.uid, vigencia]);
                console.log(`🔁 Membresía activada para ${email}, vigencia hasta ${vigencia.toISOString()}`);
            }
            catch (error) {
                console.error('❌ Error activando membresía:', error);
            }
        }
    }
    // 🔁 Renovación automática de membresía
    if (event.type === 'invoice.payment_succeeded') {
        const invoice = event.data.object;
        const customerEmail = invoice.customer_email;
        if (!customerEmail)
            return;
        const subscriptionId = typeof invoice.subscription === 'string' ? invoice.subscription : null;
        if (!subscriptionId) {
            console.warn('⚠️ Subscription ID no encontrado en invoice.');
            return res.status(200).json({ received: true });
        }
        try {
            const subscription = await stripe.subscriptions.retrieve(subscriptionId);
            const nuevaVigencia = subscription.current_period_end
                ? new Date(subscription.current_period_end * 1000)
                : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // fallback
            const userRes = await db_1.default.query('SELECT uid FROM users WHERE email = $1', [customerEmail]);
            const user = userRes.rows[0];
            if (!user)
                return;
            await db_1.default.query(`
        UPDATE tenants
        SET membresia_activa = true,
            membresia_vigencia = $2
        WHERE id = $1
      `, [user.uid, nuevaVigencia]);
            console.log('🔁 Membresía renovada para', customerEmail);
        }
        catch (error) {
            console.error('❌ Error renovando membresía:', error);
        }
    }
    // ❌ Cancelación de suscripción
    if (event.type === 'customer.subscription.deleted') {
        const subscription = event.data.object;
        let customerEmail = null;
        try {
            const customerId = subscription.customer;
            if (typeof customerId === 'string') {
                const customer = await stripe.customers.retrieve(customerId);
                if (typeof customer !== 'string' && 'email' in customer && customer.email) {
                    customerEmail = customer.email;
                }
            }
        }
        catch (err) {
            console.warn('⚠️ No se pudo obtener email del cliente:', err);
        }
        if (!customerEmail)
            return;
        try {
            const userRes = await db_1.default.query('SELECT uid, tenant_id FROM users WHERE email = $1', [customerEmail]);
            const user = userRes.rows[0];
            if (!user)
                return;
            await db_1.default.query(`
        UPDATE tenants
        SET membresia_activa = false
        WHERE id = $1
      `, [user.uid]);
            await db_1.default.query(`
        INSERT INTO uso_mensual (tenant_id, canal, mes, usados, limite)
        VALUES ($1, 'contactos', date_trunc('month', CURRENT_DATE), 0, 500)
        ON CONFLICT (tenant_id, canal, mes)
        DO UPDATE SET limite = 500
      `, [user.tenant_id]);
            console.log('🛑 Suscripción cancelada y contactos reiniciados para', customerEmail);
            await mailer_1.transporter.sendMail({
                from: `"Amy AI" <${process.env.EMAIL_FROM}>`,
                to: customerEmail,
                subject: 'Suscripción cancelada',
                html: `
          <h3>Tu suscripción ha sido cancelada</h3>
          <p>Se ha cancelado tu suscripción en <strong>Amy AI</strong>.</p>
          <p>Tu límite de contactos ha sido reiniciado a 500.</p>
          <br />
          <p>Gracias por haber sido parte de Amy AI 💜</p>
        `
            });
        }
        catch (err) {
            console.error('❌ Error al cancelar membresía:', err);
        }
    }
    res.status(200).json({ received: true });
});
exports.default = router;
