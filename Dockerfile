# Usa una imagen con Node y permisos correctos
FROM node:20-alpine

# Crea el directorio de trabajo
WORKDIR /app

# Copia package.json y package-lock.json
COPY package*.json ./

# Instala dependencias (incluye devDependencies)
RUN npm install

# Copia el resto del proyecto
COPY . .

# Asegura que tsc tenga permisos
RUN chmod +x ./node_modules/.bin/tsc

# Compila TypeScript
RUN npx tsc

# Expone el puerto (opcional: para debugging local)
EXPOSE 3001

# Comando para iniciar el backend
CMD ["node", "dist/app.js"]
