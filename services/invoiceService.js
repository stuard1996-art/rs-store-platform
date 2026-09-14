const { db } = require('../database/db.js');

/**
 * Calculates modulo 11 check digit according to SRI standard (Ecuador)
 * @param {string} code48 - 48-digit numeric string
 * @returns {number} 1-digit check digit (0-9)
 */
function calculateModulo11(code48) {
  let factor = 2;
  let sum = 0;
  for (let i = code48.length - 1; i >= 0; i--) {
    sum += parseInt(code48[i], 10) * factor;
    factor = factor === 7 ? 2 : factor + 1;
  }
  const mod = 11 - (sum % 11);
  if (mod === 11) return 0;
  if (mod === 10) return 1;
  return mod;
}

/**
 * Generates a valid 49-digit SRI electronic invoice access key
 */
function generateAccessKey(fecha, ruc, establecimiento, puntoEmision, secuencialNum) {
  // fecha format: YYYY-MM-DD or Date
  const d = new Date(fecha);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = String(d.getFullYear());
  const fechaStr = `${day}${month}${year}`;

  const tipoComprobante = '01'; // Factura
  const rucPadded = String(ruc || '0992345678001').padStart(13, '0');
  const tipoAmbiente = '1'; // 1: Pruebas, 2: Producción
  const serie = `${String(establecimiento).padStart(3, '0')}${String(puntoEmision).padStart(3, '0')}`;
  const secuencialStr = String(secuencialNum).padStart(9, '0');
  const codigoNumerico = '12345678'; // Código aleatorio / fijo
  const tipoEmision = '1'; // Emisión normal

  const base48 = `${fechaStr}${tipoComprobante}${rucPadded}${tipoAmbiente}${serie}${secuencialStr}${codigoNumerico}${tipoEmision}`;
  const digitoVerificador = calculateModulo11(base48);
  return `${base48}${digitoVerificador}`;
}

/**
 * Retrieves a configuration value from DB
 */
function getConfig(key, defaultVal = '') {
  const row = db.prepare(`SELECT valor FROM configuracion WHERE clave = ?`).get(key);
  return row ? row.valor : defaultVal;
}

/**
 * Creates an official invoice with items, updates sequential and reduces stock atomically.
 * 
 * @param {Object} data
 * @param {number} data.cliente_id
 * @param {number|null} [data.pedido_id]
 * @param {Array<{producto_id: number, descripcion: string, cantidad: number, precio_unitario: number, descuento?: number}>} data.items
 * @param {string} [data.forma_pago]
 * @param {string} [data.notas]
 * @returns {Object} Created invoice record
 */
