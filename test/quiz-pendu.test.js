'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// Quiz n’utilise axios que pour la recherche d’images ; les tests restent locaux.
const originalLoad = Module._load;
Module._load = function loadWithAxiosStub(request, parent, isMain) {
  if (request === 'axios') return { get: async () => ({ data: {} }) };
  return originalLoad.call(this, request, parent, isMain);
};

const quiz = require('../cmd/Quiz');
const pendu = require('../cmd/Pendu');
Module._load = originalLoad;

function makeSocket() {
  const sent = [];
  return {
    sent,
    async sendMessage(chatId, payload) {
      sent.push({ chatId, ...payload });
      return payload;
    }
  };
}

test('le quiz affiche et accepte les chiffres emoji et les chiffres simples', () => {
  assert.deepEqual(quiz.DIGIT_EMOJIS, ['1️⃣', '2️⃣', '3️⃣', '4️⃣']);
  assert.equal(quiz.parseDigitChoice('1️⃣'), '1');
  assert.equal(quiz.parseDigitChoice('2'), '2');
  assert.equal(quiz.parseDigitChoice('4️⃣'), '4');
  assert.equal(quiz.parseDigitChoice('5️⃣'), null);
  assert.match(quiz.formatQuestionSelections(), /1️⃣.*10 questions[\s\S]*2️⃣.*20 questions[\s\S]*3️⃣.*30 questions/);
  const questionText = quiz.formatQuestion({
    category: 'anime',
    index: 1,
    total: 10,
    question: { question: 'Question de test ?', options: ['A', 'B', 'C', 'D'] }
  });
  for (const emoji of quiz.DIGIT_EMOJIS) assert.ok(questionText.includes(emoji));
});

test('aucune question déjà jouée ne revient dans un quiz ultérieur, même en changeant de catégorie', async () => {
  const chatId = 'chat-anti-repetition';
  const player = 'joueur-1';
  const socket = makeSocket();
  quiz.activeQuizzes.clear();
  quiz.pendingQuizSelections.clear();
  quiz.quizHistory.clear();

  const playedQuestions = new Set();
  async function playTen(category) {
    await quiz.runQuizCommand(chatId, socket, { arg: [category], auteur_Message: player });
    await quiz.runQuizCommand(chatId, socket, { arg: ['1️⃣'], auteur_Message: player });
    while (quiz.activeQuizzes.has(chatId)) {
      const game = quiz.activeQuizzes.get(chatId);
      assert.equal(playedQuestions.has(game.question.question), false, 'une question précédente a été répétée');
      playedQuestions.add(game.question.question);
      await quiz.answerQuiz(chatId, socket, player, String(game.question.answer));
    }
  }

  await playTen('anime');
  await playTen('culture');
  assert.equal(playedQuestions.size, 20);
  assert.equal(quiz.quizHistory.get(chatId).size, 20);
});

test('une réponse emoji envoyée seule est reconnue pendant le quiz', async () => {
  const chatId = 'chat-reponse-emoji';
  const player = 'joueur-emoji';
  const socket = makeSocket();
  quiz.activeQuizzes.clear();
  quiz.pendingQuizSelections.clear();
  quiz.quizHistory.clear();
  await quiz.runQuizCommand(chatId, socket, { arg: ['anime'], auteur_Message: player });
  await quiz.runQuizCommand(chatId, socket, { arg: ['1️⃣'], auteur_Message: player });

  const game = quiz.activeQuizzes.get(chatId);
  const { func } = require('../lib/ovlcmd');
  const answerHandler = func.find((command) => command.nom_cmd === 'quiz_answer');
  assert.ok(answerHandler);
  const wrongAnswer = game.question.answer === 1 ? 2 : 1;
  await answerHandler.fonction(chatId, socket, {
    auteur_Message: player,
    ms: { key: { remoteJid: chatId }, message: { conversation: `${wrongAnswer}️⃣` } }
  });
  assert.equal(game.answers.get(player), wrongAnswer);
});

test('le pendu normalise les accents, compte les erreurs et termine une partie gagnée', async () => {
  const chatId = 'chat-pendu-test';
  const socket = makeSocket();
  pendu.activeGames.clear();
  assert.equal(pendu.normalizeLetter('é'), 'E');
  assert.equal(pendu.normalizeLetter('12'), null);

  await pendu.runPenduCommand(chatId, socket, { arg: [], auteur_Message: 'joueur-1' });
  const game = pendu.activeGames.get(chatId);
  assert.ok(game);
  game.word = 'TEST';

  for (const letter of new Set(pendu.normalizeWord(game.word))) {
    await pendu.applyGuess(chatId, socket, letter);
  }
  assert.equal(pendu.activeGames.has(chatId), false);
  assert.match(socket.sent.at(-1).text, /Bravo, le mot a été trouvé/);
});

test('le pendu met fin à la partie après six lettres incorrectes', async () => {
  const chatId = 'chat-pendu-erreurs';
  const socket = makeSocket();
  pendu.activeGames.clear();

  await pendu.runPenduCommand(chatId, socket, { arg: [], auteur_Message: 'joueur-1' });
  const game = pendu.activeGames.get(chatId);
  game.word = 'TEST';
  for (const letter of ['Z', 'X', 'Q', 'W', 'J', 'K']) {
    await pendu.applyGuess(chatId, socket, letter);
  }
  assert.equal(pendu.activeGames.has(chatId), false);
  assert.match(socket.sent.at(-1).text, /Partie terminée/);
  assert.match(socket.sent.at(-1).text, /TEST/);
});
