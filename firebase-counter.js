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

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const database = getDatabase(app);

const $ = (id) => document.getElementById(id);
const presenceButton = $('presenceButton');
const gameButton = $('gameButton');
const playingButton = $('playingButton');
const personalCard = $('personalCard');
const gameLeftCard = $('gameLeftCard');
const gameLeftText = $('gameLeftText');
const statusTitle = $('statusTitle');
const statusText = $('statusText');
const freshness = $('freshness');
const todayCard = $('todayCard');
const announcementCard = $('announcementCard');
const announcementBadge = $('announcementBadge');
const announcementMessage = $('announcementMessage');
const announcementMeta = $('announcementMeta');
const planningCard = $('planningCard');
const planningTitle = $('planningTitle');
const planningText = $('planningText');
const planningPresenceButton = $('planningPresenceButton');
const planningGameButton = $('planningGameButton');
const planningFeedback = $('planningFeedback');
const timeDialog = $('timeDialog');
const leaveDialog = $('leaveDialog');
const guardianDialog = $('guardianDialog');
const stickyPresence = $('stickyPresence');
const stickyTitle = $('stickyTitle');
const stickyText = $('stickyText');
const toast = $('toast');

let currentUser = null;
let myPresence = null;
let allPresence = {};
let currentAnnouncement = null;
let myIntention = null;
let timePurpose = 'presence';
let anonymousSignInInProgress = false;
let unsubscribePresence = null;
let unsubscribeMine = null;
let unsubscribeAnnouncement = null;
let unsubscribeIntention = null;

function showMessage(message) {
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showMessage.timer);
  showMessage.timer = setTimeout(() => { toast.hidden = true; }, 3200);
}

function setBusy(isBusy) {
  [presenceButton, gameButton, playingButton, planningPresenceButton, planningGameButton].forEach((button) => {
    if (button) button.disabled = isBusy;
  });
}

function formatClock(timestamp) {
  return new Intl.DateTimeFormat('fr-FR', {hour:'2-digit', minute:'2-digit'})
    .format(new Date(timestamp)).replace(':', ' h ');
}

function formatEvent(timestamp) {
  return new Intl.DateTimeFormat('fr-FR', {
    weekday:'long', day:'numeric', month:'long', hour:'2-digit', minute:'2-digit'
  }).format(new Date(timestamp));
}

function formatFreshness(timestamp) {
  if (!Number.isFinite(Number(timestamp))) return '';
  return `Mis à jour à ${formatClock(Number(timestamp))}`;
}

function active(entry) {
  return Boolean(entry && Number(entry.expiresAt) > Date.now());
}

function entryKind(entry) {
  return entry?.kind === 'game-only' ? 'game-only' : 'person';
}

function eventKey(announcement) {
  const value = Number(announcement?.eventAt);
  return Number.isFinite(value) ? String(Math.trunc(value)) : null;
}

function addMinutes(minutes) {
  const date = new Date(Date.now() + minutes * 60_000);
  const rounded = Math.ceil(date.getMinutes() / 15) * 15;
  date.setMinutes(rounded, 0, 0);
  return date.getTime();
}

function suggestedTimes() {
  return [...new Set([45, 90, 150, 240].map(addMinutes))];
}

function fillTimeChoices(container, callback) {
  if (!container) return;
  container.innerHTML = '';
  suggestedTimes().forEach((timestamp) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'time-choice';
    button.textContent = `Jusqu’à ${formatClock(timestamp)}`;
    button.addEventListener('click', () => callback(timestamp));
    container.appendChild(button);
  });
}

function timestampFromTimeInput(value) {
  if (!value) return null;
  const [hours, minutes] = value.split(':').map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  const chosen = new Date();
  chosen.setHours(hours, minutes, 0, 0);
  const timestamp = chosen.getTime();
  if (timestamp <= Date.now()) return null;
  if (timestamp > Date.now() + 12 * 60 * 60 * 1000) return null;
  return timestamp;
}

function openTimeDialog(purpose) {
  timePurpose = purpose;
  fillTimeChoices($('timeChoices'), chooseTime);
  if (typeof timeDialog?.showModal === 'function') timeDialog.showModal();
}

