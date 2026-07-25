// Le Quai joue — tableau de bord privé (modèle v7).

import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js';
import {
  browserLocalPersistence, getAuth, getRedirectResult, GoogleAuthProvider,
  onAuthStateChanged, setPersistence, signInWithPopup, signInWithRedirect, signOut
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js';
import { getDatabase, onValue, ref, remove, set, update } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js';
import {
  parisParts, timestampForParisDateTime, todayEventKey, formatClock,
  formatEvent, active, effectiveEventAt, isCancelledOccurrence
} from './quai-common.js';

const firebaseConfig = {
  apiKey: 'AIzaSyDI7PBoU_zCIyBq1YtsBSywRYs5ByUPmLw', authDomain: 'le-quai-joue.firebaseapp.com',
  databaseURL: 'https://le-quai-joue-default-rtdb.europe-west1.firebasedatabase.app', projectId: 'le-quai-joue',
  storageBucket: 'le-quai-joue.firebasestorage.app', messagingSenderId: '623424877513',
  appId: '1:623424877513:web:4f6753430f929658a66e18'
};
const ADMIN_EMAIL = 'brice.grisly@gmail.com';
const ROOT = 'v7';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const database = getDatabase(app);
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: 'select_account' });
const $ = (id) => document.getElementById(id);

const loginPanel = $('loginPanel');
const dashboardPanel = $('dashboardPanel');
const unauthorizedPanel = $('unauthorizedPanel');
const loginButton = $('loginButton');
const logoutButton = $('logoutButton');
const unauthorizedLogoutButton = $('unauthorizedLogoutButton');
const accountText = $('accountText');
const unauthorizedEmail = $('unauthorizedEmail');
const feedback = $('feedback');
const form = $('announcementForm');
const typeInput = $('announcementType');
const messageInput = $('announcementMessage');
const eventAtInput = $('eventAt');
const eventFields = $('eventFields');
const weatherInput = $('announcementWeather');
const durationInput = $('announcementDuration');
const infoDurationField = $('infoDurationField');
const cancelScopeField = $('cancelScopeField');
const cancelScope = $('cancelScope');
const publishButton = $('publishButton');
const removeButton = $('removeButton');
const briceGames = $('briceGames');
const briceGamesKept = $('briceGamesKept');
const briceState = $('briceState');
const briceContext = $('briceContext');

let currentUser = null;
let rendezvous = null;
let briceByContext = {};
let allPresence = {};
let allGameNeeds = {};
let queries = {};
let ideas = {};
let intentionsByKey = {};
let unsubMain = [];
let intentionUnsub = new Map();
let hasRendezvous = false;

