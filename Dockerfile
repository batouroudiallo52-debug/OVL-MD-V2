FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production PORT=8000
WORKDIR /ovl_bot

COPY package*.json ./
RUN npm install --omit=dev
COPY . .

# Vérifier que l’image contient bien la version complète du quiz.
RUN test -f cmd/Quiz.js \
    && test -f lib/quiz_questions.json \
    && test -f lib/quiz_true_false.json \
    && grep -q "QUESTION_LIMITS = \[10, 20, 30\]" cmd/Quiz.js \
    && grep -q "QUESTION_SELECTIONS" cmd/Quiz.js \
    && grep -q "ANSWER_TIMEOUT = 10_000" cmd/Quiz.js \
    && grep -q "Temps limite : \\*10 secondes\\*" cmd/Quiz.js \
    && grep -q "Chaque quiz utilise des questions nouvelles" cmd/Quiz.js \
    && grep -q "questionQueue" cmd/Quiz.js \
    && grep -q "function questionKey" cmd/Quiz.js \
    && node --check cmd/Quiz.js \
    && node -e "JSON.parse(require('fs').readFileSync('lib/quiz_questions.json', 'utf8')); JSON.parse(require('fs').readFileSync('lib/quiz_true_false.json', 'utf8'));" \
    && grep -q "sciences" cmd/Quiz.js \
    && grep -q '"category": "histoire"' lib/quiz_questions.json

EXPOSE 8000

CMD ["npm", "run", "Ovl"]
