// Le Quai joue — logique dynamique du site public.
// Modèle v7 : une information inconnue reste inconnue et les contextes
// « aujourd’hui » / « prochain rendez-vous » restent indépendants.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signInAnonymously } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js';
import {
  getDatabase, onValue, push, ref, set, update
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js';
import {
  parisParts, timestampForParisDateTime, parisDateKey, todayEventKey,
  endOfParisDay, isSameParisDay, formatClock, formatEvent, active,
  effectiveEventAt, isCancelledOccurrence
} from './quai-common.js';

const firebaseConfig = {
  apiKey: 'AIzaSyDI7PBoU_zCIyBq1YtsBSywRYs5ByUPmLw',
  authDomain: 'le-quai-joue.firebaseapp.com',
  databaseURL: 'https://le-quai-joue-default-rtdb.europe-west1.firebasedatabase.app',
  projectId: 'le-quai-joue',
  storageBucket: 'le-quai-joue.firebasestorage.app',
  messagingSenderId: '623424877513',
  appId: '1:623424877513:web:4f6753430f929658a66e18'
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const database = getDatabase(app);
const WORKER_URL = 'https://le-quai-joue-notifications.brice-grisly.workers.dev';
const SITE_URL = 'https://bricedelhaye-dev.github.io/';
const ROOT = 'v7';

const SEARCH_MINUTES = 25;
const GAME_NEED_MINUTES = 20;
const INTENTION_GRACE_MINUTES = 120;
const RECENT_INTENTION_MINUTES = 45;
const LATE_INTENTION_MINUTES = INTENTION_GRACE_MINUTES;
const FIRST_NAME_KEY = 'lqj.firstName';
const NAMED_CONTEXTS_KEY = 'lqj.namedContexts.v7';
const $ = (id) => document.getElementById(id);

let currentUser = null;
let allPresence = {};
let allGameNeeds = {};
let myPresence = null;
let rendezvous = null;
let briceByContext = {};
let intentionsByEvent = {};
let intentionUnsubs = new Map();
let unsub = [];
let busy = false;
let pendingNotify = null;
let lastNotifyRetryAt = 0;
let readState = { presence: false, gameNeeds: false, rendezvous: false, brice: false };
let loadedIntentionKeys = new Set();
let publicReadError = false;

// ---------------------------------------------------------------------------
// Temps
// ---------------------------------------------------------------------------
function roundedTime(minutesAhead) {
  const date = new Date(Date.now() + minutesAhead * 60_000);
  date.setMinutes(Math.ceil(date.getMinutes() / 15) * 15, 0, 0);
  return date.getTime();
}

function nowSuggestions() {
  return [...new Set([45, 90, 150, 240].map(roundedTime))]
    .filter((ts) => ts <= Date.now() + 12 * 3600_000);
}

function arrivalSuggestions(dateTs = Date.now()) {
  if (!isSameParisDay(dateTs, Date.now())) {
    const base = Number(dateTs);
    return [...new Set([-30, 0, 30, 60].map((m) => base + m * 60_000))]
      .filter((ts) => ts > Date.now());
  }
  const out = [];
  const p = parisParts();
  const currentMinutes = (Number(p.hour) % 24) * 60 + Number(p.minute);
  const firstMinutes = Math.ceil((currentMinutes + 1) / 30) * 30;
  for (let i = 0; i < 6; i += 1) {
    const minutes = firstMinutes + i * 30;
    if (minutes >= 24 * 60) break;
    const t = timestampForParisDateTime(
      Number(p.year), Number(p.month), Number(p.day),
      Math.floor(minutes / 60), minutes % 60
    );
    if (t > Date.now() && t <= endOfParisDay()) out.push(t);
  }
  return out.length ? out : [roundedTime(60), roundedTime(120), roundedTime(180)]
    .filter((ts) => ts <= endOfParisDay());
}

function timestampFromInput(value, maxHours, dateTs = Date.now()) {
  if (!value) return null;
  const [h, m] = value.split(':').map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  const p = parisParts(dateTs);
  const ts = timestampForParisDateTime(Number(p.year), Number(p.month), Number(p.day), h, m);
  const check = parisParts(ts);
  if ((Number(check.hour) % 24) !== h || Number(check.minute) !== m) return null;
  if (ts <= Date.now()) return null;
  if (ts > Date.now() + maxHours * 3600_000) return null;
  return ts;
}

// ---------------------------------------------------------------------------
// Interface et dialogues
// ---------------------------------------------------------------------------
function toast(message, action = null) {
  const el = $('toast');
  if (!el) return;
  const text = $('toastText');
  const button = $('toastAction');
  if (text) text.textContent = message;
  else el.textContent = message;
  if (button) {
    button.hidden = !action;
    button.textContent = action?.label || '';
    button.onclick = action ? async () => {
      button.disabled = true;
      try { await action.onClick(); }
      finally { button.disabled = false; el.hidden = true; }
    } : null;
  }
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, action?.timeout || 4200);
}

function setBusy(value) {
  busy = value;
  document.querySelectorAll('[data-locks]').forEach((button) => { button.disabled = value; });
}

function closeDialog(el) {
  if (el && typeof el.close === 'function' && el.open) el.close();
}

const dialogSessions = new WeakMap();
function beginDialog(dialog, resolve) {
  const previous = dialogSessions.get(dialog);
  if (previous) previous(null, true);
  let settled = false;

  const cleanup = (finish, onClose) => {
    dialog.removeEventListener('close', onClose);
    if (dialogSessions.get(dialog) === finish) dialogSessions.delete(dialog);
  };

  const onClose = () => {
    if (settled) return;
    settled = true;
    cleanup(finish, onClose);
    resolve(null);
  };

  const finish = (value, close = true) => {
    if (settled) return;
    settled = true;
    cleanup(finish, onClose);

    // Attendre la fermeture effective avant de résoudre évite qu'une nouvelle
    // question réutilise le même <dialog> pendant que l'ancien événement
    // « close » est encore en attente dans la file du navigateur.
    if (close && dialog.open && typeof dialog.close === 'function') {
      const afterClose = () => resolve(value);
      dialog.addEventListener('close', afterClose, { once: true });
      dialog.close();
      return;
    }
    if (close) closeDialog(dialog);
    resolve(value);
  };

  dialog.addEventListener('close', onClose);
  dialogSessions.set(dialog, finish);
  return finish;
}

function askChoice({ title, copy = '', options }) {
  return new Promise((resolve) => {
    const dialog = $('choiceDialog');
    const finish = beginDialog(dialog, resolve);
    $('choiceTitle').textContent = title;
    const copyEl = $('choiceCopy');
    copyEl.textContent = copy;
    copyEl.hidden = !copy;
    const box = $('choiceOptions');
    box.innerHTML = '';
    options.forEach((opt) => {
      const button = document.createElement('button');
      button.type = 'button';
      // Aucun choix n'est présenté comme la « bonne » réponse.
      button.className = 'dialog-option';
      button.textContent = opt.label;
      button.addEventListener('click', () => finish(opt.value));
      box.appendChild(button);
    });
    if (typeof dialog.showModal === 'function') dialog.showModal();
    box.querySelector('button')?.focus();
  });
}

function askTime({ title, copy = '', suggestions, maxHours = 12, dateTs = Date.now() }) {
  return new Promise((resolve) => {
    const dialog = $('timeDialog');
    const finish = beginDialog(dialog, resolve);
    $('timeTitle').textContent = title;
    const copyEl = $('timeCopy');
    copyEl.textContent = copy;
    copyEl.hidden = !copy;
    const grid = $('timeChoices');
    grid.innerHTML = '';
    (suggestions?.length ? suggestions : arrivalSuggestions(dateTs)).forEach((ts) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'time-choice';
      button.textContent = `Vers ${formatClock(ts)}`;
      button.addEventListener('click', () => finish(ts));
      grid.appendChild(button);
    });
    const input = $('timeCustomInput');
    input.value = '';
    $('timeCustomButton').onclick = () => {
      const ts = timestampFromInput(input.value, maxHours, dateTs);
      if (!ts) { toast('Choisissez une heure ultérieure valide.'); return; }
      finish(ts);
    };
    if (typeof dialog.showModal === 'function') dialog.showModal();
    grid.querySelector('button')?.focus();
  });
}

function askText({ title, copy = '', placeholder = '', maxLength = 500, submitLabel = 'Valider', optional = true, prefill = '', skipLabel = 'Sans prénom', inputMode = 'text' }) {
  return new Promise((resolve) => {
    const dialog = $('textDialog');
    const finish = beginDialog(dialog, resolve);
    $('textTitle').textContent = title;
    const copyEl = $('textCopy');
    copyEl.textContent = copy;
    copyEl.hidden = !copy;
    const field = $('textField');
    field.value = prefill;
    field.maxLength = maxLength;
    field.placeholder = placeholder;
    field.inputMode = inputMode;
    field.classList.toggle('is-number', inputMode === 'numeric');
    $('textSubmit').textContent = submitLabel;
    const skip = $('textSkip');
    skip.textContent = skipLabel;
    skip.hidden = !optional;
    $('textSubmit').onclick = () => {
      const value = field.value.trim();
      if (!value && !optional) { toast('Écrivez votre message.'); field.focus(); return; }
      finish(value);
    };
    skip.onclick = () => finish('');
    if (typeof dialog.showModal === 'function') dialog.showModal();
    field.focus();
  });
}


