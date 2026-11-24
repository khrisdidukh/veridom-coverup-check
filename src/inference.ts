import {
  getGenerativeModel,
  InferenceMode,
  InferenceSource,
  Schema,
  type GenerativeModel,
  type Part,
} from 'firebase/ai';
import { firebase, type Settings } from './firebase';
import type { Stage } from './checklists';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ItemStatus = 'ok' | 'issue' | 'not_visible';
export type Confidence = 'low' | 'medium' | 'high';

export interface PhotoVerdict {
  stage_matches: boolean;
  items: { id: string; status: ItemStatus; note: string }[];
  confidence: Confidence;
  summary: string;
}

export type Where = 'on_device' | 'in_cloud';

export interface Outcome<T> {
  value: T;
  where: Where;
  ms: number;
}

export interface PlanRequirements {
  found: { item_id: string; requirement: string; source: string }[];
  not_in_plan: string[];
}

// ---------------------------------------------------------------------------
// Device model status (Chrome Prompt API, which Firebase AI Logic drives)
// ---------------------------------------------------------------------------

type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available';
interface LanguageModelStatic {
  availability(opts?: object): Promise<Availability>;
}
const LM = (): LanguageModelStatic | undefined =>
  (globalThis as unknown as { LanguageModel?: LanguageModelStatic }).LanguageModel;

export type DeviceStatus = Availability | 'no-api';

export async function deviceStatus(): Promise<DeviceStatus> {
  const lm = LM();
  if (!lm) return 'no-api';
  try {
    return await lm.availability({
      expectedInputs: [{ type: 'text', languages: ['en'] }, { type: 'image' }],
      expectedOutputs: [{ type: 'text', languages: ['en'] }],
    });
  } catch {
    return 'unavailable';
  }
}

/** Can the on-device model write in this language? Gemini Nano supports a few output languages. */
export async function deviceCanWrite(lang: string): Promise<boolean> {
  const lm = LM();
  if (!lm) return false;
  try {
    const a = await lm.availability({
      expectedInputs: [{ type: 'text', languages: ['en'] }],
      expectedOutputs: [{ type: 'text', languages: [lang] }],
    });
    return a === 'available';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Schemas: JSON Schema for Gemini Nano (responseConstraint), Firebase Schema for the cloud.
// ---------------------------------------------------------------------------

function verdictJsonSchema(itemIds: string[]) {
  return {
    type: 'object',
    properties: {
      stage_matches: { type: 'boolean' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', enum: itemIds },
            status: { type: 'string', enum: ['ok', 'issue', 'not_visible'] },
            note: { type: 'string' },
          },
          required: ['id', 'status', 'note'],
        },
      },
      confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
      summary: { type: 'string' },
    },
    required: ['stage_matches', 'items', 'confidence', 'summary'],
  };
}

function verdictCloudSchema(itemIds: string[]) {
  return Schema.object({
    properties: {
      stage_matches: Schema.boolean(),
      items: Schema.array({
        items: Schema.object({
          properties: {
            id: Schema.enumString({ enum: itemIds }),
            status: Schema.enumString({ enum: ['ok', 'issue', 'not_visible'] }),
            note: Schema.string(),
          },
        }),
      }),
      confidence: Schema.enumString({ enum: ['low', 'medium', 'high'] }),
      summary: Schema.string(),
    },
  });
}

const planCloudSchema = Schema.object({
  properties: {
    found: Schema.array({
      items: Schema.object({
        properties: {
          item_id: Schema.string(),
          requirement: Schema.string(),
          source: Schema.string(),
        },
      }),
    }),
    not_in_plan: Schema.array({ items: Schema.string() }),
  },
});

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function photoPrompt(stage: Stage, plan?: PlanRequirements): string {
  const lines = stage.items.map((i) => `- ${i.id}: ${i.check}`).join('\n');
  const planLines = plan?.found.length
    ? `\nThe approved plan for this house says:\n${plan.found.map((f) => `- ${f.item_id}: ${f.requirement}`).join('\n')}\n`
    : '';
  return `You are checking a building-site photo before the work is covered by ${stage.coveredBy}.
Stage: ${stage.name}.
Checklist:
${lines}
${planLines}
For each checklist id, answer:
- "ok" if the photo clearly shows the item done correctly,
- "issue" if the photo shows a problem (describe it in the note),
- "not_visible" if the photo does not show enough to judge.
Only judge what is visible. Do not guess measurements.
Set stage_matches to false if the photo shows a different kind of work.
Set confidence to how sure you are overall. Keep each note under 20 words and the summary under 30 words.`;
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

function deviceFirstModel(settings: Settings, stage: Stage, localOnly: boolean): GenerativeModel {
  const h = firebase();
  if (!h) throw new Error('Firebase is not configured');
  const ids = stage.items.map((i) => i.id);
  return getGenerativeModel(h.ai, {
    mode: localOnly ? InferenceMode.ONLY_ON_DEVICE : InferenceMode.PREFER_ON_DEVICE,
    onDeviceParams: {
      createOptions: {
        expectedInputs: [{ type: 'text', languages: ['en'] }, { type: 'image' }],
        expectedOutputs: [{ type: 'text', languages: ['en'] }],
      },
      promptOptions: { responseConstraint: verdictJsonSchema(ids) },
    },
    inCloudParams: {
      model: settings.deviceModelCloudFallback,
      generationConfig: { responseMimeType: 'application/json', responseSchema: verdictCloudSchema(ids) },
    },
  });
}

function cloudReviewer(settings: Settings, stage: Stage): GenerativeModel {
  const h = firebase();
  if (!h) throw new Error('Firebase is not configured');
  return getGenerativeModel(h.ai, {
    mode: InferenceMode.ONLY_IN_CLOUD,
    inCloudParams: {
      model: settings.reviewModel,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: verdictCloudSchema(stage.items.map((i) => i.id)),
      },
    },
  });
}

