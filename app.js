import { firebaseConfig } from './firebase-config.js';
import { cloudinaryConfig } from './cloudinary-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import {
  addDoc,
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
  where
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  user: null,
  merchant: null,
  store: null,
  storeId: null,
  products: [],
  orders: [],
  productFilter: '',
  orderFilter: 'all',
  stockFilter: 'all',
  unsubProducts: null,
  unsubOrders: null,
  location: null,
  resolvedAddress: null
};

const IMAGE_RULES = {
  inputMaxBytes: 8 * 1024 * 1024,
  store: { maxWidth: 1200, maxHeight: 800, maxBytes: 300 * 1024 },
  product: { maxWidth: 800, maxHeight: 800, maxBytes: 180 * 1024 }
};

function toast(message, error = false) {
  const element = $('#toast');
  element.textContent = message;
  element.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.className = 'toast'; }, 3200);
}

function showScreen(id) {
  $$('.screen').forEach((screen) => screen.classList.toggle('active', screen.id === id));
}

function money(value) {
  return `₹${Number(value || 0).toLocaleString('en-IN')}`;
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

function stockState(product) {
  if (Number(product.stockQuantity) <= 0) return 'out';
  if (Number(product.stockQuantity) <= Number(product.lowStockThreshold || 5)) return 'low';
  return 'ok';
}

function openModal(id) {
  $(`#${id}`).classList.add('open');
  $(`#${id}`).setAttribute('aria-hidden', 'false');
}

function closeModal(id) {
  $(`#${id}`).classList.remove('open');
  $(`#${id}`).setAttribute('aria-hidden', 'true');
}

function placeholderImage(label = 'QK') {
  const initials = String(label).trim().split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase() || 'QK';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480"><rect width="640" height="480" rx="40" fill="#f8cb46"/><text x="320" y="275" text-anchor="middle" font-family="Arial,sans-serif" font-size="150" font-weight="700" fill="#111827">${escapeHtml(initials)}</text></svg>`;
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
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
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

    for (const quality of [0.82, 0.72, 0.62, 0.52]) {
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
    throw new Error('Cloudinary is not configured yet. Add cloud name and unsigned upload preset in cloudinary-config.js.');
  }

  const rules = IMAGE_RULES[kind];
  if (statusElement) statusElement.textContent = 'Compressing photo…';
  const compressed = await compressImage(file, rules);
  if (statusElement) statusElement.textContent = `Uploading ${(compressed.size / 1024).toFixed(0)} KB…`;

  const formData = new FormData();
  formData.append('file', compressed, `${kind}-${Date.now()}.webp`);
  formData.append('upload_preset', cloudinaryConfig.uploadPreset);
  formData.append('folder', folder);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
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
    if (error.name === 'AbortError') throw new Error('Photo upload timed out. Try a smaller image or better network.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function previewSelectedFile(input, preview, status, requiredText = 'JPG, PNG or WebP. The app compresses it before upload.') {
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

function setButtonBusy(button, busy, busyText, normalText) {
  button.disabled = busy;
  button.textContent = busy ? busyText : normalText;
}

async function login() {
  try {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    await signInWithPopup(auth, provider);
  } catch (error) {
    console.error(error);
    toast(error.code === 'auth/unauthorized-domain'
      ? 'Add this Vercel or Cloudflare Pages domain in Firebase Authorized domains.'
      : 'Google login failed.', true);
  }
}

async function logout() {
  state.unsubProducts?.();
  state.unsubOrders?.();
  await signOut(auth);
}

async function loadMerchant() {
  const merchantSnapshot = await getDoc(doc(db, 'merchants', state.user.uid));
  state.merchant = merchantSnapshot.exists() ? merchantSnapshot.data() : null;
  if (!state.merchant?.onboardingComplete) return false;
  state.storeId = state.merchant.storeId;
  const storeSnapshot = await getDoc(doc(db, 'stores', state.storeId));
  state.store = storeSnapshot.exists() ? storeSnapshot.data() : null;
  return Boolean(state.store);
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
  const timeout = setTimeout(() => controller.abort(), 15000);
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
    clearTimeout(timeout);
  }
}

function geolocationMessage(error) {
  if (error?.code === 1) return 'Location access is blocked. Allow Location in browser/site settings, or add the address manually below.';
  if (error?.code === 2) return 'Current location is unavailable. Turn on device Location/GPS, or add the address manually below.';
  if (error?.code === 3) return 'Location detection timed out. Try again outside, or add the address manually below.';
  return 'Location could not be detected. Add the address manually below.';
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
    $('#location-status').textContent = 'This browser does not support location. Add the shop address manually below.';
    openManualAddress(true);
    return;
  }

  setButtonBusy(button, true, 'Detecting location…', 'Use current shop location');
  $('#location-status').textContent = 'Checking location permission…';

  try {
    if (navigator.permissions?.query) {
      try {
        const permission = await navigator.permissions.query({ name: 'geolocation' });
        if (permission.state === 'denied') {
          $('#location-status').textContent = 'Location access is blocked. Open browser/site settings and allow Location, or add the address manually.';
          openManualAddress(true);
          return;
        }
      } catch (permissionError) {
        console.debug('Permissions API unavailable; using browser geolocation prompt.', permissionError);
      }
    }

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
      console.warn('Reverse geocoding failed:', error);
      state.resolvedAddress = null;
      $('#location-status').textContent = 'Location detected, but the readable address could not be fetched. Add the exact address manually below.';
      openManualAddress(true);
    }
  } catch (error) {
    console.warn('Geolocation failed:', error);
    state.location = null;
    state.resolvedAddress = null;
    $('#location-status').textContent = geolocationMessage(error);
    openManualAddress(true);
  } finally {
    setButtonBusy(button, false, 'Detecting location…', 'Use current shop location');
  }
}

