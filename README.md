# Veridom Cover-Up Check

Check building work before it disappears. Waterproofing, reinforcement, insulation and pipes are covered for good within days, and most costly defects in a private house start there. Cover-Up Check lets a homebuilder photograph each stage before it is covered: **Gemini Nano checks every photo on the builder's own computer**, privately and at no cost per use, and **Gemini in the cloud is asked only when the on-device model is unsure** and the builder allows it.

It is a new module of [Veridom](https://veridom.space), a house-building control app for private homebuilders in Austria, Ukraine and California.

Built for **#BuildHybridAI 2026** with Firebase AI Logic hybrid inference.

## Why hybrid

| Task | Where it runs | Why |
| --- | --- | --- |
| Check a site photo against the stage checklist | Gemini Nano, on device (`PREFER_ON_DEVICE`, or `ONLY_ON_DEVICE` when "Keep photos on this computer" is on) | Photos of a private home stay private; works with no signal on site; free per use |
| Second opinion on an unsure photo | Gemini in the cloud (`ONLY_IN_CLOUD`) | Larger model, used only for low confidence, a wrong stage, or mostly unseen items, and never when photos are locked to the device |
| Read the approved plan (PDF) | Gemini in the cloud | The on-device model cannot read PDF files |
| Write the hold-point note to the contractor | Gemini Nano if it can write the chosen language, else the cloud with text findings only | German and Ukrainian notes for contractors; photos are never sent for this |

Every model call is shown in the **Where each step ran** log with the reason for its route and the actual `inferenceSource` Firebase reports. With no signal, cloud tasks wait in a queue and run when the connection returns.

The routing rules are plain functions in [`src/policy.ts`](src/policy.ts), covered by tests in [`test/policy.test.ts`](test/policy.test.ts).

## Firebase products used

- **Firebase AI Logic** (`firebase/ai`): hybrid inference with `InferenceMode`, `onDeviceParams` (image input, JSON `responseConstraint`) and `inCloudParams` (response schema). See [`src/inference.ts`](src/inference.ts).
- **App Check** with reCAPTCHA v3 (required by AI Logic).
- **Remote Config**: stage checklists per jurisdiction, cloud model names and the escalation threshold ([`remoteconfig.template.json`](remoteconfig.template.json)). Bundled defaults keep it working offline.
- **Cloud Firestore**: saved hold points hold text findings and SHA-256 fingerprints of the photos, never the photos ([`firestore.rules`](firestore.rules)).
- **Authentication**: anonymous sign-in, so each builder reads only their own hold points.

## Run it

Requirements: Chrome 139+ on desktop. For on-device inference enable `chrome://flags/#prompt-api-for-gemini-nano-multimodal-input` and restart Chrome. Without it, the app still works and Firebase falls back to the cloud (unless photos are locked to the device).

```bash
npm install
cp .env.example .env   # fill in your Firebase web config and App Check key
npm run dev
npm test               # routing policy tests
```

In the Firebase console: enable Firebase AI Logic (Gemini Developer API), App Check (reCAPTCHA v3, or a debug token for local use), Anonymous sign-in, Firestore (deploy `firestore.rules`) and Remote Config (import `remoteconfig.template.json`).

## Sample photos

The sample photos are AI-generated illustrations of construction stages, labelled as such in the app. Use your own site photos for real checks.

## Veridom principles kept here

- The app never states a norm value. Each checklist names the document to open (for example ÖNORM B 3692 for waterproofing in Austria).
- A hold point is a record: Firestore rules allow create and read by the owner, no edits.

## Built during the contest

Everything in this repository was written during the submission period (November 2026). It reuses Veridom's stage vocabulary and principles, not its code.

## License

Apache 2.0
