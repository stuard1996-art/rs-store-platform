const { db } = require('../database/db.js');

function formatMoney(n) {
  return '$' + Number(n || 0).toFixed(2);
}

/**
 * Procesa consultas del administrador en lenguaje natural o estructurado
 */
async function processAdminQuery(queryText) {
  const q = (queryText || '').toLowerCase().trim();
  if (!q) {
    return {
      type: 'HELP',
      title: 'Consola de Consultas del Administrador',
      message: 'Puedes consultar sobre: ventas de hoy, pedidos pendientes, stock bajo, balance de caja o buscar clientes y productos.',
      data: null
    };
  }

  // 0. SALUDOS Y BIENVENIDA
  if (['hola', 'buenas', 'buenos dias', 'buenas tardes', 'buenas noches', 'que tal', 'hey', 'start', '/start', '/menu', '/ayuda', '/help'].some(s => q === s || q.startsWith(s))) {
    return {
      type: 'GREETING',
      title: '👋 ¡Hola! Asistente RS Store en Línea',
      summary: 'Estoy conectado a la base de datos y listo para responder cualquier consulta.',
      message: '👋 ¡Hola! Soy tu asistente inteligente de RS Store Boutique.\n\nPuedes consultar ventas de hoy, pedidos pendientes, balance de caja, stock de prendas o buscar clientes. ¿Qué deseas revisar?',
      data: null
    };
  }

  // 1. VENTAS / FACTURACIÓN
  if (q.includes('venta') || q.includes('vend') || q.includes('factur') || q.includes('cierre') || q === '/ventas') {
    const statsToday = db.prepare(`
      SELECT 
        COUNT(*) as facturas_hoy,
        COALESCE(SUM(total), 0) as total_hoy,
        COALESCE(SUM(subtotal_iva), 0) as subtotal_hoy,
        COALESCE(SUM(monto_iva), 0) as iva_hoy
      FROM facturas 
      WHERE date(fecha_emision) = date('now', 'localtime') AND estado = 'EMITIDA'
    `).get();

    const statsMonth = db.prepare(`
      SELECT 
        COUNT(*) as facturas_mes,
        COALESCE(SUM(total), 0) as total_mes
      FROM facturas 
      WHERE strftime('%Y-%m', fecha_emision) = strftime('%Y-%m', 'now', 'localtime') AND estado = 'EMITIDA'
    `).get();

    const statsTotal = db.prepare(`
      SELECT COUNT(*) as total_facturas, COALESCE(SUM(total), 0) as total_historico
      FROM facturas WHERE estado = 'EMITIDA'
    `).get();

    const ultimasFacturas = db.prepare(`
      SELECT f.id, f.secuencial, c.razon_social as cliente_nombre, f.total, f.fecha_emision
      FROM facturas f
      LEFT JOIN clientes c ON f.cliente_id = c.id
      WHERE f.estado = 'EMITIDA' ORDER BY f.id DESC LIMIT 4
    `).all();

    return {
      type: 'VENTAS',
      title: '📊 Resumen Financiero & Facturación SRI',
      summary: `Hoy se han emitido ${statsToday.facturas_hoy} facturas por un total de ${formatMoney(statsToday.total_hoy)}.`,
      details: {
        hoy: {
          facturas: statsToday.facturas_hoy,
          total: formatMoney(statsToday.total_hoy),
          iva: formatMoney(statsToday.iva_hoy),
          base: formatMoney(statsToday.subtotal_hoy)
        },
        mes: {
          facturas: statsMonth.facturas_mes,
          total: formatMoney(statsMonth.total_mes)
        },
        historico: {
          facturas: statsTotal.total_facturas,
          total: formatMoney(statsTotal.total_historico)
        },
        ultimas: ultimasFacturas
      }
    };
  }

  // 2. PEDIDOS / DESPACHO / SERVIENTREGA
  if (q.includes('pedido') || q.includes('orden') || q.includes('despach') || q.includes('envio') || q.includes('servientrega') || q === '/pedidos') {
    const pedidos = db.prepare(`
      SELECT p.*, c.razon_social as cliente_nombre, c.telefono as cliente_telefono
      FROM pedidos p
      LEFT JOIN clientes c ON p.cliente_id = c.id
      ORDER BY p.id DESC LIMIT 6
    `).all();

    const pendientes = db.prepare(`SELECT COUNT(*) as c FROM pedidos WHERE estado IN ('PENDIENTE_PAGO', 'EN_REVISION')`).get().c;
    const pagados = db.prepare(`SELECT COUNT(*) as c FROM pedidos WHERE estado = 'PAGADO'`).get().c;
    const enviados = db.prepare(`SELECT COUNT(*) as c FROM pedidos WHERE estado = 'ENVIADO'`).get().c;

    return {
      type: 'PEDIDOS',
      title: '📦 Estado de Pedidos & Despachos',
      summary: `Hay ${pagados} pedidos pagados listos para embalar/despachar y ${pendientes} en revisión de pago.`,
      details: {
        kpis: { pendientes, pagados, enviados },
        pedidos: pedidos.map(p => ({
          id: p.id,
          codigo: p.codigo_pedido,
          cliente: p.cliente_nombre || 'Cliente Web',
          telefono: p.cliente_telefono || '',
          total: formatMoney(p.total),
          estado: p.estado,
          tipo_entrega: p.tipo_entrega,
          ciudad: p.ciudad || 'Guayaquil',
          direccion: p.tipo_entrega === 'AGENCIA' ? p.agencia_servientrega : `${p.calle_principal || ''} ${p.numero_casa || ''}`
        }))
      }
    };
  }

  // 3. CAJA / BANCOS / BALANCE / SALDO
  if (q.includes('caja') || q.includes('banco') || q.includes('balance') || q.includes('saldo') || q.includes('dinero') || q.includes('plata') || q === '/caja') {
    const kpi = db.prepare(`
      SELECT 
        COALESCE(SUM(CASE WHEN tipo = 'INGRESO' THEN monto ELSE 0 END), 0) as total_ingresos,
        COALESCE(SUM(CASE WHEN tipo = 'EGRESO' THEN monto ELSE 0 END), 0) as total_egresos
      FROM movimientos_caja
    `).get();

    const saldoNeto = kpi.total_ingresos - kpi.total_egresos;
    const pendientesComprobantes = db.prepare(`SELECT COUNT(*) as c FROM comprobantes_pago WHERE estado IN ('PENDIENTE', 'REVISAR_MONTO')`).get().c;
    const ultimosMovimientos = db.prepare(`SELECT * FROM movimientos_caja ORDER BY id DESC LIMIT 5`).all();

    return {
      type: 'CAJA',
      title: '🏦 Balance de Caja y Bancos RS Store',
      summary: `Saldo neto disponible en libro de caja: ${formatMoney(saldoNeto)} (Ingresos: ${formatMoney(kpi.total_ingresos)} | Egresos: ${formatMoney(kpi.total_egresos)}).`,
      details: {
        saldo_neto: formatMoney(saldoNeto),
        total_ingresos: formatMoney(kpi.total_ingresos),
        total_egresos: formatMoney(kpi.total_egresos),
        comprobantes_pendientes: pendientesComprobantes,
        movimientos: ultimosMovimientos.map(m => ({
          id: m.id,
          tipo: m.tipo,
          monto: formatMoney(m.monto),
          concepto: m.concepto,
          fecha: m.fecha
        }))
      }
    };
  }

  // 4. STOCK / INVENTARIO / PRENDAS
  if (q.includes('stock') || q.includes('inventario') || q.includes('agotad') || q.includes('prend') || q.includes('ropa') || q === '/stock') {
    // Verificar si busca un producto específico (ej: "stock vestido")
    let specificSearch = q.replace('/stock', '').replace('stock', '').replace('inventario', '').replace('de', '').replace('del', '').trim();
    
    if (specificSearch.length >= 3) {
      const match = db.prepare(`SELECT * FROM productos WHERE LOWER(name) LIKE ? OR LOWER(cat) LIKE ? LIMIT 5`).all(`%${specificSearch}%`, `%${specificSearch}%`);
      if (match.length) {
        return {
          type: 'STOCK_BUSQUEDA',
          title: `🔍 Consulta de Stock: "${specificSearch}"`,
          summary: `Se encontraron ${match.length} producto(s) coincidentes.`,
          details: {
            productos: match.map(p => ({
              id: p.id,
              nombre: p.name,
              categoria: p.cat,
              precio: formatMoney(p.price),
              stock_total: p.stock,
              tallas: p.tallas ? JSON.parse(p.tallas) : null
            }))
          }
        };
      }
    }

    const lowStock = db.prepare(`SELECT name, cat, price, stock, tallas FROM productos WHERE stock <= 4 ORDER BY stock ASC LIMIT 8`).all();
    const totalProductos = db.prepare(`SELECT COUNT(*) as total, SUM(stock) as stock_total FROM productos`).get();

    return {
      type: 'STOCK_CRITICO',
      title: '⚠️ Inventario Crítico & Stock Bajo',
      summary: lowStock.length ? `Hay ${lowStock.length} productos con 4 o menos unidades en inventario.` : 'Todo el catálogo se encuentra con niveles óptimos de stock.',
      details: {
        total_catalogo: totalProductos.total,
        unidades_totales: totalProductos.stock_total || 0,
        criticos: lowStock.map(p => ({
          nombre: p.name,
          categoria: p.cat,
          precio: formatMoney(p.price),
          stock: p.stock,
          estado: p.stock <= 0 ? 'AGOTADO' : `${p.stock} unids restantes`
        }))
      }
    };
  }

  // 5. BÚSQUEDA DE CLIENTES POR CÉDULA O NOMBRE
  if (q.includes('cliente') || q.includes('cedula') || q.includes('ruc') || q === '/clientes' || /^\d{10,13}$/.test(q)) {
    let term = q.replace('/clientes', '').replace('/cliente', '').replace('clientes', '').replace('cliente', '').replace('cedula', '').replace('ruc', '').replace('buscar', '').trim();
    
    let clientes;
    if (!term || term.length <= 1) {
      // Listar clientes más frecuentes o recientes
      clientes = db.prepare(`
        SELECT c.*, COUNT(p.id) as total_pedidos, COALESCE(SUM(p.total), 0) as gasto_total
        FROM clientes c
        LEFT JOIN pedidos p ON c.id = p.cliente_id
        GROUP BY c.id
        ORDER BY total_pedidos DESC, c.id DESC
        LIMIT 6
      `).all();
    } else {
      clientes = db.prepare(`
        SELECT c.*, COUNT(p.id) as total_pedidos, COALESCE(SUM(p.total), 0) as gasto_total
        FROM clientes c
        LEFT JOIN pedidos p ON c.id = p.cliente_id
        WHERE LOWER(c.razon_social) LIKE ? OR c.num_doc LIKE ? OR c.telefono LIKE ?
        GROUP BY c.id
        LIMIT 6
      `).all(`%${term}%`, `%${term}%`, `%${term}%`);
    }

    if (clientes.length) {
      return {
        type: 'CLIENTES',
        title: `👤 Clientes Registrados (${clientes.length})`,
        summary: term ? `Resultados de búsqueda para "${term}":` : `Clientes frecuentes y registrados:`,
        details: {
          clientes: clientes.map(c => ({
            id: c.id,
            nombre: c.razon_social,
            doc: c.num_doc,
            telefono: c.telefono,
            email: c.email,
            pedidos: c.total_pedidos,
            gasto_total: formatMoney(c.gasto_total)
          }))
        }
      };
    }
  }

  // Búsqueda general en catálogo
  const prodMatch = db.prepare(`SELECT * FROM productos WHERE LOWER(name) LIKE ? LIMIT 4`).all(`%${q}%`);
  if (prodMatch.length) {
    return {
      type: 'STOCK_BUSQUEDA',
      title: `🛍️ Productos Encontrados: "${queryText}"`,
      summary: `Mostrando ${prodMatch.length} resultado(s):`,
      details: {
        productos: prodMatch.map(p => ({
          id: p.id,
          nombre: p.name,
          categoria: p.cat,
          precio: formatMoney(p.price),
          stock_total: p.stock,
          tallas: p.tallas ? JSON.parse(p.tallas) : null
        }))
      }
    };
  }

  // Búsqueda por defecto / no encontrado
  return {
    type: 'NO_MATCH',
    title: '🤔 Consulta no reconocida',
    message: `No encontré resultados para "${queryText}". Intenta consultar:\n• "¿Cuánto vendimos hoy?"\n• "Pedidos pendientes"\n• "Stock de prendas"\n• "Balance de caja"\n• O escribe el nombre o cédula de un cliente.`,
    data: null
  };
}

module.exports = {
  processAdminQuery
};