function visitTimeInputValue(ts) {
  if (ts === null || ts === '' || !Number.isFinite(Number(ts))) return '';
  const parts = parisParts(Number(ts));
  return `${String(Number(parts.hour) % 24).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

function visitCompanyFromEntry(entry) {
  if (!entry) return null;
  const people = Number(entry.peopleCount) || 1;
  if (entry.group === true || people >= 3) return 'group';
  return people === 2 ? 'pair' : 'solo';
}

function visitGamesFromEntry(entry, actual = false) {
  if (!entry) return null;
  if (actual) {
    if (entry.hasGameKnown !== true) return null;
    return entry.hasGame === true ? 'yes' : 'none';
  }
  if (entry.gamesKnown === false) return entry.gamesMultiple === true ? 'many' : 'unknown';
  const count = Number(entry.gamesCount) || 0;
  return count === 0 ? 'none' : count === 1 ? 'one' : 'many';
}

function publicPlannedPreview(state, returning = false) {
  if (!state.time || !state.company || !state.games) return 'Faites vos choix pour voir le message.';
  const when = isSameParisDay(state.time, Date.now())
    ? `vers ${formatClock(state.time)}`
    : formatEvent(state.time);
  let first;
  if (state.company === 'solo') first = `Une personne pense ${returning ? 'repasser' : 'passer'} ${when} environ.`;
  else if (state.company === 'pair') first = `Deux personnes pensent ${returning ? 'repasser' : 'passer'} ${when} environ.`;
  else {
    const count = Number(state.groupCount);
    first = Number.isInteger(count) && count >= 3 && count <= 30
      ? `Un groupe d’environ ${count} personnes pense ${returning ? 'repasser' : 'passer'} ${when} environ.`
      : `Un groupe pense ${returning ? 'repasser' : 'passer'} ${when} environ.`;
  }
  const subject = state.company === 'solo' ? 'solo' : state.company === 'group' ? 'group' : 'plural';
  const games = state.games === 'none'
    ? subject === 'solo' ? 'Cette personne ne prévoit pas d’apporter de jeu.' : subject === 'group' ? 'Ce groupe ne prévoit pas d’apporter de jeu.' : 'Ces personnes ne prévoient pas d’apporter de jeu.'
    : state.games === 'one'
      ? subject === 'solo' ? 'Elle prévoit d’apporter un jeu.' : subject === 'group' ? 'Ce groupe prévoit d’apporter un jeu.' : 'Elles prévoient d’apporter un jeu.'
      : state.games === 'many'
        ? subject === 'solo' ? 'Elle prévoit d’apporter plusieurs jeux.' : subject === 'group' ? 'Ce groupe prévoit d’apporter plusieurs jeux.' : 'Elles prévoient d’apporter plusieurs jeux.'
        : subject === 'solo' ? 'Elle ne sait pas encore si elle apportera un jeu.' : subject === 'group' ? 'Ce groupe ne sait pas encore s’il apportera un jeu.' : 'Elles ne savent pas encore si elles apporteront un jeu.';
  return `${first} ${games}`;
}

function publicActualPreview(state) {
  if (!state.time || !state.company || !state.games) return 'Faites vos choix pour voir le message.';
  let people = 1;
  if (state.company === 'pair') people = 2;
  if (state.company === 'group') people = Number(state.groupCount) || 0;
  if (!people) return 'Indiquez combien vous êtes pour voir le message.';
  const first = people === 1
    ? `Une personne est au quai jusqu’à ${formatClock(state.time)} environ.`
    : `${people} personnes sont au quai jusqu’à ${formatClock(state.time)} environ.`;
  const games = state.games === 'yes'
    ? people === 1 ? 'Elle a au moins un jeu.' : 'Elles ont au moins un jeu.'
    : people === 1 ? 'Elle n’a pas de jeu.' : 'Elles n’ont pas de jeu.';
  return `${first} ${games}`;
}

function openVisitBuilder({ mode = 'planned', dateTs = Date.now(), prefillTime = null, prefillGames = null, entry = null, returning = false, focus = '' } = {}) {
  return new Promise((resolve) => {
    const dialog = $('visitDialog');
    const finish = beginDialog(dialog, resolve);
    const actual = mode === 'actual';
    const state = {
      time: Number(prefillTime || (actual ? entry?.untilAt : entry?.arrivalAt)) || null,
      company: visitCompanyFromEntry(entry),
      groupCount: entry?.group === true && intentionCountKnown(entry) ? Number(entry.peopleCount) : '',
      games: visitGamesFromEntry(entry, actual) ?? prefillGames
    };

    $('visitTitle').textContent = actual
      ? (entry ? 'Vérifiez votre présence au quai' : 'Indiquer que vous êtes au quai')
      : (entry ? 'Vérifiez les changements' : returning ? 'Annoncer votre retour' : 'Annoncer votre venue');
    $('visitIntro').textContent = actual
      ? 'Tous les choix restent visibles. Vérifiez le résumé avant de confirmer.'
      : 'Choisissez ce que vous savez aujourd’hui. Une heure approximative suffit, et « Je ne sais pas encore » reste une vraie réponse.';
    $('visitTimeLabel').textContent = actual ? 'Jusqu’à quelle heure pensez-vous rester ?' : 'Vers quelle heure pensez-vous passer ?';
    $('visitPeopleLabel').textContent = actual ? 'Vous êtes…' : 'Vous venez…';
    $('visitGamesLabel').textContent = actual ? 'Avez-vous au moins un jeu avec vous ?' : 'Pensez-vous apporter un jeu ?';
    $('visitGamesHint').textContent = actual ? 'Indiquez seulement si au moins un échiquier est déjà là.' : 'Ce n’est pas obligatoire : choisissez simplement ce qui vous semble probable.';
    $('visitGroupCountLabel').innerHTML = actual ? 'Combien êtes-vous maintenant ?' : 'Combien environ ? <small>(facultatif)</small>';
    $('visitGroupCount').min = actual ? '3' : '3';
    $('visitGroupCount').required = actual;
    $('visitCancel').textContent = entry ? 'Fermer sans changer' : actual ? 'Fermer sans signaler ma présence' : 'Fermer sans annoncer';

    const renderButtons = (containerId, options, selected, onSelect) => {
      const container = $(containerId);
      container.innerHTML = '';
      options.forEach(({ label, value }) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `visit-option${selected === value ? ' is-selected' : ''}`;
        button.setAttribute('aria-pressed', selected === value ? 'true' : 'false');
        button.textContent = label;
        button.addEventListener('click', () => onSelect(value));
        container.appendChild(button);
      });
    };

    const update = () => {
      const baseSuggestions = actual ? nowSuggestions() : arrivalSuggestions(dateTs);
      const times = [...new Set([state.time, ...baseSuggestions].filter((value) =>
        value !== null && value !== '' && Number.isFinite(Number(value)) && Number(value) > Date.now()
      ))].map(Number).sort((a, b) => a - b).slice(0, 7);
      renderButtons('visitTimeOptions', times.map((value) => ({ label: actual ? `Jusqu’à ${formatClock(value)}` : `Vers ${formatClock(value)}`, value })), state.time, (value) => {
        state.time = value; $('visitCustomTime').value = visitTimeInputValue(value); update();
      });
      renderButtons('visitPeopleOptions', [
        { label: actual ? 'Je suis seul' : 'Seul', value: 'solo' },
        { label: actual ? 'Nous sommes deux' : 'À deux', value: 'pair' },
        { label: actual ? 'Nous sommes un groupe' : 'En groupe', value: 'group' }
      ], state.company, (value) => {
        state.company = value;
        if (value !== 'group') state.groupCount = '';
        update();
      });
      const groupRow = $('visitGroupCountRow');
      groupRow.hidden = state.company !== 'group';
      const countInput = $('visitGroupCount');
      if (document.activeElement !== countInput) countInput.value = state.groupCount || '';
      renderButtons('visitGamesOptions', actual ? [
        { label: 'Aucun jeu', value: 'none' },
        { label: 'Au moins un jeu', value: 'yes' }
      ] : [
        { label: 'Aucun jeu prévu', value: 'none' },
        { label: 'Un jeu', value: 'one' },
        { label: 'Plusieurs jeux', value: 'many' },
        { label: 'Je ne sais pas encore', value: 'unknown' }
      ], state.games, (value) => { state.games = value; update(); });

      const count = Number(state.groupCount);
      const hasGroupCount = state.groupCount !== '' && state.groupCount !== null;
      const groupValid = state.company !== 'group'
        || (!actual && !hasGroupCount)
        || (Number.isInteger(count) && count >= 3 && count <= 30);
      const timeValid = state.time !== null && state.time !== '' && Number.isFinite(Number(state.time)) && Number(state.time) > Date.now();
      const complete = timeValid && Boolean(state.company) && Boolean(state.games) && groupValid;
      $('visitConfirm').disabled = !complete;
      if (actual) {
        $('visitConfirm').textContent = state.company === 'solo' ? 'Indiquer ma présence' : state.company ? 'Indiquer notre présence' : 'Indiquer la présence';
      } else if (returning) {
        $('visitConfirm').textContent = state.company === 'solo' ? 'Annoncer mon retour' : state.company ? 'Annoncer notre retour' : 'Annoncer le retour';
      } else {
        $('visitConfirm').textContent = state.company === 'solo' ? 'Annoncer ma venue' : state.company ? 'Annoncer notre venue' : 'Annoncer la venue';
      }
      if (entry) $('visitConfirm').textContent = 'Confirmer les changements';
      $('visitPreview').textContent = actual ? publicActualPreview(state) : publicPlannedPreview(state, returning);
    };

    $('visitCustomTime').value = visitTimeInputValue(state.time);
    $('visitCustomTimeButton').onclick = () => {
      const maxHours = actual ? 12 : 40 * 24;
      const value = timestampFromInput($('visitCustomTime').value, maxHours, dateTs);
      if (!value) { toast('Choisissez une heure ultérieure valide.'); return; }
      state.time = value; update();
    };
    $('visitGroupCount').oninput = () => {
      state.groupCount = $('visitGroupCount').value;
      update();
    };
    $('visitCancel').onclick = () => finish(null);
    $('visitConfirm').onclick = () => {
      if ($('visitConfirm').disabled) return;
      const groupCount = Number(state.groupCount);
      const people = state.company === 'solo'
        ? { peopleCount: 1, countKnown: true, group: false }
        : state.company === 'pair'
          ? { peopleCount: 2, countKnown: true, group: false }
          : { peopleCount: Number.isInteger(groupCount) && groupCount >= 3 && groupCount <= 30 ? groupCount : 1, countKnown: Number.isInteger(groupCount) && groupCount >= 3 && groupCount <= 30, group: true };
      if (actual) {
        finish({ ...people, untilAt: state.time, hasGameKnown: true, hasGame: state.games === 'yes' });
        return;
      }
      const games = state.games === 'none'
        ? { gamesCount: 0, gamesKnown: true, gamesMultiple: false }
        : state.games === 'one'
          ? { gamesCount: 1, gamesKnown: true, gamesMultiple: false }
          : state.games === 'many'
            ? { gamesCount: 0, gamesKnown: false, gamesMultiple: true }
            : { gamesCount: 0, gamesKnown: false, gamesMultiple: false };
      finish({ ...people, ...games, arrivalAt: state.time });
    };

    update();
    if (typeof dialog.showModal === 'function') dialog.showModal();
    requestAnimationFrame(() => {
      const section = focus === 'time' ? $('visitTimeSection') : focus === 'people' ? $('visitPeopleSection') : focus === 'games' ? $('visitGamesSection') : null;
      section?.scrollIntoView({ block: 'start' });
      (section?.querySelector('button, input') || $('visitTimeOptions').querySelector('button') || $('visitCustomTime'))?.focus();
    });
  });
}

// ---------------------------------------------------------------------------
// Prénom privé et contexte dans lequel il a volontairement été utilisé
// ---------------------------------------------------------------------------
function readFirstName() {
  try { return (localStorage.getItem(FIRST_NAME_KEY) || '').slice(0, 24); }
  catch { return ''; }
}
function writeFirstName(value) {
  try {
    if (value) localStorage.setItem(FIRST_NAME_KEY, value.slice(0, 24));
    else localStorage.removeItem(FIRST_NAME_KEY);
  } catch { /* facultatif */ }
}
function readNamedContexts() {
  try { return JSON.parse(localStorage.getItem(NAMED_CONTEXTS_KEY) || '{}') || {}; }
  catch { return {}; }
}
function setNamedContext(contextKey, firstName) {
  try {
    const values = readNamedContexts();
    const clean = typeof firstName === 'string' ? firstName.trim().slice(0, 24) : '';
    if (clean) values[contextKey] = clean;
    else delete values[contextKey];
    localStorage.setItem(NAMED_CONTEXTS_KEY, JSON.stringify(values));
  } catch { /* facultatif */ }
}
function firstNameForContext(contextKey) {
  const stored = readNamedContexts()[contextKey];
  // Compatibilité avec la version précédente, qui ne mémorisait qu'un booléen.
  if (stored === true) return readFirstName();
  return typeof stored === 'string' ? stored.slice(0, 24) : '';
}

// ---------------------------------------------------------------------------
// Notifications et nouvelle tentative
// ---------------------------------------------------------------------------
function renderRetry() { /* Les nouvelles tentatives restent automatiques et invisibles. */ }
async function notifyBrice(eventType, payload = {}) {
  if (!currentUser) return false;
  try {
    const idToken = await currentUser.getIdToken();
    const response = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventType, payload })
    });
    if (response.ok) { pendingNotify = null; renderRetry(); return true; }
    return false;
  } catch (error) {
    console.warn('Notification indisponible', error);
    return false;
  }
}
function keepForRetry(eventType, payload) {
  pendingNotify = { eventType, payload };
  renderRetry();
}
function clearRetry(...types) {
  if (!pendingNotify || (types.length && !types.includes(pendingNotify.eventType))) return;
  pendingNotify = null;
  renderRetry();
}
function clearRetryForContext(eventType, contextKey) {
  if (pendingNotify?.eventType !== eventType) return;
  if (contextKey && pendingNotify.payload?.contextKey !== contextKey) return;
  pendingNotify = null;
  renderRetry();
}
function refreshRetry(eventType, payload) {
  if (pendingNotify?.eventType === eventType && pendingNotify.payload?.contextKey === payload.contextKey) {
    pendingNotify = { eventType, payload };
  }
  renderRetry();
}
function noticeText(base) { return base; }
async function retryPendingNotification() {
  if (!pendingNotify || !currentUser || busy || Date.now() - lastNotifyRetryAt < 60_000) return;
  lastNotifyRetryAt = Date.now();
  const { eventType, payload } = pendingNotify;
  await notifyBrice(eventType, payload);
}

// ---------------------------------------------------------------------------
// Partage
// ---------------------------------------------------------------------------
async function invite(text, url = `${SITE_URL}#aujourdhui`) {
  if (navigator.share) {
    try { await navigator.share({ title: 'Le Quai joue', text, url }); return; }
    catch { /* partage annulé */ }
  }
  try {
    await navigator.clipboard.writeText(`${text}\n${url}`);
    toast('Invitation copiée. Vous pouvez la coller dans un message.');
  } catch { toast('Copiez ce message : ' + text); }
}

