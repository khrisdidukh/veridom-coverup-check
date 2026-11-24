import { describe, expect, it } from 'vitest';
import { decidePhotoCheck, decidePlanRead, decideReport, decideSecondOpinion, needsSecondOpinion } from '../src/policy';
import type { PhotoVerdict } from '../src/inference';

const ready = { localOnly: false, online: true, device: 'available' as const };

const verdict = (over: Partial<PhotoVerdict> = {}): PhotoVerdict => ({
  stage_matches: true,
  confidence: 'high',
  summary: '',
  items: [
    { id: 'a', status: 'ok', note: '' },
    { id: 'b', status: 'ok', note: '' },
  ],
  ...over,
});

describe('photo check routing', () => {
  it('keeps photos on device when the lock is on', () => {
    expect(decidePhotoCheck({ ...ready, localOnly: true }).route).toBe('device_only');
  });
  it('refuses rather than leaking when the lock is on and there is no device model', () => {
    expect(decidePhotoCheck({ localOnly: true, online: true, device: 'no-api' }).route).toBe('blocked');
  });
  it('prefers the device and lets Firebase fall back when unlocked', () => {
    expect(decidePhotoCheck(ready).route).toBe('device_first');
    expect(decidePhotoCheck({ ...ready, device: 'unavailable' }).route).toBe('device_first');
  });
  it('queues when there is neither a device model nor signal', () => {
    expect(decidePhotoCheck({ localOnly: false, online: false, device: 'no-api' }).route).toBe('queue');
  });
  it('still checks on device without signal', () => {
    expect(decidePhotoCheck({ ...ready, online: false }).route).toBe('device_first');
  });
});

describe('second opinion', () => {
  it('is suggested for low confidence, wrong stage, or mostly unseen items', () => {
    expect(needsSecondOpinion(verdict({ confidence: 'low' }), 'low')).toMatch(/confidence/);
    expect(needsSecondOpinion(verdict({ stage_matches: false }), 'low')).toMatch(/different stage/);
    expect(
      needsSecondOpinion(verdict({ items: [{ id: 'a', status: 'not_visible', note: '' }, { id: 'b', status: 'ok', note: '' }] }), 'low'),
    ).toMatch(/could not be judged/);
    expect(needsSecondOpinion(verdict(), 'low')).toBeNull();
    expect(needsSecondOpinion(verdict({ confidence: 'medium' }), 'low')).toBeNull();
    expect(needsSecondOpinion(verdict({ confidence: 'medium' }), 'medium')).not.toBeNull();
  });
  it('never sends a locked photo, waits for signal, else goes to the cloud', () => {
    expect(decideSecondOpinion({ ...ready, localOnly: true }, 'x').route).toBe('blocked');
    expect(decideSecondOpinion({ ...ready, online: false }, 'x').route).toBe('queue');
    expect(decideSecondOpinion(ready, 'x').route).toBe('cloud');
  });
});

describe('plan and report', () => {
  it('reads PDF plans in the cloud only', () => {
    expect(decidePlanRead({ ...ready, localOnly: true }).route).toBe('cloud');
    expect(decidePlanRead({ ...ready, online: false }).route).toBe('queue');
  });
  it('writes the note on device when Nano supports the language', () => {
    expect(decideReport(ready, 'en', true).route).toBe('device_first');
    expect(decideReport(ready, 'de', false).route).toBe('cloud');
    expect(decideReport({ ...ready, online: false }, 'uk', false).route).toBe('queue');
  });
});
