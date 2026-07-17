import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js';
import {
  getAuth,
  onAuthStateChanged,
  signInAnonymously
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js';
import {
  getDatabase,
  onValue,
  ref,
  remove,
  set
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js';

const firebaseConfig = {
  apiKey: 'AIzaSyDI7PBoU_zCIyBq1YtsBSywRYs5ByUPmLw',
  authDomain: 'le-quai-joue.firebaseapp.com',
  databaseURL: 'https://le-quai-joue-default-rtdb.europe-west1.firebasedatabase.app',
  projectId: 'le-quai-joue',
  storageBucket: 'le-quai-joue.firebasestorage.app',
  messagingSenderId: '623424877513',
  appId: '1:623424877513:web:4f6753430f929658a66e18'
};

const PRESENCE_DURATION_MS = 2 * 60 * 60 * 1000;

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const database = getDatabase(app);

const presenceButton = document.getElementById('presenceButton');
const gameButton = document.getElementById('gameButton');
const statusTitle = document.getElementById('statusTitle');
const statusText = document.getElementById('statusText');
const announcementCard = document.getElementById('announcementCard');
const announcementBadge = document.getElementById('announcementBadge');
const announcementMessage = document.getElementById('announcementMessage');
const announcementMeta = document.getElementById('announcementMeta');
const dialog = document.getElementById('messageDialog');
const dialogText = document.getElementById('dialogText');

let currentUser = null;
let myPresence = null;
let currentAnnouncement = null;
let unsubscribePresence = null;
let unsubscribeMine = null;
let unsubscribeAnnouncement = null;
let anonymousSignInInProgress = false;

const style = document.createElement('style');
style.textContent = `
  .presence-button.is-active {
    border-color: var(--river);
    background: rgba(84, 117, 111, 0.10);
    box-shadow: 0 8px 22px rgba(45,32,24,.08);
  }
  .presence-button:disabled { opacity: .55; cursor: wait; }
  .status-dot.is-live {
    background: #2f8f65;
    box-shadow: 0 0 0 7px rgba(47,143,101,.14);
  }
  .announcement-card {
    margin-bottom: 18px;
    padding: 24px 26px;
    border: 1px solid rgba(168,95,50,.28);
    border-left: 6px solid var(--copper);
    border-radius: 22px;
    background: linear-gradient(135deg, rgba(168,95,50,.10), rgba(255,255,255,.92));
    box-shadow: 0 10px 30px rgba(45,32,24,.07);
  }
  .announcement-card[data-type="present"] {
    border-color: rgba(84,117,111,.34);
    border-left-color: var(--river);
    background: linear-gradient(135deg, rgba(84,117,111,.13), rgba(255,255,255,.94));
  }
  .announcement-card[data-type="cancelled"] {
    border-color: rgba(139,58,47,.30);
    border-left-color: #8b3a2f;
    background: linear-gradient(135deg, rgba(139,58,47,.10), rgba(255,255,255,.94));
  }
  .announcement-badge {
    display: inline-block;
    margin-bottom: 8px;
    color: var(--copper);
    font-size: .78rem;
    font-weight: 900;
    letter-spacing: .11em;
    text-transform: uppercase;
  }
  .announcement-card[data-type="present"] .announcement-badge { color: var(--river); }
  .announcement-card[data-type="cancelled"] .announcement-badge { color: #8b3a2f; }
  .announcement-message { margin: 0; font-size: 1.22rem; line-height: 1.45; font-weight: 850; }
  .announcement-meta { margin: 8px 0 0; color: var(--muted); font-size: .88rem; }
`;
document.head.appendChild(style);

function showMessage(message) {
  if (!dialog || !dialogText) {
    window.alert(message);
    return;
  }
  dialogText.textContent = message;
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else window.alert(message);
}

function setBusy(isBusy) {
  if (presenceButton) presenceButton.disabled = isBusy;
  if (gameButton) gameButton.disabled = isBusy;
}

function setButtonContent(button, title, subtitle) {
  if (!button) return;
  const strong = button.querySelector('strong');
  const small = button.querySelector('small');
  if (strong) strong.textContent = title;
  if (small) small.textContent = subtitle;
}

function updateMyButtons() {
  const now = Date.now();
  const active = Boolean(myPresence && Number(myPresence.expiresAt) > now);
  const hasGame = Boolean(active && myPresence.hasGame);

  presenceButton?.classList.toggle('is-active', active);
  gameButton?.classList.toggle('is-active', hasGame);

  setButtonContent(
    presenceButton,
    active ? 'Je quitte le quai' : 'Je suis sur place',
    active ? 'Retirer mon signalement' : 'Signaler ma présence pour 2 heures'
  );

  setButtonContent(
    gameButton,
    hasGame ? "Je n’apporte plus de jeu" : "J’apporte un jeu",
    hasGame ? 'Retirer le jeu du compteur' : 'Signaler un échiquier disponible'
  );
}

function renderPublicStatus(rawData) {
  const now = Date.now();
  const entries = Object.values(rawData || {}).filter((entry) => {
    return entry && Number(entry.expiresAt) > now;
  });
  const players = entries.length;
  const games = entries.filter((entry) => entry.hasGame === true).length;
  const dot = document.querySelector('.status-dot');

  dot?.classList.toggle('is-live', players > 0);

  if (players === 0) {
    statusTitle.textContent = 'Personne ne s’est encore signalé sur place';
    statusText.textContent = 'Les parties peuvent néanmoins apparaître spontanément. Revenez vérifier ou passez directement sur le quai.';
    return;
  }

  statusTitle.textContent = players === 1
    ? '1 personne signalée sur place'
    : `${players} personnes signalées sur place`;

  if (games === 0) {
    statusText.textContent = 'Aucun jeu supplémentaire n’est signalé. Pensez à apporter le vôtre.';
  } else if (games === 1) {
    statusText.textContent = '1 échiquier est signalé comme disponible. Compteur actualisé en temps réel.';
  } else {
    statusText.textContent = `${games} échiquiers sont signalés comme disponibles. Compteur actualisé en temps réel.`;
  }
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat('fr-FR', {
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(timestamp)).replace(':', ' h ');
}

function renderAnnouncement(value) {
  currentAnnouncement = value || null;
  const active = Boolean(
    currentAnnouncement &&
    Number(currentAnnouncement.expiresAt) > Date.now() &&
    typeof currentAnnouncement.message === 'string'
  );

  if (!announcementCard) return;
  if (!active) {
    announcementCard.hidden = true;
    return;
  }

  const labels = {
    planned: 'Rendez-vous annoncé',
    present: 'Sur place maintenant',
    cancelled: 'Information importante'
  };

  const type = ['planned', 'present', 'cancelled'].includes(currentAnnouncement.type)
    ? currentAnnouncement.type
    : 'planned';

  announcementCard.dataset.type = type;
  announcementBadge.textContent = labels[type];
  announcementMessage.textContent = currentAnnouncement.message;
  announcementMeta.textContent = Number.isFinite(Number(currentAnnouncement.updatedAt))
    ? `Mise à jour à ${formatTime(Number(currentAnnouncement.updatedAt))}`
    : 'Annonce actualisée récemment';
  announcementCard.hidden = false;
}

async function writeMyPresence(hasGame) {
  if (!currentUser) throw new Error('Connexion au compteur indisponible.');
  const now = Date.now();
  await set(ref(database, `presence/${currentUser.uid}`), {
    hasGame: Boolean(hasGame),
    updatedAt: now,
    expiresAt: now + PRESENCE_DURATION_MS
  });
}

async function handlePresenceClick() {
  setBusy(true);
  try {
    const active = Boolean(myPresence && Number(myPresence.expiresAt) > Date.now());
    if (active) {
      await remove(ref(database, `presence/${currentUser.uid}`));
      showMessage('Ton signalement a été retiré du compteur.');
    } else {
      await writeMyPresence(false);
      showMessage('Ta présence est signalée pendant 2 heures. Tu peux la retirer plus tôt avec le même bouton.');
    }
  } catch (error) {
    console.error(error);
    showMessage('Le compteur n’a pas pu être mis à jour. Vérifie ta connexion puis réessaie.');
  } finally {
    setBusy(false);
  }
}

async function handleGameClick() {
  setBusy(true);
  try {
    const active = Boolean(myPresence && Number(myPresence.expiresAt) > Date.now());
    const hasGame = Boolean(active && myPresence.hasGame);
    await writeMyPresence(!hasGame);
    showMessage(hasGame
      ? 'Le jeu a été retiré du compteur, mais ta présence reste signalée.'
      : 'Ta présence et un échiquier disponible sont maintenant signalés pendant 2 heures.');
  } catch (error) {
    console.error(error);
    showMessage('Le compteur n’a pas pu être mis à jour. Vérifie ta connexion puis réessaie.');
  } finally {
    setBusy(false);
  }
}

function stopListeners() {
  if (unsubscribePresence) unsubscribePresence();
  if (unsubscribeMine) unsubscribeMine();
  if (unsubscribeAnnouncement) unsubscribeAnnouncement();
  unsubscribePresence = null;
  unsubscribeMine = null;
  unsubscribeAnnouncement = null;
}

function startListeners(user) {
  stopListeners();

  unsubscribePresence = onValue(
    ref(database, 'presence'),
    (snapshot) => renderPublicStatus(snapshot.val()),
    (error) => {
      console.error(error);
      statusTitle.textContent = 'Compteur momentanément indisponible';
      statusText.textContent = 'Le reste de la page demeure accessible. Réessaie dans quelques instants.';
    }
  );

  unsubscribeMine = onValue(ref(database, `presence/${user.uid}`), (snapshot) => {
    myPresence = snapshot.val();
    updateMyButtons();
  });

  unsubscribeAnnouncement = onValue(
    ref(database, 'announcement'),
    (snapshot) => renderAnnouncement(snapshot.val()),
    (error) => {
      console.error(error);
      renderAnnouncement(null);
    }
  );
}

presenceButton?.addEventListener('click', handlePresenceClick);
gameButton?.addEventListener('click', handleGameClick);

setBusy(true);
statusTitle.textContent = 'Connexion au compteur…';
statusText.textContent = 'Quelques secondes peuvent être nécessaires lors de la première ouverture.';

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    currentUser = null;
    myPresence = null;
    stopListeners();
    updateMyButtons();

    if (anonymousSignInInProgress) return;
    anonymousSignInInProgress = true;
    try {
      await signInAnonymously(auth);
    } catch (error) {
      console.error(error);
      setBusy(false);
      statusTitle.textContent = 'Compteur momentanément indisponible';
      statusText.textContent = 'Le site reste utilisable, mais les signalements ne peuvent pas être chargés.';
    } finally {
      anonymousSignInInProgress = false;
    }
    return;
  }

  currentUser = user;
  startListeners(user);
  setBusy(false);
});

setInterval(() => {
  updateMyButtons();
  renderAnnouncement(currentAnnouncement);
}, 60_000);
