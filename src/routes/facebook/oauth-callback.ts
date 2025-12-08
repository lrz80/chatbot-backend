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

    // 1. Intercambiar el code por un access_token (de USUARIO)
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

    // 2. Decodificar token JWT de cookies para saber QUÉ tenant está conectando
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

    // 3. Obtener las páginas conectadas para ESTE usuario de Facebook
    const pagesRes = await axios.get(
      'https://graph.facebook.com/v19.0/me/accounts',
      { params: { access_token: accessToken } }
    );

    const pages = pagesRes.data?.data || [];

    console.log(
      '✅ /me/accounts páginas encontradas:',
      Array.isArray(pages) ? pages.length : 0
    );
    console.log(
      '📄 /me/accounts páginas (id, name):',
      pages.map((p: any) => ({ id: p.id, name: p.name }))
    );

    if (!Array.isArray(pages) || pages.length === 0) {
      console.error(
        '❌ El usuario no tiene páginas accesibles o faltan permisos:',
        { length: Array.isArray(pages) ? pages.length : 0 }
      );
      return res.redirect(
        `${FRONTEND_URL}/dashboard/meta-config?error=no_pages_or_permissions`
      );
    }

    // 4. Leer el tenant para poder tomar una decisión mejor sobre QUÉ página usar
    let tenantRow: any = null;
    try {
      const tenantRes = await pool.query(
        `SELECT 
           id,
           facebook_page_id,
           facebook_page_name
           -- 👉 adapta aquí si tienes un campo de nombre de negocio, ej:
           -- , nombre_negocio
         FROM tenants
         WHERE id = $1
         LIMIT 1`,
        [tenantId]
      );
      tenantRow = tenantRes.rows[0] || null;
    } catch (e) {
      console.warn('⚠️ No se pudo leer tenant para elegir página específica:', e);
    }

    // 5. Elegir la página adecuada para ESTE tenant
    let page: any = pages[0]; // fallback por defecto
    try {
      // a) Si el tenant ya tenía una página guardada, intenta reusar esa misma (reconexiones)
      if (tenantRow?.facebook_page_id) {
        const byId = pages.find((p: any) => p.id === tenantRow.facebook_page_id);
        if (byId) {
          page = byId;
          console.log('🔁 Reusando página previa del tenant por ID:', {
            tenantId,
            pageId: page.id,
            pageName: page.name,
          });
        }
      } else if (tenantRow?.facebook_page_name) {
        // b) Si solo tenías el nombre guardado, intenta matchear por nombre exacto
        const expectedName = String(tenantRow.facebook_page_name).toLowerCase();
        const byName = pages.find(
          (p: any) =>
            typeof p.name === 'string' &&
            p.name.toLowerCase() === expectedName
        );
        if (byName) {
          page = byName;
          console.log('🔁 Reusando página previa del tenant por NAME:', {
            tenantId,
            pageId: page.id,
            pageName: page.name,
          });
        }
      } else {
        // c) PRIMERA VEZ para este tenant:
        //    aquí puedes hacer lógica más específica si quieres (ej: por nombre de negocio).
        //    De momento, dejamos pages[0] como fallback.
        console.log('✨ Primera conexión Meta para este tenant. Usando pages[0] por ahora.', {
          tenantId,
          chosenPageId: page?.id,
          chosenPageName: page?.name,
        });
      }
    } catch (e) {
      console.warn('⚠️ Error eligiendo página; se usará pages[0]:', e);
    }

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

    console.log('✅ Página elegida para este tenant:', {
      tenantId,
      pageId,
      pageName,
    });

    // 6. Obtener instagram_business_account de la página elegida
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

    // 7. Si existe, obtener el perfil real de Instagram
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

    // 8. Guardar todo en la base de datos
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
