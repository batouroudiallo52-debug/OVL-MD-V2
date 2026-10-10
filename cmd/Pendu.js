'use strict';

const { ovlcmd } = require('../lib/ovlcmd');

const MAX_WRONG_GUESSES = 6;
const activeGames = new Map();
const usedWords = new Set();
const WORDS = [
  'ALGORITHME', 'AVENTURE', 'BIBLIOTHEQUE', 'CHOCOLAT', 'DROMADAIRE',
  'ELECTRICITE', 'EXPLORATEUR', 'FANTASTIQUE', 'GIRAFE', 'HARMONIE',
  'IMAGINATION', 'JARDIN', 'KANGOUROU', 'LUMIERE', 'MONTAGNE',
  'NAVIGATEUR', 'ORDINATEUR', 'PHOTOGRAPHIE', 'QUESTION', 'RESTAURANT',
  'SCULPTURE', 'TELEPHONE', 'UNIVERS', 'VOLCAN', 'WAGON', 'XYLOPHONE',
  'YOGOURT', 'ZOOLOGIE', 'ASTRONAUTE', 'CASCADE', 'DINOSAURE',
  'ENCYCLOPEDIE', 'FROMAGE', 'GUITARE', 'HISTOIRE', 'INVENTION',
  'LIBELLULE', 'MYSTERE', 'PAPILLON', 'TRESOR', 'VILLAGE'
];

const HANGMAN_STAGES = [
  ['  +---+', '  |   |', '      |', '      |', '      |', '========='],
  ['  +---+', '  |   |', '  O   |', '      |', '      |', '========='],
  ['  +---+', '  |   |', '  O   |', '  |   |', '      |', '========='],
  ['  +---+', '  |   |', '  O   |', ' /|   |', '      |', '========='],
  ['  +---+', '  |   |', '  O   |', ' /|\\  |', '      |', '========='],
  ['  +---+', '  |   |', '  O   |', ' /|\\  |', ' /    |', '========='],
  ['  +---+', '  |   |', '  O   |', ' /|\\  |', ' / \\  |', '=========']
];

function normalizeWord(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();
}

function normalizeLetter(value) {
  const normalized = normalizeWord(value).trim();
  return /^[A-Z]$/.test(normalized) ? normalized : null;
}

function getNextWord() {
  let available = WORDS.filter((word) => !usedWords.has(word));
  if (!available.length) {
    usedWords.clear();
    available = [...WORDS];
  }
  const word = available[Math.floor(Math.random() * available.length)];
  usedWords.add(word);
  return word;
}

function getChatId(context, fallback) {
  return context?.chatId || context?.jid || context?.ms?.key?.remoteJid || fallback;
}

function getSender(context) {
  return context?.auteur_Message || context?.sender || context?.participant || 'joueur';
}

function getRawText(context) {
  const candidates = [
    context?.body,
    context?.text,
    context?.messageText,
    context?.content,
    context?.ms?.message?.conversation,
    context?.ms?.message?.extendedTextMessage?.text
  ];
  return candidates.find((value) => typeof value === 'string')?.trim() || '';
}

function maskWord(game) {
  return Array.from(game.word, (letter) => {
    if (!/[A-Za-zÀ-ÖØ-öø-ÿ]/u.test(letter)) return letter;
    return game.guessedLetters.has(normalizeLetter(letter)) ? letter : '＿';
  }).join(' ');
}

function formatGame(game, notice = '') {
  const wrongCount = game.wrongLetters.length;
  const guessed = [...game.guessedLetters].join(', ') || 'aucune';
  const remaining = MAX_WRONG_GUESSES - wrongCount;
  return `${notice ? `${notice}\n\n` : ''}🎮 *PENDU*\n\nMot : ${maskWord(game)}\n\nLettres proposées : ${guessed}\nErreurs restantes : *${remaining}*\n\n\`\`\`\n${HANGMAN_STAGES[wrongCount].join('\n')}\n\`\`\`\n\nEnvoie une lettre seule pour proposer. Tape *.pendu stop* pour arrêter la partie.`;
}

function createGame(chatId, player) {
  const game = {
    word: getNextWord(),
    guessedLetters: new Set(),
    wrongLetters: [],
    startedBy: player,
    createdAt: Date.now()
  };
  activeGames.set(chatId, game);
  return game;
}

