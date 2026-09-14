const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const { db } = require('../database/db.js');

let sock = null;
let currentQrString = null;
let currentQrDataUrl = null;
let connectionStatus = 'INITIALIZING'; // 'INITIALIZING' | 'QR_READY' | 'CONNECTED' | 'DISCONNECTED'
let connectedPhone = null;
let statusMessage = 'Iniciando módulo de WhatsApp Web...';
let isConnecting = false;

const sessionDir = path.join(__dirname, '../data/whatsapp_session');

// Asegurar que exista la carpeta de sesión
if (!fs.existsSync(sessionDir)) {
  fs.mkdirSync(sessionDir, { recursive: true });
}

/**
 * Inicia la conexión con WhatsApp Web mediante Baileys
 */
async function initWhatsApp() {
  if (isConnecting) return;
  isConnecting = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    sock = makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['RS Store Boutique Admin', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQrString = qr;
        try {
          currentQrDataUrl = await QRCode.toDataURL(qr, {
            width: 280,
            margin: 2,
            color: { dark: '#2A1D22', light: '#FFFFFF' }
          });
          connectionStatus = 'QR_READY';
          statusMessage = 'Código QR listo. Abre WhatsApp en tu celular > Dispositivos Vinculados y escanéalo.';
          console.log('⚡ Nuevo código QR de WhatsApp generado y listo para escanear');
        } catch (qrErr) {
          console.error('Error generando QR DataURL:', qrErr);
        }
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        connectionStatus = 'DISCONNECTED';
        currentQrDataUrl = null;
        currentQrString = null;

        console.log(`WhatsApp desconectado. Código: ${statusCode}, Reintentar: ${shouldReconnect}`);

        if (statusCode === DisconnectReason.loggedOut) {
          statusMessage = 'Sesión cerrada. Generando nuevo código QR...';
          // Limpiar archivos de sesión vieja
          try {
            fs.rmSync(sessionDir, { recursive: true, force: true });
            fs.mkdirSync(sessionDir, { recursive: true });
          } catch(e) {}
          isConnecting = false;
          setTimeout(initWhatsApp, 2000);
        } else {
          statusMessage = 'Conexión perdida. Reconectando automáticamente...';
          isConnecting = false;
          setTimeout(initWhatsApp, 4000);
        }
      } else if (connection === 'open') {
        connectionStatus = 'CONNECTED';
        currentQrDataUrl = null;
        currentQrString = null;
        const userJid = sock.user?.id || '';
        connectedPhone = userJid.split(':')[0] || userJid.split('@')[0] || 'Conectado';
        statusMessage = `¡Conectado exitosamente! Número: +${connectedPhone}`;
        console.log(`✅ WhatsApp Web vinculado con éxito: +${connectedPhone}`);
        isConnecting = false;
      }
    });

    // Escuchar mensajes entrantes y salientes para el Inbox y Bot automático
    sock.ev.on('messages.upsert', async (m) => {
      try {
        if (!m.messages || !m.messages.length) return;
        const msg = m.messages[0];
        if (!msg.message) return;

        const remoteJid = msg.key.remoteJid;
        if (!remoteJid || remoteJid.includes('@g.us') || remoteJid === 'status@broadcast' || remoteJid.includes('@newsletter')) return; // Solo chats privados

        const clientPhone = remoteJid.replace('@s.whatsapp.net', '');
        const isFromMe = !!msg.key.fromMe;
        const pushName = msg.pushName || `Cliente (+${clientPhone})`;
        const text = msg.message?.conversation ||
                     msg.message?.extendedTextMessage?.text ||
                     msg.message?.imageMessage?.caption ||
                     '';

        if (!text && !msg.message?.imageMessage) return;

        console.log(`📩 Mensaje WhatsApp detectado de +${clientPhone} (fromMe: ${isFromMe}): "${text}"`);

        // Registrar o actualizar conversación en base de datos (tabla: conversaciones)
        let conv = db.prepare('SELECT * FROM conversaciones WHERE cliente_telefono = ?').get(clientPhone);
        let convId = null;

        if (!conv) {
          const ins = db.prepare(`
            INSERT INTO conversaciones (cliente_nombre, cliente_telefono, ultimo_mensaje, no_leidos, updated_at)
            VALUES (?, ?, ?, ?, datetime('now', 'localtime'))
          `).run(isFromMe ? `Contacto (+${clientPhone})` : pushName, clientPhone, text || '[Imagen/Comprobante]', isFromMe ? 0 : 1);
          convId = ins.lastInsertRowid;
        } else {
          convId = conv.id;
          db.prepare(`
            UPDATE conversaciones 
            SET ultimo_mensaje = ?, updated_at = datetime('now', 'localtime'), no_leidos = ${isFromMe ? 'no_leidos' : 'no_leidos + 1'}
            WHERE id = ?
          `).run(text || '[Imagen/Comprobante]', convId);
        }

        // Insertar mensaje en tabla mensajes
        db.prepare(`
          INSERT INTO mensajes (conversacion_id, remitente, texto, fecha, estado)
          VALUES (?, ?, ?, datetime('now', 'localtime'), 'ENVIADO')
        `).run(convId, isFromMe ? 'ADMIN' : 'CLIENTE', text || '[Imagen/Comprobante]');

        // Si el mensaje viene de un cliente (no propio), disparar auto-respuesta del bot
        if (!isFromMe) {
          await handleBotAutoReply(remoteJid, text, convId);
        }
      } catch (upsertErr) {
        console.error('Error procesando mensaje de WhatsApp:', upsertErr);
      }
    });

  } catch (err) {
    console.error('Error inicializando WhatsApp:', err);
    connectionStatus = 'DISCONNECTED';
    statusMessage = 'Error iniciando WhatsApp: ' + err.message;
    isConnecting = false;
  }
}

