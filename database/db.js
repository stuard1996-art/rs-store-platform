const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const defaultDbPath = path.join(__dirname, 'rs_store.sqlite');
const dbPath = process.env.DATABASE_PATH || defaultDbPath;
const dbDir = path.dirname(dbPath);

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new DatabaseSync(dbPath);

// Enable foreign keys and WAL mode for reliability
db.exec(`PRAGMA foreign_keys = ON;`);
db.exec(`PRAGMA journal_mode = WAL;`);

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS configuracion (
      clave TEXT PRIMARY KEY,
      valor TEXT NOT NULL,
      descripcion TEXT
    );

    CREATE TABLE IF NOT EXISTS productos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      cat TEXT NOT NULL,
      price REAL NOT NULL,
      was_price REAL,
      stock INTEGER NOT NULL DEFAULT 0,
      desc TEXT,
      visible INTEGER NOT NULL DEFAULT 1,
      is_new INTEGER NOT NULL DEFAULT 0,
      badge TEXT DEFAULT '',
      img TEXT DEFAULT '',
      images TEXT DEFAULT '[]',
      genero TEXT DEFAULT 'MUJER',
      tallas TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS clientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo_doc TEXT NOT NULL, -- 'CEDULA', 'RUC', 'PASAPORTE', 'CONSUMIDOR_FINAL'
      num_doc TEXT NOT NULL,
      razon_social TEXT NOT NULL,
      email TEXT,
      telefono TEXT,
      direccion TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS pedidos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo_pedido TEXT NOT NULL UNIQUE,
      cliente_id INTEGER REFERENCES clientes(id),
      subtotal REAL NOT NULL,
      envio REAL NOT NULL DEFAULT 0,
      descuento REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL,
      metodo_pago TEXT NOT NULL,
      estado TEXT NOT NULL DEFAULT 'PENDIENTE', -- PENDIENTE, PAGADO, ENVIADO, ENTREGADO, CANCELADO
      requiere_factura INTEGER NOT NULL DEFAULT 0,
      direccion_envio TEXT,
      ciudad_envio TEXT,
      notas TEXT,
      fecha TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS pedido_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
      producto_id INTEGER REFERENCES productos(id),
      producto_nombre TEXT NOT NULL,
      cantidad INTEGER NOT NULL,
      precio_unitario REAL NOT NULL,
      subtotal REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS facturas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      secuencial TEXT NOT NULL UNIQUE,
      pedido_id INTEGER REFERENCES pedidos(id),
      cliente_id INTEGER NOT NULL REFERENCES clientes(id),
      fecha_emision TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      subtotal_0 REAL NOT NULL DEFAULT 0,
      subtotal_iva REAL NOT NULL DEFAULT 0,
      porcentaje_iva REAL NOT NULL DEFAULT 15.00,
      monto_iva REAL NOT NULL DEFAULT 0,
      descuento REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL,
      forma_pago TEXT NOT NULL DEFAULT '01 - SIN UTILIZACION DEL SISTEMA FINANCIERO',
      estado TEXT NOT NULL DEFAULT 'EMITIDA', -- EMITIDA, ANULADA
      clave_acceso TEXT NOT NULL,
      notas TEXT
    );

    CREATE TABLE IF NOT EXISTS factura_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      factura_id INTEGER NOT NULL REFERENCES facturas(id) ON DELETE CASCADE,
      producto_id INTEGER REFERENCES productos(id),
      descripcion TEXT NOT NULL,
      cantidad INTEGER NOT NULL,
      precio_unitario REAL NOT NULL,
      descuento REAL NOT NULL DEFAULT 0,
      subtotal REAL NOT NULL,
      iva_porcentaje REAL NOT NULL DEFAULT 15.00,
      iva_valor REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS bot_respuestas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword TEXT NOT NULL UNIQUE,
      response TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS comprobantes_pago (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER REFERENCES pedidos(id),
      cliente_id INTEGER REFERENCES clientes(id),
      cliente_nombre TEXT,
      cliente_telefono TEXT,
      imagen_url TEXT NOT NULL,
      banco TEXT,
      referencia TEXT,
      monto REAL,
      fecha_transferencia TEXT,
      titular_detectado TEXT,
      estado TEXT NOT NULL DEFAULT 'PENDIENTE', -- VALIDADO_OK, PENDIENTE, RECHAZADO_FECHA, RECHAZADO_TITULAR, DUPLICADO
      observaciones TEXT,
      conciliado INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS movimientos_caja (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo TEXT NOT NULL, -- INGRESO, EGRESO
      categoria TEXT NOT NULL, -- VENTA_WEB, VENTA_POS, COMPRA_MERCADERIA, ENVIO_SERVIENTREGA, SERVICIOS, GASTOS_OPERATIVOS, OTROS
      monto REAL NOT NULL,
      fecha TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      descripcion TEXT NOT NULL,
      comprobante_id INTEGER REFERENCES comprobantes_pago(id),
      factura_id INTEGER REFERENCES facturas(id),
      metodo_pago TEXT NOT NULL DEFAULT 'TRANSFERENCIA',
      estado TEXT NOT NULL DEFAULT 'CONCILIADO', -- CONCILIADO, PENDIENTE
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS conversaciones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cliente_telefono TEXT NOT NULL UNIQUE,
      cliente_nombre TEXT NOT NULL,
      ultimo_mensaje TEXT,
      no_leidos INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS mensajes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversacion_id INTEGER NOT NULL REFERENCES conversaciones(id) ON DELETE CASCADE,
      remitente TEXT NOT NULL, -- CLIENTE, BOT, ADMIN
      texto TEXT NOT NULL,
      media_url TEXT,
      fecha TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      estado TEXT NOT NULL DEFAULT 'ENVIADO'
    );

    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      num_doc TEXT DEFAULT '', -- Cédula de identidad para vinculación con bot
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      rol TEXT NOT NULL DEFAULT 'ADMIN', -- 'ADMIN', 'VENDEDOR', 'CAJERO'
      email TEXT,
      telefono TEXT,
      telegram_chat_id TEXT DEFAULT '',
      telegram_username TEXT DEFAULT '',
      activo INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    -- CUPONES DE DESCUENTO
    CREATE TABLE IF NOT EXISTS cupones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT UNIQUE NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'PORCENTAJE', -- 'PORCENTAJE', 'FIJO'
      valor REAL NOT NULL, -- Ej: 20 (para 20%) o 5.00 (para $5)
      minimo_compra REAL NOT NULL DEFAULT 0,
      usos_max INTEGER DEFAULT 0, -- 0 = ilimitado
      usos_actuales INTEGER NOT NULL DEFAULT 0,
      activo INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    -- PROVEEDORES (COMPRAS & MERCADERÍA)
    CREATE TABLE IF NOT EXISTS proveedores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      razon_social TEXT NOT NULL,
      ruc_cedula TEXT NOT NULL UNIQUE,
      telefono TEXT,
      email TEXT,
      direccion TEXT,
      contacto_nombre TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    -- COMPRAS A PROVEEDORES
    CREATE TABLE IF NOT EXISTS compras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero_factura TEXT NOT NULL, -- No. factura del proveedor
      proveedor_id INTEGER REFERENCES proveedores(id),
      proveedor_nombre TEXT NOT NULL,
      fecha TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      subtotal REAL NOT NULL DEFAULT 0,
      iva REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      metodo_pago TEXT NOT NULL DEFAULT 'TRANSFERENCIA',
      estado TEXT NOT NULL DEFAULT 'RECIBIDO', -- 'RECIBIDO', 'PENDIENTE', 'ANULADO'
      notas TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    -- DETALLE DE COMPRAS
    CREATE TABLE IF NOT EXISTS compra_detalles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      compra_id INTEGER NOT NULL REFERENCES compras(id) ON DELETE CASCADE,
      producto_id INTEGER NOT NULL REFERENCES productos(id),
      producto_nombre TEXT NOT NULL,
      talla TEXT DEFAULT 'Única',
      cantidad INTEGER NOT NULL,
      costo_unitario REAL NOT NULL,
      subtotal REAL NOT NULL
    );

    -- KARDEX DE MOVIMIENTOS DE INVENTARIO
    CREATE TABLE IF NOT EXISTS kardex (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      producto_id INTEGER NOT NULL REFERENCES productos(id),
      producto_nombre TEXT NOT NULL,
      tipo_movimiento TEXT NOT NULL, -- 'COMPRA_ENTRADA', 'VENTA_SALIDA', 'AJUSTE_ENTRADA', 'AJUSTE_SALIDA', 'DEVOLUCION'
      cantidad INTEGER NOT NULL,
      stock_anterior INTEGER NOT NULL,
      stock_actual INTEGER NOT NULL,
      costo_unitario REAL NOT NULL DEFAULT 0,
      precio_unitario REAL NOT NULL DEFAULT 0,
      referencia_doc TEXT,
      motivo TEXT,
      fecha TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    -- BANNERS DE LA TIENDA ONLINE
    CREATE TABLE IF NOT EXISTS banners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      posicion TEXT NOT NULL DEFAULT 'PROMO_CENTRAL', -- 'TOP_BAR', 'HERO_HEADER', 'PROMO_CENTRAL'
      titulo TEXT NOT NULL,
      subtitulo TEXT,
      badge TEXT,
      boton_texto TEXT,
      boton_link TEXT,
      codigo_cupon TEXT,
      color_fondo TEXT DEFAULT '#3B2A30',
      color_texto TEXT DEFAULT '#FFFFFF',
      imagen_url TEXT,
      activo INTEGER NOT NULL DEFAULT 1,
      orden INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
  `);

  // Migraciones seguras para columnas de tallas y logística Servientrega
  try { db.exec(`ALTER TABLE productos ADD COLUMN tallas TEXT DEFAULT '{}';`); } catch(e) {}
  try { db.exec(`ALTER TABLE pedido_items ADD COLUMN talla TEXT DEFAULT '';`); } catch(e) {}
  try { db.exec(`ALTER TABLE factura_items ADD COLUMN talla TEXT DEFAULT '';`); } catch(e) {}

  // Columnas para vinculación de usuarios y Telegram
  try { db.exec(`ALTER TABLE usuarios ADD COLUMN num_doc TEXT DEFAULT '';`); } catch(e) {}
  try { db.exec(`ALTER TABLE usuarios ADD COLUMN telegram_chat_id TEXT DEFAULT '';`); } catch(e) {}
  try { db.exec(`ALTER TABLE usuarios ADD COLUMN telegram_username TEXT DEFAULT '';`); } catch(e) {}

  // Columnas para despacho y guía Servientrega Ecuador
  try { db.exec(`ALTER TABLE pedidos ADD COLUMN provincia TEXT DEFAULT '';`); } catch(e) {}
  try { db.exec(`ALTER TABLE pedidos ADD COLUMN ciudad TEXT DEFAULT '';`); } catch(e) {}
  try { db.exec(`ALTER TABLE pedidos ADD COLUMN tipo_entrega TEXT DEFAULT 'DOMICILIO';`); } catch(e) {}
  try { db.exec(`ALTER TABLE pedidos ADD COLUMN calle_principal TEXT DEFAULT '';`); } catch(e) {}
  try { db.exec(`ALTER TABLE pedidos ADD COLUMN calle_secundaria TEXT DEFAULT '';`); } catch(e) {}
  try { db.exec(`ALTER TABLE pedidos ADD COLUMN numero_casa TEXT DEFAULT '';`); } catch(e) {}
  try { db.exec(`ALTER TABLE pedidos ADD COLUMN referencia TEXT DEFAULT '';`); } catch(e) {}
  try { db.exec(`ALTER TABLE pedidos ADD COLUMN agencia_servientrega TEXT DEFAULT '';`); } catch(e) {}
  try { db.exec(`ALTER TABLE pedidos ADD COLUMN gps_lat REAL;`); } catch(e) {}
  try { db.exec(`ALTER TABLE pedidos ADD COLUMN gps_lng REAL;`); } catch(e) {}
  try { db.exec(`ALTER TABLE pedidos ADD COLUMN gps_maps_url TEXT;`); } catch(e) {}

  // Sembrar usuario administrador inicial si no existe
  try {
    const checkAdmin = db.prepare(`SELECT id FROM usuarios WHERE username = 'admin'`).get();
    if (!checkAdmin) {
      db.prepare(`
        INSERT INTO usuarios (nombre, num_doc, username, password, rol, email, telefono, activo)
        VALUES ('Stuart - Administrador Principal', '0999999999', 'admin', 'admin123', 'ADMIN', 'admin@rsstore.ec', '0991234567', 1)
      `).run();
    } else {
      // Asegurar que admin tenga cédula asignada
      db.prepare(`UPDATE usuarios SET num_doc = '0999999999' WHERE username = 'admin' AND (num_doc IS NULL OR num_doc = '')`).run();
    }
  } catch(e) {}

  // Inicializar tallas en productos existentes si aún no tienen
  const prodsSinTallas = db.prepare(`SELECT id, cat, stock, tallas FROM productos WHERE tallas IS NULL OR tallas = '' OR tallas = '{}'`).all();
  for (const p of prodsSinTallas) {
    let tObj = {};
    const s = p.stock || 0;
    if (p.cat === 'ropa') {
      const s1 = Math.floor(s / 3);
      const s2 = Math.floor(s / 3);
      const s3 = s - s1 - s2;
      tObj = { 'S': s1, 'M': s2, 'L': s3 };
    } else if (p.cat === 'calzado') {
      const s1 = Math.floor(s / 3);
      const s2 = Math.floor(s / 3);
      const s3 = s - s1 - s2;
      tObj = { '36': s1, '37': s2, '38': s3 };
    } else {
      tObj = { 'Única': s };
    }
    db.prepare(`UPDATE productos SET tallas = ? WHERE id = ?`).run(JSON.stringify(tObj), p.id);
  }

  // Seed default configuration
  const insertConfigOrIgnore = db.prepare(`INSERT OR IGNORE INTO configuracion (clave, valor, descripcion) VALUES (?, ?, ?)`);
  const defaults = [
    ['nombre_tienda', 'RS Store', 'Nombre de fantasía de la tienda'],
    ['slogan', 'ROPA · ESTILO · TÚ', 'Lema comercial'],
    ['ruc_emisor', '0992345678001', 'RUC de la empresa emisora'],
    ['razon_social', 'RS STORE BOUTIQUE S.A.S.', 'Razón Social oficial ante el SRI'],
    ['direccion_matriz', 'Av. 9 de Octubre 1200 y Malecón, Guayaquil, Ecuador', 'Dirección Matriz'],
    ['establecimiento', '001', 'Código de Establecimiento (3 dígitos)'],
    ['punto_emision', '001', 'Punto de emisión de facturas (3 dígitos)'],
    ['secuencial_actual', '150', 'Próximo secuencial numérico de factura'],
    ['porcentaje_iva', '15.00', 'Porcentaje de IVA legal en Ecuador'],
    ['tipo_contribuyente', 'REGIMEN_GENERAL', 'Régimen Tributario SRI: REGIMEN_GENERAL, RIMPE_POPULAR, RIMPE_EMPRENDEDOR, CONTRIBUYENTE_ESPECIAL'],
    ['leyenda_contribuyente', '', 'Leyenda obligatoria a imprimir en comprobantes RIDE y XML'],
    ['resolucion_contribuyente', '', 'Número de resolución del SRI si es contribuyente especial o agente retención'],
    ['ciudad_matriz', 'Guayas', 'Provincia matriz donde está la tienda para cálculo de envío local'],
    ['tarifa_envio_local', '3.00', 'Tarifa de Servientrega local (Provincia matriz)'],
    ['tarifa_envio_nacional', '5.50', 'Tarifa de Servientrega nacional (Otras provincias)'],
    ['tarifa_envio_especial', '8.50', 'Tarifa de Servientrega especial (Galápagos y Oriente lejano)'],
    ['envio_gratis_desde', '50.00', 'Monto mínimo para envío gratuito'],
    ['costo_envio_base', '4.50', 'Costo de envío estándar'],
    ['telefono_contacto', process.env.WHATSAPP_PHONE || '+593968433458', 'Teléfono de contacto / WhatsApp Business'],
    ['email_contacto', 'ventas@rsstore.ec', 'Email de atención y facturación'],
    ['bot_activo', '1', 'Estado activo del bot de WhatsApp (1 o 0)'],
    ['bot_bienvenida', '¡Hola! Bienvenida a RS Store Boutique. ¿En qué podemos ayudarte hoy? Escribe *catálogo*, *precios* o *envíos*.', 'Mensaje de bienvenida'],
    ['banco_nombre', 'Banco Pichincha', 'Banco principal de la tienda'],
    ['banco_tipo_cuenta', 'Cuenta Corriente', 'Tipo de cuenta bancaria'],
    ['banco_numero_cuenta', '2100876543', 'Número de cuenta para recibir transferencias'],
    ['banco_titular', 'RS STORE BOUTIQUE S.A.S.', 'Nombre del titular de la cuenta bancaria'],
    ['banco_identificacion', '0992345678001', 'RUC o Cédula del titular bancario'],
    ['banco_email', 'pagos@rsstore.ec', 'Correo para notificación de transferencias'],
    ['telegram_bot_token', process.env.TELEGRAM_BOT_TOKEN || '8842570395:AAHeIO1VJq8HHFZU4C3xhOq1uulFQjGnWHw', 'Token del Bot de Telegram para Administradores'],
    ['telegram_chat_id', process.env.TELEGRAM_CHAT_ID || '5857562616', 'Chat ID de Telegram del Administrador'],
    ['telegram_activo', '1', 'Activar notificaciones de pedidos por Telegram (1 o 0)'],
    ['banner_hero_img', 'https://images.unsplash.com/photo-1490481651871-ab68de25d43d?auto=format&fit=crop&w=1000&q=85', 'Imagen de Portada Principal Hero'],
    ['smtp_host', 'smtp.gmail.com', 'Servidor SMTP para envío de correos'],
    ['smtp_port', '465', 'Puerto SMTP (465 SSL o 587 TLS)'],
    ['smtp_user', '', 'Usuario o Correo del servidor SMTP'],
    ['smtp_pass', '', 'Contraseña o App Password del servidor SMTP'],
    ['smtp_from', 'RS Store Facturación <ventas@rsstore.ec>', 'Remitente visible de correos'],
    ['smtp_activo', '0', 'Activar envío de comprobantes RIDE/XML por correo (1 o 0)'],
    ['social_instagram', 'https://instagram.com/rsstore', 'Enlace a Instagram de la tienda'],
    ['social_tiktok', 'https://tiktok.com/@rsstore', 'Enlace a TikTok de la tienda'],
    ['social_facebook', 'https://facebook.com/rsstore', 'Enlace a Facebook de la tienda'],
    ['social_whatsapp', process.env.WHATSAPP_NUMBER || '593968433458', 'Número de WhatsApp para contacto directo']
  ];
  for (const [k, v, d] of defaults) {
    insertConfigOrIgnore.run(k, v, d);
  }

  // Garantizar que configuraciones críticas no queden vacías si ya existía la fila
  try {
    const curToken = db.prepare("SELECT valor FROM configuracion WHERE clave = 'telegram_bot_token'").get();
    if (!curToken || !curToken.valor || !curToken.valor.trim()) {
      db.prepare("UPDATE configuracion SET valor = '8842570395:AAHeIO1VJq8HHFZU4C3xhOq1uulFQjGnWHw' WHERE clave = 'telegram_bot_token'").run();
      db.prepare("UPDATE configuracion SET valor = '1' WHERE clave = 'telegram_activo'").run();
    }
    const curChat = db.prepare("SELECT valor FROM configuracion WHERE clave = 'telegram_chat_id'").get();
    if (!curChat || !curChat.valor || !curChat.valor.trim()) {
      db.prepare("UPDATE configuracion SET valor = '5857562616' WHERE clave = 'telegram_chat_id'").run();
    }
    const curWa = db.prepare("SELECT valor FROM configuracion WHERE clave = 'social_whatsapp'").get();
    if (!curWa || !curWa.valor || !curWa.valor.trim() || curWa.valor.includes('991234567')) {
      db.prepare("UPDATE configuracion SET valor = '593968433458' WHERE clave = 'social_whatsapp'").run();
      db.prepare("UPDATE configuracion SET valor = '+593968433458' WHERE clave = 'telefono_contacto'").run();
    }
    db.prepare(`
      UPDATE usuarios 
      SET telegram_chat_id = '5857562616', telegram_username = 'Steven', num_doc = '0942610361'
      WHERE username = 'admin' AND (telegram_chat_id IS NULL OR telegram_chat_id = '')
    `).run();
  } catch(e) {}

  // Seed cupones if empty
  const countCupones = db.prepare(`SELECT COUNT(*) as count FROM cupones`).get();
  if (countCupones.count === 0) {
    db.prepare(`
      INSERT INTO cupones (codigo, tipo, valor, minimo_compra, usos_max, activo)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run('RSSTYLE20', 'PORCENTAJE', 20.00, 0, 0);
    db.prepare(`
      INSERT INTO cupones (codigo, tipo, valor, minimo_compra, usos_max, activo)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run('BIENVENIDA5', 'FIJO', 5.00, 25.00, 0);
  }

  // Seed proveedores if empty
  const countProv = db.prepare(`SELECT COUNT(*) as count FROM proveedores`).get();
  if (countProv.count === 0) {
    db.prepare(`
      INSERT INTO proveedores (razon_social, ruc_cedula, telefono, email, direccion, contacto_nombre)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('Confecciones Textiles del Guayas S.A.', '0991234567001', '042123456', 'ventas@textilesguayas.ec', 'Parque Industrial Km 11.5 Vía a Daule, Guayaquil', 'Ing. Roberto Méndez');
    db.prepare(`
      INSERT INTO proveedores (razon_social, ruc_cedula, telefono, email, direccion, contacto_nombre)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('Importadora de Accesorios & Bisutería del Pacífico', '1792345678001', '0998765432', 'pedidos@accesoriospacifico.com', 'Av. Juan Tanca Marengo, Guayaquil', 'Lic. Mariana Cruz');
  }

  // Seed default Consumidor Final client if empty
  const countClients = db.prepare(`SELECT COUNT(*) as count FROM clientes`).get();
  if (countClients.count === 0) {
    const insertClient = db.prepare(`
      INSERT INTO clientes (tipo_doc, num_doc, razon_social, email, telefono, direccion)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertClient.run('CONSUMIDOR_FINAL', '9999999999999', 'CONSUMIDOR FINAL', 'consumidor@rsstore.ec', '0999999999', 'Guayaquil, Ecuador');
    insertClient.run('CEDULA', '0923456789', 'Andrea Sofía Morales', 'andrea.morales@example.com', '0987654321', 'Urdesa Central, Guayaquil');
  }

  // Seed products if empty
  const countProd = db.prepare(`SELECT COUNT(*) as count FROM productos`).get();
  if (countProd.count === 0) {
    const insertProd = db.prepare(`
      INSERT INTO productos (name, cat, price, was_price, stock, desc, visible, is_new, badge, img)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const defaultProds = [
      ['Aretes Lucía', 'accesorios', 12.90, 16.10, 24, 'Baño de oro de 18k, diseño geométrico y livianos para el uso diario.', 1, 0, 'sale', 'https://images.unsplash.com/photo-1630019852942-f89202989a59?auto=format&fit=crop&w=800&q=85'],
      ['Bolso Mimosa', 'accesorios', 34.50, null, 12, 'Tote mediano en semicuero texturizado, incluye correa ajustable y forro.', 1, 0, '', 'https://images.unsplash.com/photo-1590874103328-eac38a683ce7?auto=format&fit=crop&w=800&q=85'],
      ['Blusa Brisa', 'ropa', 26.00, null, 18, 'Viscosa fresca, escote suave y corte suelto ideal para clima cálido.', 1, 1, 'nuevo', 'https://images.unsplash.com/photo-1618244972963-dbee1a7edc95?auto=format&fit=crop&w=800&q=85'],
      ['Vestido Aurora', 'ropa', 45.90, 57.40, 8, 'Vestido midi con vuelo, forro interior y textura fluida.', 1, 0, 'sale', 'https://images.unsplash.com/photo-1595777457583-95e059d581b8?auto=format&fit=crop&w=800&q=85'],
      ['Sandalias Nube', 'calzado', 29.90, null, 15, 'Plantilla confort acolchada y tiras suaves en tono arena.', 1, 0, '', 'https://images.unsplash.com/photo-1543163521-1bf539c55dd2?auto=format&fit=crop&w=800&q=85'],
      ['Sérum Pétalo', 'belleza', 18.75, null, 30, 'Ácido hialurónico + niacinamida. Fórmula hidratante para piel luminosa.', 1, 1, 'nuevo', 'https://images.unsplash.com/photo-1620916566398-39f1143ab7be?auto=format&fit=crop&w=800&q=85'],
      ['Vela Jardín', 'hogar', 14.50, null, 20, 'Cera de soya natural, fragancia a jazmín y flor de naranja. 40h de aroma.', 1, 0, '', 'https://images.unsplash.com/photo-1603006905003-be475563bc59?auto=format&fit=crop&w=800&q=85'],
      ['Set Regalo Dulce', 'regalos', 39.00, 48.75, 10, 'Set especial que incluye aretes, vela aromática y caja decorativa.', 1, 0, 'sale', 'https://images.unsplash.com/photo-1549465220-1a8b9238cd48?auto=format&fit=crop&w=800&q=85']
    ];
    for (const p of defaultProds) {
      insertProd.run(...p);
    }
  }

  // Seed WhatsApp bot replies if empty
  const countBot = db.prepare(`SELECT COUNT(*) as count FROM bot_respuestas`).get();
  if (countBot.count === 0) {
    const insertBot = db.prepare(`INSERT INTO bot_respuestas (keyword, response) VALUES (?, ?)`);
    insertBot.run('catalogo', 'Tenemos colecciones en: *Accesorios*, *Ropa*, *Calzado*, *Belleza*, *Hogar* y *Regalos*. Puedes ver todo en nuestra tienda online.');
    insertBot.run('precios', 'Nuestros precios van desde $12.90 en accesorios y todos los valores ya incluyen IVA (15%). ¿Buscas alguna prenda en especial?');
    insertBot.run('envios', 'Realizamos envíos a todo Ecuador por Servientrega (24 a 48 h). ¡Envío GRATIS en pedidos desde $50!');
    insertBot.run('retiro', 'Puedes retirar tu compra sin costo en nuestro local de Guayaquil.');
  }

  // Seed banners if empty
  const countBanners = db.prepare(`SELECT COUNT(*) as count FROM banners`).get();
  if (countBanners.count === 0) {
    const insertBanner = db.prepare(`
      INSERT INTO banners (posicion, titulo, subtitulo, badge, boton_texto, boton_link, codigo_cupon, color_fondo, color_texto, activo, orden)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    // Top Bar
    insertBanner.run(
      'TOP_BAR',
      '🚚 Envíos seguros a todo el Ecuador por Servientrega | ¡20% OFF en tu compra usando el cupón RSSTYLE20!',
      '',
      'OFERTA',
      'Comprar Ahora',
      '#coleccion',
      'RSSTYLE20',
      '#882F50',
      '#FFFFFF',
      1,
      1
    );
    // Promo Central Banner (Captura 2)
    insertBanner.run(
      'PROMO_CENTRAL',
      '-20% en tu primera compra',
      'Aplica el código en tu compra online o menciónalo en caja al facturar en nuestro local de Guayaquil.',
      'DESCUENTO ESPECIAL',
      'Ver Productos',
      '#coleccion',
      'RSSTYLE20',
      '#3B2A30',
      '#FFFFFF',
      1,
      2
    );
  }

  // Migraciones de columnas para compatibilidad
  try {
    const cols = db.prepare(`PRAGMA table_info(productos)`).all().map(c => c.name);
    if (!cols.includes('images')) {
      db.exec(`ALTER TABLE productos ADD COLUMN images TEXT DEFAULT '[]';`);
    }
    if (!cols.includes('genero')) {
      db.exec(`ALTER TABLE productos ADD COLUMN genero TEXT DEFAULT 'MUJER';`);
    }
    if (!cols.includes('tallas')) {
      db.exec(`ALTER TABLE productos ADD COLUMN tallas TEXT DEFAULT '{}';`);
    }
  } catch (err) {
    console.error('Error migrando columnas en productos:', err.message);
  }
}

initSchema();

module.exports = { db };
