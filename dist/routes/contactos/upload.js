"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const multer_1 = __importDefault(require("multer"));
const csv_parser_1 = __importDefault(require("csv-parser"));
const db_1 = __importDefault(require("../../lib/db"));
const auth_1 = require("../../middleware/auth");
const stream_1 = require("stream");
const router = express_1.default.Router();
const upload = (0, multer_1.default)();
function mapRow(row) {
    const nombre = row["nombre"] || `${row["First Name"] || ""} ${row["Last Name"] || ""}`.trim();
    const email = row["email"] || row["Email"] || row["E-mail"];
    const telefono = row["telefono"] || row["Phone"] || row["Teléfono"];
    const segmento = row["segmento"] || row["Category"] || row["Label"] || "leads";
    return { nombre, email, telefono, segmento };
}
router.post("/upload", auth_1.authenticateUser, upload.single("file"), async (req, res) => {
    const { tenant_id } = req.user;
    if (!req.file) {
        return res.status(400).json({ error: "Archivo no proporcionado." });
    }
    const contactos = [];
    try {
        const existing = await db_1.default.query("SELECT COUNT(*) FROM contactos WHERE tenant_id = $1", [tenant_id]);
        const existentes = parseInt(existing.rows[0].count || "0", 10);
        const stream = stream_1.Readable.from(req.file.buffer);
        await new Promise((resolve, reject) => {
            stream
                .pipe((0, csv_parser_1.default)())
                .on("data", (row) => {
                const contacto = mapRow(row);
                if (contacto.email || contacto.telefono) {
                    contactos.push(contacto);
                }
            })
                .on("end", resolve)
                .on("error", reject);
        });
        if (contactos.length + existentes > 1500) {
            return res.status(400).json({ error: "Máximo 1500 contactos permitidos por tenant." });
        }
        const existentesQuery = await db_1.default.query("SELECT telefono, email FROM contactos WHERE tenant_id = $1", [tenant_id]);
        const existentesMap = new Set(existentesQuery.rows.map((r) => r.telefono + "|" + r.email));
        const nuevosUnicos = contactos.filter((c) => {
            const clave = (c.telefono || "") + "|" + (c.email || "");
            if (existentesMap.has(clave))
                return false;
            existentesMap.add(clave);
            return true;
        });
        for (const contacto of nuevosUnicos) {
            await db_1.default.query(`INSERT INTO contactos (tenant_id, nombre, email, telefono, segmento)
         VALUES ($1, $2, $3, $4, $5)`, [
                tenant_id,
                contacto.nombre || null,
                contacto.email || null,
                contacto.telefono || null,
                contacto.segmento || null,
            ]);
        }
        res.status(200).json({ ok: true, nuevos: nuevosUnicos.length });
    }
    catch (err) {
        console.error("❌ Error al subir contactos:", err);
        res.status(500).json({ error: "Error al procesar archivo CSV." });
    }
});
exports.default = router;