/**
 * Manejador de respuestas automáticas configurables
 */
async function handleBotAutoReply(remoteJid, text, convId) {
  if (!text || !sock) return;
  const clean = text.toLowerCase().trim();

  try {
    let replyText = null;

    // Buscar en reglas configuradas en bot_respuestas
    try {
      const rules = db.prepare('SELECT * FROM bot_respuestas').all();
      for (const r of rules) {
        const kw = (r.keyword || '').toLowerCase().trim();
        if (kw && clean.includes(kw)) {
          replyText = r.response;
          break;
        }
      }
    } catch(e) {}

    // Respuestas por defecto inteligentes
    if (!replyText) {
      if (clean.includes('hola') || clean.includes('buenas') || clean.includes('buenos dias') || clean.includes('buenas tardes') || clean.includes('hello') || clean.includes('hi')) {
        replyText = `¡Hola! ✨ Gracias por comunicarte con *RS Store Boutique*.\n\n¿En qué prenda o pedido podemos ayudarte hoy? Un asesor te responderá enseguida.\n\n🛍️ *Ver Catálogo:* http://localhost:3000`;
      } else if (clean.includes('cuenta') || clean.includes('transferir') || clean.includes('banco') || clean.includes('pagar') || clean.includes('datos')) {
        const banco = db.prepare("SELECT valor FROM configuracion WHERE clave = 'banco_nombre'").get()?.valor || 'Banco Pichincha';
        const cta = db.prepare("SELECT valor FROM configuracion WHERE clave = 'banco_numero_cuenta'").get()?.valor || '2100876543';
        const tipo = db.prepare("SELECT valor FROM configuracion WHERE clave = 'banco_tipo_cuenta'").get()?.valor || 'Cta. Corriente';
        const titular = db.prepare("SELECT valor FROM configuracion WHERE clave = 'banco_titular'").get()?.valor || 'RS STORE BOUTIQUE S.A.S.';
        const ruc = db.prepare("SELECT valor FROM configuracion WHERE clave = 'banco_identificacion'").get()?.valor || '0992345678001';

        replyText = `💳 *Datos de Pago de RS Store:*\n🏛 *Banco:* ${banco}\n📋 *Tipo:* ${tipo}\n🔢 *Cuenta:* ${cta}\n👤 *Titular:* ${titular}\n🆔 *RUC:* ${ruc}\n\nEnvíanos la captura de tu comprobante por aquí para validarlo al instante.`;
      } else if (clean.includes('catalogo') || clean.includes('precio') || clean.includes('prenda') || clean.includes('vestido')) {
        replyText = `👗 Conoce nuestras colecciones y vestidos en nuestra tienda oficial:\n👉 http://localhost:3000\n\nPuedes agregar al carrito y pagar por transferencia o efectivo.`;
      } else if (clean.includes('envio') || clean.includes('servientrega')) {
        replyText = `🚚 Realizamos envíos diarios a todo el Ecuador por *Servientrega* (Entrega a domicilio o retiro en agencia). Tarifa estándar $5.00.`;
      } else {
        replyText = `✨ ¡Hola! Hemos recibido tu mensaje en *RS Store Boutique*.\n\nUn asesor de ventas te responderá por este medio en unos minutos.\n\nPuedes revisar nuestras prendas y vestidos aquí: http://localhost:3000`;
      }
    }

    if (replyText) {
      console.log(`🤖 Enviando respuesta automática de WhatsApp a ${remoteJid}: "${replyText.substring(0, 40)}..."`);
      await sock.sendMessage(remoteJid, { text: replyText });
      db.prepare(`
        INSERT INTO mensajes (conversacion_id, remitente, texto, fecha, estado)
        VALUES (?, 'BOT', ?, datetime('now', 'localtime'), 'ENVIADO')
      `).run(convId, replyText);

      db.prepare(`
        UPDATE conversaciones 
        SET ultimo_mensaje = ?, updated_at = datetime('now', 'localtime') 
        WHERE id = ?
      `).run(replyText, convId);
    }
  } catch (e) {
    console.error('Error enviando auto-respuesta de WhatsApp:', e);
  }
}

