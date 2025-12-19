# ===== Imagem base =====
FROM mcr.microsoft.com/devcontainers/javascript-node:dev-20 AS build

# ===== Diretório de trabalho =====
WORKDIR /app

# ===== Copia apenas package.json =====
COPY package.json ./

RUN npm config set strict-ssl false

# ===== Instala dependências =====
RUN npm install --production

# ===== Copia o código =====
COPY index.js ./

# ===== Porta exposta =====
EXPOSE 3000

# ===== Variáveis padrão =====
ENV NODE_ENV=production
ENV PORT=3000

# ===== Start =====
CMD ["npm", "start"]