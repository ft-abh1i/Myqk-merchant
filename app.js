import { firebaseConfig } from './firebase-config.js';
import { cloudinaryConfig } from './cloudinary-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import {
  browserLocalPersistence,
  getAuth,
  onAuthStateChanged,
  setPersistence,
  signInAnonymously
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import {
  collection,
  doc,
  getDoc,
  getFirestore,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  user: null,
  merchant: null,
  store: null,
  storeId: null,
  products: [],
  orders: [],
  todayCompleted: [],
  productFilter: '',
  orderFilter: 'all',
  stockFilter: 'all',
  location: null,
  resolvedAddress: null,
  unsubStore: null,
  unsubProducts: null,
  unsubOrders: null,
  unsubToday: null,
  hasInitialOrderSnapshot: false,
  knownPendingOrders: new Set(),
  reconcilingOrders: new Set()
};

const IMAGE_RULES = Object.freeze({
  inputMaxBytes: 8 * 1024 * 1024,
  store: { maxWidth: 1200, maxHeight: 800, maxBytes: 300 * 1024 },
  product: { maxWidth: 800, maxHeight: 800, maxBytes: 180 * 1024 }
});

const CATEGORY_LABELS = Object.freeze({
  groceries: 'Grocery',
  food: 'Food & Restaurant',
  pharmacy: 'Pharmacy',
  beauty: 'Beauty',
  kids: 'Kids',
  electronics: 'Electronics',
  services: 'Services',
  other: 'Other'
});

function toast(message, error = false) {
  const element = $('#toast');
  if (!element) return;
  element.textContent = message;
  element.className = `toast show${error ? ' error' : ''}`;
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => { element.className = 'toast'; }, 3400);
}

function showScreen(id) {
  $('.screen').forEach((screen) => screen.classList.toggle('active', screen.id === id));
}

function setLoadingMessage(message) {
  const element = $('#loading-message');
  if (element) element.textContent = message;
}

function setButtonBusy(button, busy, busyText, normalText) {
  if (!button) return;
  button.disabled = busy;
  button.textContent = busy ? busyText : normalText;
}

function money(value) {
  return `₹${Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function validCoordinates(value) {
  if (!value || typeof value !== 'object') return false;
  const latitude = Number(value.latitude ?? value.lat);
  const longitude = Number(value.longitude ?? value.lng);
  return Number.isFinite(latitude)
    && Number.isFinite(longitude)
    && latitude >= -90
    && latitude <= 90
    && longitude >= -180
    && longitude <= 180;
}

function distanceKm(first, second) {
  if (!validCoordinates(first) || !validCoordinates(second)) return Infinity;
  const lat1 = Number(first.latitude ?? first.lat);
  const lon1 = Number(first.longitude ?? first.lng);
  const lat2 = Number(second.latitude ?? second.lat);
  const lon2 = Number(second.longitude ?? second.lng);
  const radians = (value) => value * Math.PI / 180;
  const latitudeDistance = radians(lat2 - lat1);
  const longitudeDistance = radians(lon2 - lon1);
  const calculation = Math.sin(latitudeDistance / 2) ** 2
    + Math.cos(radians(lat1)) * Math.cos(radians(lat2))
    * Math.sin(longitudeDistance / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(calculation), Math.sqrt(1 - calculation));
}

function stockState(product) {
  const stock = Number(product.stockQuantity || 0);
  if (stock <= 0) return 'out';
  if (stock <= Number(product.lowStockThreshold || 5)) return 'low';
  return 'ok';
}

function statusLabel(status) {
  return ({
    pending_merchant: 'New order',
    merchant_accepted: 'Accepted',
    preparing: 'Preparing',
    ready_for_pickup: 'Ready for pickup',
    accepted: 'Rider assigned',
    arrived_pickup: 'Rider at store',
    picked_up: 'Picked up',
    completed: 'Completed',
    merchant_rejected: 'Rejected',
    cancelled: 'Cancelled'
  })[status] || status || 'Processing';
}

function placeholderImage(label = 'QK') {
  const initials = String(label).trim().split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase() || 'QK';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480"><rect width="640" height="480" fill="#061a3b"/><circle cx="320" cy="240" r="125" fill="#f7cf3f"/><text x="320" y="275" text-anchor="middle" font-family="Arial,sans-serif" font-size="86" font-weight="800" fill="#061a3b">${escapeHtml(initials)}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function safeImageUrl(value, fallbackLabel = 'QK') {
  if (!value) return placeholderImage(fallbackLabel);
  if (String(value).startsWith('data:image/')) return value;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : placeholderImage(fallbackLabel);
  } catch {
    return placeholderImage(fallbackLabel);
  }
}

function openModal(id) {
  const modal = $(`#${id}`);
  if (!modal) return;
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function closeModal(id) {
  const modal = $(`#${id}`);
  if (!modal) return;
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

function cloudinaryReady() {
  return Boolean(
    cloudinaryConfig?.cloudName
    && cloudinaryConfig?.uploadPreset
    && !String(cloudinaryConfig.cloudName).includes('YOUR_')
    && !String(cloudinaryConfig.uploadPreset).includes('YOUR_')
  );
}

function validateImageFile(file) {
  if (!file) return;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    throw new Error('Only JPG, PNG and WebP photos are allowed.');
  }
  if (file.size > IMAGE_RULES.inputMaxBytes) {
    throw new Error('Photo must be smaller than 8 MB.');
  }
}

async function decodeImage(file) {
  if ('createImageBitmap' in window) return createImageBitmap(file);
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = objectUrl;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function canvasToBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('This browser could not compress the photo.'));
    }, 'image/webp', quality);
  });
}

async function compressImage(file, rules) {
  validateImageFile(file);
  const source = await decodeImage(file);
  const sourceWidth = source.width;
  const sourceHeight = source.height;
  let scale = Math.min(1, rules.maxWidth / sourceWidth, rules.maxHeight / sourceHeight);
  let lastBlob = null;

  for (let resizePass = 0; resizePass < 3; resizePass += 1) {
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false });
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(source, 0, 0, width, height);

    for (const quality of [0.84, 0.74, 0.64, 0.54]) {
      lastBlob = await canvasToBlob(canvas, quality);
      if (lastBlob.size <= rules.maxBytes) {
        if (typeof source.close === 'function') source.close();
        return lastBlob;
      }
    }
    scale *= 0.82;
  }

  if (typeof source.close === 'function') source.close();
  return lastBlob;
}