// ---------------------------------------------------------------------------
// Contexte rendez-vous / intentions
// ---------------------------------------------------------------------------
function rendezvousOccurrence() {
  if (!active(rendezvous)) return null;
  const occurrence = effectiveEventAt(rendezvous);
  return Number.isFinite(occurrence) ? occurrence : null;
}
function rendezvousKey() {
  const occurrence = rendezvousOccurrence();
  return Number.isFinite(occurrence) ? String(Math.trunc(occurrence)) : null;
}
function rendezvousCancelled() {
  const occurrence = rendezvousOccurrence();
  return active(rendezvous) && (rendezvous.type === 'cancelled' || isCancelledOccurrence(rendezvous, occurrence));
}
function intentionKeysToWatch() {
  const keys = [todayEventKey()];
  const key = rendezvousKey();
  if (key && !keys.includes(key)) keys.push(key);
  return keys;
}
function activeIntentionsForKey(key) {
  return Object.entries(intentionsByEvent[key] || {})
    .filter(([, entry]) => active(entry) && entry.attending === true);
}
function myIntentions() {
  if (!currentUser) return [];
  return intentionKeysToWatch().map((key) => ({ key, entry: intentionsByEvent[key]?.[currentUser.uid] || null }))
    .filter(({ entry }) => active(entry) && entry.attending === true)
    .sort((a, b) => Number(a.entry.arrivalAt) - Number(b.entry.arrivalAt));
}
function myIntentionFor(key) {
  return myIntentions().find((item) => item.key === key)?.entry || null;
}
function intentionCountKnown(entry) { return entry?.countKnown !== false; }
function intentionGamesKnown(entry) { return entry?.gamesKnown !== false; }

// ---------------------------------------------------------------------------
// Présences réelles
// ---------------------------------------------------------------------------
function presencePath() { return `${ROOT}/presence/${currentUser.uid}`; }
function gameNeedPath() { return `${ROOT}/gameNeeds/${currentUser.uid}`; }
function normalizedPresence(fields) {
  const now = Date.now();
  const untilAt = Number(fields.untilAt);
  const hasGameKnown = fields.hasGameKnown === true;
  const searching = fields.searching === true;
  const data = {
    peopleCount: Math.min(30, Math.max(1, Number(fields.peopleCount) || 1)),
    hasGameKnown,
    hasGame: hasGameKnown ? fields.hasGame === true : false,
    searching, untilAt, updatedAt: now, expiresAt: untilAt
  };
  if (searching) data.searchUntil = Math.min(untilAt, Number(fields.searchUntil));
  return data;
}
async function writePresence(fields) {
  await set(ref(database, presencePath()), normalizedPresence(fields));
}

async function flowHere() {
  if (busy) return;
  const presenceChoice = await openVisitBuilder({ mode: 'actual' });
  if (!presenceChoice) return;
  try {
    setBusy(true);
    const presence = normalizedPresence({ ...presenceChoice, searching: false });
    const changes = {
      [`${ROOT}/presence/${currentUser.uid}`]: presence,
      [`${ROOT}/gameNeeds/${currentUser.uid}`]: null
    };
    const removedContexts = [];
    myIntentions().forEach(({ key, entry }) => {
      if (!isSameParisDay(Number(entry.arrivalAt), Date.now())) return;
      changes[`${ROOT}/intentions/${key}/${currentUser.uid}`] = null;
      changes[`${ROOT}/private/queries/${key}/${currentUser.uid}`] = null;
      removedContexts.push(key);
      setNamedContext(key, false);
    });
    await update(ref(database), changes);
    removedContexts.forEach((key) => {
      clearRetryForContext('planned_visit', key);
      clearRetryForContext('planned_visit_updated', key);
      clearRetryForContext('planned_visit_cancelled', key);
    });
    clearRetry('looking_for_player', 'game_needed');
    const payload = {
      untilAt: presenceChoice.untilAt, peopleCount: presenceChoice.peopleCount,
      gamesKnown: true, gamesCount: presenceChoice.hasGame ? 1 : 0
    };
    const notified = await notifyBrice('arrival', payload);
    if (!notified) keepForRetry('arrival', payload);
    toast(`C’est noté : vous êtes au quai jusqu’à ${formatClock(presenceChoice.untilAt)} environ.`);
  } catch (error) {
    console.error(error); toast('Nous n’avons pas réussi à confirmer votre présence. Vérifiez la connexion puis réessayez.');
  } finally { setBusy(false); }
}

async function flowEditPresence() {
  if (busy || !active(myPresence) || !currentUser) return;
  const before = { ...myPresence };
  const beforeNeed = allGameNeeds[currentUser.uid];
  const draft = await openVisitBuilder({
    mode: 'actual',
    entry: { ...myPresence, group: Number(myPresence.peopleCount) >= 3 }
  });
  if (!draft) return;
  try {
    setBusy(true);
    const searching = before.searching === true && Number(before.searchUntil) > Date.now();
    const updated = normalizedPresence({
      ...draft,
      searching,
      searchUntil: searching ? Math.min(Number(before.searchUntil), Number(draft.untilAt)) : null
    });
    const changes = { [`${ROOT}/presence/${currentUser.uid}`]: updated };
    if (draft.hasGame === true) changes[`${ROOT}/gameNeeds/${currentUser.uid}`] = null;
    await update(ref(database), changes);
    const arrivalPayload = {
      untilAt: updated.untilAt, peopleCount: updated.peopleCount,
      gamesCount: updated.hasGame ? 1 : 0, gamesKnown: true, gamesMultiple: false
    };
    refreshRetry('arrival', arrivalPayload);
    if (searching) refreshRetry('looking_for_player', {
      untilAt: updated.searchUntil, hasGame: updated.hasGame,
      peopleCount: updated.peopleCount
    });
    if (draft.hasGame === true) clearRetry('game_needed');
    toast('C’est corrigé. Les autres voient maintenant ces nouvelles informations.', {
      label: 'Annuler', timeout: 8000,
      onClick: async () => {
        const restored = normalizedPresence(before);
        await update(ref(database), {
          [presencePath()]: restored,
          [gameNeedPath()]: active(beforeNeed) ? beforeNeed : null
        });
        refreshRetry('arrival', {
          untilAt: restored.untilAt, peopleCount: restored.peopleCount,
          gamesCount: restored.hasGame ? 1 : 0, gamesKnown: true, gamesMultiple: false
        });
        if (restored.searching === true && Number(restored.searchUntil) > Date.now()) {
          refreshRetry('looking_for_player', {
            untilAt: restored.searchUntil, hasGame: restored.hasGame,
            peopleCount: restored.peopleCount
          });
        }
        toast('La correction a été annulée.');
      }
    });
  } catch (error) {
    console.error(error);
    toast('Nous n’avons pas réussi à corriger ces informations. Réessayez dans un instant.');
  } finally { setBusy(false); }
}

async function flowSearch() {
  if (busy || !active(myPresence)) return;
  const searching = myPresence.searching === true && Number(myPresence.searchUntil) > Date.now();
  if (searching) {
    try {
      setBusy(true);
      await writePresence({ ...myPresence, searching: false, searchUntil: null });
      clearRetry('looking_for_player');
      toast('C’est noté : vous ne cherchez plus de partenaire.');
    } catch (error) { console.error(error); toast('Nous n’avons pas réussi à arrêter la recherche. Réessayez dans un instant.'); }
    finally { setBusy(false); }
    return;
  }

  const answer = await askChoice({
    title: 'Avez-vous un jeu pour commencer la partie ?',
    options: [
      { label: 'Oui, un jeu est là', value: true },
      { label: 'Non, pas de jeu', value: false }
    ]
  });
  if (answer === null) return;
  try {
    setBusy(true);
    const searchUntil = Math.min(Number(myPresence.untilAt), Date.now() + SEARCH_MINUTES * 60_000);
    await writePresence({
      ...myPresence, hasGameKnown: true, hasGame: answer === true,
      searching: true, searchUntil, untilAt: myPresence.untilAt
    });
    const payload = {
      untilAt: searchUntil, hasGame: answer === true,
      peopleCount: Number(myPresence.peopleCount) || 1
    };
    const notified = await notifyBrice('looking_for_player', payload);
    if (!notified) keepForRetry('looking_for_player', payload);
    toast(noticeText(`C’est noté : vous cherchez quelqu’un jusqu’à ${formatClock(searchUntil)} environ.`, notified));
  } catch (error) { console.error(error); toast('Nous n’avons pas réussi à lancer la recherche. Réessayez dans un instant.'); }
  finally { setBusy(false); }
}

function searchInviteText() {
  const until = formatClock(Number(myPresence?.searchUntil || Date.now()));
  const people = Math.min(30, Math.max(1, Number(myPresence?.peopleCount) || 1));
  const subject = people === 1 ? 'Je suis' : people === 2 ? 'Nous sommes deux' : `Nous sommes ${people}`;
  const search = people === 1 ? 'je cherche' : 'nous cherchons';
  return myPresence?.hasGame === true
    ? `${subject} au quai des Bateliers avec au moins un jeu et ${search} quelqu’un pour faire une partie jusqu’à ${until} environ. Ça te dit de passer ?`
    : `${subject} au quai des Bateliers et ${search} quelqu’un pour faire une partie jusqu’à ${until} environ. Prends un jeu si tu passes.`;
}

function gameInviteText() {
  const people = Math.min(30, Math.max(1, Number(myPresence?.peopleCount) || 1));
  return people === 1
    ? 'Il me manque un jeu au quai des Bateliers pour lancer une partie. Tu peux passer avec un jeu ?'
    : 'Il nous manque un jeu au quai des Bateliers pour lancer une partie. Tu peux passer avec un jeu ?';
}

