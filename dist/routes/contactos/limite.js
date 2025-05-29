"use strict";
// src/routes/contactos/limite.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const db_1 = __importDefault(require("../../lib/db"));
const router = (0, express_1.Router)();
router.get("/", async (req, res) => {
    const token = req.cookies.token;
    if (!token)
        return res.status(401).json({ error: "Token requerido" });
    try {
        const decoded = jsonwebtoken_1.default.verify(token, process.env.JWT_SECRET);
        const userRes = await db_1.default.query("SELECT tenant_id FROM users WHERE uid = $1", [decoded.uid]);
        const tenantId = userRes.rows[0]?.tenant_id;
        if (!tenantId)
            return res.status(404).json({ error: "Tenant no encontrado" });
        // 🔄 Leer uso mensual de contactos
        const usoRes = await db_1.default.query(`
      SELECT usados, limite
      FROM uso_mensual
      WHERE tenant_id = $1 AND canal = 'contactos' AND mes = date_trunc('month', CURRENT_DATE)
    `, [tenantId]);
        const usados = usoRes.rows[0]?.usados ?? 0;
        const limite = usoRes.rows[0]?.limite ?? 500;
        res.json({ limite, total: usados });
    }
    catch (err) {
        console.error("❌ Error en /contactos/limite:", err);
        res.status(500).json({ error: "Error interno" });
    }
});
exports.default = router;
