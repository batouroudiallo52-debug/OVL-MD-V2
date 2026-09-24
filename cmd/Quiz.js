'use strict';

const fs = require('fs');
const path = require('path');
const { ovlcmd } = require('../lib/ovlcmd');

const QUESTIONS_FILE = path.join(__dirname, '..', 'lib', 'quiz_questions.json');
const activeQuizzes = new Map();
const scores = new Map();

const CATEGORIES = {
  anime: 'Anime',
  culture: 'Culture générale',
  foot: 'Football',
  musique: 'Musique',
  horreur: 'Films d’horreur',
  kpop: 'K-pop'
};

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function loadQuestions() {
  const questions = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'));
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error('La banque de questions est vide.');
  }
  return questions.filter((item) => (
    item && CATEGORIES[item.category] && typeof item.question === 'string' &&
    Array.isArray(item.options) && item.options.length === 4 &&
    item.options.every((option) => typeof option === 'string' && option.trim()) &&
    Number.isInteger(item.answer) && item.answer >= 1 && item.answer <= 4
  ));
}

function getArgs(context) {
  if (Array.isArray(context?.arg)) return context.arg.map(String);
  if (typeof context?.arg === 'string') return context.arg.trim().split(/\s+/).filter(Boolean);
  return [];
}

function getSender(context) {
  return context?.auteur_Message || context?.sender || context?.participant || 'joueur';
}

function getChatId(context, fallback) {
  return context?.chatId || context?.jid || context?.ms?.key?.remoteJid || fallback;
}

function getRawText(context) {
  const candidates = [
    context?.body,
    context?.text,
    context?.messageText,
    context?.content,
    context?.ms?.message?.conversation,
    context?.ms?.message?.extendedTextMessage?.text,
    context?.ms?.message?.imageMessage?.caption,
    context?.ms?.message?.videoMessage?.caption
  ];
  return candidates.find((value) => typeof value === 'string')?.trim() || '';
}

function categoryFrom(value) {
  const category = normalize(value);
  if (category === 'culture generale' || category === 'general') return 'culture';
  if (category === 'film' || category === 'films horreur' || category === 'films dhorreur') return 'horreur';
  return category;
}

function formatCategories() {
  return Object.entries(CATEGORIES)
    .map(([key, label]) => `• *.quiz ${key}* — ${label}`)
    .join('\n');
}

function formatQuestion(game) {
  const options = game.question.options
    .map((option, index) => `   *${index + 1}.* ${option}`)
    .join('\n');
  return `🧠 *QUIZ ${CATEGORIES[game.category].toUpperCase()}*\n\n${game.question.question}\n\n${options}\n\nRéponds simplement avec *1*, *2*, *3* ou *4*.\n⏱️ Temps limite : 90 secondes`;
}

function getScore(chatId, player) {
  const key = `${chatId}:${player}`;
  if (!scores.has(key)) scores.set(key, { player, points: 0, attempts: 0 });
  return scores.get(key);
}

function startQuiz(chatId, player, category, sock) {
  const questions = loadQuestions().filter((question) => question.category === category);
  if (!questions.length) throw new Error(`Aucune question disponible pour ${category}.`);

  const current = questions[Math.floor(Math.random() * questions.length)];
  const game = { category, question: current, player, expiresAt: Date.now() + 90_000 };
  activeQuizzes.set(chatId, game);

  const timeout = setTimeout(() => {
    if (activeQuizzes.get(chatId) === game) {
      activeQuizzes.delete(chatId);
      sock.sendMessage(chatId, {
        text: `⏱️ Temps écoulé ! La bonne réponse était *${current.answer}*.\n\nLance *.quiz ${category}* pour recommencer.`
      }).catch(() => {});
    }
  }, 90_000);
  timeout.unref?.();
  return game;
}

