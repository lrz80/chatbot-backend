"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const db_1 = __importDefault(require("../lib/db"));
const auth_1 = require("../middleware/auth");
const router = express_1.default.Router();
// ✅ GET /api/flows
router.get("/api/flows", auth_1.authenticateUser, async (req, res) => {
    try {
        const { tenant_id } = req.user;
        const result = await db_1.default.query("SELECT data FROM flows WHERE tenant_id = $1", [tenant_id]);
        res.json(result.rows[0]?.data || []);
    }
    catch (err) {
        console.error("❌ Error al obtener flujos:", err);
        res.status(500).json({ error: "Error interno" });
    }
});
// ✅ POST /api/flows
router.post("/api/flows", auth_1.authenticateUser, async (req, res) => {
    try {
        const { tenant_id } = req.user;
        const flows = req.body.flows;
        if (!Array.isArray(flows)) {
            return res.status(400).json({ error: "Formato de flujos inválido" });
        }
        await db_1.default.query(`INSERT INTO flows (tenant_id, data, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (tenant_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`, [tenant_id, JSON.stringify(flows)]);
        res.json({ success: true });
    }
    catch (err) {
        console.error("❌ Error al guardar flujos:", err);
        res.status(500).json({ error: "Error interno" });
    }
});
exports.default = router;
