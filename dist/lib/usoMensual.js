"use strict";
// src/lib/usoMensual.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.obtenerUsoActual = obtenerUsoActual;
const db_1 = __importDefault(require("./db")); // ajusta si estás en otra ruta
async function obtenerUsoActual(tenantId, canal) {
    const res = await db_1.default.query(`SELECT usados, limite FROM uso_mensual
     WHERE tenant_id = $1 AND canal = $2 AND mes = date_trunc('month', NOW() AT TIME ZONE 'America/New_York')`, [tenantId, canal]);
    return res.rows[0] || { usados: 0, limite: canal === 'sms' ? 500 : 1000 }; // puedes ajustar límites por defecto
}
