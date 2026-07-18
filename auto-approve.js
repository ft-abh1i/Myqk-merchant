import { firebaseConfig } from './firebase-config.js';
import { getApps, initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import {
  doc,
  getDoc,
  getFirestore,
  runTransaction,
  serverTimestamp,
  updateDoc
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';

const app = getApps()[0] || initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

function showToast(message, error = false) {
  const element = document.querySelector('#toast');
  if (!element) return;
  element.textContent = message;
  element.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { element.className = 'toast'; }, 3600);
}

function closeOrderModal() {
  const modal = document.querySelector('#order-modal');
  modal?.classList.remove('open');
  modal?.setAttribute('aria-hidden', 'true');
}

function renameDispatchButtons(root = document) {
  root.querySelectorAll?.('[data-order-action="merchant_accepted"]').forEach((button) => {
    button.textContent = 'Accept & request rider';
    button.setAttribute('aria-label', 'Accept order and send delivery request to nearby riders');
  });
}

async function moveOrderOneStep(orderRef, merchantId, storeId) {
  return runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(orderRef);
    if (!snapshot.exists()) throw new Error('ORDER_NOT_FOUND');

    const order = snapshot.data();
    if (order.merchantId !== merchantId || order.storeId !== storeId) {
      throw new Error('ORDER_ACCESS_DENIED');
    }

    if (order.status === 'ready_for_pickup' || order.status === 'accepted') {
      return order.status;
    }

    const nextStatus = {
      pending_merchant: 'merchant_accepted',
      merchant_accepted: 'preparing',
      preparing: 'ready_for_pickup'
    }[order.status];

    if (!nextStatus) throw new Error(`ORDER_STATUS_${order.status || 'UNKNOWN'}`);

    const patch = {
      status: nextStatus,
      updatedAt: serverTimestamp()
    };
    if (nextStatus === 'merchant_accepted') patch.merchantAcceptedAt = serverTimestamp();
    if (nextStatus === 'preparing') patch.preparingAt = serverTimestamp();
    if (nextStatus === 'ready_for_pickup') patch.readyAt = serverTimestamp();

    transaction.update(orderRef, patch);
    return nextStatus;
  });
}

async function dispatchOrderToRider(orderId) {
  const user = auth.currentUser;
  if (!user) throw new Error('MERCHANT_NOT_SIGNED_IN');

  const merchantSnapshot = await getDoc(doc(db, 'merchants', user.uid));
  const storeId = merchantSnapshot.data()?.storeId;
  if (!merchantSnapshot.exists() || !storeId) throw new Error('MERCHANT_STORE_NOT_FOUND');

  const orderRef = doc(db, 'orders', orderId);
  let status = '';

  // Firestore rules validate pending → accepted → preparing → ready as
  // individual merchant transitions, so keep each step retry-safe and atomic.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    status = await moveOrderOneStep(orderRef, user.uid, storeId);
    if (status === 'ready_for_pickup' || status === 'accepted') break;
  }

  if (status !== 'ready_for_pickup' && status !== 'accepted') {
    throw new Error('RIDER_DISPATCH_INCOMPLETE');
  }
}

// app.js owns generic document-level order actions. Capture only merchant
// acceptance first so one tap completes the existing three-step MVP pipeline
// and makes the order visible to the rider realtime listener immediately.
document.addEventListener('click', async (event) => {
  const button = event.target.closest?.('[data-order-action="merchant_accepted"]');
  if (!button) return;

  event.preventDefault();
  event.stopImmediatePropagation();

  const orderId = button.dataset.id;
  if (!orderId || button.disabled) return;

  const normalText = 'Accept & request rider';
  button.disabled = true;
  button.textContent = 'Requesting rider…';
  showToast('Order accept ho raha hai aur nearby rider search start ho rahi hai…');

  try {
    await dispatchOrderToRider(orderId);
    closeOrderModal();
    showToast('Order accepted. Delivery request nearby riders ko bhej di gayi.');
  } catch (error) {
    console.error('Merchant rider dispatch failed:', error);
    showToast(
      error?.code === 'permission-denied'
        ? 'Rider request permission denied. Latest Firestore rules publish karo.'
        : 'Order accept hua nahi ya rider request complete nahi hui. Dobara try karo.',
      true
    );
    button.disabled = false;
    button.textContent = normalText;
  }
}, true);

const buttonObserver = new MutationObserver((records) => {
  records.forEach((record) => record.addedNodes.forEach((node) => {
    if (node.nodeType === Node.ELEMENT_NODE) renameDispatchButtons(node);
  }));
});
buttonObserver.observe(document.documentElement, { childList: true, subtree: true });
renameDispatchButtons();

onAuthStateChanged(auth, async (user) => {
  if (!user) return;
  try {
    const merchantSnapshot = await getDoc(doc(db, 'merchants', user.uid));
    if (!merchantSnapshot.exists() || !merchantSnapshot.data().storeId) return;
    const storeId = merchantSnapshot.data().storeId;
    await Promise.all([
      updateDoc(doc(db, 'merchants', user.uid), { accountStatus: 'active', updatedAt: serverTimestamp() }),
      updateDoc(doc(db, 'stores', storeId), { isApproved: true, status: 'active', updatedAt: serverTimestamp() })
    ]);
  } catch (error) {
    console.warn('Merchant auto approval will retry on next login:', error);
  }
});
