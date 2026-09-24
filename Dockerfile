FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /ovl_bot

COPY package*.json ./
RUN npm install --omit=dev
COPY . .

# Vérifier que l’image contient bien la version complète du quiz.
RUN test -f cmd/Quiz.js \
    && test -f lib/quiz_questions.json \
    && grep -q "sciences" cmd/Quiz.js \
    && grep -q '"category": "histoire"' lib/quiz_questions.json

EXPOSE 8000

CMD ["npm", "run", "Ovl"]
