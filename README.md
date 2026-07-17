# MyQK Merchant

Mobile-first merchant web app for the MyQK local commerce platform.

## Included

- Firebase Google login
- Merchant and store onboarding
- Live shop open/closed control
- Product catalog management
- Inventory and stock movement tracking
- Realtime merchant order queue
- Order status flow: pending merchant → accepted → preparing → ready for pickup
- Unified Firestore rules for customer, merchant and rider apps

## Firebase setup

Use the shared Firebase project `buyqk-rider`.

1. Enable Google authentication.
2. Add the deployed merchant domain to Firebase Authorized domains.
3. Publish `firestore.rules` in Firestore Database → Rules.
4. Deploy the repository to Vercel.

## Required order shape

Customer orders must include `merchantId`, `storeId`, and begin with status `pending_merchant`. Rider apps should query `ready_for_pickup` orders rather than `pending` orders.
