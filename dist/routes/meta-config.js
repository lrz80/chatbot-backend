"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/meta-config.ts
const express_1 = require("express");
const db_1 = __importDefault(require("../lib/db"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const router = (0, express_1.Router)();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';
// GET: obtener configuración meta del tenant
router.get('/', async (req, res) => {
    const token = req.cookies.token;
    if (!token)
        return res.status(401).json({ error: 'Token requerido' });
    try {
        const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        const userRes = await db_1.default.query('SELECT tenant_id FROM users WHERE uid = $1', [decoded.uid]);
        const tenantId = userRes.rows[0]?.tenant_id;
        if (!tenantId)
            return res.status(404).json({ error: 'Usuario sin tenant asociado' });
        const configRes = await db_1.default.query('SELECT * FROM meta_configs WHERE tenant_id = $1 LIMIT 1', [tenantId]);
        const config = configRes.rows[0] || {};
        const tenantRes = await db_1.default.query(`
        SELECT facebook_page_id, facebook_page_name, instagram_page_id, instagram_page_name, membresia_activa
        FROM tenants WHERE id = $1 LIMIT 1
      `, [tenantId]);
        const tenant = tenantRes.rows[0] || {};
        return res.status(200).json({
            ...config,
            facebook_page_id: tenant.facebook_page_id,
            facebook_page_name: tenant.facebook_page_name,
            instagram_page_id: tenant.instagram_page_id,
            instagram_page_name: tenant.instagram_page_name,
            membresia_activa: tenant.membresia_activa, // ✅ AÑADIDO
        });
    }
    catch (err) {
        console.error('❌ Error en GET /api/meta-config:', err);
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});
// PUT: guardar configuración meta del tenant
router.put('/', async (req, res) => {
    const token = req.cookies.token;
    if (!token)
        return res.status(401).json({ error: 'Token requerido' });
    try {
        const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        const userRes = await db_1.default.query('SELECT tenant_id FROM users WHERE uid = $1', [decoded.uid]);
        const tenantId = userRes.rows[0]?.tenant_id;
        if (!tenantId)
            return res.status(404).json({ error: 'Usuario sin tenant asociado' });
        const { funciones_asistente, info_clave, prompt_meta, bienvenida_meta, idioma } = req.body;
        await db_1.default.query(`
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
    }
    catch (err) {
        console.error('❌ Error en PUT /api/meta-config:', err);
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});
// POST: desconectar cuentas de Facebook e Instagram
router.post('/disconnect', async (req, res) => {
    const token = req.cookies.token;
    if (!token)
        return res.status(401).json({ error: 'Token requerido' });
    try {
        const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        const userRes = await db_1.default.query('SELECT tenant_id FROM users WHERE uid = $1', [decoded.uid]);
        const tenantId = userRes.rows[0]?.tenant_id;
        if (!tenantId)
            return res.status(404).json({ error: 'Usuario sin tenant asociado' });
        await db_1.default.query(`
        UPDATE tenants SET 
          facebook_page_id = NULL, 
          facebook_page_name = NULL, 
          instagram_page_id = NULL, 
          instagram_page_name = NULL,
          facebook_access_token = NULL
        WHERE id = $1
      `, [tenantId]);
        return res.status(200).json({ message: 'Cuentas desconectadas correctamente' });
    }
    catch (err) {
        console.error('❌ Error en POST /api/meta-config/disconnect:', err);
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});
exports.default = router;
