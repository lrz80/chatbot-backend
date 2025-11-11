// src/routes/meta-config.ts
import { Router, Request, Response } from 'express';
import pool from '../lib/db';
import jwt, { JwtPayload } from 'jsonwebtoken';
import axios from 'axios'; // 👈 nuevo

const APP_ID = process.env.FB_APP_ID || '';
const APP_SECRET = process.env.FB_APP_SECRET || '';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';

// GET: obtener configuración meta del tenant
router.get('/', async (req: Request, res: Response) => {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Token requerido' });
  
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
      const userRes = await pool.query('SELECT tenant_id FROM users WHERE uid = $1', [decoded.uid]);
      const tenantId = userRes.rows[0]?.tenant_id;
      if (!tenantId) return res.status(404).json({ error: 'Usuario sin tenant asociado' });
  
      const configRes = await pool.query(`
        SELECT 
          funciones_asistente,
          info_clave,
          prompt_meta        AS prompt, 
          bienvenida_meta    AS bienvenida, 
          idioma
        FROM meta_configs
        WHERE tenant_id = $1
        LIMIT 1
      `, [tenantId]);
      
      const config = configRes.rows[0] || {};
  
      const tenantRes = await pool.query(`
        SELECT 
          facebook_page_id, 
          facebook_page_name, 
          instagram_page_id, 
          instagram_page_name, 
          membresia_activa,
          facebook_access_token       -- 👈 nuevo
        FROM tenants 
        WHERE id = $1 
        LIMIT 1
      `, [tenantId]);

      const tenant = tenantRes.rows[0] || {};

      // 👉 Determinar estado de conexión y si requiere reconexión
      const hasPageId = Boolean(tenant.facebook_page_id || tenant.instagram_page_id);
      let needsReconnect = false;

      if (tenant.facebook_access_token) {
        try {
          // Prueba simple: /me con el PAGE TOKEN
          await axios.get('https://graph.facebook.com/v19.0/me', {
            params: { access_token: tenant.facebook_access_token },
            timeout: 6000,
          });
        } catch (e: any) {
          const code = e?.response?.data?.error?.code;
          if (code === 190) {
            // Token inválido/caducado
            needsReconnect = true;
          } else {
            // Otros errores de red/API: no marcamos como reconexión, solo registramos
            console.warn('⚠️ Chequeo token FB falló (no 190):', e?.response?.data || e?.message);
          }
        }
      }

      return res.status(200).json({
        ...config,
        facebook_page_id: tenant.facebook_page_id,
        facebook_page_name: tenant.facebook_page_name,
        instagram_page_id: tenant.instagram_page_id,
        instagram_page_name: tenant.instagram_page_name,
        membresia_activa: tenant.membresia_activa, // ✅ AÑADIDO
        connected: hasPageId,          // 👈 nuevo
        needs_reconnect: needsReconnect // 👈 nuevo
      });
      
    } catch (err) {
      console.error('❌ Error en GET /api/meta-config:', err);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  });  

// PUT: guardar configuración meta del tenant
router.put('/', async (req: Request, res: Response) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Token requerido' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    const userRes = await pool.query('SELECT tenant_id FROM users WHERE uid = $1', [decoded.uid]);
    const tenantId = userRes.rows[0]?.tenant_id;
    if (!tenantId) return res.status(404).json({ error: 'Usuario sin tenant asociado' });

    const {
        funciones_asistente,
        info_clave,
        prompt_meta,
        bienvenida_meta,
        idioma
      } = req.body;
      
      await pool.query(`
        INSERT INTO meta_configs (
          tenant_id, funciones_asistente, info_clave, prompt_meta, bienvenida_meta, idioma, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
        ON CONFLICT (tenant_id)
        DO UPDATE SET
          funciones_asistente = EXCLUDED.funciones_asistente,
          info_clave = EXCLUDED.info_clave,
          prompt_meta = EXCLUDED.prompt_meta,
          bienvenida_meta = EXCLUDED.bienvenida_meta,
          idioma = EXCLUDED.idioma,
          updated_at = NOW()
      `, [
        tenantId, funciones_asistente, info_clave, prompt_meta, bienvenida_meta, idioma
      ]);      

    console.log('📝 Datos recibidos en PUT /api/meta-config:', req.body);
  
    return res.status(200).json({ message: 'Configuración Meta guardada correctamente' });
  } catch (err) {
    console.error('❌ Error en PUT /api/meta-config:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// POST: desconectar cuentas de Facebook e Instagram
router.post('/disconnect', async (req: Request, res: Response) => {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Token requerido' });
  
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
      const userRes = await pool.query('SELECT tenant_id FROM users WHERE uid = $1', [decoded.uid]);
      const tenantId = userRes.rows[0]?.tenant_id;
      if (!tenantId) return res.status(404).json({ error: 'Usuario sin tenant asociado' });
  
      await pool.query(`
        UPDATE tenants SET 
          facebook_page_id = NULL, 
          facebook_page_name = NULL, 
          instagram_page_id = NULL, 
          instagram_page_name = NULL,
          facebook_access_token = NULL
        WHERE id = $1
      `, [tenantId]);
  
      return res.status(200).json({ message: 'Cuentas desconectadas correctamente' });
    } catch (err) {
      console.error('❌ Error en POST /api/meta-config/disconnect:', err);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  });
  
export default router;
