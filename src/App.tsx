import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_STAGES, JURISDICTIONS, type Jurisdiction, type Stage } from './checklists';
import { firebaseConfigured, loadSettings, type Settings } from './firebase';
import {
  checkPhoto,
  deviceCanWrite,
  deviceStatus,
  readPlan,
  REPORT_LANGUAGES,
  secondOpinion,
  warmUpDeviceModel,
  writeReport,
  type DeviceStatus,
  type Outcome,
  type PhotoVerdict,
  type PlanRequirements,
  type Where,
} from './inference';
import { decidePhotoCheck, decidePlanRead, decideReport, decideSecondOpinion, needsSecondOpinion, type Decision, type Route } from './policy';
import { fileToBase64, prepareImage, SAMPLES, type PreparedImage } from './images';
import { saveHoldPoint } from './store';

const MOCK = import.meta.env.DEV && new URLSearchParams(location.search).has('mock');
const mock = MOCK ? await import('./mock') : null;

const DEFAULT_SETTINGS: Settings = {
  stages: DEFAULT_STAGES,
  deviceModelCloudFallback: 'gemini-3.5-flash-lite',
  reviewModel: 'gemini-3.5-flash',
  escalateBelow: 'low',
};

type Step = 'idle' | 'running' | 'done' | 'queued' | 'blocked' | 'error';

interface Photo {
  key: string;
  caption: string;
  sample?: string;
  img: PreparedImage;
  check: Step;
  verdict?: PhotoVerdict;
  where?: Where;
  ms?: number;
  reviewWhy?: string;
  review: Step;
  reviewVerdict?: PhotoVerdict;
  note?: string; // error or block reason
}

interface LogEntry {
  id: number;
  task: string;
  target: string;
  route: Route;
  reason: string;
  where?: Where;
  ms?: number;
  failed?: string;
}

type Pending = { kind: 'check' | 'review'; key: string } | { kind: 'plan' } | { kind: 'report' };

const ROUTE_LABEL: Record<Route, string> = {
  device_only: 'This computer only',
  device_first: 'This computer first',
  cloud: 'Cloud',
  queue: 'Waiting for signal',
  blocked: 'Not sent',
};

function decisionOf(v?: PhotoVerdict, r?: PhotoVerdict): 'hold' | 'clear' | 'incomplete' | null {
  const x = r ?? v;
  if (!x) return null;
  if (x.items.some((i) => i.status === 'issue') || !x.stage_matches) return 'hold';
  if (x.items.every((i) => i.status === 'ok')) return 'clear';
  return 'incomplete';
}

const secs = (ms?: number) => (ms ? `${(ms / 1000).toFixed(1)} s` : '');

