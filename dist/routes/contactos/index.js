"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const db_1 = __importDefault(require("../../lib/db"));
const auth_1 = require("../../middleware/auth");
const router = express_1.default.Router();
// ✅ Configuración de subida de archivos CSV
const storage = multer_1.default.diskStorage({
    destination: (req, file, cb) => {
        const dir = path_1.default.join(__dirname, "../../../uploads");
        if (!fs_1.default.existsSync(dir))
            fs_1.default.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const uniqueName = Date.now() + "-" + file.originalname;
        cb(null, uniqueName);
    },
});
const upload = (0, multer_1.default)({ storage });
// 📥 Subir archivo CSV de contactos
router.post("/", auth_1.authenticateUser, upload.single("file"), async (req, res) => {
    const { tenant_id } = req.user;
    if (!req.file)
        return res.status(400).json({ error: "Archivo no proporcionado." });
    try {
        const content = fs_1.default.readFileSync(req.file.path, "utf8");
        const lines = content
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith("#"));
        if (lines.length < 2)
            return res.status(400).json({ error: "El archivo está vacío o mal formado." });
        const headers = lines[0].toLowerCase().split(",").map((h) => h.replace(/"/g, "").trim());
        const dataLines = lines.slice(1);
        // ✅ Obtener uso mensual actual de contactos
        const usoRes = await db_1.default.query(`
      SELECT usados, limite
      FROM uso_mensual
      WHERE tenant_id = $1 AND canal = 'contactos' AND mes = date_trunc('month', CURRENT_DATE)
    `, [tenant_id]);
        let usados = usoRes.rows[0]?.usados ?? 0;
        let limite = usoRes.rows[0]?.limite ?? 500;
        const disponibles = limite - usados;
        if (disponibles <= 0) {
            return res.status(403).json({ error: "Ya has alcanzado tu límite mensual de contactos." });
        }
        const acciones = [];
        let nuevos = 0;
        for (const line of dataLines.slice(0, disponibles)) {
            acciones.push((async () => {
                try {
                    const cols = line.split(",").map((c) => c.replace(/"/g, "").trim());
                    const firstName = cols[headers.indexOf("nombre")] || cols[headers.indexOf("first name")] || "";
                    const lastName = cols[headers.indexOf("last name")] || "";
                    const nombre = `${firstName} ${lastName}`.trim() || "Sin nombre";
                    const telefono = cols[headers.indexOf("telefono")] || cols[headers.indexOf("phone")] || "";
                    const email = cols[headers.indexOf("email")] || "";
                    const segmento = cols[headers.indexOf("segmento")]?.toLowerCase() || "cliente";
                    if (!telefono && !email)
                        return;
                    const existe = await db_1.default.query("SELECT id FROM contactos WHERE tenant_id = $1 AND (telefono = $2 OR email = $3)", [tenant_id, telefono, email]);
                    if ((existe?.rowCount ?? 0) > 0) {
                        const id = existe.rows[0].id;
                        await db_1.default.query("UPDATE contactos SET nombre = $1, segmento = $2 WHERE id = $3", [nombre, segmento, id]);
                    }
                    else {
                        await db_1.default.query(`INSERT INTO contactos (tenant_id, nombre, telefono, email, segmento, fecha_creacion)
               VALUES ($1, $2, $3, $4, $5, NOW())`, [tenant_id, nombre, telefono, email, segmento]);
                        nuevos++;
                    }
                }
                catch (err) {
                    console.warn("❌ Error procesando fila:", line, err);
                }
            })());
        }
        await Promise.all(acciones);
        // ✅ Sumar los nuevos al conteo mensual
        await db_1.default.query(`
      INSERT INTO uso_mensual (tenant_id, canal, mes, usados, limite)
      VALUES ($1, 'contactos', date_trunc('month', CURRENT_DATE), $2, 500)
      ON CONFLICT (tenant_id, canal, mes)
      DO UPDATE SET usados = uso_mensual.usados + $2
    `, [tenant_id, nuevos]);
        res.json({ ok: true, nuevos, mensaje: `Se procesaron ${nuevos} contactos nuevos.` });
    }
    catch (err) {
        console.error("❌ Error al subir contactos:", err);
        res.status(500).json({ error: "Error al procesar archivo." });
    }
});
// 🧼 Eliminar todos los contactos del tenant
router.delete("/", auth_1.authenticateUser, async (req, res) => {
    const { tenant_id } = req.user;
    try {
        await db_1.default.query("DELETE FROM contactos WHERE tenant_id = $1", [tenant_id]);
        res.json({ ok: true, message: "Contactos eliminados correctamente." });
    }
    catch (err) {
        console.error("❌ Error al eliminar contactos:", err);
        res.status(500).json({ error: "Error al eliminar contactos." });
    }
});
// 📦 Obtener todos los contactos del tenant
router.get("/", auth_1.authenticateUser, async (req, res) => {
    const { tenant_id } = req.user;
    try {
        const result = await db_1.default.query("SELECT nombre, telefono, email, segmento FROM contactos WHERE tenant_id = $1", [tenant_id]);
        res.json(result.rows);
    }
    catch (err) {
        console.error("❌ Error al obtener contactos:", err);
        res.status(500).json({ error: "Error al obtener contactos" });
    }
});
// 🔢 Contar contactos
router.get("/count", auth_1.authenticateUser, async (req, res) => {
    const { tenant_id } = req.user;
    try {
        const result = await db_1.default.query("SELECT COUNT(*)::int AS total FROM contactos WHERE tenant_id = $1", [tenant_id]);
        res.json({ total: result.rows[0].total });
    }
    catch (err) {
        console.error("❌ Error al contar contactos:", err);
        res.status(500).json({ error: "Error al contar contactos." });
    }
});
exports.default = router;
