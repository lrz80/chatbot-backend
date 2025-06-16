"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const db_1 = __importDefault(require("../../lib/db"));
const router = express_1.default.Router();
router.get('/', async (req, res) => {
    try {
        const { rows } = await db_1.default.query(`
      SELECT LOWER(TRIM(canal)) AS canal, COUNT(DISTINCT message_id) AS total
      FROM messages
      WHERE role = 'user'
      GROUP BY canal
    `);
        const conteo = {
            whatsapp: 0,
            facebook: 0,
            instagram: 0,
            voz: 0, // Usamos "voz" si en la base de datos se guarda así
        };
        for (const row of rows) {
            const canal = row.canal;
            if (canal === 'voice') {
                conteo.voz = parseInt(row.total);
            }
            else if (conteo.hasOwnProperty(canal)) {
                conteo[canal] = parseInt(row.total);
            }
        }
        res.json(conteo);
    }
    catch (err) {
        console.error('❌ Error al obtener conteo global:', err);
        res.status(500).json({ error: 'Error al obtener conteo' });
    }
});
exports.default = router;
