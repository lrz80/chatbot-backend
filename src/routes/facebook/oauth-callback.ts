import express from 'express';
import axios from 'axios';
import pool from '../../lib/db';
import { authenticateUser } from '../../middleware/auth';

const router = express.Router();

router.get('/api/facebook/oauth-callback', async (req, res) => {
  const { code } = req.query;

  if (!code) return res.status(400).send("No code provided");

  try {
    const appId = process.env.FB_APP_ID!;
    const appSecret = process.env.FB_APP_SECRET!;
    const redirectUri = 'https://api.aamy.ai/api/facebook/oauth-callback';

    // 1. Intercambiar el code por un access_token
    const tokenRes = await axios.get('https://graph.facebook.com/v19.0/oauth/access_token', {
      params: {
        client_id: appId,
        redirect_uri: redirectUri,
        client_secret: appSecret,
        code,
      },
    });

    const accessToken = tokenRes.data.access_token;

    // 2. Obtener las páginas conectadas
    const pagesRes = await axios.get('https://graph.facebook.com/v19.0/me/accounts', {
      params: { access_token: accessToken },
    });

    const page = pagesRes.data.data[0];
    const pageId = page.id;
    const pageAccessToken = page.access_token;
    const pageName = page.name;

    // 3. Obtener instagram_business_account
    const igRes = await axios.get(`https://graph.facebook.com/v19.0/${pageId}?fields=instagram_business_account`, {
      params: { access_token: pageAccessToken },
    });

    const instagramBusinessAccount = igRes.data.instagram_business_account;
    const instagramId = instagramBusinessAccount?.id || null;

    // 4. Obtener al usuario autenticado (puedes hacerlo con token JWT en cookies o session)
    // Aquí ejemplo con token en cookies
    const token = req.cookies?.token;

    if (!token) return res.status(401).send("Unauthorized");

    const userRes = await pool.query('SELECT tenant_id FROM users WHERE token = $1 LIMIT 1', [token]);
    const tenantId = userRes.rows[0]?.tenant_id;

    if (!tenantId) return res.status(404).send("Tenant not found");

    // 5. Guardar los datos en DB
    await pool.query(
      `UPDATE tenants SET 
        facebook_page_id = $1,
        facebook_page_name = $2,
        facebook_access_token = $3,
        instagram_business_account_id = $4
       WHERE id = $5`,
      [pageId, pageName, pageAccessToken, instagramId, tenantId]
    );

    console.log('✅ Datos guardados en tenants:', { pageId, pageName, instagramId });

    return res.redirect('https://www.aamy.ai/dashboard/meta-config?connected=success');
  } catch (err: any) {
    console.error('❌ Error en oauth-callback:', err.response?.data || err.message || err);  
    return res.status(500).send("Error during OAuth callback.");
  }
});

export default router;
