"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const db_1 = __importDefault(require("../../lib/db"));
const auth_1 = require("../../middleware/auth");
const router = express_1.default.Router();
router.delete("/", auth_1.authenticateUser, async (req, res) => {
    const { tenant_id } = req.user;
    try {
        // Elimina todas las tablas relacionadas con el tenant
        await db_1.default.query("DELETE FROM mensajes_promocionales WHERE tenant_id = $1", [tenant_id]);
        await db_1.default.query("DELETE FROM campaign_usage WHERE tenant_id = $1", [tenant_id]);
        await db_1.default.query("DELETE FROM campanas WHERE tenant_id = $1", [tenant_id]);
        await db_1.default.query("DELETE FROM contactos WHERE tenant_id = $1", [tenant_id]);
        await db_1.default.query("DELETE FROM clientes WHERE tenant_id = $1", [tenant_id]);
        await db_1.default.query("DELETE FROM faqs WHERE tenant_id = $1", [tenant_id]);
        await db_1.default.query("DELETE FROM flows WHERE tenant_id = $1", [tenant_id]);
        await db_1.default.query("DELETE FROM follow_up_settings WHERE tenant_id = $1", [tenant_id]);
        await db_1.default.query("DELETE FROM intents WHERE tenant_id = $1", [tenant_id]);
        await db_1.default.query("DELETE FROM interactions WHERE tenant_id = $1", [tenant_id]);
        await db_1.default.query("DELETE FROM keywords WHERE tenant_id = $1", [tenant_id]);
        await db_1.default.query("DELETE FROM messages WHERE tenant_id = $1", [tenant_id]);
        await db_1.default.query("DELETE FROM prompts WHERE tenant_id = $1", [tenant_id]);
        await db_1.default.query("DELETE FROM sales_intelligence WHERE tenant_id = $1", [tenant_id]);
        await db_1.default.query("DELETE FROM voice_configs WHERE tenant_id = $1", [tenant_id]);
        // Eliminar usuario(s) y tenant
        await db_1.default.query("DELETE FROM users WHERE tenant_id = $1", [tenant_id]);
        await db_1.default.query("DELETE FROM tenants WHERE id = $1", [tenant_id]);
        res.status(200).json({ ok: true, message: "Cuenta eliminada correctamente." });
    }
    catch (err) {
        console.error("❌ Error al eliminar cuenta:", err);
        res.status(500).json({ error: "Error al eliminar la cuenta." });
    }
});
exports.default = router;
