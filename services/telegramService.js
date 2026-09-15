const { db } = require('../database/db.js');
const { createInvoice } = require('./invoiceService.js');

let pollingActive = false;
let lastUpdateId = 0;
let isProcessingUpdates = false;

function getConfig(key, defaultVal = '') {
  try {
    const row = db.prepare('SELECT valor FROM configuracion WHERE clave = ?').get(key);
    return row ? row.valor : defaultVal;
  } catch (e) {
    return defaultVal;
  }
}

function getBotToken() {
  return (process.env.TELEGRAM_BOT_TOKEN || getConfig('telegram_bot_token', '8842570395:AAHeIO1VJq8HHFZU4C3xhOq1uulFQjGnWHw')).trim();
}

/**
 * Envía un mensaje a un chat específico vía Telegram
 */
async function sendTelegramMessage(chatId, text, options = {}) {
  const token = getBotToken();
  if (!token || !chatId) {
    return { success: false, error: 'Telegram no está configurado (Token o Chat ID ausente)' };
  }

  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const payload = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      ...options
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    let json = await res.json();

    // Si falló por formato HTML (parse entities), reintentar en texto plano para garantizar entrega
    if (!json.ok && json.description && json.description.toLowerCase().includes('parse')) {
      const cleanText = text.replace(/<[^>]*>/g, '');
      const retryRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: cleanText,
          ...options,
          parse_mode: undefined
        })
      });
      json = await retryRes.json();
    }

    return json;
  } catch (err) {
    console.error('Error enviando mensaje a Telegram:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Notifica un nuevo pedido a todos los administradores y usuarios vinculados
 */
async function notifyOrderToTelegram(pedidoId, comprobanteId = null) {
  const token = getConfig('telegram_bot_token', '');
  const activo = getConfig('telegram_activo', '0') === '1';

  if (!token || !activo) return;

  try {
    const pedido = db.prepare(`
      SELECT p.*, c.razon_social as cliente_nombre, c.num_doc as cliente_doc, c.telefono as cliente_telefono
      FROM pedidos p
      LEFT JOIN clientes c ON p.cliente_id = c.id
      WHERE p.id = ?
    `).get(pedidoId);

    if (!pedido) return;

    const items = db.prepare('SELECT * FROM pedido_items WHERE pedido_id = ?').all(pedidoId);
    const itemsText = items.map(it => `• ${it.producto_nombre} ${it.talla ? `(Talla: <b>${it.talla}</b>)` : ''} x${it.cantidad} - $${it.subtotal.toFixed(2)}`).join('\n');

    let comprobante = null;
    if (comprobanteId) {
      comprobante = db.prepare('SELECT * FROM comprobantes_pago WHERE id = ?').get(comprobanteId);
    } else {
      comprobante = db.prepare('SELECT * FROM comprobantes_pago WHERE pedido_id = ? ORDER BY id DESC LIMIT 1').get(pedidoId);
    }

    let ocrSection = '<i>Sin comprobante bancario adjunto aún.</i>';
    if (comprobante) {
      const badge = comprobante.estado === 'VALIDADO_OK' ? '🟢 <b>VALIDADO AUTOMÁTICO</b>' :
                    comprobante.estado === 'DUPLICADO' ? '🔴 <b>DUPLICADO SOSPECHOSO</b>' : '🟡 <b>EN REVISIÓN</b>';
      ocrSection = `🏛 <b>Banco:</b> ${comprobante.banco || 'N/A'}\n` +
                   `💵 <b>Monto OCR:</b> $${comprobante.monto ? comprobante.monto.toFixed(2) : '0.00'}\n` +
                   `🔢 <b>No. Referencia:</b> ${comprobante.referencia || 'N/A'}\n` +
                   `📅 <b>Fecha Pago:</b> ${comprobante.fecha_transferencia || 'N/A'}\n` +
                   `👤 <b>Beneficiario:</b> ${comprobante.titular_detectado || 'N/A'}\n` +
                   `🚦 <b>Dictamen:</b> ${badge}`;
    }

    // Datos de entrega Servientrega
    let envioInfo = '';
    if (pedido.tipo_entrega === 'AGENCIA') {
      envioInfo = `🏢 <b>Retiro Agencia:</b> ${pedido.agencia_servientrega || 'Agencia Servientrega'} (${pedido.ciudad || ''}, ${pedido.provincia || ''})`;
    } else {
      const calleCompleta = [pedido.calle_principal, pedido.numero_casa, pedido.calle_secundaria ? `y ${pedido.calle_secundaria}` : ''].filter(Boolean).join(' ');
      envioInfo = `🏠 <b>Domicilio:</b> ${calleCompleta || pedido.direccion_envio || 'Ecuador'}\n` +
                  `📍 <b>Ciudad/Provincia:</b> ${pedido.ciudad || 'Guayaquil'}, ${pedido.provincia || 'Guayas'}` +
                  (pedido.referencia ? `\n🔎 <b>Ref Servientrega:</b> ${pedido.referencia}` : '') +
                  (pedido.gps_maps_url ? `\n📌 <b>Ubicación GPS:</b> <a href="${pedido.gps_maps_url}">Ver en Google Maps</a>` : '');
    }

    const text = `🛍 <b>¡NUEVO PEDIDO RECIBIDO EN RS STORE!</b>\n\n` +
                 `📦 <b>Código:</b> <code>${pedido.codigo_pedido}</code>\n` +
                 `👤 <b>Cliente:</b> ${pedido.cliente_nombre}\n` +
                 `📱 <b>WhatsApp:</b> ${pedido.cliente_telefono || 'No registrado'}\n\n` +
                 `🚚 <b>LOGÍSTICA SERVIENTREGA:</b>\n${envioInfo}\n\n` +
                 `<b>Prendas Solicitadas:</b>\n${itemsText}\n\n` +
                 `💰 <b>TOTAL A COBRAR: $${pedido.total.toFixed(2)}</b>\n` +
                 `💳 <b>Método de Pago:</b> ${pedido.metodo_pago}\n\n` +
                 `<b>Verificación Bancaria (OCR):</b>\n${ocrSection}`;

    const inlineKeyboard = {
      inline_keyboard: [
        [
          { text: '✅ Aprobar & Facturar SRI', callback_data: `approve:${pedido.id}:${comprobante ? comprobante.id : 0}` },
          { text: '🚚 Marcar Despachado', callback_data: `ship:${pedido.id}` }
        ],
        [
          { text: '❌ Rechazar Pago', callback_data: `reject:${pedido.id}:${comprobante ? comprobante.id : 0}` },
          { text: '🌐 Ver en Panel', url: 'http://localhost:3000/admin.html' }
        ]
      ]
    };

    // Recopilar todos los Chat IDs a notificar:
    const chatIds = new Set();
    const mainChatId = getConfig('telegram_chat_id', '');
    if (mainChatId) chatIds.add(mainChatId);

    // Usuarios del personal vinculados
    try {
      const linkedUsers = db.prepare(`SELECT telegram_chat_id FROM usuarios WHERE telegram_chat_id IS NOT NULL AND telegram_chat_id != '' AND activo = 1`).all();
      for (const u of linkedUsers) {
        if (u.telegram_chat_id) chatIds.add(u.telegram_chat_id);
      }
    } catch(e) {}

    // Enviar a todos los destinatarios
    for (const cId of chatIds) {
      await sendTelegramMessage(cId, text, { reply_markup: inlineKeyboard });
    }
  } catch (err) {
    console.error('Error notificando pedido a Telegram:', err.message);
  }
}

/**
 * Vincula un usuario del sistema por su cédula o nombre de usuario
 */
function vincularUsuarioTelegram(chatId, fromUsername, inputDocOrUser) {
  const clean = inputDocOrUser.trim().replace(/^@/, '');
  if (!clean) return null;

  const user = db.prepare(`
    SELECT * FROM usuarios 
    WHERE (num_doc = ? OR username = ? OR telefono = ? OR LOWER(username) = LOWER(?)) 
      AND activo = 1 
    LIMIT 1
  `).get(clean, clean, clean, clean);

  if (!user) return null;

  // Actualizar vinculación en la base de datos
  db.prepare(`
    UPDATE usuarios 
    SET telegram_chat_id = ?, telegram_username = ? 
    WHERE id = ?
  `).run(String(chatId), fromUsername || '', user.id);

  // Si el usuario es ADMIN, fijarlo también como chat de alerta principal de la tienda
  if (user.rol === 'ADMIN') {
    db.prepare(`UPDATE configuracion SET valor = ? WHERE clave = 'telegram_chat_id'`).run(String(chatId));
    db.prepare(`UPDATE configuracion SET valor = '1' WHERE clave = 'telegram_activo'`).run();
  }

  return user;
}

const { processAdminQuery } = require('./adminQueryService.js');

function getMainMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '📦 Pedidos Web', callback_data: 'query:pedidos' },
        { text: '💰 Ventas de Hoy', callback_data: 'query:ventas' }
      ],
      [
        { text: '🏦 Balance de Caja', callback_data: 'query:caja' },
        { text: '⚠️ Stock Crítico', callback_data: 'query:stock' }
      ],
      [
        { text: '🧾 Facturas SRI', callback_data: 'query:facturas' },
        { text: '🌐 Panel Admin', url: 'http://localhost:3000/admin.html' }
      ]
    ]
  };
}