async function uploadImage(file, { folder, kind, statusElement }) {
  if (!file) return null;
  if (!cloudinaryReady()) {
    throw new Error('Cloudinary is not configured. Add the public cloud name and unsigned preset.');
  }

  if (statusElement) statusElement.textContent = 'Compressing photo…';
  const compressed = await compressImage(file, IMAGE_RULES[kind]);
  if (statusElement) statusElement.textContent = `Uploading ${(compressed.size / 1024).toFixed(0)} KB…`;

  const formData = new FormData();
  formData.append('file', compressed, `${kind}-${Date.now()}.webp`);
  formData.append('upload_preset', cloudinaryConfig.uploadPreset);
  formData.append('folder', folder);

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(
      `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudinaryConfig.cloudName)}/image/upload`,
      { method: 'POST', body: formData, signal: controller.signal }
    );
    const result = await response.json();
    if (!response.ok || !result.secure_url) {
      throw new Error(result?.error?.message || 'Photo upload failed.');
    }
    if (statusElement) statusElement.textContent = 'Photo uploaded.';
    return { imageUrl: result.secure_url, imagePublicId: result.public_id || '' };
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Photo upload timed out. Check your connection and retry.');
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function previewSelectedFile(input, preview, status, requiredText) {
  const file = input.files?.[0];
  if (!file) {
    preview.removeAttribute('src');
    preview.classList.remove('visible');
    status.textContent = requiredText;
    return;
  }
  try {
    validateImageFile(file);
    const objectUrl = URL.createObjectURL(file);
    preview.src = objectUrl;
    preview.classList.add('visible');
    preview.onload = () => URL.revokeObjectURL(objectUrl);
    status.textContent = `${(file.size / 1024 / 1024).toFixed(1)} MB selected. It will be compressed.`;
  } catch (error) {
    input.value = '';
    preview.removeAttribute('src');
    preview.classList.remove('visible');
    status.textContent = error.message;
    toast(error.message, true);
  }
}

function stopRealtime()
function stopRealtime() {
  state.unsubStore?.();
  state.unsubProducts?.();
  state.unsubOrders?.();
  state.unsubToday?.();
  state.unsubStore = null;
  state.unsubProducts = null;
  state.unsubOrders = null;
  state.unsubToday = null;
}

async function loadMerchant()
async function loadMerchant() {
  const merchantSnapshot = await getDoc(doc(db, 'merchants', state.user.uid));
  state.merchant = merchantSnapshot.exists() ? merchantSnapshot.data() : null;
  if (!state.merchant?.onboardingComplete) return false;
  state.storeId = state.merchant.storeId;
  const storeSnapshot = await getDoc(doc(db, 'stores', state.storeId));
  if (!storeSnapshot.exists()) throw new Error('Linked store was not found.');
  state.store = storeSnapshot.data();
  return true;
}

function openManualAddress(focus = false) {
  $('#manual-address-panel').classList.remove('hidden');
  $('#manual-address-btn').textContent = 'Address form opened';
  if (focus) $('#shop-address').focus();
}

function formatReverseAddress(result) {
  const locality = result.locality || result.city || result.localityInfo?.administrative?.find((item) => item.adminLevel >= 8)?.name || '';
  const city = result.city || result.localityInfo?.administrative?.find((item) => item.adminLevel === 6)?.name || '';
  const stateName = result.principalSubdivision || result.localityInfo?.administrative?.find((item) => item.adminLevel === 4)?.name || '';
  const postalCode = result.postcode || '';
  const country = result.countryName || '';
  const parts = [...new Set([locality, city, stateName, postalCode, country].filter(Boolean))];
  return {
    fullAddress: parts.join(', '),
    locality,
    city,
    state: stateName,
    postalCode,
    country,
    source: 'reverse_geocoding'
  };
}

async function reverseGeocode(latitude, longitude) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15000);
  try {
    const params = new URLSearchParams({
      latitude: String(latitude),
      longitude: String(longitude),
      localityLanguage: 'en'
    });
    const response = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?${params}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) throw new Error('Address lookup failed.');
    const address = formatReverseAddress(await response.json());
    if (!address.fullAddress) throw new Error('Exact address could not be detected.');
    return address;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function forwardGeocode(fullAddress) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15000);
  try {
    const params = new URLSearchParams({
      q: fullAddress,
      format: 'jsonv2',
      addressdetails: '1',
      limit: '1',
      countrycodes: 'in'
    });
    const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'Accept-Language': 'en-IN,en;q=0.8' }
    });
    if (!response.ok) throw new Error('Address verification failed.');
    const result = (await response.json())?.[0];
    const latitude = Number(result?.lat);
    const longitude = Number(result?.lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new Error('Shop address was not found. Add area, city, state and PIN code.');
    }
    const details = result.address || {};
    return {
      location: {
        latitude: Number(latitude.toFixed(6)),
        longitude: Number(longitude.toFixed(6)),
        accuracy: null,
        capturedAt: new Date().toISOString()
      },
      address: {
        fullAddress,
        locality: details.suburb || details.neighbourhood || details.village || '',
        city: details.city || details.town || details.county || '',
        state: details.state || '',
        postalCode: details.postcode || '',
        country: details.country || 'India',
        source: 'forward_geocoding'
      }
    };
  } finally {
    window.clearTimeout(timeout);
  }
}

function geolocationMessage(error) {
  if (error?.code === 1) return 'Location access is blocked. Allow it in browser settings, or add the address manually.';
  if (error?.code === 2) return 'Current location is unavailable. Turn on GPS, or add the address manually.';
  if (error?.code === 3) return 'Location detection timed out. Try again or add the address manually.';
  return 'Location could not be detected. Add the address manually.';
}

function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 18000,
      maximumAge: 30000
    });
  });
}

async function requestLocation() {
  const button = $('#location-btn');
  if (!navigator.geolocation) {
    $('#location-status').textContent = 'This browser does not support location. Add the address manually.';
    openManualAddress(true);
    return;
  }
  setButtonBusy(button, true, 'Detecting location…', 'Use current shop location');
  $('#location-status').textContent = 'Checking location permission…';
  try {
    const position = await getCurrentPosition();
    state.location = {
      latitude: Number(position.coords.latitude.toFixed(6)),
      longitude: Number(position.coords.longitude.toFixed(6)),
      accuracy: Math.round(position.coords.accuracy),
      capturedAt: new Date().toISOString()
    };
    $('#location-status').textContent = 'Location found. Fetching readable address…';
    try {
      state.resolvedAddress = await reverseGeocode(state.location.latitude, state.location.longitude);
      $('#shop-address').value = state.resolvedAddress.fullAddress;
      $('#shop-address').dataset.source = 'detected';
      openManualAddress(false);
      $('#location-status').textContent = `Detected: ${state.resolvedAddress.fullAddress}`;
      toast('Shop location and address added.');
    } catch (error) {
      console.warn(error);
      state.resolvedAddress = null;
      $('#location-status').textContent = 'Location detected. Add the exact readable address below.';
      openManualAddress(true);
    }
  } catch (error) {
    console.warn(error);
    state.location = null;
    state.resolvedAddress = null;
    $('#location-status').textContent = geolocationMessage(error);
    openManualAddress(true);
  } finally {
    setButtonBusy(button, false, 'Detecting location…', 'Use current shop location');
  }
}