async function flowNeedGame() {
  if (busy || !active(myPresence) || !currentUser) return;
  const myNeed = allGameNeeds[currentUser.uid];
  try {
    setBusy(true);
    if (active(myNeed)) {
      const presence = normalizedPresence({ ...myPresence, hasGameKnown: true, hasGame: true });
      await update(ref(database), {
        [`${ROOT}/presence/${currentUser.uid}`]: presence,
        [`${ROOT}/gameNeeds/${currentUser.uid}`]: null
      });
      clearRetry('game_needed');
      toast('C’est noté : un jeu est maintenant là.');
      return;
    }
    const now = Date.now();
    const presence = normalizedPresence({ ...myPresence, hasGameKnown: true, hasGame: false });
    await update(ref(database), {
      [`${ROOT}/presence/${currentUser.uid}`]: presence,
      [`${ROOT}/gameNeeds/${currentUser.uid}`]: { updatedAt: now, expiresAt: now + GAME_NEED_MINUTES * 60_000 }
    });
    const notified = await notifyBrice('game_needed', {});
    if (!notified) keepForRetry('game_needed', {});
    toast(noticeText('C’est noté : il vous manque un jeu.', notified));
  } catch (error) { console.error(error); toast('Nous n’avons pas réussi à le signaler. Réessayez dans un instant.'); }
  finally { setBusy(false); }
}

async function flowBringGame() {
  if (busy || !currentUser) return;
  const key = todayEventKey();
  const planned = myIntentionFor(key);
  if (active(myPresence)) {
    const before = { ...myPresence };
    const beforeNeed = allGameNeeds[currentUser.uid];
    try {
      setBusy(true);
      const presence = normalizedPresence({ ...myPresence, hasGameKnown: true, hasGame: true });
      await update(ref(database), {
        [`${ROOT}/presence/${currentUser.uid}`]: presence,
        [`${ROOT}/gameNeeds/${currentUser.uid}`]: null
      });
      clearRetry('game_needed');
      toast('C’est noté : vous avez un jeu avec vous.', {
        label: 'Annuler', timeout: 8000,
        onClick: async () => {
          await update(ref(database), {
            [presencePath()]: normalizedPresence(before),
            [gameNeedPath()]: active(beforeNeed) ? beforeNeed : null
          });
          toast('Le changement a été annulé.');
        }
      });
    } catch (error) {
      console.error(error); toast('Nous n’avons pas réussi à signaler le jeu. Réessayez dans un instant.');
    } finally { setBusy(false); }
    return;
  }
  if (active(planned)) {
    const firstName = planned.wantsBrice === true ? firstNameForContext(key) : '';
    const updated = { ...planned, gamesKnown: true, gamesCount: 1, gamesMultiple: false, firstName };
    const result = await saveIntention(updated, key, { notificationType: 'planned_visit_updated' });
    if (result === 'error') return;
    toast('C’est noté : un jeu est maintenant prévu avec votre venue.', {
      label: 'Annuler', timeout: 8000,
      onClick: async () => {
        await saveIntention({ ...planned, firstName }, key, { notificationType: 'planned_visit_updated' });
        toast('Le changement a été annulé.');
      }
    });
    return;
  }
  await flowPlan(null, key, { prefillGames: 'one' });
}

async function flowLeave() {
  if (busy || !active(myPresence) || !currentUser) return;
  try {
    setBusy(true);
    await update(ref(database), {
      [`${ROOT}/presence/${currentUser.uid}`]: null,
      [`${ROOT}/gameNeeds/${currentUser.uid}`]: null
    });
    clearRetry('arrival', 'looking_for_player', 'game_needed');
    toast('Merci, à bientôt !');
  } catch (error) {
    console.error(error); toast('Nous n’avons pas réussi à confirmer votre départ. Réessayez dans un instant.'); setBusy(false); return;
  }
  setBusy(false);
  const again = await askChoice({
    title: 'Pensez-vous repasser plus tard aujourd’hui ?',
    options: [
      { label: 'Oui, probablement', value: true },
      { label: 'Non, pas aujourd’hui', value: false }
    ]
  });
  if (again !== true) return;
  const when = await askTime({ title: 'Vers quelle heure pensez-vous repasser ?', suggestions: arrivalSuggestions(), maxHours: 14 });
  if (!when) return;
  await flowPlan(when, todayEventKey(), { returning: true });
}

// ---------------------------------------------------------------------------
// Venues prévues
// ---------------------------------------------------------------------------
function intentionPayload(data, firstName = '', contextKey = '') {
  return {
    contextKey, arrivalAt: data.arrivalAt, peopleCount: data.peopleCount,
    countKnown: data.countKnown, group: data.group,
    gamesCount: data.gamesCount, gamesKnown: data.gamesKnown,
    gamesMultiple: data.gamesMultiple, wantsBrice: data.wantsBrice,
    ...(firstName ? { firstName } : {})
  };
}

async function flowPlan(prefillArrival = null, boundEventKey = null, options = {}) {
  if (busy) return;
  const eventKey = boundEventKey || todayEventKey();
  if (active(myIntentionFor(eventKey))) {
    toast('Vous avez déjà annoncé cette venue. Les boutons sous votre annonce permettent de la corriger.');
    return;
  }
  const returning = options.returning === true;
  const contextDate = prefillArrival || Date.now();
  const draft = await openVisitBuilder({
    mode: 'planned', dateTs: contextDate, prefillTime: prefillArrival,
    prefillGames: options.prefillGames || null, returning
  });
  if (!draft) return;
  const details = { wantsBrice: false, firstName: '' };
  setNamedContext(eventKey, false);
  const result = await saveIntention({ ...draft, ...details, returning }, eventKey);
  if (result === 'error') return;

  const companyText = draft.group
    ? draft.countKnown ? `, en groupe d’environ ${draft.peopleCount} personnes` : ', en groupe'
    : draft.peopleCount === 2 ? ', à deux' : '';
  const noun = returning ? 'retour' : 'venue';
  const confirmation = eventKey === todayEventKey()
    ? `C’est noté : votre ${noun} est prévu${returning ? '' : 'e'} vers ${formatClock(draft.arrivalAt)} environ${companyText}.`
    : `C’est noté : votre venue au rendez-vous du ${formatEvent(Number(eventKey))} est annoncée${companyText}. Vous pensez arriver vers ${formatClock(draft.arrivalAt)} environ.`;
  const undoEntry = {
    ...draft, ...details, returning, attending: true,
    wantsBrice: false, expiresAt: Date.now() + INTENTION_GRACE_MINUTES * 60_000
  };
  toast(confirmation, {
    label: 'Annuler', timeout: 8000,
    onClick: () => cancelIntention(eventKey, undoEntry)
  });
}

async function saveIntention(fields, eventKey, options = {}) {
  if (!currentUser) return 'error';
  try {
    setBusy(true);
    const now = Date.now();
    const arrivalAt = Number(fields.arrivalAt);
    const naturalExpiry = arrivalAt + INTENTION_GRACE_MINUTES * 60_000;
    let expiresAt = eventKey.startsWith('d')
      ? Math.min(naturalExpiry, endOfParisDay(arrivalAt))
      : Math.min(naturalExpiry, Number(eventKey) + 8 * 3600_000, now + 40 * 86400_000);
    if (fields.returning) expiresAt = Math.min(expiresAt, endOfParisDay(arrivalAt));
    const group = fields.group === true;
    const countKnown = !group || fields.countKnown !== false;
    const gamesKnown = fields.gamesKnown !== false;
    const data = {
      attending: true, arrivalAt,
      peopleCount: countKnown ? Math.min(30, Math.max(1, Number(fields.peopleCount) || 1)) : 1,
      countKnown, group,
      gamesCount: gamesKnown ? Math.min(10, Math.max(0, Number(fields.gamesCount) || 0)) : 0,
      gamesKnown, gamesMultiple: fields.gamesMultiple === true,
      wantsBrice: fields.wantsBrice === true, arrived: false,
      returning: fields.returning === true, updatedAt: now,
      expiresAt: Math.max(expiresAt, now + 60_000)
    };
    const changes = { [`${ROOT}/intentions/${eventKey}/${currentUser.uid}`]: data };
    const queryPath = `${ROOT}/private/queries/${eventKey}/${currentUser.uid}`;
    if (data.wantsBrice) {
      changes[queryPath] = {
        ...(fields.firstName ? { firstName: fields.firstName.slice(0, 24) } : {}),
        arrivalAt, createdAt: now, expiresAt: data.expiresAt
      };
    } else changes[queryPath] = null;
    await update(ref(database), changes);

    const payload = intentionPayload(data, fields.firstName || '', eventKey);
    const notificationType = options.notificationType || 'planned_visit';
    if (options.silentBrice) {
      refreshRetry(notificationType, payload);
      return null;
    }
    const notified = await notifyBrice(notificationType, payload);
    if (!notified) keepForRetry(notificationType, payload);
    return notified;
  } catch (error) {
    console.error(error); toast('Nous n’avons pas réussi à annoncer votre venue. Réessayez dans un instant.'); return 'error';
  } finally { setBusy(false); }
}

async function cancelIntention(key, entry) {
  if (busy || !currentUser || !active(entry)) return;
  try {
    setBusy(true);
    const cancellationName = entry.wantsBrice === true ? firstNameForContext(key) : '';
    await update(ref(database), {
      [`${ROOT}/intentions/${key}/${currentUser.uid}`]: null,
      [`${ROOT}/private/queries/${key}/${currentUser.uid}`]: null
    });
    setNamedContext(key, false);
    clearRetryForContext('planned_visit', key);
    clearRetryForContext('planned_visit_updated', key);
    const payload = intentionPayload(entry, cancellationName, key);
    const notified = await notifyBrice('planned_visit_cancelled', payload);
    if (!notified) keepForRetry('planned_visit_cancelled', payload);
    toast(noticeText(entry.returning ? 'C’est noté : vous ne repasserez finalement pas.' : 'C’est noté : vous ne viendrez finalement pas.', notified));
  } catch (error) { console.error(error); toast('Nous n’avons pas réussi à retirer cette venue. Réessayez dans un instant.'); }
  finally { setBusy(false); }
}

async function arriveFromIntention(key, entry) {
  if (busy || !currentUser || !active(entry)) return;
  const actualPrefill = {
    peopleCount: Number(entry.peopleCount) || 1,
    countKnown: intentionCountKnown(entry), group: entry.group === true,
    hasGameKnown: intentionGamesKnown(entry) || entry.gamesMultiple === true,
    hasGame: (intentionGamesKnown(entry) && Number(entry.gamesCount) > 0) || entry.gamesMultiple === true
  };
  const actual = await openVisitBuilder({ mode: 'actual', entry: actualPrefill });
  if (!actual) return;
  try {
    setBusy(true);
    const presence = normalizedPresence({ ...actual, searching: false });
    const changes = {
      [`${ROOT}/presence/${currentUser.uid}`]: presence,
      [`${ROOT}/gameNeeds/${currentUser.uid}`]: null
    };
    const removedContexts = [];
    intentionKeysToWatch().forEach((candidateKey) => {
      const candidate = intentionsByEvent[candidateKey]?.[currentUser.uid];
      if (active(candidate) && isSameParisDay(Number(candidate.arrivalAt), Date.now())) {
        changes[`${ROOT}/intentions/${candidateKey}/${currentUser.uid}`] = null;
        changes[`${ROOT}/private/queries/${candidateKey}/${currentUser.uid}`] = null;
        removedContexts.push(candidateKey);
        setNamedContext(candidateKey, false);
      }
    });
    await update(ref(database), changes);
    removedContexts.forEach((candidateKey) => {
      clearRetryForContext('planned_visit', candidateKey);
      clearRetryForContext('planned_visit_updated', candidateKey);
      clearRetryForContext('planned_visit_cancelled', candidateKey);
    });
    clearRetry('game_needed', 'looking_for_player');
    const payload = {
      untilAt: actual.untilAt, peopleCount: actual.peopleCount,
      gamesCount: actual.hasGame ? 1 : 0, gamesKnown: true, gamesMultiple: false
    };
    const notified = await notifyBrice('arrival', payload);
    if (!notified) keepForRetry('arrival', payload);
    toast(`Vous êtes au quai jusqu’à ${formatClock(actual.untilAt)} environ.`);
  } catch (error) { console.error(error); toast('Nous n’avons pas réussi à confirmer votre arrivée. Réessayez dans un instant.'); }
  finally { setBusy(false); }
}

