"use strict";
// 📁 src/lib/getRespuestaDesdeFlows.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRespuestaDesdeFlows = getRespuestaDesdeFlows;
const db_1 = __importDefault(require("./db"));
async function getRespuestaDesdeFlows(tenant_id, userMessage) {
    try {
        const result = await db_1.default.query('SELECT data FROM flows WHERE tenant_id = $1', [tenant_id]);
        if (result.rows.length === 0)
            return null;
        const flujos = result.rows[0].data;
        const mensajePrincipal = flujos?.[0]?.mensaje || '';
        const opciones = flujos?.[0]?.opciones || [];
        // Busca coincidencia directa con alguna opción del primer nivel
        const opcion = opciones.find((op) => userMessage.toLowerCase().includes(op.texto.toLowerCase()));
        if (opcion) {
            if (opcion.respuesta) {
                return opcion.respuesta;
            }
            if (opcion.submenu) {
                return opcion.submenu.mensaje;
            }
        }
        // Si no hay coincidencia, devuelve null para fallback a OpenAI
        return null;
    }
    catch (err) {
        console.error('❌ Error en getRespuestaDesdeFlows:', err);
        return null;
    }
}