/** Start the Gemini Nano download from a user gesture, as Chrome requires. */
export async function warmUpDeviceModel(settings: Settings, stage: Stage, onProgress: (p: number) => void) {
  const m = deviceFirstModel(settings, stage, false);
  await m.initializeDeviceModel(onProgress);
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

const whereOf = (src: InferenceSource | undefined): Where =>
  src === InferenceSource.ON_DEVICE ? 'on_device' : 'in_cloud';

function parseJson<T>(text: string): T {
  const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  return JSON.parse(cleaned) as T;
}

function normaliseVerdict(v: PhotoVerdict, stage: Stage): PhotoVerdict {
  // Make sure every checklist item has exactly one answer, in checklist order.
  const byId = new Map(v.items?.map((i) => [i.id, i]) ?? []);
  return {
    stage_matches: Boolean(v.stage_matches),
    confidence: (['low', 'medium', 'high'] as Confidence[]).includes(v.confidence) ? v.confidence : 'low',
    summary: v.summary ?? '',
    items: stage.items.map(
      (i) => byId.get(i.id) ?? { id: i.id, status: 'not_visible' as ItemStatus, note: 'Not assessed' },
    ),
  };
}

export async function checkPhoto(
  settings: Settings,
  stage: Stage,
  image: { base64: string; mimeType: 'image/jpeg' },
  opts: { localOnly: boolean; plan?: PlanRequirements },
): Promise<Outcome<PhotoVerdict>> {
  const model = deviceFirstModel(settings, stage, opts.localOnly);
  const parts: Part[] = [{ type: 'text', text: photoPrompt(stage, opts.plan) }, { type: 'inlineData', inlineData: { data: image.base64, mimeType: image.mimeType } }];
  const t0 = performance.now();
  const res = await model.generateContent({ contents: [{ role: 'user', parts }] });
  const ms = performance.now() - t0;
  return {
    value: normaliseVerdict(parseJson<PhotoVerdict>(res.response.text()), stage),
    where: whereOf(res.response.inferenceSource),
    ms,
  };
}

export async function secondOpinion(
  settings: Settings,
  stage: Stage,
  image: { base64: string; mimeType: 'image/jpeg' },
  first: PhotoVerdict,
  plan?: PlanRequirements,
): Promise<Outcome<PhotoVerdict>> {
  const model = cloudReviewer(settings, stage);
  const prompt = `${photoPrompt(stage, plan)}

A smaller on-device model already looked at this photo and was not sure. Its answer:
${JSON.stringify(first.items)}
Check each item yourself. Where you disagree, say why in the note.`;
  const t0 = performance.now();
  const res = await model.generateContent([prompt, { type: 'inlineData', inlineData: { data: image.base64, mimeType: image.mimeType } }]);
  return { value: normaliseVerdict(parseJson<PhotoVerdict>(res.response.text()), stage), where: 'in_cloud', ms: performance.now() - t0 };
}

export async function readPlan(
  settings: Settings,
  stage: Stage,
  pdf: { base64: string },
): Promise<Outcome<PlanRequirements>> {
  // PDF input is not supported by the on-device model, so this task always runs in the cloud.
  const h = firebase();
  if (!h) throw new Error('Firebase is not configured');
  const model = getGenerativeModel(h.ai, {
    mode: InferenceMode.ONLY_IN_CLOUD,
    inCloudParams: {
      model: settings.reviewModel,
      generationConfig: { responseMimeType: 'application/json', responseSchema: planCloudSchema },
    },
  });
  const prompt = `This is the approved plan or specification for a private house.
For the stage "${stage.name}", find what the plan requires for each of these checklist items:
${stage.items.map((i) => `- ${i.id}: ${i.check}`).join('\n')}
Quote the requirement as written (material, layer, thickness, product) and where it is in the document (page, drawing number, detail).
Only report what the document actually says. List item ids the document does not cover in not_in_plan.`;
  const t0 = performance.now();
  const res = await model.generateContent([prompt, { type: 'inlineData', inlineData: { data: pdf.base64, mimeType: 'application/pdf' } }]);
  return { value: parseJson<PlanRequirements>(res.response.text()), where: 'in_cloud', ms: performance.now() - t0 };
}

export const REPORT_LANGUAGES: Record<string, string> = { en: 'English', de: 'German', uk: 'Ukrainian' };

export async function writeReport(
  settings: Settings,
  findingsText: string,
  lang: string,
  route: 'device_first' | 'cloud',
): Promise<Outcome<string>> {
  const h = firebase();
  if (!h) throw new Error('Firebase is not configured');
  const model = getGenerativeModel(h.ai, {
    mode: route === 'cloud' ? InferenceMode.ONLY_IN_CLOUD : InferenceMode.PREFER_ON_DEVICE,
    onDeviceParams: {
      createOptions: {
        expectedInputs: [{ type: 'text', languages: ['en'] }],
        expectedOutputs: [{ type: 'text', languages: [lang] }],
      },
    },
    inCloudParams: { model: settings.deviceModelCloudFallback },
  });
  const prompt = `Write a short hold-point note from a private homebuilder to their contractor, in ${REPORT_LANGUAGES[lang]}.
Plain text, no markdown. Polite and factual. Start with one sentence saying whether the work may be covered.
Then list each open problem with what must be fixed before covering. Then list what still needs a photo.
Do not invent anything that is not in the findings.

Findings:
${findingsText}`;
  const t0 = performance.now();
  const res = await model.generateContent(prompt);
  return { value: res.response.text().trim(), where: whereOf(res.response.inferenceSource), ms: performance.now() - t0 };
}
