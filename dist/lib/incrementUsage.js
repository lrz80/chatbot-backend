"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.incrementarUsoPorNumero = incrementarUsoPorNumero;
const db_1 = __importDefault(require("./db"));
async function incrementarUsoPorNumero(numero) {
    try {
        await db_1.default.query(`UPDATE tenants
       SET used = COALESCE(used, 0) + 1
       WHERE twilio_number = $1 OR twilio_sms_number = $1 OR twilio_voice_number = $1`, [numero]);
    }
    catch (error) {
        console.error('❌ Error al incrementar uso:', error);
    }
}
