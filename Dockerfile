FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /ovl_bot

COPY package*.json ./
RUN npm install --omit=dev
COPY . .

EXPOSE 8000

CMD ["npm", "run", "Ovl"]