/**
 * Procesa mensajes y comandos de texto entrantes
 */
async function handleIncomingMessage(msg) {
  const chatId = msg.chat?.id;
  if (!chatId) return;

  const text = (msg.text || '').trim();
  const fromUsername = msg.from?.username || msg.from?.first_name || '';

  // 1. Comando /start
  if (text.startsWith('/start')) {
    const parts = text.split(' ');
    if (parts.length > 1 && parts[1].trim()) {
      // /start 0923456789
      const vinculacion = vincularUsuarioTelegram(chatId, fromUsername, parts[1].trim());
      if (vinculacion) {
        await sendTelegramMessage(chatId, 
          `✅ <b>¡Cuenta Vinculada con Éxito!</b>\n\n` +
          `👤 <b>Nombre:</b> ${vinculacion.nombre}\n` +
          `👑 <b>Rol:</b> ${vinculacion.rol}\n` +
          `🆔 <b>Cédula/Usuario:</b> <code>${vinculacion.num_doc || vinculacion.username}</code>\n\n` +
          `Bienvenido al Asistente Inteligente de RS Store. Puedes hacerme preguntas como:\n` +
          `• <i>"¿Cuánto vendimos hoy?"</i>\n` +
          `• <i>"¿Qué pedidos faltan despachar?"</i>\n` +
          `• <i>"¿Cuánto hay en caja?"</i>\n` +
          `• <i>"Stock de vestidos"</i>\n` +
          `O usa el menú interactivo abajo:`,
          { reply_markup: getMainMenuKeyboard() }
        );
        return;
      }
    }

    // Si ya está vinculado
    const alreadyUser = db.prepare(`SELECT * FROM usuarios WHERE telegram_chat_id = ? AND activo = 1`).get(String(chatId));
    if (alreadyUser) {
      await sendTelegramMessage(chatId,
        `👋 ¡Hola, <b>${alreadyUser.nombre}</b>! (${alreadyUser.rol})\n\n` +
        `¿Qué deseas consultar en el sistema hoy? Selecciona una opción o escribe tu pregunta en lenguaje natural:`,
        { reply_markup: getMainMenuKeyboard() }
      );
      return;
    }

    // Mensaje inicial pidiendo cédula
    await sendTelegramMessage(chatId,
      `👋 ¡Hola! Bienvenido al Bot de Administración y Consultas de <b>RS Store Boutique</b>.\n\n` +
      `Para vincular tu cuenta y acceder a consultas de ventas, inventario y despachos:\n\n` +
      `👉 <b>Escribe aquí tu número de Cédula</b> o tu <b>Usuario</b> registrado en el sistema (ejemplo: <code>0999999999</code> o <code>admin</code>).`
    );
    return;
  }

  // 2. Comando /menu o /ayuda
  if (text === '/menu' || text === '/ayuda' || text === '/help') {
    await sendTelegramMessage(chatId,
      `📖 <b>Centro de Consultas y Operaciones RS Store:</b>\n\n` +
      `Puedes escribir preguntas directamente o tocar un botón rápido:`,
      { reply_markup: getMainMenuKeyboard() }
    );
    return;
  }

  // 3. Auto-vinculación directa con cédula si aún no está vinculado
  let checkLinked = db.prepare(`SELECT id, nombre, rol FROM usuarios WHERE telegram_chat_id = ? AND activo = 1`).get(String(chatId));
  
  // Auto-reconocer al administrador principal por su chatId oficial de Steven
  const isMasterAdmin = String(chatId) === '5857562616' || String(chatId) === String(getConfig('telegram_chat_id', '5857562616'));
  if (!checkLinked && isMasterAdmin) {
    checkLinked = vincularUsuarioTelegram(chatId, fromUsername, 'admin') || { nombre: 'Steven (Administrador)', rol: 'ADMIN' };
  }

  if (!checkLinked) {
    // Si escribió un saludo sin estar vinculado todavía
    const isGreeting = ['hola', 'buenas', 'hey', 'start', 'buen dia'].some(s => text.toLowerCase().includes(s));
    if (isGreeting) {
      await sendTelegramMessage(chatId,
        `👋 ¡Hola! Bienvenido al Asistente Inteligente de <b>RS Store Boutique</b>.\n\n` +
        `Para vincular tu cuenta y habilitar consultas de ventas, inventario y pedidos en vivo:\n\n` +
        `👉 <b>Escribe aquí tu número de Cédula</b> o tu <b>Usuario</b> registrado en el sistema (ejemplo: <code>0942610361</code> o <code>admin</code>).`
      );
      return;
    }

    const vinculacionDirecta = vincularUsuarioTelegram(chatId, fromUsername, text);
    if (vinculacionDirecta) {
      await sendTelegramMessage(chatId,
        `✅ <b>¡Identificación Reconocida con Éxito!</b>\n\n` +
        `Bienvenido/a <b>${vinculacionDirecta.nombre}</b>. Tu cuenta con rol <b>${vinculacionDirecta.rol}</b> ha quedado vinculada.\n\n` +
        `A partir de ahora recibirás aquí notificaciones en vivo y puedes realizar cualquier consulta al sistema.`,
        { reply_markup: getMainMenuKeyboard() }
      );
      return;
    } else {
      await sendTelegramMessage(chatId,
        `⚠️ No se encontró ningún usuario con la identificación <code>${text}</code>.\n\n` +
        `Para vincularte, asegúrate de ingresar el número de <b>Cédula</b> o <b>Usuario</b> con el que fuiste registrado en el panel "Equipo & Usuarios" de RS Store.`
      );
      return;
    }
  }

  // 4. Procesar consulta inteligente del administrador (para usuarios vinculados)
  try {
    const res = await processAdminQuery(text);

    if (res.type === 'GREETING') {
      await sendTelegramMessage(chatId, res.message, { reply_markup: getMainMenuKeyboard() });
      return;
    }

    if (res.type === 'VENTAS') {
      const d = res.details;
      let msgText = `📊 <b>REPORTE FINANCIERO & FACTURACIÓN SRI:</b>\n\n` +
                    `📅 <b>HOY:</b>\n` +
                    `• Facturas emitidas: <b>${d.hoy.facturas}</b>\n` +
                    `• Total recaudado: <b>${d.hoy.total}</b>\n` +
                    `• Base imponible: <b>${d.hoy.base}</b>\n` +
                    `• IVA recaudado (15%): <b>${d.hoy.iva}</b>\n\n` +
                    `📈 <b>HISTÓRICO GENERAL:</b>\n` +
                    `• Total Facturado: <b>${d.historico.total}</b> (${d.historico.facturas} facturas)`;
      await sendTelegramMessage(chatId, msgText, { reply_markup: getMainMenuKeyboard() });
      return;
    }

    if (res.type === 'PEDIDOS') {
      const d = res.details;
      let msgText = `📦 <b>ESTADO DE PEDIDOS & DESPACHOS:</b>\n\n` +
                    `🟢 Pagados (Listos para embalar): <b>${d.kpis.pagados}</b>\n` +
                    `🟡 En revisión de pago: <b>${d.kpis.pendientes}</b>\n` +
                    `🚚 Despachados: <b>${d.kpis.enviados}</b>\n\n` +
                    `<b>Últimos pedidos registrados:</b>\n`;
      for (const p of d.pedidos.slice(0, 5)) {
        const badge = p.estado === 'PAGADO' ? '🟢' : p.estado === 'ENVIADO' ? '🚚' : '🟡';
        msgText += `${badge} <b>Pedido #${p.codigo}</b> (${p.total})\n` +
                   `• Cliente: <i>${p.cliente}</i>\n` +
                   `• Destino: ${p.ciudad} - ${p.tipo_entrega}\n\n`;
      }
      await sendTelegramMessage(chatId, msgText, { reply_markup: getMainMenuKeyboard() });
      return;
    }

    if (res.type === 'CAJA') {
      const d = res.details;
      let msgText = `🏦 <b>BALANCE DE CAJA & BANCOS:</b>\n\n` +
                    `💰 <b>Saldo Neto Disponible:</b> <code>${d.saldo_neto}</code>\n` +
                    `📥 Total Ingresos: <b>${d.total_ingresos}</b>\n` +
                    `📤 Total Egresos: <b>${d.total_egresos}</b>\n` +
                    `📑 Comprobantes pendientes: <b>${d.comprobantes_pendientes}</b>\n\n` +
                    `<b>Últimos movimientos de caja:</b>\n`;
      for (const m of d.movimientos) {
        msgText += `• ${m.tipo === 'INGRESO' ? '🟢' : '🔴'} <b>${m.monto}</b> - ${m.concepto} (<i>${m.fecha.split(' ')[0]}</i>)\n`;
      }
      await sendTelegramMessage(chatId, msgText, { reply_markup: getMainMenuKeyboard() });
      return;
    }

    if (res.type === 'STOCK_CRITICO') {
      const d = res.details;
      let msgText = `⚠️ <b>ALERTAS DE STOCK CRÍTICO:</b>\n\n`;
      if (!d.criticos.length) {
        msgText += `🟢 Todo el inventario se encuentra en niveles normales (${d.total_catalogo} productos activos).`;
      } else {
        for (const p of d.criticos) {
          msgText += `• <b>${p.nombre}</b> (${p.categoria}): <b>${p.estado}</b> - ${p.precio}\n`;
        }
      }
      await sendTelegramMessage(chatId, msgText, { reply_markup: getMainMenuKeyboard() });
      return;
    }

    if (res.type === 'STOCK_BUSQUEDA') {
      const prods = res.details.productos;
      let msgText = `🛍️ <b>RESULTADOS DE INVENTARIO:</b>\n\n`;
      for (const p of prods) {
        let tallasStr = '';
        if (p.tallas) {
          tallasStr = Object.entries(p.tallas).map(([k, v]) => `${k}:${v}`).join(', ');
        }
        msgText += `👗 <b>${p.nombre}</b> (${p.categoria})\n` +
                   `• Precio: <b>${p.precio}</b> | Stock Total: <b>${p.stock_total} unids</b>\n` +
                   (tallasStr ? `• Tallas: <code>[${tallasStr}]</code>\n\n` : '\n');
      }
      await sendTelegramMessage(chatId, msgText, { reply_markup: getMainMenuKeyboard() });
      return;
    }

    if (res.type === 'CLIENTES') {
      const clis = res.details.clientes;
      let msgText = `👤 <b>CLIENTES ENCONTRADOS:</b>\n\n`;
      for (const c of clis) {
        msgText += `• <b>${c.nombre}</b>\n` +
                   `  Doc: <code>${c.doc}</code> | Tel: ${c.telefono || 'N/A'}\n` +
                   `  Compras: ${c.pedidos} pedidos | Gasto: <b>${c.gasto_total}</b>\n\n`;
      }
      await sendTelegramMessage(chatId, msgText, { reply_markup: getMainMenuKeyboard() });
      return;
    }

    // Default
    await sendTelegramMessage(chatId, res.message || res.summary, { reply_markup: getMainMenuKeyboard() });
  } catch(err) {
    await sendTelegramMessage(chatId, `⚠️ Error al procesar tu consulta: ${err.message}`, { reply_markup: getMainMenuKeyboard() });
  }
}