function hydrateOnboarding() {
  $('#business-form').reset();
  $('#owner-name').value = state.user.displayName || '';
  $('#opening-time').value = '09:00';
  $('#closing-time').value = '21:00';
  state.location = null;
  state.resolvedAddress = null;
  $('#shop-address').dataset.source = '';
  $('#manual-address-panel').classList.add('hidden');
  $('#manual-address-btn').textContent = 'Add address manually';
  $('#location-status').textContent = 'Use GPS to detect the shop area, or add the address manually.';
  $('#shop-image-preview').removeAttribute('src');
  $('#shop-image-preview').classList.remove('visible');
  $('#shop-image-status').textContent = cloudinaryReady()
    ? 'Required. The photo is compressed before upload.'
    : 'Cloudinary configuration is required before creating a store.';
}

async function createBusiness(event) {
  event.preventDefault();
  const phone = $('#owner-phone').value.replace(/\D/g, '');
  const fullAddress = $('#shop-address').value.trim();
  const storePhoto = $('#shop-image').files?.[0];
  if (!/^[6-9]\d{9}$/.test(phone)) return toast('Enter a valid 10-digit phone number.', true);
  if (!fullAddress) {
    openManualAddress(true);
    return toast('Detect or enter the full shop address.', true);
  }
  if (!storePhoto) return toast('Add a store cover photo.', true);

  const button = $('#complete-setup-btn');
  setButtonBusy(button, true, 'Creating…', 'Create business profile');
  try {
    if (!state.location || $('#shop-address').dataset.source === 'manual') {
      $('#location-status').textContent = 'Verifying the manual address…';
      const geocoded = await forwardGeocode(fullAddress);
      state.location = geocoded.location;
      state.resolvedAddress = geocoded.address;
      $('#location-status').textContent = 'Address verified and map pin added.';
    }

    const storeReference = doc(collection(db, 'stores'));
    const storeImage = await uploadImage(storePhoto, {
      folder: `myqk/stores/${storeReference.id}`,
      kind: 'store',
      statusElement: $('#shop-image-status')
    });
    const timestamp = serverTimestamp();
    const address = {
      fullAddress,
      locality: state.resolvedAddress?.locality || '',
      city: state.resolvedAddress?.city || '',
      state: state.resolvedAddress?.state || '',
      postalCode: state.resolvedAddress?.postalCode || '',
      country: state.resolvedAddress?.country || 'India',
      source: state.resolvedAddress?.source || 'manual'
    };
    const store = {
      merchantId: state.user.uid,
      name: $('#shop-name').value.trim(),
      category: $('#shop-category').value,
      description: $('#shop-description').value.trim(),
      phone,
      address,
      location: state.location,
      openingTime: $('#opening-time').value,
      closingTime: $('#closing-time').value,
      isOpen: true,
      isApproved: false,
      status: 'pending_approval',
      minimumOrder: 99,
      deliveryRadiusKm: 8,
      rating: 0,
      totalRatings: 0,
      imageUrl: storeImage.imageUrl,
      imagePublicId: storeImage.imagePublicId,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const merchant = {
      uid: state.user.uid,
      fullName: $('#owner-name').value.trim(),
      email: state.user.email || '',
      photoURL: state.user.photoURL || '',
      phone,
      storeId: storeReference.id,
      onboardingComplete: true,
      accountStatus: 'pending',
      termsAccepted: true,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    const batch = writeBatch(db);
    batch.set(storeReference, store);
    batch.set(doc(db, 'merchants', state.user.uid), merchant);
    await batch.commit();

    state.merchant = merchant;
    state.store = store;
    state.storeId = storeReference.id;
    hydrateApp();
    startRealtime();
    showScreen('app-screen');
    toast('Business profile created. Store approval is pending.');
  } catch (error) {
    console.error(error);
    toast(error.message || 'Business profile could not be created.', true);
  } finally {
    setButtonBusy(button, false, 'Creating…', 'Create business profile');
  }
}

function renderShopToggle() {
  const button = $('#shop-toggle');
  const open = state.store?.isOpen !== false;
  button.textContent = open ? 'Open' : 'Closed';
  button.className = `status-toggle ${open ? 'open' : 'closed'}`;
}

function hydrateStoreSettings() {
  if (!state.store) return;
  $('#settings-store-name').value = state.store.name || '';
  $('#settings-category').value = state.store.category || 'other';
  $('#settings-description').value = state.store.description || '';
  $('#settings-phone').value = state.store.phone || '';
  $('#settings-address').value = state.store.address?.fullAddress || '';
  $('#settings-opening-time').value = state.store.openingTime || '09:00';
  $('#settings-closing-time').value = state.store.closingTime || '21:00';
  $('#settings-minimum-order').value = Number(state.store.minimumOrder || 0);
  $('#settings-radius').value = Number(state.store.deliveryRadiusKm || 8);
}

function hydrateApp() {
  const name = state.store?.name || 'BuyQK Store';
  $('#header-store-name').textContent = name;
  $('#profile-store-name').textContent = name;
  $('#profile-avatar').textContent = name.charAt(0).toUpperCase();
  const approved = state.store?.isApproved === true && state.store?.status === 'active';
  $('#profile-status').textContent = approved ? 'Active store' : 'Pending approval';
  $('#approval-banner').classList.toggle('hidden', approved);
  $('#profile-store-image').src = safeImageUrl(state.store?.imageUrl, name);
  $('#store-image-update-status').textContent = cloudinaryReady()
    ? 'Choose a new cover photo and save.'
    : 'Cloudinary configuration is required for uploads.';
  renderShopToggle();
  hydrateStoreSettings();
}

async function toggleShop() {
  if (!state.storeId) return;
  const next = !(state.store?.isOpen !== false);
  try {
    await updateDoc(doc(db, 'stores', state.storeId), { isOpen: next, updatedAt: serverTimestamp() });
    toast(next ? 'Store is open.' : 'Store is closed.');
  } catch (error) {
    console.error(error);
    toast('Store status update failed.', true);
  }
}

async function saveStoreSettings(event) {
  event.preventDefault();
  const phone = $('#settings-phone').value.replace(/\D/g, '');
  const minimumOrder = Number($('#settings-minimum-order').value);
  const deliveryRadiusKm = Number($('#settings-radius').value);
  if (!/^[6-9]\d{9}$/.test(phone)) return toast('Enter a valid 10-digit store phone number.', true);
  if (!Number.isFinite(minimumOrder) || minimumOrder < 0) return toast('Minimum order must be zero or more.', true);
  if (!Number.isFinite(deliveryRadiusKm) || deliveryRadiusKm <= 0) return toast('Delivery radius must be greater than zero.', true);

  const button = $('#save-store-settings-btn');
  setButtonBusy(button, true, 'Saving…', 'Save store details');
  try {
    const address = {
      ...(state.store.address || {}),
      fullAddress: $('#settings-address').value.trim(),
      source: 'merchant_edit'
    };
    await updateDoc(doc(db, 'stores', state.storeId), {
      name: $('#settings-store-name').value.trim(),
      category: $('#settings-category').value,
      description: $('#settings-description').value.trim(),
      phone,
      address,
      openingTime: $('#settings-opening-time').value,
      closingTime: $('#settings-closing-time').value,
      minimumOrder,
      deliveryRadiusKm,
      updatedAt: serverTimestamp()
    });
    toast('Store details updated for customers and riders.');
  } catch (error) {
    console.error(error);
    toast('Store details could not be saved.', true);
  } finally {
    setButtonBusy(button, false, 'Saving…', 'Save store details');
  }
}

async function saveStoreImage() {
  const file = $('#store-image-update').files?.[0];
  if (!file) return toast('Choose a store photo first.', true);
  const button = $('#save-store-image-btn');
  setButtonBusy(button, true, 'Uploading…', 'Save store photo');
  try {
    const uploaded = await uploadImage(file, {
      folder: `myqk/stores/${state.storeId}`,
      kind: 'store',
      statusElement: $('#store-image-update-status')
    });
    await updateDoc(doc(db, 'stores', state.storeId), {
      imageUrl: uploaded.imageUrl,
      imagePublicId: uploaded.imagePublicId,
      updatedAt: serverTimestamp()
    });
    $('#store-image-update').value = '';
    toast('Store photo updated on customer and merchant apps.');
  } catch (error) {
    console.error(error);
    toast(error.message || 'Store photo upload failed.', true);
  } finally {
    setButtonBusy(button, false, 'Uploading…', 'Save store photo');
  }
}

function playNewOrderTone() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(660, context.currentTime);
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.32);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.34);
    oscillator.addEventListener('ended', () => context.close());
  } catch (error) {
    console.debug('Order tone unavailable:', error);
  }
}

