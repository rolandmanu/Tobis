import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js';
import { getFirestore, collection, addDoc, updateDoc, doc, onSnapshot, query, where, serverTimestamp } from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const $ = (id) => document.getElementById(id);
const state = {
  db: null,
  tripId: null,
  watchId: null,
  toastTimer: null,
  installPrompt: null,
  passengerSubscription: null,
  liveUnsubscribe: null
};

function toast(message) {
  const element = $('toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => element.classList.remove('show'), 3200);
}

function setStatus(text, online = navigator.onLine) {
  const el = $('connectionStatus');
  if (!el) return;
  el.textContent = `${text} · ${online ? 'En ligne' : 'Hors ligne'}`;
}

function safeText(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  return value.trim().slice(0, 90) || fallback;
}

function drawTrips(trips) {
  const list = $('liveTrips');
  if (!list) return;
  list.replaceChildren();

  if (!trips.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = state.db
      ? 'Aucun trajet actif. Le chauffeur peut démarrer un trajet pour publier une position.'
      : 'Mode démonstration : configurez Firebase pour afficher les trajets en direct.';
    list.append(empty);
    return;
  }

  for (const trip of trips) {
    const card = document.createElement('article');
    card.className = 'trip';

    const content = document.createElement('div');
    const title = document.createElement('h3');
    title.textContent = safeText(trip.line, 'Ligne sans nom');

    const meta = document.createElement('p');
    const city = safeText(trip.city, 'Ville inconnue');
    const coords = trip.location && Number.isFinite(Number(trip.location.lat)) && Number.isFinite(Number(trip.location.lng))
      ? `${Number(trip.location.lat).toFixed(5)}, ${Number(trip.location.lng).toFixed(5)}`
      : 'Position en attente';
    meta.textContent = `${city} · ${coords}`;

    const badge = document.createElement('span');
    badge.className = 'live-pill';
    badge.textContent = 'EN DIRECT';

    content.append(title, meta);
    card.append(content, badge);
    list.append(card);
  }
}

function listenForTrips() {
  if (!state.db) {
    drawTrips([]);
    return;
  }

  if (state.liveUnsubscribe) state.liveUnsubscribe();

  state.liveUnsubscribe = onSnapshot(
    query(collection(state.db, 'liveTrips'), where('status', '==', 'active')),
    (snapshot) => {
      const docs = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      drawTrips(docs);
      setStatus('Firebase synchronisé');
    },
    (error) => {
      console.error('Live trips subscription failed', error);
      setStatus('Erreur Firebase');
      toast('Lecture Firestore impossible : vérifiez les règles et les permissions.');
    }
  );
}

function savePassengerSubscription(subscription) {
  const summary = $('passengerSummary');
  if (!summary) return;
  summary.classList.remove('hidden');
  summary.innerHTML = `<p><strong>Abonnement actif</strong></p><p>${subscription.phone} · ${subscription.line}</p><p>Arrêt : ${subscription.stop}</p><p class="status-good">Les alertes WhatsApp seront envoyées par le backend, sur les lignes autorisées.</p>`;
}

function setupPassengerForm() {
  const form = $('passengerForm');
  if (!form) return;

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const phone = document.getElementById('phoneNumber').value.trim();
    const line = document.getElementById('wantedLine').value.trim();
    const stop = document.getElementById('stopName').value.trim();

    if (!phone || !line || !stop) {
      toast('Saisissez le téléphone, la ligne et l’arrêt.');
      return;
    }

    const subscription = { phone, line, stop, createdAt: new Date().toISOString() };
    state.passengerSubscription = subscription;
    localStorage.setItem('tobis.passenger', JSON.stringify(subscription));
    savePassengerSubscription(subscription);
    toast('Abonnement enregistré pour les alertes WhatsApp.');

    if (state.db) {
      addDoc(collection(state.db, 'passengerAlerts'), {
        phone,
        line,
        stop,
        status: 'active',
        createdAt: serverTimestamp()
      }).catch((error) => {
        console.error('Passenger subscription failed', error);
      });
    }
  });

  const unsubscribeButton = $('unsubscribePassenger');
  if (unsubscribeButton) {
    unsubscribeButton.addEventListener('click', () => {
      localStorage.removeItem('tobis.passenger');
      state.passengerSubscription = null;
      const summary = $('passengerSummary');
      if (summary) summary.classList.add('hidden');
      toast('Abonnement désactivé.');
    });
  }

  const saved = JSON.parse(localStorage.getItem('tobis.passenger') || 'null');
  if (saved) {
    document.getElementById('phoneNumber').value = saved.phone || '';
    document.getElementById('wantedLine').value = saved.line || '';
    document.getElementById('stopName').value = saved.stop || '';
    state.passengerSubscription = saved;
    savePassengerSubscription(saved);
  }
}

