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
        } else {
          // Rehidratar identidad visual de la tienda en storefront
          rehydrateStorefrontBrand(t);
        }
      }
    } catch(e) {}
  }

  function rehydrateStorefrontBrand(t) {
    if (!t) return;

    // 1. Inyectar colores de marca
    if (t.color_primario) {
      document.documentElement.style.setProperty('--accent', t.color_primario);
      document.documentElement.style.setProperty('--accent-deep', t.color_secundario || t.color_primario);
      document.documentElement.style.setProperty('--accent-soft', t.color_suave || '#FDF2F8');
      document.documentElement.style.setProperty('--primary', t.color_primario);
    }

    const adminUrl = (t.slug && t.slug !== 'rs-store') ? `/t/${t.slug}/admin` : '/admin';

    // 2. Si no es RS Store, personalizar logotipo y textos
    if (t.slug !== 'rs-store') {
      // Navbar Logo watermark
      const wm = document.querySelector('.logo .wm');
      if (wm) {
        wm.innerHTML = `<b>${escapeHtml(t.nombre_comercial)}</b><span>${escapeHtml(t.slogan || 'TIENDA OFICIAL')}</span>`;
      }

      // Logotipo dinámico o monograma en caso de no tener imagen
      const logoImgs = document.querySelectorAll('.store-dyn-logo');
      const initials = (t.nombre_comercial || 'ST')
        .split(' ')
        .map(w => w[0])
        .filter(Boolean)
        .slice(0, 2)
        .join('')
        .toUpperCase();

      const monogramSvg = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="26" fill="${encodeURIComponent(t.color_secundario || '#7B113A')}"/><text x="50%" y="54%" font-family="system-ui,sans-serif" font-weight="900" font-size="38" fill="%23ffffff" dominant-baseline="middle" text-anchor="middle">${initials}</text></svg>`;

      logoImgs.forEach(img => {
        if (!img.src || img.src.includes('rs-store-logo.svg')) {
          img.src = monogramSvg;
        }
        img.alt = t.nombre_comercial;
      });

      // Announcement Bar
      const announce = document.querySelector('.announce span');
      if (announce) {
        const envioMin = t.envio_gratis_desde || '50';
        const ciudad = t.ciudad_matriz || 'Ecuador';
        announce.innerHTML = `Envío <b>gratis</b> en compras desde $${envioMin} · Retiro en tienda en <b>${escapeHtml(ciudad)}</b> · Facturación legal SRI`;
      }

      // Hero Eyebrow
      const eyebrow = document.querySelector('.hero .eyebrow');
      if (eyebrow) {
        eyebrow.textContent = `Catálogo 2026 · ${t.nombre_comercial}`;
      }

      // Hero Title
      const heroH1 = document.querySelector('.hero h1');
      if (heroH1 && t.hero_titulo) {
        heroH1.innerHTML = t.hero_titulo;
      } else if (heroH1) {
        heroH1.innerHTML = `${escapeHtml(t.nombre_comercial)} con <em>estilo y calidad.</em>`;
      }

      // Hero Subtitle
      const heroP = document.querySelector('.hero p');
      if (heroP && t.hero_subtitulo) {
        heroP.textContent = t.hero_subtitulo;
      }

      // Hero Background Photo
      const heroBgPhoto = document.getElementById('heroBgPhoto');
      if (heroBgPhoto && t.hero_imagen) {
        heroBgPhoto.src = t.hero_imagen;
        heroBgPhoto.alt = `${t.nombre_comercial} Catálogo`;
      }

      // Hero Card Overlay
      const heroOverlay = document.querySelector('.hero-brand-overlay');
      if (heroOverlay) {
        const b = heroOverlay.querySelector('b');
        const span = heroOverlay.querySelector('span');
        if (b) b.textContent = t.nombre_comercial.toUpperCase();
        if (span) span.textContent = (t.slogan || 'COLECCIÓN EXCLUSIVA 2026').toUpperCase();
      }

      // Footer brand details
      const footBrandP = document.querySelector('.foot-brand p');
      if (footBrandP && t.hero_subtitulo) {
        footBrandP.textContent = `${t.nombre_comercial} · ${t.hero_subtitulo}`;
      }

      const footContact = document.querySelector('.foot-col:last-child');
      if (footContact) {
        footContact.innerHTML = `
          <h4>Contacto</h4>
          <a href="#">${escapeHtml(t.ciudad_matriz || 'Guayaquil')}, Ecuador</a>
          <a href="mailto:${t.email_contacto || 'ventas@tienda.ec'}">${escapeHtml(t.email_contacto || 'ventas@tienda.ec')}</a>
          <a href="https://wa.me/${(t.telefono_contacto || '').replace(/[^0-9]/g, '')}" target="_blank">${escapeHtml(t.telefono_contacto || '+593 99 999 9999')}</a>
        `;
      }

      // Reset default activeGender to TODOS for non-clothing store and hide clothing chips
      if (t.rubro && t.rubro !== 'MODA') {
        window.activeGender = 'TODOS';
        const shopFilters = document.querySelector('.shop-bar .filters');
        if (shopFilters) shopFilters.style.display = 'none';
      }

      // Rehydrate Category Tabs
      if (t.categorias && Array.isArray(t.categorias) && t.categorias.length) {
        const catNav = document.querySelector('.gender-nav-tabs');
        if (catNav) {
          let tabsHtml = `<button type="button" class="gender-tab active" data-cat="all" onclick="handleTenantCatClick('all', this)">TODOS</button>`;
          t.categorias.forEach(cat => {
            tabsHtml += `<button type="button" class="gender-tab" data-cat="${escapeHtml(cat)}" onclick="handleTenantCatClick('${escapeHtml(cat)}', this)">${escapeHtml(cat.toUpperCase())}</button>`;
          });
          tabsHtml += `<button type="button" class="gender-tab promo-tab" data-cat="OFERTAS" onclick="handleTenantCatClick('OFERTAS', this)">🔥 OFERTAS</button>`;
          catNav.innerHTML = tabsHtml;
        }
      }
    }

    // 3. Footer Copyright & Acceso Administrador (Visible y elegante en el pie)
    const footBottom = document.querySelector('.foot-bottom');
    if (footBottom && !document.getElementById('agAdminAccessLink')) {
      const copySpan = footBottom.querySelector('span:first-child');
      if (copySpan) {
        copySpan.innerHTML = `© 2026 <b>${escapeHtml(t.nombre_comercial)}</b> · Facturación SRI`;
      }

      const adminBtn = document.createElement('a');
      adminBtn.id = 'agAdminAccessLink';
      adminBtn.href = adminUrl;
      adminBtn.target = '_blank';
      adminBtn.style.cssText = `
        display: inline-flex; align-items: center; gap: 6px;
        padding: 5px 14px; border-radius: 999px;
        background: rgba(255,255,255,0.08);
        color: var(--accent-deep, #7B113A); font-size: 11.5px; font-weight: 800;
        text-decoration: none; border: 1px solid var(--accent, #A8324E);
        transition: all 0.2s ease; cursor: pointer;
      `;
      adminBtn.innerHTML = `<span>🔒</span> Panel Administrativo (${escapeHtml(t.nombre_comercial)}) ↗`;
      adminBtn.onmouseover = function() { this.style.transform = 'scale(1.04)'; };
      adminBtn.onmouseout = function() { this.style.transform = 'scale(1)'; };
      footBottom.appendChild(adminBtn);
    }

    // 4. Agregar enlace Admin en el menú de cuenta de cliente si existe
    const clientMenuDropdown = document.getElementById('clientMenuDropdown');
    if (clientMenuDropdown && !document.getElementById('agMenuAdminLink')) {
      const listContainer = clientMenuDropdown.querySelector('div:last-child');
      if (listContainer) {
        const menuAdmin = document.createElement('a');
        menuAdmin.id = 'agMenuAdminLink';
        menuAdmin.href = adminUrl;
        menuAdmin.target = '_blank';
        menuAdmin.style.cssText = `
          display: flex; align-items: center; gap: 8px; width: 100%;
          padding: 8px 10px; border-radius: 10px; text-decoration: none;
          background: rgba(99,102,241,0.08); color: #4F46E5;
          font-size: 12.5px; font-weight: 700; margin-top: 4px;
        `;
        menuAdmin.innerHTML = `<span>⚙️</span> Panel de Dueño / Admin ↗`;
        listContainer.appendChild(menuAdmin);
      }
    }
  }

  window.handleTenantCatClick = function(cat, el) {
    if (window.setCategoryFilter) {
      window.setCategoryFilter(cat, el);
    } else if (window.setFilter) {
      window.setFilter(cat, el);
    }
  };

  function escapeHtml(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadTenantBrand);
  } else {
    loadTenantBrand();
  }
})();