async function changeIntentionBrice(key, entry) {
  if (entry.wantsBrice === true) {
    const remove = await askChoice({
      title: 'Retirer votre demande à Brice ?',
      copy: 'Sa réponse ne sera plus attendue pour cette venue.',
      options: [
        { label: 'Oui, retirer la demande', value: true },
        { label: 'Non, la garder', value: false }
      ]
    });
    if (remove !== true) return;
    const result = await saveIntention(
      { ...entry, wantsBrice: false, firstName: '' }, key,
      { notificationType: 'planned_visit_updated', silentBrice: true }
    );
    if (result !== 'error') {
      setNamedContext(key, false);
      toast('C’est noté : la demande à Brice a été retirée.');
    }
    return;
  }

  const ask = await askChoice({
    title: 'Demander à Brice s’il pense être là ?',
    copy: 'C’est facultatif. Brice répondra ici s’il le peut, quand il aura le temps.',
    options: [
      { label: 'Oui, lui demander', value: true },
      { label: 'Non merci', value: false }
    ]
  });
  if (ask !== true) return;
  const savedName = readFirstName();
  const entered = await askText({
    title: 'Souhaitez-vous laisser un prénom à Brice ?',
    copy: 'C’est facultatif et privé. Le prénom ne sera jamais affiché publiquement.',
    placeholder: savedName || 'Votre prénom', maxLength: 24,
    submitLabel: 'Envoyer la demande', optional: true,
    skipLabel: 'Sans prénom', prefill: savedName
  });
  if (entered === null) return;
  const firstName = entered.trim().slice(0, 24);
  if (firstName) writeFirstName(firstName);
  setNamedContext(key, firstName);
  const result = await saveIntention(
    { ...entry, wantsBrice: true, firstName }, key,
    { notificationType: 'planned_visit_updated' }
  );
  if (result !== 'error') toast('C’est noté : Brice verra votre demande.');
}

async function editIntention(key, entry, focus = '') {
  const updated = await openVisitBuilder({
    mode: 'planned', dateTs: Number(entry.arrivalAt), entry,
    returning: entry.returning === true, focus
  });
  if (!updated) return;
  const firstName = entry.wantsBrice === true ? firstNameForContext(key) : '';
  const result = await saveIntention(
    { ...entry, ...updated, firstName }, key,
    { notificationType: 'planned_visit_updated' }
  );
  if (result === 'error') return;
  toast('C’est corrigé.', {
    label: 'Annuler', timeout: 8000,
    onClick: async () => {
      await saveIntention({ ...entry, firstName }, key, { notificationType: 'planned_visit_updated' });
      toast('Les changements ont été annulés.');
    }
  });
}

// ---------------------------------------------------------------------------
// Idée ou signalement privé
// ---------------------------------------------------------------------------
let lastIdeaAt = 0;
async function sendIdea() {
  if (!currentUser) { toast('Le service n’est pas encore prêt. Réessayez dans un instant.'); return; }
  if (Date.now() - lastIdeaAt < 60_000) { toast('Patientez un instant avant d’envoyer un autre message.'); return; }
  const message = await askText({
    title: 'Une idée, une question ou quelque chose à signaler ?',
    copy: 'Votre message reste privé. Vous pouvez aussi poser une question sur le fonctionnement du site.',
    placeholder: 'Écrivez votre message', maxLength: 500,
    submitLabel: 'Envoyer mon message', optional: false
  });
  if (!message) return;
  try {
    setBusy(true);
    await push(ref(database, `${ROOT}/private/ideas`), { message: message.slice(0, 500), createdAt: Date.now() });
    lastIdeaAt = Date.now();
    const notified = await notifyBrice('idea_received', {});
    toast(noticeText('Merci, votre message est envoyé.', notified));
  } catch (error) { console.error(error); toast('Nous n’avons pas réussi à envoyer votre message. Réessayez dans un instant.'); }
  finally { setBusy(false); }
}

// ---------------------------------------------------------------------------
// Agenda
// ---------------------------------------------------------------------------
function localIcsDate(ts) {
  const p = parisParts(ts);
  return `${p.year}${p.month}${p.day}T${p.hour}${p.minute}${p.second}`;
}
function icsFor(rdv, occurrence) {
  const start = Number(occurrence);
  const end = start + 2 * 3600_000;
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'CALSCALE:GREGORIAN',
    'PRODID:-//Le Quai joue//FR', 'BEGIN:VEVENT',
    `UID:${Number(rdv.eventAt)}@le-quai-joue`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`,
    `DTSTART;TZID=Europe/Paris:${localIcsDate(start)}`,
    `DTEND;TZID=Europe/Paris:${localIcsDate(end)}`,
    ...(rdv.repeatWeekly === true ? ['RRULE:FREQ=WEEKLY'] : []),
    'SUMMARY:Le Quai joue — échecs au quai des Bateliers',
    'LOCATION:Quai des Bateliers, Strasbourg (galets côté Ill, face au salon Vue sur l\'Ill)',
    'GEO:48.5804;7.7539',
    `DESCRIPTION:Parties d'échecs libres et gratuites. ${SITE_URL}`,
    'END:VEVENT', 'END:VCALENDAR'
  ];
  return 'data:text/calendar;charset=utf-8,' + encodeURIComponent(lines.join('\r\n'));
}