/**
 * Envía un mensaje saliente a través de WhatsApp conectado
 */
async function sendWhatsAppMessage(phone, text) {
  if (!sock || connectionStatus !== 'CONNECTED') {
    return { success: false, error: 'WhatsApp no está conectado en el sistema. Escanea el código QR primero.' };
  }

  try {
    let jid = '';
    if (phone.includes('@')) {
      jid = phone;
    } else {
      let cleanPhone = phone.replace(/[^0-9]/g, '');
      if (cleanPhone.startsWith('09')) {
        cleanPhone = '593' + cleanPhone.substring(1);
      } else if (cleanPhone.startsWith('9') && cleanPhone.length === 9) {
        cleanPhone = '593' + cleanPhone;
      }
      jid = `${cleanPhone}@s.whatsapp.net`;
    }

    console.log(`📤 Enviando mensaje WhatsApp a ${jid}: "${text}"`);
    const sent = await sock.sendMessage(jid, { text });
    return { success: true, data: sent };
  } catch (err) {
    console.error('Error enviando mensaje WhatsApp:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Desconecta WhatsApp y elimina la sesión para generar un nuevo QR
 */
async function disconnectWhatsApp() {
  try {
    if (sock) {
      await sock.logout().catch(() => {});
      sock = null;
    }
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      fs.mkdirSync(sessionDir, { recursive: true });
    } catch(e) {}

    connectionStatus = 'DISCONNECTED';
    connectedPhone = null;
    currentQrDataUrl = null;
    currentQrString = null;
    statusMessage = 'Sesión cerrada. Generando nuevo código QR...';
    isConnecting = false;

    setTimeout(initWhatsApp, 1500);
    return { success: true, message: 'WhatsApp desconectado correctamente' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Retorna el estado actual de WhatsApp
 */
function getWhatsAppStatus() {
  return {
    status: connectionStatus,
    qr: currentQrDataUrl,
    phone: connectedPhone,
    message: statusMessage,
    connected: connectionStatus === 'CONNECTED'
  };
}

module.exports = {
  initWhatsApp,
  getWhatsAppStatus,
  sendWhatsAppMessage,
  disconnectWhatsApp
};
