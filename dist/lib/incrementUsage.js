"use strict";
// src/lib/incrementUsage.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.incrementarUsoPorNumero = incrementarUsoPorNumero;
const db_1 = __importDefault(require("./db"));
async function incrementarUsoPorNumero(numero, canal = 'whatsapp') {
    try {
        const tenantRes = await db_1.default.query(`SELECT id FROM tenants
       WHERE twilio_number = $1 OR twilio_sms_number = $1 OR twilio_voice_number = $1
       LIMIT 1`, [numero]);
        const tenantId = tenantRes.rows[0]?.id;
        if (!tenantId)
            return;
        await db_1.default.query(`INSERT INTO uso_mensual (tenant_id, canal, mes, usados, limite)
       VALUES ($1, $2, date_trunc('month', CURRENT_DATE), 1, 500)
       ON CONFLICT (tenant_id, canal, mes)
       DO UPDATE SET usados = uso_mensual.usados + 1`, [tenantId, canal]);
    }
    catch (error) {
        console.error('❌ Error al incrementar uso mensual:', error);
    }
}