// ---------------------------------------------------------------------------
// Météo
// ---------------------------------------------------------------------------
const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast?latitude=48.5804&longitude=7.7539&hourly=weather_code,precipitation_probability,wind_speed_10m&daily=sunset&timezone=Europe%2FParis&forecast_days=3';
let weatherData = null;
let weatherFetchedAt = 0;
let weatherFetching = false;
async function ensureWeather() {
  if (weatherFetching || Date.now() - weatherFetchedAt < 30 * 60_000) return;
  weatherFetching = true;
  try {
    const response = await fetch(WEATHER_URL);
    if (response.ok) { weatherData = await response.json(); weatherFetchedAt = Date.now(); renderAll(); }
  } catch { /* facultatif */ }
  finally { weatherFetching = false; }
}
function sentenceFromHourly(hourly, ts) {
  if (!hourly || !Array.isArray(hourly.time)) return '';
  const p = parisParts(ts);
  const key = `${p.year}-${p.month}-${p.day}T${p.hour}:00`;
  const i = hourly.time.indexOf(key);
  if (i < 0) return '';
  const code = Number(hourly.weather_code?.[i]);
  const rain = Number(hourly.precipitation_probability?.[i]);
  const wind = Number(hourly.wind_speed_10m?.[i]);
  if (!Number.isFinite(code)) return '';
  if (code >= 51 || (Number.isFinite(rain) && rain >= 45)) return `🌦️ Des averses restent possibles vers ${formatClock(ts)}.`;
  if (Number.isFinite(wind) && wind >= 30) return `💨 Du vent est prévu vers ${formatClock(ts)}. Un jeu avec des pièces assez stables sera plus pratique.`;
  if (code <= 2 && (!Number.isFinite(rain) || rain < 30)) return `☀️ Le temps devrait être agréable vers ${formatClock(ts)}.`;
  return '';
}
function parisTimestampFromLocalIso(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(value || ''));
  if (!match) return null;
  const ts = timestampForParisDateTime(...match.slice(1).map(Number));
  return Number.isFinite(ts) ? ts : null;
}
function sunsetFor(ts) {
  const daily = weatherData?.daily;
  if (!daily || !Array.isArray(daily.time) || !Array.isArray(daily.sunset)) return null;
  const p = parisParts(Number(ts));
  const day = `${p.year}-${p.month}-${p.day}`;
  const index = daily.time.indexOf(day);
  return index < 0 ? null : parisTimestampFromLocalIso(daily.sunset[index]);
}
function nightfallSentence(ts) {
  const sunset = sunsetFor(ts);
  if (!Number.isFinite(sunset) || Number(ts) < sunset - 30 * 60_000) return '';
  if (Date.now() >= sunset) return '🌙 Le soleil est couché. Pensez à choisir un endroit suffisamment éclairé.';
  return `🌙 Le soleil se couchera vers ${formatClock(sunset)}. Pensez à la lumière si vous restez après.`;
}
function autoWeatherFor(ts) {
  if (!Number.isFinite(Number(ts)) || !weatherData || Date.now() - weatherFetchedAt > 2 * 3600_000) return '';
  if (ts < Date.now() - 30 * 60_000 || ts > Date.now() + 60 * 3600_000) return '';
  return [sentenceFromHourly(weatherData.hourly, Number(ts)), nightfallSentence(Number(ts))].filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------------
function activePresences() { return Object.values(allPresence || {}).filter(active); }
function activeGameNeeds() {
  const presentIds = new Set(Object.entries(allPresence || {}).filter(([, item]) => active(item)).map(([uid]) => uid));
  return Object.entries(allGameNeeds || {})
    .filter(([uid, item]) => presentIds.has(uid) && active(item))
    .map(([, item]) => item);
}
function summarizeRendezvousIntentions(entries) {
  const intentions = entries.map(([, entry]) => entry);
  if (!intentions.length) return '';
  const subject = intentionPeopleLabel(intentions)
    .replace('pense passer', 'pense venir')
    .replace('pensent passer', 'pensent venir');
  const arrivals = [...new Set(intentions.map((item) => Number(item.arrivalAt)).filter(Number.isFinite))]
    .sort((a, b) => a - b);
  let timing = '';
  if (arrivals.length === 1) timing = ` Arrivée annoncée vers ${formatClock(arrivals[0])} environ.`;
  else if (arrivals.length <= 3) timing = ` Arrivées annoncées vers ${humanList(arrivals.map(formatClock))} environ.`;
  else timing = ` Arrivées annoncées entre ${formatClock(arrivals[0])} et ${formatClock(arrivals.at(-1))} environ.`;
  const games = intentionGamesLine(intentions)
    .replace('à ce moment-là', 'pour ce rendez-vous')
    .replace('On ne sait pas encore si un jeu est prévu.', 'On ne sait pas encore si un jeu est prévu pour ce rendez-vous.');
  return `${subject}.${timing} ${games}`.replace(/\s+/g, ' ').trim();
}
function briceTextFor(contextKey) {
  const brice = briceByContext?.[contextKey];
  if (!active(brice)) return '';
  const isToday = contextKey === todayEventKey();
  const gamesKnown = brice.gamesCountKnown !== false;
  const count = gamesKnown ? Math.max(0, Number(brice.gamesCount) || 0) : 0;
  const presence = isToday ? 'passer aujourd’hui' : 'être là';
  if (brice.state === 'yes') {
    if (!gamesKnown) return isToday
      ? 'Brice pense passer aujourd’hui. Il n’a pas encore précisé l’heure ni le nombre de jeux.'
      : 'Brice pense être là. Il ne sait pas encore combien de jeux il apportera.';
    const games = count === 0
      ? ', sans jeu annoncé de son côté'
      : count === 1 ? ' avec un jeu' : ` avec ${count} jeux`;
    return isToday
      ? `Brice pense passer aujourd’hui${games}. Il n’a pas précisé l’heure.`
      : `Brice pense être là${games}.`;
  }
  if (brice.state === 'unknown') return isToday
    ? 'Brice ne sait pas encore s’il passera aujourd’hui.'
    : 'Brice ne sait pas encore s’il pourra venir.';
  if (!gamesKnown) {
    if (brice.gamesKept === 'yes') return isToday
      ? 'Brice ne pense pas pouvoir passer aujourd’hui, mais quelqu’un prévoit d’apporter des jeux.'
      : 'Brice ne pourra pas venir, mais quelqu’un prévoit d’apporter des jeux.';
    if (brice.gamesKept === 'no') return isToday
      ? 'Brice ne pense pas pouvoir passer aujourd’hui et aucun jeu n’est prévu de son côté.'
      : 'Brice ne pourra pas venir et aucun jeu n’est prévu de son côté.';
    return isToday
      ? 'Brice ne pense pas pouvoir passer aujourd’hui. On ne sait pas encore si des jeux seront apportés de son côté.'
      : 'Brice ne pourra pas venir. On ne sait pas encore si des jeux seront apportés de son côté.';
  }
  if (count === 0) return isToday ? 'Brice ne pense pas pouvoir passer aujourd’hui.' : 'Brice ne pourra pas venir.';
  const planned = count === 1 ? 'le jeu prévu' : `les ${count} jeux prévus`;
  const absent = isToday ? 'Brice ne pense pas pouvoir passer aujourd’hui' : 'Brice ne pourra pas venir';
  if (brice.gamesKept === 'yes') return `${absent}, mais ${planned} ${count === 1 ? 'sera apporté' : 'seront apportés'} par quelqu’un.`;
  if (brice.gamesKept === 'no') return `${absent} et ${planned} ne ${count === 1 ? 'sera' : 'seront'} pas apporté${count === 1 ? '' : 's'} : pensez à prendre un jeu.`;
  return `${absent}. On ne sait pas encore si ${planned} ${count === 1 ? 'sera apporté' : 'seront apportés'}.`;
}

function presencePeopleCount(entries) {
  return entries.reduce((sum, item) => sum + (Number(item.peopleCount) || 1), 0);
}

function intentionPeopleLabel(entries) {
  const knownPeople = entries.filter(intentionCountKnown)
    .reduce((sum, item) => sum + (Number(item.peopleCount) || 1), 0);
  const unknownGroups = entries.filter((item) => item.group === true && !intentionCountKnown(item)).length;
  if (unknownGroups === 1 && knownPeople === 0) return 'Un groupe pense passer';
  if (unknownGroups > 0) {
    const peoplePart = knownPeople ? `${knownPeople === 1 ? 'Une personne' : `${knownPeople} personnes`} et ` : '';
    const groupsPart = unknownGroups === 1 ? 'un groupe' : `${unknownGroups} groupes`;
    return `${peoplePart}${groupsPart} pensent passer`;
  }
  if (knownPeople === 1) return 'Une personne pense passer';
  if (knownPeople === 2) return 'Deux personnes pensent passer';
  return `${knownPeople} personnes pensent passer`;
}

function intentionGamesLine(entries) {
  const hasSeveral = entries.some((item) => item.gamesMultiple === true || (intentionGamesKnown(item) && Number(item.gamesCount) > 1));
  const hasAtLeastOne = entries.some((item) => item.gamesMultiple === true || (intentionGamesKnown(item) && Number(item.gamesCount) > 0));
  const allAnswered = entries.every((item) => intentionGamesKnown(item) || item.gamesMultiple === true);
  if (hasSeveral) return 'Plusieurs jeux sont prévus à ce moment-là.';
  if (hasAtLeastOne) return 'Au moins un jeu est prévu à ce moment-là.';
  if (allAnswered) return `${entries.length === 1 ? 'Cette personne ne prévoit pas de jeu pour le moment.' : 'Les personnes annoncées ne prévoient pas de jeu pour le moment.'} Prenez-en un si vous pouvez.`;
  return 'On ne sait pas encore si un jeu est prévu.';
}

function currentGamesLine(entries, searching = false) {
  const known = entries.filter((item) => item.hasGameKnown === true);
  const hasAtLeastOne = known.some((item) => item.hasGame === true);
  if (hasAtLeastOne) return searching ? 'Un jeu est prêt pour commencer.' : 'Au moins un jeu est au quai, mais il peut déjà être occupé.';
  if (known.length === entries.length && entries.length) {
    return searching ? 'Pour être tranquille, apportez un jeu si vous le pouvez.' : 'Aucun jeu n’a été signalé. Pour être tranquille, prenez-en un si vous le pouvez.';
  }
  return searching ? 'On ne sait pas si un jeu est déjà là. Prenez-en un si vous le pouvez.' : 'On ne sait pas encore si un jeu est déjà là.';
}

function searchGamesLine(searchers, allPresences) {
  const searcherKnown = searchers.filter((item) => item.hasGameKnown === true);
  if (searcherKnown.some((item) => item.hasGame === true)) return 'Un jeu est prêt pour commencer.';
  const allKnown = allPresences.filter((item) => item.hasGameKnown === true);
  if (allKnown.some((item) => item.hasGame === true)) return 'Au moins un jeu est au quai, mais il peut déjà être utilisé.';
  if (allKnown.length === allPresences.length && allPresences.length) return 'Pour être tranquille, apportez un jeu si vous le pouvez.';
  return 'On ne sait pas si un jeu est déjà là. Prenez-en un si vous le pouvez.';
}

function adverseWeatherFor(ts) {
  const weather = sentenceFromHourly(weatherData?.hourly, Number(ts));
  const adverse = weather.startsWith('☀️') ? '' : weather;
  return [adverse, nightfallSentence(Number(ts))].filter(Boolean).join(' ');
}
function todayConditionSummary(timestamps) {
  const uniqueTimes = [...new Set(timestamps.filter(Number.isFinite).map(Number))].sort((a, b) => a - b);
  const messages = [];
  uniqueTimes.forEach((ts) => {
    const message = adverseWeatherFor(ts);
    if (message && !messages.includes(message)) messages.push(message);
  });
  return messages.slice(0, 2).join(' ');
}

function groupFutureIntentions(entries) {
  const sorted = entries.slice().sort((a, b) => Number(a.arrivalAt) - Number(b.arrivalAt));
  const groups = [];
  sorted.forEach((entry) => {
    const arrival = Number(entry.arrivalAt);
    const current = groups[groups.length - 1];
    if (!current || arrival - current.startAt > 30 * 60_000) {
      groups.push({ startAt: arrival, endAt: arrival, entries: [entry] });
      return;
    }
    current.endAt = Math.max(current.endAt, arrival);
    current.entries.push(entry);
  });
  return groups;
}

function humanList(items) {
  if (items.length <= 1) return items[0] || '';
  if (items.length === 2) return `${items[0]} et ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} et ${items.at(-1)}`;
}

function arrivalTiming(entries) {
  const arrivals = [...new Set(entries.map((item) => Number(item.arrivalAt)).filter(Number.isFinite))]
    .sort((a, b) => a - b);
  if (!arrivals.length) return '';
  if (arrivals.length <= 3) return `vers ${humanList(arrivals.map(formatClock))} environ`;
  return `entre ${formatClock(arrivals[0])} et ${formatClock(arrivals.at(-1))} environ`;
}

function futureGroupDisplay(group) {
  const subject = intentionPeopleLabel(group.entries);
  const timing = arrivalTiming(group.entries);
  if (group.startAt === group.endAt) return {
    title: `${subject} ${timing}.`,
    text: intentionGamesLine(group.entries)
  };
  return {
    title: `${subject}.`,
    text: `Arrivées prévues ${timing}. ${intentionGamesLine(group.entries)}`
  };
}

function pastIntentionsTitle(entries) {
  const subject = intentionPeopleLabel(entries)
    .replace('pense passer', 'pensait passer')
    .replace('pensent passer', 'pensaient passer');
  const timing = arrivalTiming(entries);
  return timing ? `${subject} ${timing}.` : `${subject}.`;
}

function pastIntentionsText(entries, stale = false) {
  const unknownGroupOnly = entries.length === 1 && entries[0].group === true && !intentionCountKnown(entries[0]);
  if (stale) {
    if (unknownGroupOnly) return 'Le site ne sait pas si ce groupe est encore là.';
    const people = entries.filter(intentionCountKnown).reduce((sum, item) => sum + (Number(item.peopleCount) || 1), 0);
    if (people === 1 && entries.length === 1) return 'Le site ne sait pas si cette personne est encore là.';
    return 'Le site ne sait pas si ces personnes sont encore là.';
  }
  if (unknownGroupOnly) return 'Ce groupe est peut-être déjà là.';
  const people = entries.filter(intentionCountKnown).reduce((sum, item) => sum + (Number(item.peopleCount) || 1), 0);
  if (people === 1 && entries.length === 1) return 'Cette personne est peut-être déjà là.';
  return 'Ces personnes sont peut-être déjà là.';
}

function setStatusDetails(items) {
  const container = $('statusDetails');
  if (!container) return;
  container.replaceChildren();
  items.forEach(({ title, text = '' }) => {
    const item = document.createElement('p');
    item.className = 'status-item';
    const strong = document.createElement('strong');
    strong.textContent = title;
    item.appendChild(strong);
    if (text) {
      const small = document.createElement('small');
      small.textContent = text;
      item.appendChild(small);
    }
    container.appendChild(item);
  });
  container.hidden = items.length === 0;
}

function renderStatus() {
  const now = Date.now();
  const presences = activePresences();
  const searchers = presences.filter((item) => item.searching === true && Number(item.searchUntil) > now);
  const otherPresences = presences.filter((item) => !(item.searching === true && Number(item.searchUntil) > now));
  const needs = activeGameNeeds();
  const todayEntries = activeIntentionsForKey(todayEventKey()).map(([, entry]) => entry);
  const recentPast = todayEntries.filter((entry) => {
    const arrival = Number(entry.arrivalAt);
    return arrival <= now && arrival >= now - RECENT_INTENTION_MINUTES * 60_000;
  });
  const latePast = todayEntries.filter((entry) => {
    const arrival = Number(entry.arrivalAt);
    return arrival < now - RECENT_INTENTION_MINUTES * 60_000
      && arrival >= now - LATE_INTENTION_MINUTES * 60_000;
  });
  const future = todayEntries.filter((entry) => Number(entry.arrivalAt) > now);
  const futureGroups = groupFutureIntentions(future);
  const detailItems = [];
  let title = 'Pour l’instant, personne ne s’est signalé sur le site.';
  let text = 'Il peut quand même y avoir des joueurs. Vous pouvez passer librement.';
  let updatedAt = null;
  let tone = 'quiet';

  if (searchers.length) {
    const searchPeople = presencePeopleCount(searchers);
    const latestSearch = Math.max(...searchers.map((item) => Number(item.searchUntil) || 0));
    title = searchPeople === 1
      ? 'Quelqu’un cherche une personne pour jouer maintenant.'
      : 'Plusieurs personnes cherchent à jouer en ce moment.';
    text = `${searchGamesLine(searchers, presences)} ${searchPeople === 1 ? 'La personne pense' : 'Au moins une personne pense'} rester disponible jusqu’à ${formatClock(latestSearch)} environ.`;
    updatedAt = Math.max(...searchers.map((item) => Number(item.updatedAt) || 0));
    tone = 'live';
  } else if (otherPresences.length) {
    const people = presencePeopleCount(otherPresences);
    const latest = Math.max(...otherPresences.map((item) => Number(item.untilAt) || 0));
    title = people === 1
      ? 'Une personne dit être au quai.'
      : `${people} personnes disent être au quai.`;
    text = people === 1
      ? `Elle pense rester jusqu’à ${formatClock(latest)} environ. ${currentGamesLine(otherPresences)}`
      : `Certaines pensent rester jusqu’à ${formatClock(latest)} environ. ${currentGamesLine(otherPresences)}`;
    updatedAt = Math.max(...otherPresences.map((item) => Number(item.updatedAt) || 0));
    tone = 'live';
  } else if (recentPast.length) {
    title = pastIntentionsTitle(recentPast);
    text = pastIntentionsText(recentPast);
    updatedAt = Math.max(...recentPast.map((item) => Number(item.updatedAt) || 0));
    tone = 'soft';
  } else if (futureGroups.length) {
    const first = futureGroups[0];
    const display = futureGroupDisplay(first);
    title = display.title;
    text = display.text;
    updatedAt = Math.max(...first.entries.map((item) => Number(item.updatedAt) || 0));
    tone = 'soft';
  } else if (latePast.length) {
    title = pastIntentionsTitle(latePast);
    text = pastIntentionsText(latePast, true);
    updatedAt = Math.max(...latePast.map((item) => Number(item.updatedAt) || 0));
    tone = 'quiet';
  }

  if (searchers.length && otherPresences.length) {
    const people = presencePeopleCount(otherPresences);
    const latest = Math.max(...otherPresences.map((item) => Number(item.untilAt) || 0));
    detailItems.push({
      title: people === 1 ? 'Une autre personne dit aussi être au quai.' : `${people} autres personnes disent aussi être au quai.`,
      text: people === 1 ? `Elle pense rester jusqu’à ${formatClock(latest)} environ.` : `Certaines pensent rester jusqu’à ${formatClock(latest)} environ.`
    });
  }

  if ((searchers.length || otherPresences.length) && recentPast.length) {
    detailItems.push({
      title: pastIntentionsTitle(recentPast),
      text: pastIntentionsText(recentPast).replace(' Il peut malgré tout y avoir des joueurs.', '')
    });
  }

  const primaryUsesFuture = !searchers.length && !otherPresences.length && !recentPast.length && futureGroups.length > 0;
  const remainingFutureGroups = futureGroups.slice(primaryUsesFuture ? 1 : 0);
  const maximumFutureDetails = primaryUsesFuture ? 2 : 3;
  const maximumDetails = 4;
  const availablePlaces = Math.max(0, maximumDetails - detailItems.length);
  let detailedFutureCount = Math.min(remainingFutureGroups.length, maximumFutureDetails, availablePlaces);
  let futureSummaryNeeded = remainingFutureGroups.length > detailedFutureCount;
  if (futureSummaryNeeded && detailedFutureCount === availablePlaces && detailedFutureCount > 0) detailedFutureCount -= 1;
  remainingFutureGroups.slice(0, detailedFutureCount).forEach((group) => {
    detailItems.push(futureGroupDisplay(group));
  });
  futureSummaryNeeded = remainingFutureGroups.length > detailedFutureCount;
  if (futureSummaryNeeded && detailItems.length < maximumDetails) {
    detailItems.push({ title: 'D’autres personnes pensent aussi passer plus tard.' });
  }
  if (latePast.length && (searchers.length || otherPresences.length || recentPast.length || futureGroups.length)) {
    const lateTitle = pastIntentionsTitle(latePast);
    const lateText = pastIntentionsText(latePast, true);
    if (detailItems.length < maximumDetails) detailItems.push({ title: lateTitle, text: lateText });
  }

  $('statusTitle').textContent = title;
  $('statusText').textContent = text;
  setStatusDetails(detailItems);
  $('todayCard').dataset.tone = tone;
  $('freshness').textContent = updatedAt ? `Mis à jour à ${formatClock(updatedAt)}` : '';
  $('freshness').hidden = !updatedAt;
  const needVisible = needs.length > 0 && presences.length > 0;
  $('needLine').textContent = needs.length === 1 ? 'Un jeu supplémentaire serait utile en ce moment.' : 'Plusieurs jeux supplémentaires seraient utiles en ce moment.';
  $('needOffer').hidden = !needVisible;
  const todayPlan = myIntentionFor(todayEventKey());
  const alreadyHasGame = active(myPresence) && myPresence.hasGameKnown === true && myPresence.hasGame === true;
  const alreadyPlansGame = active(todayPlan) && (todayPlan.gamesMultiple === true || (intentionGamesKnown(todayPlan) && Number(todayPlan.gamesCount) > 0));
  const bringButton = $('bringGameButton');
  bringButton.hidden = !needVisible || alreadyHasGame || alreadyPlansGame;
  bringButton.textContent = active(myPresence)
    ? 'J’ai un jeu avec moi'
    : active(todayPlan) ? 'Je prévois d’apporter un jeu' : 'Je peux apporter un jeu';
  const todayBrice = briceTextFor(todayEventKey());
  $('todayBriceLine').textContent = todayBrice;
  $('todayBriceLine').hidden = !todayBrice;
  const conditionTimes = [
    ...(presences.length || recentPast.length ? [now] : []),
    ...future.map((entry) => Number(entry.arrivalAt))
  ].filter(Number.isFinite);
  const todayWeather = todayConditionSummary(conditionTimes);
  $('todayWeatherLine').textContent = todayWeather;
  $('todayWeatherLine').hidden = !todayWeather;
  if (conditionTimes.length) ensureWeather();
}

function renderRendezvous() {
  const card = $('rendezvousCard');
  if (!active(rendezvous) || typeof rendezvous.message !== 'string') { card.hidden = true; return; }
  const occurrence = rendezvousOccurrence();
  const cancelled = rendezvousCancelled();
  const type = cancelled ? 'cancelled' : ['proposed', 'maintained', 'present', 'info'].includes(rendezvous.type) ? rendezvous.type : 'info';
  const labels = { proposed: 'Rendez-vous proposé', maintained: 'Le rendez-vous tient toujours', present: 'Sur place maintenant', info: 'Information', cancelled: 'Rendez-vous annulé' };
  card.dataset.type = type;
  $('rendezvousBadge').textContent = labels[type];
  $('rendezvousMessage').textContent = cancelled && rendezvous.cancelledMessage ? rendezvous.cancelledMessage : rendezvous.message;
  const hasEvent = Number.isFinite(occurrence);
  $('rendezvousMeta').textContent = hasEvent ? formatEvent(occurrence) + (rendezvous.repeatWeekly === true ? ' · chaque semaine' : '') : '';
  $('rendezvousMeta').hidden = !hasEvent;
  const key = rendezvousKey();
  const briceLine = key ? briceTextFor(key) : '';
  $('briceLine').textContent = briceLine;
  $('briceLine').hidden = !briceLine;
  const planned = key ? activeIntentionsForKey(key) : [];
  const attendance = planned.length ? summarizeRendezvousIntentions(planned) : '';
  $('rendezvousAttendanceLine').textContent = attendance;
  $('rendezvousAttendanceLine').hidden = !attendance;

  const weather = $('weatherLine');
  if (typeof rendezvous.weather === 'string' && rendezvous.weather.trim()) {
    weather.textContent = rendezvous.weather.trim(); weather.hidden = false;
  } else {
    const auto = hasEvent ? autoWeatherFor(occurrence) : '';
    weather.textContent = auto; weather.hidden = !auto;
    if (hasEvent) ensureWeather();
  }
  const joinButton = $('rdvJoinButton');
  joinButton.hidden = !(hasEvent && !cancelled && ['proposed', 'maintained'].includes(type)) || Boolean(key && active(myIntentionFor(key)));
  $('rdvMapButton').hidden = false;
  const calButton = $('rdvCalendarButton');
  if (hasEvent && !cancelled) { calButton.hidden = false; calButton.href = icsFor(rendezvous, occurrence); }
  else calButton.hidden = true;
  $('rdvInviteButton').hidden = !(hasEvent && !cancelled && ['proposed', 'maintained'].includes(type));
  card.hidden = false;
}

function intentionGameText(entry) {
  if (!intentionGamesKnown(entry)) return entry.gamesMultiple ? ', avec plusieurs jeux prévus' : ', jeux non précisés';
  const count = Number(entry.gamesCount) || 0;
  return count === 0 ? ', sans jeu prévu' : count === 1 ? ', avec un jeu prévu' : `, avec ${count} jeux prévus`;
}
function makeButton(label, className, onClick, locks = false) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = className; button.textContent = label;
  if (locks) button.dataset.locks = '';
  button.addEventListener('click', onClick);
  return button;
}
function renderIntentions() {
  const todayContainer = $('intentionsList');
  const rendezvousContainer = $('rendezvousIntentionsList');
  todayContainer.innerHTML = '';
  rendezvousContainer.innerHTML = '';
  const currentRendezvousKey = rendezvousKey();
  const items = myIntentions();
  items.forEach(({ key, entry }) => {
    const container = key === currentRendezvousKey ? rendezvousContainer : todayContainer;
    const card = document.createElement('section'); card.className = 'state-card';
    const heading = document.createElement('h3');
    const future = !isSameParisDay(Number(entry.arrivalAt), Date.now());
    const companyText = entry.group
      ? intentionCountKnown(entry) ? `, en groupe de ${entry.peopleCount} personnes` : ', en groupe'
      : Number(entry.peopleCount) === 2 ? ', à deux' : '';
    heading.textContent = entry.returning
      ? `Vous pensez repasser aujourd’hui vers ${formatClock(Number(entry.arrivalAt))} environ${companyText}${intentionGameText(entry)}.`
      : future
        ? `Vous pensez venir ${formatEvent(Number(entry.arrivalAt))}${companyText}${intentionGameText(entry)}.`
        : `Vous pensez passer aujourd’hui vers ${formatClock(Number(entry.arrivalAt))} environ${companyText}${intentionGameText(entry)}.`;
    card.appendChild(heading);

    const isRdv = key === rendezvousKey();
    const cancelled = isRdv && rendezvousCancelled();
    if (cancelled) {
      const warning = document.createElement('p'); warning.className = 'need-line';
      warning.textContent = 'Ce rendez-vous est annoncé comme annulé. Vous pouvez retirer cette venue. Si vous êtes tout de même au quai, utilisez « Je suis au quai ».';
      card.appendChild(warning);
    }
    const weatherText = !isRdv ? autoWeatherFor(Number(entry.arrivalAt)) : '';
    if (weatherText) { const weather = document.createElement('p'); weather.className = 'weather-line'; weather.textContent = weatherText; card.appendChild(weather); }

    if (entry.wantsBrice === true) {
      const briceRequest = document.createElement('p');
      briceRequest.className = 'brice-line';
      const response = briceTextFor(key);
      briceRequest.textContent = response
        ? `Réponse de Brice : ${response}`
        : 'Vous avez demandé à Brice s’il pense être là. Il répondra ici s’il le peut, quand il aura le temps.';
      card.appendChild(briceRequest);
    }

    const solo = !entry.group && Number(entry.peopleCount) === 1;
    const edits = document.createElement('div'); edits.className = 'state-edit-links';
    edits.appendChild(makeButton('Changer l’heure', 'button quiet-link', () => editIntention(key, entry, 'time'), true));
    const peopleLabel = entry.group && !intentionCountKnown(entry)
      ? 'Changer qui vient ou indiquer le nombre'
      : 'Changer qui vient';
    edits.appendChild(makeButton(peopleLabel, 'button quiet-link', () => editIntention(key, entry, 'people'), true));
    const gamesLabel = intentionGamesKnown(entry) || entry.gamesMultiple
      ? 'Changer les jeux prévus'
      : solo ? 'Dire si j’apporte un jeu' : 'Dire si nous apportons un jeu';
    edits.appendChild(makeButton(gamesLabel, 'button quiet-link', () => editIntention(key, entry, 'games'), true));
    edits.appendChild(makeButton(
      entry.wantsBrice === true ? 'Retirer ma demande à Brice' : 'Demander si Brice pense être là',
      'button quiet-link', () => changeIntentionBrice(key, entry), true
    ));
    card.appendChild(edits);

    const actions = document.createElement('div'); actions.className = `state-actions ${!future && !cancelled ? 'two' : ''}`;
    if (!future && !cancelled) {
      const arrivalLabel = entry.returning
        ? solo ? 'Je suis de retour' : 'Nous sommes de retour'
        : solo ? 'Je suis au quai' : 'Nous sommes au quai';
      actions.appendChild(makeButton(arrivalLabel, 'button primary', () => arriveFromIntention(key, entry), true));
    }
    const cancelLabel = entry.returning
      ? solo ? 'Je ne repasserai pas' : 'Nous ne repasserons pas'
      : solo ? 'Je ne viendrai pas' : 'Nous ne viendrons pas';
    actions.appendChild(makeButton(cancelLabel, 'button soft', () => cancelIntention(key, entry), true));
    card.appendChild(actions);

    const inviteLine = document.createElement('p'); inviteLine.className = 'secondary-line';
    inviteLine.appendChild(makeButton(solo ? 'Inviter quelqu’un à venir avec moi' : 'Inviter quelqu’un à venir avec nous', 'button quiet-link', () => {
      const when = future ? formatEvent(Number(entry.arrivalAt)) : `aujourd’hui vers ${formatClock(Number(entry.arrivalAt))}`;
      const verb = entry.returning ? 'repasser' : 'passer';
      invite(`Je pense ${verb} au quai des Bateliers ${when} pour jouer aux échecs. Ça te dit de venir ?`);
    }));
    card.appendChild(inviteLine);
    container.appendChild(card);
  });
}

