"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = __importDefault(require("../../lib/db"));
const incrementUsage_1 = require("../../lib/incrementUsage");
const router = (0, express_1.Router)();
router.post('/', async (req, res) => {
    const from = req.body.From || '';
    const to = req.body.To || '';
    const userInput = req.body.Body || '';
    const fromNumber = from.replace('tel:', '');
    const toNumber = to.replace('tel:', '');
    try {
        const tenantRes = await db_1.default.query('SELECT * FROM tenants WHERE twilio_sms_number = $1', [toNumber]);
        const tenant = tenantRes.rows[0];
        if (!tenant)
            return res.sendStatus(404);
        console.log(`📩 SMS recibido de ${fromNumber} para tenant ${tenant.name}`);
        // 💾 Guardar mensaje del usuario
        await db_1.default.query(`INSERT INTO messages (tenant_id, sender, content, timestamp, canal, from_number)
       VALUES ($1, 'user', $2, NOW(), 'sms', $3)`, [tenant.id, userInput, fromNumber]);
        // 🔢 Incrementar uso real
        await (0, incrementUsage_1.incrementarUsoPorNumero)(toNumber);
        // 📨 Respuesta básica
        res.type('text/xml');
        res.send(`<Response><Message>Recibido por SMS ✅</Message></Response>`);
    }
    catch (err) {
        console.error('❌ Error SMS Webhook:', err);
        res.sendStatus(500);
    }
});
exports.default = router;