export default function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [settingsSource, setSettingsSource] = useState<'remote' | 'bundled'>('bundled');
  const [jurisdiction, setJurisdiction] = useState<Jurisdiction>('AT');
  const [stageId, setStageId] = useState('waterproofing');
  const [localOnly, setLocalOnly] = useState(true);
  const [online, setOnline] = useState(navigator.onLine);
  const [device, setDevice] = useState<DeviceStatus>(MOCK ? 'available' : 'no-api');
  const [download, setDownload] = useState<number | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [plan, setPlan] = useState<{ name: string; step: Step; value?: PlanRequirements; error?: string; b64?: string } | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [lang, setLang] = useState('en');
  const [report, setReport] = useState<{ step: Step; text?: string; where?: Where; ms?: number; reason?: string } | null>(null);
  const [saved, setSaved] = useState<{ step: Step; id?: string; error?: string } | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const logId = useRef(0);
  const photosRef = useRef(photos);
  photosRef.current = photos;

  const stage: Stage = useMemo(
    () => settings.stages.find((s) => s.id === stageId) ?? settings.stages[0],
    [settings, stageId],
  );
  const ctx = { localOnly, online, device };

  // --- environment -------------------------------------------------------
  useEffect(() => {
    loadSettings().then(({ settings, source }) => {
      setSettings(settings);
      setSettingsSource(source);
    });
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    addEventListener('online', on);
    addEventListener('offline', off);
    return () => {
      removeEventListener('online', on);
      removeEventListener('offline', off);
    };
  }, []);

  useEffect(() => {
    if (MOCK) return;
    let alive = true;
    const poll = async () => {
      const s = await deviceStatus();
      if (alive) setDevice(s);
    };
    poll();
    const t = setInterval(poll, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const addLog = useCallback((e: Omit<LogEntry, 'id'>) => {
    const id = ++logId.current;
    setLog((l) => [{ ...e, id }, ...l]);
    return id;
  }, []);
  const finishLog = (id: number, patch: Partial<LogEntry>) =>
    setLog((l) => l.map((e) => (e.id === id ? { ...e, ...patch } : e)));

  const updatePhoto = (key: string, patch: Partial<Photo>) =>
    setPhotos((ps) => ps.map((p) => (p.key === key ? { ...p, ...patch } : p)));

  // --- photos ------------------------------------------------------------
  const resetStage = (id: string) => {
    setStageId(id);
    setPhotos([]);
    setPlan(null);
    setReport(null);
    setSaved(null);
  };

  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files)) {
      if (!/^image\/(jpeg|png|webp|heic)/.test(f.type)) continue;
      const img = await prepareImage(f);
      setPhotos((ps) => [...ps, { key: img.sha256.slice(0, 12) + ps.length, caption: f.name.replace(/\.\w+$/, ''), img, check: 'idle', review: 'idle' }]);
    }
  };

  const loadSamples = async () => {
    const list = SAMPLES[stage.id] ?? [];
    const loaded: Photo[] = [];
    for (const s of list) {
      const blob = await fetch(`${import.meta.env.BASE_URL}samples/${s.file}`).then((r) => r.blob());
      const img = await prepareImage(blob);
      loaded.push({ key: s.file, caption: s.caption, sample: s.file, img, check: 'idle', review: 'idle' });
    }
    setPhotos(loaded);
    setReport(null);
    setSaved(null);
  };

  const runReview = async (p: Photo, why: string, verdict: PhotoVerdict, userAsked = false) => {
    // userAsked: the builder pressed "send this photo" for this one photo.
    const d: Decision = decideSecondOpinion(userAsked ? { ...ctx, localOnly: false } : ctx, why);
    const id = addLog({ task: 'Second opinion', target: p.caption, route: d.route, reason: d.reason });
    if (d.route === 'blocked') return updatePhoto(p.key, { review: 'blocked', reviewWhy: why });
    if (d.route === 'queue') {
      setPending((q) => [...q, { kind: 'review', key: p.key }]);
      return updatePhoto(p.key, { review: 'queued', reviewWhy: why });
    }
    updatePhoto(p.key, { review: 'running', reviewWhy: why });
    try {
      const out: Outcome<PhotoVerdict> = mock
        ? await mock.mockReview(stage, verdict)
        : await secondOpinion(settings, stage, p.img, verdict, plan?.value);
      updatePhoto(p.key, { review: 'done', reviewVerdict: out.value });
      finishLog(id, { where: out.where, ms: out.ms });
    } catch (e) {
      updatePhoto(p.key, { review: 'error', note: String((e as Error).message ?? e) });
      finishLog(id, { failed: String((e as Error).message ?? e) });
    }
  };

  const runCheck = async (p: Photo) => {
    const d = decidePhotoCheck(ctx);
    const id = addLog({ task: 'Photo check', target: p.caption, route: d.route, reason: d.reason });
    if (d.route === 'blocked') return updatePhoto(p.key, { check: 'blocked', note: d.reason });
    if (d.route === 'queue') {
      setPending((q) => [...q, { kind: 'check', key: p.key }]);
      return updatePhoto(p.key, { check: 'queued' });
    }
    updatePhoto(p.key, { check: 'running', verdict: undefined, review: 'idle', reviewVerdict: undefined, note: undefined });
    try {
      const out = mock
        ? await mock.mockCheck(stage, p.sample ?? '')
        : await checkPhoto(settings, stage, p.img, { localOnly: d.route === 'device_only', plan: plan?.value });
      updatePhoto(p.key, { check: 'done', verdict: out.value, where: out.where, ms: out.ms });
      finishLog(id, { where: out.where, ms: out.ms });
      const why = needsSecondOpinion(out.value, settings.escalateBelow);
      if (why) await runReview({ ...p, verdict: out.value }, why, out.value);
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      updatePhoto(p.key, { check: 'error', note: msg });
      finishLog(id, { failed: msg });
    }
  };

  const checkAll = async () => {
    setReport(null);
    setSaved(null);
    for (const p of photosRef.current) await runCheck(p);
  };

  const prepareDevice = async () => {
    if (MOCK) return;
    setDownload(0);
    try {
      await warmUpDeviceModel(settings, stage, (v) => setDownload(v));
    } finally {
      setDevice(await deviceStatus());
      setDownload(null);
    }
  };

  // --- plan --------------------------------------------------------------
  const runPlan = async (b64: string, name: string) => {
    const d = decidePlanRead(ctx);
    const id = addLog({ task: 'Read plan', target: name, route: d.route, reason: d.reason });
    if (d.route === 'queue') {
      setPending((q) => [...q, { kind: 'plan' }]);
      return setPlan({ name, step: 'queued', b64 });
    }
    setPlan({ name, step: 'running', b64 });
    try {
      const out = mock ? await mock.mockPlan(stage) : await readPlan(settings, stage, { base64: b64 });
      setPlan({ name, step: 'done', value: out.value, b64 });
      finishLog(id, { where: out.where, ms: out.ms });
    } catch (e) {
      setPlan({ name, step: 'error', error: String((e as Error).message ?? e), b64 });
      finishLog(id, { failed: String((e as Error).message ?? e) });
    }
  };

  const addPlan = async (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    await runPlan(await fileToBase64(f), f.name);
  };

  // --- report ------------------------------------------------------------
  const checked = photos.filter((p) => p.verdict);
  const overall: 'hold' | 'clear' | 'incomplete' | null = !checked.length
    ? null
    : checked.some((p) => decisionOf(p.verdict, p.reviewVerdict) === 'hold')
      ? 'hold'
      : checked.length === photos.length && checked.every((p) => decisionOf(p.verdict, p.reviewVerdict) === 'clear')
        ? 'clear'
        : 'incomplete';

  const findingsText = () =>
    [
      `Stage: ${stage.name} (${JURISDICTIONS[jurisdiction]}). Will be covered by ${stage.coveredBy}.`,
      ...checked.map((p) => {
        const v = p.reviewVerdict ?? p.verdict!;
        return `Photo "${p.caption}":\n${v.items
          .map((i) => `  - ${stage.items.find((s) => s.id === i.id)?.check}: ${i.status.replace('_', ' ')}. ${i.note}`)
          .join('\n')}`;
      }),
    ].join('\n');

  const runReport = async () => {
    const can = mock ? lang === 'en' : await deviceCanWrite(lang);
    const d = decideReport(ctx, lang, can);
    const id = addLog({ task: 'Note to contractor', target: REPORT_LANGUAGES[lang], route: d.route, reason: d.reason });
    if (d.route === 'queue') {
      setPending((q) => [...q, { kind: 'report' }]);
      return setReport({ step: 'queued', reason: d.reason });
    }
    setReport({ step: 'running' });
    try {
      const out = mock
        ? await mock.mockReport()
        : await writeReport(settings, findingsText(), lang, d.route === 'cloud' ? 'cloud' : 'device_first');
      setReport({ step: 'done', text: out.value, where: mock && d.route === 'cloud' ? 'in_cloud' : out.where, ms: out.ms });
      finishLog(id, { where: mock && d.route === 'cloud' ? 'in_cloud' : out.where, ms: out.ms });
    } catch (e) {
      setReport({ step: 'error', reason: String((e as Error).message ?? e) });
      finishLog(id, { failed: String((e as Error).message ?? e) });
    }
  };

  const save = async () => {
    if (!overall) return;
    setSaved({ step: 'running' });
    try {
      const id = mock
        ? 'demo-' + Date.now().toString(36)
        : await saveHoldPoint({
            stageId: stage.id,
            jurisdiction,
            decision: overall,
            note: report?.text,
            noteLanguage: report?.text ? lang : undefined,
            photos: checked.map((p) => ({
              caption: p.caption,
              sha256: p.img.sha256,
              verdict: p.verdict!,
              checkedWhere: p.where!,
              ...(p.reviewVerdict ? { secondOpinion: p.reviewVerdict } : {}),
            })),
          });
      setSaved({ step: 'done', id });
    } catch (e) {
      setSaved({ step: 'error', error: String((e as Error).message ?? e) });
    }
  };

  // --- run what waited for signal ------------------------------------------
  useEffect(() => {
    if (!online || !pending.length) return;
    const todo = pending;
    setPending([]);
    (async () => {
      for (const t of todo) {
        if (t.kind === 'plan' && plan?.b64) await runPlan(plan.b64, plan.name);
        if (t.kind === 'report') await runReport();
        if (t.kind === 'check' || t.kind === 'review') {
          const p = photosRef.current.find((x) => x.key === t.key);
          if (!p) continue;
          if (t.kind === 'check') await runCheck(p);
          else if (p.verdict) await runReview(p, p.reviewWhy ?? 'queued', p.verdict);
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online]);

  // --- render --------------------------------------------------------------
  const deviceText: Record<DeviceStatus, string> = {
    available: 'Gemini Nano ready on this computer',
    downloadable: 'Gemini Nano can be downloaded',
    downloading: 'Gemini Nano downloading',
    unavailable: 'Gemini Nano not available on this computer',
    'no-api': 'This browser has no on-device model',
  };

  const onDeviceCount = log.filter((l) => l.where === 'on_device').length;
  const cloudCount = log.filter((l) => l.where === 'in_cloud').length;

  return (
    <div className="page">
      <header className="masthead">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span>Veridom</span>
          <span className="brand-module">Cover-Up Check</span>
        </div>
        <div className="status">
          <span className={`pill device-${device}`}>
            <span className="dot" />
            {deviceText[device]}
            {download !== null && ` ${Math.round(download * 100)}%`}
          </span>
          {(device === 'downloadable' || device === 'downloading') && download === null && (
            <button className="link" onClick={prepareDevice}>Download model</button>
          )}
          <span className={`pill ${online ? 'net-on' : 'net-off'}`}>
            <span className="dot" />
            {online ? 'Online' : 'No signal'}
          </span>
        </div>
      </header>

      <section className="lede">
        <h1>Check the work before it disappears.</h1>
        <p>
          Waterproofing, rebar, insulation and pipes get covered for good. Photograph them first. Gemini Nano checks each
          photo on this computer, privately and for free, and asks the larger cloud model only when it is unsure.
        </p>
        <div className="sentence" role="group" aria-label="What you are checking">
          <span>Checking</span>
          <select value={stage.id} onChange={(e) => resetStage(e.target.value)} aria-label="Stage">
            {settings.stages.map((s) => (
              <option key={s.id} value={s.id}>{s.name.toLowerCase()}</option>
            ))}
          </select>
          <span>in</span>
          <select value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value as Jurisdiction)} aria-label="Jurisdiction">
            {Object.entries(JURISDICTIONS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
          <span>before the {stage.coveredBy}.</span>
        </div>
      </section>

      {!firebaseConfigured && !MOCK && (
        <p className="banner">Firebase is not configured for this build. Add the web config to <code>.env</code> (see README).</p>
      )}

      <main className="layout">
        <div className="work">
          <section className="checklist" aria-labelledby="cl-h">
            <h2 id="cl-h">What must be visible</h2>
            <ol>
              {stage.items.map((i) => (
                <li key={i.id}>
                  <strong>{i.check}</strong>
                  <span>{i.why}</span>
                </li>
              ))}
            </ol>
            <p className="refs">
              Documents to open: {stage.refs[jurisdiction].join('; ')}. Veridom names the document; it never states a norm
              value for you.
              <span className="rc">Checklist from {settingsSource === 'remote' ? 'Remote Config' : 'the bundled copy'}.</span>
            </p>
          </section>

          <section className="plan" aria-labelledby="plan-h">
            <h2 id="plan-h">Approved plan</h2>
            {!plan && (
              <label className="drop small">
                <input type="file" accept="application/pdf" onChange={(e) => addPlan(e.target.files)} />
                Add the plan or specification (PDF) to check photos against what was approved
              </label>
            )}
            {plan && (
              <div className="plan-body">
                <p>
                  <strong>{plan.name}</strong>{' '}
                  {plan.step === 'running' && <span className="muted">Reading in the cloud…</span>}
                  {plan.step === 'queued' && <span className="muted">Waiting for signal</span>}
                  {plan.step === 'error' && <span className="err">{plan.error}</span>}
                </p>
                {plan.value && (
                  <ul>
                    {plan.value.found.map((f) => (
                      <li key={f.item_id + f.source}>
                        {f.requirement} <span className="muted">({f.source})</span>
                      </li>
                    ))}
                    {plan.value.not_in_plan.length > 0 && (
                      <li className="muted">Not covered by the plan: {plan.value.not_in_plan.length} check(s)</li>
                    )}
                  </ul>
                )}
              </div>
            )}
          </section>

          <section className="board" aria-labelledby="board-h">
            <div className="board-head">
              <h2 id="board-h">Photos</h2>
              <div className="actions">
                <label className="button ghost">
                  <input type="file" accept="image/*" multiple onChange={(e) => addFiles(e.target.files)} />
                  Add photos
                </label>
                <button className="ghost" onClick={loadSamples}>Use sample photos</button>
                <button className="primary" disabled={!photos.length} onClick={checkAll}>Check photos</button>
              </div>
            </div>

            {!photos.length && (
              <label className="drop">
                <input type="file" accept="image/*" multiple onChange={(e) => addFiles(e.target.files)} />
                Drop site photos here, or use the sample photos. Sample photos are AI-generated illustrations.
              </label>
            )}

            <div className="cards">
              {photos.map((p) => {
                const final = p.reviewVerdict ?? p.verdict;
                const dec = decisionOf(p.verdict, p.reviewVerdict);
                return (
                  <article key={p.key} className={`card ${dec ?? ''}`}>
                    <div className="shot">
                      <img src={p.img.previewUrl} alt={p.caption} />
                      {dec && (
                        <div className={`tag ${dec}`}>
                          <span className="hole" aria-hidden="true" />
                          {dec === 'hold' ? 'Hold. Do not cover.' : dec === 'clear' ? 'Clear to cover' : 'Needs another photo'}
                        </div>
                      )}
                    </div>
                    <div className="card-body">
                      <h3>{p.caption}</h3>
                      {p.sample && <p className="muted tiny">AI-generated sample photo</p>}
                      {p.check === 'running' && <p className="working">Gemini Nano is looking…</p>}
                      {p.check === 'queued' && <p className="muted">Waiting for signal</p>}
                      {(p.check === 'blocked' || p.check === 'error') && <p className="err">{p.note}</p>}
                      {final && (
                        <>
                          <p className="summary">{final.summary}</p>
                          <ul className="items">
                            {final.items.map((i) => (
                              <li key={i.id} className={i.status}>
                                <span className="mark" aria-label={i.status.replace('_', ' ')} />
                                <span>
                                  <strong>{stage.items.find((s) => s.id === i.id)?.label}.</strong> {i.note}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                      <div className="provenance">
                        {p.where && (
                          <span className={`where ${p.where}`}>
                            {p.where === 'on_device' ? 'Checked on this computer' : 'Checked in the cloud'} in {secs(p.ms)}
                          </span>
                        )}
                        {p.review === 'running' && <span className="where in_cloud">Second opinion running…</span>}
                        {p.review === 'done' && <span className="where in_cloud">Second opinion from the cloud model</span>}
                        {p.review === 'queued' && <span className="where queued">Second opinion waits for signal</span>}
                        {p.review === 'blocked' && p.verdict && (
                          <span className="where blocked">
                            Unsure ({p.reviewWhy}). Photo kept local.{' '}
                            <button
                              className="link"
                              onClick={() => {
                                runReview(p, `${p.reviewWhy ?? 'unsure'}; sent by you`, p.verdict!, true);
                              }}
                            >
                              Send this photo for a second opinion
                            </button>
                          </span>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        </div>

        <aside className="side">
          <section className="privacy">
            <label className="switch">
              <input type="checkbox" checked={localOnly} onChange={(e) => setLocalOnly(e.target.checked)} />
              <span className="track" aria-hidden="true" />
              <span>
                <strong>Keep photos on this computer</strong>
                <span className="muted">
                  {localOnly
                    ? 'Only Gemini Nano sees the photos. Unsure results are flagged, not sent.'
                    : 'Unsure photos may go to the cloud model for a second opinion.'}
                </span>
              </span>
            </label>
          </section>

          <section className="verdict">
            <h2>Hold point</h2>
            {!overall && <p className="muted">Check photos to get a decision.</p>}
            {overall && (
              <p className={`big ${overall}`}>
                {overall === 'hold' ? 'Do not cover yet' : overall === 'clear' ? 'Clear to cover' : 'Needs more photos'}
              </p>
            )}
            <div className="report-row">
              <select value={lang} onChange={(e) => setLang(e.target.value)} aria-label="Note language">
                {Object.entries(REPORT_LANGUAGES).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
              <button className="ghost" disabled={!checked.length || report?.step === 'running'} onClick={runReport}>
                Write note to contractor
              </button>
            </div>
            {report?.step === 'running' && <p className="working">Writing…</p>}
            {report?.step === 'queued' && <p className="muted">{report.reason}</p>}
            {report?.step === 'error' && <p className="err">{report.reason}</p>}
            {report?.text && (
              <>
                <pre className="note">{report.text}</pre>
                <p className={`where ${report.where}`}>
                  {report.where === 'on_device' ? 'Written on this computer' : 'Written in the cloud from text findings'} in {secs(report.ms)}
                </p>
              </>
            )}
            <button className="primary wide" disabled={!overall || saved?.step === 'running'} onClick={save}>
              Save hold point
            </button>
            {saved?.step === 'done' && (
              <p className="muted tiny">Saved as {saved.id}. Findings and photo fingerprints only; the photos stay here.</p>
            )}
            {saved?.step === 'error' && <p className="err">{saved.error}</p>}
          </section>

          <section className="ledger" aria-labelledby="ledger-h">
            <h2 id="ledger-h">Where each step ran</h2>
            <p className="tally">
              <span className="where on_device">{onDeviceCount} on this computer</span>
              <span className="where in_cloud">{cloudCount} in the cloud</span>
            </p>
            {!log.length && <p className="muted">Every model call appears here with the reason for its route.</p>}
            <ol>
              {log.map((e) => (
                <li key={e.id} className={`r-${e.route}`}>
                  <div className="l-top">
                    <strong>{e.task}</strong>
                    <span className="muted">{e.target}</span>
                  </div>
                  <div className="l-route">
                    {ROUTE_LABEL[e.route]}
                    {e.where && ` → ran ${e.where === 'on_device' ? 'on this computer' : 'in the cloud'}`}
                    {e.ms ? `, ${secs(e.ms)}` : ''}
                  </div>
                  <div className="l-reason">{e.failed ? `Failed: ${e.failed}` : e.reason}</div>
                </li>
              ))}
            </ol>
          </section>
        </aside>
      </main>

      <footer className="foot">
        <span>A module of Veridom, the house-building control app for private homebuilders.</span>
        <span>Firebase AI Logic hybrid inference: Gemini Nano in Chrome, Gemini in the cloud.</span>
      </footer>
    </div>
  );
}
