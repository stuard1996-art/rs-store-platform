const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const PLATFORM_SECRET = process.env.PLATFORM_SECRET || 'rs-saas-platform-secret-key-2026';
const databaseDir = path.join(__dirname);
const tenantsDir = path.join(databaseDir, 'tenants');
const masterDbPath = path.join(databaseDir, 'master.sqlite');

if (!fs.existsSync(tenantsDir)) {
  fs.mkdirSync(tenantsDir, { recursive: true });
}

// Master Database instance
const masterDb = new DatabaseSync(masterDbPath);
masterDb.exec(`PRAGMA foreign_keys = ON;`);
masterDb.exec(`PRAGMA journal_mode = WAL;`);

// In-memory cache for open tenant DB connections
const tenantDbCache = new Map();

const RUBRO_PRESETS = {
  MODA: {
    id: 'MODA',
    nombre: 'Moda & Ropa Boutique',
    icono: '👗',
    slogan: 'ROPA · ESTILO · TÚ',
    color_primario: '#A8324E',
    color_secundario: '#7B113A',
    color_suave: '#FAF5F6',
    hero_titulo: 'Ropa y accesorios con <em>estilo propio.</em>',
    hero_subtitulo: 'Prendas, calzado, belleza y detalles elegidos uno por uno. Calidad garantizada, facturación electrónica legal y envíos a todo Ecuador.',
    hero_imagen: 'https://images.unsplash.com/photo-1490481651871-ab68de25d43d?auto=format&fit=crop&w=1000&q=85',
    categorias: ['Mujer', 'Hombre', 'Calzado', 'Belleza & Accesorios', 'Ofertas']
  },
  JOYERIA: {
    id: 'JOYERIA',
    nombre: 'Joyería, Relojes & Accesorios Finos',
    icono: '💎',
    slogan: 'BRILLO · ELEGANCIA · EXCLUSIVIDAD',
    color_primario: '#9D174D',
    color_secundario: '#831843',
    color_suave: '#FDF2F8',
    hero_titulo: 'Joyas y accesorios que <em>resaltan tu esencia.</em>',
    hero_subtitulo: 'Diseños exclusivos en plata 925, oro laminado, acero inoxidable y pedrería fina. Calidad garantizada y envíos seguros a todo Ecuador.',
    hero_imagen: 'https://images.unsplash.com/photo-1599643478518-a784e5dc4c8f?auto=format&fit=crop&w=1000&q=85',
    categorias: ['Collares', 'Pulseras', 'Anillos', 'Aretes', 'Relojes', 'Dijes', 'Sets de Regalo']
  },
  TECNOLOGIA: {
    id: 'TECNOLOGIA',
    nombre: 'Tecnología, Computación & Celulares',
    icono: '💻',
    slogan: 'INNOVACIÓN · RENDIMIENTO · GARANTÍA',
    color_primario: '#2563EB',
    color_secundario: '#1D4ED8',
    color_suave: '#EFF6FF',
    hero_titulo: 'Tecnología y dispositivos al <em>mejor precio del mercado.</em>',
    hero_subtitulo: 'Equipos de alta gama, laptops, smartphones, audio y periféricos con garantía oficial, servicio técnico y envíos express a todo el país.',
    hero_imagen: 'https://images.unsplash.com/photo-1519389950473-47ba0277781c?auto=format&fit=crop&w=1000&q=85',
    categorias: ['Laptops', 'Celulares', 'Audio & Audífonos', 'Gaming', 'Accesorios PC', 'Smartwatches']
  },
  CALZADO: {
    id: 'CALZADO',
    nombre: 'Calzado, Zapatos & Sneakers',
    icono: '👟',
    slogan: 'CONFORT · ESTILO · DURABILIDAD',
    color_primario: '#D97706',
    color_secundario: '#B45309',
    color_suave: '#FFFBEB',
    hero_titulo: 'Calzado diseñado para <em>acompañar cada paso.</em>',
    hero_subtitulo: 'Zapatos deportivos, casuales y formales para toda la familia. Diseños anatómicos, máximo confort y acabados de primera calidad.',
    hero_imagen: 'https://images.unsplash.com/photo-1549298916-b41d501d3772?auto=format&fit=crop&w=1000&q=85',
    categorias: ['Deportivo & Running', 'Casual & Sneakers', 'Formal & Cuero', 'Sandalias', 'Botas']
  },
  BELLEZA: {
    id: 'BELLEZA',
    nombre: 'Belleza, Cosméticos & Cuidado Personal',
    icono: '💄',
    slogan: 'CUIDADO · BELLEZA · BIENESTAR',
    color_primario: '#DB2777',
    color_secundario: '#BE185D',
    color_suave: '#FDF2F8',
    hero_titulo: 'Cosméticos y cuidado facial para <em>tu rutina diaria.</em>',
    hero_subtitulo: 'Productos dermatológicamente comprobados, maquillaje profesional, fragancias exclusivas y cuidado capilar con entrega inmediata.',
    hero_imagen: 'https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=1000&q=85',
    categorias: ['Skincare Facial', 'Maquillaje', 'Fragancias', 'Cuidado Capilar', 'Tratamientos']
  },
  ALIMENTOS: {
    id: 'ALIMENTOS',
    nombre: 'Alimentos, Bebidas & Delicatessen',
    icono: '🍕',
    slogan: 'SABOR · FRESCURA · CALIDAD',
    color_primario: '#EA580C',
    color_secundario: '#C2410C',
    color_suave: '#FFF7ED',
    hero_titulo: 'Sabores seleccionados preparados con <em>ingredientes frescos.</em>',
    hero_subtitulo: 'Disfruta de la mejor selección de productos gourmet, café de especialidad, postres y bebidas entregadas directamente en tu puerta.',
    hero_imagen: 'https://images.unsplash.com/photo-1504674900247-0877df9cc836?auto=format&fit=crop&w=1000&q=85',
    categorias: ['Café & Bebidas', 'Gourmet & Snacks', 'Postres', 'Combos Especiales', 'Salados']
  },
  GENERAL: {
    id: 'GENERAL',
    nombre: 'Tienda General / Multirubro',
    icono: '🛒',
    slogan: 'VARIEDAD · CALIDAD · ATENCIÓN',
    color_primario: '#0D9488',
    color_secundario: '#0F766E',
    color_suave: '#F0FDFA',
    hero_titulo: 'Los mejores productos para <em>tu hogar y estilo de vida.</em>',
    hero_subtitulo: 'Encuentra variedad, precios justos, atención personalizada y entregas rápidas y garantizadas en todo el territorio nacional.',
    hero_imagen: 'https://images.unsplash.com/photo-1472851294608-062f824d29cc?auto=format&fit=crop&w=1000&q=85',
    categorias: ['Hogar & Deco', 'Tecnología', 'Cuidado Personal', 'Novedades', 'Ofertas']
  }
};

