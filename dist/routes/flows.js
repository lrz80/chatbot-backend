"use strict";
// src/routes/flows.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const db_1 = __importDefault(require("../lib/db"));
const auth_1 = require("../middleware/auth");
const router = express_1.default.Router();
// ✅ GET /api/flows
router.get("/", auth_1.authenticateUser, async (req, res) => {
    try {
        console.log("👤 Usuario autenticado:", req.user);
        const tenant_id = req.user?.tenant_id;
        if (!tenant_id) {
            return res.status(401).json({ error: "Tenant no autenticado" });
        }
        const result = await db_1.default.query("SELECT data FROM flows WHERE tenant_id = $1", [tenant_id]);
        res.json(result.rows[0]?.data || []);
    }
    catch (err) {
        console.error("❌ Error al obtener flujos:", err);
        res.status(500).json({ error: "Error interno" });
    }
});
// ✅ POST /api/flows
router.post("/", auth_1.authenticateUser, async (req, res) => {
    try {
        console.log("🧠 Middleware req.user:", req.user);
        console.log("👤 Usuario autenticado:", req.user);
        console.log("🛬 Llamada al POST /api/flows");
        console.log("📥 Cuerpo recibido:", req.body);
        const tenant_id = req.user?.tenant_id;
        if (!tenant_id) {
            return res.status(401).json({ error: "Tenant no autenticado" });
        }
        const flows = req.body.flows;
        if (!Array.isArray(flows)) {
            return res.status(400).json({ error: "Formato de flujos inválido" });
        }
        console.log("📥 Flujos recibidos:", JSON.stringify(flows, null, 2)); // 👈 opcional para debug
        await db_1.default.query(`INSERT INTO flows (tenant_id, data, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (tenant_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`, [tenant_id, JSON.stringify(flows)] // 👈 sin stringify
        );
        res.json({ success: true });
    }
    catch (err) {
        console.error("❌ Error al guardar flujos:", err);
        res.status(500).json({ error: "Error interno" });
    }
});
exports.default = router;
