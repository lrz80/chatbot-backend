// src/routes/facebook/oauth-callbacks.ts

import express from 'express';
import axios from 'axios';
import pool from '../../lib/db';
import jwt from 'jsonwebtoken';

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

    // 1. Intercambiar el code por un access_token
    const tokenRes = await axios.get(
      'https://graph.facebook.com/v19.0/oauth/access_token',
      {
        params: {
          client_id: appId,
          redirect_uri: redirectUri,
          client_secret: appSecret,
          code,
        },
      }
    );

    const accessToken = tokenRes.data?.access_token;
    if (!accessToken) {
      console.error('❌ Meta no devolvió access_token:', tokenRes.data);
      return res.redirect(
        `${FRONTEND_URL}/dashboard/meta-config?error=no_access_token`
      );
    }

    // 🔍 Ver qué permisos tiene este token (no expone secretos)
    try {
      const permsRes = await axios.get(
        'https://graph.facebook.com/v19.0/me/permissions',
        { params: { access_token: accessToken } }
      );
      console.log(
        '🔐 [FB PERMISSIONS]',
        JSON.stringify(permsRes.data, null, 2)
      );
    } catch (permsErr: any) {
      console.warn(
        '⚠️ No se pudieron leer los permisos de este token:',
        permsErr.response?.data || permsErr.message
      );
    }

    // 🔍 Ver a quién pertenece este token (id + nombre está OK)
    const meRes = await axios.get('https://graph.facebook.com/v19.0/me', {
      params: { access_token: accessToken },
    });
    console.log('👤 [FB ME] id:', meRes.data?.id, 'name:', meRes.data?.name);

    // 2. Obtener las páginas conectadas
    const pagesRes = await axios.get(
      'https://graph.facebook.com/v19.0/me/accounts',
      { params: { access_token: accessToken } }
    );

    const pages = pagesRes.data?.data || [];

    // ⚠️ IMPORTANTE: no logueamos access_token de las páginas
    console.log(
      '✅ /me/accounts páginas encontradas:',
      Array.isArray(pages) ? pages.length : 0
    );
    if (Array.isArray(pages) && pages.length > 0) {
      console.log(
        '📄 /me/accounts páginas (id, name):',
        pages.map((p: any) => ({
          id: p.id,
          name: p.name,
        }))
      );
    }

    if (!Array.isArray(pages) || pages.length === 0) {
      console.error(
        '❌ El usuario no tiene páginas accesibles o faltan permisos. Resumen:',
        {
          length: Array.isArray(pages) ? pages.length : 0,
        }
      );
      return res.redirect(
        `${FRONTEND_URL}/dashboard/meta-config?error=no_pages_or_permissions`
      );
    }

    const page = pages[0];

    if (!page?.id || !page?.access_token) {
      console.error('❌ Página sin id o access_token (solo id/name):', {
        id: page?.id,
        name: page?.name,
      });
      return res.redirect(
        `${FRONTEND_URL}/dashboard/meta-config?error=invalid_page_data`
      );
    }

    const pageId = page.id;
    const pageAccessToken = page.access_token;
    const pageName = page.name || null;

    // 3. Obtener instagram_business_account de la página
    let instagramBusinessAccountId: string | null = null;

    try {
      const igRes = await axios.get(
        `https://graph.facebook.com/v19.0/${pageId}`,
        {
          params: {
            fields: 'instagram_business_account',
            access_token: pageAccessToken,
          },
        }
      );

      const instagramBusinessAccount =
        igRes.data?.instagram_business_account || null;
      instagramBusinessAccountId = instagramBusinessAccount?.id || null;

      console.log(
        '✅ instagram_business_account:',
        JSON.stringify(
          {
            hasInstagramBusinessAccount: !!instagramBusinessAccountId,
            instagramBusinessAccountId,
          },
          null,
          2
        )
      );
    } catch (igErr: any) {
      console.warn(
        '⚠️ No se pudo obtener instagram_business_account (puede no estar conectado):',
        igErr.response?.data || igErr.message
      );
    }

    // 4. Si existe, obtener el perfil real de Instagram
    let instagramPageId: string | null = null;
    let instagramPageUsername: string | null = null;

    if (instagramBusinessAccountId) {
      try {
        const igProfileRes = await axios.get(
          `https://graph.facebook.com/v19.0/${instagramBusinessAccountId}`,
          {
            params: {
              fields: 'id,username',
              access_token: pageAccessToken,
            },
          }
        );

        instagramPageId = igProfileRes.data?.id || null;
        instagramPageUsername = igProfileRes.data?.username || null;

        console.log('✅ Perfil de Instagram:', {
          instagramPageId,
          instagramPageUsername,
        });
      } catch (igProfileErr: any) {
        console.warn(
          '⚠️ No se pudo obtener el perfil de Instagram:',
          igProfileErr.response?.data || igProfileErr.message
        );
      }
    }

    // 5. Decodificar token JWT de cookies (no loguear todo el payload)
    const token = req.cookies?.token;

    if (!token) {
      console.error('❌ No hay cookie "token" en oauth-callback');
      return res.status(401).send('Unauthorized');
    }

    const decoded: any = jwt.verify(token, process.env.JWT_SECRET!);

    console.log('✅ TOKEN DECODIFICADO (resumen):', {
      uid: decoded.uid,
      tenant_id: decoded.tenant_id,
    });

    const tenantId = decoded.tenant_id;
    if (!tenantId) {
      console.error('❌ Tenant id no encontrado en token decodificado');
      return res.status(404).send('Tenant not found in token');
    }

    // 6. Guardar todo en la base de datos
    await pool.query(
      `
      UPDATE tenants 
      SET 
        facebook_page_id = $1,
        facebook_page_name = $2,
        facebook_access_token = $3,
        instagram_business_account_id = $4,
        instagram_page_id = $5,
        instagram_page_name = $6
      WHERE id = $7
    `,
      [
        pageId,
        pageName,
        pageAccessToken,
        instagramBusinessAccountId,
        instagramPageId,
        instagramPageUsername,
        tenantId,
      ]
    );

    console.log(
      '✅ Datos de Facebook e Instagram guardados exitosamente para tenant:',
      tenantId
    );

    return res.redirect(
      `${FRONTEND_URL}/dashboard/meta-config?connected=success`
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