function hydrateOnboarding() {
  $('#owner-name').value = state.user.displayName || '';
  state.location = null;
  state.resolvedAddress = null;
  $('#shop-address').value = '';
  $('#shop-address').dataset.source = '';
  $('#manual-address-panel').classList.add('hidden');
  $('#manual-address-btn').textContent = 'Add address manually';
  $('#location-status').textContent = 'Use GPS to detect the shop area, or add the address manually.';
  $('#shop-image').value = '';
  $('#shop-image-preview').classList.remove('visible');
  $('#shop-image-status').textContent = cloudinaryReady()
    ? 'Required. JPG, PNG or WebP; compressed automatically.'
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
    const storeReference = doc(collection(db, 'stores'));
    const storeImage = await uploadImage(storePhoto, {
      folder: `myqk/stores/${storeReference.id}`,
      kind: 'store',
      statusElement: $('#shop-image-status')
    });
    const now = serverTimestamp();
    const address = {
      fullAddress,
      locality: state.resolvedAddress?.locality || '',
      city: state.resolvedAddress?.city || '',
      state: state.resolvedAddress?.state || '',
      postalCode: state.resolvedAddress?.postalCode || '',
      country: state.resolvedAddress?.country || '',
      source: state.resolvedAddress ? 'reverse_geocoding' : 'manual'
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
      createdAt: now,
      updatedAt: now
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
      createdAt: now,
      updatedAt: now
    };

    await setDoc(storeReference, store);
    await setDoc(doc(db, 'merchants', state.user.uid), merchant);

    let activated = false;
    try {
      await Promise.all([
        updateDoc(doc(db, 'merchants', state.user.uid), { accountStatus: 'active', updatedAt: serverTimestamp() }),
        updateDoc(storeReference, { isApproved: true, status: 'active', updatedAt: serverTimestamp() })
      ]);
      activated = true;
    } catch (activationError) {
      console.warn('Immediate store activation failed; auto-approve will retry:', activationError);
    }

    state.merchant = { ...merchant, accountStatus: activated ? 'active' : 'pending' };
    state.store = { ...store, isApproved: activated, status: activated ? 'active' : 'pending_approval' };
    state.storeId = storeReference.id;
    hydrateApp();
    startRealtime();
    showScreen('app-screen');
    toast(activated ? 'Store created and published to the customer app.' : 'Store created. Publishing will retry automatically.');
  } catch (error) {
    console.error(error);
    toast(error.message || 'Business profile could not be created.', true);
  } finally {
    setButtonBusy(button, false, 'Creating…', 'Create business profile');
  }
}