function updateOrderAlert() {
  const count = state.orders.filter((order) => order.status === 'pending_merchant').length;
  $('#orders-nav-badge').textContent = count > 99 ? '99+' : String(count);
  $('#orders-nav-badge').classList.toggle('hidden', count === 0);
  $('#new-order-alert-text').textContent = count === 1 ? '1 new order needs attention' : `${count} new orders need attention`;
  $('#new-order-alert').classList.toggle('hidden', count === 0);
}

function startRealtime() {
  stopRealtime();
  state.hasInitialOrderSnapshot = false;
  state.knownPendingOrders = new Set();

  state.unsubStore = onSnapshot(doc(db, 'stores', state.storeId), (snapshot) => {
    if (!snapshot.exists()) return;
    state.store = snapshot.data();
    hydrateApp();
  }, (error) => {
    console.error(error);
    toast('Store profile could not refresh.', true);
  });

  state.unsubProducts = onSnapshot(
    query(collection(db, 'stores', state.storeId, 'products'), orderBy('createdAt', 'desc')),
    (snapshot) => {
      state.products = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
      renderAll();
    },
    (error) => {
      console.error(error);
      toast('Products could not load.', true);
    }
  );

  state.unsubOrders = onSnapshot(
    query(collection(db, 'orders'), where('storeId', '==', state.storeId), orderBy('createdAt', 'desc'), limit(50)),
    (snapshot) => {
      state.orders = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
      const currentPending = new Set(state.orders.filter((order) => order.status === 'pending_merchant').map((order) => order.id));
      if (state.hasInitialOrderSnapshot) {
        const newPending = [...currentPending].filter((id) => !state.knownPendingOrders.has(id));
        if (newPending.length) {
          playNewOrderTone();
          toast(newPending.length === 1 ? 'New order received.' : `${newPending.length} new orders received.`);
        }
      }
      state.knownPendingOrders = currentPending;
      state.hasInitialOrderSnapshot = true;
      renderAll();
      updateOrderAlert();
      state.orders
        .filter((order) => order.status === 'cancelled' && order.inventoryReserved === true && order.inventoryRestored !== true)
        .forEach((order) => reconcileCancelledInventory(order.id));
    },
    (error) => {
      console.error(error);
      toast('Orders could not load. Check Firestore indexes.', true);
    }
  );

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  state.unsubToday = onSnapshot(
    query(
      collection(db, 'orders'),
      where('storeId', '==', state.storeId),
      where('status', '==', 'completed'),
      where('completedAt', '>=', startOfToday),
      orderBy('completedAt', 'desc'),
      limit(500)
    ),
    (snapshot) => {
      state.todayCompleted = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
      renderStats();
    },
    (error) => {
      console.error(error);
      toast('Today’s sales could not load. Check Firestore indexes.', true);
    }
  );
}

function renderStats() {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const completed = state.todayCompleted.filter((order) => {
    const timestamp = order.completedAt || order.updatedAt;
    const completedAt = typeof timestamp?.toMillis === 'function'
      ? timestamp.toMillis()
      : Number(timestamp?.seconds || 0) * 1000;
    return order.status === 'completed' && completedAt >= startOfToday.getTime();
  });
  const sales = completed.reduce((sum, order) => sum + Number(order.subtotal || order.totalAmount || 0), 0);
  $('#today-sales').textContent = money(sales);
  $('#today-summary').textContent = `${completed.length} order${completed.length === 1 ? '' : 's'} completed today`;
  $('#new-orders-count').textContent = state.orders.filter((order) => order.status === 'pending_merchant').length;
  $('#preparing-count').textContent = state.orders.filter((order) => ['merchant_accepted', 'preparing'].includes(order.status)).length;
  $('#products-count').textContent = state.products.length;
  $('#low-stock-count').textContent = state.products.filter((product) => stockState(product) !== 'ok').length;
}