/**
 * Initialize Master Database Schema
 */
function initMasterSchema() {
  masterDb.exec(`
    CREATE TABLE IF NOT EXISTS empresas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      nombre_comercial TEXT NOT NULL,
      razon_social TEXT DEFAULT '',
      ruc TEXT DEFAULT '',
      dominio_personalizado TEXT DEFAULT '',
      provincia_matriz TEXT DEFAULT 'Guayas',
      ciudad_matriz TEXT DEFAULT 'Guayaquil',
      ciudades_zona_local TEXT DEFAULT 'Guayaquil, Samborondón, Durán, Daule',
      email_contacto TEXT DEFAULT '',
      telefono_contacto TEXT DEFAULT '',
      estado TEXT DEFAULT 'ACTIVA', -- 'ACTIVA', 'SUSPENDIDA', 'EXPIRADA'
      licencia_tipo TEXT DEFAULT 'ANUAL', -- 'MENSUAL', 'ANUAL', 'VITALICIA', 'PRUEBA'
      licencia_inicio TEXT NOT NULL,
      licencia_fin TEXT NOT NULL,
      licencia_clave TEXT DEFAULT '',
      notas TEXT DEFAULT '',
      rubro TEXT DEFAULT 'MODA',
      slogan TEXT DEFAULT '',
      color_primario TEXT DEFAULT '#A8324E',
      color_secundario TEXT DEFAULT '#7B113A',
      color_suave TEXT DEFAULT '#FAF5F6',
      hero_titulo TEXT DEFAULT '',
      hero_subtitulo TEXT DEFAULT '',
      hero_imagen TEXT DEFAULT '',
      categorias TEXT DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
  `);

  // Migration for existing table columns
  const tableInfo = masterDb.prepare("PRAGMA table_info(empresas)").all();
  const existingCols = new Set(tableInfo.map(c => c.name));
  
  const colsToAdd = [
    ['rubro', "TEXT DEFAULT 'MODA'"],
    ['slogan', "TEXT DEFAULT ''"],
    ['color_primario', "TEXT DEFAULT '#A8324E'"],
    ['color_secundario', "TEXT DEFAULT '#7B113A'"],
    ['color_suave', "TEXT DEFAULT '#FAF5F6'"],
    ['hero_titulo', "TEXT DEFAULT ''"],
    ['hero_subtitulo', "TEXT DEFAULT ''"],
    ['hero_imagen', "TEXT DEFAULT ''"],
    ['categorias', "TEXT DEFAULT '[]'"]
  ];

  for (const [colName, colDef] of colsToAdd) {
    if (!existingCols.has(colName)) {
      try {
        masterDb.exec(`ALTER TABLE empresas ADD COLUMN ${colName} ${colDef};`);
      } catch (e) {}
    }
  }

  // Ensure 'rs-store' is registered as company #1 (Matriz con licencia vitalicia)
  const existingRs = masterDb.prepare("SELECT * FROM empresas WHERE slug = 'rs-store'").get();
  if (!existingRs) {
    const now = new Date();
    const future = new Date();
    future.setFullYear(now.getFullYear() + 50); // Licencia vitalicia para RS Store
    const p = RUBRO_PRESETS.MODA;

    masterDb.prepare(`
      INSERT INTO empresas (
        slug, nombre_comercial, razon_social, ruc, dominio_personalizado,
        provincia_matriz, ciudad_matriz, ciudades_zona_local,
        email_contacto, telefono_contacto, estado, licencia_tipo,
        licencia_inicio, licencia_fin, notas,
        rubro, slogan, color_primario, color_secundario, color_suave,
        hero_titulo, hero_subtitulo, hero_imagen, categorias
      ) VALUES (
        'rs-store', 'RS Store', 'RS STORE BOUTIQUE S.A.S.', '0992345678001', '',
        'Guayas', 'Guayaquil', 'Guayaquil, Samborondón, Durán, Daule',
        'ventas@rsstore.ec', '+593968433458', 'ACTIVA', 'VITALICIA',
        ?, ?, 'Empresa matriz original',
        'MODA', ?, ?, ?, ?,
        ?, ?, ?, ?
      )
    `).run(
      now.toISOString().split('T')[0], future.toISOString().split('T')[0],
      p.slogan, p.color_primario, p.color_secundario, p.color_suave,
      p.hero_titulo, p.hero_subtitulo, p.hero_imagen, JSON.stringify(p.categorias)
    );
  }

  // Update existing tenants with their industry presets if missing
  const applyPreset = (slug, rubroKey, customName) => {
    const row = masterDb.prepare("SELECT * FROM empresas WHERE slug = ?").get(slug);
    if (row && (!row.slogan || !row.hero_titulo || row.rubro !== rubroKey)) {
      const p = RUBRO_PRESETS[rubroKey] || RUBRO_PRESETS.GENERAL;
      masterDb.prepare(`
        UPDATE empresas SET
          rubro = ?,
          slogan = ?,
          color_primario = ?,
          color_secundario = ?,
          color_suave = ?,
          hero_titulo = ?,
          hero_subtitulo = ?,
          hero_imagen = ?,
          categorias = ?
        WHERE slug = ?
      `).run(
        rubroKey,
        p.slogan,
        p.color_primario,
        p.color_secundario,
        p.color_suave,
        p.hero_titulo,
        p.hero_subtitulo,
        p.hero_imagen,
        JSON.stringify(p.categorias),
        slug
      );
    }
  };

  applyPreset('jannella', 'JOYERIA');
  applyPreset('editec', 'TECNOLOGIA');
  applyPreset('rs-store', 'MODA');
  applyPreset('zapateria-el-sol', 'CALZADO');

  // Ensure rs-store.sqlite file exists in tenants folder (copiar del original si falta)
  const rsTenantDbFile = path.join(tenantsDir, 'rs-store.sqlite');
  const originalDbFile = path.join(databaseDir, 'rs_store.sqlite');
  if (!fs.existsSync(rsTenantDbFile) && fs.existsSync(originalDbFile)) {
    try {
      fs.copyFileSync(originalDbFile, rsTenantDbFile);
    } catch (e) {
      console.error('Error copiando rs_store.sqlite a tenants/rs-store.sqlite:', e);
    }
  }
}