async function initializeFirebase() {
  if (!firebaseConfig.apiKey || firebaseConfig.apiKey.includes('REPLACE_')) {
    setStatus('Mode démonstration');
    return;
  }

  const app = initializeApp(firebaseConfig);
  state.db = getFirestore(app);
  $('setupNotice').textContent = 'Firebase configuré. Le backend WhatsApp Business doit envoyer les alertes depuis Cloud Functions.';
  listenForTrips();
}

async function endTrip() {
  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }

  const tripId = state.tripId;
  state.tripId = null;
  $('startTrip').classList.remove('hidden');
  $('startTrip').disabled = false;
  $('stopTrip').classList.add('hidden');
  $('driverStatus').textContent = 'Trajet terminé. Vous pouvez en redémarrer un autre.';

  if (tripId && state.db) {
    try {
      await updateDoc(doc(state.db, 'liveTrips', tripId), {
        status: 'ended',
        endedAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      toast('Trajet terminé et publié.');
    } catch (error) {
      console.error('Trip end update failed', error);
      toast('La fin du trajet n’a pas pu être synchronisée.');
    }
  }
}

async function startTrip() {
  if (!navigator.geolocation) {
    toast('Le navigateur ne prend pas en charge le GPS.');
    return;
  }

  if (!window.isSecureContext && location.protocol !== 'file:') {
    toast('Le GPS exige HTTPS ou localhost.');
    return;
  }

  const city = $('city').value;
  const line = $('line').value.trim();
  if (!line) {
    $('line').focus();
    toast('Saisissez une ligne ou une destination.');
    return;
  }

  $('startTrip').disabled = true;
  $('driverStatus').textContent = 'Publication du trajet…';

  try {
    if (!state.db) {
      toast('Le backend Firebase n’est pas configuré; mode démonstration seulement.');
      $('startTrip').disabled = false;
      return;
    }

    const draft = await addDoc(collection(state.db, 'liveTrips'), {
      city,
      line,
      status: 'active',
      location: null,
      startedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    state.tripId = draft.id;
    $('startTrip').classList.add('hidden');
    $('stopTrip').classList.remove('hidden');
    $('driverStatus').textContent = 'GPS actif. Les passagers peuvent être alertés depuis Firebase + WhatsApp Business.';

    state.watchId = navigator.geolocation.watchPosition(
      async (position) => {
        if (!state.tripId || !state.db) return;
        const payload = {
          location: {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracy: Math.round(position.coords.accuracy || 0),
            capturedAt: new Date(position.timestamp).toISOString()
          },
          updatedAt: serverTimestamp()
        };

        try {
          await updateDoc(doc(state.db, 'liveTrips', state.tripId), payload);
          $('driverStatus').textContent = `GPS actif · précision ±${Math.round(position.coords.accuracy || 0)} m`;
        } catch (error) {
          console.error('Location update error', error);
          toast('Mise à jour GPS impossible : vérifiez Firestore et les règles.');
        }
      },
      (error) => {
        console.error('Geolocation watch failed', error);
        toast(error.code === 1 ? 'Autorisez la localisation pour publier le trajet.' : 'GPS indisponible : vérifiez le signal.');
        endTrip();
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
    );

    toast('Trajet publié et prêt à notifier les passagers.');
  } catch (error) {
    console.error('Trip start failed', error);
    $('startTrip').disabled = false;
    toast('Impossible de démarrer le trajet. Vérifiez Firebase et les règles.');
  }
}

function setupPwa() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch((error) => console.error('Service worker registration failed', error));
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    state.installPrompt = event;
    $('installButton').classList.remove('hidden');
  });

  $('installButton').addEventListener('click', async () => {
    if (!state.installPrompt) return;
    await state.installPrompt.prompt();
    state.installPrompt = null;
    $('installButton').classList.add('hidden');
  });
}

function setupTabs() {
  document.querySelectorAll('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      const tabName = button.dataset.tab;
      document.querySelectorAll('[data-tab]').forEach((item) => item.classList.toggle('active', item === button));
      document.querySelectorAll('.panel').forEach((panel) => {
        const active = panel.id === `panel-${tabName}`;
        panel.classList.toggle('active', active);
        panel.hidden = !active;
      });
    });
  });
}

function bindEvents() {
  $('refreshButton').addEventListener('click', () => listenForTrips());
  $('startTrip').addEventListener('click', startTrip);
  $('stopTrip').addEventListener('click', endTrip);
  window.addEventListener('online', () => setStatus('Connecté'));
  window.addEventListener('offline', () => setStatus('Hors ligne', false));
  window.addEventListener('pagehide', () => {
    if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
  });
}

setupTabs();
setupPwa();
setupPassengerForm();
bindEvents();
setStatus('Démarrage');
initializeFirebase();