function productCard(product, inventory = false) {
  const currentStockState = stockState(product);
  const image = `<img class="catalog-thumb${inventory ? ' inventory-thumb' : ''}" src="${safeImageUrl(product.imageUrl, product.name)}" alt="${escapeHtml(product.name)}">`;
  if (inventory) {
    return `<article class="inventory-card product-card-with-image">${image}<div class="product-card-body"><div class="card-head"><div><h4>${escapeHtml(product.name)}</h4><p>${escapeHtml(product.unit || '')} · ${escapeHtml(product.category || '')}</p></div><span class="stock-chip ${currentStockState}">${currentStockState === 'ok' ? 'In stock' : currentStockState === 'low' ? 'Low stock' : 'Out of stock'}</span></div><div class="inventory-controls"><button data-stock="-1" data-id="${product.id}" type="button" aria-label="Decrease ${escapeHtml(product.name)} stock">−</button><strong>${Number(product.stockQuantity || 0)}</strong><button data-stock="1" data-id="${product.id}" type="button" aria-label="Increase ${escapeHtml(product.name)} stock">+</button><span>${money(product.sellingPrice)}</span></div><div class="card-actions"><button data-edit-product="${product.id}" type="button">Edit product</button></div></div></article>`;
  }
  return `<article class="product-card product-card-with-image">${image}<div class="product-card-body"><div class="card-head"><div><h4>${escapeHtml(product.name)}</h4><p>${escapeHtml(product.brand || 'BuyQK')} · ${escapeHtml(product.unit || '')}</p></div><div><div class="price">${money(product.sellingPrice)}</div><span class="stock-chip ${currentStockState}">${Number(product.stockQuantity || 0)} left</span></div></div><div class="card-actions"><button data-edit-product="${product.id}" type="button">Edit</button><button data-toggle-product="${product.id}" type="button" class="${product.isActive === false ? 'danger' : ''}">${product.isActive === false ? 'Activate' : 'Disable'}</button></div></div></article>`;
}

function orderCard(order) {
  return `<article class="order-card" data-order="${order.id}" tabindex="0" role="button"><div class="card-head"><div><h4>Order #${escapeHtml(order.orderNumber || order.id.slice(0, 6))}</h4><p>${escapeHtml(order.customerName || 'Customer')} · ${Number(order.itemCount || order.items?.length || 0)} items</p></div><span class="order-status ${escapeHtml(order.status)}">${escapeHtml(statusLabel(order.status))}</span></div><div class="order-meta"><span>${escapeHtml(order.paymentMode || 'Cash on Delivery')}</span><strong>${money(order.totalAmount)}</strong></div></article>`;
}

function lowStockCard(product) {
  const currentStockState = stockState(product);
  return `<article class="low-stock-card"><img class="catalog-thumb" src="${safeImageUrl(product.imageUrl, product.name)}" alt="${escapeHtml(product.name)}"><div class="product-card-body"><div class="card-head"><div><h4>${escapeHtml(product.name)}</h4><p>${escapeHtml(product.unit || '')}</p></div><span class="stock-chip ${currentStockState}">${Number(product.stockQuantity || 0)} left</span></div><div class="card-actions"><button data-view="inventory" type="button">Update stock</button></div></div></article>`;
}

function renderProducts() {
  const term = state.productFilter.toLowerCase();
  const list = state.products.filter((product) => !term || `${product.name} ${product.category} ${product.brand}`.toLowerCase().includes(term));
  $('#products-list').innerHTML = list.length ? list.map((product) => productCard(product)).join('') : '<div class="empty-state">No products added yet.</div>';
}

function renderInventory() {
  let list = state.products;
  if (state.stockFilter === 'low') list = list.filter((product) => stockState(product) === 'low');
  if (state.stockFilter === 'out') list = list.filter((product) => stockState(product) === 'out');
  $('#inventory-list').innerHTML = list.length ? list.map((product) => productCard(product, true)).join('') : '<div class="empty-state">No products in this section.</div>';
}

function renderOrders() {
  const list = state.orderFilter === 'all' ? state.orders : state.orders.filter((order) => order.status === state.orderFilter);
  $('#orders-list').innerHTML = list.length ? list.map(orderCard).join('') : '<div class="empty-state">No orders in this section.</div>';
}

function renderRecentOrders() {
  const list = state.orders.slice(0, 3);
  $('#recent-orders').innerHTML = list.length ? list.map(orderCard).join('') : '<div class="empty-state compact">No merchant orders yet.</div>';
}

function renderLowStock() {
  const list = state.products.filter((product) => stockState(product) !== 'ok').slice(0, 3);
  $('#home-low-stock').innerHTML = list.length ? list.map(lowStockCard).join('') : '<div class="empty-state compact">Stock levels look good.</div>';
}

function renderAll() {
  renderStats();
  renderProducts();
  renderInventory();
  renderOrders();
  renderRecentOrders();
  renderLowStock();
}

function resetProductForm() {
  $('#product-form').reset();
  $('#product-id').value = '';
  $('#product-threshold').value = '5';
  $('#product-modal-title').textContent = 'Add product';
  $('#product-image-preview').removeAttribute('src');
  $('#product-image-preview').classList.remove('visible');
  $('#product-image-status').textContent = cloudinaryReady()
    ? 'Required for a new product. One photo; compressed automatically.'
    : 'Cloudinary configuration is required before adding a product.';
}

function openAddProduct() {
  resetProductForm();
  openModal('product-modal');
}

function editProduct(id) {
  const product = state.products.find((item) => item.id === id);
  if (!product) return;
  $('#product-id').value = id;
  $('#product-name').value = product.name || '';
  $('#product-category').value = product.category || '';
  $('#product-brand').value = product.brand || '';
  $('#product-unit').value = product.unit || '';
  $('#product-mrp').value = product.mrp || 0;
  $('#product-price').value = product.sellingPrice || 0;
  $('#product-stock').value = product.stockQuantity || 0;
  $('#product-threshold').value = product.lowStockThreshold || 5;
  $('#product-description').value = product.description || '';
  $('#product-image').value = '';
  $('#product-image-preview').src = safeImageUrl(product.imageUrl, product.name);
  $('#product-image-preview').classList.add('visible');
  $('#product-image-status').textContent = product.imageUrl
    ? 'Current photo. Choose another only to replace it.'
    : 'This product has no photo. Add one before saving.';
  $('#product-modal-title').textContent = 'Edit product';
  openModal('product-modal');
}

