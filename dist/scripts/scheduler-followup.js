"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const db_1 = __importDefault(require("../lib/db"));
const detectarIdioma_1 = require("../lib/detectarIdioma");
const traducirTexto_1 = require("../lib/traducirTexto");
const whatsapp_1 = require("../lib/senders/whatsapp");
const express_1 = __importDefault(require("express"));
// 🕒 Scheduler de mensajes programados para follow-up
async function enviarMensajesProgramados() {
    const ahora = new Date().toISOString();
    try {
        const res = await db_1.default.query(`SELECT * FROM mensajes_programados
       WHERE enviado = false AND fecha_envio <= $1
       ORDER BY fecha_envio ASC
       LIMIT 10`, [ahora]);
        const mensajes = res.rows;
        if (mensajes.length === 0) {
            console.log("📭 No hay mensajes pendientes para enviar.");
            return;
        }
        for (const mensaje of mensajes) {
            try {
                // 🛡️ Marcar como enviado primero
                await db_1.default.query(`UPDATE mensajes_programados SET enviado = true WHERE id = $1`, [mensaje.id]);
                // ❌ Validar canal
                if (mensaje.canal !== 'whatsapp') {
                    console.warn(`❌ Canal no compatible: ${mensaje.canal}`);
                    continue;
                }
                // ❌ Validar formato internacional del número
                if (!mensaje.contacto.startsWith('+')) {
                    console.warn(`❌ Número inválido: ${mensaje.contacto}`);
                    continue;
                }
                // 🧠 Detectar idioma (opcional)
                const ultimoMsg = await db_1.default.query(`SELECT content FROM messages
           WHERE tenant_id = $1 AND canal = 'whatsapp' AND role = 'user' AND from_number = $2
           ORDER BY timestamp DESC LIMIT 1`, [mensaje.tenant_id, mensaje.contacto]);
                const mensajeCliente = ultimoMsg.rows[0]?.content || mensaje.contenido;
                const idioma = await (0, detectarIdioma_1.detectarIdioma)(mensajeCliente);
                const contenidoTraducido = await (0, traducirTexto_1.traducirTexto)(mensaje.contenido, idioma);
                // 📤 Enviar mensaje
                await (0, whatsapp_1.enviarWhatsApp)(mensaje.contacto, contenidoTraducido, mensaje.tenant_id);
                console.log(`✅ Mensaje enviado a ${mensaje.contacto} (idioma: ${idioma})`);
                // 🔄 Incrementar uso mensual de followup
                const { rows: tenantRows } = await db_1.default.query(`SELECT membresia_inicio FROM tenants WHERE id = $1`, [mensaje.tenant_id]);
                const membresiaInicio = tenantRows[0]?.membresia_inicio;
                if (!membresiaInicio) {
                    console.warn(`❌ No se encontró membresia_inicio para tenant ${mensaje.tenant_id}`);
                    continue;
                }
                const inicio = new Date(membresiaInicio);
                const ahoraFecha = new Date();
                const diffInMonths = Math.floor((ahoraFecha.getFullYear() - inicio.getFullYear()) * 12 + (ahoraFecha.getMonth() - inicio.getMonth()));
                const cicloInicio = new Date(inicio);
                cicloInicio.setMonth(inicio.getMonth() + diffInMonths);
                const cicloMes = cicloInicio.toISOString().split('T')[0];
                await db_1.default.query(`INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
           VALUES ($1, 'followup', $2, 1)
           ON CONFLICT (tenant_id, canal, mes) DO UPDATE SET usados = uso_mensual.usados + 1`, [mensaje.tenant_id, cicloMes]);
                console.log(`🔄 Uso mensual followup incrementado para tenant ${mensaje.tenant_id}, ciclo ${cicloMes}`);
            }
            catch (error) {
                console.error(`❌ Error enviando mensaje a ${mensaje.contacto}:`, error);
            }
        }
    }
    catch (err) {
        console.error("❌ Error general en enviarMensajesProgramados:", err);
    }
}
// 🕒 Scheduler corriendo cada minuto
setInterval(() => {
    enviarMensajesProgramados();
}, 60 * 1000);
console.log("⏰ Scheduler de follow-up corriendo cada minuto...");
const app = (0, express_1.default)();
const PORT = process.env.PORT || 3003;
app.get('/', (_req, res) => {
    res.send('🟢 Follow-up scheduler is running...');
});
app.listen(PORT, () => {
    console.log(`🚀 Follow-up scheduler activo en http://localhost:${PORT}`);
});
