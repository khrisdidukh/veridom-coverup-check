// Development-only stand-in for the models, used to lay out the interface in a
// browser without Gemini Nano (`npm run dev`, then open /?mock). It is not
// included in production builds: App.tsx only imports it when import.meta.env.DEV.

import type { Stage } from './checklists';
import type { Outcome, PhotoVerdict, PlanRequirements } from './inference';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ISSUES: Record<string, Record<string, string>> = {
  'wp-corner.jpg': {
    'wp-overlaps': 'Overlap at the corner is lifted and open',
    'wp-continuous': 'Bare concrete visible behind the lifted sheet',
    'wp-footing': 'Standing water at the footing',
  },
  'rebar-ground.jpg': { 'rb-spacers': 'Mesh lies on the sheeting, no spacers visible', 'rb-tied': 'Several crossings look untied' },
  'insulation-gaps.jpg': { 'in-filled': 'Gaps around the socket box and cable', 'in-compressed': 'Insulation torn around the socket' },
  'pipes-notch.jpg': { 'sv-protected': 'Red pipe sits in a notch without a nail plate' },
};

export async function mockCheck(stage: Stage, file: string): Promise<Outcome<PhotoVerdict>> {
  await wait(900 + Math.random() * 700);
  const issues = ISSUES[file] ?? {};
  const unsure = file === 'roof-underlay.jpg';
  return {
    where: 'on_device',
    ms: 1400 + Math.random() * 900,
    value: {
      stage_matches: true,
      confidence: unsure ? 'low' : Object.keys(issues).length ? 'high' : 'medium',
      summary: Object.keys(issues).length ? 'Problems visible; do not cover yet' : 'Work looks complete for the visible area',
      items: stage.items.map((i, n) => {
        if (issues[i.id]) return { id: i.id, status: 'issue', note: issues[i.id] };
        if (unsure && n > 0) return { id: i.id, status: 'not_visible', note: 'Cannot see from this angle' };
        return { id: i.id, status: 'ok', note: 'Visible and looks right' };
      }),
    },
  };
}

export async function mockReview(stage: Stage, first: PhotoVerdict): Promise<Outcome<PhotoVerdict>> {
  await wait(1600);
  return {
    where: 'in_cloud',
    ms: 2300,
    value: {
      ...first,
      confidence: 'high',
      summary: 'Overlaps run the right way; counter battens present; no tears visible',
      items: stage.items.map((i) => ({ id: i.id, status: 'ok', note: 'Confirmed on closer look' })),
    },
  };
}

export async function mockPlan(stage: Stage): Promise<Outcome<PlanRequirements>> {
  await wait(1800);
  return {
    where: 'in_cloud',
    ms: 2600,
    value: {
      found: [{ item_id: stage.items[0].id, requirement: 'Bituminous membrane, 2 layers, up to 30 cm above ground', source: 'Detail D-04, page 7' }],
      not_in_plan: stage.items.slice(2).map((i) => i.id),
    },
  };
}

export async function mockReport(): Promise<Outcome<string>> {
  await wait(1500);
  return {
    where: 'on_device',
    ms: 1900,
    value:
      'Please do not backfill the north-east corner yet.\n\nOpen problems:\n1. Corner overlap is lifted and open. Reseal before backfill.\n2. Standing water at the footing. Drain and check the footing joint.\n\nStill needs a photo: protection board on the east wall.',
  };
}
