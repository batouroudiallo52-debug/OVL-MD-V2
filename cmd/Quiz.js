'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { ovlcmd } = require('../lib/ovlcmd');

const QUESTIONS_FILE = path.join(__dirname, '..', 'lib', 'quiz_questions.json');
const TRUE_FALSE_FILE = path.join(__dirname, '..', 'lib', 'quiz_true_false.json');
const TRUE_FALSE_CATEGORY = 'vrai-faux';
const TRUE_FALSE_ALIASES = ['vrai', 'faux', 'vrai-faux', 'vraifaux', 'truefalse', 'tf'];
const activeQuizzes = new Map();
const pendingQuizSelections = new Map();
const scores = new Map();
// Historique des questions utilisées par conversation, catégorie et mode.
// Il empêche les quiz successifs de reprendre une question déjà jouée.
const quizHistory = new Map();
const QUESTION_LIMITS = [10, 20, 30, 50, 100];
const QUESTION_SELECTIONS = new Map([
  ['1', 10],
  ['2', 20],
  ['3', 30],
  ['4', 50],
  ['5', 100]
]);
const ANSWER_TIMEOUT = 15_000;
const IMAGE_SEARCH_TIMEOUT = 8_000;
const imageSearchCache = new Map();

// Images thématiques utilisées lorsque la partie est lancée avec l’option « image ».
// Une question peut aussi fournir sa propre propriété « image » dans le JSON.
const CATEGORY_IMAGES = {
  anime: 'https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&w=1200&q=80',
  culture: 'https://images.unsplash.com/photo-1523731407965-2430cd12f5e4?auto=format&fit=crop&w=1200&q=80',
  foot: 'https://images.unsplash.com/photo-1579952363873-27f3bade9f55?auto=format&fit=crop&w=1200&q=80',
  horreur: 'https://images.unsplash.com/photo-1509248961158-e54f6934749c?auto=format&fit=crop&w=1200&q=80',
  kpop: 'https://images.unsplash.com/photo-1524368535928-5b5e00ddc76b?auto=format&fit=crop&w=1200&q=80',
  musique: 'https://images.unsplash.com/photo-1516280440614-37939bbacd81?auto=format&fit=crop&w=1200&q=80',
  films: 'https://images.unsplash.com/photo-1485846234645-a62644f84728?auto=format&fit=crop&w=1200&q=80',
  geographie: 'https://images.unsplash.com/photo-1526778548025-fa2f459cd5c1?auto=format&fit=crop&w=1200&q=80',
  histoire: 'https://images.unsplash.com/photo-1461360370896-922624d12aa1?auto=format&fit=crop&w=1200&q=80',
  litterature: 'https://images.unsplash.com/photo-1507842217343-583bb7270b66?auto=format&fit=crop&w=1200&q=80',
  nature: 'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?auto=format&fit=crop&w=1200&q=80',
  sciences: 'https://images.unsplash.com/photo-1532094349884-543bc11b234d?auto=format&fit=crop&w=1200&q=80',
  technologie: 'https://images.unsplash.com/photo-1518770660439-4636190af475?auto=format&fit=crop&w=1200&q=80'
};

// Catégories disponibles pour les parties de quiz.
const CATEGORIES = {
  mix: 'Toutes catégories',
  anime: 'Anime',
  culture: 'Culture générale',
  foot: 'Football',
  horreur: 'Films d’horreur',
  kpop: 'K-pop',
  musique: 'Musique',
  films: 'Films',
  geographie: 'Géographie',
  histoire: 'Histoire',
  litterature: 'Littérature',
  nature: 'Nature',
  sciences: 'Sciences',
  technologie: 'Technologie'
};

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function questionKey(value) {
  return normalize(value)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function historyKey(chatId, category, mode) {
  return `${chatId}:${mode}:${category}`;
}

function getFreshQuestions(chatId, category, mode) {
  const questions = loadQuestions(category, mode);
  const used = quizHistory.get(historyKey(chatId, category, mode)) || new Set();
  return questions.filter((question) => !used.has(questionKey(question.question)));
}

function reserveQuestions(chatId, category, mode, questions) {
  const key = historyKey(chatId, category, mode);
  const used = quizHistory.get(key) || new Set();
  for (const question of questions) used.add(questionKey(question.question));
  quizHistory.set(key, used);
}

function isTrueFalseCategory(value) {
  return TRUE_FALSE_ALIASES.includes(normalize(value));
}

function isImageUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value.trim());
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

