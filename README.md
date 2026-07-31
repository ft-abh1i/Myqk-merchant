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
3. Deploy rules and indexes with `firebase deploy --only firestore`.
4. Approve new stores from a trusted Admin SDK service or Firebase Console by
   setting the merchant `accountStatus` to `active`, then the store
   `isApproved` to `true` and `status` to `active`.
5. Deploy the repository to Vercel.

Merchants cannot approve their own accounts. A web admin panel must use an
`admin: true` Firebase Auth custom claim set by a trusted server.

## Required order shape

Customer orders must include `merchantId`, `storeId`, and begin with status `pending_merchant`. Rider apps should query `ready_for_pickup` orders rather than `pending` orders.
