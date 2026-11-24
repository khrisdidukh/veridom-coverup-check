// Saves a hold point to Firestore. Only text findings and photo fingerprints
// (SHA-256) are stored. The photos themselves never leave this computer
// through this path, so the record can later prove which photo was checked.

import { addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { firebase, ensureSignedIn } from './firebase';
import type { PhotoVerdict, Where } from './inference';

export interface HoldPointPhoto {
  caption: string;
  sha256: string;
  verdict: PhotoVerdict;
  checkedWhere: Where;
  secondOpinion?: PhotoVerdict;
}

export interface HoldPoint {
  stageId: string;
  jurisdiction: string;
  decision: 'hold' | 'clear' | 'incomplete';
  photos: HoldPointPhoto[];
  note?: string;
  noteLanguage?: string;
}

export async function saveHoldPoint(hp: HoldPoint): Promise<string> {
  const h = firebase();
  if (!h) throw new Error('Firebase is not configured');
  const uid = await ensureSignedIn();
  const ref = await addDoc(collection(h.db, 'holdPoints'), { ...hp, uid, createdAt: serverTimestamp() });
  return ref.id;
}