function createInvoice(data) {
  const { cliente_id, pedido_id = null, items = [], forma_pago = '01 - SIN UTILIZACION DEL SISTEMA FINANCIERO', notas = '' } = data;

  if (!cliente_id) throw new Error('Se requiere un cliente_id válido para emitir factura');
  if (!items || items.length === 0) throw new Error('La factura debe tener al menos un ítem');

  // Verify client exists
  const client = db.prepare(`SELECT * FROM clientes WHERE id = ?`).get(cliente_id);
  if (!client) throw new Error('Cliente no encontrado en la base de datos');

  const establecimiento = getConfig('establecimiento', '001');
  const puntoEmision = getConfig('punto_emision', '001');
  const rucEmisor = getConfig('ruc_emisor', '0992345678001');

  // Control tributario oficial SRI: RIMPE Negocio Popular no cobra IVA (tarifa 0%)
  const tipoContribuyente = getConfig('tipo_contribuyente', 'REGIMEN_GENERAL');
  const isRimpePopular = (tipoContribuyente === 'RIMPE_POPULAR');
  const ivaPorcentaje = isRimpePopular ? 0.00 : (parseFloat(getConfig('porcentaje_iva', '15.00')) || 15.00);

  // Begin atomic operation
  db.exec('BEGIN TRANSACTION;');

  try {
    // 1. Get and increment sequential
    let seqRow = db.prepare(`SELECT valor FROM configuracion WHERE clave = 'secuencial_actual'`).get();
    let currentSeq = seqRow ? parseInt(seqRow.valor, 10) : 1;
    if (isNaN(currentSeq) || currentSeq < 1) currentSeq = 1;

    const secuencialFormatted = `${establecimiento.padStart(3, '0')}-${puntoEmision.padStart(3, '0')}-${String(currentSeq).padStart(9, '0')}`;
    
    // Increment config for next invoice
    db.prepare(`UPDATE configuracion SET valor = ? WHERE clave = 'secuencial_actual'`).run(String(currentSeq + 1));

    // 2. Calculate items and totals
    let subtotalIva = 0;
    let subtotalCero = 0;
    let totalDescuento = 0;
    const computedItems = [];

    for (const item of items) {
      const qty = parseInt(item.cantidad, 10);
      if (qty <= 0) throw new Error(`Cantidad inválida para el producto "${item.descripcion}"`);

      const price = parseFloat(item.precio_unitario);
      const desc = parseFloat(item.descuento || 0);
      const itemSubtotal = parseFloat(((price * qty) - desc).toFixed(2));
      totalDescuento += desc;

      // Check product stock and reduce it if producto_id is present (including size stock)
      if (item.producto_id) {
        const prod = db.prepare(`SELECT id, name, stock, tallas FROM productos WHERE id = ?`).get(item.producto_id);
        if (prod) {
          let tallasObj = {};
          try { tallasObj = JSON.parse(prod.tallas || '{}'); } catch(e) {}

          if (item.talla && Object.keys(tallasObj).length > 0 && tallasObj[item.talla] !== undefined) {
            const currentTallaStock = parseInt(tallasObj[item.talla], 10) || 0;
            if (currentTallaStock < qty) {
              throw new Error(`Stock insuficiente para "${prod.name}" en Talla ${item.talla}. Disponible: ${currentTallaStock}, Solicitado: ${qty}`);
            }
            tallasObj[item.talla] = currentTallaStock - qty;
            const newTotalStock = Object.values(tallasObj).reduce((a, b) => a + (Number(b) || 0), 0);
            db.prepare(`UPDATE productos SET stock = ?, tallas = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`).run(newTotalStock, JSON.stringify(tallasObj), prod.id);
          } else {
            if (prod.stock < qty) {
              throw new Error(`Stock insuficiente para "${prod.name}". Disponible: ${prod.stock}, Solicitado: ${qty}`);
            }
            db.prepare(`UPDATE productos SET stock = stock - ?, updated_at = datetime('now', 'localtime') WHERE id = ?`).run(qty, prod.id);
          }
        }
      }

      // RS Store products: Si es RIMPE Popular la tarifa es 0%, caso contrario aplica IVA legal
      const ivaValor = isRimpePopular ? 0.00 : parseFloat(((itemSubtotal * ivaPorcentaje) / 100).toFixed(2));
      if (isRimpePopular) {
        subtotalCero += itemSubtotal;
      } else {
        subtotalIva += itemSubtotal;
      }

      const descConTalla = item.talla ? `${item.descripcion} (Talla: ${item.talla})` : item.descripcion;

      computedItems.push({
        producto_id: item.producto_id || null,
        descripcion: descConTalla || 'Artículo de tienda',
        cantidad: qty,
        precio_unitario: price,
        descuento: desc,
        subtotal: itemSubtotal,
        iva_porcentaje: ivaPorcentaje,
        iva_valor: ivaValor,
        talla: item.talla || ''
      });
    }

    const subtotal = parseFloat((subtotalIva + subtotalCero).toFixed(2));
    const montoIva = parseFloat(((subtotalIva * ivaPorcentaje) / 100).toFixed(2));
    const total = parseFloat((subtotal + montoIva).toFixed(2));

    const now = new Date();
    const claveAcceso = generateAccessKey(now, rucEmisor, establecimiento, puntoEmision, currentSeq);

    // Leyendas tributarias según tipo de contribuyente
    let finalNotas = (notas || '').trim();
    if (isRimpePopular && !finalNotas.includes('RIMPE - Negocio Popular')) {
      finalNotas = (finalNotas ? finalNotas + '\n' : '') + 'Contribuyente Régimen RIMPE - Negocio Popular';
    } else if (tipoContribuyente === 'RIMPE_EMPRENDEDOR' && !finalNotas.includes('RIMPE')) {
      finalNotas = (finalNotas ? finalNotas + '\n' : '') + 'Contribuyente Régimen RIMPE';
    }
    const extraLeyenda = getConfig('leyenda_contribuyente', '');
    if (extraLeyenda && !finalNotas.includes(extraLeyenda)) {
      finalNotas = (finalNotas ? finalNotas + '\n' : '') + extraLeyenda;
    }

    // 3. Insert Invoice
    const insertInv = db.prepare(`
      INSERT INTO facturas (
        secuencial, pedido_id, cliente_id, subtotal_0, subtotal_iva,
        porcentaje_iva, monto_iva, descuento, total, forma_pago,
        estado, clave_acceso, notas
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'EMITIDA', ?, ?)
    `);

    const result = insertInv.run(
      secuencialFormatted,
      pedido_id,
      cliente_id,
      subtotalCero,
      subtotalIva,
      ivaPorcentaje,
      montoIva,
      totalDescuento,
      total,
      forma_pago,
      claveAcceso,
      finalNotas
    );

    const facturaId = result.lastInsertRowid;

    // 4. Insert Invoice Items
    const insertItem = db.prepare(`
      INSERT INTO factura_items (
        factura_id, producto_id, descripcion, cantidad, precio_unitario,
        descuento, subtotal, iva_porcentaje, iva_valor, talla
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const it of computedItems) {
      insertItem.run(
        facturaId,
        it.producto_id,
        it.descripcion,
        it.cantidad,
        it.precio_unitario,
        it.descuento,
        it.subtotal,
        it.iva_porcentaje,
        it.iva_valor,
        it.talla || ''
      );
    }

    // 5. If linked to an order, update order status
    if (pedido_id) {
      db.prepare(`UPDATE pedidos SET estado = 'PAGADO' WHERE id = ?`).run(pedido_id);
    }

    db.exec('COMMIT;');

    return getInvoiceDetails(facturaId);
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

/**
 * Retrieves full invoice details with client and items
 */
function getInvoiceDetails(id) {
  const invoice = db.prepare(`
    SELECT f.*, 
           c.tipo_doc as cliente_tipo_doc,
           c.num_doc as cliente_num_doc,
           c.razon_social as cliente_nombre,
           c.email as cliente_email,
           c.telefono as cliente_telefono,
           c.direccion as cliente_direccion
    FROM facturas f
    JOIN clientes c ON f.cliente_id = c.id
    WHERE f.id = ?
  `).get(id);

  if (!invoice) return null;

  const items = db.prepare(`
    SELECT fi.*, p.name as producto_nombre_original, p.cat as producto_categoria
    FROM factura_items fi
    LEFT JOIN productos p ON fi.producto_id = p.id
    WHERE fi.factura_id = ?
  `).all(id);

  invoice.items = items;
  invoice.emisor = {
    nombre_tienda: getConfig('nombre_tienda', 'RS Store'),
    razon_social: getConfig('razon_social', 'RS STORE BOUTIQUE S.A.S.'),
    ruc: getConfig('ruc_emisor', '0992345678001'),
    direccion_matriz: getConfig('direccion_matriz', 'Av. 9 de Octubre 1200 y Malecón, Guayaquil, Ecuador'),
    establecimiento: getConfig('establecimiento', '001'),
    punto_emision: getConfig('punto_emision', '001'),
    telefono: getConfig('telefono_contacto', '+593 99 123 4567'),
    email: getConfig('email_contacto', 'ventas@rsstore.ec'),
    tipo_contribuyente: getConfig('tipo_contribuyente', 'REGIMEN_GENERAL'),
    leyenda_contribuyente: getConfig('leyenda_contribuyente', ''),
    resolucion_contribuyente: getConfig('resolucion_contribuyente', '')
  };

  return invoice;
}

/**
 * Anulates an invoice and optionally restores inventory
 */
function anularInvoice(id, restoreStock = true) {
  db.exec('BEGIN TRANSACTION;');
  try {
    const invoice = db.prepare(`SELECT * FROM facturas WHERE id = ?`).get(id);
    if (!invoice) throw new Error('Factura no encontrada');
    if (invoice.estado === 'ANULADA') throw new Error('La factura ya se encuentra anulada');

    if (restoreStock) {
      const items = db.prepare(`SELECT producto_id, cantidad, talla FROM factura_items WHERE factura_id = ?`).all(id);
      for (const it of items) {
        if (it.producto_id) {
          const prod = db.prepare(`SELECT id, stock, tallas FROM productos WHERE id = ?`).get(it.producto_id);
          if (prod) {
            let tallasObj = {};
            try { tallasObj = JSON.parse(prod.tallas || '{}'); } catch(e) {}

            if (it.talla && tallasObj[it.talla] !== undefined) {
              tallasObj[it.talla] = (parseInt(tallasObj[it.talla], 10) || 0) + it.cantidad;
              const newTotalStock = Object.values(tallasObj).reduce((a, b) => a + (Number(b) || 0), 0);
              db.prepare(`UPDATE productos SET stock = ?, tallas = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`).run(newTotalStock, JSON.stringify(tallasObj), prod.id);
            } else {
              db.prepare(`UPDATE productos SET stock = stock + ?, updated_at = datetime('now', 'localtime') WHERE id = ?`).run(it.cantidad, prod.id);
            }
          }
        }
      }
    }

    db.prepare(`UPDATE facturas SET estado = 'ANULADA' WHERE id = ?`).run(id);

    db.exec('COMMIT;');
    return { success: true, message: 'Factura anulada con éxito' };
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

module.exports = {
  createInvoice,
  getInvoiceDetails,
  anularInvoice,
  getConfig
};
