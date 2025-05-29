"use strict";
// src/routes/facebook/oauth-callbacks.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const axios_1 = __importDefault(require("axios"));
const db_1 = __importDefault(require("../../lib/db"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const router = express_1.default.Router();
router.get('/api/facebook/oauth-callback', async (req, res) => {
    const { code } = req.query;
    if (!code)
        return res.status(400).send("No code provided");
    try {
        const appId = process.env.FB_APP_ID;
        const appSecret = process.env.FB_APP_SECRET;
        const redirectUri = 'https://api.aamy.ai/api/facebook/oauth-callback';
        // 1. Intercambiar el code por un access_token
        const tokenRes = await axios_1.default.get('https://graph.facebook.com/v19.0/oauth/access_token', {
            params: {
                client_id: appId,
                redirect_uri: redirectUri,
                client_secret: appSecret,
                code,
            },
        });
        const accessToken = tokenRes.data.access_token;
        // 2. Obtener las páginas conectadas
        const pagesRes = await axios_1.default.get('https://graph.facebook.com/v19.0/me/accounts', {
            params: { access_token: accessToken },
        });
        const page = pagesRes.data.data[0];
        const pageId = page.id;
        const pageAccessToken = page.access_token;
        const pageName = page.name;
        // 3. Obtener instagram_business_account de la página
        const igRes = await axios_1.default.get(`https://graph.facebook.com/v19.0/${pageId}?fields=instagram_business_account`, {
            params: { access_token: pageAccessToken },
        });
        const instagramBusinessAccount = igRes.data.instagram_business_account;
        const instagramBusinessAccountId = instagramBusinessAccount?.id || null;
        // 4. Si existe, obtener el perfil real de Instagram
        let instagramPageId = null;
        let instagramPageUsername = null;
        if (instagramBusinessAccountId) {
            const igProfileRes = await axios_1.default.get(`https://graph.facebook.com/v19.0/${instagramBusinessAccountId}?fields=id,username`, {
                params: { access_token: pageAccessToken },
            });
            instagramPageId = igProfileRes.data?.id || null;
            instagramPageUsername = igProfileRes.data?.username || null;
        }
        // 5. Decodificar token JWT de cookies
        const token = req.cookies?.token;
        if (!token)
            return res.status(401).send("Unauthorized");
        const decoded = jsonwebtoken_1.default.verify(token, process.env.JWT_SECRET);
        console.log('✅ TOKEN DECODIFICADO:', decoded);
        const tenantId = decoded.tenant_id;
        if (!tenantId)
            return res.status(404).send("Tenant not found in token");
        // 6. Guardar todo en la base de datos
        await db_1.default.query(`UPDATE tenants SET 
        facebook_page_id = $1,
        facebook_page_name = $2,
        facebook_access_token = $3,
        instagram_business_account_id = $4,
        instagram_page_id = $5,
        instagram_page_name = $6
       WHERE id = $7`, [
            pageId,
            pageName,
            pageAccessToken,
            instagramBusinessAccountId,
            instagramPageId,
            instagramPageUsername,
            tenantId,
        ]);
        console.log('✅ Datos de Facebook e Instagram guardados exitosamente para tenant:', tenantId);
        return res.redirect('https://www.aamy.ai/dashboard/meta-config?connected=success');
    }
    catch (err) {
        console.error('❌ Error en oauth-callback:', err.response?.data || err.message || err);
        return res.status(500).send("Error during OAuth callback.");
    }
});
exports.default = router;
