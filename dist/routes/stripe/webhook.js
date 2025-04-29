"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const stripe_1 = __importDefault(require("stripe"));
const db_1 = __importDefault(require("../../lib/db"));
const mailer_1 = require("../../lib/mailer");
const router = express_1.default.Router();
const stripe = new stripe_1.default(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2025-03-31.basil',
});
router.post('/', express_1.default.raw({ type: 'application/json' }), async (req, res) => {
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
    const sig = req.headers['stripe-signature'];
    if (!endpointSecret) {
        console.error('❌ Falta STRIPE_WEBHOOK_SECRET en .env');
        return res.status(500).json({ error: 'Configuración incompleta' });
    }
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    }
    catch (err) {
        console.error('⚠️ Webhook error:', err);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    // ✅ Activación inicial por checkout
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const email = session.customer_email;
        try {
            const userRes = await db_1.default.query('SELECT uid, owner_name FROM users WHERE email = $1', [email]);
            const user = userRes.rows[0];
            if (!user)
                return;
            const uid = user.uid;
            const tenantName = user.owner_name || 'Negocio sin nombre';
            const vigencia = new Date();
            vigencia.setDate(vigencia.getDate() + 30);
            const tenantCheck = await db_1.default.query('SELECT * FROM tenants WHERE admin_uid = $1', [uid]);
            if (tenantCheck.rows.length === 0) {
                await db_1.default.query(`
          INSERT INTO tenants (
            admin_uid, name, membresia_activa, membresia_vigencia, used, plan
          ) VALUES ($1, $2, true, $3, 0, 'pro')
        `, [uid, tenantName, vigencia]);
                console.log('✅ Tenant creado con membresía activa para', email);
            }
            else {
                await db_1.default.query(`
          UPDATE tenants
          SET membresia_activa = true,
              membresia_vigencia = $2
          WHERE admin_uid = $1
        `, [uid, vigencia]);
                console.log('🔁 Membresía activada para', email);
            }
        }
        catch (error) {
            console.error('❌ Error activando membresía:', error);
        }
    }
    // 🔁 Renovación mensual automática
    if (event.type === 'invoice.payment_succeeded') {
        const invoice = event.data.object;
        const customerEmail = invoice.customer_email || null;
        if (!customerEmail)
            return;
        try {
            const userRes = await db_1.default.query('SELECT uid FROM users WHERE email = $1', [customerEmail]);
            const user = userRes.rows[0];
            if (!user)
                return;
            const uid = user.uid;
            const nuevaVigencia = new Date();
            nuevaVigencia.setDate(nuevaVigencia.getDate() + 30);
            await db_1.default.query(`
        UPDATE tenants
        SET membresia_activa = true,
            membresia_vigencia = $2
        WHERE admin_uid = $1
      `, [uid, nuevaVigencia]);
            console.log('🔁 Membresía renovada para', customerEmail);
        }
        catch (error) {
            console.error('❌ Error renovando membresía:', error);
        }
    }
    // ❌ Cancelación automática
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
            console.warn('⚠️ No se pudo obtener email del cliente para cancelación');
        }
        if (!customerEmail)
            return;
        try {
            const userRes = await db_1.default.query('SELECT uid FROM users WHERE email = $1', [customerEmail]);
            const user = userRes.rows[0];
            if (!user)
                return;
            const uid = user.uid;
            await db_1.default.query(`
        UPDATE tenants
        SET membresia_activa = false
        WHERE admin_uid = $1
      `, [uid]);
            console.log('🛑 Membresía cancelada para', customerEmail);
            await mailer_1.transporter.sendMail({
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
        }
        catch (err) {
            console.error('❌ Error desactivando membresía:', err);
        }
    }
    res.status(200).json({ received: true });
});
exports.default = router;