async function writePresence({kind='person', hasGame=false, playing=false, expiresAt}) {
  if (!currentUser) throw new Error('Connexion indisponible.');
  const now = Date.now();
  await set(ref(database, `presence/${currentUser.uid}`), {
    kind,
    hasGame: Boolean(hasGame),
    playing: Boolean(playing),
    updatedAt: now,
    expiresAt: Number(expiresAt)
  });
}

async function chooseTime(expiresAt) {
  try {
    setBusy(true);
    const currentlyActive = active(myPresence);
    const currentlyPerson = currentlyActive && entryKind(myPresence) === 'person';
    const currentlyGameOnly = currentlyActive && entryKind(myPresence) === 'game-only';

    if (timePurpose === 'game-only') {
      await writePresence({kind:'game-only', hasGame:true, playing:false, expiresAt});
      timeDialog?.close();
      showMessage(`Le jeu devrait rester disponible jusqu’à ${formatClock(expiresAt)} environ.`);
      return;
    }

    const hasGame = timePurpose === 'game'
      ? true
      : Boolean((currentlyPerson && myPresence.hasGame) || currentlyGameOnly);
    const playing = Boolean(currentlyPerson && myPresence.playing);
    await writePresence({kind:'person', hasGame, playing, expiresAt});
    timeDialog?.close();
    showMessage(hasGame ? 'Votre présence et le jeu sont indiqués.' : 'Votre présence est indiquée.');
  } catch (error) {
    console.error(error);
    showMessage('La mise à jour a échoué. Vérifiez votre connexion puis réessayez.');
  } finally {
    setBusy(false);
  }
}

function renderLiveStatus() {
  const entries = Object.values(allPresence || {}).filter(active);
  const people = entries.filter((entry) => entryKind(entry) === 'person');
  const playingEntries = people.filter((entry) => entry.playing === true);
  const gamesWithPeople = people.filter((entry) => entry.hasGame === true);
  const gamesLeft = entries.filter((entry) => entryKind(entry) === 'game-only' && entry.hasGame === true);
  const allGames = [...gamesWithPeople, ...gamesLeft];

  let title = 'Pas d’information en direct pour le moment.';
  let text = 'Des parties peuvent tout de même commencer spontanément au quai.';
  let updatedAt = null;
  let tone = 'quiet';

  if (playingEntries.length > 0) {
    title = 'Ça joue au quai des Bateliers en ce moment.';
    text = 'Vous pouvez passer, regarder une partie ou proposer de jouer.';
    updatedAt = Math.max(...playingEntries.map((entry) => Number(entry.updatedAt) || 0));
    tone = 'live';
  } else if (allGames.length > 0) {
    const latestGame = allGames.reduce((best, entry) => Number(entry.expiresAt) > Number(best.expiresAt) ? entry : best);
    const onlyLeftGames = gamesWithPeople.length === 0;
    title = onlyLeftGames
      ? `Un jeu devrait rester disponible jusqu’à ${formatClock(Number(latestGame.expiresAt))} environ.`
      : `Un jeu est disponible jusqu’à ${formatClock(Number(latestGame.expiresAt))} environ.`;
    text = onlyLeftGames
      ? 'Une personne présente en a la garde.'
      : 'Quelqu’un est au quai et peut commencer une partie.';
    updatedAt = Math.max(...allGames.map((entry) => Number(entry.updatedAt) || 0));
    tone = 'live';
  } else if (people.length > 0) {
    const latestDeparture = Math.max(...people.map((entry) => Number(entry.expiresAt) || 0));
    title = `Quelqu’un pense rester au quai jusqu’à ${formatClock(latestDeparture)} environ.`;
    text = 'Apportez un jeu lorsque c’est possible.';
    updatedAt = Math.max(...people.map((entry) => Number(entry.updatedAt) || 0));
    tone = 'live';
  }

  statusTitle.textContent = title;
  statusText.textContent = text;
  todayCard.dataset.tone = tone;
  freshness.textContent = updatedAt ? formatFreshness(updatedAt) : '';
  freshness.hidden = !updatedAt;
}

