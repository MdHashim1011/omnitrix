import { describe, expect, it } from 'vitest';
import { parseCodexRateLimits } from '../src/quota.js';

describe('parseCodexRateLimits', () => {
  it('parses both windows and the plan', () => {
    expect(parseCodexRateLimits({
      rateLimits: {
        primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 1794366122 },
        secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1794518336 },
        planType: 'plus',
      },
    }, 123)).toEqual({
      at: 123,
      plan: 'plus',
      windows: [
        { name: '5 hours', usedPercent: 1, resetsAt: 1794366122000 },
        { name: '7 days', usedPercent: 0, resetsAt: 1794518336000 },
      ],
    });
  });

  it('accepts a null secondary window', () => {
    expect(parseCodexRateLimits({ rateLimits: {
      primary: { usedPercent: 20, windowDurationMins: 300 },
      secondary: null,
    } }, 123)).toEqual({ at: 123, windows: [{ name: '5 hours', usedPercent: 20 }] });
  });

  it('names unknown durations in minutes', () => {
    expect(parseCodexRateLimits({ rateLimits: {
      secondary: { usedPercent: 10, windowDurationMins: 60 },
    } }, 123)).toEqual({ at: 123, windows: [{ name: '60 minutes', usedPercent: 10 }] });
  });

  it('clamps percentages above 100', () => {
    expect(parseCodexRateLimits({ rateLimits: {
      primary: { usedPercent: 120, windowDurationMins: 300 },
    } })?.windows[0]?.usedPercent).toBe(100);
  });

  it.each([null, {}, 'garbage'])('returns undefined for garbage input %j', (input) => {
    expect(parseCodexRateLimits(input)).toBeUndefined();
  });
});