/**
 * Procesa clics en botones de acción y nuevos mensajes entrantes
 */
async function processTelegramUpdates() {
  const token = getBotToken();
  if (!token) return;

  if (isProcessingUpdates) return;
  isProcessingUpdates = true;

  try {
    const offsetParam = lastUpdateId > 0 ? `offset=${lastUpdateId + 1}&` : '';
    const url = `https://api.telegram.org/bot${token}/getUpdates?${offsetParam}timeout=8`;
    
    // Controlador de timeout para evitar sockets colgados
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), 16000);

    let json = null;
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutHandle);
      json = await res.json();
    } catch (netErr) {
      clearTimeout(timeoutHandle);
      return;
    }

    if (json && !json.ok && json.error_code === 409) {
      // 409 Conflict: Otra instancia (ej. producción vs local) está consultando Telegram
      console.warn('[Telegram Bot] Aviso: Conflicto 409 detectado (otra instancia está haciendo polling). Pausando 15 segundos...');
      await new Promise(r => setTimeout(r, 15000));
      return;
    }

    if (json && json.ok && Array.isArray(json.result) && json.result.length > 0) {
      for (const update of json.result) {
        lastUpdateId = update.update_id;
        try {
          // A) Manejar mensajes de texto entrantes (/start, cédula, /pedidos, /ventas, etc.)
          if (update.message && update.message.text) {
            console.log(`[Telegram Bot] Mensaje recibido de ${update.message.from?.first_name || 'usuario'} (${update.message.chat?.id}): "${update.message.text}"`);
            await handleIncomingMessage(update.message);
          }

          // B) Manejar botones interactivos de aprobación y despacho
          if (update.callback_query) {
            const cq = update.callback_query;
            const data = cq.data || '';
            const parts = data.split(':');
            const action = parts[0];
            const pedidoId = parseInt(parts[1], 10);
            const compId = parseInt(parts[2], 10);
            let replyToast = 'Acción procesada';

          // Consultas directas desde botones del bot (/ventas, /pedidos, /caja, /stock)
          if (action === 'query') {
            const queryTarget = parts[1];
            await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ callback_query_id: cq.id, text: 'Consultando datos en tiempo real...' })
            });
            await handleIncomingMessage({
              chat: { id: cq.message.chat.id },
              from: cq.from,
              text: '/' + queryTarget
            });
            continue;
          }

          if (action === 'approve') {
            db.prepare("UPDATE pedidos SET estado = 'PAGADO' WHERE id = ?").run(pedidoId);
            if (compId > 0) {
              db.prepare("UPDATE comprobantes_pago SET estado = 'VALIDADO_OK', conciliado = 1 WHERE id = ?").run(compId);
            }

            const ped = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(pedidoId);
            if (ped) {
              db.prepare(`
                INSERT INTO movimientos_caja (tipo, categoria, monto, descripcion, comprobante_id, metodo_pago, estado)
                VALUES ('INGRESO', 'VENTA_WEB', ?, ?, ?, ?, 'CONCILIADO')
              `).run(ped.total, `Venta Web Aprobada Pedido #${ped.codigo_pedido}`, compId > 0 ? compId : null, ped.metodo_pago);

              const existingInv = db.prepare('SELECT id, secuencial FROM facturas WHERE pedido_id = ?').get(pedidoId);
              let secuencialFact = '';
              if (!existingInv) {
                const items = db.prepare('SELECT * FROM pedido_items WHERE pedido_id = ?').all(pedidoId);
                const inv = createInvoice({
                  cliente_id: ped.cliente_id,
                  pedido_id: ped.id,
                  items: items.map(it => ({
                    producto_id: it.producto_id,
                    descripcion: it.producto_nombre,
                    cantidad: it.cantidad,
                    precio_unitario: it.precio_unitario,
                    talla: it.talla
                  })),
                  forma_pago: '20 - OTROS CON UTILIZACION DEL SISTEMA FINANCIERO (TRANSFERENCIA)',
                  notas: `Aprobado vía Telegram. Pedido #${ped.codigo_pedido}`
                });
                secuencialFact = inv.secuencial;
              } else {
                secuencialFact = existingInv.secuencial;
              }

              replyToast = `✅ Pedido #${ped.codigo_pedido} Aprobado. Factura SRI: ${secuencialFact}`;

              const updatedText = (cq.message.text || '') + `\n\n══════════════════════\n✅ <b>ESTADO:</b> APROBADO & FACTURADO\n🧾 <b>Factura SRI:</b> <code>${secuencialFact}</code>`;
              await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  chat_id: cq.message.chat.id,
                  message_id: cq.message.message_id,
                  text: updatedText,
                  parse_mode: 'HTML'
                })
              });
            }
          } else if (action === 'ship') {
            db.prepare("UPDATE pedidos SET estado = 'ENVIADO' WHERE id = ?").run(pedidoId);
            replyToast = '🚚 Pedido marcado como DESPACHADO / ENVIADO';
            const updatedText = (cq.message.text || '') + `\n\n══════════════════════\n🚚 <b>ESTADO:</b> DESPACHADO POR SERVIENTREGA`;
            await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: cq.message.chat.id,
                message_id: cq.message.message_id,
                text: updatedText,
                parse_mode: 'HTML'
              })
            });
          } else if (action === 'reject') {
            db.prepare("UPDATE pedidos SET estado = 'CANCELADO' WHERE id = ?").run(pedidoId);
            if (compId > 0) {
              db.prepare("UPDATE comprobantes_pago SET estado = 'RECHAZADO_TITULAR' WHERE id = ?").run(compId);
            }
            replyToast = '❌ Comprobante rechazado y pedido cancelado';
            const updatedText = (cq.message.text || '') + `\n\n══════════════════════\n❌ <b>ESTADO:</b> PAGO RECHAZADO`;
            await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: cq.message.chat.id,
                message_id: cq.message.message_id,
                text: updatedText,
                parse_mode: 'HTML'
              })
            });
          }

          // Responder al callback query
          await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: cq.id, text: replyToast })
          });
        }
      } catch (singleErr) {
        console.error('Error en update de Telegram:', singleErr.message);
      }
    }
  }
  } catch (err) {
    // Error silencioso
  } finally {
    isProcessingUpdates = false;
  }
}