function renderMyPresence() {
  const isActive = active(myPresence);
  const isPerson = isActive && entryKind(myPresence) === 'person';
  const isGameOnly = isActive && entryKind(myPresence) === 'game-only';
  const hasGame = Boolean(isPerson && myPresence.hasGame);

  presenceButton?.classList.toggle('is-active', isPerson);
  gameButton?.classList.toggle('is-active', hasGame);

  if (presenceButton) {
    presenceButton.querySelector('strong').textContent = 'Je suis au quai';
    presenceButton.querySelector('small').textContent = isPerson
      ? `Jusqu’à ${formatClock(Number(myPresence.expiresAt))} environ · appuyez pour modifier`
      : 'Pour que d’autres puissent vous rejoindre';
  }

  if (gameButton) {
    gameButton.querySelector('strong').textContent = hasGame ? 'Un jeu est disponible' : 'J’ai apporté un jeu';
    gameButton.querySelector('small').textContent = hasGame
      ? 'Appuyez si le jeu n’est plus disponible'
      : 'Pour qu’une partie puisse commencer';
  }

  personalCard.hidden = !isPerson;
  gameLeftCard.hidden = !isGameOnly;
  stickyPresence.hidden = !isPerson;
  document.body.classList.toggle('has-sticky', isPerson);

  if (isPerson) {
    playingButton.textContent = myPresence.playing ? 'La partie est terminée' : 'Une partie a commencé';
    stickyTitle.textContent = `Vous êtes au quai jusqu’à ${formatClock(Number(myPresence.expiresAt))} environ.`;
    stickyText.textContent = hasGame ? 'Un jeu est disponible.' : 'Vous pouvez modifier cette heure à tout moment.';
  }

  if (isGameOnly) {
    gameLeftText.textContent = `Votre jeu reste indiqué au quai jusqu’à ${formatClock(Number(myPresence.expiresAt))} environ.`;
  }
}

function renderAnnouncement(value) {
  currentAnnouncement = active(value) && typeof value.message === 'string' ? value : null;
  if (!announcementCard) return;

  if (!currentAnnouncement) {
    announcementCard.hidden = true;
    planningCard.hidden = true;
    stopIntentionListener();
    return;
  }

  const type = ['planned','maintained','present','info','cancelled'].includes(currentAnnouncement.type)
    ? currentAnnouncement.type : 'planned';
  const labels = {
    planned:'Rencontre proposée',
    maintained:'Le rendez-vous tient toujours',
    present:'Sur place maintenant',
    info:'Information importante',
    cancelled:'Information importante'
  };

  announcementCard.dataset.type = type;
  announcementBadge.textContent = labels[type];
  announcementMessage.textContent = currentAnnouncement.message;

  const eventAt = Number(currentAnnouncement.eventAt);
  const eventText = Number.isFinite(eventAt) ? ` · ${formatEvent(eventAt)}` : '';
  announcementMeta.textContent = `${formatFreshness(Number(currentAnnouncement.updatedAt))}${eventText}`;
  announcementCard.hidden = false;

  const canPlan = ['planned','maintained'].includes(type) && eventKey(currentAnnouncement);
  planningCard.hidden = !canPlan;
  if (canPlan) {
    const maintained = type === 'maintained';
    planningTitle.textContent = maintained ? 'Le rendez-vous tient toujours pour vous ?' : 'Vous pensez venir ?';
    planningText.textContent = maintained
      ? 'Indiquez simplement si vous comptez toujours venir.'
      : 'Vous pouvez indiquer votre intention, sans engagement définitif.';
    planningPresenceButton.textContent = maintained ? 'Je confirme ma venue' : 'Je pense passer';
    startIntentionListener();
  } else {
    stopIntentionListener();
  }
}

function renderMyIntention() {
  const attending = Boolean(myIntention && myIntention.attending === true && active(myIntention));
  const hasGame = Boolean(attending && myIntention.hasGame === true);
  planningPresenceButton?.classList.toggle('is-active', attending);
  planningGameButton?.classList.toggle('is-active', hasGame);
  planningFeedback.hidden = !attending;
  planningFeedback.textContent = hasGame
    ? 'Votre venue et un jeu sont prévus.'
    : 'Votre intention de venir est indiquée.';
}