function isAdmin(user) {
  return Boolean(user && user.emailVerified === true && String(user.email || '').toLowerCase() === ADMIN_EMAIL);
}
function setFeedback(message, kind = 'info') {
  feedback.textContent = message;
  feedback.dataset.kind = kind;
  feedback.hidden = !message;
}
function setBusy(value) {
  [loginButton, publishButton, logoutButton, unauthorizedLogoutButton, $('briceYes'), $('briceNo'), $('briceUnsure'), briceGames, briceContext, cancelScope]
    .forEach((button) => { if (button) button.disabled = value; });
  briceGamesKept.disabled = value || briceGames.value === '0';
  removeButton.disabled = value || !hasRendezvous;
}
function syncBriceGamesKept() {
  if (briceGames.value === '0') briceGamesKept.value = 'unknown';
  briceGamesKept.disabled = briceGames.disabled || briceGames.value === '0';
}
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
function toLocalInput(ts) {
  const p = parisParts(Number(ts));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
function timestampFromParisInput(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value || '');
  if (!match) return NaN;
  const ts = timestampForParisDateTime(...match.slice(1).map(Number));
  return toLocalInput(ts) === value ? ts : NaN;
}
function intentionsForKey(key) {
  return Object.entries(intentionsByKey[key] || {}).filter(([, entry]) => active(entry) && entry.attending === true);
}
function intentionCountKnown(entry) { return entry?.countKnown !== false; }
function intentionGamesKnown(entry) { return entry?.gamesKnown !== false; }
function plannedHeadcount(entries) {
  return entries.map(([, entry]) => entry).filter(intentionCountKnown)
    .reduce((sum, entry) => sum + (Number(entry.peopleCount) || 1), 0);
}
function unknownGroupCount(entries) {
  return entries.map(([, entry]) => entry).filter((entry) => entry.group === true && !intentionCountKnown(entry)).length;
}
function gameSummary(entries) {
  const values = entries.map(([, entry]) => entry);
  const known = values.filter(intentionGamesKnown).reduce((sum, entry) => sum + Number(entry.gamesCount || 0), 0);
  const unknownMany = values.filter((entry) => !intentionGamesKnown(entry) && entry.gamesMultiple === true).length;
  const unknown = values.filter((entry) => !intentionGamesKnown(entry) && entry.gamesMultiple !== true).length;
  const explicitlyNone = values.length > 0 && values.every((entry) => intentionGamesKnown(entry) && Number(entry.gamesCount) === 0);
  if (explicitlyNone) return 'aucun jeu prévu';
  const parts = [];
  if (known === 1) parts.push('un jeu prévu');
  else if (known > 1) parts.push(`${known} jeux prévus`);
  if (unknownMany === 1) parts.push('plusieurs jeux prévus');
  else if (unknownMany > 1) parts.push(`${unknownMany} groupes prévoient plusieurs jeux`);
  if (unknown === 1) parts.push('jeux non précisés pour une venue');
  else if (unknown > 1) parts.push(`jeux non précisés pour ${unknown} venues`);
  return parts.join(', ');
}

function planningPeopleText(entries) {
  const people = plannedHeadcount(entries);
  const unknownGroups = unknownGroupCount(entries);
  if (unknownGroups === 1 && people === 0) return 'un groupe';
  if (unknownGroups > 0) return `${people ? `${people} personne${people > 1 ? 's' : ''} et ` : ''}${unknownGroups === 1 ? 'un groupe' : `${unknownGroups} groupes`}`;
  if (people === 1) return 'une personne';
  if (people === 2) return 'deux personnes';
  return `${people} personnes`;
}

function groupPlanningEntries(entries) {
  const sorted = entries.slice().sort((a, b) => Number(a[1].arrivalAt) - Number(b[1].arrivalAt));
  const groups = [];
  sorted.forEach((item) => {
    const arrival = Number(item[1].arrivalAt);
    const current = groups.at(-1);
    if (!current || arrival - current.startAt > 30 * 60_000) groups.push({ startAt: arrival, entries: [item] });
    else current.entries.push(item);
  });
  return groups;
}

function planningText(entries, label) {
  if (!entries.length) return `${label} : aucune venue annoncée.`;
  const groups = groupPlanningEntries(entries);
  const slots = groups.slice(0, 4).map((group) => {
    const times = [...new Set(group.entries.map(([, entry]) => Number(entry.arrivalAt)))].sort((a, b) => a - b);
    const timing = times.length === 1
      ? `vers ${formatClock(times[0])}`
      : `vers ${times.map(formatClock).join(' et ')}`;
    const games = gameSummary(group.entries);
    return `${planningPeopleText(group.entries)} ${timing}${games ? ` (${games})` : ''}`;
  });
  if (groups.length > 4) slots.push(`${groups.length - 4} autre${groups.length - 4 > 1 ? 's' : ''} créneau${groups.length - 4 > 1 ? 'x' : ''}`);
  return `${label} : ${slots.join(' ; ')}.`;
}
function activeGameNeedsWithPresence() {
  const presentIds = new Set(Object.entries(allPresence || {})
    .filter(([, entry]) => active(entry))
    .map(([uid]) => uid));
  return Object.entries(allGameNeeds || {})
    .filter(([uid, entry]) => presentIds.has(uid) && active(entry));
}