function firstImageValue(question) {
  // Les données peuvent fournir image, imageUrl, image_url ou images[].
  const candidates = [
    question?.image,
    question?.imageUrl,
    question?.image_url,
    ...(Array.isArray(question?.images) ? question.images : [])
  ];
  return candidates.find(isImageUrl) || null;
}

function imageSearchQuery(question, category) {
  // imageQuery permet de demander explicitement un sujet d’image dans le JSON.
  const explicitQuery = question?.imageQuery || question?.image_query;
  if (typeof explicitQuery === 'string' && explicitQuery.trim()) return explicitQuery.trim();

  const answer = question?.options?.[Number(question.answer) - 1];
  return [answer, category].filter(Boolean).join(' ');
}

async function findQuestionImage(question, category) {
  const directImage = firstImageValue(question);
  if (directImage) return directImage;

  const query = imageSearchQuery(question, category);
  const cacheKey = normalize(query);
  if (!cacheKey) return CATEGORY_IMAGES[category] || null;
  if (imageSearchCache.has(cacheKey)) return imageSearchCache.get(cacheKey);

  const request = axios.get('https://commons.wikimedia.org/w/api.php', {
    timeout: IMAGE_SEARCH_TIMEOUT,
    params: {
      action: 'query',
      generator: 'search',
      gsrsearch: query,
      gsrnamespace: 6,
      gsrlimit: 5,
      prop: 'imageinfo',
      iiprop: 'url|mime',
      iiurlwidth: 1200,
      format: 'json',
      origin: '*'
    },
    headers: { 'User-Agent': 'OVL-MD-V2/2.1 (quiz image search)' }
  }).then(({ data }) => {
    const pages = Object.values(data?.query?.pages || {});
    const image = pages.find((page) => {
      const info = page?.imageinfo?.[0];
      return info && /^image\/(jpeg|png|webp)$/i.test(info.mime || '') && isImageUrl(info.thumburl || info.url);
    });
    return image?.imageinfo?.[0]?.thumburl || image?.imageinfo?.[0]?.url || null;
  }).catch((error) => {
    console.error('[quiz image search]', query, error.message);
    return null;
  });

  imageSearchCache.set(cacheKey, request);
  const foundImage = await request;
  return foundImage || CATEGORY_IMAGES[category] || null;
}

function loadQuestions(category, mode = 'classic') {
  const file = mode === 'true-false' ? TRUE_FALSE_FILE : QUESTIONS_FILE;
  const questions = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(questions)) throw new Error('La banque de questions est invalide.');
  const filtered = questions.filter((item) => (
    item && typeof item.question === 'string' && item.question.trim() &&
    Array.isArray(item.options) && item.options.length === (mode === 'true-false' ? 2 : 4) &&
    item.options.every((option) => typeof option === 'string' && option.trim()) &&
    Number.isInteger(item.answer) && item.answer >= 1 && item.answer <= (mode === 'true-false' ? 2 : 4) &&
    (mode === 'true-false' || (CATEGORIES[item.category] && (!category || category === 'mix' || item.category === category)))
  ));
  if (!filtered.length) throw new Error(`Aucune question disponible pour ${category || 'cette catégorie'}.`);

  // Évite les doublons présents dans la banque, indépendamment de la casse
  // ou des espaces superflus dans le texte de la question.
  const uniqueQuestions = new Map();
  for (const item of filtered) {
    const key = questionKey(item.question);
    if (!uniqueQuestions.has(key)) uniqueQuestions.set(key, item);
  }
  return [...uniqueQuestions.values()];
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
  if (['mix', 'mixed', 'toutes', 'toutes categories', 'aleatoire', 'aléatoire'].includes(category)) return 'mix';
  if (category === 'culture generale' || category === 'general' || category === 'culture') return 'culture';
  if (category === 'films horreur' || category === 'films dhorreur' || category === 'horreur') return 'horreur';
  if (category === 'football' || category === 'foot') return 'foot';
  if (category === 'film' || category === 'films') return 'films';
  if (category === 'géographie' || category === 'geographie' || category === 'geography') return 'geographie';
  if (category === 'histoire' || category === 'history') return 'histoire';
  if (category === 'littérature' || category === 'litterature' || category === 'literature') return 'litterature';
  if (category === 'nature') return 'nature';
  if (category === 'sciences' || category === 'science') return 'sciences';
  if (category === 'technologie' || category === 'technology' || category === 'tech') return 'technologie';
  if (category === 'k-pop' || category === 'kpop') return 'kpop';
  if (category === 'musique' || category === 'music') return 'musique';
  return category;
}