async function toggleIntention(withGame) {
  const key = eventKey(currentAnnouncement);
  if (!currentUser || !key || !currentAnnouncement) return;
  const attending = Boolean(myIntention && myIntention.attending === true && active(myIntention));
  const currentHasGame = Boolean(attending && myIntention.hasGame === true);

  try {
    setBusy(true);
    if (!withGame && attending) {
      await remove(ref(database, `intentions/${key}/${currentUser.uid}`));
      showMessage('Votre réponse a été retirée.');
      return;
    }

    const nextHasGame = withGame ? !currentHasGame : false;
    const now = Date.now();
    await set(ref(database, `intentions/${key}/${currentUser.uid}`), {
      attending: true,
      hasGame: nextHasGame,
      updatedAt: now,
      expiresAt: Number(currentAnnouncement.expiresAt)
    });
    showMessage(nextHasGame ? 'Votre venue et un jeu sont prévus.' : 'Votre venue est indiquée.');
  } catch (error) {
    console.error(error);
    showMessage('La réponse n’a pas pu être enregistrée.');
  } finally {
    setBusy(false);
  }
}

function stopIntentionListener() {
  if (unsubscribeIntention) unsubscribeIntention();
  unsubscribeIntention = null;
  myIntention = null;
  renderMyIntention();
}

function startIntentionListener() {
  const key = eventKey(currentAnnouncement);
  if (!currentUser || !key) return;
  if (unsubscribeIntention) unsubscribeIntention();
  unsubscribeIntention = onValue(
    ref(database, `intentions/${key}/${currentUser.uid}`),
    (snapshot) => {
      myIntention = snapshot.val();
      renderMyIntention();
    },
    (error) => console.error(error)
  );
}

async function startLeaving() {
  if (!active(myPresence) || entryKind(myPresence) !== 'person') return;
  if (myPresence.hasGame === true) {
    leaveDialog?.showModal();
  } else {
    try {
      await remove(ref(database, `presence/${currentUser.uid}`));
      showMessage('Votre départ est indiqué. Merci.');
    } catch (error) {
      console.error(error);
      showMessage('Le départ n’a pas pu être enregistré.');
    }
  }
}

async function leaveWithGame(expiresAt) {
  try {
    setBusy(true);
    await writePresence({kind:'game-only', hasGame:true, playing:false, expiresAt});
    guardianDialog?.close();
    showMessage(`Le jeu devrait rester disponible jusqu’à ${formatClock(expiresAt)} environ.`);
  } catch (error) {
    console.error(error);
    showMessage('L’information concernant le jeu n’a pas pu être mise à jour.');
  } finally {
    setBusy(false);
  }
}

function stopListeners() {
  [unsubscribePresence, unsubscribeMine, unsubscribeAnnouncement, unsubscribeIntention].forEach((unsubscribe) => {
    if (unsubscribe) unsubscribe();
  });
  unsubscribePresence = null;
  unsubscribeMine = null;
  unsubscribeAnnouncement = null;
  unsubscribeIntention = null;
}

