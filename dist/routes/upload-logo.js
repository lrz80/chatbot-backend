"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const auth_1 = require("../middleware/auth");
const db_1 = __importDefault(require("../lib/db"));
const router = express_1.default.Router();
// 📁 Crear carpeta /uploads si no existe
const uploadsDir = path_1.default.join(__dirname, '../../uploads');
if (!fs_1.default.existsSync(uploadsDir)) {
    fs_1.default.mkdirSync(uploadsDir);
}
// 📸 Configuración de Multer
const storage = multer_1.default.diskStorage({
    destination: function (_, __, cb) {
        cb(null, uploadsDir);
    },
    filename: function (_, file, cb) {
        const ext = path_1.default.extname(file.originalname);
        const uniqueName = `logo-${Date.now()}${ext}`;
        cb(null, uniqueName);
    },
});
const upload = (0, multer_1.default)({ storage });
// ✅ POST: Subir logo del negocio
router.post('/', auth_1.authenticateUser, upload.single('logo'), async (req, res) => {
    try {
        const tenant_id = req.user?.tenant_id;
        if (!tenant_id)
            return res.status(401).json({ error: 'No autenticado' });
        if (!req.file)
            return res.status(400).json({ error: 'No se subió archivo' });
        const logo_url = `${process.env.BASE_URL}/uploads/${req.file.filename}`;
        await db_1.default.query('UPDATE tenants SET logo_url = $1 WHERE id = $2', [logo_url, tenant_id]);
        res.status(200).json({ logo_url });
    }
    catch (err) {
        console.error('❌ Error al subir logo:', err);
        res.status(500).json({ error: 'Error al subir logo' });
    }
});
exports.default = router;
