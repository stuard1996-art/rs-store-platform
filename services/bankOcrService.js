const Tesseract = require('tesseract.js');
const { db } = require('../database/db.js');

/**
 * Obtiene valor de configuración de la BD
 */
function getConfig(key, defaultVal = '') {
  try {
    const row = db.prepare('SELECT valor FROM configuracion WHERE clave = ?').get(key);
    return row ? row.valor : defaultVal;
  } catch (e) {
    return defaultVal;
  }
}

/**
 * Limpia y normaliza texto
 */
function normalize(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

/**
 * Detecta el banco ecuatoriano a partir del texto OCR
 */
function detectEcuadorianBank(text) {
  const t = normalize(text);
  if (t.includes('pichincha') || t.includes('deuna') || t.includes('de una')) {
    return t.includes('deuna') ? 'Deuna! (Banco Pichincha)' : 'Banco Pichincha';
  }
  if (t.includes('guayaquil')) return 'Banco Guayaquil';
  if (t.includes('produbanco') || t.includes('be produbanco')) return 'Produbanco';
  if (t.includes('pacifico') || t.includes('intermatico')) return 'Banco del Pacífico';
  if (t.includes('bolivariano') || t.includes('24movil')) return 'Banco Bolivariano';
  if (t.includes('jep') || t.includes('coop jep')) return 'Cooperativa JEP';
  if (t.includes('policia nacional')) return 'Cooperativa Policía Nacional';
  if (t.includes('alianza del valle')) return 'Cooperativa Alianza del Valle';
  if (t.includes('internacional')) return 'Banco Internacional';
  return 'Banco Nacional de Ecuador';
}

/**
 * Extrae monto en dólares ($)
 */
function extractAmount(text) {
  // Patrones como $ 25.80, $25,80, USD 25.80, Monto: 25.80, Valor: 25.80
  const patterns = [
    /\$\s*([0-9]+[.,][0-9]{2})/i,
    /usd\s*([0-9]+[.,][0-9]{2})/i,
    /monto[:\s]*\$?\s*([0-9]+[.,][0-9]{2})/i,
    /valor[:\s]*\$?\s*([0-9]+[.,][0-9]{2})/i,
    /total[:\s]*\$?\s*([0-9]+[.,][0-9]{2})/i,
    /transferido[:\s]*\$?\s*([0-9]+[.,][0-9]{2})/i,
    /\b([0-9]{1,4}[.,][0-9]{2})\b/
  ];

  for (const regex of patterns) {
    const match = text.match(regex);
    if (match && match[1]) {
      const cleanNum = parseFloat(match[1].replace(',', '.'));
      if (!isNaN(cleanNum) && cleanNum > 0 && cleanNum < 50000) {
        return cleanNum;
      }
    }
  }
  return 0.0;
}

/**
 * Extrae número de comprobante / secuencial / referencia
 */
function extractReference(text) {
  const patterns = [
    /(?:comprobante|control|documento|autorizaci[oó]n|secuencial|referencia|ref|transacci[oó]n)[:\s#]*([0-9A-Z]{5,14})/i,
    /(?:no\.|n[uú]mero)[:\s#]*([0-9]{5,12})/i,
    /\b(00[0-9]{6,10})\b/,
    /\b([0-9]{7,10})\b/
  ];

  for (const regex of patterns) {
    const match = text.match(regex);
    if (match && match[1]) {
      return match[1].trim();
    }
  }
  return `REF-${Date.now().toString().slice(-6)}`;
}

/**
 * Extrae fecha de la transferencia
 */
function extractDate(text) {
  // DD/MM/YYYY, DD-MM-YYYY, DD/MM/YY
  const regexNum = /\b([0-3]?[0-9])[/-]([0-1]?[0-9])[/-](20[2-3][0-9]|[2-3][0-9])\b/;
  const matchNum = text.match(regexNum);
  if (matchNum) {
    const day = matchNum[1].padStart(2, '0');
    const month = matchNum[2].padStart(2, '0');
    let year = matchNum[3];
    if (year.length === 2) year = '20' + year;
    return `${year}-${month}-${day}`;
  }

  // Nombres de mes en español (ej: 13 Sep 2026, 13 de Septiembre del 2026)
  const meses = {
    ene: '01', feb: '02', mar: '03', abr: '04', may: '05', jun: '06',
    jul: '07', ago: '08', sep: '09', oct: '10', nov: '11', dic: '12'
  };
  const regexText = /\b([0-3]?[0-9])(?:\s+de)?\s+([a-zA-Z]{3,10})(?:\s+del?|\s+de)?\s+(20[2-3][0-9])\b/i;
  const matchText = text.match(regexText);
  if (matchText) {
    const day = matchText[1].padStart(2, '0');
    const mesKey = matchText[2].toLowerCase().slice(0, 3);
    const month = meses[mesKey] || '01';
    const year = matchText[3];
    return `${year}-${month}-${day}`;
  }

  // Si no se detecta, retorna fecha actual ISO (YYYY-MM-DD)
  const now = new Date();
  return now.toISOString().split('T')[0];
}

/**
 * Extrae titular / beneficiario del texto
 */
function extractBeneficiary(text, storeTitular) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const triggerKeywords = ['beneficiario', 'nombre', 'a la cuenta', 'destinatario', 'para:', 'a:', 'titular'];

  for (let i = 0; i < lines.length; i++) {
    const lineNorm = normalize(lines[i]);
    for (const kw of triggerKeywords) {
      if (lineNorm.includes(kw)) {
        // Puede estar en la misma línea después de ':' o en la línea siguiente
        const parts = lines[i].split(/[:]/);
        if (parts.length > 1 && parts[1].trim().length > 3) {
          return parts[1].trim();
        }
        if (i + 1 < lines.length && lines[i + 1].trim().length > 3) {
          return lines[i + 1].trim();
        }
      }
    }
  }

  // Si el texto contiene directamente palabras del titular de la tienda
  if (storeTitular) {
    const storeWords = normalize(storeTitular).split(/\s+/).filter(w => w.length > 2);
    const textNorm = normalize(text);
    const found = storeWords.some(w => textNorm.includes(w));
    if (found) return storeTitular;
  }

  return 'Beneficiario No Identificado';
}

/**
 * Valida si la fecha corresponde a hoy o máx 24 horas atrás
 */
function isDateRecent(extractedDateStr) {
  try {
    const today = new Date();
    const [y, m, d] = extractedDateStr.split('-').map(Number);
    const targetDate = new Date(y, m - 1, d);

    // Diferencia en días
    const diffMs = Math.abs(today.setHours(0,0,0,0) - targetDate.setHours(0,0,0,0));
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    return diffDays <= 1; // Hoy o ayer
  } catch (e) {
    return true;
  }
}

/**
 * Valida si el titular del comprobante coincide con el titular de la tienda
 */
function doesBeneficiaryMatch(extractedTitular, storeTitular) {
  if (!storeTitular) return true; // Si no hay configurado, permitir
  const extNorm = normalize(extractedTitular);
  const storeNorm = normalize(storeTitular);

  // Coincidencia exacta o contenida
  if (extNorm.includes(storeNorm) || storeNorm.includes(extNorm)) return true;

  // Coincidencia por palabras clave (ej: "RS", "STORE", "BOUTIQUE", o apellido principal)
  const storeTokens = storeNorm.split(/\s+/).filter(t => t.length > 2);
  let matches = 0;
  for (const tok of storeTokens) {
    if (extNorm.includes(tok)) matches++;
  }
  return matches >= 1;
}

/**
 * Procesa una imagen de comprobante bancario con OCR y aplica validaciones ecuatorianas
 * @param {string|Buffer} imageSource - Ruta, buffer o base64 de la imagen
 * @param {number|null} [pedidoId] - ID del pedido opcional para cotejar monto
 * @returns {Promise<object>} Resultado estructurado
 */
async function processBankVoucher(imageSource, pedidoId = null) {
  try {
    let imageBuffer = imageSource;
    if (typeof imageSource === 'string' && imageSource.startsWith('data:image')) {
      imageBuffer = Buffer.from(imageSource.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    }

    // Ejecutar OCR con Tesseract.js en español
    let rawText = '';
    try {
      const { data } = await Tesseract.recognize(imageBuffer, 'spa+eng', {
        logger: () => {} // Silenciar logs para no saturar consola
      });
      rawText = data.text || '';
    } catch (ocrErr) {
      console.warn('Tesseract fallback notice:', ocrErr.message);
      rawText = 'Comprobante de Transferencia Banco Pichincha $ 0.00';
    }

    // 1. Detección de Banco
    const bancoDetectado = detectEcuadorianBank(rawText);

    // 2. Extracción de Monto
    const montoDetectado = extractAmount(rawText);

    // 3. Extracción de Referencia
    const referencia = extractReference(rawText);

    // 4. Extracción de Fecha
    const fechaDetectada = extractDate(rawText);

    // 5. Configuración de la Tienda
    const titularConfig = getConfig('banco_titular', 'RS STORE BOUTIQUE S.A.S.');
    const bancoConfig = getConfig('banco_nombre', 'Banco Pichincha');
    const cuentaConfig = getConfig('banco_numero_cuenta', '2100876543');

    // 6. Extracción y cotejo de Titular
    const titularDetectado = extractBeneficiary(rawText, titularConfig);

    // 7. Matriz de Validaciones de Seguridad
    const fechaValida = isDateRecent(fechaDetectada);
    const titularValido = doesBeneficiaryMatch(titularDetectado, titularConfig);

    // 8. Validación de duplicidad
    const dupCheck = db.prepare('SELECT id, pedido_id, created_at FROM comprobantes_pago WHERE referencia = ? AND banco = ?').get(referencia, bancoDetectado);
    const esDuplicado = Boolean(dupCheck);

    // 9. Cotejo con Pedido si existe
    let montoValido = true;
    let pedidoInfo = null;
    if (pedidoId) {
      pedidoInfo = db.prepare('SELECT id, codigo_pedido, total, cliente_id, estado FROM pedidos WHERE id = ?').get(pedidoId);
      if (pedidoInfo && montoDetectado > 0) {
        // Tolerancia de centavos
        montoValido = Math.abs(pedidoInfo.total - montoDetectado) <= 0.05;
      }
    }

    // Determinar Estado Final
    let estado = 'VALIDADO_OK';
    const observaciones = [];

    if (esDuplicado) {
      estado = 'DUPLICADO';
      observaciones.push(`⚠️ Comprobante duplicado. Ya fue registrado anteriormente para el pedido #${dupCheck.pedido_id || 'anterior'}.`);
    } else if (!fechaValida) {
      estado = 'RECHAZADO_FECHA';
      observaciones.push(`⚠️ Fecha no corresponde al día actual (${fechaDetectada}). Posible comprobante antiguo.`);
    } else if (!titularValido) {
      estado = 'RECHAZADO_TITULAR';
      observaciones.push(`⚠️ El titular detectado ("${titularDetectado}") no coincide con la cuenta oficial ("${titularConfig}").`);
    } else if (!montoValido && pedidoInfo) {
      estado = 'PENDIENTE';
      observaciones.push(`⚠️ El monto transferido ($${montoDetectado.toFixed(2)}) no coincide exactamente con el total del pedido ($${pedidoInfo.total.toFixed(2)}).`);
    } else if (montoDetectado === 0) {
      estado = 'PENDIENTE';
      observaciones.push('ℹ️ No se pudo leer el monto con total certeza. Requiere revisión visual.');
    }

    // Respuesta automática amigable para el Bot de WhatsApp
    let autoReply = '';
    if (estado === 'VALIDADO_OK') {
      autoReply = `✅ *¡Transferencia Verificada con Éxito!*\n\nHemos validado tu comprobante de *${bancoDetectado}* por *$${montoDetectado.toFixed(2)}* con fecha de hoy.\n• No. Documento: *${referencia}*\n• Beneficiario: *${titularConfig}*\n\nTu pedido *#${pedidoInfo ? pedidoInfo.codigo_pedido : 'RS-WEB'}* ha sido marcado como *PAGADO* y entra a preparación inmediata. ¡Muchas gracias por tu compra en RS Store! 👗✨`;
    } else if (estado === 'DUPLICADO') {
      autoReply = `❌ *Alerta de Comprobante*\n\nEl número de comprobante *${referencia}* ya fue utilizado en un pedido anterior. Si se trata de un error, un asesor de RS Store te atenderá en este mismo chat en breve.`;
    } else {
      autoReply = `📄 *Comprobante Recibido*\n\nHemos recibido la foto de tu comprobante de *${bancoDetectado}* por *$${montoDetectado.toFixed(2)}*.\n• Estado: *En revisión por administración*\n\nUn asesor validará los detalles y te confirmará por este medio en pocos minutos. ¡Gracias por tu paciencia!`;
    }

    return {
      success: true,
      data: {
        banco: bancoDetectado,
        monto: montoDetectado,
        referencia,
        fecha: fechaDetectada,
        titular_detectado: titularDetectado,
        titular_esperado: titularConfig,
        estado,
        fecha_valida: fechaValida,
        titular_valido: titularValido,
        es_duplicado: esDuplicado,
        monto_valido: montoValido,
        observaciones: observaciones.join(' '),
        autoReply,
        raw_text_snippet: rawText.slice(0, 300)
      }
    };
  } catch (err) {
    return {
      success: false,
      error: err.message
    };
  }
}

module.exports = {
  detectEcuadorianBank,
  extractAmount,
  extractReference,
  extractDate,
  processBankVoucher
};
