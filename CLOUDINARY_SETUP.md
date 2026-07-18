# Cloudinary image setup (free MVP)

MyQK keeps authentication, stores, products and orders in Firebase. Cloudinary is used only for store and product photos.

## 1. Create the free account

Create a Cloudinary account and open the dashboard. Copy the **Cloud name** shown in the Product Environment Credentials section.

Do not copy the API secret into the merchant app. The app never needs it.

## 2. Create an unsigned upload preset

Open **Settings → Upload → Upload presets** and create a preset with:

- Signing mode: **Unsigned**
- Preset name: `myqk_unsigned`
- Asset folder: `myqk`
- Allowed formats: `jpg,jpeg,png,webp`
- Unique filename: enabled
- Use filename: disabled
- Disallow public ID: enabled, when the dashboard offers this setting
- Maximum input file size: 8 MB, when the dashboard offers this setting

The browser also validates and compresses every selected photo before upload.

## 3. Add the two public values

Edit `cloudinary-config.js`:

```js
export const cloudinaryConfig = Object.freeze({
  cloudName: 'your-cloud-name',
  uploadPreset: 'myqk_unsigned'
});
```

These two values are safe to expose in a browser app. Never add `api_secret`.

## 4. Publish Firestore rules

Copy `firestore.rules` into **Firebase Console → Firestore Database → Rules** and publish it. The updated rules allow merchants to save `imageUrl` and `imagePublicId` on their own store.

## 5. Test

1. Open MyQK Merchant.
2. Create a store and select a cover photo.
3. Add a product and select one product photo.
4. Open Myqk-demo.
5. Confirm that the store and product photos appear.

## MVP limits built into the app

- Accepted input: JPG, PNG and WebP
- Maximum selected file: 8 MB
- Store output target: 1200 × 800, approximately 300 KB or less
- Product output target: 800 × 800, approximately 180 KB or less
- One current cover photo per store
- One current main photo per product

## Security note

Unsigned uploads are suitable for a controlled zero-budget MVP, but the upload preset is visible in frontend code. Restrict the preset carefully and monitor Cloudinary usage. Once the app has revenue, replace unsigned uploads with signed uploads through a serverless function.