initMasterSchema();

/**
 * Generate a cryptographically signed license activation key
 * Format: LIC-{SLUG}-{YYYYMMDD}-{HASH16}
 */
function generateLicenseKey(slug, expiryDateString) {
  const cleanSlug = slug.trim().toLowerCase();
  const dateFormatted = expiryDateString.replace(/-/g, '').substring(0, 8);
  const payload = `${cleanSlug}|${dateFormatted}`;
  const signature = crypto.createHmac('sha256', PLATFORM_SECRET)
    .update(payload)
    .digest('hex')
    .substring(0, 16)
    .toUpperCase();
  return `LIC-${cleanSlug.toUpperCase()}-${dateFormatted}-${signature}`;
}

/**
 * Validate an offline/online license activation key
 */
function validateLicenseKey(slug, key) {
  if (!key || typeof key !== 'string') return { valid: false, reason: 'Clave vacía' };
  const parts = key.trim().split('-');
  if (parts.length < 4 || parts[0] !== 'LIC') {
    return { valid: false, reason: 'Formato de clave inválido' };
  }
  const keySig = parts[parts.length - 1].toUpperCase();
  const keyDate = parts[parts.length - 2];
  const keySlug = parts.slice(1, parts.length - 2).join('-').toLowerCase();

  if (keySlug !== slug.trim().toLowerCase()) {
    return { valid: false, reason: 'Esta clave no pertenece a esta empresa' };
  }

  const expectedSig = crypto.createHmac('sha256', PLATFORM_SECRET)
    .update(`${keySlug}|${keyDate}`)
    .digest('hex')
    .substring(0, 16)
    .toUpperCase();

  if (keySig !== expectedSig) {
    return { valid: false, reason: 'Firma criptográfica de licencia no válida' };
  }

  const y = parseInt(keyDate.substring(0, 4), 10);
  const m = parseInt(keyDate.substring(4, 6), 10) - 1;
  const d = parseInt(keyDate.substring(6, 8), 10);
  const expiryDate = new Date(y, m, d, 23, 59, 59);

  return {
    valid: true,
    expiryDate: expiryDate.toISOString().split('T')[0],
    isExpired: new Date() > expiryDate
  };
}

