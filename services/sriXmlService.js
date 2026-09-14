const { getInvoiceDetails, getConfig } = require('./invoiceService.js');

/**
 * Genera el XML estándar de Factura Electrónica versión 1.1.0 para el SRI del Ecuador
 * @param {number} invoiceId 
 * @returns {string} XML formateado
 */
function generateInvoiceXml(invoiceId) {
  const inv = getInvoiceDetails(invoiceId);
  if (!inv) throw new Error('Factura no encontrada');

  const em = inv.emisor || {};
  const fecha = new Date(inv.fecha_emision);
  const dia = String(fecha.getDate()).padStart(2, '0');
  const mes = String(fecha.getMonth() + 1).padStart(2, '0');
  const anio = fecha.getFullYear();
  const fechaEmisionStr = `${dia}/${mes}/${anio}`;

  // Tipo de identificación del comprador según tabla 6 del SRI
  let tipoIdComprador = '07'; // Consumidor final
  if (inv.cliente_tipo_doc === 'RUC') tipoIdComprador = '04';
  else if (inv.cliente_tipo_doc === 'CEDULA') tipoIdComprador = '05';
  else if (inv.cliente_tipo_doc === 'PASAPORTE') tipoIdComprador = '06';

  const [estab, ptoEmi, secuencialNum] = inv.secuencial.split('-');

  // Detalles XML
  const detallesXml = inv.items.map(it => `
    <detalle>
      <codigoPrincipal>${it.producto_id || 'ART'}</codigoPrincipal>
      <descripcion><![CDATA[${it.descripcion}]]></descripcion>
      <cantidad>${it.cantidad}</cantidad>
      <precioUnitario>${Number(it.precio_unitario).toFixed(2)}</precioUnitario>
      <descuento>${Number(it.descuento || 0).toFixed(2)}</descuento>
      <precioTotalSinImpuesto>${Number(it.subtotal).toFixed(2)}</precioTotalSinImpuesto>
      <impuestos>
        <impuesto>
          <codigo>2</codigo>
          <codigoPorcentaje>4</codigoPorcentaje>
          <tarifa>${Number(it.iva_porcentaje).toFixed(2)}</tarifa>
          <baseImponible>${Number(it.subtotal).toFixed(2)}</baseImponible>
          <valor>${Number(it.iva_valor).toFixed(2)}</valor>
        </impuesto>
      </impuestos>
    </detalle>`).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<factura id="comprobante" version="1.1.0">
  <infoTributaria>
    <ambiente>1</ambiente>
    <tipoEmision>1</tipoEmision>
    <razonSocial><![CDATA[${em.razon_social || 'RS STORE BOUTIQUE S.A.S.'}]]></razonSocial>
    <nombreComercial><![CDATA[${em.nombre_tienda || 'RS STORE'}]]></nombreComercial>
    <ruc>${em.ruc || '0992345678001'}</ruc>
    <claveAcceso>${inv.clave_acceso}</claveAcceso>
    <codDoc>01</codDoc>
    <estab>${estab}</estab>
    <ptoEmi>${ptoEmi}</ptoEmi>
    <secuencial>${secuencialNum}</secuencial>
    <dirMatriz><![CDATA[${em.direccion_matriz || 'Guayaquil, Ecuador'}]]></dirMatriz>
    ${em.tipo_contribuyente && em.tipo_contribuyente.startsWith('RIMPE') ? `<contribuyenteRimpe>CONTRIBUYENTE RÉGIMEN RIMPE</contribuyenteRimpe>` : ''}
    ${em.resolucion_contribuyente ? `<resolucion>${em.resolucion_contribuyente}</resolucion>` : ''}
  </infoTributaria>
  <infoFactura>
    <fechaEmision>${fechaEmisionStr}</fechaEmision>
    <dirEstablecimiento><![CDATA[${em.direccion_matriz || 'Guayaquil, Ecuador'}]]></dirEstablecimiento>
    <obligadoContabilidad>NO</obligadoContabilidad>
    <tipoIdentificacionComprador>${tipoIdComprador}</tipoIdentificacionComprador>
    <razonSocialComprador><![CDATA[${inv.cliente_nombre}]]></razonSocialComprador>
    <identificacionComprador>${inv.cliente_num_doc}</identificacionComprador>
    <direccionComprador><![CDATA[${inv.cliente_direccion || 'Ecuador'}]]></direccionComprador>
    <totalSinImpuestos>${Number(inv.subtotal_iva + inv.subtotal_0).toFixed(2)}</totalSinImpuestos>
    <totalDescuento>${Number(inv.descuento || 0).toFixed(2)}</totalDescuento>
    <totalConImpuestos>
      ${Number(inv.subtotal_iva) > 0 ? `
      <totalImpuesto>
        <codigo>2</codigo>
        <codigoPorcentaje>4</codigoPorcentaje>
        <baseImponible>${Number(inv.subtotal_iva).toFixed(2)}</baseImponible>
        <valor>${Number(inv.monto_iva).toFixed(2)}</valor>
      </totalImpuesto>` : ''}
      ${Number(inv.subtotal_0) > 0 ? `
      <totalImpuesto>
        <codigo>2</codigo>
        <codigoPorcentaje>0</codigoPorcentaje>
        <baseImponible>${Number(inv.subtotal_0).toFixed(2)}</baseImponible>
        <valor>0.00</valor>
      </totalImpuesto>` : ''}
    </totalConImpuestos>
    <propina>0.00</propina>
    <importeTotal>${Number(inv.total).toFixed(2)}</importeTotal>
    <moneda>DOLAR</moneda>
    <pagos>
      <pago>
        <formaPago>${inv.forma_pago.startsWith('19') ? '19' : (inv.forma_pago.startsWith('20') ? '20' : '01')}</formaPago>
        <total>${Number(inv.total).toFixed(2)}</total>
        <plazo>0</plazo>
        <unidadTiempo>dias</unidadTiempo>
      </pago>
    </pagos>
  </infoFactura>
  <detalles>${detallesXml}
  </detalles>
  <infoAdicional>
    <campoAdicional nombre="Email">${inv.cliente_email || 'ventas@rsstore.ec'}</campoAdicional>
    <campoAdicional nombre="Telefono">${inv.cliente_telefono || '0991234567'}</campoAdicional>
    <campoAdicional nombre="Notas">${inv.notas || 'RS Store Boutique Ecuador'}</campoAdicional>
    ${em.tipo_contribuyente === 'RIMPE_POPULAR' ? `<campoAdicional nombre="Regimen">Contribuyente Regimen RIMPE - Negocio Popular</campoAdicional>` : (em.tipo_contribuyente === 'RIMPE_EMPRENDEDOR' ? `<campoAdicional nombre="Regimen">Contribuyente Regimen RIMPE</campoAdicional>` : '')}
  </infoAdicional>
</factura>`;

  return xml.trim();
}

module.exports = {
  generateInvoiceXml
};
