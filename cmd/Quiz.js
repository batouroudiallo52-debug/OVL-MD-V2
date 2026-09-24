'use strict';

const fs = require('fs');
const path = require('path');
const { ovlcmd } = require('../lib/ovlcmd');

const QUESTIONS_FILE = path.join(__dirname, '..', 'lib', 'quiz_questions.json');
const activeQuizzes = new Map();
const scores = new Map();
const QUESTION_LIMITS = [10, 30, 60, 100];
const ANSWER_TIMEOUT = 90_000;

// Catégories disponibles pour les parties de quiz.
const CATEGORIES = {
  anime: 'Anime',
  culture: 'Culture générale',
  foot: 'Football',
  horreur: 'Films d’horreur',
  kpop: 'K-pop',
  musique: 'Musique'
};

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function loadQuestions(category) {
  const questions = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'));
  if (!Array.isArray(questions)) throw new Error('La banque de questions est invalide.');
  const filtered = questions.filter((item) => (
    item && CATEGORIES[item.category] &&
    (!category || item.category === category) &&
    typeof item.question === 'string' && item.question.trim() &&
    Array.isArray(item.options) && item.options.length === 4 &&
    item.options.every((option) => typeof option === 'string' && option.trim()) &&
    Number.isInteger(item.answer) && item.answer >= 1 && item.answer <= 4
  ));
  if (!filtered.length) throw new Error(`Aucune question disponible pour ${category || 'cette catégorie'}.`);
  return filtered;
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
  if (category === 'culture generale' || category === 'general' || category === 'culture') return 'culture';
  if (category === 'film' || category === 'films horreur' || category === 'films dhorreur' || category === 'horreur') return 'horreur';
  if (category === 'football' || category === 'foot') return 'foot';
  if (category === 'k-pop' || category === 'kpop') return 'kpop';
  if (category === 'musique' || category === 'music') return 'musique';
  return category;
}

function formatCategories() {
  return Object.entries(CATEGORIES)
    .map(([key, label]) => `• *.quiz ${key} 10* — ${label}`)
    .join('\n');
}

function formatQuestion(game) {
  const options = game.question.options
    .map((option, index) => `   *${index + 1}.* ${option}`)
    .join('\n');
  return `🧠 *QUIZ ${CATEGORIES[game.category].toUpperCase()}*\nQuestion *${game.index}/${game.total}*\n\n${game.question.question}\n\n${options}\n\nRéponds seulement avec *1*, *2*, *3* ou *4*.\n⏱️ Réponses ouvertes pendant 90 secondes.\n✅ La correction est automatique dès qu’un joueur trouve ou que tous les joueurs connus ont répondu.`;
}

function playerLabel(player) {
  return `@${String(player).split('@')[0]}`;
}

function getGlobalScore(chatId, player) {
  const key = `${chatId}:${player}`;
  if (!scores.has(key)) scores.set(key, { player, points: 0, attempts: 0 });
  return scores.get(key);
}

function clearRoundTimer(game) {
  if (game.timer) clearTimeout(game.timer);
  game.timer = null;
}

function scheduleRoundTimeout(chatId, sock, game) {
  clearRoundTimer(game);
  game.timer = setTimeout(() => {
    if (activeQuizzes.get(chatId) === game) {
      revealRound(chatId, sock, game, 'timeout').catch((error) => console.error('[quiz timeout]', error));
    }
  }, ANSWER_TIMEOUT);
  game.timer.unref?.();
}

function chooseQuestion(game) {
  const pool = game.pool.filter((item) => !game.used.has(item.question));
  const available = pool.length ? pool : game.pool;
  const question = available[Math.floor(Math.random() * available.length)];
  game.used.add(question.question);
  return question;
}

function createGame(chatId, player, category, total, sock) {
  const pool = loadQuestions(category);
  const game = {
    category,
    total,
    index: 1,
    pool,
    used: new Set(),
    question: null,
    answers: new Map(),
    participants: new Set([player]),
    resolving: false,
    timer: null
  };
  game.question = chooseQuestion(game);
  activeQuizzes.set(chatId, game);
  scheduleRoundTimeout(chatId, sock, game);
  return game;
}

function parseTotal(args) {
  const requested = args.map(normalize).find((arg) => QUESTION_LIMITS.includes(Number(arg)));
  return requested ? Number(requested) : 10;
}

function parseCategory(args) {
  const candidate = args.find((arg) => !QUESTION_LIMITS.includes(Number(normalize(arg))));
  return categoryFrom(candidate || '');
}

function scoreSummary(chatId, game) {
  return [...game.participants]
    .map((player) => getGlobalScore(chatId, player))
    .sort((a, b) => b.points - a.points)
    .map((entry, index) => `${index + 1}. ${playerLabel(entry.player)} — ${entry.points} point(s)`)
    .join('\n') || 'Aucun score enregistré.';
}

