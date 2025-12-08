import express from 'express';
import axios from 'axios';
import pool from '../../lib/db';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';

const router = express.Router();

const PUBLIC_BACKEND_URL =
  process.env.PUBLIC_BACKEND_URL || 'https://api.aamy.ai';
const FRONTEND_URL =
  process.env.FRONTEND_URL || 'https://www.aamy.ai';

router.get('/api/facebook/oauth-callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    console.error('❌ OAuth callback sin "code" en query');
    return res.redirect(`${PUBLIC_BACKEND_URL}/api/facebook/oauth-start`);
  }

  try {
    const appId = process.env.FB_APP_ID!;
    const appSecret = process.env.FB_APP_SECRET!;
    const redirectUri = `${PUBLIC_BACKEND_URL}/api/facebook/oauth-callback`;

    // 1) Intercambiar el code por un access_token (usuario)
    const tokenRes = await axios.get(
      'https://graph.facebook.com/v19.0/oauth_access_token'.replace(
        'oauth_access_token',
        'oauth/access_token'
      ),
      {
        params: {
          client_id: appId,
          redirect_uri: redirectUri,
          client_secret: appSecret,
          code,
        },
      }
    );

    const userAccessToken = tokenRes.data?.access_token;
    if (!userAccessToken) {
      console.error('❌ Meta no devolvió access_token:', tokenRes.data);
      return res.redirect(
        `${FRONTEND_URL}/dashboard/meta-config?error=no_access_token`
      );
    }

    // 2) Decodificar token JWT de cookies (para saber tenant actual)
    const cookieToken = req.cookies?.token;
    if (!cookieToken) {
      console.error('❌ No hay cookie "token" en oauth-callback');
      return res.status(401).send('Unauthorized');
    }

    const decoded: any = jwt.verify(cookieToken, process.env.JWT_SECRET!);
    const tenantId = decoded.tenant_id;

    if (!tenantId) {
      console.error('❌ Tenant id no encontrado en token decodificado');
      return res.status(404).send('Tenant not found in token');
    }

    console.log('✅ TOKEN DECODIFICADO (resumen):', {
      uid: decoded.uid,
      tenant_id: tenantId,
    });

    // 3) Crear sesión temporal de OAuth
    const sessionId = randomUUID();

    await pool.query(
      `
      INSERT INTO facebook_oauth_sessions (id, tenant_id, user_access_token)
      VALUES ($1, $2, $3)
      `,
      [sessionId, tenantId, userAccessToken]
    );

    console.log('✅ Sesión OAuth Facebook creada:', {
      sessionId,
      tenantId,
    });

    // 4) Redirigir al frontend para que elija la página
    return res.redirect(
      `${FRONTEND_URL}/dashboard/meta-config?fb_session=${sessionId}`
    );
  } catch (err: any) {
    console.error(
      '❌ Error en oauth-callback:',
      err.response?.data || err.message || err
    );
    return res.status(500).send('Error during OAuth callback.');
  }
});

export default router;