function startListeners(user) {
  stopListeners();
  unsubscribePresence = onValue(
    ref(database, 'presence'),
    (snapshot) => {
      allPresence = snapshot.val() || {};
      renderLiveStatus();
    },
    (error) => {
      console.error(error);
      statusTitle.textContent = 'Information en direct momentanément indisponible.';
      statusText.textContent = 'Le reste du site demeure accessible.';
    }
  );

  unsubscribeMine = onValue(ref(database, `presence/${user.uid}`), (snapshot) => {
    myPresence = snapshot.val();
    renderMyPresence();
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

presenceButton?.addEventListener('click', () => openTimeDialog('presence'));
gameButton?.addEventListener('click', async () => {
  if (active(myPresence) && entryKind(myPresence) === 'person' && myPresence.hasGame === true) {
    try {
      setBusy(true);
      await writePresence({
        kind:'person', hasGame:false, playing:Boolean(myPresence.playing), expiresAt:Number(myPresence.expiresAt)
      });
      showMessage('Le jeu n’est plus indiqué comme disponible.');
    } catch (error) {
      console.error(error);
      showMessage('La mise à jour a échoué.');
    } finally {
      setBusy(false);
    }
    return;
  }
  openTimeDialog('game');
});

playingButton?.addEventListener('click', async () => {
  if (!active(myPresence) || entryKind(myPresence) !== 'person') return;
  try {
    setBusy(true);
    await writePresence({
      kind:'person',
      hasGame:Boolean(myPresence.hasGame),
      playing:!Boolean(myPresence.playing),
      expiresAt:Number(myPresence.expiresAt)
    });
    showMessage(myPresence.playing ? 'La partie est indiquée comme terminée.' : 'La partie est indiquée comme commencée.');
  } catch (error) {
    console.error(error);
    showMessage('La mise à jour a échoué.');
  } finally {
    setBusy(false);
  }
});

planningPresenceButton?.addEventListener('click', () => toggleIntention(false));
planningGameButton?.addEventListener('click', () => toggleIntention(true));
$('stickyModify')?.addEventListener('click', () => openTimeDialog('presence'));
$('stickyLeave')?.addEventListener('click', startLeaving);
$('modifyGameTimeButton')?.addEventListener('click', () => openTimeDialog('game-only'));
$('removeLeftGameButton')?.addEventListener('click', async () => {
  try {
    await remove(ref(database, `presence/${currentUser.uid}`));
    showMessage('Le jeu n’est plus indiqué au quai.');
  } catch (error) {
    console.error(error);
    showMessage('La mise à jour a échoué.');
  }
});

$('customTimeButton')?.addEventListener('click', () => {
  const timestamp = timestampFromTimeInput($('customTime')?.value);
  if (!timestamp) {
    showMessage('Choisissez une heure plus tardive, dans les douze prochaines heures.');
    return;
  }
  chooseTime(timestamp);
});

$('takeGameButton')?.addEventListener('click', async () => {
  leaveDialog?.close();
  try {
    await remove(ref(database, `presence/${currentUser.uid}`));
    showMessage('Votre départ est indiqué. Merci.');
  } catch (error) {
    console.error(error);
    showMessage('Le départ n’a pas pu être enregistré.');
  }
});

$('leaveGameButton')?.addEventListener('click', () => {
  leaveDialog?.close();
  fillTimeChoices($('guardianChoices'), leaveWithGame);
  guardianDialog?.showModal();
});

$('guardianCustomButton')?.addEventListener('click', () => {
  const timestamp = timestampFromTimeInput($('guardianCustomTime')?.value);
  if (!timestamp) {
    showMessage('Choisissez une heure plus tardive, dans les douze prochaines heures.');
    return;
  }
  leaveWithGame(timestamp);
});

document.querySelectorAll('[data-close]').forEach((button) => {
  button.addEventListener('click', () => $(button.dataset.close)?.close());
});

[timeDialog, leaveDialog, guardianDialog].forEach((dialog) => {
  dialog?.addEventListener('click', (event) => {
    const rect = dialog.getBoundingClientRect();
    const outside = event.clientX < rect.left || event.clientX > rect.right ||
                    event.clientY < rect.top || event.clientY > rect.bottom;
    if (outside) dialog.close();
  });
});

setBusy(true);
statusTitle.textContent = 'Chargement des informations du quai…';
statusText.textContent = 'Quelques secondes peuvent être nécessaires lors de la première ouverture.';

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    currentUser = null;
    myPresence = null;
    allPresence = {};
    stopListeners();
    renderMyPresence();

    if (anonymousSignInInProgress) return;
    anonymousSignInInProgress = true;
    try {
      await signInAnonymously(auth);
    } catch (error) {
      console.error(error);
      setBusy(false);
      statusTitle.textContent = 'Information en direct momentanément indisponible.';
      statusText.textContent = 'Le reste du site demeure accessible.';
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
  renderLiveStatus();
  renderMyPresence();
  if (currentAnnouncement && !active(currentAnnouncement)) renderAnnouncement(null);
}, 60_000);