/**
 * Inicia el ciclo de polling continuo en segundo plano
 */
function startTelegramPolling() {
  if (pollingActive) return;
  pollingActive = true;
  console.log('[Telegram Bot] Servicio de recepción y respuestas automáticas iniciado.');

  // Bucle asíncrono permanente de polling
  (async function loop() {
    while (pollingActive) {
      try {
        const token = getConfig('telegram_bot_token', '');
        if (token) {
          await processTelegramUpdates();
        }
      } catch (err) {
        console.error('[Telegram Loop Error]:', err.message);
      }
      // Pequeña pausa de 1 segundo entre ciclos para máxima capacidad de respuesta
      await new Promise(r => setTimeout(r, 1000));
    }
  })();
}

/**
 * Prueba la validez del token y el chat_id con diagnóstico preciso
 */
async function testTelegramBot(customToken = null, customChatId = null) {
  const token = (customToken || getConfig('telegram_bot_token', '')).trim();
  const chatId = (customChatId || getConfig('telegram_chat_id', '')).trim();

  if (!token) {
    return {
      success: false,
      error: 'Debes ingresar el Token generado por @BotFather (Ej: 123456789:ABCDef...)'
    };
  }

  // Guardar token en DB inmediatamente para que sea persistente
  try {
    db.prepare(`UPDATE configuracion SET valor = ? WHERE clave = 'telegram_bot_token'`).run(token);
    db.prepare(`UPDATE configuracion SET valor = '1' WHERE clave = 'telegram_activo'`).run();
  } catch (e) {}

  // 1. Probar que el bot exista en Telegram usando getMe
  let botData = null;
  try {
    const meRes = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const meJson = await meRes.json();
    if (!meJson.ok) {
      return {
        success: false,
        error: `El Token ingresado no es válido para Telegram: ${meJson.description || 'Token inválido'}. Asegúrate de copiarlo completo desde @BotFather.`
      };
    }
    botData = meJson.result;
  } catch (err) {
    return { success: false, error: `Error conectando con Telegram API: ${err.message}` };
  }

  // 2. Si no hay chat_id, sugerir vinculación automática por cédula
  if (!chatId) {
    return {
      success: true,
      bot: botData,
      warning: `✅ Bot @${botData.username} verificado y operativo. Para recibir mensajes, abre Telegram, busca a @${botData.username} y envíale tu número de Cédula o Usuario para vincularte automáticamente.`
    };
  }

  // 3. Probar envío de mensaje al chat_id
  try {
    const testText = `🔔 <b>¡Conexión Exitosa con RS Store!</b>\n\nTu bot de administración <b>@${botData.username}</b> está activo, en línea y listo para consultas en vivo.\n\nPrueba enviar:\n📦 /pedidos\n💰 /ventas\n📊 /stock`;
    const sendRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: testText,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🌐 Abrir Panel RS Store', url: 'http://localhost:3000/admin.html' }]
          ]
        }
      })
    });
    const sendJson = await sendRes.json();
    if (!sendJson.ok) {
      if (sendJson.error_code === 400 || sendJson.error_code === 403) {
        return {
          success: true,
          bot: botData,
          messageWarning: `El bot @${botData.username} está en línea, pero aún no le has dado permiso de escribirte. Abre Telegram, busca a @${botData.username} y presiona "INICIAR" (o envíale tu cédula) para vincularte.`
        };
      }
      return {
        success: false,
        bot: botData,
        error: `Error al enviar mensaje a Telegram: ${sendJson.description}`
      };
    }

    try {
      db.prepare(`UPDATE configuracion SET valor = ? WHERE clave = 'telegram_chat_id'`).run(chatId);
    } catch(e) {}

    return {
      success: true,
      bot: botData,
      messageSent: true,
      message: `¡Conexión exitosa! El bot @${botData.username} te acaba de enviar un mensaje interactivo de prueba a Telegram.`
    };
  } catch (err) {
    return { success: false, bot: botData, error: err.message };
  }
}

module.exports = {
  sendTelegramMessage,
  notifyOrderToTelegram,
  startTelegramPolling,
  testTelegramBot,
  vincularUsuarioTelegram
};
