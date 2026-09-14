const express = require('express');
const cors = require('cors');
const path = require('node:path');
const fs = require('node:fs');
const { db } = require('./database/db.js');
const { createInvoice, getInvoiceDetails, anularInvoice, getConfig } = require('./services/invoiceService.js');
const { consultarSRIEnLinea, validarCedula } = require('./services/sriLookupService.js');
const { generateInvoiceXml } = require('./services/sriXmlService.js');
const { parseP12, signInvoiceXmlXadesBes } = require('./services/sriSignatureService.js');
const { generateProductDescription } = require('./services/aiCopywriterService.js');
const { processBankVoucher } = require('./services/bankOcrService.js');
const { sendTelegramMessage, notifyOrderToTelegram, startTelegramPolling, testTelegramBot } = require('./services/telegramService.js');
const { testSmtpConnection, sendInvoiceEmail } = require('./services/emailService.js');
const { initWhatsApp, getWhatsAppStatus, sendWhatsAppMessage, disconnectWhatsApp } = require('./services/whatsappService.js');
const { processAdminQuery } = require('./services/adminQueryService.js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static frontend files with no-cache for HTML files
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/' || req.path === '/admin') {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { etag: false, maxAge: 0 }));

// ==========================================
// 1. PRODUCTOS (CRUD & INVENTARIO)
// ==========================================

// Listar productos
app.get('/api/products', (req, res) => {
  try {
    const { cat, q, onlyVisible } = req.query;
    let sql = 'SELECT * FROM productos WHERE 1=1';
    const params = [];

    if (onlyVisible === 'true' || onlyVisible === '1') {
      sql += ' AND visible = 1';
    }
    if (cat && cat !== 'all') {
      sql += ' AND cat = ?';
      params.push(cat);
    }
    if (q) {
      sql += ' AND (LOWER(name) LIKE ? OR LOWER(desc) LIKE ?)';
      params.push(`%${q.toLowerCase()}%`, `%${q.toLowerCase()}%`);
    }

    sql += ' ORDER BY id DESC';
    const products = db.prepare(sql).all(...params);
    res.json({ success: true, data: products });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Obtener un producto por ID
app.get('/api/products/:id', (req, res) => {
  try {
    const product = db.prepare('SELECT * FROM productos WHERE id = ?').get(req.params.id);
    if (!product) return res.status(404).json({ success: false, error: 'Producto no encontrado' });
    res.json({ success: true, data: product });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Crear producto
app.post('/api/products', (req, res) => {
  try {
    const { name, cat, price, was_price = null, stock = 0, desc = '', visible = 1, is_new = 0, badge = '', img = '', tallas = null } = req.body;
    if (!name || price === undefined) {
      return res.status(400).json({ success: false, error: 'Nombre y precio son obligatorios' });
    }

    const numPrice = parseFloat(String(price).replace(',', '.'));
    const numWasPrice = was_price ? parseFloat(String(was_price).replace(',', '.')) : null;
    let numStock = parseInt(stock, 10) || 0;
    let tallasStr = '{}';

    if (tallas) {
      if (typeof tallas === 'object') {
        tallasStr = JSON.stringify(tallas);
        const sumTallas = Object.values(tallas).reduce((a, b) => a + (parseInt(b, 10) || 0), 0);
        if (sumTallas > 0) numStock = sumTallas;
      } else {
        tallasStr = String(tallas);
      }
    } else {
      tallasStr = JSON.stringify({ 'Única': numStock });
    }

    const stmt = db.prepare(`
      INSERT INTO productos (name, cat, price, was_price, stock, desc, visible, is_new, badge, img, tallas)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(name, cat || 'accesorios', numPrice, numWasPrice, numStock, desc, visible ? 1 : 0, is_new ? 1 : 0, badge, img, tallasStr);
    const newProd = db.prepare('SELECT * FROM productos WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ success: true, data: newProd, message: 'Producto creado exitosamente' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Actualizar producto
app.put('/api/products/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { name, cat, price, was_price, stock, desc, visible, is_new, badge, img, tallas } = req.body;

    const existing = db.prepare('SELECT * FROM productos WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ success: false, error: 'Producto no encontrado' });

    const numPrice = price !== undefined ? parseFloat(String(price).replace(',', '.')) : existing.price;
    const numWasPrice = was_price !== undefined ? (was_price ? parseFloat(String(was_price).replace(',', '.')) : null) : existing.was_price;
    let numStock = stock !== undefined ? parseInt(stock, 10) : existing.stock;
    let tallasStr = existing.tallas || '{}';

    if (tallas !== undefined) {
      if (typeof tallas === 'object') {
        tallasStr = JSON.stringify(tallas);
        const sumTallas = Object.values(tallas).reduce((a, b) => a + (parseInt(b, 10) || 0), 0);
        if (sumTallas >= 0) numStock = sumTallas;
      } else {
        tallasStr = String(tallas);
      }
    }

    const stmt = db.prepare(`
      UPDATE productos SET
        name = ?, cat = ?, price = ?, was_price = ?, stock = ?,
        desc = ?, visible = ?, is_new = ?, badge = ?, img = ?, tallas = ?,
        updated_at = datetime('now', 'localtime')
      WHERE id = ?
    `);

    stmt.run(
      name || existing.name,
      cat || existing.cat,
      numPrice,
      numWasPrice,
      numStock,
      desc !== undefined ? desc : existing.desc,
      visible !== undefined ? (visible ? 1 : 0) : existing.visible,
      is_new !== undefined ? (is_new ? 1 : 0) : existing.is_new,
      badge !== undefined ? badge : existing.badge,
      img !== undefined ? img : existing.img,
      tallasStr,
      id
    );

    const updated = db.prepare('SELECT * FROM productos WHERE id = ?').get(id);
    res.json({ success: true, data: updated, message: 'Producto actualizado exitosamente' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Eliminar producto
app.delete('/api/products/:id', (req, res) => {
  try {
    const { id } = req.params;
    db.prepare('DELETE FROM productos WHERE id = ?').run(id);
    res.json({ success: true, message: 'Producto eliminado exitosamente' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 2. CLIENTES
// ==========================================

// Buscar o listar clientes
app.get('/api/clients', (req, res) => {
  try {
    const { q } = req.query;
    let sql = 'SELECT * FROM clientes WHERE 1=1';
    const params = [];
    if (q) {
      sql += ' AND (num_doc LIKE ? OR LOWER(razon_social) LIKE ? OR LOWER(email) LIKE ?)';
      params.push(`%${q}%`, `%${q.toLowerCase()}%`, `%${q.toLowerCase()}%`);
    }
    sql += ' ORDER BY id DESC LIMIT 50';
    const clients = db.prepare(sql).all(...params);
    res.json({ success: true, data: clients });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Registrar o actualizar cliente
app.post('/api/clients', (req, res) => {
  try {
    const { tipo_doc = 'CEDULA', num_doc, razon_social, email = '', telefono = '', direccion = '' } = req.body;
    if (!num_doc || !razon_social) {
      return res.status(400).json({ success: false, error: 'Número de documento y razón social son obligatorios' });
    }

    // Verificar si ya existe por número de documento
    const existing = db.prepare('SELECT * FROM clientes WHERE num_doc = ?').get(num_doc.trim());
    if (existing) {
      db.prepare(`
        UPDATE clientes SET tipo_doc = ?, razon_social = ?, email = ?, telefono = ?, direccion = ?
        WHERE id = ?
      `).run(tipo_doc, razon_social.trim(), email.trim(), telefono.trim(), direccion.trim(), existing.id);
      const updated = db.prepare('SELECT * FROM clientes WHERE id = ?').get(existing.id);
      return res.json({ success: true, data: updated, message: 'Cliente actualizado' });
    }

    const stmt = db.prepare(`
      INSERT INTO clientes (tipo_doc, num_doc, razon_social, email, telefono, direccion)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(tipo_doc, num_doc.trim(), razon_social.trim(), email.trim(), telefono.trim(), direccion.trim());
    const newClient = db.prepare('SELECT * FROM clientes WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ success: true, data: newClient, message: 'Cliente registrado' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 3. CHECKOUT & PEDIDOS WEB
// ==========================================

// Procesar compra desde la tienda pública
app.post('/api/checkout', (req, res) => {
  try {
    const {
      cliente, items, metodo_pago = 'TRANSFERENCIA', envio = 0,
      codigo_cupon = '', descuento = 0,
      direccion_envio = '', ciudad_envio = '', notas = '', emitir_factura = true,
      provincia = '', ciudad = '', tipo_entrega = 'DOMICILIO',
      calle_principal = '', calle_secundaria = '', numero_casa = '', referencia = '',
      agencia_servientrega = '', gps_lat = null, gps_lng = null, gps_maps_url = ''
    } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ success: false, error: 'El carrito no contiene productos' });
    }

    db.exec('BEGIN TRANSACTION;');

    try {
      // 1. Resolver cliente
      let clienteId;
      if (cliente && cliente.num_doc && cliente.num_doc !== '9999999999999') {
        const exist = db.prepare('SELECT id FROM clientes WHERE num_doc = ?').get(cliente.num_doc.trim());
        if (exist) {
          clienteId = exist.id;
          db.prepare(`
            UPDATE clientes SET razon_social = ?, email = ?, telefono = ?, direccion = ? WHERE id = ?
          `).run(cliente.razon_social, cliente.email || '', cliente.telefono || '', cliente.direccion || direccion_envio, clienteId);
        } else {
          const insertC = db.prepare(`
            INSERT INTO clientes (tipo_doc, num_doc, razon_social, email, telefono, direccion)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(cliente.tipo_doc || 'CEDULA', cliente.num_doc.trim(), cliente.razon_social, cliente.email || '', cliente.telefono || '', cliente.direccion || direccion_envio);
          clienteId = insertC.lastInsertRowid;
        }
      } else {
        // Consumidor final por defecto
        const cf = db.prepare("SELECT id FROM clientes WHERE tipo_doc = 'CONSUMIDOR_FINAL'").get();
        clienteId = cf ? cf.id : 1;
      }

      // 2. Calcular subtotal e ítems
      let subtotal = 0;
      const orderItemsToInsert = [];

      for (const it of items) {
        const prod = db.prepare('SELECT id, name, price, stock FROM productos WHERE id = ?').get(it.id);
        if (!prod) throw new Error(`Producto con ID ${it.id} no existe`);
        if (prod.stock < it.qty) {
          throw new Error(`Stock insuficiente para "${prod.name}". Disponibles: ${prod.stock}, Solicitados: ${it.qty}`);
        }
        const itemSub = prod.price * it.qty;
        subtotal += itemSub;
        orderItemsToInsert.push({
          producto_id: prod.id,
          producto_nombre: prod.name,
          cantidad: it.qty,
          precio_unitario: prod.price,
          subtotal: itemSub,
          talla: it.talla || ''
        });
      }

      // Validar Cupón de Descuento
      let discountAmount = 0;
      let validCouponId = null;
      if (codigo_cupon && codigo_cupon.trim()) {
        const cleanC = codigo_cupon.trim().toUpperCase();
        const cRow = db.prepare('SELECT * FROM cupones WHERE codigo = ? AND activo = 1').get(cleanC);
        if (cRow && (!cRow.usos_max || cRow.usos_actuales < cRow.usos_max) && (!cRow.minimo_compra || subtotal >= cRow.minimo_compra)) {
          validCouponId = cRow.id;
          if (cRow.tipo === 'PORCENTAJE') {
            discountAmount = parseFloat(((subtotal * cRow.valor) / 100).toFixed(2));
          } else {
            discountAmount = parseFloat(Math.min(cRow.valor, subtotal).toFixed(2));
          }
        }
      } else if (descuento && parseFloat(descuento) > 0) {
        discountAmount = parseFloat(descuento);
      }

      const shippingCost = parseFloat(envio) || 0;
      const total = parseFloat(Math.max(0, subtotal - discountAmount + shippingCost).toFixed(2));
      const orderCode = `RS-${new Date().getFullYear()}-${String(Date.now()).slice(-4)}`;

      // 3. Insertar Pedido con datos de Servientrega, GPS y Descuento
      const finalDir = direccion_envio || `${calle_principal} ${numero_casa ? '#' + numero_casa : ''} ${calle_secundaria ? 'y ' + calle_secundaria : ''}`.trim();
      const insertOrder = db.prepare(`
        INSERT INTO pedidos (
          codigo_pedido, cliente_id, subtotal, envio, descuento, total,
          metodo_pago, estado, requiere_factura, direccion_envio, ciudad_envio, notas,
          provincia, ciudad, tipo_entrega, calle_principal, calle_secundaria,
          numero_casa, referencia, agencia_servientrega, gps_lat, gps_lng, gps_maps_url
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDIENTE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const orderRes = insertOrder.run(
        orderCode, clienteId, subtotal, shippingCost, discountAmount, total,
        metodo_pago, emitir_factura ? 1 : 0, finalDir, ciudad || ciudad_envio, notas,
        provincia, ciudad || ciudad_envio, tipo_entrega, calle_principal, calle_secundaria,
        numero_casa, referencia, agencia_servientrega, gps_lat, gps_lng, gps_maps_url
      );
      const pedidoId = orderRes.lastInsertRowid;

      if (validCouponId) {
        db.prepare('UPDATE cupones SET usos_actuales = usos_actuales + 1 WHERE id = ?').run(validCouponId);
      }

      // 4. Insertar Pedido Items (con talla)
      const insertOrderItem = db.prepare(`
        INSERT INTO pedido_items (pedido_id, producto_id, producto_nombre, cantidad, precio_unitario, subtotal, talla)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const oi of orderItemsToInsert) {
        insertOrderItem.run(pedidoId, oi.producto_id, oi.producto_nombre, oi.cantidad, oi.precio_unitario, oi.subtotal, oi.talla);
      }

      db.exec('COMMIT;');

      // 5. Emitir factura automática si se solicitó
      let facturaEmitida = null;
      if (emitir_factura) {
        facturaEmitida = createInvoice({
          cliente_id: clienteId,
          pedido_id: pedidoId,
          items: orderItemsToInsert.map(oi => ({
            producto_id: oi.producto_id,
            descripcion: oi.producto_nombre,
            cantidad: oi.cantidad,
            precio_unitario: oi.precio_unitario,
            talla: oi.talla
          })),
          forma_pago: metodo_pago.includes('TARJETA') ? '19 - TARJETA DE CREDITO' : '20 - OTROS CON UTILIZACION DEL SISTEMA FINANCIERO',
          notas: `Pedido web #${orderCode}`
        });
      }

      // Notificar al bot de Telegram del administrador
      try { notifyOrderToTelegram(pedidoId); } catch (te) { console.warn('Telegram notify notice:', te.message); }

      // Envío de correo electrónico si el cliente indicó correo y SMTP está activo
      if (facturaEmitida && cliente.email && cliente.email.trim()) {
        const rideUrl = `http://localhost:${PORT}/factura-ride.html?id=${facturaEmitida.id}`;
        sendInvoiceEmail({
          toEmail: cliente.email.trim(),
          clientName: cliente.razon_social,
          invoiceSecuencial: facturaEmitida.secuencial,
          total: facturaEmitida.total,
          rideUrl
        }).catch(e => console.warn('Email notify notice:', e.message));
      }

      res.status(201).json({
        success: true,
        data: {
          pedido_id: pedidoId,
          codigo_pedido: orderCode,
          total,
          factura: facturaEmitida
        },
        message: '¡Pedido realizado exitosamente!'
      });
    } catch (innerErr) {
      db.exec('ROLLBACK;');
      throw innerErr;
    }
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Listar pedidos (Admin)
app.get('/api/orders', (req, res) => {
  try {
    const orders = db.prepare(`
      SELECT p.*, c.razon_social as cliente_nombre, c.num_doc as cliente_doc, c.telefono as cliente_telefono
      FROM pedidos p
      LEFT JOIN clientes c ON p.cliente_id = c.id
      ORDER BY p.id DESC
    `).all();

    for (const ord of orders) {
      ord.items = db.prepare('SELECT * FROM pedido_items WHERE pedido_id = ?').all(ord.id);
      ord.factura = db.prepare('SELECT id, secuencial, estado, clave_acceso FROM facturas WHERE pedido_id = ?').get(ord.id) || null;
    }

    res.json({ success: true, data: orders });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Actualizar estado de pedido
app.put('/api/orders/:id/status', (req, res) => {
  try {
    const { estado } = req.body;
    db.prepare('UPDATE pedidos SET estado = ? WHERE id = ?').run(estado, req.params.id);
    res.json({ success: true, message: 'Estado del pedido actualizado' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 4. MÓDULO DE FACTURACIÓN (SRI & POS)
// ==========================================

// Listar facturas
app.get('/api/invoices', (req, res) => {
  try {
    const { q, estado } = req.query;
    let sql = `
      SELECT f.*, c.razon_social as cliente_nombre, c.num_doc as cliente_doc, c.tipo_doc as cliente_tipo_doc
      FROM facturas f
      JOIN clientes c ON f.cliente_id = c.id
      WHERE 1=1
    `;
    const params = [];

    if (estado && estado !== 'all') {
      sql += ' AND f.estado = ?';
      params.push(estado);
    }
    if (q) {
      sql += ' AND (f.secuencial LIKE ? OR c.num_doc LIKE ? OR LOWER(c.razon_social) LIKE ?)';
      params.push(`%${q}%`, `%${q}%`, `%${q.toLowerCase()}%`);
    }

    sql += ' ORDER BY f.id DESC';
    const invoices = db.prepare(sql).all(...params);
    res.json({ success: true, data: invoices });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Obtener detalle completo de factura (para RIDE e impresión)
app.get('/api/invoices/:id', (req, res) => {
  try {
    const invoice = getInvoiceDetails(req.params.id);
    if (!invoice) return res.status(404).json({ success: false, error: 'Factura no encontrada' });
    res.json({ success: true, data: invoice });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Emitir factura manual (Caja / POS)
app.post('/api/invoices', (req, res) => {
  try {
    const { cliente_id, items, forma_pago, notas } = req.body;
    const invoice = createInvoice({ cliente_id, items, forma_pago, notas });
    res.status(201).json({ success: true, data: invoice, message: 'Factura emitida exitosamente' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Anular factura
app.post('/api/invoices/:id/anular', (req, res) => {
  try {
    const { restoreStock = true } = req.body;
    const result = anularInvoice(req.params.id, restoreStock);
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Descargar XML estándar SRI
app.get('/api/invoices/:id/xml', (req, res) => {
  try {
    const xml = generateInvoiceXml(req.params.id);
    const invoice = getInvoiceDetails(req.params.id);
    const filename = `factura_${invoice ? invoice.secuencial : req.params.id}.xml`;
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(xml);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Descargar XML Firmado XAdES-BES
app.get('/api/invoices/:id/xml-signed', (req, res) => {
  try {
    const certPath = path.join(__dirname, 'certificates', 'firma.p12');
    if (!fs.existsSync(certPath)) {
      return res.status(400).json({ success: false, error: 'No se ha configurado ninguna firma electrónica (.p12). Ve al menú "Configuración" para cargarla.' });
    }
    const password = getConfig('firma_password', '');
    if (!password) {
      return res.status(400).json({ success: false, error: 'No se ha registrado la contraseña del certificado de firma electrónica.' });
    }

    const xmlUnsigned = generateInvoiceXml(req.params.id);
    const p12Buffer = fs.readFileSync(certPath);
    const xmlSigned = signInvoiceXmlXadesBes(xmlUnsigned, p12Buffer, password);

    const invoice = getInvoiceDetails(req.params.id);
    const filename = `factura_${invoice ? invoice.secuencial : req.params.id}_firmada.xml`;
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(xmlSigned);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Consulta automática de Nombres / Razón Social en SRI en Línea
app.get('/api/sri/lookup/:identificacion', async (req, res) => {
  try {
    const result = await consultarSRIEnLinea(req.params.identificacion);
    if (!result || !result.success) {
      return res.status(404).json(result || { success: false, error: 'No se encontraron datos en el SRI' });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 5. ESTADÍSTICAS & AJUSTES
// ==========================================

app.get('/api/stats', (req, res) => {
  try {
    const totalProd = db.prepare('SELECT count(*) as c FROM productos').get().c;
    const visibleProd = db.prepare('SELECT count(*) as c FROM productos WHERE visible = 1').get().c;
    const agotadosProd = db.prepare('SELECT count(*) as c FROM productos WHERE stock <= 0').get().c;
    const pedidosPend = db.prepare("SELECT count(*) as c FROM pedidos WHERE estado = 'PENDIENTE'").get().c;
    
    // Facturación total del mes
    const facturadoTotal = db.prepare("SELECT COALESCE(SUM(total), 0) as total FROM facturas WHERE estado = 'EMITIDA'").get().total;
    const ivaTotal = db.prepare("SELECT COALESCE(SUM(monto_iva), 0) as total FROM facturas WHERE estado = 'EMITIDA'").get().total;
    const facturasCount = db.prepare("SELECT count(*) as c FROM facturas WHERE estado = 'EMITIDA'").get().c;

    const botActivo = getConfig('bot_activo', '1') === '1';

    res.json({
      success: true,
      data: {
        productos_total: totalProd,
        productos_visibles: visibleProd,
        productos_agotados: agotadosProd,
        pedidos_pendientes: pedidosPend,
        facturacion_total: parseFloat(facturadoTotal.toFixed(2)),
        iva_recaudado: parseFloat(ivaTotal.toFixed(2)),
        facturas_emitidas: facturasCount,
        bot_activo: botActivo
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Configuración
app.get('/api/settings', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM configuracion').all();
    const configMap = {};
    for (const r of rows) configMap[r.clave] = r.valor;
    res.json({ success: true, data: configMap });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/settings', (req, res) => {
  try {
    const updateStmt = db.prepare(`
      INSERT INTO configuracion (clave, valor) VALUES (?, ?)
      ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor
    `);
    db.exec('BEGIN TRANSACTION;');
    for (const [k, v] of Object.entries(req.body)) {
      updateStmt.run(k, String(v));
    }
    db.exec('COMMIT;');
    res.json({ success: true, message: 'Configuración actualizada exitosamente' });
  } catch (err) {
    db.exec('ROLLBACK;');
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 5.1 FIRMA ELECTRÓNICA SRI (.P12 / PKCS#12)
// ==========================================

// Consultar estado de la firma electrónica configurada
app.get('/api/settings/signature/info', (req, res) => {
  try {
    const certPath = path.join(__dirname, 'certificates', 'firma.p12');
    const hasFile = fs.existsSync(certPath);
    const titular = getConfig('firma_titular', '');
    const emisor = getConfig('firma_emisor', '');
    const validoHasta = getConfig('firma_valido_hasta', '');
    const diasRestantes = getConfig('firma_dias_restantes', '0');
    const estado = getConfig('firma_estado', hasFile ? 'ACTIVA' : 'NO_CONFIGURADA');
    const ambienteSri = getConfig('ambiente_sri', '1'); // 1 = Pruebas, 2 = Producción
    const hasPassword = Boolean(getConfig('firma_password', ''));

    res.json({
      success: true,
      data: {
        has_file: hasFile,
        has_password: hasPassword,
        titular: titular || (hasFile ? 'Certificado Digital Cargado' : 'No se ha configurado firma digital'),
        emisor: emisor || '—',
        valido_hasta: validoHasta || '—',
        dias_restantes: parseInt(diasRestantes, 10) || 0,
        estado: hasFile ? estado : 'NO_CONFIGURADA',
        ambiente_sri: ambienteSri
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Cargar y validar certificado .p12
app.post('/api/settings/signature/upload', (req, res) => {
  try {
    const { p12Base64, password, ambiente_sri } = req.body;
    if (!p12Base64) {
      return res.status(400).json({ success: false, error: 'Por favor selecciona el archivo de tu firma electrónica (.p12 o .pfx)' });
    }
    if (!password) {
      return res.status(400).json({ success: false, error: 'Por favor ingresa la contraseña de tu firma electrónica' });
    }

    const p12Buffer = Buffer.from(p12Base64.replace(/^data:.*?;base64,/, ''), 'base64');
    const parseResult = parseP12(p12Buffer, password);

    if (!parseResult.success) {
      return res.status(400).json({ success: false, error: parseResult.error });
    }

    // Asegurar directorio certificates/
    const certDir = path.join(__dirname, 'certificates');
    if (!fs.existsSync(certDir)) {
      fs.mkdirSync(certDir, { recursive: true });
    }
    const certPath = path.join(certDir, 'firma.p12');
    fs.writeFileSync(certPath, p12Buffer);

    // Guardar parámetros en la base de datos
    const updateStmt = db.prepare(`
      INSERT INTO configuracion (clave, valor) VALUES (?, ?)
      ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor
    `);

    db.exec('BEGIN TRANSACTION;');
    updateStmt.run('firma_ruta', 'certificates/firma.p12');
    updateStmt.run('firma_password', password);
    updateStmt.run('firma_titular', parseResult.titular);
    updateStmt.run('firma_emisor', parseResult.emisor);
    updateStmt.run('firma_valido_hasta', parseResult.valido_hasta);
    updateStmt.run('firma_dias_restantes', String(parseResult.dias_restantes));
    updateStmt.run('firma_estado', parseResult.estado);
    if (ambiente_sri) updateStmt.run('ambiente_sri', String(ambiente_sri));
    db.exec('COMMIT;');

    res.json({
      success: true,
      message: '¡Firma electrónica (.p12) validada y configurada exitosamente!',
      data: {
        titular: parseResult.titular,
        emisor: parseResult.emisor,
        valido_hasta: parseResult.valido_hasta,
        dias_restantes: parseResult.dias_restantes,
        estado: parseResult.estado,
        ambiente_sri: ambiente_sri || getConfig('ambiente_sri', '1')
      }
    });
  } catch (err) {
    if (db.inTransaction) db.exec('ROLLBACK;');
    res.status(500).json({ success: false, error: err.message });
  }
});

// Probar firma electrónica guardada
app.post('/api/settings/signature/test', (req, res) => {
  try {
    const certPath = path.join(__dirname, 'certificates', 'firma.p12');
    if (!fs.existsSync(certPath)) {
      return res.status(404).json({ success: false, error: 'No existe archivo de firma digital (.p12) guardado' });
    }
    const password = getConfig('firma_password', '');
    if (!password) {
      return res.status(400).json({ success: false, error: 'No hay contraseña guardada para la firma digital' });
    }

    const p12Buffer = fs.readFileSync(certPath);
    const parseResult = parseP12(p12Buffer, password);
    if (!parseResult.success) {
      return res.status(400).json({ success: false, error: parseResult.error });
    }

    res.json({
      success: true,
      message: 'Firma electrónica operativa y válida',
      data: parseResult
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Bot respuestas
app.get('/api/bot/replies', (req, res) => {
  try {
    const replies = db.prepare('SELECT * FROM bot_respuestas ORDER BY id ASC').all();
    res.json({ success: true, data: replies });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/bot/replies', (req, res) => {
  try {
    const { keyword, response } = req.body;
    if (!keyword || !response) return res.status(400).json({ success: false, error: 'Palabra clave y respuesta son obligatorias' });
    const stmt = db.prepare('INSERT INTO bot_respuestas (keyword, response) VALUES (?, ?)');
    const resId = stmt.run(keyword.trim().toLowerCase(), response.trim());
    res.status(201).json({ success: true, data: { id: resId.lastInsertRowid, keyword, response } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/bot/replies/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM bot_respuestas WHERE id = ?').run(req.params.id);
    res.json({ success: true, message: 'Respuesta eliminada' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/bot/chat', (req, res) => {
  try {
    const { message } = req.body;
    const botActivo = getConfig('bot_activo', '1') === '1';
    if (!botActivo) {
      return res.json({ success: true, reply: '(El bot de WhatsApp se encuentra actualmente inactivo)' });
    }
    const cleanMsg = (message || '').toLowerCase();
    const replies = db.prepare('SELECT * FROM bot_respuestas').all();
    const match = replies.find(r => cleanMsg.includes(r.keyword.toLowerCase()));

    const reply = match ? match.response : getConfig('bot_bienvenida', '¡Hola! Bienvenida a RS Store. ¿En qué te ayudo? Escribe *catálogo*, *precios* o *envíos*.');
    res.json({ success: true, reply });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 6. ASISTENTE DE IA (COPYWRITING BOUTIQUE)
// ==========================================
app.post('/api/ai/describe-product', async (req, res) => {
  try {
    const { name, cat, notes = '' } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'El nombre del producto es obligatorio' });
    const description = await generateProductDescription(name, cat, notes);
    res.json({ success: true, description });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 7. OCR DE COMPROBANTES & CONCILIACIÓN BANCARIA
// ==========================================

// Subir y procesar comprobante de pago por transferencia (OCR Inteligente Ecuador)
app.post('/api/payments/upload-voucher', async (req, res) => {
  try {
    const { image_base64, pedido_id, cliente_telefono, cliente_nombre } = req.body;
    if (!image_base64) {
      return res.status(400).json({ success: false, error: 'Se requiere la imagen del comprobante de transferencia' });
    }

    // Procesar con el motor OCR especializado en bancos de Ecuador
    const ocrResult = await processBankVoucher(image_base64, pedido_id || null);
    if (!ocrResult.success) {
      return res.status(500).json({ success: false, error: ocrResult.error });
    }

    const d = ocrResult.data;

    // Buscar o registrar cliente para el comprobante
    let clienteId = null;
    let finalNombre = cliente_nombre || 'Cliente Web';
    let finalTel = cliente_telefono || '';

    if (pedido_id) {
      const p = db.prepare('SELECT p.*, c.razon_social, c.telefono FROM pedidos p LEFT JOIN clientes c ON p.cliente_id = c.id WHERE p.id = ?').get(pedido_id);
      if (p) {
        clienteId = p.cliente_id;
        finalNombre = p.razon_social || finalNombre;
        finalTel = p.telefono || finalTel;
      }
    }

    // Insertar en comprobantes_pago
    const stmtComp = db.prepare(`
      INSERT INTO comprobantes_pago (
        pedido_id, cliente_id, cliente_nombre, cliente_telefono, imagen_url,
        banco, referencia, monto, fecha_transferencia, titular_detectado,
        estado, observaciones, conciliado
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const isConciliado = d.estado === 'VALIDADO_OK' ? 1 : 0;
    const compRes = stmtComp.run(
      pedido_id || null,
      clienteId,
      finalNombre,
      finalTel,
      image_base64,
      d.banco,
      d.referencia,
      d.monto,
      d.fecha,
      d.titular_detectado,
      d.estado,
      d.observaciones,
      isConciliado
    );
    const comprobanteId = compRes.lastInsertRowid;

    // Si fue validado con éxito y hay pedido, actualizar pedido a PAGADO y registrar movimiento
    if (pedido_id && d.estado === 'VALIDADO_OK') {
      db.prepare("UPDATE pedidos SET estado = 'PAGADO' WHERE id = ?").run(pedido_id);

      db.prepare(`
        INSERT INTO movimientos_caja (tipo, categoria, monto, descripcion, comprobante_id, metodo_pago, estado)
        VALUES ('INGRESO', 'VENTA_WEB', ?, ?, ?, 'TRANSFERENCIA', 'CONCILIADO')
      `).run(d.monto, `Transferencia validada Pedido #${pedido_id} (${d.banco} Ref: ${d.referencia})`, comprobanteId);
    }

    // Guardar en historial de chat WhatsApp
    if (finalTel) {
      let conv = db.prepare('SELECT id FROM conversaciones WHERE cliente_telefono = ?').get(finalTel);
      if (!conv) {
        const convRes = db.prepare('INSERT INTO conversaciones (cliente_telefono, cliente_nombre, ultimo_mensaje, no_leidos) VALUES (?, ?, ?, 1)')
          .run(finalTel, finalNombre, `[Foto de Comprobante ${d.banco} $${d.monto}]`);
        conv = { id: convRes.lastInsertRowid };
      } else {
        db.prepare("UPDATE conversaciones SET ultimo_mensaje = ?, no_leidos = no_leidos + 1, updated_at = datetime('now','localtime') WHERE id = ?")
          .run(`[Foto de Comprobante ${d.banco} $${d.monto}]`, conv.id);
      }

      // Mensaje del cliente con la foto
      db.prepare("INSERT INTO mensajes (conversacion_id, remitente, texto, media_url) VALUES (?, 'CLIENTE', ?, ?)")
        .run(conv.id, `Envío comprobante de pago por $${d.monto.toFixed(2)} (${d.banco})`, image_base64);

      // Respuesta automática del bot
      db.prepare("INSERT INTO mensajes (conversacion_id, remitente, texto) VALUES (?, 'BOT', ?)")
        .run(conv.id, d.autoReply);
    }

    // Notificar al bot de Telegram del administrador
    if (pedido_id) {
      try { notifyOrderToTelegram(pedido_id, comprobanteId); } catch (e) {}
    }

    res.json({
      success: true,
      data: {
        comprobante_id: comprobanteId,
        ...d
      },
      message: d.autoReply
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Resumen financiero para Conciliación Bancaria y Flujo de Caja
app.get('/api/finance/overview', (req, res) => {
  try {
    const ingresos = db.prepare("SELECT COALESCE(SUM(monto), 0) as total FROM movimientos_caja WHERE tipo = 'INGRESO'").get().total;
    const egresos = db.prepare("SELECT COALESCE(SUM(monto), 0) as total FROM movimientos_caja WHERE tipo = 'EGRESO'").get().total;
    const saldo = parseFloat((ingresos - egresos).toFixed(2));

    const totalComprobantes = db.prepare('SELECT COUNT(*) as c FROM comprobantes_pago').get().c;
    const comprobantesPendientes = db.prepare("SELECT COUNT(*) as c FROM comprobantes_pago WHERE conciliado = 0").get().c;
    const comprobantesValidados = db.prepare("SELECT COUNT(*) as c FROM comprobantes_pago WHERE estado = 'VALIDADO_OK'").get().c;

    res.json({
      success: true,
      data: {
        ingresos_total: parseFloat(ingresos.toFixed(2)),
        egresos_total: parseFloat(egresos.toFixed(2)),
        saldo_bancario: saldo,
        comprobantes_total: totalComprobantes,
        comprobantes_pendientes: comprobantesPendientes,
        comprobantes_validados: comprobantesValidados
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Listar todos los comprobantes bancarios recibidos
app.get('/api/finance/receipts', (req, res) => {
  try {
    const receipts = db.prepare(`
      SELECT cp.*, p.codigo_pedido, p.total as pedido_total
      FROM comprobantes_pago cp
      LEFT JOIN pedidos p ON cp.pedido_id = p.id
      ORDER BY cp.id DESC
    `).all();
    res.json({ success: true, data: receipts });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Conciliar / Aprobar manualmente un comprobante
app.post('/api/finance/receipts/:id/reconcile', (req, res) => {
  try {
    const comp = db.prepare('SELECT * FROM comprobantes_pago WHERE id = ?').get(req.params.id);
    if (!comp) return res.status(404).json({ success: false, error: 'Comprobante no encontrado' });

    db.prepare("UPDATE comprobantes_pago SET estado = 'VALIDADO_OK', conciliado = 1 WHERE id = ?").run(comp.id);

    if (comp.pedido_id) {
      db.prepare("UPDATE pedidos SET estado = 'PAGADO' WHERE id = ?").run(comp.pedido_id);
    }

    // Registrar ingreso en caja si no existe
    const existingMov = db.prepare('SELECT id FROM movimientos_caja WHERE comprobante_id = ?').get(comp.id);
    if (!existingMov) {
      db.prepare(`
        INSERT INTO movimientos_caja (tipo, categoria, monto, descripcion, comprobante_id, metodo_pago, estado)
        VALUES ('INGRESO', 'VENTA_WEB', ?, ?, ?, 'TRANSFERENCIA', 'CONCILIADO')
      `).run(comp.monto || 0, `Comprobante conciliado manualmente: ${comp.banco} (Ref: ${comp.referencia})`, comp.id);
    }

    res.json({ success: true, message: 'Comprobante conciliado y aprobado con éxito' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Rechazar comprobante bancario
app.post('/api/finance/receipts/:id/reject', (req, res) => {
  try {
    const { motivo } = req.body;
    const comp = db.prepare('SELECT * FROM comprobantes_pago WHERE id = ?').get(req.params.id);
    if (!comp) return res.status(404).json({ success: false, error: 'Comprobante no encontrado' });

    db.prepare("UPDATE comprobantes_pago SET estado = 'RECHAZADO_TITULAR', observaciones = ? WHERE id = ?")
      .run(motivo || 'Rechazado manualmente por el administrador', comp.id);

    if (comp.pedido_id) {
      db.prepare("UPDATE pedidos SET estado = 'CANCELADO' WHERE id = ?").run(comp.pedido_id);
    }

    res.json({ success: true, message: 'Comprobante rechazado' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Movimientos de caja (Ingresos y Egresos)
app.get('/api/finance/movements', (req, res) => {
  try {
    const movements = db.prepare('SELECT * FROM movimientos_caja ORDER BY id DESC LIMIT 100').all();
    res.json({ success: true, data: movements });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/finance/movements', (req, res) => {
  try {
    const { tipo, categoria, monto, descripcion, metodo_pago = 'TRANSFERENCIA' } = req.body;
    if (!tipo || !monto || !descripcion) {
      return res.status(400).json({ success: false, error: 'Tipo, monto y descripción son obligatorios' });
    }
    const numMonto = parseFloat(String(monto).replace(',', '.'));
    if (isNaN(numMonto) || numMonto <= 0) {
      return res.status(400).json({ success: false, error: 'Monto debe ser un número positivo' });
    }

    const stmt = db.prepare(`
      INSERT INTO movimientos_caja (tipo, categoria, monto, descripcion, metodo_pago, estado)
      VALUES (?, ?, ?, ?, ?, 'CONCILIADO')
    `);
    const result = stmt.run(tipo, categoria || (tipo === 'EGRESO' ? 'GASTOS_OPERATIVOS' : 'OTROS'), numMonto, descripcion, metodo_pago);
    res.status(201).json({ success: true, message: 'Movimiento financiero registrado con éxito', id: result.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 8. BANDEJA "WHATSAPP WEB" & CHAT AUTÓNOMO
// ==========================================

// Listar conversaciones
app.get('/api/chat/conversations', (req, res) => {
  try {
    const convs = db.prepare('SELECT * FROM conversaciones ORDER BY updated_at DESC').all();
    res.json({ success: true, data: convs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Obtener mensajes de una conversación
app.get('/api/chat/conversations/:id/messages', (req, res) => {
  try {
    const msgs = db.prepare('SELECT * FROM mensajes WHERE conversacion_id = ? ORDER BY id ASC').all(req.params.id);
    db.prepare('UPDATE conversaciones SET no_leidos = 0 WHERE id = ?').run(req.params.id);
    res.json({ success: true, data: msgs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Responder desde el panel como Administrador
app.post('/api/chat/conversations/:id/reply', async (req, res) => {
  try {
    const { texto, mensaje } = req.body;
    const msgText = (texto || mensaje || '').trim();
    if (!msgText) return res.status(400).json({ success: false, error: 'El mensaje no puede estar vacío' });

    const stmt = db.prepare("INSERT INTO mensajes (conversacion_id, remitente, texto, fecha, estado) VALUES (?, 'ADMIN', ?, datetime('now', 'localtime'), 'ENVIADO')");
    stmt.run(req.params.id, msgText);

    db.prepare("UPDATE conversaciones SET ultimo_mensaje = ?, updated_at = datetime('now','localtime') WHERE id = ?")
      .run(msgText, req.params.id);

    // Si WhatsApp está conectado con QR, enviar también al número de WhatsApp del cliente en vivo
    let waSent = false;
    let waError = null;
    try {
      const conv = db.prepare('SELECT cliente_telefono FROM conversaciones WHERE id = ?').get(req.params.id);
      if (conv && conv.cliente_telefono) {
        const waRes = await sendWhatsAppMessage(conv.cliente_telefono, msgText);
        if (waRes && waRes.success) {
          waSent = true;
        } else if (waRes && waRes.error) {
          waError = waRes.error;
          console.warn('Aviso enviando WhatsApp a cliente:', waRes.error);
        }
      }
    } catch(e) {
      console.error('Error enviando respuesta WhatsApp:', e);
      waError = e.message;
    }

    res.json({ success: true, message: 'Mensaje enviado', waSent, waError });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Estado de WhatsApp Web & QR
app.get('/api/whatsapp/status', (req, res) => {
  try {
    const status = getWhatsAppStatus();
    res.json({ success: true, data: status });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Desconectar WhatsApp Web
app.post('/api/whatsapp/disconnect', async (req, res) => {
  try {
    const result = await disconnectWhatsApp();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Enviar mensaje por WhatsApp
app.post('/api/whatsapp/send', async (req, res) => {
  try {
    const { phone, text } = req.body;
    if (!phone || !text) return res.status(400).json({ success: false, error: 'Teléfono y texto son requeridos' });
    const result = await sendWhatsAppMessage(phone, text);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Motor de consultas del Administrador (Web & Telegram)
app.post('/api/admin/query', async (req, res) => {
  try {
    const { query } = req.body;
    const result = await processAdminQuery(query || '');
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Probar servidor de correo SMTP
app.post('/api/settings/smtp/test', async (req, res) => {
  try {
    const result = await testSmtpConnection(req.body);
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Probar conexión con Bot de Telegram (Diagnóstico Inteligente y Persistencia)
app.post('/api/settings/telegram/test', async (req, res) => {
  try {
    const { token, chatId } = req.body;
    const result = await testTelegramBot(token, chatId);
    if (!result.success) {
      return res.status(400).json(result);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 9. GESTIÓN DE USUARIOS & EQUIPO ADMIN
// ==========================================

// Listar usuarios
app.get('/api/users', (req, res) => {
  try {
    const users = db.prepare('SELECT id, nombre, num_doc, username, rol, email, telefono, telegram_chat_id, telegram_username, activo, created_at FROM usuarios ORDER BY id ASC').all();
    res.json({ success: true, data: users });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Crear usuario
app.post('/api/users', (req, res) => {
  try {
    const { nombre, num_doc = '', username, password, rol = 'VENDEDOR', email = '', telefono = '' } = req.body;
    if (!nombre || !username || !password) {
      return res.status(400).json({ success: false, error: 'Nombre, usuario y contraseña son obligatorios' });
    }

    const cleanUsername = username.trim().toLowerCase();
    const existing = db.prepare('SELECT id FROM usuarios WHERE username = ?').get(cleanUsername);
    if (existing) {
      return res.status(400).json({ success: false, error: `El nombre de usuario "${cleanUsername}" ya está en uso.` });
    }

    const stmt = db.prepare(`
      INSERT INTO usuarios (nombre, num_doc, username, password, rol, email, telefono, activo)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `);
    const result = stmt.run(nombre.trim(), (num_doc || '').trim(), cleanUsername, password.trim(), rol, (email || '').trim(), (telefono || '').trim());
    const newUser = db.prepare('SELECT id, nombre, num_doc, username, rol, email, telefono, telegram_chat_id, telegram_username, activo, created_at FROM usuarios WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ success: true, data: newUser, message: 'Usuario creado exitosamente' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Modificar usuario
app.put('/api/users/:id', (req, res) => {
  try {
    const { nombre, num_doc = '', rol, email = '', telefono = '', activo = 1, password } = req.body;
    const user = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ success: false, error: 'Usuario no encontrado' });

    if (password && password.trim().length > 0) {
      db.prepare(`
        UPDATE usuarios SET nombre = ?, num_doc = ?, rol = ?, email = ?, telefono = ?, activo = ?, password = ?
        WHERE id = ?
      `).run(nombre.trim(), (num_doc || '').trim(), rol, (email || '').trim(), (telefono || '').trim(), activo ? 1 : 0, password.trim(), req.params.id);
    } else {
      db.prepare(`
        UPDATE usuarios SET nombre = ?, num_doc = ?, rol = ?, email = ?, telefono = ?, activo = ?
        WHERE id = ?
      `).run(nombre.trim(), (num_doc || '').trim(), rol, (email || '').trim(), (telefono || '').trim(), activo ? 1 : 0, req.params.id);
    }

    const updated = db.prepare('SELECT id, nombre, num_doc, username, rol, email, telefono, telegram_chat_id, telegram_username, activo, created_at FROM usuarios WHERE id = ?').get(req.params.id);
    res.json({ success: true, data: updated, message: 'Usuario actualizado con éxito' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Desvincular Telegram de un usuario
app.post('/api/users/:id/unlink-telegram', (req, res) => {
  try {
    db.prepare(`UPDATE usuarios SET telegram_chat_id = '', telegram_username = '' WHERE id = ?`).run(req.params.id);
    res.json({ success: true, message: 'Telegram desvinculado con éxito' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Eliminar usuario
app.delete('/api/users/:id', (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ success: false, error: 'Usuario no encontrado' });

    if (user.username === 'admin') {
      return res.status(400).json({ success: false, error: 'No es posible eliminar la cuenta del Administrador Principal del sistema.' });
    }

    db.prepare('DELETE FROM usuarios WHERE id = ?').run(req.params.id);
    res.json({ success: true, message: `Usuario ${user.username} eliminado.` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 10. CUPONES & CÓDIGOS DE DESCUENTO
// ==========================================

app.get('/api/coupons', (req, res) => {
  try {
    const coupons = db.prepare('SELECT * FROM cupones ORDER BY id DESC').all();
    res.json({ success: true, data: coupons });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/coupons', (req, res) => {
  try {
    const { codigo, tipo = 'PORCENTAJE', valor, minimo_compra = 0, usos_max = 0 } = req.body;
    if (!codigo || !valor) return res.status(400).json({ success: false, error: 'Código y valor son obligatorios' });

    const cleanCode = codigo.trim().toUpperCase();
    const exist = db.prepare('SELECT id FROM cupones WHERE codigo = ?').get(cleanCode);
    if (exist) return res.status(400).json({ success: false, error: `El código "${cleanCode}" ya existe` });

    const stmt = db.prepare(`
      INSERT INTO cupones (codigo, tipo, valor, minimo_compra, usos_max, activo)
      VALUES (?, ?, ?, ?, ?, 1)
    `);
    const r = stmt.run(cleanCode, tipo, parseFloat(valor), parseFloat(minimo_compra || 0), parseInt(usos_max || 0, 10));
    res.status(201).json({ success: true, message: 'Cupón creado con éxito', id: r.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/coupons/:id/toggle', (req, res) => {
  try {
    const c = db.prepare('SELECT * FROM cupones WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ success: false, error: 'Cupón no encontrado' });
    const nuevoEstado = c.activo ? 0 : 1;
    db.prepare('UPDATE cupones SET activo = ? WHERE id = ?').run(nuevoEstado, req.params.id);
    res.json({ success: true, message: `Cupón ${nuevoEstado ? 'activado' : 'desactivado'}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/coupons/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM cupones WHERE id = ?').run(req.params.id);
    res.json({ success: true, message: 'Cupón eliminado' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/coupons/validate', (req, res) => {
  try {
    const { code, subtotal = 0 } = req.body;
    if (!code) return res.status(400).json({ success: false, valid: false, error: 'Código requerido' });

    const cleanCode = code.trim().toUpperCase();
    const coupon = db.prepare('SELECT * FROM cupones WHERE codigo = ?').get(cleanCode);

    if (!coupon) {
      return res.status(404).json({ success: false, valid: false, error: 'Código de descuento no válido o no existe.' });
    }
    if (!coupon.activo) {
      return res.status(400).json({ success: false, valid: false, error: 'Este cupón se encuentra inactivo actualmente.' });
    }
    if (coupon.usos_max > 0 && coupon.usos_actuales >= coupon.usos_max) {
      return res.status(400).json({ success: false, valid: false, error: 'Este cupón ha alcanzado su límite de usos.' });
    }
    const numSubtotal = parseFloat(subtotal) || 0;
    if (coupon.minimo_compra > 0 && numSubtotal < coupon.minimo_compra) {
      return res.status(400).json({
        success: false,
        valid: false,
        error: `El monto mínimo de compra para este cupón es de $${coupon.minimo_compra.toFixed(2)}.`
      });
    }

    let discountAmount = 0;
    if (coupon.tipo === 'PORCENTAJE') {
      discountAmount = parseFloat(((numSubtotal * coupon.valor) / 100).toFixed(2));
    } else {
      discountAmount = parseFloat(Math.min(coupon.valor, numSubtotal).toFixed(2));
    }

    res.json({
      success: true,
      valid: true,
      data: {
        codigo: coupon.codigo,
        tipo: coupon.tipo,
        valor: coupon.valor,
        monto_descuento: discountAmount,
        nuevo_subtotal: parseFloat(Math.max(0, numSubtotal - discountAmount).toFixed(2))
      },
      message: `¡Cupón aplicado! Descuento de $${discountAmount.toFixed(2)}`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 11. PROVEEDORES, COMPRAS & KARDEX DE INVENTARIO
// ==========================================

// Listar proveedores
app.get('/api/suppliers', (req, res) => {
  try {
    const suppliers = db.prepare('SELECT * FROM proveedores ORDER BY razon_social ASC').all();
    res.json({ success: true, data: suppliers });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Crear proveedor
app.post('/api/suppliers', (req, res) => {
  try {
    const razon_social = (req.body.razon_social || '').trim();
    const ruc_cedula = (req.body.ruc_cedula || req.body.ruc || '').trim();
    const contacto_nombre = (req.body.contacto_nombre || req.body.contacto || '').trim();
    const telefono = (req.body.telefono || '').trim();
    const email = (req.body.email || '').trim();
    const direccion = (req.body.direccion || '').trim();

    if (!razon_social || !ruc_cedula) {
      return res.status(400).json({ success: false, error: 'Razón Social y RUC/Cédula son obligatorios' });
    }

    const exist = db.prepare('SELECT id FROM proveedores WHERE ruc_cedula = ?').get(ruc_cedula);
    if (exist) {
      return res.status(400).json({ success: false, error: `El proveedor con identificación "${ruc_cedula}" ya existe` });
    }

    const stmt = db.prepare(`
      INSERT INTO proveedores (razon_social, ruc_cedula, telefono, email, direccion, contacto_nombre)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const r = stmt.run(razon_social, ruc_cedula, telefono, email, direccion, contacto_nombre);
    res.status(201).json({ success: true, message: 'Proveedor registrado exitosamente', id: r.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Listar compras
app.get('/api/purchases', (req, res) => {
  try {
    const purchases = db.prepare(`
      SELECT c.*, p.ruc_cedula as proveedor_ruc, p.telefono as proveedor_telefono
      FROM compras c
      LEFT JOIN proveedores p ON c.proveedor_id = p.id
      ORDER BY c.id DESC
    `).all();

    for (const pur of purchases) {
      pur.detalles = db.prepare('SELECT * FROM compra_detalles WHERE compra_id = ?').all(pur.id);
      pur.fecha_compra = pur.fecha;
      pur.total_items = pur.detalles.reduce((s, d) => s + (d.cantidad || 0), 0);
    }

    res.json({ success: true, data: purchases });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Obtener compra por ID
app.get('/api/purchases/:id', (req, res) => {
  try {
    const purchase = db.prepare('SELECT * FROM compras WHERE id = ?').get(req.params.id);
    if (!purchase) return res.status(404).json({ success: false, error: 'Compra no encontrada' });
    purchase.detalles = db.prepare('SELECT * FROM compra_detalles WHERE compra_id = ?').all(req.params.id);
    purchase.fecha_compra = purchase.fecha;
    purchase.total_items = purchase.detalles.reduce((s, d) => s + (d.cantidad || 0), 0);
    purchase.proveedor = db.prepare('SELECT * FROM proveedores WHERE id = ?').get(purchase.proveedor_id) || null;
    res.json({ success: true, data: purchase });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Registrar nueva compra (Entrada a inventario + Kardex + Egreso en caja)
app.post('/api/purchases', (req, res) => {
  try {
    const numero_factura = (req.body.numero_factura || '').trim();
    const proveedor_id = req.body.proveedor_id ? parseInt(req.body.proveedor_id, 10) : null;
    let proveedor_nombre = (req.body.proveedor_nombre || '').trim();
    const fecha = req.body.fecha || req.body.fecha_compra || null;
    const metodo_pago = req.body.metodo_pago || 'TRANSFERENCIA';
    const notas = (req.body.notas || req.body.observaciones || '').trim();
    const items = req.body.items || [];

    if (!numero_factura) {
      return res.status(400).json({ success: false, error: 'El número de factura del proveedor es obligatorio' });
    }
    if (!items || !items.length) {
      return res.status(400).json({ success: false, error: 'Debes incluir al menos un producto en la compra' });
    }

    db.exec('BEGIN TRANSACTION;');

    try {
      // 1. Resolver proveedor
      let resolvedProvId = proveedor_id;
      let resolvedProvName = proveedor_nombre || 'Proveedor General';
      if (proveedor_id) {
        const prov = db.prepare('SELECT id, razon_social FROM proveedores WHERE id = ?').get(proveedor_id);
        if (prov) resolvedProvName = prov.razon_social;
      }


      // 2. Calcular totales
      let subtotal = 0;
      for (const it of items) {
        const c = parseFloat(it.costo_unitario) || 0;
        const q = parseInt(it.cantidad, 10) || 1;
        subtotal += (c * q);
      }
      const iva = parseFloat((subtotal * 0.15).toFixed(2));
      const total = parseFloat((subtotal + iva).toFixed(2));

      // 3. Insertar compra
      const insertComp = db.prepare(`
        INSERT INTO compras (numero_factura, proveedor_id, proveedor_nombre, fecha, subtotal, iva, total, metodo_pago, estado, notas)
        VALUES (?, ?, ?, COALESCE(?, datetime('now', 'localtime')), ?, ?, ?, ?, 'RECIBIDO', ?)
      `);
      const compRes = insertComp.run(
        numero_factura.trim(),
        resolvedProvId || null,
        resolvedProvName,
        fecha || null,
        subtotal,
        iva,
        total,
        metodo_pago,
        notas
      );
      const compraId = compRes.lastInsertRowid;

      // 4. Insertar detalles, incrementar stock y registrar en Kardex
      const insertDet = db.prepare(`
        INSERT INTO compra_detalles (compra_id, producto_id, producto_nombre, talla, cantidad, costo_unitario, subtotal)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      const insertKardex = db.prepare(`
        INSERT INTO kardex (producto_id, producto_nombre, tipo_movimiento, cantidad, stock_anterior, stock_actual, costo_unitario, referencia_doc, motivo, fecha)
        VALUES (?, ?, 'COMPRA_ENTRADA', ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now', 'localtime')))
      `);

      for (const it of items) {
        const prodId = it.producto_id;
        const prod = db.prepare('SELECT id, name, stock, tallas FROM productos WHERE id = ?').get(prodId);
        if (!prod) continue;

        const qty = parseInt(it.cantidad, 10) || 1;
        const cost = parseFloat(it.costo_unitario) || 0;
        const itemSub = parseFloat((qty * cost).toFixed(2));
        const talla = it.talla || 'Única';

        insertDet.run(compraId, prod.id, prod.name, talla, qty, cost, itemSub);

        const stockAnterior = prod.stock || 0;
        const stockActual = stockAnterior + qty;

        // Actualizar tallas JSON si existe
        let tallasObj = {};
        try { tallasObj = JSON.parse(prod.tallas || '{}'); } catch(e) {}
        if (talla && Object.keys(tallasObj).length > 0) {
          tallasObj[talla] = (tallasObj[talla] || 0) + qty;
        }

        db.prepare(`
          UPDATE productos 
          SET stock = ?, tallas = ?
          WHERE id = ?
        `).run(stockActual, JSON.stringify(tallasObj), prod.id);

        // Movimiento Kardex
        insertKardex.run(
          prod.id,
          prod.name,
          qty,
          stockAnterior,
          stockActual,
          cost,
          `Factura Compra #${numero_factura}`,
          `Compra a proveedor ${resolvedProvName}`,
          fecha || null
        );
      }

      // 5. Registrar Egreso Financiero en Caja
      db.prepare(`
        INSERT INTO movimientos_caja (tipo, categoria, monto, descripcion, metodo_pago, estado)
        VALUES ('EGRESO', 'COMPRA_MERCADERIA', ?, ?, ?, 'CONCILIADO')
      `).run(total, `Compra de Mercadería Factura #${numero_factura} (${resolvedProvName})`, metodo_pago);

      db.exec('COMMIT;');
      res.status(201).json({ success: true, message: 'Compra y stock registrados exitosamente', id: compraId, total });
    } catch (innerErr) {
      db.exec('ROLLBACK;');
      throw innerErr;
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Movimientos de Kardex (Filtro por producto o tipo)
app.get('/api/kardex', (req, res) => {
  try {
    const { producto_id, tipo } = req.query;
    let sql = 'SELECT * FROM kardex WHERE 1=1';
    const params = [];

    if (producto_id && producto_id !== 'all') {
      sql += ' AND producto_id = ?';
      params.push(producto_id);
    }
    if (tipo && tipo !== 'all') {
      sql += ' AND tipo_movimiento = ?';
      params.push(tipo);
    }

    sql += ' ORDER BY id DESC LIMIT 100';
    const rows = db.prepare(sql).all(...params);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Ajuste manual de inventario (Entrada / Salida / Mermas)
app.post('/api/inventory/adjust', (req, res) => {
  try {
    const { producto_id, cantidad, motivo = 'Ajuste manual de inventario', talla = '' } = req.body;
    const tipo = (req.body.tipo || req.body.tipo_movimiento || '').trim();
    if (!producto_id || !tipo || !cantidad) {
      return res.status(400).json({ success: false, error: 'Producto, tipo de ajuste y cantidad son requeridos' });
    }

    const prod = db.prepare('SELECT id, name, stock, tallas, price FROM productos WHERE id = ?').get(producto_id);
    if (!prod) return res.status(404).json({ success: false, error: 'Producto no encontrado' });

    const qty = parseInt(cantidad, 10);
    if (qty <= 0) return res.status(400).json({ success: false, error: 'La cantidad debe ser mayor a 0' });

    const stockAnterior = prod.stock || 0;
    let stockActual = stockAnterior;

    if (tipo === 'AJUSTE_ENTRADA') {
      stockActual = stockAnterior + qty;
    } else if (tipo === 'AJUSTE_SALIDA') {
      if (stockAnterior < qty) {
        return res.status(400).json({ success: false, error: `Stock insuficiente para salida. Actual: ${stockAnterior}, Solicitado: ${qty}` });
      }
      stockActual = stockAnterior - qty;
    } else {
      return res.status(400).json({ success: false, error: 'Tipo debe ser AJUSTE_ENTRADA o AJUSTE_SALIDA' });
    }

    // Actualizar tallas JSON si existe
    let tallasObj = {};
    try { tallasObj = JSON.parse(prod.tallas || '{}'); } catch(e) {}
    if (talla && tallasObj[talla] !== undefined) {
      if (tipo === 'AJUSTE_ENTRADA') tallasObj[talla] += qty;
      else tallasObj[talla] = Math.max(0, tallasObj[talla] - qty);
    }

    db.prepare('UPDATE productos SET stock = ?, tallas = ? WHERE id = ?').run(stockActual, JSON.stringify(tallasObj), prod.id);

    db.prepare(`
      INSERT INTO kardex (producto_id, producto_nombre, tipo_movimiento, cantidad, stock_anterior, stock_actual, precio_unitario, referencia_doc, motivo)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'Ajuste Físico', ?)
    `).run(prod.id, prod.name, tipo, qty, stockAnterior, stockActual, prod.price, motivo);

    res.json({ success: true, message: 'Ajuste de inventario aplicado con éxito', stockActual });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 12. GESTOR DE BANNERS DE LA TIENDA ONLINE
// ==========================================

app.get('/api/banners', (req, res) => {
  try {
    const { posicion, solo_activos } = req.query;
    let sql = 'SELECT * FROM banners WHERE 1=1';
    const params = [];
    if (posicion) {
      sql += ' AND posicion = ?';
      params.push(posicion);
    }
    if (solo_activos === '1' || solo_activos === 'true') {
      sql += ' AND activo = 1';
    }
    sql += ' ORDER BY orden ASC, id ASC';
    const banners = db.prepare(sql).all(...params);
    res.json({ success: true, data: banners });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/banners', (req, res) => {
  try {
    const {
      posicion = 'PROMO_CENTRAL',
      titulo,
      subtitulo = '',
      badge = '',
      boton_texto = 'Ver Más',
      boton_link = '#coleccion',
      codigo_cupon = '',
      color_fondo = '#3B2A30',
      color_texto = '#FFFFFF',
      imagen_url = '',
      activo = 1,
      orden = 0
    } = req.body;

    if (!titulo) return res.status(400).json({ success: false, error: 'El título del banner es obligatorio' });

    const stmt = db.prepare(`
      INSERT INTO banners (posicion, titulo, subtitulo, badge, boton_texto, boton_link, codigo_cupon, color_fondo, color_texto, imagen_url, activo, orden)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const r = stmt.run(posicion, titulo.trim(), (subtitulo || '').trim(), (badge || '').trim(), (boton_texto || '').trim(), (boton_link || '#coleccion').trim(), (codigo_cupon || '').trim().toUpperCase(), color_fondo || '#3B2A30', color_texto || '#FFFFFF', (imagen_url || '').trim(), activo ? 1 : 0, parseInt(orden || 0, 10));
    res.status(201).json({ success: true, message: 'Banner creado con éxito', id: r.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/banners/:id', (req, res) => {
  try {
    const banner = db.prepare('SELECT * FROM banners WHERE id = ?').get(req.params.id);
    if (!banner) return res.status(404).json({ success: false, error: 'Banner no encontrado' });

    const {
      posicion = banner.posicion,
      titulo = banner.titulo,
      subtitulo = banner.subtitulo,
      badge = banner.badge,
      boton_texto = banner.boton_texto,
      boton_link = banner.boton_link,
      codigo_cupon = banner.codigo_cupon,
      color_fondo = banner.color_fondo,
      color_texto = banner.color_texto,
      imagen_url = banner.imagen_url,
      activo = banner.activo,
      orden = banner.orden
    } = req.body;

    db.prepare(`
      UPDATE banners
      SET posicion = ?, titulo = ?, subtitulo = ?, badge = ?, boton_texto = ?, boton_link = ?, codigo_cupon = ?, color_fondo = ?, color_texto = ?, imagen_url = ?, activo = ?, orden = ?
      WHERE id = ?
    `).run(posicion, titulo, subtitulo, badge, boton_texto, boton_link, (codigo_cupon || '').trim().toUpperCase(), color_fondo, color_texto, imagen_url, activo ? 1 : 0, parseInt(orden || 0, 10), req.params.id);

    res.json({ success: true, message: 'Banner actualizado con éxito' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/banners/:id/toggle', (req, res) => {
  try {
    const banner = db.prepare('SELECT * FROM banners WHERE id = ?').get(req.params.id);
    if (!banner) return res.status(404).json({ success: false, error: 'Banner no encontrado' });
    const nuevoEstado = banner.activo ? 0 : 1;
    db.prepare('UPDATE banners SET activo = ? WHERE id = ?').run(nuevoEstado, req.params.id);
    res.json({ success: true, message: `Banner ${nuevoEstado ? 'activado' : 'desactivado'}`, activo: nuevoEstado });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/banners/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM banners WHERE id = ?').run(req.params.id);
    res.json({ success: true, message: 'Banner eliminado' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(` RS Store Platform & Facturación está en ejecución!`);
  console.log(` Tienda Pública:    http://localhost:${PORT}`);
  console.log(` Panel Admin & POS: http://localhost:${PORT}/admin.html`);
  console.log(` API REST:          http://localhost:${PORT}/api/products`);
  console.log(`====================================================`);

  // Iniciar bot de Telegram en segundo plano
  try {
    startTelegramPolling();
  } catch (e) {
    console.warn('Telegram polling notice:', e.message);
  }

  // Iniciar WhatsApp Web en segundo plano
  try {
    initWhatsApp();
  } catch (e) {
    console.warn('WhatsApp Web init notice:', e.message);
  }
});
