"use strict";
// src/routes/upload-logo.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const multer_1 = __importDefault(require("multer"));
const cloudinary_1 = require("cloudinary");
const auth_1 = require("../middleware/auth");
const db_1 = __importDefault(require("../lib/db"));
const router = express_1.default.Router();
const upload = (0, multer_1.default)({ storage: multer_1.default.memoryStorage() });
cloudinary_1.v2.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});
// ✅ POST: Subir logo del negocio a Cloudinary
router.post('/', auth_1.authenticateUser, upload.single('logo'), async (req, res) => {
    const tenant_id = req.user?.tenant_id;
    if (!req.file)
        return res.status(400).json({ error: 'No se subió archivo' });
    try {
        const uploadStream = cloudinary_1.v2.uploader.upload_stream({
            folder: `aamy/logos/${tenant_id}`,
            public_id: `logo_${Date.now()}`,
            resource_type: 'image',
        }, async (error, result) => {
            if (error || !result) {
                console.error('❌ Error al subir a Cloudinary:', error);
                return res.status(500).json({ error: 'Error al subir imagen' });
            }
            const logo_url = result.secure_url;
            await db_1.default.query('UPDATE tenants SET logo_url = $1 WHERE id = $2', [logo_url, tenant_id]);
            return res.status(200).json({ logo_url });
        });
        uploadStream.end(req.file.buffer);
    }
    catch (err) {
        console.error('❌ Error general al subir logo:', err);
        res.status(500).json({ error: 'Error inesperado' });
    }
});
exports.default = router;
