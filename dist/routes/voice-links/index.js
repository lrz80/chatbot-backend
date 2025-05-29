"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const db_1 = __importDefault(require("../../lib/db"));
const auth_1 = require("../../middleware/auth");
const router = express_1.default.Router();
// 📥 Obtener links útiles
router.get("/", auth_1.authenticateUser, async (req, res) => {
    const { tenant_id } = req.user;
    try {
        const result = await db_1.default.query(`SELECT * FROM links_utiles
       WHERE tenant_id = $1
       ORDER BY created_at DESC`, [tenant_id]);
        res.json(result.rows);
    }
    catch (err) {
        console.error("❌ Error al obtener links útiles:", err);
        res.status(500).json({ error: "Error al obtener links útiles." });
    }
});
// 📤 Agregar nuevo link útil
router.post("/", auth_1.authenticateUser, async (req, res) => {
    const { tenant_id } = req.user;
    const { tipo, nombre, url } = req.body;
    if (!tipo || !nombre || !url) {
        return res.status(400).json({ error: "Todos los campos son requeridos." });
    }
    try {
        await db_1.default.query(`INSERT INTO links_utiles (tenant_id, tipo, nombre, url)
       VALUES ($1, $2, $3, $4)`, [tenant_id, tipo, nombre, url]);
        const result = await db_1.default.query(`SELECT * FROM links_utiles
       WHERE tenant_id = $1
       ORDER BY created_at DESC`, [tenant_id]);
        res.json(result.rows);
    }
    catch (err) {
        console.error("❌ Error al guardar link útil:", err);
        res.status(500).json({ error: "Error al guardar link útil." });
    }
});
// 🗑️ Eliminar link útil
router.delete("/:id", auth_1.authenticateUser, async (req, res) => {
    const { tenant_id } = req.user;
    const linkId = parseInt(req.params.id);
    try {
        await db_1.default.query(`DELETE FROM links_utiles
       WHERE id = $1 AND tenant_id = $2`, [linkId, tenant_id]);
        res.status(200).json({ ok: true });
    }
    catch (err) {
        console.error("❌ Error al eliminar link útil:", err);
        res.status(500).json({ error: "Error al eliminar link." });
    }
});
exports.default = router;
