// Routing policy: decides, for each task, whether it runs on this computer,
// in the cloud, waits for a connection, or is refused. Pure functions, so the
// rules are easy to read and test. Every decision carries a reason that the
// app shows to the builder in the routing log.

import type { Confidence, DeviceStatus, PhotoVerdict } from './inference';

export interface RouteContext {
  localOnly: boolean; // "Keep photos on this computer"
  online: boolean;
  device: DeviceStatus;
}

export type Route = 'device_only' | 'device_first' | 'cloud' | 'queue' | 'blocked';

export interface Decision {
  route: Route;
  reason: string;
}

const deviceReady = (d: DeviceStatus) => d === 'available';

export function decidePhotoCheck(ctx: RouteContext): Decision {
  if (ctx.localOnly) {
    if (deviceReady(ctx.device) || ctx.device === 'downloadable' || ctx.device === 'downloading')
      return { route: 'device_only', reason: 'Photos stay on this computer, so only Gemini Nano may look at them' };
    return { route: 'blocked', reason: 'Photos stay on this computer, and Gemini Nano is not available in this browser' };
  }
  if (deviceReady(ctx.device))
    return { route: 'device_first', reason: 'Gemini Nano is ready: private, free, works without signal' };
  if (!ctx.online) return { route: 'queue', reason: 'No signal and no on-device model: check later' };
  return { route: 'device_first', reason: 'Gemini Nano is not ready here, so Firebase falls back to Gemini in the cloud' };
}

const rank: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

/** Should a photo get a second opinion from the larger cloud model? */
export function needsSecondOpinion(v: PhotoVerdict, escalateBelow: Confidence): string | null {
  if (!v.stage_matches) return 'the photo may show a different stage';
  if (rank[v.confidence] <= rank[escalateBelow]) return `on-device confidence is ${v.confidence}`;
  const unseen = v.items.filter((i) => i.status === 'not_visible').length;
  if (unseen >= Math.ceil(v.items.length / 2)) return `${unseen} of ${v.items.length} checks could not be judged`;
  return null;
}

export function decideSecondOpinion(ctx: RouteContext, why: string): Decision {
  if (ctx.localOnly)
    return { route: 'blocked', reason: `Second opinion suggested (${why}), but photos are set to stay on this computer` };
  if (!ctx.online) return { route: 'queue', reason: `Second opinion suggested (${why}); waiting for signal` };
  return { route: 'cloud', reason: `Second opinion from the larger cloud model: ${why}` };
}

export function decidePlanRead(ctx: RouteContext): Decision {
  // The on-device model does not read PDF files. The plan is a document, not a photo
  // of the house, so it is allowed even when photos are kept local.
  if (!ctx.online) return { route: 'queue', reason: 'Reading a PDF plan needs the cloud model; waiting for signal' };
  return { route: 'cloud', reason: 'Gemini Nano cannot read PDF files, so the plan goes to the cloud model' };
}

export function decideReport(ctx: RouteContext, lang: string, deviceWritesLang: boolean): Decision {
  // Only text findings are sent, never photos, so the photo lock does not apply.
  if (deviceReady(ctx.device) && deviceWritesLang)
    return { route: 'device_first', reason: `Gemini Nano writes ${lang.toUpperCase()} on this computer` };
  if (!ctx.online) return { route: 'queue', reason: `Gemini Nano cannot write ${lang.toUpperCase()} here; waiting for signal` };
  return {
    route: 'cloud',
    reason: deviceReady(ctx.device)
      ? `Gemini Nano cannot write ${lang.toUpperCase()}, so the text findings (no photos) go to the cloud`
      : 'Gemini Nano is not ready here, so the text findings (no photos) go to the cloud',
  };
}
