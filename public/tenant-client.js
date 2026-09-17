/**
 * Antigravity Multi-Tenant & License Guard Client Library
 */
(function() {
  // 1. Detect Tenant Slug
  let tenantSlug = 'rs-store';
  const pathParts = window.location.pathname.split('/').filter(Boolean);
  if (pathParts[0] === 't' && pathParts[1]) {
    tenantSlug = pathParts[1].toLowerCase();
    localStorage.setItem('ag_current_tenant', tenantSlug);
  } else {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('tenant') || urlParams.get('t')) {
      tenantSlug = (urlParams.get('tenant') || urlParams.get('t')).toLowerCase();
      localStorage.setItem('ag_current_tenant', tenantSlug);
    } else {
      const stored = localStorage.getItem('ag_current_tenant');
      if (stored && window.location.pathname.includes('/admin')) {
        tenantSlug = stored;
      }
    }
  }

  window.__CURRENT_TENANT_SLUG__ = tenantSlug;

  // 2. Intercept fetch to inject X-Tenant-Slug header and handle license expiration
  const originalFetch = window.fetch;
  window.fetch = async function(resource, init = {}) {
    init = init || {};
    init.headers = init.headers || {};

    if (init.headers instanceof Headers) {
      if (!init.headers.has('X-Tenant-Slug')) {
        init.headers.append('X-Tenant-Slug', tenantSlug);
      }
    } else if (Array.isArray(init.headers)) {
      init.headers.push(['X-Tenant-Slug', tenantSlug]);
    } else {
      init.headers['X-Tenant-Slug'] = tenantSlug;
    }

    try {
      const response = await originalFetch(resource, init);

      if (response.status === 403) {
        // Check if it's license expired
        const cloned = response.clone();
        try {
          const json = await cloned.json();
          if (json.error === 'LICENCIA_EXPIRADA') {
            showLicenseLockScreen(json);
          }
        } catch(e) {}
      }

      return response;
    } catch(err) {
      throw err;
    }
  };

  // 3. License Lock Screen Modal
  function showLicenseLockScreen(data) {
    let modal = document.getElementById('agLicenseLockModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'agLicenseLockModal';
      modal.style.cssText = `
        position: fixed; inset: 0; background: rgba(11, 15, 23, 0.95);
        backdrop-filter: blur(14px); z-index: 999999; display: flex;
        align-items: center; justify-content: center; padding: 20px;
        font-family: 'Plus Jakarta Sans', system-ui, sans-serif; color: #fff;
      `;
      modal.innerHTML = `
        <div style="background: #182234; border: 1px solid rgba(255,255,255,0.15); border-radius: 20px; max-width: 520px; width: 100%; padding: 32px; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.8); text-align: center;">
          <div style="width: 64px; height: 64px; border-radius: 16px; background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239,68,68,0.3); color: #EF4444; font-size: 32px; display: flex; align-items: center; justify-content: center; margin: 0 auto 18px;">
            🔒
          </div>
          <h2 style="font-size: 22px; font-weight: 800; margin-bottom: 8px;" id="agLockCompanyTitle">Licencia Anual Expirada</h2>
          <p style="font-size: 13.5px; color: #9CA3AF; line-height: 1.6; margin-bottom: 20px;" id="agLockDesc">
            El período de vigencia de esta empresa ha finalizado. Todos los datos, inventario y facturas tributarias del SRI están <b>100% seguros y respaldados</b> esperando tu renovación.
          </p>
          
          <div style="background: rgba(255,255,255,0.03); border: 1px dashed rgba(255,255,255,0.12); border-radius: 12px; padding: 14px; margin-bottom: 20px; text-align: left; font-size: 12.5px;">
            <div style="color:#9CA3AF; margin-bottom: 4px;">Proveedor Autorizado:</div>
            <div style="font-weight: 700; color: #F3F4F6;">Soporte Técnico &amp; Renovaciones</div>
            <div style="color: #6366F1; font-weight: 600; margin-top: 2px;">WhatsApp: <a id="agLockWaLink" href="https://wa.me/593968433458" target="_blank" style="color:#6366F1; text-decoration: underline;">+593 96 843 3458</a></div>
          </div>

          <div style="text-align: left; margin-bottom: 16px;">
            <label style="display: block; font-size: 11.5px; font-weight: 700; color: #9CA3AF; text-transform: uppercase; margin-bottom: 6px;">
              ¿Tienes una clave de activación / renovación?
            </label>
            <input type="text" id="agLicenseKeyInput" placeholder="LIC-XXXX-YYYYMMDD-XXXX" style="width: 100%; box-sizing: border-box; background: #111827; border: 1px solid rgba(255,255,255,0.2); border-radius: 10px; padding: 12px 14px; color: #fff; font-family: 'JetBrains Mono', monospace; font-size: 13px; text-transform: uppercase; outline: none;">
          </div>

          <button type="button" id="btnAgActivateLicense" style="width: 100%; background: linear-gradient(135deg, #6366F1, #4F46E5); color: #fff; border: none; padding: 13px; border-radius: 10px; font-weight: 700; font-size: 14px; cursor: pointer; box-shadow: 0 4px 14px rgba(99,102,241,0.4);">
            🚀 Reactivar Sistema Ahora
          </button>
          <div id="agLockMsg" style="font-size: 12px; margin-top: 10px; display: none;"></div>
        </div>
      `;
      document.body.appendChild(modal);

      document.getElementById('btnAgActivateLicense').addEventListener('click', async () => {
        const key = document.getElementById('agLicenseKeyInput').value.trim();
        const msg = document.getElementById('agLockMsg');
        const btn = document.getElementById('btnAgActivateLicense');
        if (!key) {
          msg.style.display = 'block';
          msg.style.color = '#EF4444';
          msg.textContent = 'Por favor ingresa la clave de licencia provista por tu proveedor.';
          return;
        }
        btn.disabled = true;
        btn.textContent = 'Validando clave...';
        msg.style.display = 'none';

        try {
          const res = await originalFetch('/api/license/activate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ slug: tenantSlug, clave: key })
          });
          const json = await res.json();
          btn.disabled = false;
          btn.textContent = '🚀 Reactivar Sistema Ahora';

          if (json.success) {
            msg.style.display = 'block';
            msg.style.color = '#10B981';
            msg.textContent = '¡Licencia activada con éxito! Reiniciando sistema...';
            setTimeout(() => {
              window.location.reload();
            }, 1500);
          } else {
            msg.style.display = 'block';
            msg.style.color = '#EF4444';
            msg.textContent = json.error || 'Clave de activación inválida.';
          }
        } catch(e) {
          btn.disabled = false;
          btn.textContent = '🚀 Reactivar Sistema Ahora';
          msg.style.display = 'block';
          msg.style.color = '#EF4444';
          msg.textContent = 'Error al verificar con el servidor.';
        }
      });
    }

    if (data) {
      const isPrueba = data.licencia_tipo === 'PRUEBA';
      const isMensual = data.licencia_tipo === 'MENSUAL';
      
      let title = `Licencia Expirada · ${data.empresa || 'Tienda'}`;
      let icon = '🔒';
      let desc = `El período de vigencia de <b>${data.empresa || 'esta empresa'}</b> finalizó el <b>${data.expiracion || ''}</b>.`;

      if (isPrueba) {
        title = `🎁 Período de Prueba Finalizado · ${data.empresa || 'Tienda'}`;
        icon = '🎁';
        desc = `Tu período de <b>prueba gratuita de 15 días</b> para <b>${data.empresa || 'esta empresa'}</b> ha concluido.<br>
        ¡Todo tu inventario, clientes y configuraciones están <b>100% guardados y respaldados</b>! Puedes contratar tu plan mensual o anual para continuar vendiendo de inmediato.`;
      } else if (isMensual) {
        title = `💳 Mensualidad Vencida · ${data.empresa || 'Tienda'}`;
        icon = '💳';
        desc = `La suscripción mensual de <b>${data.empresa || 'esta empresa'}</b> finalizó el <b>${data.expiracion || ''}</b>.<br>
        Tus datos, productos y facturas SRI están <b>100% seguros y respaldados</b> esperando tu renovación mensual para reactivar el servicio al instante.`;
      } else {
        title = `🏆 Licencia Anual Expirada · ${data.empresa || 'Tienda'}`;
        icon = '🏆';
        desc = `El período de servicio anual de <b>${data.empresa || 'esta empresa'}</b> finalizó el <b>${data.expiracion || ''}</b>.<br>
        Todos tus datos, inventario y facturas tributarias del SRI están <b>100% seguros y respaldados</b> esperando tu renovación anual.`;
      }

      const titleEl = document.getElementById('agLockCompanyTitle');
      const descEl = document.getElementById('agLockDesc');
      if (titleEl) titleEl.textContent = title;
      if (descEl) descEl.innerHTML = desc;

      const waLink = document.getElementById('agLockWaLink');
      if (waLink) {
        const textParam = encodeURIComponent(`Hola, deseo renovar / contratar la licencia (${isPrueba ? 'Prueba 15 días' : (isMensual ? 'Plan Mensual' : 'Plan Anual')}) para mi empresa: ${data.empresa || ''}`);
        waLink.href = `https://wa.me/593968433458?text=${textParam}`;
      }
    }
  }

  // 4. Initial check for Tenant branding
  async function loadTenantBrand() {
    try {
      const res = await originalFetch('/api/tenant/current', {
        headers: { 'X-Tenant-Slug': tenantSlug }
      });
      const json = await res.json();
      if (json.success && json.data) {
        const t = json.data;
        window.__TENANT_DATA__ = t;
        
        // Update document title if not already branded
        if (t.nombre_comercial && t.slug !== 'rs-store') {
          document.title = `${t.nombre_comercial} · Tienda Oficial`;
        }

        // Check license status
        if (!t.isLicensed) {
          showLicenseLockScreen({
            empresa: t.nombre_comercial,
            expiracion: t.licencia_fin,
            licencia_tipo: t.licencia_tipo,
            telefono_soporte: t.telefono_contacto
          });
        } else if (window.location.pathname.includes('/admin')) {
          // Banner de prueba de 15 días o mensualidad próxima a vencer
          const daysRemaining = Math.max(0, Math.ceil((new Date(t.licencia_fin) - new Date()) / (1000 * 60 * 60 * 24)));
          let bannerHtml = '';
          if (t.licencia_tipo === 'PRUEBA') {
            bannerHtml = `
              <div id="agTrialBanner" style="background: linear-gradient(90deg, #EC4899, #8B5CF6); color: #fff; padding: 10px 18px; font-size: 13px; font-weight: 600; display: flex; align-items: center; justify-content: space-between; gap: 12px; z-index: 9999; box-shadow: 0 4px 14px rgba(236,72,153,0.3);">
                <div style="display: flex; align-items: center; gap: 8px;">
                  <span style="font-size: 16px;">🎁</span>
                  <span><b>Período de Prueba Activo (15 días):</b> Te quedan <b>${daysRemaining} días</b> de prueba gratuita.</span>
                </div>
                <a href="https://wa.me/593968433458?text=Hola,%20deseo%20contratar%20el%20plan%20para%20${encodeURIComponent(t.nombre_comercial)}" target="_blank" style="background: #fff; color: #8B5CF6; padding: 5px 12px; border-radius: 999px; text-decoration: none; font-size: 12px; font-weight: 700;">
                  Contratar Plan Mensual / Anual ↗
                </a>
              </div>
            `;
          } else if (t.licencia_tipo === 'MENSUAL' && daysRemaining <= 7) {
            bannerHtml = `
              <div id="agTrialBanner" style="background: linear-gradient(90deg, #F59E0B, #D97706); color: #fff; padding: 10px 18px; font-size: 13px; font-weight: 600; display: flex; align-items: center; justify-content: space-between; gap: 12px; z-index: 9999;">
                <div style="display: flex; align-items: center; gap: 8px;">
                  <span style="font-size: 16px;">⏰</span>
                  <span><b>Renovación Mensual Próxima:</b> Tu suscripción vence en <b>${daysRemaining} días</b> (${t.licencia_fin}).</span>
                </div>
                <a href="https://wa.me/593968433458?text=Hola,%20deseo%20pagar%20mi%20mensualidad%20de%20${encodeURIComponent(t.nombre_comercial)}" target="_blank" style="background: #fff; color: #B45309; padding: 5px 12px; border-radius: 999px; text-decoration: none; font-size: 12px; font-weight: 700;">
                  Pagar Mensualidad ↗
                </a>
              </div>
            `;
          }
          if (bannerHtml && !document.getElementById('agTrialBanner')) {
            document.body.insertAdjacentHTML('afterbegin', bannerHtml);
          }
        }
      }
    } catch(e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadTenantBrand);
  } else {
    loadTenantBrand();
  }
})();
