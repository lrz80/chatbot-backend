//src/routes/facebook/oauth-sessions.ts
import express from 'express';
import axios from 'axios';
import pool from '../../lib/db';
import { authenticateUser } from '../../middleware/auth';

const router = express.Router();

/**
 * GET /api/facebook/oauth-pages?session_id=...
 * Devuelve las páginas disponibles para esa sesión OAuth.
 */
router.get(
  '/api/facebook/oauth-pages',
  authenticateUser,
  async (req, res) => {
    try {
      const sessionId = String(req.query.session_id || '').trim();
      if (!sessionId) {
        return res.status(400).json({ error: 'session_id requerido' });
      }

      const tenantId = (req as any).user?.tenant_id;
      if (!tenantId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      // 1) Cargar sesión
      const { rows } = await pool.query(
        `
        SELECT id, tenant_id, user_access_token, created_at
          FROM facebook_oauth_sessions
         WHERE id = $1
         LIMIT 1
        `,
        [sessionId]
      );

      const session = rows[0];
      if (!session) {
        return res.status(404).json({ error: 'Sesión no encontrada' });
      }

      if (session.tenant_id !== tenantId) {
        return res
          .status(403)
          .json({ error: 'Sesión no pertenece a este tenant' });
      }

      const userAccessToken: string = session.user_access_token;

      try {
        const bizRes = await axios.get("https://graph.facebook.com/v19.0/me/businesses", {
            params: { access_token: userAccessToken, fields: "id,name" },
        });
        console.log("🏢 [META] /me/businesses:", JSON.stringify(bizRes.data, null, 2));
      } catch (e: any) {
        console.log("⚠️ [META] /me/businesses failed:", e?.response?.data || e.message);
      }

      // ✅ Paso 1A: confirmar quién es el usuario del token
      const meRes = await axios.get("https://graph.facebook.com/v19.0/me", {
        params: { access_token: userAccessToken, fields: "id,name" },
      });
      console.log("👤 [META] /me:", JSON.stringify(meRes.data, null, 2));

      // ✅ Paso 1B: confirmar permisos reales concedidos al token
      const permsRes = await axios.get("https://graph.facebook.com/v19.0/me/permissions", {
        params: { access_token: userAccessToken },
      });

      // 2) Obtener páginas accesibles para este usuario
      const pagesRes = await axios.get(
        "https://graph.facebook.com/v19.0/me",
        {
            params: {
            access_token: userAccessToken,
            fields: "accounts{id,name,picture{url},instagram_business_account{id,username}}",
            },
        }
        );

        const pages = Array.isArray(pagesRes.data?.accounts?.data)
        ? pagesRes.data.accounts.data
        : [];

    interface FBPage {
        id: string;
        name: string;
        picture?: { data?: { url?: string } };
        instagram_business_account?: { id?: string; username?: string };
        }

    const simplified = pages.map((p: FBPage) => ({
        id: p.id,
        name: p.name,
        pictureUrl: p.picture?.data?.url || null,
        instagramBusinessId: p.instagram_business_account?.id || null,
        instagramUsername: p.instagram_business_account?.username || null,
        }));

    console.log('📄 Páginas disponibles para selección:', {
        tenantId,
        sessionId,
        count: simplified.length,
        pageIds: simplified.map((p: any) => p.id),
        pageNames: simplified.map((p: any) => p.name),
        });

    return res.json({ pages: simplified });
    } catch (error: any) {
      console.error(
        '❌ Error en /api/facebook/oauth-pages:',
        error?.response?.data || error.message || error
      );
      return res
        .status(500)
        .json({ error: 'Error al obtener las páginas de Facebook' });
    }
  }
);

/**
 * POST /api/facebook/select-page
 * Body: { session_id: string, page_id: string }
 * Usa el user_access_token de la sesión para obtener el pageAccessToken y guardar en tenants.
 */
router.post(
  '/api/facebook/select-page',
  authenticateUser,
  async (req, res) => {
    try {
      const { session_id, page_id } = req.body || {};

      if (!session_id || !page_id) {
        return res
          .status(400)
          .json({ error: 'session_id y page_id son requeridos' });
      }

      const tenantId = (req as any).user?.tenant_id;
      if (!tenantId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      // 1) Cargar sesión
      const { rows } = await pool.query(
        `
        SELECT id, tenant_id, user_access_token
          FROM facebook_oauth_sessions
         WHERE id = $1
         LIMIT 1
        `,
        [session_id]
      );
      const session = rows[0];
      if (!session) {
        return res.status(404).json({ error: 'Sesión no encontrada' });
      }

      if (session.tenant_id !== tenantId) {
        return res.status(403).json({ error: 'Sesión no pertenece a este tenant' });
      }

      const userAccessToken: string = session.user_access_token;

      // 2) Obtener datos de la página elegida (incluye page access_token)
      const pageRes = await axios.get(
        `https://graph.facebook.com/v19.0/${page_id}`,
        {
          params: {
            access_token: userAccessToken,
            fields:
              'id,name,access_token,instagram_business_account{id,username}',
          },
        }
      );

      const pageData = pageRes.data;
      const pageId = pageData.id;
      const pageName = pageData.name;
      const pageAccessToken = pageData.access_token;

      if (!pageId || !pageAccessToken) {
        console.error('❌ Página sin id o access_token:', {
          pageId,
          pageName,
        });
        return res
          .status(400)
          .json({ error: 'No se pudo obtener access_token de la página' });
      }

      const instagramBusinessAccount = pageData.instagram_business_account || null;
      const instagramBusinessAccountId = instagramBusinessAccount?.id || null;
      const instagramUsername = instagramBusinessAccount?.username || null;

      let instagramPageId: string | null = null;
      let instagramPageUsername: string | null = null;

      // 3) Si hay instagram_business_account, obtener el perfil real de Instagram
      if (instagramBusinessAccountId) {
        try {
          const igProfileRes = await axios.get(
            `https://graph.facebook.com/v19.0/${instagramBusinessAccountId}`,
            {
              params: {
                access_token: pageAccessToken,
                fields: 'id,username',
              },
            }
          );
          instagramPageId = igProfileRes.data?.id || null;
          instagramPageUsername = igProfileRes.data?.username || instagramUsername;
        } catch (e: any) {
          console.warn(
            '⚠️ No se pudo obtener el perfil de Instagram:',
            e.response?.data || e.message
          );
        }
      }

      // 4) Guardar en tenants
      await pool.query(
        `
        UPDATE tenants 
           SET facebook_page_id = $1,
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

      console.log('✅ Página Meta conectada para tenant (DB):', {
        tenantId,
        pageId,
        pageName,
        instagramPageId,
        instagramPageUsername,
      });

      // 5) Suscribir la página a tu webhook (Messenger)
      try {
        const subRes = await axios.post(
          `https://graph.facebook.com/v19.0/${pageId}/subscribed_apps`,
          null,
          {
            params: {
              access_token: pageAccessToken,
              subscribed_fields: [
                'messages',
                'messaging_postbacks',
                'messaging_optins',
                'messaging_referrals',
                'message_reactions',
                'message_reads',
              ].join(','),
            },
          }
        );

        console.log('📡 Página suscrita a webhook (Messenger):', {
          tenantId,
          pageId,
          result: subRes.data,
        });
      } catch (e: any) {
        console.error(
          '❌ Error suscribiendo página a webhook:',
          e.response?.data || e.message
        );
        // No hacemos return aquí para no romper la UX, pero es importante revisarlo si falla
      }

      // 6) (Opcional pero recomendable) eliminar sesión
      await pool.query(
        'DELETE FROM facebook_oauth_sessions WHERE id = $1',
        [session_id]
      );

      return res.json({ success: true });
    } catch (error: any) {
      console.error(
        '❌ Error en /api/facebook/select-page:',
        error?.response?.data || error.message || error
      );
      return res
        .status(500)
        .json({ error: 'Error al guardar la página seleccionada' });
    }
  }
);

export default router;
