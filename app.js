import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js';
import { initializeFirestore, persistentLocalCache, persistentSingleTabManager, collection, doc, addDoc, getDoc, onSnapshot, query, where, serverTimestamp, updateDoc } from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const $ = (id) => document.getElementById(id);
const state = { app: null, auth: null, db: null, user: null, isDriver: false, watchId: null, tripId: null, liveUnsubscribe: null, toastTimer: null, prompt: null };
const statusEl = $('connectionStatus');

function toast(message) {
  const element = $('toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => element.classList.remove('show'), 3200);
}
function setStatus(text, online = navigator.onLine) {
  statusEl.textContent = `${text} · ${online ? 'En ligne' : 'Hors ligne'}`;
}
function safeText(value, fallback = '') { return typeof value === 'string' ? value.slice(0, 160) : fallback; }
function drawTrips(trips) {
  const list = $('liveTrips');
  list.replaceChildren();
  if (!trips.length) {
    const empty = document.createElement('div'); empty.className = 'empty';
    empty.textContent = state.db ? 'Aucun trajet actif. Les positions apparaîtront ici lorsqu’un chauffeur autorisé démarrera une course.' : 'Mode démonstration : connectez Firebase pour afficher des trajets réels.';
    list.append(empty); return;
  }
  for (const trip of trips) {
    const card = document.createElement('article'); card.className = 'trip';
    const details = document.createElement('div');
    const title = document.createElement('h3'); title.textContent = safeText(trip.line, 'Ligne sans nom');
    const meta = document.createElement('p');
    const lat = Number(trip.location?.lat); const lng = Number(trip.location?.lng);
    const coords = Number.isFinite(lat) && Number.isFinite(lng) ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : 'Position en attente';
    meta.textContent = `${safeText(trip.city, 'Ville inconnue')} · ${coords}`;
    details.append(title, meta);
    const badge = document.createElement('span'); badge.className = 'live-pill'; badge.textContent = 'EN DIRECT';
    card.append(details, badge); list.append(card);
  }
}
function listenForTrips() {
  if (state.liveUnsubscribe) state.liveUnsubscribe();
  if (!state.db) { drawTrips([]); return; }
  state.liveUnsubscribe = onSnapshot(query(collection(state.db, 'liveTrips'), where('status', '==', 'active')),
    (snapshot) => { drawTrips(snapshot.docs.map((item) => item.data())); setStatus('Firebase synchronisé'); },
    (error) => { console.error('Live trips subscription failed', error); setStatus('Erreur de synchronisation'); toast('Lecture Firestore impossible : vérifiez les règles de sécurité.'); });
}
async function checkDriverRole(user) {
  if (!state.db || !user) return false;
  try { const profile = await getDoc(doc(state.db, 'users', user.uid)); return profile.exists() && profile.data().role === 'driver'; }
  catch (error) { console.error('Driver profile check failed', error); return false; }
}
function renderAuth() {
  $('loginForm').classList.toggle('hidden', Boolean(state.isDriver));
  $('driverControls').classList.toggle('hidden', !state.isDriver);
  $('signOutButton').classList.toggle('hidden', !state.user);
  if (state.user && !state.isDriver) {
    $('loginForm').classList.remove('hidden');
    const message = $('loginForm').querySelector('.auth-message');
    if (message) message.remove();
    const note = document.createElement('p'); note.className = 'auth-message'; note.textContent = 'Ce compte est connecté mais n’a pas le rôle chauffeur. Demandez à l’administrateur Firebase de l’autoriser.'; $('loginForm').prepend(note);
  }
}
async function beginTrip() {
  if (!state.user || !state.isDriver || !state.db) { toast('Connectez-vous avec un compte chauffeur autorisé.'); return; }
  if (!navigator.geolocation) { toast('La géolocalisation n’est pas prise en charge par ce navigateur.'); return; }
  if (!window.isSecureContext) { toast('Le GPS exige HTTPS ou localhost.'); return; }
  const line = $('line').value.trim();
  if (!line) { $('line').focus(); toast('Saisissez la ligne ou la destination.'); return; }
  $('startTrip').disabled = true;
  try {
    const reference = await addDoc(collection(state.db, 'liveTrips'), {
      driverUid: state.user.uid, city: $('city').value, line, status: 'active', location: null,
      startedAt: serverTimestamp(), updatedAt: serverTimestamp()
    });
    state.tripId = reference.id;
    state.watchId = navigator.geolocation.watchPosition(async (position) => {
      if (!state.tripId) return;
      try {
        await updateDoc(doc(state.db, 'liveTrips', state.tripId), {
          location: { lat: position.coords.latitude, lng: position.coords.longitude, accuracy: Math.round(position.coords.accuracy || 0), capturedAt: new Date(position.timestamp).toISOString() },
          updatedAt: serverTimestamp()
        });
        $('driverStatus').textContent = `GPS actif · précision ±${Math.round(position.coords.accuracy || 0)} m · gardez l’application ouverte.`;
      } catch (error) { console.error('GPS update failed', error); toast('Position non publiée : vérifiez la connexion et les règles Firestore.'); }
    }, (error) => {
      console.error('Geolocation error', error);
      toast(error.code === 1 ? 'Autorisez la localisation dans les réglages du navigateur.' : 'Position indisponible. Vérifiez le GPS et réessayez.');
      endTrip();
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
    $('startTrip').classList.add('hidden'); $('stopTrip').classList.remove('hidden');
    $('driverStatus').textContent = 'Demande de position GPS en cours…';
    toast('Trajet publié. Le GPS s’arrête si le navigateur ferme la page.');
  } catch (error) {
    console.error('Trip creation failed', error); $('startTrip').disabled = false;
    toast('Impossible de publier le trajet. Vérifiez Firebase et votre autorisation chauffeur.');
  }
}
async function endTrip() {
  if (state.watchId !== null) { navigator.geolocation.clearWatch(state.watchId); state.watchId = null; }
  const tripId = state.tripId; state.tripId = null;
  $('startTrip').classList.remove('hidden'); $('startTrip').disabled = false; $('stopTrip').classList.add('hidden');
  $('driverStatus').textContent = 'Trajet terminé. Vous pouvez en démarrer un autre.';
  if (tripId && state.db) {
    try { await updateDoc(doc(state.db, 'liveTrips', tripId), { status: 'ended', endedAt: serverTimestamp(), updatedAt: serverTimestamp() }); toast('Trajet terminé.'); }
    catch (error) { console.error('Trip stop failed', error); toast('GPS arrêté, mais la fin du trajet n’a pas pu être synchronisée.'); }
  }
}
function setupNavigation() {
  document.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => {
    document.querySelectorAll('[data-tab]').forEach((item) => item.classList.toggle('active', item === button));
    document.querySelectorAll('.panel').forEach((panel) => { const active = panel.id === `panel-${button.dataset.tab}`; panel.classList.toggle('active', active); panel.hidden = !active; });
  }));
}
async function initializeFirebase() {
  if (!firebaseConfig.apiKey || firebaseConfig.apiKey.includes('REPLACE_')) return;
  state.app = initializeApp(firebaseConfig);
  state.auth = getAuth(state.app);
  try { state.db = initializeFirestore(state.app, { localCache: persistentLocalCache({ tabManager: persistentSingleTabManager() }) }); }
  catch (error) { console.warn('Using default Firestore cache', error); const { getFirestore } = await import('https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js'); state.db = getFirestore(state.app); }
  $('setupNotice').textContent = 'Firebase configuré. Ajoutez vos lignes et autorisez les comptes chauffeurs dans Firestore avant la mise en service.';
  listenForTrips();
  onAuthStateChanged(state.auth, async (user) => {
    state.user = user; state.isDriver = user ? await checkDriverRole(user) : false; renderAuth();
  });
}
function setupPwa() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('./sw.js').catch((error) => console.error('Service worker registration failed', error));
  window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); state.prompt = event; $('installButton').classList.remove('hidden'); });
  $('installButton').addEventListener('click', async () => { if (!state.prompt) return; await state.prompt.prompt(); state.prompt = null; $('installButton').classList.add('hidden'); });
}
function bindEvents() {
  $('loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.auth) { toast('Configurez Firebase avant la connexion.'); return; }
    try { await signInWithEmailAndPassword(state.auth, $('email').value.trim(), $('password').value); toast('Connexion réussie.'); }
    catch (error) { console.error('Sign-in failed', error); toast('Connexion impossible. Vérifiez les identifiants et Authentication.'); }
  });
  $('signOutButton').addEventListener('click', async () => { await endTrip(); if (state.auth) await signOut(state.auth); });
  $('startTrip').addEventListener('click', beginTrip); $('stopTrip').addEventListener('click', endTrip);
  $('refreshButton').addEventListener('click', () => { listenForTrips(); toast('Actualisation demandée.'); });
  window.addEventListener('online', () => setStatus('Connecté')); window.addEventListener('offline', () => setStatus('Hors ligne', false));
  window.addEventListener('pagehide', () => { if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId); });
}

setupNavigation(); bindEvents(); setupPwa(); setStatus('Démarrage'); renderAuth();
try { await initializeFirebase(); if (!state.db) { setStatus('Mode démonstration'); drawTrips([]); } }
catch (error) { console.error('Firebase initialization failed', error); setStatus('Firebase indisponible'); drawTrips([]); toast('Firebase n’est pas configuré correctement.'); }