async function saveProduct(event) {
  event.preventDefault();
  const id = $('#product-id').value;
  const imageFile = $('#product-image').files?.[0];
  const productReference = id
    ? doc(db, 'stores', state.storeId, 'products', id)
    : doc(collection(db, 'stores', state.storeId, 'products'));
  const existing = id ? state.products.find((product) => product.id === id) : null;
  const sellingPrice = Number($('#product-price').value);
  const mrp = Number($('#product-mrp').value);
  const stockQuantity = Number($('#product-stock').value);
  const lowStockThreshold = Number($('#product-threshold').value);
  if (!Number.isFinite(mrp) || !Number.isFinite(sellingPrice) || sellingPrice > mrp) return toast('Selling price cannot be higher than MRP.', true);
  if (!Number.isInteger(stockQuantity) || stockQuantity < 0) return toast('Stock quantity must be a whole number.', true);
  if (!Number.isInteger(lowStockThreshold) || lowStockThreshold < 0) return toast('Low-stock alert must be a whole number.', true);
  if (!id && !imageFile) return toast('Add a product photo.', true);
  if (id && !existing?.imageUrl && !imageFile) return toast('Add a product photo.', true);

  const button = $('#product-form button[type="submit"]');
  setButtonBusy(button, true, 'Saving…', 'Save product');
  try {
    const uploaded = await uploadImage(imageFile, {
      folder: `myqk/stores/${state.storeId}/products/${productReference.id}`,
      kind: 'product',
      statusElement: $('#product-image-status')
    });
    const data = {
      storeId: state.storeId,
      merchantId: state.user.uid,
      name: $('#product-name').value.trim(),
      category: $('#product-category').value.trim(),
      brand: $('#product-brand').value.trim(),
      unit: $('#product-unit').value.trim(),
      mrp,
      sellingPrice,
      stockQuantity,
      lowStockThreshold,
      description: $('#product-description').value.trim(),
      imageUrl: uploaded?.imageUrl || existing?.imageUrl || '',
      imagePublicId: uploaded?.imagePublicId || existing?.imagePublicId || '',
      isActive: existing?.isActive === false ? false : true,
      isAvailable: stockQuantity > 0,
      updatedAt: serverTimestamp()
    };
    if (id) await updateDoc(productReference, data);
    else await setDoc(productReference, { ...data, createdAt: serverTimestamp() });
    closeModal('product-modal');
    toast(id ? 'Product updated for customers.' : 'Product added to your live catalog.');
  } catch (error) {
    console.error(error);
    toast(error.message || 'Product save failed.', true);
  } finally {
    setButtonBusy(button, false, 'Saving…', 'Save product');
  }
}

async function toggleProduct(id) {
  const product = state.products.find((item) => item.id === id);
  if (!product) return;
  try {
    await updateDoc(doc(db, 'stores', state.storeId, 'products', id), {
      isActive: product.isActive === false,
      updatedAt: serverTimestamp()
    });
    toast(product.isActive === false ? 'Product activated.' : 'Product hidden from customers.');
  } catch (error) {
    console.error(error);
    toast('Product status update failed.', true);
  }
}

async function changeStock(id, delta) {
  const reference = doc(db, 'stores', state.storeId, 'products', id);
  try {
    await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists()) throw new Error('NOT_FOUND');
      const before = Number(snapshot.data().stockQuantity || 0);
      const after = Math.max(0, before + delta);
      if (after === before) return;
      transaction.update(reference, {
        stockQuantity: after,
        isAvailable: after > 0,
        updatedAt: serverTimestamp()
      });
      transaction.set(doc(collection(db, 'stores', state.storeId, 'stockMovements')), {
        productId: id,
        type: delta > 0 ? 'manual_add' : 'manual_remove',
        quantityChange: after - before,
        previousStock: before,
        newStock: after,
        createdBy: state.user.uid,
        createdAt: serverTimestamp()
      });
    });
  } catch (error) {
    console.error(error);
    toast('Stock update failed.', true);
  }
}

function openOrder(id) {
  const order = state.orders.find((item) => item.id === id);
  if (!order) return;
  const items = (order.items || []).map((item) => `<div class="order-item-row"><span>${Number(item.quantity || 1)} × ${escapeHtml(item.name)}</span><strong>${money(item.lineTotal || Number(item.unitPrice || 0) * Number(item.quantity || 1))}</strong></div>`).join('');
  let actions = '';
  if (order.status === 'pending_merchant') actions = `<div class="card-actions"><button data-order-action="merchant_rejected" data-id="${id}" type="button">Reject</button><button class="primary-action" data-order-action="merchant_accepted" data-id="${id}" type="button">Accept order</button></div>`;
  if (order.status === 'merchant_accepted') actions = `<div class="card-actions"><button class="primary-action" data-order-action="preparing" data-id="${id}" type="button">Start preparing</button></div>`;
  if (order.status === 'preparing') actions = `<div class="card-actions"><button class="primary-action" data-order-action="ready_for_pickup" data-id="${id}" type="button">Mark ready for pickup</button></div>`;
  $('#order-modal-title').textContent = `Order #${order.orderNumber || order.id.slice(0, 6)}`;
  $('#order-detail-content').innerHTML = `<div class="order-customer"><strong>${escapeHtml(order.customerName || 'Customer')}</strong><p>${escapeHtml(order.drop?.address || order.dropAddress || 'Delivery address unavailable')}</p></div><div class="order-items">${items || '<div class="order-item-row"><span>No item details</span></div>'}</div><div class="order-meta"><span>${escapeHtml(statusLabel(order.status))} · ${escapeHtml(order.paymentMode || 'Cash on Delivery')}</span><strong>${money(order.totalAmount)}</strong></div>${actions}`;
  openModal('order-modal');
}

