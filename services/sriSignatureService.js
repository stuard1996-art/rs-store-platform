const forge = require('node-forge');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Parsea y extrae información del certificado PKCS#12 (.p12 / .pfx)
 * @param {Buffer} p12Buffer - Buffer del archivo .p12
 * @param {string} password - Contraseña del certificado
 * @returns {object} Metadatos del certificado y claves
 */
function parseP12(p12Buffer, password) {
  try {
    const p12Der = p12Buffer.toString('binary');
    const p12Asn1 = forge.asn1.fromDer(p12Der);
    const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, password);

    // Obtener bolsas de certificados
    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
    const certBag = certBags[forge.pki.oids.certBag];

    if (!certBag || certBag.length === 0) {
      throw new Error('No se encontró certificado digital dentro del archivo .p12');
    }

    // Buscar el certificado principal (no de la CA intermedia)
    let certObj = null;
    let cert = null;
    for (const b of certBag) {
      if (b.cert) {
        // Preferir el que tiene clave asociada o el último de la cadena
        certObj = b;
        cert = b.cert;
      }
    }

    if (!cert) {
      throw new Error('Certificado no válido en el contenedor PKCS#12');
    }

    // Obtener clave privada
    const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
    const pkcs8Bags = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag] || [];
    let keyBag = pkcs8Bags[0];

    if (!keyBag) {
      const standardKeyBags = p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || [];
      keyBag = standardKeyBags[0];
    }

    const privateKey = keyBag ? keyBag.key : null;

    // Extraer datos del titular (Subject)
    const subjectAttrs = cert.subject.attributes;
    const cnAttr = subjectAttrs.find(a => a.name === 'commonName' || a.shortName === 'CN');
    const oAttr = subjectAttrs.find(a => a.name === 'organizationName' || a.shortName === 'O');
    const titular = cnAttr ? cnAttr.value : (oAttr ? oAttr.value : 'TITULAR FIRMA ELECTRÓNICA');

    // Extraer emisor (Issuer / Autoridad de Certificación)
    const issuerAttrs = cert.issuer.attributes;
    const issuerCn = issuerAttrs.find(a => a.name === 'commonName' || a.shortName === 'CN');
    const issuerO = issuerAttrs.find(a => a.name === 'organizationName' || a.shortName === 'O');
    const emisor = issuerCn ? issuerCn.value : (issuerO ? issuerO.value : 'Entidad de Certificación Autorizada');

    // Fechas de vigencia
    const notBefore = cert.validity.notBefore;
    const notAfter = cert.validity.notAfter;
    const now = new Date();

    const diasRestantes = Math.ceil((notAfter.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    const expirado = now > notAfter;
    const noIniciado = now < notBefore;

    let estado = 'ACTIVA';
    if (expirado) estado = 'VENCIDA';
    else if (noIniciado) estado = 'NO_INICIADA';
    else if (diasRestantes <= 30) estado = 'POR_VENCER';

    // Certificado en DER y Base64
    const certAsn1 = forge.pki.certificateToAsn1(cert);
    const certDer = forge.asn1.toDer(certAsn1).getBytes();
    const certB64 = forge.util.encode64(certDer);

    // Huella SHA1
    const certMd = forge.md.sha1.create();
    certMd.update(certDer);
    const sha1Fingerprint = certMd.digest().toHex();

    // Serial
    const serialNumber = cert.serialNumber;

    return {
      success: true,
      titular,
      emisor,
      serialNumber,
      valido_desde: notBefore.toISOString(),
      valido_hasta: notAfter.toISOString(),
      dias_restantes: diasRestantes,
      estado,
      expirado,
      sha1: sha1Fingerprint,
      certB64,
      cert,
      privateKey
    };
  } catch (err) {
    let msg = err.message;
    if (msg.includes('PKCS#12 MAC could not be verified') || msg.includes('Invalid password') || msg.includes('MAC verification failed')) {
      msg = 'Contraseña de la firma electrónica incorrecta. Por favor verifica e intenta nuevamente.';
    }
    return {
      success: false,
      error: msg
    };
  }
}

/**
 * SHA1 en formato Base64
 */
function sha1Base64(str) {
  return crypto.createHash('sha1').update(str, 'utf8').digest('base64');
}

/**
 * Firma digitalmente un XML con el estándar XAdES-BES requerido por el SRI de Ecuador
 * @param {string} xmlContent - XML de la factura SRI
 * @param {Buffer} p12Buffer - Archivo .p12
 * @param {string} password - Contraseña
 * @returns {string} XML firmado con bloque ds:Signature XAdES-BES
 */
