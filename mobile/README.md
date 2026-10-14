# DRM Android app

DRM in a phone shell. It opens https://drm.harekrishnavizag.org and adds what a
web page cannot do:

- **Call** buttons ring straight from the caller's SIM.
- After every call it reads the phone's call log and tells DRM about calls to
  and from DRM's donors: calls made, donors who rang back, and missed
  call-backs. The caller's personal calls are never sent.
- It finds the recording the phone's own dialer made of each call and uploads
  it. Android does not let apps record calls themselves, so the phone's
  automatic call recording must be on. Phones that use the Google Phone app
  keep recordings private, so on those only the calls and talk time are saved.

The web side is in `client/src/lib/phone-app.ts`, and the server side is in
`server/src/routes/phoneApp.ts`. Admins see every phone on **Setup → Phones**.
A caller sets their phone up on **Calling → This phone**, which only appears
inside the app.

## Build

You need Node 20+ and Android Studio (or the Android SDK and JDK 21).

```
cd mobile
npm install
npm run apk:release   # app at android/app/build/outputs/apk/release/app-release.apk
```

## The signing key — back it up

`mobile/keystore/` holds `drm-release.jks` and its password file. It is not in
git.

**Every update must be signed with this same key.** Without it, phones refuse
to install the update over the old app. Keep a copy somewhere safe.

## Installing on a caller's phone

1. Send the APK to the phone (WhatsApp, Drive). Open it and allow "install
   unknown apps" when asked.
2. Open DRM and sign in as the caller.
3. Menu → **This phone**. Allow calls and the call log, then music and audio.
   Turn on auto-record in the phone's dialer, then let the app run in the
   background.
4. Make a short test call, then press **Find a recording**.

## What the server needs

The recordings are kept in DRM's R2 storage (the `R2_*` settings on the
server). Until R2 is set up, calls are still saved but recordings wait on
the phone. The Phones page says so when this is the case.
