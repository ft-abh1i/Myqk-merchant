import { firebaseConfig } from './firebase-config.js';
import { getApps, initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import { doc, getDoc, getFirestore, serverTimestamp, updateDoc } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';

const app = getApps()[0] || initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

onAuthStateChanged(auth, async user => {
  if (!user) return;
  try {
    const merchantSnap = await getDoc(doc(db, 'merchants', user.uid));
    if (!merchantSnap.exists() || !merchantSnap.data().storeId) return;
    const storeId = merchantSnap.data().storeId;
    await Promise.all([
      updateDoc(doc(db, 'merchants', user.uid), { accountStatus: 'active', updatedAt: serverTimestamp() }),
      updateDoc(doc(db, 'stores', storeId), { isApproved: true, status: 'active', updatedAt: serverTimestamp() })
    ]);
  } catch (error) {
    console.warn('Merchant auto approval will retry on next login:', error);
  }
});