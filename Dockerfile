FROM node:22-alpine

WORKDIR /app

# Copiar definiciones de paquetes
COPY package*.json ./

# Instalar dependencias de producción
RUN npm install --omit=dev

# Copiar código fuente
COPY . .

# Exponer el puerto
EXPOSE 3000

ENV PORT=3000
ENV NODE_ENV=production

# Iniciar servidor
CMD ["node", "server.js"]