function renderMine() {
  const present = active(myPresence);
  $('restActions').hidden = present;
  $('presentCard').hidden = !present;
  $('stickyPresence').hidden = !present;
  document.body.classList.toggle('has-sticky', present);
  const plannedToday = Boolean(myIntentionFor(todayEventKey()));
  $('planButton').disabled = busy;
  $('planButton').hidden = plannedToday;
  $('presenceGrid')?.classList.toggle('one', plannedToday);
  if ($('actionsLabel')) $('actionsLabel').textContent = plannedToday
    ? 'Vous êtes maintenant au quai ?'
    : 'Vous êtes déjà au quai ou vous pensez passer ?';
  if (present) {
    const searching = myPresence.searching === true && Number(myPresence.searchUntil) > Date.now();
    $('presentTitle').textContent = `Vous êtes au quai jusqu’à ${formatClock(Number(myPresence.untilAt))} environ.`;
    const people = Math.min(30, Math.max(1, Number(myPresence.peopleCount) || 1));
    const solo = people === 1;
    const peopleText = solo ? 'une personne' : people === 2 ? 'deux personnes' : `${people} personnes`;
    const gameText = myPresence.hasGame === true ? 'avec au moins un jeu' : 'sans jeu';
    const recorded = `Pour les autres : ${peopleText}, ${gameText}.`;
    $('presentText').textContent = searching
      ? `${recorded} Les autres voient aussi que vous cherchez quelqu’un jusqu’à ${formatClock(Number(myPresence.searchUntil))} environ.`
      : `${recorded} Profitez du moment ; vous pouvez ranger le téléphone.`;
    $('presentLeave').textContent = solo ? 'Je pars' : 'Nous partons';
    $('stickyLeave').textContent = solo ? 'Je pars' : 'Nous partons';
    $('searchButton').classList.toggle('is-active', searching);
    $('searchButton').querySelector('strong').textContent = searching
      ? solo ? 'Je ne cherche plus' : 'Nous ne cherchons plus'
      : solo ? 'Je cherche quelqu’un pour jouer' : 'Nous cherchons quelqu’un pour jouer';
    $('inviteSearchButton').hidden = !searching;
    const myNeed = currentUser ? allGameNeeds[currentUser.uid] : null;
    const needActive = active(myNeed);
    $('needGameButton').textContent = needActive ? 'Le jeu est arrivé' : solo ? 'Il me manque un jeu' : 'Il nous manque un jeu';
    $('askGameButton').hidden = !needActive;
    $('stickyTitle').textContent = `Au quai jusqu’à ${formatClock(Number(myPresence.untilAt))} environ.`;
  }
  renderIntentions();
  renderRetry();
}
function requiredIntentionKeysLoaded() {
  return intentionKeysToWatch().every((key) => loadedIntentionKeys.has(key));
}
function publicDataLoaded() {
  return Object.values(readState).every(Boolean) && requiredIntentionKeysLoaded();
}
function showPublicWaiting(title = 'Un instant, nous regardons ce qui se passe au quai…', text = 'Quelques secondes peuvent être nécessaires à la première ouverture.') {
  $('todayCard')?.setAttribute('aria-busy', 'true');
  $('statusTitle').textContent = title;
  $('statusText').textContent = text;
  setStatusDetails([]);
  $('freshness').hidden = true;
  $('needOffer').hidden = true;
  $('todayBriceLine').hidden = true;
  $('todayWeatherLine').hidden = true;
  $('rendezvousCard').hidden = true;
}
function clearPublicDynamicState() {
  $('intentionsList')?.replaceChildren();
  $('rendezvousIntentionsList')?.replaceChildren();
  if ($('presentCard')) $('presentCard').hidden = true;
  if ($('stickyPresence')) $('stickyPresence').hidden = true;
  document.body.classList.remove('has-sticky');
}
function handlePublicReadError(error) {
  console.error(error);
  $('todayCard')?.setAttribute('aria-busy', 'false');
  publicReadError = true;
  setBusy(true);
  clearPublicDynamicState();
  showPublicWaiting('Nous n’arrivons pas à voir ce qui se passe au quai.', 'Vous pouvez malgré tout consulter le lieu et passer librement.');
}
function renderAll() {
  if (!currentUser) return;
  if (publicReadError) {
    setBusy(true);
    showPublicWaiting('Nous n’arrivons pas à voir ce qui se passe au quai.', 'Vous pouvez malgré tout consulter le lieu et passer librement.');
    return;
  }
  if (!publicDataLoaded()) {
    setBusy(true);
    showPublicWaiting();
    return;
  }
  setBusy(false);
  $('todayCard')?.setAttribute('aria-busy', 'false');
  renderStatus(); renderRendezvous(); renderMine();
}

