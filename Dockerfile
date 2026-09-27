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
    && grep -q "QUESTION_LIMITS = \[10, 20, 30\]" cmd/Quiz.js \
    && grep -q "QUESTION_SELECTIONS" cmd/Quiz.js \
    && grep -q "ANSWER_TIMEOUT = 10_000" cmd/Quiz.js \
    && grep -q "Temps limite : \\*10 secondes\\*" cmd/Quiz.js \
    && grep -q "Chaque quiz utilise des questions nouvelles" cmd/Quiz.js \
    && grep -q "questionQueue" cmd/Quiz.js \
    && grep -q "function questionKey" cmd/Quiz.js \
    && node --check cmd/Quiz.js \
    && node -e "const q=JSON.parse(require('fs').readFileSync('lib/quiz_questions.json', 'utf8')); const allowed=new Set(['anime','culture','foot','horreur','kpop']); if (!q.length || q.some(x => !allowed.has(x.category)) || new Set(q.map(x => x.category)).size !== allowed.size) process.exit(1);"

EXPOSE 8000

CMD ["npm", "run", "Ovl"]