function flattenQueries() {
  const out = [];
  Object.entries(queries || {}).forEach(([contextKey, group]) => {
    Object.entries(group || {}).forEach(([uid, query]) => {
      if (active(query)) out.push({ contextKey, uid, query });
    });
  });
  return out;
}

function renderPresence() {
  const presences = Object.values(allPresence || {}).filter(active);
  const people = presences.reduce((sum, item) => sum + (Number(item.peopleCount) || 1), 0);
  const searchers = presences.filter((item) => item.searching === true && Number(item.searchUntil) > Date.now());
  const needs = activeGameNeedsWithPresence();
  $('presenceSummary').textContent = people === 0
    ? 'Personne n’a annoncé être au quai en ce moment.'
    : people === 1 ? 'Une personne a annoncé être au quai.'
      : `${people} personnes ont annoncé être au quai.`;
  const searchSummary = $('searchSummary');
  if (searchers.length) {
    const withGame = searchers.filter((item) => item.hasGameKnown === true && item.hasGame === true).length;
    const unknown = searchers.filter((item) => item.hasGameKnown !== true).length;
    searchSummary.textContent = `${searchers.length} recherche${searchers.length > 1 ? 's' : ''} d’un partenaire de jeu en cours${withGame ? `, dont ${withGame} avec un jeu` : ''}${unknown ? `, ${unknown} sans information sur le jeu` : ''}.`;
    searchSummary.hidden = false;
  } else searchSummary.hidden = true;
  const needSummary = $('needSummary');
  if (needs.length && presences.length) {
    needSummary.textContent = needs.length === 1 ? 'Un jeu supplémentaire serait utile au quai.' : 'Plusieurs jeux supplémentaires seraient utiles au quai.';
    needSummary.hidden = false;
  } else needSummary.hidden = true;
}

function renderPlanning() {
  const todayEntries = intentionsForKey(todayEventKey());
  $('planningTodaySummary').textContent = planningText(todayEntries, 'Aujourd’hui');
  const key = rendezvousKey();
  const rdvSummary = $('planningRdvSummary');
  if (key) {
    const occurrence = rendezvousOccurrence();
    rdvSummary.textContent = planningText(intentionsForKey(key), `Rendez-vous du ${formatEvent(occurrence)}`);
    if (rendezvousCancelled()) rdvSummary.textContent += ' Ce rendez-vous est annulé.';
    rdvSummary.hidden = false;
  } else rdvSummary.hidden = true;

  const list = $('queriesList');
  const block = $('queriesBlock');
  const activeQueries = flattenQueries();
  list.innerHTML = '';
  if (!activeQueries.length) { block.hidden = true; return; }
  block.hidden = false;
  activeQueries.sort((a, b) => Number(a.query.arrivalAt) - Number(b.query.arrivalAt)).forEach(({ contextKey, query }) => {
    const row = document.createElement('div'); row.className = 'list-item';
    const text = document.createElement('span'); text.className = 'text';
    const name = typeof query.firstName === 'string' && query.firstName ? query.firstName : 'Une personne';
    const context = contextKey === todayEventKey() ? 'aujourd’hui' : formatEvent(Number(query.arrivalAt));
    text.textContent = `${name} aimerait savoir si vous serez là ${context} (vers ${formatClock(Number(query.arrivalAt))}).`;
    row.appendChild(text); list.appendChild(row);
  });
}