function formatCategories() {
  return Object.entries(CATEGORIES)
    .map(([key, label]) => `• *.quiz ${key} 10* — ${label}`)
    .join('\n');
}

function formatQuestionSelections(maxQuestions = Infinity) {
  return [...QUESTION_SELECTIONS.entries()]
    .filter(([, total]) => total <= maxQuestions)
    .map(([key, total]) => `*${key}* — ${total} questions`)
    .join('\n');
}

function formatQuestion(game) {
  const options = game.question.options
    .map((option, index) => `   *${index + 1}.* ${option}`)
    .join('\n');
  return `🧠 *QUIZ ${(game.mode === 'true-false' ? 'VRAI/FAUX' : CATEGORIES[game.category]).toUpperCase()}*\nQuestion *${game.index}/${game.total}*\n\n${game.question.question}\n\n${options}\n\nRéponds uniquement avec le chiffre correspondant : *${game.mode === 'true-false' ? '1 ou 2' : '1, 2, 3 ou 4'}*.\n⏱️ Temps limite : *15 secondes*.\n✅ Une seule bonne réponse est comptabilisée et rapporte *1 point*.`;
}

function playerLabel(player) {
  return `@${String(player).split('@')[0]}`;
}

async function sendQuestion(chatId, sock, game) {
  const text = formatQuestion(game);
  if (!game.imageMode || game.mode === 'true-false') return sock.sendMessage(chatId, { text });
  try {
    const image = await findQuestionImage(game.question, game.category);
    if (!image) throw new Error('Aucune image trouvée');
    return await sock.sendMessage(chatId, {
      image: { url: image },
      caption: `🖼️ ${text}`
    });
  } catch (error) {
    console.error('[quiz image]', error.message);
    return sock.sendMessage(chatId, {
      text: `⚠️ L’image n’a pas pu être chargée. Voici la question sans image :\n\n${text}`
    });
  }
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

function shuffleQuestions(questions) {
  const shuffled = [...questions];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[index]];
  }
  return shuffled;
}

function chooseQuestion(game) {
  const question = game.questionQueue[game.index - 1];
  if (!question) throw new Error('La file de questions uniques est épuisée.');
  const key = questionKey(question.question);
  if (game.used.has(key)) throw new Error('Une question du quiz serait répétée.');
  game.used.add(key);
  return question;
}

function createGame(chatId, player, category, total, imageMode, sock, mode = 'classic') {
  const pool = getFreshQuestions(chatId, category, mode);
  if (total > pool.length) {
    throw new Error(`Cette partie demande ${total} nouvelles questions, mais seulement ${pool.length} restent inédites dans cette conversation.`);
  }
  const questionQueue = shuffleQuestions(pool).slice(0, total);
  reserveQuestions(chatId, category, mode, questionQueue);
  const game = {
    category,
    mode,
    total,
    imageMode,
    index: 1,
    pool,
    questionQueue,
    used: new Set(),
    question: null,
    answers: new Map(),
    participants: new Set([player]),
    resolving: false,
    timer: null
  };
  game.question = chooseQuestion(game);
  activeQuizzes.set(chatId, game);
  return game;
}

function parseTotal(args) {
  const requested = args.map(normalize).find((arg) => QUESTION_LIMITS.includes(Number(arg)));
  return requested ? Number(requested) : 10;
}

function hasImageOption(args) {
  return args.some((arg) => ['image', 'images', 'img', 'photo', 'photos'].includes(normalize(arg)));
}