/**
 * Initialize table schema and initial data on any SQLite database
 */
function initSchemaOnDb(targetDb, companyInfo = {}) {
  targetDb.exec(`PRAGMA foreign_keys = ON;`);
  targetDb.exec(`PRAGMA journal_mode = WAL;`);

  targetDb.exec(`
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
      tipo_doc TEXT NOT NULL,
      num_doc TEXT NOT NULL,
      razon_social TEXT NOT NULL,
      email TEXT,
      telefono TEXT,
      direccion TEXT,
      password_hash TEXT DEFAULT '',
      google_id TEXT DEFAULT '',
      avatar_url TEXT DEFAULT '',
      auth_provider TEXT DEFAULT 'LOCAL',
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
      estado TEXT NOT NULL DEFAULT 'PENDIENTE',
      requiere_factura INTEGER NOT NULL DEFAULT 0,
      direccion_envio TEXT,
      ciudad_envio TEXT,
      provincia TEXT DEFAULT '',
      ciudad TEXT DEFAULT '',
      tipo_entrega TEXT DEFAULT 'DOMICILIO',
      calle_principal TEXT DEFAULT '',
      calle_secundaria TEXT DEFAULT '',
      numero_casa TEXT DEFAULT '',
      referencia TEXT DEFAULT '',
      agencia_servientrega TEXT DEFAULT '',
      gps_lat REAL,
      gps_lng REAL,
      gps_maps_url TEXT,
      notas TEXT,
      fecha TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS pedido_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
      producto_id INTEGER REFERENCES productos(id),
      producto_nombre TEXT NOT NULL,
      talla TEXT DEFAULT '',
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
      estado TEXT NOT NULL DEFAULT 'EMITIDA',
      clave_acceso TEXT NOT NULL,
      notas TEXT
    );

    CREATE TABLE IF NOT EXISTS factura_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      factura_id INTEGER NOT NULL REFERENCES facturas(id) ON DELETE CASCADE,
      producto_id INTEGER REFERENCES productos(id),
      descripcion TEXT NOT NULL,
      talla TEXT DEFAULT '',
      cantidad INTEGER NOT NULL,
      precio_unitario REAL NOT NULL,
      descuento REAL NOT NULL DEFAULT 0,
      subtotal REAL NOT NULL,
      iva_porcentaje REAL NOT NULL DEFAULT 15.00,
      iva_valor REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS cupones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT NOT NULL UNIQUE,
      tipo TEXT NOT NULL DEFAULT 'PORCENTAJE',
      valor REAL NOT NULL,
      minimo_compra REAL NOT NULL DEFAULT 0,
      usos_max INTEGER NOT NULL DEFAULT 0,
      usos_actuales INTEGER NOT NULL DEFAULT 0,
      activo INTEGER NOT NULL DEFAULT 1,
      fecha_vencimiento TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
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
      estado TEXT NOT NULL DEFAULT 'PENDIENTE',
      observaciones TEXT,
      conciliado INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS movimientos_caja (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo TEXT NOT NULL,
      categoria TEXT NOT NULL,
      monto REAL NOT NULL,
      fecha TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      descripcion TEXT NOT NULL,
      comprobante_id INTEGER REFERENCES comprobantes_pago(id),
      factura_id INTEGER REFERENCES facturas(id),
      metodo_pago TEXT NOT NULL DEFAULT 'TRANSFERENCIA',
      estado TEXT NOT NULL DEFAULT 'CONCILIADO',
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      num_doc TEXT DEFAULT '',
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      rol TEXT NOT NULL DEFAULT 'ADMIN',
      email TEXT,
      telefono TEXT,
      activo INTEGER NOT NULL DEFAULT 1,
      telegram_chat_id TEXT DEFAULT '',
      telegram_username TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

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

    CREATE TABLE IF NOT EXISTS compras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero_factura TEXT NOT NULL,
      proveedor_id INTEGER REFERENCES proveedores(id),
      proveedor_nombre TEXT NOT NULL,
      fecha TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      subtotal REAL NOT NULL DEFAULT 0,
      iva REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      metodo_pago TEXT NOT NULL DEFAULT 'TRANSFERENCIA',
      estado TEXT NOT NULL DEFAULT 'RECIBIDO',
      notas TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

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

    CREATE TABLE IF NOT EXISTS kardex (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      producto_id INTEGER NOT NULL REFERENCES productos(id),
      producto_nombre TEXT NOT NULL,
      tipo_movimiento TEXT NOT NULL,
      cantidad INTEGER NOT NULL,
      stock_anterior INTEGER NOT NULL,
      stock_actual INTEGER NOT NULL,
      costo_unitario REAL NOT NULL DEFAULT 0,
      precio_unitario REAL NOT NULL DEFAULT 0,
      referencia_doc TEXT,
      motivo TEXT,
      fecha TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS banners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      posicion TEXT NOT NULL DEFAULT 'PROMO_CENTRAL',
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

  // Default initial configuration
  const insertConfig = targetDb.prepare(`INSERT OR REPLACE INTO configuracion (clave, valor, descripcion) VALUES (?, ?, ?)`);
  const companyDefaults = [
    ['nombre_tienda', companyInfo.nombre_comercial || 'Mi Tienda', 'Nombre comercial'],
    ['slogan', companyInfo.slogan || 'ESTILO · CALIDAD · ATENCIÓN', 'Lema comercial'],
    ['ruc_emisor', companyInfo.ruc || '0999999999001', 'RUC de la empresa'],
    ['razon_social', companyInfo.razon_social || companyInfo.nombre_comercial || 'EMPRESA S.A.S.', 'Razón social'],
    ['rubro', companyInfo.rubro || 'MODA', 'Rubro comercial de la tienda'],
    ['color_primario', companyInfo.color_primario || '#A8324E', 'Color primario de la marca'],
    ['color_secundario', companyInfo.color_secundario || '#7B113A', 'Color secundario de la marca'],
    ['color_suave', companyInfo.color_suave || '#FAF5F6', 'Color suave de acento'],
    ['hero_titulo', companyInfo.hero_titulo || '', 'Título principal del hero'],
    ['hero_subtitulo', companyInfo.hero_subtitulo || '', 'Subtítulo o descripción del hero'],
    ['hero_imagen', companyInfo.hero_imagen || '', 'URL de imagen de portada del hero'],
    ['categorias', JSON.stringify(companyInfo.categorias || []), 'Categorías de la tienda'],
    ['direccion_matriz', companyInfo.direccion || `${companyInfo.ciudad_matriz || 'Guayaquil'}, Ecuador`, 'Dirección matriz'],
    ['provincia_matriz', companyInfo.provincia_matriz || 'Guayas', 'Provincia sede matriz'],
    ['ciudad_matriz', companyInfo.ciudad_matriz || 'Guayaquil', 'Ciudad sede matriz'],
    ['ciudades_zona_local', companyInfo.ciudades_zona_local || `${companyInfo.ciudad_matriz || 'Guayaquil'}`, 'Ciudades de envío local'],
    ['tarifa_envio_local', '3.00', 'Tarifa Servientrega Local'],
    ['tarifa_envio_nacional', '5.50', 'Tarifa Servientrega Nacional'],
    ['tarifa_envio_especial', '8.50', 'Tarifa Servientrega Especial'],
    ['envio_gratis_desde', '50.00', 'Envío gratis desde'],
    ['porcentaje_iva', '15.00', 'IVA Ecuador 15%'],
    ['tipo_contribuyente', 'REGIMEN_GENERAL', 'Régimen tributario SRI'],
    ['banco_nombre', companyInfo.banco_nombre || 'Banco Pichincha', 'Banco para transferencias'],
    ['banco_tipo_cuenta', 'Cuenta Corriente', 'Tipo de cuenta'],
    ['banco_numero_cuenta', '2100000000', 'Número de cuenta'],
    ['banco_titular', companyInfo.nombre_comercial || 'EMPRESA', 'Titular de la cuenta'],
    ['banco_identificacion', companyInfo.ruc || '0999999999001', 'RUC del titular'],
    ['banco_email', companyInfo.email_contacto || 'pagos@empresa.ec', 'Email de pagos'],
    ['telefono_contacto', companyInfo.telefono_contacto || '+593999999999', 'WhatsApp de la tienda'],
    ['email_contacto', companyInfo.email_contacto || 'ventas@empresa.ec', 'Email de contacto']
  ];

  for (const [k, v, d] of companyDefaults) {
    insertConfig.run(k, v, d);
  }

  // Seed default admin user
  const adminUser = companyInfo.admin_user || 'admin';
  const adminPass = companyInfo.admin_pass || 'admin123';
  const adminName = companyInfo.admin_nombre || `Administrador - ${companyInfo.nombre_comercial || 'Tienda'}`;

  const checkUser = targetDb.prepare("SELECT id FROM usuarios WHERE username = ?").get(adminUser);
  if (!checkUser) {
    targetDb.prepare(`
      INSERT INTO usuarios (nombre, num_doc, username, password, rol, email, telefono, activo)
      VALUES (?, '0999999999', ?, ?, 'ADMIN', ?, ?, 1)
    `).run(adminName, adminUser, adminPass, companyInfo.email_contacto || '', companyInfo.telefono_contacto || '');
  }

  // Seed default welcome promo coupon
  const countCupones = targetDb.prepare(`SELECT COUNT(*) as count FROM cupones`).get();
  if (countCupones.count === 0) {
    targetDb.prepare(`
      INSERT INTO cupones (codigo, tipo, valor, minimo_compra, usos_max, activo)
      VALUES ('BIENVENIDO10', 'PORCENTAJE', 10.00, 0, 0, 1)
    `).run();
  }
}

/**
 * Get tenant SQLite database instance by slug
 */
function getTenantDb(tenantSlug) {
  const slug = (tenantSlug || 'rs-store').trim().toLowerCase();
  
  if (tenantDbCache.has(slug)) {
    return tenantDbCache.get(slug);
  }

  const tenantDbFile = path.join(tenantsDir, `${slug}.sqlite`);
  
  // If file doesn't exist, check if it's in master database
  if (!fs.existsSync(tenantDbFile)) {
    const tenantRecord = masterDb.prepare("SELECT * FROM empresas WHERE slug = ?").get(slug);
    if (!tenantRecord) {
      // Si ni el archivo ni el registro existen, fallback a rs-store
      if (slug !== 'rs-store') {
        return getTenantDb('rs-store');
      }
    }
  }

  const dbInstance = new DatabaseSync(tenantDbFile);
  dbInstance.exec(`PRAGMA foreign_keys = ON;`);
  dbInstance.exec(`PRAGMA journal_mode = WAL;`);

  tenantDbCache.set(slug, dbInstance);
  return dbInstance;
}

/**
 * Resolve tenant metadata and license validation from HTTP request
 */
function resolveTenant(req) {
  let slug = 'rs-store';

  // 1. Check custom domain (req.hostname)
  const host = (req.hostname || req.headers.host || '').split(':')[0].toLowerCase();
  if (host && host !== 'localhost' && host !== '127.0.0.1') {
    const matchDomain = masterDb.prepare(`
      SELECT slug FROM empresas 
      WHERE lower(dominio_personalizado) = ? OR lower(dominio_personalizado) = ?
    `).get(host, `www.${host}`);
    if (matchDomain) {
      slug = matchDomain.slug;
    }
  }

  // 2. Check header
  if (req.headers['x-tenant-slug']) {
    slug = req.headers['x-tenant-slug'].trim().toLowerCase();
  }
  // 3. Check query param (?tenant=editec o ?t=editec)
  else if (req.query.tenant || req.query.t) {
    slug = (req.query.tenant || req.query.t).trim().toLowerCase();
  }
  // 4. Check route parameter (if router captured it)
  else if (req.params && req.params.tenantSlug) {
    slug = req.params.tenantSlug.trim().toLowerCase();
  }

  // Retrieve tenant record from master database
  let tenant = masterDb.prepare("SELECT * FROM empresas WHERE slug = ?").get(slug);
  if (!tenant) {
    slug = 'rs-store';
    tenant = masterDb.prepare("SELECT * FROM empresas WHERE slug = 'rs-store'").get();
  }

  // Check License validity
  const nowStr = new Date().toISOString().split('T')[0];
  const isExpired = tenant.licencia_tipo !== 'VITALICIA' && tenant.licencia_fin && tenant.licencia_fin < nowStr;
  const isSuspended = tenant.estado === 'SUSPENDIDA';

  let licenseStatus = 'ACTIVA';
  if (isSuspended) licenseStatus = 'SUSPENDIDA';
  else if (isExpired) licenseStatus = 'EXPIRADA';

  return {
    slug,
    tenant,
    licenseStatus,
    isLicensed: licenseStatus === 'ACTIVA',
    db: getTenantDb(slug)
  };
}

/**
 * Create a new tenant from scratch
 */
function createTenant({
  nombre_comercial,
  slug,
  razon_social,
  ruc,
  dominio_personalizado,
  provincia_matriz,
  ciudad_matriz,
  ciudades_zona_local,
  email_contacto,
  telefono_contacto,
  licencia_tipo = 'ANUAL',
  duracion_dias = 365,
  admin_user = 'admin',
  admin_pass = 'admin123',
  admin_nombre,
  rubro = 'MODA',
  slogan,
  color_primario,
  color_secundario,
  color_suave,
  hero_titulo,
  hero_subtitulo,
  hero_imagen,
  categorias
}) {
  const cleanSlug = (slug || nombre_comercial).toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

  if (!cleanSlug) throw new Error('El identificador (slug) de la empresa no es válido.');

  const existing = masterDb.prepare("SELECT id FROM empresas WHERE slug = ?").get(cleanSlug);
  if (existing) throw new Error(`Ya existe una empresa registrada con el identificador "${cleanSlug}".`);

  // Presets resolution
  const preset = RUBRO_PRESETS[rubro] || RUBRO_PRESETS.GENERAL;
  const finalSlogan = slogan || preset.slogan;
  const finalColorPrimario = color_primario || preset.color_primario;
  const finalColorSecundario = color_secundario || preset.color_secundario;
  const finalColorSuave = color_suave || preset.color_suave;
  const finalHeroTitulo = hero_titulo || preset.hero_titulo;
  const finalHeroSubtitulo = hero_subtitulo || preset.hero_subtitulo;
  const finalHeroImagen = hero_imagen || preset.hero_imagen;
  const finalCategorias = (categorias && Array.isArray(categorias) && categorias.length) ? categorias : preset.categorias;

  const now = new Date();
  const fin = new Date();
  fin.setDate(now.getDate() + parseInt(duracion_dias || 365, 10));

  const fechaInicio = now.toISOString().split('T')[0];
  const fechaFin = fin.toISOString().split('T')[0];
  const claveLicencia = generateLicenseKey(cleanSlug, fechaFin);

  // 1. Create physical SQLite file in database/tenants/[slug].sqlite
  const tenantDbFile = path.join(tenantsDir, `${cleanSlug}.sqlite`);
  if (fs.existsSync(tenantDbFile)) {
    fs.unlinkSync(tenantDbFile); // fresh start if leftover
  }

  const newDb = new DatabaseSync(tenantDbFile);
  
  // 2. Initialize full schema and default configs
  initSchemaOnDb(newDb, {
    nombre_comercial,
    razon_social,
    ruc,
    provincia_matriz,
    ciudad_matriz,
    ciudades_zona_local,
    email_contacto,
    telefono_contacto,
    admin_user,
    admin_pass,
    admin_nombre,
    rubro,
    slogan: finalSlogan,
    color_primario: finalColorPrimario,
    color_secundario: finalColorSecundario,
    color_suave: finalColorSuave,
    hero_titulo: finalHeroTitulo,
    hero_subtitulo: finalHeroSubtitulo,
    hero_imagen: finalHeroImagen,
    categorias: finalCategorias
  });

  // 3. Register in master.sqlite
  masterDb.prepare(`
    INSERT INTO empresas (
      slug, nombre_comercial, razon_social, ruc, dominio_personalizado,
      provincia_matriz, ciudad_matriz, ciudades_zona_local,
      email_contacto, telefono_contacto, estado, licencia_tipo,
      licencia_inicio, licencia_fin, licencia_clave, notas,
      rubro, slogan, color_primario, color_secundario, color_suave,
      hero_titulo, hero_subtitulo, hero_imagen, categorias
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, 'ACTIVA', ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?
    )
  `).run(
    cleanSlug,
    nombre_comercial,
    razon_social || nombre_comercial,
    ruc || '',
    (dominio_personalizado || '').toLowerCase().trim(),
    provincia_matriz || 'Guayas',
    ciudad_matriz || 'Guayaquil',
    ciudades_zona_local || `${ciudad_matriz || 'Guayaquil'}`,
    email_contacto || '',
    telefono_contacto || '',
    licencia_tipo,
    fechaInicio,
    fechaFin,
    claveLicencia,
    `Empresa creada el ${fechaInicio}`,
    rubro,
    finalSlogan,
    finalColorPrimario,
    finalColorSecundario,
    finalColorSuave,
    finalHeroTitulo,
    finalHeroSubtitulo,
    finalHeroImagen,
    JSON.stringify(finalCategorias)
  );

  return {
    slug: cleanSlug,
    nombre_comercial,
    fechaInicio,
    fechaFin,
    claveLicencia,
    rubro,
    slogan: finalSlogan,
    color_primario: finalColorPrimario,
    dbPath: tenantDbFile
  };
}

/**
 * Renew or extend tenant license
 */
function renewTenantLicense(slug, duracionDias = 365, providedKey = '', nuevoTipo = '') {
  const tenant = masterDb.prepare("SELECT * FROM empresas WHERE slug = ?").get(slug);
  if (!tenant) throw new Error('Empresa no encontrada.');

  const daysNum = parseInt(duracionDias, 10);
  let resolvedTipo = nuevoTipo || tenant.licencia_tipo;
  if (!nuevoTipo) {
    if (daysNum === 15) resolvedTipo = 'PRUEBA';
    else if (daysNum === 30) resolvedTipo = 'MENSUAL';
    else if (daysNum === 365) resolvedTipo = 'ANUAL';
    else if (daysNum >= 36500) resolvedTipo = 'VITALICIA';
  }

  // If a key was provided (offline renewal), validate it
  let newFinDate;
  if (providedKey) {
    const val = validateLicenseKey(slug, providedKey);
    if (!val.valid) throw new Error(val.reason);
    newFinDate = val.expiryDate;
  } else {
    // Superadmin manual renewal: add days from today (or from current expiry if future)
    const baseDate = (new Date(tenant.licencia_fin) > new Date()) ? new Date(tenant.licencia_fin) : new Date();
    baseDate.setDate(baseDate.getDate() + daysNum);
    newFinDate = baseDate.toISOString().split('T')[0];
  }

  const newKey = generateLicenseKey(slug, newFinDate);

  masterDb.prepare(`
    UPDATE empresas 
    SET licencia_fin = ?, estado = 'ACTIVA', licencia_clave = ?, licencia_tipo = ?
    WHERE slug = ?
  `).run(newFinDate, newKey, resolvedTipo, slug);

  return {
    slug,
    newFinDate,
    newKey,
    licencia_tipo: resolvedTipo
  };
}

/**
 * List all tenants for Superadmin
 */
function listAllTenants() {
  const rows = masterDb.prepare("SELECT * FROM empresas ORDER BY id ASC").all();
  const nowStr = new Date().toISOString().split('T')[0];

  return rows.map(r => {
    const isExpired = r.licencia_tipo !== 'VITALICIA' && r.licencia_fin < nowStr;
    let computedStatus = r.estado;
    if (r.estado === 'ACTIVA' && isExpired) computedStatus = 'EXPIRADA';

    const dbPath = path.join(tenantsDir, `${r.slug}.sqlite`);
    let sizeBytes = 0;
    if (fs.existsSync(dbPath)) {
      try { sizeBytes = fs.statSync(dbPath).size; } catch(e) {}
    }

    return {
      ...r,
      computedStatus,
      isExpired,
      sizeBytes,
      sizeFormatted: (sizeBytes / (1024 * 1024)).toFixed(2) + ' MB'
    };
  });
}

module.exports = {
  masterDb,
  RUBRO_PRESETS,
  getTenantDb,
  resolveTenant,
  createTenant,
  renewTenantLicense,
  listAllTenants,
  generateLicenseKey,
  validateLicenseKey,
  tenantsDir
};