function refreshBriceContextOptions() {
  const previous = briceContext.value;
  briceContext.innerHTML = '';
  const today = document.createElement('option'); today.value = todayEventKey(); today.textContent = 'Aujourd’hui'; briceContext.appendChild(today);
  const key = rendezvousKey();
  if (key) {
    const option = document.createElement('option'); option.value = key; option.textContent = `Le rendez-vous du ${formatEvent(rendezvousOccurrence())}`; briceContext.appendChild(option);
  }
  const available = [...briceContext.options].map((option) => option.value);
  briceContext.value = available.includes(previous) ? previous : todayEventKey();
}
function renderBrice() {
  refreshBriceContextOptions();
  const contextKey = briceContext.value;
  const brice = briceByContext?.[contextKey];
  if (active(brice) && brice.state) {
    briceState.textContent = brice.state === 'yes' ? 'Vous pensez être là' : brice.state === 'no' ? 'Vous ne pourrez pas venir' : 'Vous ne savez pas encore';
    briceGames.value = brice.gamesCountKnown === false ? 'unknown' : String(Math.min(5, Math.max(0, Number(brice.gamesCount) || 0)));
    briceGamesKept.value = ['yes', 'no', 'unknown'].includes(brice.gamesKept) ? brice.gamesKept : 'unknown';
  } else {
    briceState.textContent = 'Aucune réponse pour ce moment';
    briceGames.value = 'unknown';
    briceGamesKept.value = 'unknown';
  }
  $('briceHint').textContent = contextKey === todayEventKey()
    ? 'Cette réponse apparaîtra dans la rubrique « Aujourd’hui au quai ».'
    : 'Cette réponse apparaîtra dans la carte du prochain rendez-vous.';
  syncBriceGamesKept();
}

function renderRendezvous() {
  hasRendezvous = active(rendezvous);
  removeButton.disabled = !hasRendezvous;
  const card = $('currentRendezvous');
  if (!hasRendezvous || typeof rendezvous.message !== 'string') { card.hidden = true; return; }
  const occurrence = rendezvousOccurrence();
  const cancelled = rendezvousCancelled();
  const labels = { proposed: 'Rendez-vous proposé', maintained: 'Rendez-vous maintenu', present: 'Sur place', info: 'Information', cancelled: 'Rendez-vous annulé' };
  const displayType = cancelled ? 'cancelled' : rendezvous.type;
  const message = cancelled && rendezvous.cancelledMessage ? rendezvous.cancelledMessage : rendezvous.message;
  $('currentRdvMessage').textContent = `${labels[displayType] || 'Information'} : ${message}`;
  const eventText = Number.isFinite(occurrence) ? ` · prochain : ${formatEvent(occurrence)}${rendezvous.repeatWeekly === true ? ' · chaque semaine' : ''}` : '';
  $('currentRdvMeta').textContent = rendezvous.repeatWeekly === true
    ? `Série hebdomadaire${eventText}`
    : `Visible jusqu’au ${formatEvent(Number(rendezvous.expiresAt))}${eventText}`;
  if (Number.isFinite(occurrence)) eventAtInput.value = toLocalInput(occurrence);
  $('repeatWeekly').checked = rendezvous.repeatWeekly === true;
  card.hidden = false;
}

function renderIdeas() {
  const list = $('ideasList');
  const entries = Object.entries(ideas || {}).sort((a, b) => Number(b[1].createdAt) - Number(a[1].createdAt));
  if (!entries.length) { list.innerHTML = '<p class="muted">Aucun message reçu pour le moment.</p>'; return; }
  list.innerHTML = '';
  entries.forEach(([id, idea]) => {
    const row = document.createElement('div'); row.className = 'list-item';
    const wrap = document.createElement('div');
    const p = document.createElement('p'); p.className = 'idea-text'; p.textContent = String(idea.message || '');
    const meta = document.createElement('p'); meta.className = 'muted'; meta.style.margin = '4px 0 0'; meta.style.fontSize = '.82rem';
    meta.textContent = Number.isFinite(Number(idea.createdAt)) ? `Reçu le ${formatEvent(Number(idea.createdAt))}` : '';
    wrap.append(p, meta);
    const button = document.createElement('button'); button.className = 'action'; button.type = 'button'; button.textContent = 'Supprimer'; button.style.minHeight = '40px';
    button.addEventListener('click', async () => {
      if (!window.confirm('Supprimer définitivement ce message ?')) return;
      try { await remove(ref(database, `${ROOT}/private/ideas/${id}`)); } catch (error) { console.error(error); }
    });
    row.append(wrap, button); list.appendChild(row);
  });
}