async function revealRound(chatId, sock, game, reason) {
  if (game.resolving || activeQuizzes.get(chatId) !== game) return;
  game.resolving = true;
  clearRoundTimer(game);

  const correctAnswer = game.question.answer;
  const correctText = game.question.options[correctAnswer - 1];
  const winners = [...game.answers.entries()]
    .filter(([, answer]) => answer === correctAnswer)
    .map(([player]) => player);

  for (const [player] of game.answers) {
    getGlobalScore(chatId, player).attempts += 1;
  }
  for (const player of winners) getGlobalScore(chatId, player).points += 1;

  let result;
  if (winners.length) {
    result = `✅ ${winners.map(playerLabel).join(', ')} a trouvé la bonne réponse !\n🎯 Réponse : *${correctAnswer} — ${correctText}*`;
  } else if (reason === 'timeout') {
    result = `⏱️ Personne n’a trouvé à temps.\n🎯 La bonne réponse était : *${correctAnswer} — ${correctText}*`;
  } else {
    result = `❌ Aucun joueur n’a trouvé la bonne réponse.\n🎯 La bonne réponse était : *${correctAnswer} — ${correctText}*`;
  }

  if (game.index >= game.total) {
    activeQuizzes.delete(chatId);
    await sock.sendMessage(chatId, {
      text: `${result}\n\n🏁 *QUIZ TERMINÉ*\n\n🏆 Classement final :\n${scoreSummary(chatId, game)}`
    });
    return;
  }

  game.index += 1;
  game.answers = new Map();
  game.question = chooseQuestion(game);
  game.resolving = false;
  scheduleRoundTimeout(chatId, sock, game);
  await sock.sendMessage(chatId, { text: `${result}\n\n${formatQuestion(game)}` });
}

async function answerQuiz(chatId, sock, player, answer) {
  const game = activeQuizzes.get(chatId);
  if (!game || game.resolving) return false;

  const selectedAnswer = Number(answer);
  if (!Number.isInteger(selectedAnswer) || selectedAnswer < 1 || selectedAnswer > 4) return false;
  if (game.answers.has(player)) return true;

  game.participants.add(player);
  game.answers.set(player, selectedAnswer);

  if (selectedAnswer === game.question.answer) {
    await revealRound(chatId, sock, game, 'correct');
    return true;
  }

  // Quand plusieurs joueurs participent, la manche est corrigée dès que
  // chaque joueur déjà inscrit a répondu. Le délai couvre le cas d’un seul joueur.
  if (game.participants.size > 1 && [...game.participants].every((participant) => game.answers.has(participant))) {
    await revealRound(chatId, sock, game, 'all_answered');
  }
  return true;
}

async function showScore(chatId, sock) {
  const entries = [...scores.entries()]
    .filter(([key]) => key.startsWith(`${chatId}:`))
    .map(([, value]) => value)
    .sort((a, b) => b.points - a.points);
  const text = entries.length
    ? entries.map((entry, index) => `${index + 1}. ${playerLabel(entry.player)} — ${entry.points} point(s)`).join('\n')
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
      text: `🧠 *QUIZ — CATÉGORIES DISPONIBLES*\n\n${formatCategories()}\n\nFormats acceptés : *10*, *30*, *60* ou *100* questions.\nExemple : *.quiz anime 30*\n\nRéponds uniquement avec *1*, *2*, *3* ou *4*. La correction et la question suivante sont automatiques.\n\n*.quiz score* — voir les scores\n*.quiz stop* — arrêter la partie`
    });
  }

  if (['stop', 'arret', 'arrêt', 'cancel'].includes(firstArg)) {
    const game = activeQuizzes.get(chatId);
    if (game) clearRoundTimer(game);
    activeQuizzes.delete(chatId);
    return sock.sendMessage(chatId, { text: '🛑 Quiz arrêté.' });
  }

  if (['score', 'scores', 'classement'].includes(firstArg)) return showScore(chatId, sock);

  if (activeQuizzes.has(chatId)) {
    return sock.sendMessage(chatId, { text: '⚠️ Un quiz est déjà en cours. Réponds avec *1*, *2*, *3* ou *4*, ou utilise *.quiz stop*.' });
  }

  const category = parseCategory(args);
  const total = parseTotal(args);
  if (!CATEGORIES[category]) {
    return sock.sendMessage(chatId, { text: `❌ Catégorie inconnue.\n\n${formatCategories()}` });
  }

  try {
    const game = createGame(chatId, player, category, total, sock);
    return sock.sendMessage(chatId, { text: `🎮 Partie de *${total} questions* lancée dans la catégorie *${CATEGORIES[category]}*.\n\n${formatQuestion(game)}` });
  } catch (error) {
    console.error('[quiz]', error);
    return sock.sendMessage(chatId, { text: '❌ Impossible de charger cette catégorie pour le moment.' });
  }
}

ovlcmd({
  nom_cmd: 'quiz',
  classe: 'Jeux',
  react: '🧠',
  desc: 'Quiz anime, culture générale, football, films d’horreur, K-pop et musique, en 10, 30, 60 ou 100 questions.',
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

module.exports = {
  activeQuizzes,
  scores,
  loadQuestions,
  CATEGORIES,
  answerQuiz,
  runQuizCommand
};
