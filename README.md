# BuyQK Merchant

Mobile-first merchant MVP for the BuyQK local commerce platform.

## Working flows

- Direct dashboard startup with Firebase Anonymous Authentication running in the background
- First-time store setup inside the dashboard's Store tab
- GPS or verified manual pickup location
- Compressed Cloudinary store and product images
- Realtime products, inventory and merchant order queue
- Transaction-safe stock adjustments and stock movement audit records
- Secure order flow: `pending_merchant` → `merchant_accepted` → `preparing` → `ready_for_pickup`
- Automatic reserved-stock restoration after eligible cancellations
- Live completed-order sales totals
- Customer-facing store settings and open/closed control

## Shared backend

The app uses the shared Firebase project configured in `firebase-config.js` and preserves the collection contracts used by `Myqk-demo` and `Myqk-rider`:

- `merchants/{merchantId}`
- `stores/{storeId}`
- `stores/{storeId}/products/{productId}`
- `stores/{storeId}/stockMovements/{movementId}`
- `orders/{orderId}`

New stores are created with `accountStatus: pending`, `isApproved: false`, and `status: pending_approval`. Approval must be performed through a trusted admin process. Merchants cannot approve themselves through the browser.

## Setup

1. Enable **Anonymous** sign-in in Firebase Authentication.
2. Add the deployed merchant domain to Firebase Authorized domains.
3. Deploy `firestore.rules` and `firestore.indexes.json` from this repository.
4. Keep only the public Cloudinary cloud name and unsigned upload preset in `cloudinary-config.js`; never commit an API secret.
5. Deploy the repository as a static site.

Anonymous merchant identity is stored in the browser's Firebase session. Clearing site data or opening the app on another browser/device creates a new merchant identity.