function briceHasExpectedGame(contextKey) {
  const entry = briceByContext?.[contextKey];
  if (!active(entry)) return false;
  if (entry.state === 'yes' && entry.gamesCountKnown === true && Number(entry.gamesCount) > 0) return true;
  if (entry.state === 'no' && entry.gamesKept === 'yes') {
    return entry.gamesCountKnown === false || Number(entry.gamesCount) > 0;
  }
  return false;
}

function renderAlerts() {
  const alerts = [];
  const presences = Object.values(allPresence || {}).filter(active);
  const people = presences.reduce((sum, item) => sum + (Number(item.peopleCount) || 1), 0);
  const searchers = presences.filter((item) => item.searching === true && Number(item.searchUntil) > Date.now());
  const needs = activeGameNeedsWithPresence();
  if (people === 1) alerts.push({ text: 'Une personne a indiqué être au quai.', kind: 'good' });
  else if (people > 1) alerts.push({ text: `${people} personnes ont indiqué être au quai.`, kind: 'good' });
  searchers.forEach((item) => {
    const game = item.hasGameKnown !== true ? 'jeu non précisé' : item.hasGame === true ? 'un jeu est là' : 'sans jeu';
    alerts.push({ text: `Recherche d’un partenaire de jeu jusqu’à ${formatClock(Number(item.searchUntil))} environ, ${game}.`, kind: 'calm' });
  });
  if (needs.length) alerts.push({ text: needs.length === 1 ? 'Un jeu supplémentaire serait utile.' : 'Plusieurs jeux supplémentaires seraient utiles.', kind: 'warn' });
  [todayEventKey(), rendezvousKey()].filter(Boolean).forEach((key) => {
    const entries = intentionsForKey(key);
    if (!entries.length) return;
    const games = entries.map(([, entry]) => entry);
    const noKnownGame = games.every((entry) => intentionGamesKnown(entry) && Number(entry.gamesCount) === 0);
    if (noKnownGame && !briceHasExpectedGame(key)) {
      alerts.push({ text: `${key === todayEventKey() ? 'Aujourd’hui' : 'Au prochain rendez-vous'}, les personnes annoncées ne prévoient pas de jeu et Brice n’en a pas indiqué non plus.`, kind: 'warn' });
    }
  });
  const queryCount = flattenQueries().length;
  if (queryCount) alerts.push({ text: `${queryCount} demande${queryCount > 1 ? 's' : ''} concerne${queryCount > 1 ? 'nt' : ''} votre présence.`, kind: 'calm' });
  const container = $('alertsList');
  if (!alerts.length) { container.innerHTML = '<p class="muted">Rien de particulier à signaler pour le moment.</p>'; return; }
  container.innerHTML = '';
  alerts.forEach((alert) => {
    const element = document.createElement('article');
    element.className = `alert ${alert.kind === 'warn' ? 'warn' : alert.kind === 'good' ? 'good' : 'calm'}`;
    element.textContent = alert.text; container.appendChild(element);
  });
}
function renderAll() { renderPresence(); renderPlanning(); renderBrice(); renderRendezvous(); renderIdeas(); renderAlerts(); updateTypeFields(); }

function selectedBriceContext() { return briceContext.value || todayEventKey(); }
function briceExpiry(contextKey) {
  if (contextKey === todayEventKey()) {
    const p = parisParts();
    const tomorrow = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) + 1));
    return timestampForParisDateTime(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), 0, 0, 0);
  }
  const occurrence = rendezvousOccurrence();
  return Number.isFinite(occurrence) ? Math.min(occurrence + 8 * 3600_000, Date.now() + 40 * 86400_000) : Date.now() + 24 * 3600_000;
}
async function setBriceState(state) {
  if (!isAdmin(currentUser)) return;
  const contextKey = selectedBriceContext();
  const gamesCountKnown = briceGames.value !== 'unknown';
  const data = {
    state,
    gamesCountKnown,
    gamesCount: gamesCountKnown ? Math.min(5, Math.max(0, Number(briceGames.value) || 0)) : 0,
    gamesKept: briceGames.value === '0'
      ? 'unknown'
      : ['yes', 'no', 'unknown'].includes(briceGamesKept.value) ? briceGamesKept.value : 'unknown',
    updatedAt: Date.now(), expiresAt: briceExpiry(contextKey)
  };
  if (contextKey !== todayEventKey()) data.eventAt = Number(contextKey);
  try {
    setBusy(true);
    await update(ref(database), {
      [`${ROOT}/brice/${contextKey}`]: data,
      [`${ROOT}/private/queries/${contextKey}`]: null
    });
    setFeedback('C’est noté : votre réponse apparaîtra au bon endroit.', 'success');
  } catch (error) {
    console.error(error); setFeedback('La réponse n’a pas pu être publiée. Vérifiez le compte et les règles Firebase.', 'error');
  } finally { setBusy(false); }
}

