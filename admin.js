import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js';
import {
  browserLocalPersistence,
  getAuth,
  getRedirectResult,
  GoogleAuthProvider,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
  signInWithRedirect,
  signOut
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

const ADMIN_EMAIL = 'brice.grisly@gmail.com';
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const database = getDatabase(app);
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: 'select_account' });

const loginPanel = document.getElementById('loginPanel');
const adminPanel = document.getElementById('adminPanel');
const unauthorizedPanel = document.getElementById('unauthorizedPanel');
const loginButton = document.getElementById('loginButton');
const logoutButton = document.getElementById('logoutButton');
const unauthorizedLogoutButton = document.getElementById('unauthorizedLogoutButton');
const accountText = document.getElementById('accountText');
const unauthorizedEmail = document.getElementById('unauthorizedEmail');
const form = document.getElementById('announcementForm');
const typeInput = document.getElementById('announcementType');
const messageInput = document.getElementById('announcementMessage');
const durationInput = document.getElementById('announcementDuration');
const publishButton = document.getElementById('publishButton');
const removeButton = document.getElementById('removeButton');
const feedback = document.getElementById('feedback');
const currentCard = document.getElementById('currentCard');
const currentBadge = document.getElementById('currentBadge');
const currentMessage = document.getElementById('currentMessage');
const currentMeta = document.getElementById('currentMeta');

let currentUser = null;
let currentAnnouncement = null;
let unsubscribeAnnouncement = null;
let hasActiveAnnouncement = false;

function isAdmin(user) {
  return Boolean(
    user &&
    user.emailVerified === true &&
    String(user.email || '').toLowerCase() === ADMIN_EMAIL
  );
}

function setFeedback(message, kind = 'info') {
  feedback.textContent = message;
  feedback.dataset.kind = kind;
  feedback.hidden = !message;
}

function setBusy(isBusy) {
  loginButton.disabled = isBusy;
  publishButton.disabled = isBusy;
  removeButton.disabled = isBusy || !hasActiveAnnouncement;
  logoutButton.disabled = isBusy;
  unauthorizedLogoutButton.disabled = isBusy;
}

function formatDate(timestamp) {
  return new Intl.DateTimeFormat('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(timestamp));
}

function renderCurrent(value) {
  currentAnnouncement = value || null;
  const active = Boolean(
    currentAnnouncement &&
    Number(currentAnnouncement.expiresAt) > Date.now() &&
    typeof currentAnnouncement.message === 'string'
  );

  hasActiveAnnouncement = active;
  removeButton.disabled = !active;

  if (!active) {
    currentCard.hidden = true;
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

  currentCard.dataset.type = type;
  currentBadge.textContent = labels[type];
  currentMessage.textContent = currentAnnouncement.message;
  currentMeta.textContent = `Visible jusqu’au ${formatDate(Number(currentAnnouncement.expiresAt))}`;
  currentCard.hidden = false;
}

function showPanel(name, user = null) {
  loginPanel.hidden = name !== 'login';
  adminPanel.hidden = name !== 'admin';
  unauthorizedPanel.hidden = name !== 'unauthorized';

  if (name === 'admin' && user) {
    accountText.textContent = `Connecté avec ${user.email}`;
  }
  if (name === 'unauthorized' && user) {
    unauthorizedEmail.textContent = user.email || 'ce compte';
  }
}

function startAnnouncementListener() {
  if (unsubscribeAnnouncement) unsubscribeAnnouncement();
  unsubscribeAnnouncement = onValue(
    ref(database, 'announcement'),
    (snapshot) => renderCurrent(snapshot.val()),
    (error) => {
      console.error(error);
      setFeedback('Impossible de lire l’annonce actuelle. Vérifie la connexion.', 'error');
    }
  );
}

async function login() {
  setBusy(true);
  setFeedback('Ouverture de la connexion Google…');
  try {
    await setPersistence(auth, browserLocalPersistence);
    await signInWithPopup(auth, provider);
  } catch (error) {
    console.error(error);
    if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment'].includes(error.code)) {
      await signInWithRedirect(auth, provider);
      return;
    }
    if (error.code === 'auth/popup-closed-by-user') {
      setFeedback('Connexion annulée.');
    } else {
      setFeedback('La connexion Google a échoué. Réessaie dans quelques instants.', 'error');
    }
  } finally {
    setBusy(false);
  }
}

async function logout() {
  setBusy(true);
  try {
    await signOut(auth);
  } catch (error) {
    console.error(error);
    setFeedback('La déconnexion a échoué.', 'error');
  } finally {
    setBusy(false);
  }
}

async function publishAnnouncement(event) {
  event.preventDefault();
  if (!isAdmin(currentUser)) {
    setFeedback('Ce compte n’est pas autorisé à publier.', 'error');
    return;
  }

  const message = messageInput.value.trim();
  const durationHours = Number(durationInput.value);
  if (!message) {
    setFeedback('Écris le message à afficher sur le site.', 'error');
    messageInput.focus();
    return;
  }
  if (message.length > 180) {
    setFeedback('Le message doit rester inférieur à 180 caractères.', 'error');
    messageInput.focus();
    return;
  }
  if (![2, 6, 12, 24].includes(durationHours)) {
    setFeedback('Choisis une durée valide.', 'error');
    return;
  }

  setBusy(true);
  setFeedback('Publication en cours…');
  try {
    const now = Date.now();
    await set(ref(database, 'announcement'), {
      type: typeInput.value,
      message,
      updatedAt: now,
      expiresAt: now + durationHours * 60 * 60 * 1000
    });
    setFeedback('L’annonce est publiée sur le site.', 'success');
  } catch (error) {
    console.error(error);
    setFeedback('Publication refusée. Vérifie que tu utilises bien le compte autorisé.', 'error');
  } finally {
    setBusy(false);
  }
}

async function removeAnnouncement() {
  if (!isAdmin(currentUser)) return;
  const confirmed = window.confirm('Retirer immédiatement l’annonce du site ?');
  if (!confirmed) return;

  setBusy(true);
  setFeedback('Retrait en cours…');
  try {
    await remove(ref(database, 'announcement'));
    setFeedback('L’annonce a été retirée du site.', 'success');
  } catch (error) {
    console.error(error);
    setFeedback('Impossible de retirer l’annonce.', 'error');
  } finally {
    setBusy(false);
  }
}

loginButton.addEventListener('click', login);
logoutButton.addEventListener('click', logout);
unauthorizedLogoutButton.addEventListener('click', logout);
form.addEventListener('submit', publishAnnouncement);
removeButton.addEventListener('click', removeAnnouncement);

setBusy(true);
showPanel('login');
setFeedback('Vérification de la connexion…');

setPersistence(auth, browserLocalPersistence)
  .then(() => getRedirectResult(auth))
  .catch((error) => {
    console.error(error);
    setFeedback('Le retour de la connexion Google a échoué.', 'error');
  });

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  setBusy(false);

  if (!user || user.isAnonymous) {
    if (unsubscribeAnnouncement) unsubscribeAnnouncement();
    unsubscribeAnnouncement = null;
    showPanel('login');
    setFeedback('Connecte-toi avec le compte Google autorisé.');
    return;
  }

  if (!isAdmin(user)) {
    if (unsubscribeAnnouncement) unsubscribeAnnouncement();
    unsubscribeAnnouncement = null;
    showPanel('unauthorized', user);
    setFeedback('');
    return;
  }

  showPanel('admin', user);
  setFeedback('');
  startAnnouncementListener();
});