function hydrateApp() {
  const name = state.store?.name || 'MyQK Store';
  $('#header-store-name').textContent = name;
  $('#profile-store-name').textContent = name;
  $('#profile-owner-email').textContent = state.user.email || '—';
  $('#profile-avatar').textContent = name.charAt(0).toUpperCase();
  $('#profile-status').textContent = state.store?.isApproved ? 'Active store' : 'Pending approval';
  $('#profile-store-image').src = safeImageUrl(state.store?.imageUrl, name);
  $('#store-image-update-status').textContent = cloudinaryReady()
    ? 'Choose a new cover photo and save.'
    : 'Add Cloudinary settings before uploading photos.';
  renderShopToggle();
}

function renderShopToggle() {
  const button = $('#shop-toggle');
  const open = state.store?.isOpen !== false;
  button.textContent = open ? 'Open' : 'Closed';
  button.className = `status-toggle ${open ? 'open' : 'closed'}`;
}

async function toggleShop() {
  try {
    const next = !(state.store?.isOpen !== false);
    await updateDoc(doc(db, 'stores', state.storeId), { isOpen: next, updatedAt: serverTimestamp() });
    state.store.isOpen = next;
    renderShopToggle();
    toast(next ? 'Store is open.' : 'Store is closed.');
  } catch {
    toast('Store status update failed.', true);
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
    state.store.imageUrl = uploaded.imageUrl;
    state.store.imagePublicId = uploaded.imagePublicId;
    $('#profile-store-image').src = uploaded.imageUrl;
    $('#store-image-update').value = '';
    toast('Store photo updated on merchant and customer pages.');
  } catch (error) {
    console.error(error);
    toast(error.message || 'Store photo upload failed.', true);
  } finally {
    setButtonBusy(button, false, 'Uploading…', 'Save store photo');
  }
}

function startRealtime() {
  state.unsubProducts?.();
  state.unsubOrders?.();
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
    query(collection(db, 'orders'), where('storeId', '==', state.storeId), limit(50)),
    (snapshot) => {
      state.orders = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
        .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
      renderAll();
    },
    (error) => {
      console.error(error);
      toast('Orders could not load. Firestore rules or index may be missing.', true);
    }
  );
}

function renderAll() {
  renderStats();
  renderProducts();
  renderOrders();
  renderInventory();
  renderRecentOrders();
}

function renderStats() {
  const completed = state.orders.filter((order) => order.status === 'completed');
  const sales = completed.reduce((sum, order) => sum + Number(order.subtotal || order.totalAmount || 0), 0);
  $('#today-sales').textContent = money(sales);
  $('#today-summary').textContent = `${completed.length} orders completed`;
  $('#new-orders-count').textContent = state.orders.filter((order) => order.status === 'pending_merchant').length;
  $('#preparing-count').textContent = state.orders.filter((order) => ['merchant_accepted', 'preparing'].includes(order.status)).length;
  $('#products-count').textContent = state.products.length;
  $('#low-stock-count').textContent = state.products.filter((product) => stockState(product) !== 'ok').length;
}