async function answerQuiz(chatId, sock, player, answer) {
  const active = activeQuizzes.get(chatId);
  if (!active || Date.now() >= active.expiresAt) return false;

  const score = getScore(chatId, player);
  score.attempts += 1;
  if (Number(answer) !== active.question.answer) {
    await sock.sendMessage(chatId, {
      text: `❌ Mauvaise réponse, @${player.split('@')[0]}. Essaie encore avec *1*, *2*, *3* ou *4*.`
    });
    return true;
  }

  score.points += 1;
  const nextGame = startQuiz(chatId, player, active.category, sock);
  await sock.sendMessage(chatId, {
    text: `✅ Bonne réponse, @${player.split('@')[0]} ! +1 point.\n\nScore : *${score.points}*\n\n${formatQuestion(nextGame)}`
  });
  return true;
}

async function showScore(chatId, sock) {
  const entries = [...scores.entries()]
    .filter(([key]) => key.startsWith(`${chatId}:`))
    .map(([, value]) => value)
    .sort((a, b) => b.points - a.points);
  const text = entries.length
    ? entries.map((entry, index) => `${index + 1}. @${entry.player.split('@')[0]} — ${entry.points} point(s)`).join('\n')
    : 'Aucun score enregistré pour le moment.';
  return sock.sendMessage(chatId, { text: `🏆 *SCORES QUIZ*\n\n${text}` });
}

async function runQuizCommand(jid, sock, context = {}) {
  const chatId = getChatId(context, jid);
  const args = getArgs(context);
  const firstArg = normalize(args[0]);
  const player = getSender(context);

  if (/^[1-4]$/.test(firstArg) && activeQuizzes.has(chatId)) {
    return answerQuiz(chatId, sock, player, firstArg);
  }

  if (!firstArg || ['aide', 'help', 'categories', 'catégories'].includes(firstArg)) {
    return sock.sendMessage(chatId, {
      text: `🧠 *QUIZ — CATÉGORIES DISPONIBLES*\n\n${formatCategories()}\n\nAprès la question, réponds simplement avec *1*, *2*, *3* ou *4*.\n\n*.quiz score* — voir les scores\n*.quiz stop* — arrêter la partie`
    });
  }

  if (['stop', 'arret', 'arrêt', 'cancel'].includes(firstArg)) {
    activeQuizzes.delete(chatId);
    return sock.sendMessage(chatId, { text: '🛑 Quiz arrêté.' });
  }

  if (['score', 'scores', 'classement'].includes(firstArg)) return showScore(chatId, sock);

  const category = categoryFrom(firstArg);
  if (!CATEGORIES[category]) {
    return sock.sendMessage(chatId, { text: `❌ Catégorie inconnue.\n\n${formatCategories()}` });
  }

  try {
    const game = startQuiz(chatId, player, category, sock);
    return sock.sendMessage(chatId, { text: formatQuestion(game) });
  } catch (error) {
    console.error('[quiz]', error);
    return sock.sendMessage(chatId, { text: '❌ Impossible de charger cette catégorie pour le moment.' });
  }
}

ovlcmd({
  nom_cmd: 'quiz',
  classe: 'Jeux',
  react: '🧠',
  desc: 'Quiz anime, culture générale, football, musique, K-pop et films d’horreur.',
  alias: ['quizz']
}, runQuizCommand);

// Réception des réponses seules « 1 », « 2 », « 3 » ou « 4 », sans préfixe.
ovlcmd({
  nom_cmd: 'quiz_answer',
  isfunc: true,
  react: '🧠',
  desc: 'Traite les réponses numériques d’une partie de quiz en cours.'
}, async (jid, sock, context = {}) => {
  const chatId = getChatId(context, jid);
  const raw = getRawText(context);
  const answer = raw.match(/^[1-4]$/)?.[0];
  if (!answer || !activeQuizzes.has(chatId)) return;
  await answerQuiz(chatId, sock, getSender(context), answer);
});

module.exports = { activeQuizzes, scores, loadQuestions, CATEGORIES, answerQuiz, runQuizCommand };