function parseCategory(args) {
  const candidate = args.find((arg) => (
    !QUESTION_LIMITS.includes(Number(normalize(arg))) &&
    !['image', 'images', 'img', 'photo', 'photos'].includes(normalize(arg)) &&
    !isTrueFalseCategory(arg)
  ));
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
  const winner = [...game.answers.entries()]
    .find(([, answer]) => answer === correctAnswer)?.[0] || null;

  for (const [player] of game.answers) {
    getGlobalScore(chatId, player).attempts += 1;
  }
  if (winner) getGlobalScore(chatId, winner).points += 1;

  let result;
  if (winner) {
    result = `✅ ${playerLabel(winner)} a trouvé la bonne réponse et gagne *1 point* !\n🎯 Réponse : *${correctAnswer} — ${correctText}*`;
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
  await sock.sendMessage(chatId, { text: result });
  try {
    await sendQuestion(chatId, sock, game);
  } finally {
    // Le délai commence après l’envoi effectif de la question, pas pendant
    // la recherche ou le téléchargement éventuel de son image.
    game.resolving = false;
    scheduleRoundTimeout(chatId, sock, game);
  }
}

async function answerQuiz(chatId, sock, player, answer) {
  const game = activeQuizzes.get(chatId);
  if (!game || game.resolving) return false;

  const normalizedAnswer = normalize(answer);
  const selectedAnswer = game.mode === 'true-false'
    ? (['vrai', 'true', '1'].includes(normalizedAnswer) ? 1 : ['faux', 'false', '2'].includes(normalizedAnswer) ? 2 : null)
    : (/^[1-4]$/.test(String(answer).trim()) ? Number(answer) : null);
  if (!selectedAnswer || !Number.isInteger(selectedAnswer) || selectedAnswer < 1 || selectedAnswer > (game.mode === 'true-false' ? 2 : 4)) return false;
  if (game.answers.has(player)) return true;

  game.participants.add(player);
  game.answers.set(player, selectedAnswer);

  if (selectedAnswer === game.question.answer) {
    await revealRound(chatId, sock, game, 'correct');
    return true;
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

  const currentGame = activeQuizzes.get(chatId);
  if (currentGame && (currentGame.mode === 'true-false' ? ['vrai', 'faux', 'true', 'false', '1', '2'].includes(firstArg) : /^[1-4]$/.test(firstArg))) {
    return answerQuiz(chatId, sock, player, firstArg);
  }

  const pendingSelection = pendingQuizSelections.get(chatId);
  if (pendingSelection && QUESTION_SELECTIONS.has(firstArg)) {
    pendingQuizSelections.delete(chatId);
    try {
      const total = QUESTION_SELECTIONS.get(firstArg);
      const game = createGame(chatId, pendingSelection.player, pendingSelection.category, total, pendingSelection.imageMode, sock, pendingSelection.mode);
      await sock.sendMessage(chatId, {
        text: `✅ Sélection validée : *${total} questions*.\n\nRéponds uniquement avec *1*, *2*, *3* ou *4*. Chaque question a une limite de *15 secondes*.`
      });
      await sendQuestion(chatId, sock, game);
      scheduleRoundTimeout(chatId, sock, game);
      return;
    } catch (error) {
      console.error('[quiz selection]', error);
      return sock.sendMessage(chatId, { text: '❌ Impossible de démarrer cette catégorie pour le moment.' });
    }
  }

  if (!firstArg || ['aide', 'help', 'categories', 'catégories'].includes(firstArg)) {
    return sock.sendMessage(chatId, {
      text: `🧠 *QUIZ — CATÉGORIES DISPONIBLES*\n\n${formatCategories()}\n\nLance une catégorie avec *.quiz anime*. Le bot te demandera ensuite le nombre de questions.\n\n*.quiz score* — voir les scores\n*.quiz stop* — arrêter la partie`
    });
  }

  if (['stop', 'arret', 'arrêt', 'cancel'].includes(firstArg)) {
    const game = activeQuizzes.get(chatId);
    if (game) clearRoundTimer(game);
    activeQuizzes.delete(chatId);
    pendingQuizSelections.delete(chatId);
    return sock.sendMessage(chatId, { text: '🛑 Quiz arrêté.' });
  }

  if (['score', 'scores', 'classement'].includes(firstArg)) return showScore(chatId, sock);

  if (activeQuizzes.has(chatId)) {
    return sock.sendMessage(chatId, { text: '⚠️ Un quiz est déjà en cours. Réponds avec *1*, *2*, *3* ou *4*, ou utilise *.quiz stop*.' });
  }

  const trueFalseMode = isTrueFalseCategory(firstArg);
  const category = parseCategory(args);
  const imageMode = hasImageOption(args);
  if (!trueFalseMode && !CATEGORIES[category]) {
    return sock.sendMessage(chatId, { text: `❌ Catégorie inconnue.\n\n${formatCategories()}\n\nMode spécial : *.quiz vrai-faux*` });
  }

  const availableQuestions = getFreshQuestions(
    chatId,
    trueFalseMode ? TRUE_FALSE_CATEGORY : category,
    trueFalseMode ? 'true-false' : 'classic'
  ).length;
  const selectionText = formatQuestionSelections(availableQuestions);
  if (!selectionText) {
    return sock.sendMessage(chatId, {
      text: `❌ Il ne reste que *${availableQuestions} question(s) inédite(s)* dans cette catégorie. Il en faut au moins 10 pour démarrer un nouveau quiz sans répétition.`
    });
  }

  pendingQuizSelections.set(chatId, {
    category: trueFalseMode ? TRUE_FALSE_CATEGORY : category,
    mode: trueFalseMode ? 'true-false' : 'classic',
    imageMode,
    player,
    sock
  });
  return sock.sendMessage(chatId, {
    text: `🎮 *${trueFalseMode ? 'Vrai/Faux' : CATEGORIES[category]}*\n\nCombien de questions veux-tu ?\n\n${selectionText}\n\nLes questions ne sont jamais répétées dans cette partie ni dans tes quiz précédents de cette catégorie.\n\nRéponds uniquement avec le numéro correspondant.`
  });
}

ovlcmd({
  nom_cmd: 'quiz',
  classe: 'Jeux',
  react: '🧠',
  desc: 'Quiz à choix multiples : sélection 10/20/30/50/100 questions, sans répétition entre les quiz, réponses 1-4 et 15 secondes par question.',
  alias: ['quizz']
}, runQuizCommand);

// Réception des réponses seules « 1 », « 2 » ou « 3 » pour la sélection,
// puis « 1 », « 2 », « 3 » ou « 4 » pour les questions.
ovlcmd({
  nom_cmd: 'quiz_answer',
  isfunc: true,
  react: '🧠',
  desc: 'Traite les réponses numériques d’une partie de quiz en cours.'
}, async (jid, sock, context = {}) => {
  const chatId = getChatId(context, jid);
  const raw = getRawText(context);
  const answer = raw.match(/^(1|2|3|4|5|vrai|faux|true|false)$/i)?.[0];
  if (!answer) return;

  const pending = pendingQuizSelections.get(chatId);
  if (pending && QUESTION_SELECTIONS.has(answer)) {
    pendingQuizSelections.delete(chatId);
    try {
      const total = QUESTION_SELECTIONS.get(answer);
      const game = createGame(chatId, pending.player, pending.category, total, pending.imageMode, sock, pending.mode);
      await sock.sendMessage(chatId, {
        text: `✅ Sélection validée : *${total} questions*.\n\nRéponds uniquement avec *1*, *2*, *3* ou *4*. Chaque question a une limite de *15 secondes*.`
      });
      await sendQuestion(chatId, sock, game);
      scheduleRoundTimeout(chatId, sock, game);
    } catch (error) {
      console.error('[quiz selection]', error);
      await sock.sendMessage(chatId, { text: '❌ Impossible de démarrer cette catégorie pour le moment.' });
    }
    return;
  }

  if (!activeQuizzes.has(chatId)) return;
  await answerQuiz(chatId, sock, getSender(context), answer);
});

module.exports = {
  activeQuizzes,
  pendingQuizSelections,
  scores,
  quizHistory,
  loadQuestions,
  CATEGORIES,
  findQuestionImage,
  imageSearchQuery,
  answerQuiz,
  runQuizCommand
};