function productCard(product, inventory = false) {
  const currentStockState = stockState(product);
  const image = `<img class="catalog-thumb${inventory ? ' inventory-thumb' : ''}" src="${safeImageUrl(product.imageUrl, product.name)}" alt="${escapeHtml(product.name)}">`;
  if (inventory) {
    return `<article class="inventory-card product-card-with-image">${image}<div class="product-card-body"><div class="card-head"><div><h4>${escapeHtml(product.name)}</h4><p>${escapeHtml(product.unit || '')} · ${escapeHtml(product.category || '')}</p></div><span class="stock-chip ${currentStockState}">${currentStockState === 'ok' ? 'In stock' : currentStockState === 'low' ? 'Low stock' : 'Out of stock'}</span></div><div class="inventory-controls"><button data-stock="-1" data-id="${product.id}">−</button><strong>${Number(product.stockQuantity || 0)}</strong><button data-stock="1" data-id="${product.id}">+</button><span>${money(product.sellingPrice)}</span></div><div class="card-actions"><button data-edit-product="${product.id}">Edit product</button></div></div></article>`;
  }
  return `<article class="product-card product-card-with-image">${image}<div class="product-card-body"><div class="card-head"><div><h4>${escapeHtml(product.name)}</h4><p>${escapeHtml(product.brand || 'MyQK')} · ${escapeHtml(product.unit || '')}</p></div><div><div class="price">${money(product.sellingPrice)}</div><span class="stock-chip ${currentStockState}">${Number(product.stockQuantity || 0)} left</span></div></div><div class="card-actions"><button data-edit-product="${product.id}">Edit</button><button data-toggle-product="${product.id}" class="${product.isActive === false ? 'danger' : ''}">${product.isActive === false ? 'Activate' : 'Disable'}</button></div></div></article>`;
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

function statusLabel(status) {
  return ({
    pending_merchant: 'New order',
    merchant_accepted: 'Accepted',
    preparing: 'Preparing',
    ready_for_pickup: 'Ready for pickup',
    accepted: 'Rider assigned',
    picked_up: 'Picked up',
    completed: 'Completed',
    merchant_rejected: 'Rejected',
    cancelled: 'Cancelled'
  })[status] || status;
}

function orderCard(order) {
  return `<article class="order-card" data-order="${order.id}"><div class="card-head"><div><h4>Order #${escapeHtml(order.orderNumber || order.id.slice(0, 6))}</h4><p>${escapeHtml(order.customerName || 'Customer')} · ${order.itemCount || order.items?.length || 0} items</p></div><span class="order-status">${escapeHtml(statusLabel(order.status))}</span></div><div class="order-meta"><span>${escapeHtml(order.paymentMode || 'Cash on Delivery')}</span><strong>${money(order.totalAmount)}</strong></div></article>`;
}

function renderOrders() {
  const list = state.orderFilter === 'all' ? state.orders : state.orders.filter((order) => order.status === state.orderFilter);
  $('#orders-list').innerHTML = list.length ? list.map(orderCard).join('') : '<div class="empty-state">No orders in this section.</div>';
}

function renderRecentOrders() {
  const list = state.orders.slice(0, 3);
  $('#recent-orders').innerHTML = list.length ? list.map(orderCard).join('') : 'No merchant orders yet.';
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
  $('#product-image-status').textContent = product.imageUrl ? 'Current photo. Choose another photo only to replace it.' : 'This product has no photo. Add one before saving.';
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
  if (sellingPrice > mrp) return toast('Selling price cannot be higher than MRP.', true);
  if (!id && !imageFile) return toast('Add a product photo.', true);
  if (id && !existing?.imageUrl && !imageFile) return toast('Add a product photo.', true);

  const submitButton = $('#product-form button[type="submit"]');
  setButtonBusy(submitButton, true, 'Saving…', 'Save product');
  try {
    const uploaded = await uploadImage(imageFile, {
      folder: `myqk/stores/${state.storeId}/products/${productReference.id}`,
      kind: 'product',
      statusElement: $('#product-image-status')
    });
    const stockQuantity = Number($('#product-stock').value);
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
      lowStockThreshold: Number($('#product-threshold').value),
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
    toast(id ? 'Product updated on merchant and customer pages.' : 'Product added to inventory and customer app.');
  } catch (error) {
    console.error(error);
    toast(error.message || 'Product save failed.', true);
  } finally {
    setButtonBusy(submitButton, false, 'Saving…', 'Save product');
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
  } catch {
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
      transaction.update(reference, { stockQuantity: after, isAvailable: after > 0, updatedAt: serverTimestamp() });
      const movement = doc(collection(db, 'stores', state.storeId, 'stockMovements'));
      transaction.set(movement, {
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
  const items = (order.items || []).map((item) => `<div class="order-item-row"><span>${item.quantity || 1} × ${escapeHtml(item.name)}</span><strong>${money(item.lineTotal || Number(item.unitPrice || 0) * Number(item.quantity || 1))}</strong></div>`).join('');
  let actions = '';
  if (order.status === 'pending_merchant') actions = `<div class="card-actions"><button data-order-action="merchant_rejected" data-id="${id}">Reject</button><button class="primary-action" data-order-action="merchant_accepted" data-id="${id}">Accept order</button></div>`;
  if (order.status === 'merchant_accepted') actions = `<div class="card-actions"><button class="primary-action" data-order-action="preparing" data-id="${id}">Start preparing</button></div>`;
  if (order.status === 'preparing') actions = `<div class="card-actions"><button class="primary-action" data-order-action="ready_for_pickup" data-id="${id}">Mark ready for pickup</button></div>`;
  $('#order-detail-content').innerHTML = `<p><strong>${escapeHtml(order.customerName || 'Customer')}</strong><br>${escapeHtml(order.drop?.address || order.dropAddress || '')}</p><div class="order-items">${items || 'No item details'}</div><div class="order-meta"><span>${escapeHtml(statusLabel(order.status))}</span><strong>${money(order.totalAmount)}</strong></div>${actions}`;
  openModal('order-modal');
}

async function orderAction(id, next) {
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
      if (next === 'merchant_accepted') update.merchantAcceptedAt = serverTimestamp();
      if (next === 'merchant_rejected') update.merchantRejectedAt = serverTimestamp();
      if (next === 'preparing') update.preparingAt = serverTimestamp();
      if (next === 'ready_for_pickup') update.readyAt = serverTimestamp();
      transaction.update(reference, update);
    });
    closeModal('order-modal');
    toast(`Order marked ${statusLabel(next)}.`);
  } catch (error) {
    console.error(error);
    toast('Order status update failed.', true);
  }
}

function switchView(name) {
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === `${name}-view`));
  $$('.nav-btn').forEach((button) => button.classList.toggle('active', button.dataset.view === name));
  $('#main-content').scrollTop = 0;
}

