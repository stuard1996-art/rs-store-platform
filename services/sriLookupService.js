const { db } = require('../database/db.js');

/**
 * Valida cédula ecuatoriana según algoritmo módulo 10
 * @param {string} cedula 
 * @returns {boolean}
 */
function validarCedula(cedula) {
  if (!cedula || cedula.length !== 10 || !/^\d{10}$/.test(cedula)) return false;
  const prov = parseInt(cedula.slice(0, 2), 10);
  if ((prov < 1 || prov > 24) && prov !== 30) return false;

  const tercerDigito = parseInt(cedula[2], 10);
  if (tercerDigito >= 6) return false;

  const coeficientes = [2, 1, 2, 1, 2, 1, 2, 1, 2];
  let suma = 0;
  for (let i = 0; i < 9; i++) {
    let valor = parseInt(cedula[i], 10) * coeficientes[i];
    if (valor >= 10) valor -= 9;
    suma += valor;
  }

  const digitoVerificador = parseInt(cedula[9], 10);
  const residuo = suma % 10;
  const resultado = residuo === 0 ? 0 : 10 - residuo;

  return resultado === digitoVerificador;
}

/**
 * Consulta en tiempo real al catastro oficial del SRI en línea
 * @param {string} identificacion - 10 dígitos (Cédula) o 13 dígitos (RUC)
 * @returns {Promise<Object>} Datos del contribuyente o null
 */
async function consultarSRIEnLinea(identificacion) {
  const doc = String(identificacion || '').trim();
  if (!doc) return null;

  // 1. Si es consumidor final directo
  if (doc === '9999999999999') {
    return {
      success: true,
      tipo_doc: 'CONSUMIDOR_FINAL',
      num_doc: '9999999999999',
      razon_social: 'CONSUMIDOR FINAL',
      fuente: 'SISTEMA'
    };
  }

  // 2. Primero buscar en la base de datos local (cache instantáneo de clientes y proveedores)
  const localClient = db.prepare(`SELECT * FROM clientes WHERE num_doc = ?`).get(doc);
  if (localClient && localClient.razon_social && localClient.razon_social !== 'CONSUMIDOR FINAL') {
    return {
      success: true,
      tipo_doc: localClient.tipo_doc,
      num_doc: localClient.num_doc,
      razon_social: localClient.razon_social,
      telefono: localClient.telefono || '',
      email: localClient.email || '',
      direccion: localClient.direccion || '',
      fuente: 'BD_LOCAL_CLIENTE'
    };
  }

  const localSupplier = db.prepare(`SELECT * FROM proveedores WHERE ruc_cedula = ?`).get(doc);
  if (localSupplier && localSupplier.razon_social) {
    return {
      success: true,
      tipo_doc: doc.length === 13 ? 'RUC' : 'CEDULA',
      num_doc: localSupplier.ruc_cedula,
      razon_social: localSupplier.razon_social,
      contacto: localSupplier.contacto_nombre || '',
      telefono: localSupplier.telefono || '',
      email: localSupplier.email || '',
      direccion: localSupplier.direccion || '',
      fuente: 'BD_LOCAL_PROVEEDOR'
    };
  }

  // 3. Preparar RUC para consulta oficial del SRI
  // En Ecuador, toda cédula registrada en SRI tiene RUC terminando en 001
  let rucConsulta = doc;
  let esCedula = false;

  if (doc.length === 10) {
    esCedula = true;
    rucConsulta = doc + '001';
  } else if (doc.length !== 13) {
    return {
      success: false,
      error: 'La identificación debe tener 10 dígitos (cédula) o 13 dígitos (RUC).'
    };
  }

  try {
    const url = `https://srienlinea.sri.gob.ec/sri-catastro-sujeto-servicio-internet/rest/ConsolidadoContribuyente/obtenerPorNumerosRuc?ruc=${rucConsulta}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000); // 4s timeout

    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (res.status === 200) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        const item = data[0];
        const razonSocial = (item.razonSocial || '').trim();
        const tipoDoc = esCedula ? 'CEDULA' : (item.tipoContribuyente === 'SOCIEDAD' ? 'RUC' : 'RUC');

        // Guardar en base de datos local para acelerar futuras consultas
        try {
          const insertStmt = db.prepare(`
            INSERT INTO clientes (tipo_doc, num_doc, razon_social, direccion)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(num_doc) DO UPDATE SET razon_social = excluded.razon_social
          `);
          insertStmt.run(tipoDoc, doc, razonSocial, 'Ecuador');
        } catch(e) {
          // Si no tiene constraint UNIQUE o falla, intentar insert simple
          try {
            db.prepare(`INSERT INTO clientes (tipo_doc, num_doc, razon_social, direccion) VALUES (?, ?, ?, ?)`).run(tipoDoc, doc, razonSocial, 'Ecuador');
          } catch(e2) {}
        }

        return {
          success: true,
          tipo_doc: tipoDoc,
          num_doc: doc,
          razon_social: razonSocial,
          estado_sri: item.estadoContribuyenteRuc || 'ACTIVO',
          tipo_contribuyente: item.tipoContribuyente || 'PERSONA NATURAL',
          regimen: item.regimen || 'GENERAL',
          obligado_contabilidad: item.obligadoLlevarContabilidad || 'NO',
          fuente: 'SRI_EN_LINEA'
        };
      }
    }

    // Si el SRI no tiene RUC con 001 (por ejemplo, persona que nunca ha sacado RUC pero tiene cédula válida)
    if (esCedula && validarCedula(doc)) {
      return {
        success: true,
        tipo_doc: 'CEDULA',
        num_doc: doc,
        razon_social: '', // Requiere ingresar nombre ya que no tiene RUC registrado en catastro
        cedula_valida: true,
        fuente: 'VALIDACION_ALGORITMICA',
        mensaje: 'Cédula válida. Ingrese el nombre del cliente.'
      };
    }

    return {
      success: false,
      error: 'No se encontraron datos en el catastro del SRI para esta identificación.'
    };
  } catch (err) {
    // Si falla la conexión con el SRI, validar al menos el algoritmo de cédula
    if (esCedula && validarCedula(doc)) {
      return {
        success: true,
        tipo_doc: 'CEDULA',
        num_doc: doc,
        razon_social: '',
        cedula_valida: true,
        fuente: 'VALIDACION_ALGORITMICA',
        mensaje: 'Cédula válida según algoritmo del Registro Civil.'
      };
    }
    return {
      success: false,
      error: 'No fue posible consultar el SRI: ' + err.message
    };
  }
}

module.exports = {
  validarCedula,
  consultarSRIEnLinea
};
