FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    fonts-dejavu \
    fonts-liberation \
    fonts-noto-core \
    libreoffice \
    libreoffice-writer \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV LIBREOFFICE_PATH=libreoffice

CMD ["npm", "start"]