function openAddProduct() {
  resetProductForm();
  openModal('product-modal');
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

$('#google-login-btn').addEventListener('click', login);
$('#logout-btn').addEventListener('click', logout);
$('#onboarding-logout-btn').addEventListener('click', logout);
$('#business-form').addEventListener('submit', createBusiness);
$('#location-btn').addEventListener('click', requestLocation);
$('#manual-address-btn').addEventListener('click', () => openManualAddress(true));
$('#shop-address').addEventListener('input', () => {
  if ($('#shop-address').dataset.source === 'detected') {
    state.resolvedAddress = null;
  }
  $('#shop-address').dataset.source = 'manual';
  $('#location-status').textContent = state.location
    ? 'Location pin saved. The address was edited manually.'
    : 'Manual shop address added.';
});
$('#shop-toggle').addEventListener('click', toggleShop);
$('#save-store-image-btn').addEventListener('click', saveStoreImage);
$('#add-product-btn').addEventListener('click', openAddProduct);
$('#add-inventory-product-btn').addEventListener('click', openAddProduct);
$('#home-add-product-btn').addEventListener('click', openAddProduct);
$('#product-form').addEventListener('submit', saveProduct);
$('#product-search').addEventListener('input', (event) => { state.productFilter = event.target.value; renderProducts(); });
$('#shop-image').addEventListener('change', () => previewSelectedFile(
  $('#shop-image'),
  $('#shop-image-preview'),
  $('#shop-image-status'),
  'Required. JPG, PNG or WebP; compressed automatically.'
));
$('#product-image').addEventListener('change', () => previewSelectedFile(
  $('#product-image'),
  $('#product-image-preview'),
  $('#product-image-status'),
  $('#product-id').value ? 'Choose a photo only to replace the current one.' : 'Required for a new product.'
));
$('#store-image-update').addEventListener('change', () => previewSelectedFile(
  $('#store-image-update'),
  $('#profile-store-image'),
  $('#store-image-update-status'),
  'Choose a new cover photo and save.'
));
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
$('#owner-phone').addEventListener('input', (event) => { event.target.value = event.target.value.replace(/\D/g, '').slice(0, 10); });

document.addEventListener('error', (event) => {
  if (!(event.target instanceof HTMLImageElement)) return;
  const image = event.target;
  if (image.dataset.fallbackApplied) return;
  image.dataset.fallbackApplied = 'true';
  image.src = placeholderImage(image.alt || 'QK');
}, true);

onAuthStateChanged(auth, async (user) => {
  state.user = user;
  if (!user) {
    showScreen('login-screen');
    return;
  }
  showScreen('loading-screen');
  try {
    const ready = await loadMerchant();
    if (!ready) {
      hydrateOnboarding();
      showScreen('onboarding-screen');
      return;
    }
    hydrateApp();
    startRealtime();
    showScreen('app-screen');
  } catch (error) {
    console.error(error);
    toast('Merchant data could not load. Check Firestore rules.', true);
    showScreen('login-screen');
  }
});
