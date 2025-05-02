// src/routes/upload-logo.ts

import express from 'express';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { authenticateUser } from '../middleware/auth';
import pool from '../lib/db';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME!,
  api_key: process.env.CLOUDINARY_API_KEY!,
  api_secret: process.env.CLOUDINARY_API_SECRET!,
});

// ✅ POST: Subir logo del negocio a Cloudinary
router.post('/', authenticateUser, upload.single('logo'), async (req: any, res) => {
  const tenant_id = req.user?.tenant_id;

  if (!req.file) return res.status(400).json({ error: 'No se subió archivo' });

  try {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: `aamy/logos/${tenant_id}`,
        public_id: `logo_${Date.now()}`,
        resource_type: 'image',
      },
      async (error, result) => {
        if (error || !result) {
          console.error('❌ Error al subir a Cloudinary:', error);
          return res.status(500).json({ error: 'Error al subir imagen' });
        }

        const logo_url = result.secure_url;

        await pool.query('UPDATE tenants SET logo_url = $1 WHERE id = $2', [logo_url, tenant_id]);

        return res.status(200).json({ logo_url });
      }
    );

    uploadStream.end(req.file.buffer);
  } catch (err) {
    console.error('❌ Error general al subir logo:', err);
    res.status(500).json({ error: 'Error inesperado' });
  }
});

export default router;