function updateTypeFields() {
  const type = typeInput.value;
  const isInfo = type === 'info';
  const isCancelled = type === 'cancelled';
  eventFields.hidden = isInfo || isCancelled;
  infoDurationField.hidden = !isInfo;
  cancelScopeField.hidden = !(isCancelled && active(rendezvous) && rendezvous.repeatWeekly === true);
  eventAtInput.required = !isInfo && !isCancelled;
  messageInput.placeholder = isInfo
    ? 'Exemple : Un jeu avec des pièces stables sera plus pratique avec le vent.'
    : type === 'maintained' ? 'Exemple : Le rendez-vous de 18 h tient toujours.'
      : isCancelled ? 'Exemple : Le rendez-vous de ce soir est annulé.'
        : 'Exemple : Des parties sont proposées dimanche vers 18 h sur les galets.';
}

async function publish(event) {
  event.preventDefault();
  if (!isAdmin(currentUser)) { setFeedback('Ce compte n’est pas autorisé à publier.', 'error'); return; }
  const type = typeInput.value;
  const message = messageInput.value.trim();
  if (!message) { setFeedback('Écrivez le message à afficher.', 'error'); messageInput.focus(); return; }
  if (message.length > 240) { setFeedback('Le message doit rester sous 240 caractères.', 'error'); return; }
  const now = Date.now();

  try {
    setBusy(true); setFeedback('Publication en cours…');
    if (type === 'info') {
      const currentKey = rendezvousKey();
      if (currentKey && intentionsForKey(currentKey).length) throw new Error('RESPONSES_INFO');
      const hours = Number(durationInput.value);
      if (![2, 6, 12, 24].includes(hours)) throw new Error('DURATION');
      const payload = { type: 'info', message, updatedAt: now, expiresAt: now + hours * 3600_000 };
      const weather = weatherInput.value.trim(); if (weather) payload.weather = weather.slice(0, 160);
      await set(ref(database, `${ROOT}/rendezvous`), payload);
    } else if (type === 'cancelled') {
      const occurrence = rendezvousOccurrence();
      if (!active(rendezvous) || !Number.isFinite(occurrence)) throw new Error('NO_RDV');
      if (rendezvous.repeatWeekly === true && cancelScope.value === 'next') {
        await set(ref(database, `${ROOT}/rendezvous`), {
          ...rendezvous,
          cancelledOccurrenceAt: occurrence,
          cancelledMessage: message,
          updatedAt: now
        });
      } else {
        await set(ref(database, `${ROOT}/rendezvous`), {
          type: 'cancelled', message, eventAt: occurrence, repeatWeekly: false,
          updatedAt: now, expiresAt: Math.max(now + 3600_000, occurrence + 8 * 3600_000)
        });
      }
    } else {
      let eventAt = timestampFromParisInput(eventAtInput.value);
      if (!Number.isFinite(eventAt) || eventAt < now - 3600_000) throw new Error('DATE');
      if (eventAt > now + 30 * 86400_000) throw new Error('FAR');
      const repeatWeekly = $('repeatWeekly').checked;
      const currentOccurrence = rendezvousOccurrence();
      const sameMinute = Number.isFinite(currentOccurrence) && toLocalInput(currentOccurrence) === eventAtInput.value;
      if (sameMinute && active(rendezvous)) eventAt = repeatWeekly && rendezvous.repeatWeekly === true ? Number(rendezvous.eventAt) : Number(currentOccurrence);
      const nextEffective = repeatWeekly ? eventAt : eventAt;
      const oldKey = rendezvousKey();
      const newKey = String(Math.trunc(repeatWeekly && sameMinute && rendezvous?.repeatWeekly === true ? currentOccurrence : nextEffective));
      if (oldKey && oldKey !== newKey && intentionsForKey(oldKey).length) throw new Error('RESPONSES');
      const payload = {
        type, message, eventAt, repeatWeekly,
        updatedAt: now, expiresAt: repeatWeekly ? now + 364 * 86400_000 : eventAt + 8 * 3600_000
      };
      const weather = weatherInput.value.trim(); if (weather) payload.weather = weather.slice(0, 160);
      await set(ref(database, `${ROOT}/rendezvous`), payload);
    }
    setFeedback('L’information est publiée sur le site.', 'success');
    messageInput.value = ''; weatherInput.value = '';
  } catch (error) {
    console.error(error);
    const messages = {
      DURATION: 'Choisissez une durée valide.', NO_RDV: 'Aucun rendez-vous actif ne peut être annulé.',
      DATE: 'Choisissez la date et l’heure du rendez-vous.', FAR: 'Le rendez-vous doit être prévu dans les trente prochains jours.',
      RESPONSES: 'Ce rendez-vous a déjà reçu des réponses. Annulez-le ou conservez sa date au lieu de le déplacer.',
      RESPONSES_INFO: 'Ce rendez-vous a déjà reçu des réponses. Annulez-le ou attendez leur retrait avant de le remplacer par une information.'
    };
    setFeedback(messages[error.message] || 'Publication refusée. Vérifiez le compte utilisé et les règles Firebase.', 'error');
  } finally { setBusy(false); }
}