function isWon(game) {
  return Array.from(game.word).every((letter) => (
    !/[A-Za-zÀ-ÖØ-öø-ÿ]/u.test(letter) || game.guessedLetters.has(normalizeLetter(letter))
  ));
}

async function applyGuess(chatId, sock, rawGuess) {
  const game = activeGames.get(chatId);
  if (!game) return false;

  const letter = normalizeLetter(rawGuess);
  if (!letter) return false;
  if (game.guessedLetters.has(letter)) {
    await sock.sendMessage(chatId, { text: `Cette lettre a déjà été proposée : *${letter}*.\n\n${formatGame(game)}` });
    return true;
  }

  game.guessedLetters.add(letter);
  if (!normalizeWord(game.word).includes(letter)) game.wrongLetters.push(letter);

  if (isWon(game)) {
    activeGames.delete(chatId);
    await sock.sendMessage(chatId, {
      text: `🎉 *Bravo, le mot a été trouvé !*\n\nLe mot était : *${game.word}*\nLettres incorrectes : ${game.wrongLetters.length}/${MAX_WRONG_GUESSES}.`
    });
    return true;
  }

  if (game.wrongLetters.length >= MAX_WRONG_GUESSES) {
    activeGames.delete(chatId);
    await sock.sendMessage(chatId, {
      text: `💀 *Partie terminée !*\n\nLe mot était : *${game.word}*.\nEssaie encore avec *.pendu*.`
    });
    return true;
  }

  const notice = normalizeWord(game.word).includes(letter)
    ? `✅ La lettre *${letter}* est dans le mot !`
    : `❌ La lettre *${letter}* n’est pas dans le mot.`;
  await sock.sendMessage(chatId, { text: formatGame(game, notice) });
  return true;
}

async function runPenduCommand(jid, sock, context = {}) {
  const chatId = getChatId(context, jid);
  const args = Array.isArray(context?.arg)
    ? context.arg.map(String)
    : typeof context?.arg === 'string'
      ? context.arg.trim().split(/\s+/).filter(Boolean)
      : [];
  const action = normalizeWord(args[0] || '');

  if (['STOP', 'ARRET', 'ARRÊT', 'CANCEL'].includes(action)) {
    if (!activeGames.has(chatId)) {
      return sock.sendMessage(chatId, { text: 'Aucune partie de pendu n’est en cours.' });
    }
    activeGames.delete(chatId);
    return sock.sendMessage(chatId, { text: '🛑 Partie de pendu arrêtée.' });
  }

  if (action === 'AIDE' || action === 'HELP') {
    return sock.sendMessage(chatId, {
      text: '🎮 *JEU DU PENDU*\n\nLance *.pendu*, puis envoie une lettre à la fois. Le groupe dispose de 6 erreurs. Tape *.pendu stop* pour arrêter.'
    });
  }

  const existing = activeGames.get(chatId);
  if (existing) {
    return sock.sendMessage(chatId, { text: `Une partie est déjà en cours.\n\n${formatGame(existing)}` });
  }

  const game = createGame(chatId, getSender(context));
  return sock.sendMessage(chatId, { text: formatGame(game, 'Devinez le mot, lettre par lettre !') });
}

ovlcmd({
  nom_cmd: 'pendu',
  classe: 'Jeux',
  react: '🪢',
  desc: 'Lance une partie du pendu dans la conversation : trouvez le mot avant 6 erreurs.',
  alias: ['hangman']
}, runPenduCommand);

ovlcmd({
  nom_cmd: 'pendu_answer',
  isfunc: true,
  react: '🔤',
  desc: 'Traite les propositions de lettres pendant une partie de pendu.'
}, async (jid, sock, context = {}) => {
  const chatId = getChatId(context, jid);
  if (!activeGames.has(chatId)) return;

  const raw = getRawText(context);
  const prefix = typeof context?.prefixe === 'string' ? context.prefixe : '';
  if (!raw || (prefix && raw.startsWith(prefix))) return;
  const letter = normalizeLetter(raw);
  if (!letter) return;
  await applyGuess(chatId, sock, letter);
});

module.exports = {
  activeGames,
  WORDS,
  MAX_WRONG_GUESSES,
  normalizeWord,
  normalizeLetter,
  maskWord,
  formatGame,
  createGame,
  applyGuess,
  runPenduCommand
};