async function orderAction(id, next) {
  if (next === 'merchant_rejected' && !window.confirm('Reject this order?')) return;
  const reference = doc(db, 'orders', id);
  try {
    await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists()) throw new Error('NOT_FOUND');
      const order = snapshot.data();
      if (order.storeId !== state.storeId || order.merchantId !== state.user.uid) throw new Error('DENIED');
      const allowed = {
        pending_merchant: ['merchant_accepted', 'merchant_rejected'],
        merchant_accepted: ['preparing'],
        preparing: ['ready_for_pickup']
      };
      if (!allowed[order.status]?.includes(next)) throw new Error('INVALID_STATUS');
      const update = { status: next, updatedAt: serverTimestamp() };

      if (next === 'merchant_accepted') {
        if (order.inventoryReserved === true) {
          update.merchantAcceptedAt = serverTimestamp();
        } else {
          const storeSnapshot = await transaction.get(doc(db, 'stores', state.storeId));
          if (!storeSnapshot.exists()) throw new Error('STORE_NOT_FOUND');
          const store = storeSnapshot.data();
          if (store.isApproved !== true || store.status !== 'active') throw new Error('STORE_NOT_APPROVED');
          const deliveryDistance = distanceKm(store.location, order.drop?.location || order.dropLocation);
          const deliveryRadius = Number(store.deliveryRadiusKm || 0);
          if (!Number.isFinite(deliveryDistance) || (deliveryRadius > 0 && deliveryDistance > deliveryRadius)) {
            throw new Error('OUT_OF_DELIVERY_RADIUS');
          }

          const quantities = new Map();
          for (const item of order.items || []) {
            const productId = String(item.productId || '');
            const quantity = Number(item.quantity);
            if (!productId || !Number.isInteger(quantity) || quantity <= 0) throw new Error('INVALID_ORDER_ITEMS');
            quantities.set(productId, (quantities.get(productId) || 0) + quantity);
          }
          if (!quantities.size) throw new Error('INVALID_ORDER_ITEMS');

          const productReferences = [...quantities.keys()].map((productId) => doc(db, 'stores', state.storeId, 'products', productId));
          const productSnapshots = await Promise.all(productReferences.map((productReference) => transaction.get(productReference)));
          const products = new Map(productSnapshots.map((productSnapshot) => [productSnapshot.id, productSnapshot]));

          let verifiedSubtotal = 0;
          for (const item of order.items) {
            const productSnapshot = products.get(String(item.productId || ''));
            if (!productSnapshot?.exists()) throw new Error('PRODUCT_NOT_FOUND');
            const product = productSnapshot.data();
            const unitPrice = Number(item.unitPrice);
            const currentPrice = Number(product.sellingPrice);
            const quantity = Number(item.quantity);
            if (product.isActive === false || product.isAvailable === false) throw new Error(`${product.name || 'Product'} is unavailable`);
            if (!Number.isFinite(unitPrice) || Math.abs(unitPrice - currentPrice) > 0.001) throw new Error(`${product.name || 'Product'} price changed`);
            verifiedSubtotal += currentPrice * quantity;
          }

          const deliveryFee = verifiedSubtotal >= 299 ? 0 : 25;
          const platformFee = 3;
          const totalAmount = verifiedSubtotal + deliveryFee + platformFee;
          if (
            verifiedSubtotal < Number(store.minimumOrder || 0)
            || Math.abs(Number(order.subtotal) - verifiedSubtotal) > 0.01
            || Math.abs(Number(order.deliveryFee) - deliveryFee) > 0.01
            || Math.abs(Number(order.platformFee) - platformFee) > 0.01
            || Math.abs(Number(order.totalAmount) - totalAmount) > 0.01
          ) throw new Error('ORDER_TOTAL_MISMATCH');

          for (const [productId, quantity] of quantities) {
            const productSnapshot = products.get(productId);
            const product = productSnapshot.data();
            const before = Number(product.stockQuantity || 0);
            if (!Number.isInteger(before) || before < quantity) throw new Error(`${product.name || 'Product'} is out of stock`);
            const after = before - quantity;
            transaction.update(productSnapshot.ref, {
              stockQuantity: after,
              isAvailable: after > 0,
              updatedAt: serverTimestamp()
            });
            transaction.set(doc(collection(db, 'stores', state.storeId, 'stockMovements')), {
              productId,
              orderId: id,
              type: 'order_reserved',
              quantityChange: -quantity,
              previousStock: before,
              newStock: after,
              createdBy: state.user.uid,
              createdAt: serverTimestamp()
            });
          }

          update.inventoryReserved = true;
          update.inventoryRestored = false;
          update.inventoryReservedAt = serverTimestamp();
          update.merchantAcceptedAt = serverTimestamp();
        }
      }
      if (next === 'merchant_rejected') update.merchantRejectedAt = serverTimestamp();
      if (next === 'preparing') update.preparingAt = serverTimestamp();
      if (next === 'ready_for_pickup') update.readyAt = serverTimestamp();
      transaction.update(reference, update);
    });
    closeModal('order-modal');
    toast(`Order marked ${statusLabel(next)}.`);
  } catch (error) {
    console.error(error);
    const message = String(error?.message || '');
    const readable = message
      .replace('ORDER_TOTAL_MISMATCH', 'bill details are invalid')
      .replace('OUT_OF_DELIVERY_RADIUS', 'delivery address is outside the store area')
      .replace('STORE_NOT_APPROVED', 'store approval is still pending');
    toast(/out of stock|unavailable|price changed|ORDER_TOTAL_MISMATCH|OUT_OF_DELIVERY_RADIUS|STORE_NOT_APPROVED/.test(message)
      ? `Order cannot be accepted: ${readable}.`
      : 'Order status update failed.', true);
  }
}

async function reconcileCancelledInventory(id) {
  if (state.reconcilingOrders.has(id)) return;
  state.reconcilingOrders.add(id);
  const orderReference = doc(db, 'orders', id);
  try {
    await runTransaction(db, async (transaction) => {
      const orderSnapshot = await transaction.get(orderReference);
      if (!orderSnapshot.exists()) return;
      const order = orderSnapshot.data();
      if (order.storeId !== state.storeId || order.status !== 'cancelled' || order.inventoryReserved !== true || order.inventoryRestored === true) return;

      const quantities = new Map();
      for (const item of order.items || []) {
        const productId = String(item.productId || '');
        const quantity = Number(item.quantity);
        if (!productId || !Number.isInteger(quantity) || quantity <= 0) throw new Error('INVALID_ORDER_ITEMS');
        quantities.set(productId, (quantities.get(productId) || 0) + quantity);
      }
      const productReferences = [...quantities.keys()].map((productId) => doc(db, 'stores', state.storeId, 'products', productId));
      const productSnapshots = await Promise.all(productReferences.map((productReference) => transaction.get(productReference)));
      if (productSnapshots.some((productSnapshot) => !productSnapshot.exists())) throw new Error('PRODUCT_NOT_FOUND');

      for (const productSnapshot of productSnapshots) {
        const quantity = quantities.get(productSnapshot.id);
        const before = Number(productSnapshot.data().stockQuantity || 0);
        const after = before + quantity;
        transaction.update(productSnapshot.ref, { stockQuantity: after, isAvailable: true, updatedAt: serverTimestamp() });
        transaction.set(doc(collection(db, 'stores', state.storeId, 'stockMovements')), {
          productId: productSnapshot.id,
          orderId: id,
          type: 'order_cancelled_restore',
          quantityChange: quantity,
          previousStock: before,
          newStock: after,
          createdBy: state.user.uid,
          createdAt: serverTimestamp()
        });
      }
      transaction.update(orderReference, {
        inventoryRestored: true,
        inventoryRestoredAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    });
  } catch (error) {
    console.error('Cancelled order inventory restoration failed:', error);
  } finally {
    state.reconcilingOrders.delete(id);
  }
}

function switchView(name) {
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === `${name}-view`));
  $$('.nav-btn').forEach((button) => button.classList.toggle('active', button.dataset.view === name));
  $('#main-content').scrollTop = 0;
}