function signInvoiceXmlXadesBes(xmlContent, p12Buffer, password) {
  const p12Info = parseP12(p12Buffer, password);
  if (!p12Info.success) {
    throw new Error(`Error al leer firma electrónica: ${p12Info.error}`);
  }

  if (!p12Info.privateKey) {
    throw new Error('El archivo .p12 no contiene la clave privada necesaria para firmar');
  }

  // IDs únicos para las etiquetas del comprobante y firma
  const randNum = Math.floor(Math.random() * 900000) + 100000;
  const signatureId = `Signature${randNum}`;
  const signedPropertiesId = `SignedPropertiesID${randNum}`;
  const signedInfoId = `SignedInfoID${randNum}`;
  const signatureValueId = `SignatureValueID${randNum}`;
  const certificateId = `CertificateID${randNum}`;
  const referenceDocId = `Reference-ID-${randNum}`;

  // Asegurar que la etiqueta raíz factura tenga id="comprobante"
  let cleanXml = xmlContent.trim();
  if (!cleanXml.includes('id="comprobante"')) {
    cleanXml = cleanXml.replace(/<factura([^>]*)>/, '<factura$1 id="comprobante">');
  }

  // Digest del documento (factura)
  const docDigest = sha1Base64(cleanXml);

  // Digest del certificado
  const certDerBinary = forge.util.decode64(p12Info.certB64);
  const certSha1 = crypto.createHash('sha1').update(Buffer.from(certDerBinary, 'binary')).digest('base64');

  // Fecha y hora de firma ISO
  const signingTime = new Date().toISOString();

  // Emisor del certificado para IssuerSerial
  const issuerAttributes = p12Info.cert.issuer.attributes;
  const issuerStr = issuerAttributes.map(a => `${a.shortName || a.name}=${a.value}`).join(',');
  const serialDecimal = parseInt(p12Info.serialNumber, 16).toString();

  // 1. Bloque SignedProperties
  const signedPropertiesXml = `<etsi:SignedProperties xmlns:etsi="http://uri.etsi.org/01903/v1.3.2#" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Id="${signedPropertiesId}">` +
    `<etsi:SignedSignatureProperties>` +
      `<etsi:SigningTime>${signingTime}</etsi:SigningTime>` +
      `<etsi:SigningCertificate>` +
        `<etsi:Cert>` +
          `<etsi:CertDigest>` +
            `<ds:DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/>` +
            `<ds:DigestValue>${certSha1}</ds:DigestValue>` +
          `</etsi:CertDigest>` +
          `<etsi:IssuerSerial>` +
            `<ds:X509IssuerName>${issuerStr}</ds:X509IssuerName>` +
            `<ds:X509SerialNumber>${serialDecimal}</ds:X509SerialNumber>` +
          `</etsi:IssuerSerial>` +
        `</etsi:Cert>` +
      `</etsi:SigningCertificate>` +
    `</etsi:SignedSignatureProperties>` +
    `<etsi:SignedDataObjectProperties>` +
      `<etsi:DataObjectFormat ObjectReference="#${referenceDocId}">` +
        `<etsi:Description>Comprobante Electrónico SRI</etsi:Description>` +
        `<etsi:MimeType>text/xml</etsi:MimeType>` +
      `</etsi:DataObjectFormat>` +
    `</etsi:SignedDataObjectProperties>` +
  `</etsi:SignedProperties>`;

  const signedPropertiesDigest = sha1Base64(signedPropertiesXml);

  // 2. Bloque SignedInfo
  const signedInfoXml = `<ds:SignedInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:etsi="http://uri.etsi.org/01903/v1.3.2#" Id="${signedInfoId}">` +
    `<ds:CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>` +
    `<ds:SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"/>` +
    `<ds:Reference Id="${referenceDocId}" URI="#comprobante">` +
      `<ds:Transforms>` +
        `<ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>` +
      `</ds:Transforms>` +
      `<ds:DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/>` +
      `<ds:DigestValue>${docDigest}</ds:DigestValue>` +
    `</ds:Reference>` +
    `<ds:Reference Type="http://uri.etsi.org/01903#SignedProperties" URI="#${signedPropertiesId}">` +
      `<ds:DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/>` +
      `<ds:DigestValue>${signedPropertiesDigest}</ds:DigestValue>` +
    `</ds:Reference>` +
    `<ds:Reference URI="#${certificateId}">` +
      `<ds:DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/>` +
      `<ds:DigestValue>${certSha1}</ds:DigestValue>` +
    `</ds:Reference>` +
  `</ds:SignedInfo>`;

  // 3. Firma RSA-SHA1 de SignedInfo con la clave privada
  const md = forge.md.sha1.create();
  md.update(signedInfoXml, 'utf8');
  const signatureBytes = p12Info.privateKey.sign(md);
  const signatureValueB64 = forge.util.encode64(signatureBytes);

  // Formatear certificado con saltos de línea de 76 caracteres
  const certLines = p12Info.certB64.match(/.{1,76}/g).join('\n');

  // Módulos de clave RSA pública
  const rsaModulus = forge.util.encode64(forge.util.hexToBytes(p12Info.privateKey.n.toString(16)));
  const rsaExponent = forge.util.encode64(forge.util.hexToBytes(p12Info.privateKey.e.toString(16)));

  // 4. Armar el bloque final ds:Signature
  const signatureXml = `\n<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:etsi="http://uri.etsi.org/01903/v1.3.2#" Id="${signatureId}">` +
    `\n${signedInfoXml}` +
    `\n<ds:SignatureValue Id="${signatureValueId}">\n${signatureValueB64}\n</ds:SignatureValue>` +
    `\n<ds:KeyInfo Id="${certificateId}">` +
      `\n<ds:X509Data>` +
        `\n<ds:X509Certificate>\n${certLines}\n</ds:X509Certificate>` +
      `\n</ds:X509Data>` +
      `\n<ds:KeyValue>` +
        `\n<ds:RSAKeyValue>` +
          `\n<ds:Modulus>\n${rsaModulus}\n</ds:Modulus>` +
          `\n<ds:Exponent>${rsaExponent}</ds:Exponent>` +
        `\n</ds:RSAKeyValue>` +
      `\n</ds:KeyValue>` +
    `\n</ds:KeyInfo>` +
    `\n<ds:Object Id="${signatureId}-Object">` +
      `<etsi:QualifyingProperties Target="#${signatureId}">` +
        `${signedPropertiesXml}` +
      `</etsi:QualifyingProperties>` +
    `</ds:Object>` +
  `\n</ds:Signature>`;

  // Insertar ds:Signature justo antes de </factura>
  const signedXmlFinal = cleanXml.replace('</factura>', `${signatureXml}\n</factura>`);
  return signedXmlFinal;
}

module.exports = {
  parseP12,
  signInvoiceXmlXadesBes
};
