"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const db_1 = __importDefault(require("../lib/db"));
const auth_1 = require("../middleware/auth");
const router = express_1.default.Router();
// ✅ GET: Perfil del negocio
router.get('/', auth_1.authenticateUser, async (req, res) => {
    try {
        const uid = req.user?.uid;
        const tenant_id = req.user?.tenant_id;
        if (!tenant_id) {
            return res.status(401).json({ error: 'Tenant no encontrado o no asignado' });
        }
        const userRes = await db_1.default.query('SELECT uid, email, owner_name FROM users WHERE uid = $1', [uid]);
        const user = userRes.rows[0];
        if (!user)
            return res.status(404).json({ error: 'Usuario no encontrado' });
        const tenantRes = await db_1.default.query(`
      SELECT 
        * 
      FROM tenants 
      WHERE id = $1
      LIMIT 1
    `, [tenant_id]);
        const tenant = tenantRes.rows[0];
        if (!tenant)
            return res.status(404).json({ error: 'Tenant no encontrado' });
        return res.status(200).json({
            uid: user.uid,
            email: user.email,
            owner_name: user.owner_name,
            membresia_activa: tenant.membresia_activa ?? false,
            membresia_vigencia: tenant.membresia_vigencia ?? null,
            onboarding_completado: tenant.onboarding_completado,
            name: tenant.name || '',
            categoria: tenant.categoria || '',
            idioma: tenant.idioma || 'es',
            prompt: tenant.prompt || '',
            bienvenida: tenant.bienvenida || '',
            direccion: tenant.direccion || '',
            horario_atencion: tenant.horario_atencion || '',
            twilio_number: tenant.twilio_number || '',
            twilio_sms_number: tenant.twilio_sms_number || '',
            twilio_voice_number: tenant.twilio_voice_number || '',
            informacion_negocio: tenant.informacion_negocio || '',
            funciones_asistente: tenant.funciones_asistente || '',
            info_clave: tenant.info_clave || '',
            limite_uso: tenant.limite_uso || 150,
            logo_url: tenant.logo_url || '',
            plan: tenant.plan || '',
            fecha_registro: tenant.fecha_registro || null,
            // 👇 Agregamos los nuevos campos de Facebook e Instagram
            facebook_page_id: tenant.facebook_page_id || '',
            facebook_page_name: tenant.facebook_page_name || '',
            facebook_access_token: tenant.facebook_access_token || '',
            instagram_page_id: tenant.instagram_page_id || '',
            instagram_page_name: tenant.instagram_page_name || '',
        });
    }
    catch (error) {
        console.error('❌ Error en GET /api/settings:', error);
        return res.status(401).json({ error: 'Token inválido' });
    }
});
// ✅ POST: Guardar cambios iniciales del negocio
router.post('/', auth_1.authenticateUser, async (req, res) => {
    try {
        const tenant_id = req.user?.tenant_id;
        if (!tenant_id) {
            return res.status(401).json({ error: 'Tenant no autenticado' });
        }
        const { nombre_negocio, categoria, idioma, direccion, horario_atencion, prompt, bienvenida, informacion_negocio, funciones_asistente, info_clave, limite_uso, logo_url, } = req.body;
        if (!nombre_negocio) {
            return res.status(400).json({ error: 'El nombre del negocio es obligatorio' });
        }
        const current = await db_1.default.query('SELECT * FROM tenants WHERE id = $1', [tenant_id]);
        const existing = current.rows[0];
        if (!existing)
            return res.status(404).json({ error: 'Negocio no encontrado' });
        await db_1.default.query(`UPDATE tenants SET 
        name = $1,
        categoria = $2,
        idioma = $3,
        direccion = $4,
        horario_atencion = $5,
        prompt = $6,
        bienvenida = $7,
        twilio_number = $8,
        twilio_sms_number = $9,
        twilio_voice_number = $10,
        informacion_negocio = $11,
        funciones_asistente = $12,
        info_clave = $13,
        limite_uso = $14,
        logo_url = $15
      WHERE id = $16`, [
            nombre_negocio,
            categoria ?? existing.categoria,
            idioma ?? existing.idioma,
            direccion ?? existing.direccion,
            horario_atencion ?? existing.horario_atencion,
            prompt ?? existing.prompt,
            bienvenida ?? existing.bienvenida,
            existing.twilio_number,
            existing.twilio_sms_number,
            existing.twilio_voice_number,
            informacion_negocio ?? existing.informacion_negocio,
            funciones_asistente?.trim() !== '' ? funciones_asistente : existing.funciones_asistente,
            info_clave ?? existing.info_clave,
            limite_uso ?? existing.limite_uso,
            logo_url ?? existing.logo_url,
            tenant_id,
        ]);
        res.status(200).json({ success: true });
    }
    catch (error) {
        console.error('❌ Error en POST /api/settings:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});
// ✅ PUT: Actualizar perfil de negocio
router.put('/', auth_1.authenticateUser, async (req, res) => {
    try {
        const tenant_id = req.user?.tenant_id;
        if (!tenant_id) {
            return res.status(401).json({ error: 'Tenant no autenticado' });
        }
        const { nombre_negocio, categoria, idioma, direccion, horario_atencion, prompt, bienvenida, informacion_negocio, funciones_asistente, info_clave, limite_uso, logo_url, prompt_meta, bienvenida_meta, } = req.body;
        const existingRes = await db_1.default.query('SELECT * FROM tenants WHERE id = $1', [tenant_id]);
        const current = existingRes.rows[0];
        if (!current)
            return res.status(404).json({ error: 'Tenant no encontrado' });
        await db_1.default.query(`UPDATE tenants SET 
        name = $1,
        categoria = $2,
        idioma = $3,
        direccion = $4,
        horario_atencion = $5,
        prompt = $6,
        bienvenida = $7,
        informacion_negocio = $8,
        funciones_asistente = $9,
        info_clave = $10,
        limite_uso = $11,
        logo_url = $12,
        prompt_meta = $13,
        bienvenida_meta = $14,
        onboarding_completado = true
      WHERE id = $15`, [
            nombre_negocio || current.name,
            categoria || current.categoria,
            idioma || current.idioma,
            direccion || current.direccion,
            horario_atencion || current.horario_atencion,
            prompt || current.prompt,
            bienvenida || current.bienvenida,
            informacion_negocio || current.informacion_negocio,
            funciones_asistente || current.funciones_asistente,
            info_clave || current.info_clave,
            limite_uso || current.limite_uso,
            logo_url || current.logo_url,
            prompt_meta || current.prompt_meta,
            bienvenida_meta || current.bienvenida_meta,
            tenant_id,
        ]);
        return res.status(200).json({ message: 'Perfil actualizado correctamente' });
    }
    catch (error) {
        console.error('❌ Error en PUT /api/settings:', error);
        return res.status(500).json({ error: 'Error al guardar cambios' });
    }
});
exports.default = router;
