'use strict';

const fs = require('fs');
const path = require('path');
const { ovlcmd } = require('../lib/ovlcmd');

const QUESTIONS_FILE = path.join(__dirname, '..', 'lib', 'aquizz.json');
const activeQuizzes = new Map();
const scores = new Map();

function loadQuestions() {
  const questions = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'));
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error('La banque de questions est vide.');
  }
  return questions.filter((item) => (
    item && typeof item.question === 'string' &&
    item.options && typeof item.options === 'object' &&
    /^[a-d]$/i.test(String(item.answer))
  ));
}

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function getArgs(context) {
  if (Array.isArray(context?.arg)) return context.arg.map(String);
  if (typeof context?.arg === 'string') return context.arg.trim().split(/\s+/).filter(Boolean);
  return [];
}

function getSender(context) {
  return context?.auteur_Message || context?.sender || 'joueur';
}

function formatQuestion(question, number, total) {
  const options = Object.entries(question.options)
    .map(([key, value]) => `   ${key.toUpperCase()}. ${value}`)
    .join('\n');
  return `🧠 *QUIZ* — Question ${number}/${total}\n\n${question.question}\n\n${options}\n\nRéponds avec *.quiz a*, *.quiz b*, *.quiz c* ou *.quiz d*.`;
}

function getScore(chatId, player) {
  const key = `${chatId}:${player}`;
  if (!scores.has(key)) scores.set(key, { player, points: 0, attempts: 0 });
  return scores.get(key);
}

function startQuiz(chatId, player, sock) {
  const questions = loadQuestions();
  const current = questions[Math.floor(Math.random() * questions.length)];
  const game = {
    question: current,
    player,
    total: questions.length,
    startedAt: Date.now(),
    expiresAt: Date.now() + 90_000
  };
  activeQuizzes.set(chatId, game);
  const timeout = setTimeout(() => {
    const currentGame = activeQuizzes.get(chatId);
    if (currentGame === game) {
      activeQuizzes.delete(chatId);
      sock.sendMessage(chatId, {
        text: `⏱️ Temps écoulé ! La bonne réponse était *${String(current.answer).toUpperCase()}*. Lance *.quiz* pour une nouvelle question.`
      }).catch(() => {});
    }
  }, 90_000);
  timeout.unref?.();
  return game;
}

ovlcmd({
  nom_cmd: 'quiz',
  classe: 'Jeux',
  react: '🧠',
  desc: 'Lance un quiz à choix multiple ou répond à la question en cours.',
  alias: ['quizz']
}, async (chatId, sock, context = {}) => {
  const args = getArgs(context);
  const command = normalize(args[0]);
  const player = getSender(context);

  if (['stop', 'arret', 'arrêt', 'cancel'].includes(command)) {
    if (!activeQuizzes.has(chatId)) {
      return sock.sendMessage(chatId, { text: 'ℹ️ Aucun quiz n’est en cours dans cette discussion.' });
    }
    activeQuizzes.delete(chatId);
    return sock.sendMessage(chatId, { text: '🛑 Quiz arrêté. Lance *.quiz* pour recommencer.' });
  }

  if (['score', 'scores', 'classement'].includes(command)) {
    const entries = [...scores.entries()]
      .filter(([key]) => key.startsWith(`${chatId}:`))
      .map(([, value]) => value)
      .sort((a, b) => b.points - a.points);
    const text = entries.length
      ? entries.map((entry, index) => `${index + 1}. @${entry.player.split('@')[0]} — ${entry.points} point(s)`).join('\n')
      : 'Aucun score enregistré pour le moment.';
    return sock.sendMessage(chatId, { text: `🏆 *SCORES QUIZ*\n\n${text}` });
  }

  const game = activeQuizzes.get(chatId);
  if (game && Date.now() < game.expiresAt && /^[a-d]$/i.test(command)) {
    const score = getScore(chatId, player);
    score.attempts += 1;
    const expected = normalize(game.question.answer);
    if (command === expected) {
      score.points += 1;
      activeQuizzes.delete(chatId);
      return sock.sendMessage(chatId, {
        text: `✅ Bonne réponse, @${player.split('@')[0]} ! Tu gagnes 1 point.\n\nScore actuel : *${score.points}*\n\nLance *.quiz* pour continuer.`
      });
    }
    return sock.sendMessage(chatId, {
      text: `❌ Mauvaise réponse, @${player.split('@')[0]}. Essaie encore avec une lettre entre *a* et *d*.`
    });
  }

  if (game && Date.now() >= game.expiresAt) activeQuizzes.delete(chatId);
  const nextGame = startQuiz(chatId, player, sock);
  return sock.sendMessage(chatId, { text: formatQuestion(nextGame.question, 1, nextGame.total) });
});

module.exports = { activeQuizzes, scores, loadQuestions };