async function removeRendezvous() {
  if (!isAdmin(currentUser)) return;
  const key = rendezvousKey();
  if (key && intentionsForKey(key).length) {
    setFeedback('Des personnes ont répondu à ce rendez-vous. Annoncez son annulation plutôt que de le retirer, afin que leur venue reste visible et annulable.', 'error');
    return;
  }
  if (!window.confirm('Retirer cette information du site ?')) return;
  try { setBusy(true); await remove(ref(database, `${ROOT}/rendezvous`)); setFeedback('L’information a été retirée.', 'success'); }
  catch (error) { console.error(error); setFeedback('Impossible de retirer l’information.', 'error'); }
  finally { setBusy(false); }
}

async function login() {
  setBusy(true); setFeedback('Ouverture de la connexion Google…');
  try {
    await setPersistence(auth, browserLocalPersistence); await signInWithPopup(auth, provider);
  } catch (error) {
    console.error(error);
    if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment'].includes(error.code)) { await signInWithRedirect(auth, provider); return; }
    setFeedback(error.code === 'auth/popup-closed-by-user' ? 'Connexion annulée.' : 'La connexion Google a échoué. Réessayez.', 'error');
  } finally { setBusy(false); }
}
async function logout() {
  setBusy(true); try { await signOut(auth); }
  catch (error) { console.error(error); setFeedback('La déconnexion a échoué.', 'error'); }
  finally { setBusy(false); }
}
function showPanel(name, user = null) {
  loginPanel.hidden = name !== 'login'; dashboardPanel.hidden = name !== 'dashboard'; unauthorizedPanel.hidden = name !== 'unauthorized';
  if (name === 'dashboard' && user) accountText.textContent = `Connecté avec ${user.email}`;
  if (name === 'unauthorized' && user) unauthorizedEmail.textContent = user.email || 'ce compte';
}

