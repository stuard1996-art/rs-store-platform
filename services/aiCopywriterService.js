/**
 * Generador de descripciones profesionales y persuasivas para boutique de moda (IA Copywriter)
 */

const FASHION_COPY_TEMPLATES = {
  ropa: [
    (n, d) => `Confeccionada para realzar tu figura con sutileza y elegancia. ${n} destaca por su caída fluida y tejido suave al tacto que garantiza frescura y confort durante todo el día. ${d ? d + '. ' : ''}Ideal para llevar desde un brunch casual hasta una cena especial; combínala con tus accesorios favoritos y luce un estilo sofisticado sin esfuerzo.`,
    (n, d) => `Una prenda esencial que eleva cualquier fondo de armario. ${n} combina un corte moderno con acabados impecables, brindando libertad de movimiento y máxima versatilidad. ${d ? d + '. ' : ''}Llévala con pantalones de lino o falda midi para un look contemporáneo y chic.`
  ],
  accesorios: [
    (n, d) => `El toque definitivo para elevar cualquier atuendo. ${n} está diseñado con acabados finos y un peso liviano que te permite usarlo cómodamente durante todo el día. ${d ? d + '. ' : ''}Aporta luminosidad y distinción instantánea tanto en looks de día como para eventos nocturnos.`,
    (n, d) => `Diseño exclusivo que fusiona minimalismo y brillo sofisticado. ${n} complementa tu estilo con un carácter atemporal. ${d ? d + '. ' : ''}Un detalle perfecto para regalarte o sorprender a alguien especial.`
  ],
  calzado: [
    (n, d) => `Elegancia y comodidad en cada paso. ${n} incorpora plantilla ergonómica acolchada y materiales de primera calidad pensados para acompañarte durante largas jornadas. ${d ? d + '. ' : ''}Su tono y diseño combinan a la perfección con vestidos vaporosos, jeans o prendas de lino.`,
    (n, d) => `El equilibrio ideal entre tendencia y confort absoluto. ${n} abraza el pie con suavidad y ligereza, convirtiéndose en tu calzado favorito de la temporada.`
  ],
  belleza: [
    (n, d) => `Fórmula avanzada de textura sedosa y rápida absorción. ${n} nutre profundamente, devolviendo la luminosidad natural y frescura a tu piel. ${d ? d + '. ' : ''}Dermatológicamente testeado, libre de sensación pesada e ideal para tu rutina diaria de cuidado personal.`,
    (n, d) => `Un ritual de autocuidado que transforma tu piel. ${n} proporciona hidratación prolongada y un acabado radiante desde la primera aplicación.`
  ],
  hogar: [
    (n, d) => `Transforma cualquier rincón en un oasis de calidez y serenidad. ${n} ofrece una atmósfera envolvente gracias a su diseño acogedor y notas aromáticas exquisitas. ${d ? d + '. ' : ''}El elemento decorativo ideal para tu sala, habitación o espacio de descanso.`,
    (n, d) => `Detalles que transmiten paz y buen gusto. ${n} llena tus espacios de armonía y estilo con acabados artesanales seleccionados con mimo.`
  ],
  regalos: [
    (n, d) => `El detalle perfecto, presentado con delicadeza y buen gusto. ${n} reúne piezas armoniosas listas para emocionar en cualquier fecha especial. ${d ? d + '. ' : ''}Calidad garantizada y presentación impecable que enamora al primer instante.`,
    (n, d) => `Celebra momentos inolvidables con un regalo que habla por sí solo. ${n} combina elegancia, sorpresa y utilidad en una sola experiencia.`
  ]
};

async function generateProductDescription(name, category, userNotes = '') {
  if (!name) throw new Error('El nombre del producto es necesario para generar la descripción.');

  const cat = (category || 'accesorios').toLowerCase();

  // Si existe clave GEMINI_API_KEY o variable de entorno de IA, podemos intentar consultar en vivo
  const apiKey = process.env.GEMINI_API_KEY || process.env.AI_API_KEY;
  if (apiKey) {
    try {
      const prompt = `Actúa como una experta en redacción publicitaria (copywriting) para una boutique de moda femenina de lujo accesible en Ecuador llamada "RS Store". 
Escribe una descripción de producto irresistible, sofisticada, elegante y persuasiva que destaque beneficios, cómo se siente la prenda, ocasiones de uso y consejos para combinarla.
Nombre del producto: "${name}"
Categoría: "${cat}"
Detalles clave: "${userNotes || 'alta calidad, tendencia 2026, cómodo y duradero'}"
Longitud: 2 párrafos concisos y fluidos (máximo 70 palabras). No uses viñetas ni asteriscos innecesarios, escribe prosa limpia.`;

      const aiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });

      if (aiRes.ok) {
        const aiJson = await aiRes.json();
        const text = aiJson?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text && text.trim()) {
          return text.trim();
        }
      }
    } catch (err) {
      // Fallback a motor boutique semántico
    }
  }

  // Motor semántico boutique local (alta conversión, garantizado sin fallas de red)
  const templates = FASHION_COPY_TEMPLATES[cat] || FASHION_COPY_TEMPLATES.ropa;
  const chosen = templates[Math.floor(Math.random() * templates.length)];
  return chosen(name.trim(), userNotes.trim());
}

module.exports = {
  generateProductDescription
};