function digitsOnly(event) {
  event.target.value = event.target.value.replace(/\D/g, '').slice(0, 10);
}

document.addEventListener('click', (event) => {
  const close = event.target.closest('[data-close-modal]');
  if (close) closeModal(close.dataset.closeModal);
  const navigation = event.target.closest('[data-view]');
  if (navigation) switchView(navigation.dataset.view);
  const go = event.target.closest('[data-go]');
  if (go) switchView(go.dataset.go);
  const edit = event.target.closest('[data-edit-product]');
  if (edit) editProduct(edit.dataset.editProduct);
  const toggle = event.target.closest('[data-toggle-product]');
  if (toggle) toggleProduct(toggle.dataset.toggleProduct);
  const stock = event.target.closest('[data-stock]');
  if (stock) changeStock(stock.dataset.id, Number(stock.dataset.stock));
  const order = event.target.closest('[data-order]');
  if (order) openOrder(order.dataset.order);
  const action = event.target.closest('[data-order-action]');
  if (action) orderAction(action.dataset.id, action.dataset.orderAction);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') $$('.modal.open').forEach((modal) => closeModal(modal.id));
  if (event.key === 'Enter' && event.target.matches('[data-order]')) openOrder(event.target.dataset.order);
});

$('#business-form').addEventListener('submit', createBusiness);
$('#location-btn').addEventListener('click', requestLocation);
$('#manual-address-btn').addEventListener('click', () => openManualAddress(true));
$('#shop-address').addEventListener('input', () => {
  if ($('#shop-address').dataset.source === 'detected') state.resolvedAddress = null;
  $('#shop-address').dataset.source = 'manual';
  $('#location-status').textContent = state.location
    ? 'Location pin saved. The address was edited manually.'
    : 'Manual shop address added.';
});
$('#shop-toggle').addEventListener('click', toggleShop);
$('#store-settings-form').addEventListener('submit', saveStoreSettings);
$('#save-store-image-btn').addEventListener('click', saveStoreImage);
$('#add-product-btn').addEventListener('click', openAddProduct);
$('#add-inventory-product-btn').addEventListener('click', openAddProduct);
$('#home-add-product-btn').addEventListener('click', openAddProduct);
$('#product-form').addEventListener('submit', saveProduct);
$('#product-search').addEventListener('input', (event) => {
  state.productFilter = event.target.value;
  renderProducts();
});
$('#shop-image').addEventListener('change', () => previewSelectedFile(
  $('#shop-image'),
  $('#shop-image-preview'),
  $('#shop-image-status'),
  'Required. The photo is compressed before upload.'
));
$('#product-image').addEventListener('change', () => previewSelectedFile(
  $('#product-image'),
  $('#product-image-preview'),
  $('#product-image-status'),
  $('#product-id').value ? 'Choose a photo only to replace the current one.' : 'Required for a new product.'
));
$('#store-image-update').addEventListener('change', () => {
  const file = $('#store-image-update').files?.[0];
  if (!file) return;
  try {
    validateImageFile(file);
    $('#store-image-update-status').textContent = `${(file.size / 1024 / 1024).toFixed(1)} MB selected. Save to upload.`;
  } catch (error) {
    $('#store-image-update').value = '';
    $('#store-image-update-status').textContent = error.message;
    toast(error.message, true);
  }
});
$$('[data-filter]').forEach((button) => button.addEventListener('click', () => {
  $$('[data-filter]').forEach((item) => item.classList.remove('active'));
  button.classList.add('active');
  state.orderFilter = button.dataset.filter;
  renderOrders();
}));
$$('[data-stock-filter]').forEach((button) => button.addEventListener('click', () => {
  $$('[data-stock-filter]').forEach((item) => item.classList.remove('active'));
  button.classList.add('active');
  state.stockFilter = button.dataset.stockFilter;
  renderInventory();
}));
$('#owner-phone').addEventListener('input', digitsOnly);
$('#settings-phone').addEventListener('input', digitsOnly);

document.addEventListener('error', (event) => {
  if (!(event.target instanceof HTMLImageElement)) return;
  const image = event.target;
  if (image.dataset.fallbackApplied) return;
  image.dataset.fallbackApplied = 'true';
  image.src = placeholderImage(image.alt || 'QK');
}, true);

window.addEventListener('beforeunload', stopRealtime);


let anonymousSignInPending = false;

async function handleAuthState(user) {
  state.user = user;
  if (!user) {
    stopRealtime();
    state.merchant = null;
    state.store = null;
    state.storeId = null;
    showScreen('loading-screen');
    setLoadingMessage('Starting your secure session…');
    if (anonymousSignInPending) return;
    anonymousSignInPending = true;
    try {
      await signInAnonymously(auth);
    } catch (error) {
      console.error(error);
      const message = error.code === 'auth/operation-not-allowed'
        ? 'Enable Anonymous sign-in in Firebase Authentication, then refresh.'
        : 'Secure anonymous session could not start. Refresh and retry.';
      setLoadingMessage(message);
      toast(message, true);
    } finally {
      anonymousSignInPending = false;
    }
    return;
  }

  showScreen('loading-screen');
  setLoadingMessage('Connecting your store…');
  try {
    const ready = await loadMerchant();
    if (!ready) {
      hydrateOnboarding();
      showScreen('onboarding-screen');
      return;
    }
    hydrateApp();
    renderAll();
    startRealtime();
    showScreen('app-screen');
  } catch (error) {
    console.error(error);
    const message = error.message || 'Merchant data could not load. Check Firestore rules.';
    setLoadingMessage(message);
    toast(message, true);
    showScreen('loading-screen');
  }
}

async function startAuthentication() {
  try {
    await setPersistence(auth, browserLocalPersistence);
  } catch (error) {
    console.warn('Firebase auth persistence could not be set explicitly.', error);
  }
  onAuthStateChanged(auth, handleAuthState);
}

startAuthentication();
