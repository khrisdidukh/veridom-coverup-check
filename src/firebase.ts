import { initializeApp, type FirebaseApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaV3Provider } from 'firebase/app-check';
import { getAI, GoogleAIBackend, type AI } from 'firebase/ai';
import { getRemoteConfig, fetchAndActivate, getValue, type RemoteConfig } from 'firebase/remote-config';
import { getAuth, signInAnonymously, type Auth } from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';
import { DEFAULT_STAGES, parseStages, type Stage } from './checklists';

// Web config is public by design (it identifies the project, it is not a secret).
// Access to Gemini is protected by App Check, which Firebase AI Logic enforces.
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FB_API_KEY,
  authDomain: import.meta.env.VITE_FB_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FB_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FB_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FB_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FB_APP_ID,
};

export const firebaseConfigured = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);

export interface Settings {
  stages: Stage[];
  deviceModelCloudFallback: string; // cloud model used when the device model is missing
  reviewModel: string; // cloud model for second opinions and plan reading
  escalateBelow: 'low' | 'medium'; // device confidence that triggers a second opinion
}

const DEFAULTS: Settings = {
  stages: DEFAULT_STAGES,
  deviceModelCloudFallback: 'gemini-3.5-flash-lite',
  reviewModel: 'gemini-3.5-flash',
  escalateBelow: 'low',
};

export interface FirebaseHandles {
  app: FirebaseApp;
  ai: AI;
  auth: Auth;
  db: Firestore;
  rc: RemoteConfig;
}

let handles: FirebaseHandles | null = null;

export function firebase(): FirebaseHandles | null {
  if (!firebaseConfigured) return null;
  if (handles) return handles;
  const app = initializeApp(firebaseConfig);

  // App Check: reCAPTCHA v3 on the hosted site; a debug token in local development.
  const debugToken = import.meta.env.VITE_APPCHECK_DEBUG_TOKEN;
  if (debugToken) (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN: string }).FIREBASE_APPCHECK_DEBUG_TOKEN = debugToken;
  const siteKey = import.meta.env.VITE_RECAPTCHA_SITE_KEY;
  if (siteKey || debugToken) {
    initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(siteKey || 'debug'),
      isTokenAutoRefreshEnabled: true,
    });
  }

  const ai = getAI(app, { backend: new GoogleAIBackend() });
  const rc = getRemoteConfig(app);
  rc.settings.minimumFetchIntervalMillis = 60 * 60 * 1000;
  rc.defaultConfig = {
    checklists_v1: JSON.stringify(DEFAULTS.stages),
    device_cloud_fallback_model: DEFAULTS.deviceModelCloudFallback,
    review_model: DEFAULTS.reviewModel,
    escalate_below: DEFAULTS.escalateBelow,
  };
  handles = { app, ai, rc, auth: getAuth(app), db: getFirestore(app) };
  return handles;
}

export async function loadSettings(): Promise<{ settings: Settings; source: 'remote' | 'bundled' }> {
  const h = firebase();
  if (!h) return { settings: DEFAULTS, source: 'bundled' };
  let source: 'remote' | 'bundled' = 'bundled';
  try {
    await fetchAndActivate(h.rc);
    source = getValue(h.rc, 'checklists_v1').getSource() === 'remote' ? 'remote' : 'bundled';
  } catch {
    // Offline on site: Remote Config keeps the last activated values or the defaults.
  }
  const esc = getValue(h.rc, 'escalate_below').asString();
  return {
    source,
    settings: {
      stages: parseStages(getValue(h.rc, 'checklists_v1').asString()),
      deviceModelCloudFallback: getValue(h.rc, 'device_cloud_fallback_model').asString() || DEFAULTS.deviceModelCloudFallback,
      reviewModel: getValue(h.rc, 'review_model').asString() || DEFAULTS.reviewModel,
      escalateBelow: esc === 'medium' ? 'medium' : 'low',
    },
  };
}

export async function ensureSignedIn(): Promise<string | null> {
  const h = firebase();
  if (!h) return null;
  if (h.auth.currentUser) return h.auth.currentUser.uid;
  const cred = await signInAnonymously(h.auth);
  return cred.user.uid;
}
