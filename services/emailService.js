const nodemailer = require('nodemailer');
const { db } = require('../database/db.js');

function getConfig(key, defaultVal = '') {
  try {
    const row = db.prepare('SELECT valor FROM configuracion WHERE clave = ?').get(key);
    return row ? row.valor : defaultVal;
  } catch (e) {
    return defaultVal;
  }
}

/**
 * Crea el transportador de correo según la configuración de la BD
 */
function createTransporter() {
  const host = getConfig('smtp_host', 'smtp.gmail.com');
  const port = parseInt(getConfig('smtp_port', '465'), 10);
  const user = getConfig('smtp_user', '');
  const pass = getConfig('smtp_pass', '');

  if (!user || !pass) return null;

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
    tls: { rejectUnauthorized: false }
  });
}

/**
 * Prueba la conexión con el servidor SMTP configurado
 */
async function testSmtpConnection(customConfig = null) {
  try {
    const host = customConfig?.host || getConfig('smtp_host', 'smtp.gmail.com');
    const port = parseInt(customConfig?.port || getConfig('smtp_port', '465'), 10);
    const user = customConfig?.user || getConfig('smtp_user', '');
    const pass = customConfig?.pass || getConfig('smtp_pass', '');

    if (!user || !pass) {
      return { success: false, error: 'Ingresa el usuario y contraseña del servidor SMTP.' };
    }

    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
      tls: { rejectUnauthorized: false }
    });

    await transporter.verify();
    return { success: true, message: `Conexión exitosa con el servidor SMTP (${host}:${port})` };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Envía la factura electrónica por correo al cliente si SMTP está habilitado
 */
async function sendInvoiceEmail({ toEmail, clientName, invoiceSecuencial, total, rideUrl, xmlContent = null }) {
  const activo = getConfig('smtp_activo', '0') === '1';
  if (!activo || !toEmail || toEmail.includes('consumidor@rsstore.ec') || toEmail.includes('example.com')) {
    return { sent: false, reason: 'SMTP no activo o correo no aplica' };
  }

  const transporter = createTransporter();
  if (!transporter) {
    return { sent: false, reason: 'Credenciales SMTP incompletas' };
  }

  const from = getConfig('smtp_from', 'RS Store Facturación <ventas@rsstore.ec>');
  const storeName = getConfig('nombre_tienda', 'RS Store');

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333; border: 1px solid #eee; border-radius: 12px; overflow: hidden;">
      <div style="background: #9E3E60; color: #fff; padding: 24px; text-align: center;">
        <h1 style="margin: 0; font-size: 24px;">${storeName}</h1>
        <p style="margin: 6px 0 0; font-size: 14px; opacity: 0.9;">Comprobante Electrónico Autorizado por el SRI</p>
      </div>
      <div style="padding: 24px;">
        <p>Estimado/a <b>${clientName || 'Cliente'}</b>,</p>
        <p>Gracias por tu compra en <b>${storeName}</b>. Adjuntamos la información de tu comprobante electrónico emitido ante el Servicio de Rentas Internas (SRI):</p>
        
        <table style="width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px;">
          <tr style="background: #f9f9f9;"><td style="padding: 10px; border: 1px solid #ddd;"><b>No. Factura SRI:</b></td><td style="padding: 10px; border: 1px solid #ddd;">${invoiceSecuencial}</td></tr>
          <tr><td style="padding: 10px; border: 1px solid #ddd;"><b>Total Pagado:</b></td><td style="padding: 10px; border: 1px solid #ddd; font-weight: bold; color: #9E3E60;">$${Number(total).toFixed(2)}</td></tr>
          <tr style="background: #f9f9f9;"><td style="padding: 10px; border: 1px solid #ddd;"><b>Estado SRI:</b></td><td style="padding: 10px; border: 1px solid #ddd; color: #2E7D32;">AUTORIZADO / VIGENTE</td></tr>
        </table>

        <div style="text-align: center; margin: 28px 0;">
          <a href="${rideUrl}" style="background: #9E3E60; color: #fff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: bold; display: inline-block;">Ver y Descargar Factura (RIDE PDF)</a>
        </div>

        <p style="font-size: 12px; color: #777; line-height: 1.5;">
          Este comprobante electrónico tiene validez tributaria según la normativa del Servicio de Rentas Internas de la República del Ecuador.
        </p>
      </div>
      <div style="background: #f5f5f5; padding: 14px; text-align: center; font-size: 12px; color: #888;">
        ${storeName} · Facturación Electrónica SRI Ecuador
      </div>
    </div>
  `;

  const mailOptions = {
    from,
    to: toEmail,
    subject: `Tu Factura Electrónica ${invoiceSecuencial} - ${storeName}`,
    html
  };

  if (xmlContent) {
    mailOptions.attachments = [
      {
        filename: `Factura_${invoiceSecuencial}.xml`,
        content: xmlContent,
        contentType: 'application/xml'
      }
    ];
  }

  try {
    const info = await transporter.sendMail(mailOptions);
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    console.error('Error enviando correo de factura:', err.message);
    return { sent: false, error: err.message };
  }
}

module.exports = {
  testSmtpConnection,
  sendInvoiceEmail
};
