import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { authenticateUser } from '../middleware/auth';
import pool from '../lib/db';

const router = express.Router();

// Crear carpeta /uploads si no existe
const uploadsDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

// Configuración de Multer
const storage = multer.diskStorage({
  destination: function (_, __, cb) {
    cb(null, uploadsDir);
  },
  filename: function (_, file, cb) {
    const ext = path.extname(file.originalname);
    const uniqueName = `logo-${Date.now()}${ext}`;
    cb(null, uniqueName);
  },
});

const upload = multer({ storage });

// ✅ Ruta para subir el logo
router.post('/', authenticateUser, upload.single('logo'), async (req: any, res) => {
  try {
    const tenant_id = req.user?.tenant_id;
    if (!tenant_id) return res.status(401).json({ error: 'No autenticado' });

    if (!req.file) return res.status(400).json({ error: 'No se subió archivo' });

    const logo_url = `/uploads/${req.file.filename}`;

    await pool.query('UPDATE tenants SET logo_url = $1 WHERE id = $2', [logo_url, tenant_id]);

    res.status(200).json({ logo_url });
  } catch (err) {
    console.error('❌ Error al subir logo:', err);
    res.status(500).json({ error: 'Error al subir logo' });
  }
});

export default router;