// ---------------------------------------------------------------------------
// Ecoutes Firebase
// ---------------------------------------------------------------------------
function stopAll() {
  unsub.forEach((fn) => fn && fn()); unsub = [];
  intentionUnsubs.forEach((fn) => fn && fn()); intentionUnsubs.clear();
  intentionsByEvent = {};
  readState = { presence: false, gameNeeds: false, rendezvous: false, brice: false };
  loadedIntentionKeys = new Set();
  publicReadError = false;
}
function refreshIntentionSubscriptions() {
  const wanted = new Set(intentionKeysToWatch());
  intentionUnsubs.forEach((off, key) => {
    if (wanted.has(key)) return;
    if (off) off(); intentionUnsubs.delete(key); delete intentionsByEvent[key]; loadedIntentionKeys.delete(key);
  });
  wanted.forEach((key) => {
    if (intentionUnsubs.has(key)) return;
    const off = onValue(ref(database, `${ROOT}/intentions/${key}`), (snap) => {
      intentionsByEvent[key] = snap.val() || {};
      loadedIntentionKeys.add(key);
      renderAll();
    }, handlePublicReadError);
    intentionUnsubs.set(key, off);
  });
}
function startAll(user) {
  stopAll();
  unsub.push(onValue(ref(database, `${ROOT}/presence`), (snap) => {
    allPresence = snap.val() || {};
    myPresence = allPresence[user.uid] || null;
    readState.presence = true;
    renderAll();
  }, handlePublicReadError));
  unsub.push(onValue(ref(database, `${ROOT}/gameNeeds`), (snap) => {
    allGameNeeds = snap.val() || {};
    readState.gameNeeds = true;
    renderAll();
  }, handlePublicReadError));
  unsub.push(onValue(ref(database, `${ROOT}/rendezvous`), (snap) => {
    rendezvous = snap.val();
    readState.rendezvous = true;
    refreshIntentionSubscriptions();
    renderAll();
  }, handlePublicReadError));
  unsub.push(onValue(ref(database, `${ROOT}/brice`), (snap) => {
    briceByContext = snap.val() || {};
    readState.brice = true;
    renderAll();
  }, handlePublicReadError));
  refreshIntentionSubscriptions();
}

// ---------------------------------------------------------------------------
// Boutons
// ---------------------------------------------------------------------------
$('hereButton')?.addEventListener('click', flowHere);
$('planButton')?.addEventListener('click', () => flowPlan(null, todayEventKey()));
$('searchButton')?.addEventListener('click', flowSearch);
$('editPresenceButton')?.addEventListener('click', flowEditPresence);
$('needGameButton')?.addEventListener('click', flowNeedGame);
$('bringGameButton')?.addEventListener('click', flowBringGame);
$('stickyLeave')?.addEventListener('click', flowLeave);
$('presentLeave')?.addEventListener('click', flowLeave);
$('ideaLink')?.addEventListener('click', (event) => { event.preventDefault(); sendIdea(); });
$('shareProjectButton')?.addEventListener('click', () => invite('Au quai des Bateliers à Strasbourg, on peut jouer aux échecs librement, gratuitement et sans inscription. Le site permet de voir si quelqu’un est au quai ou pense passer.', SITE_URL));
$('inviteSearchButton')?.addEventListener('click', () => invite(searchInviteText()));
$('askGameButton')?.addEventListener('click', () => invite(gameInviteText()));
$('rdvJoinButton')?.addEventListener('click', () => {
  const occurrence = rendezvousOccurrence(); const key = rendezvousKey();
  if (Number.isFinite(occurrence) && key) flowPlan(occurrence, key);
});
$('rdvInviteButton')?.addEventListener('click', () => {
  const occurrence = rendezvousOccurrence();
  const when = Number.isFinite(occurrence) ? ` ${formatEvent(occurrence)}` : '';
  invite(`Un rendez-vous d’échecs est proposé au quai des Bateliers${when}. Ça te dit de venir ?`);
});

document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => closeDialog($(button.dataset.close))));
document.querySelectorAll('dialog').forEach((dialog) => {
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog(dialog);
  });
});

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------
setBusy(true);
$('statusTitle').textContent = 'Un instant, nous regardons ce qui se passe au quai…';
$('statusText').textContent = 'Quelques secondes peuvent être nécessaires à la première ouverture.';
let signingIn = false;
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    setBusy(true);
    currentUser = null; stopAll(); allPresence = {}; allGameNeeds = {}; myPresence = null;
    showPublicWaiting();
    if (signingIn) return;
    signingIn = true;
    try { await signInAnonymously(auth); }
    catch (error) {
      console.error(error); $('todayCard')?.setAttribute('aria-busy', 'false'); $('statusTitle').textContent = 'Nous n’arrivons pas à voir ce qui se passe au quai.'; $('statusText').textContent = 'Vous pouvez malgré tout consulter le lieu et passer librement.';
    } finally { signingIn = false; }
    return;
  }
  currentUser = user;
  startAll(user);
});

setInterval(() => {
  if (currentUser) refreshIntentionSubscriptions();
  retryPendingNotification();
  if (active(rendezvous) || myIntentions().length || activePresences().length || activeIntentionsForKey(todayEventKey()).length) ensureWeather();
  renderAll();
}, 30_000);