function watchIntentionKey(key) {
  if (!key || intentionUnsub.has(key)) return;
  const off = onValue(ref(database, `${ROOT}/intentions/${key}`), (snap) => {
    intentionsByKey[key] = snap.val() || {}; renderAll();
  }, (error) => console.error(error));
  intentionUnsub.set(key, off);
}
function refreshIntentionWatches() {
  const wanted = new Set([todayEventKey()]);
  const key = rendezvousKey(); if (key) wanted.add(key);
  intentionUnsub.forEach((off, watchedKey) => {
    if (wanted.has(watchedKey)) return;
    if (off) off(); intentionUnsub.delete(watchedKey); delete intentionsByKey[watchedKey];
  });
  wanted.forEach(watchIntentionKey);
}
function startListeners() {
  stopListeners();
  unsubMain.push(onValue(ref(database, `${ROOT}/rendezvous`), (snap) => {
    rendezvous = snap.val(); refreshIntentionWatches(); renderAll();
  }, (error) => { console.error(error); setFeedback('Impossible de lire le rendez-vous.', 'error'); }));
  unsubMain.push(onValue(ref(database, `${ROOT}/brice`), (snap) => {
    briceByContext = snap.val() || {};
    const cleanup = {};
    Object.entries(briceByContext).forEach(([contextKey, entry]) => {
      if (!active(entry)) cleanup[`${ROOT}/brice/${contextKey}`] = null;
    });
    if (Object.keys(cleanup).length) update(ref(database), cleanup).catch(console.error);
    renderAll();
  }, console.error));
  unsubMain.push(onValue(ref(database, `${ROOT}/presence`), (snap) => { allPresence = snap.val() || {}; renderAll(); }, console.error));
  unsubMain.push(onValue(ref(database, `${ROOT}/gameNeeds`), (snap) => { allGameNeeds = snap.val() || {}; renderAll(); }, console.error));
  unsubMain.push(onValue(ref(database, `${ROOT}/private/queries`), (snap) => {
    queries = snap.val() || {};
    const cleanup = {};
    Object.entries(queries).forEach(([contextKey, group]) => Object.entries(group || {}).forEach(([uid, query]) => {
      if (!active(query)) cleanup[`${ROOT}/private/queries/${contextKey}/${uid}`] = null;
    }));
    if (Object.keys(cleanup).length) update(ref(database), cleanup).catch(console.error);
    renderAll();
  }, console.error));
  unsubMain.push(onValue(ref(database, `${ROOT}/private/ideas`), (snap) => { ideas = snap.val() || {}; renderAll(); }, console.error));
  refreshIntentionWatches();
}
function stopListeners() {
  unsubMain.forEach((fn) => fn && fn()); unsubMain = [];
  intentionUnsub.forEach((fn) => fn && fn()); intentionUnsub.clear();
  intentionsByKey = {};
}

loginButton.addEventListener('click', login);
logoutButton.addEventListener('click', logout);
unauthorizedLogoutButton.addEventListener('click', logout);
form.addEventListener('submit', publish);
removeButton.addEventListener('click', removeRendezvous);
typeInput.addEventListener('change', updateTypeFields);
briceContext.addEventListener('change', renderBrice);
briceGames.addEventListener('change', syncBriceGamesKept);
$('briceYes').addEventListener('click', () => setBriceState('yes'));
$('briceNo').addEventListener('click', () => setBriceState('no'));
$('briceUnsure').addEventListener('click', () => setBriceState('unknown'));
updateTypeFields();

setBusy(true); showPanel('login'); setFeedback('Vérification de la connexion…');
setPersistence(auth, browserLocalPersistence).then(() => getRedirectResult(auth)).catch((error) => {
  console.error(error); setFeedback('Le retour de la connexion Google a échoué.', 'error');
});
onAuthStateChanged(auth, (user) => {
  currentUser = user; setBusy(false);
  if (!user || user.isAnonymous) { stopListeners(); showPanel('login'); setFeedback('Connectez-vous avec le compte Google autorisé.'); return; }
  if (!isAdmin(user)) { stopListeners(); showPanel('unauthorized', user); setFeedback(''); return; }
  showPanel('dashboard', user); setFeedback(''); startListeners(); renderAll();
});
setInterval(() => { if (!dashboardPanel.hidden) refreshIntentionWatches(); renderAll(); }, 30_000);
