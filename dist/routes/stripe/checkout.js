"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const stripe_1 = __importDefault(require("stripe"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const db_1 = __importDefault(require("../../lib/db"));
const router = express_1.default.Router();
const stripe = new stripe_1.default(process.env.STRIPE_SECRET_KEY);
// POST /api/stripe/checkout
router.post('/checkout', async (req, res) => {
    const token = req.cookies.token;
    if (!token) {
        return res.status(401).json({ error: 'No autorizado. Token requerido.' });
    }
    try {
        const decoded = jsonwebtoken_1.default.verify(token, process.env.JWT_SECRET);
        const uid = decoded.uid;
        // Obtener el correo del usuario
        const result = await db_1.default.query('SELECT email FROM users WHERE uid = $1', [uid]);
        const user = result.rows[0];
        if (!user) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            mode: 'subscription',
            customer_email: user.email,
            line_items: [
                {
                    price: 'price_1R8C4K05RmqANw5eLQo1xPMU', // ✅ tu price_id real
                    quantity: 1,
                },
            ],
            subscription_data: {
                trial_period_days: 7, // ✅ prueba de 7 días
            },
            success_url: 'https://www.aamy.ai/dashboard?success=1',
            cancel_url: 'https://www.aamy.ai/upgrade?canceled=1',
        });
        res.json({ url: session.url });
    }
    catch (error) {
        console.error('❌ Error creando sesión de Stripe:', error);
        res.status(500).json({ error: 'Error al crear la sesión de pago' });
    }
});
exports.default = router;
