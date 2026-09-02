import { describe, expect, test } from 'bun:test'

import { classifyProviderRecovery } from '../pending/recovery'
import { DEFAULT_CONFIG } from '../scheduler/config'
import { testAccount } from './fixtures/account'

const NOW = 1_800_000_000_000
const POLL_MS = 5 * 60_000

describe('classifyProviderRecovery', () => {
  test('an account with account-wide headroom makes the provider available', () => {
    const accounts = [
      testAccount({
        id: 'ready',
        usage: {
          hourly: { utilization: 0.2, resetAt: NOW + 60_000 },
          weekly: { utilization: 0.8, resetAt: NOW + 86_400_000 },
          capturedAt: NOW,
        },
      }),
    ]

    expect(
      classifyProviderRecovery(
        accounts,
        'anthropic',
        DEFAULT_CONFIG,
        NOW,
        POLL_MS,
      ),
    ).toEqual({ state: 'available' })
  })

  test('one account recovers after its latest active account-wide constraint', () => {
    const hourlyReset = NOW + 10 * 60_000
    const weeklyReset = NOW + 2 * 60 * 60_000
    const cooldownReset = NOW + 30 * 60_000
    const accounts = [
      testAccount({
        id: 'full',
        usage: {
          hourly: { utilization: 1, resetAt: hourlyReset },
          weekly: { utilization: 1, resetAt: weeklyReset },
          capturedAt: NOW,
        },
        cooldownUntil: cooldownReset,
        cooldownKind: 'quota',
      }),
    ]

    expect(
      classifyProviderRecovery(
        accounts,
        'anthropic',
        DEFAULT_CONFIG,
        NOW,
        POLL_MS,
      ),
    ).toEqual({
      state: 'quota-blocked',
      nextCheckAt: weeklyReset,
      resumeAt: weeklyReset,
    })
  })

  test('multiple quota-blocked accounts use the earliest complete account recovery', () => {
    const first = NOW + 60 * 60_000
    const second = NOW + 3 * 60 * 60_000
    const accounts = [
      testAccount({
        id: 'first',
        usage: {
          hourly: null,
          weekly: { utilization: 1, resetAt: first },
          capturedAt: NOW,
        },
      }),
      testAccount({
        id: 'second',
        cooldownUntil: second,
        cooldownKind: 'quota',
      }),
    ]

    expect(
      classifyProviderRecovery(
        accounts,
        'anthropic',
        DEFAULT_CONFIG,
        NOW,
        POLL_MS,
      ),
    ).toEqual({
      state: 'quota-blocked',
      nextCheckAt: first,
      resumeAt: first,
    })
  })

  test('an unknown exhausted reset schedules the existing usage poll cadence', () => {
    const accounts = [
      testAccount({
        usage: {
          hourly: { utilization: 1, resetAt: 0 },
          weekly: null,
          capturedAt: NOW,
        },
      }),
    ]

    expect(
      classifyProviderRecovery(
        accounts,
        'anthropic',
        DEFAULT_CONFIG,
        NOW,
        POLL_MS,
      ),
    ).toEqual({
      state: 'quota-blocked',
      nextCheckAt: NOW + POLL_MS,
      resumeAt: null,
    })
  })

  test('unknown recovery polls before another account known to recover later', () => {
    const knownReset = NOW + 60 * 60_000
    const accounts = [
      testAccount({
        id: 'unknown',
        usage: {
          hourly: null,
          weekly: { utilization: 1, resetAt: 0 },
          capturedAt: NOW,
        },
      }),
      testAccount({
        id: 'known',
        cooldownUntil: knownReset,
        cooldownKind: 'quota',
      }),
    ]

    expect(
      classifyProviderRecovery(
        accounts,
        'anthropic',
        DEFAULT_CONFIG,
        NOW,
        POLL_MS,
      ),
    ).toEqual({
      state: 'quota-blocked',
      nextCheckAt: NOW + POLL_MS,
      resumeAt: knownReset,
    })
  })

  test('expired exhausted windows no longer block the provider', () => {
    const accounts = [
      testAccount({
        usage: {
          hourly: { utilization: 1, resetAt: NOW },
          weekly: null,
          capturedAt: NOW - 60_000,
        },
      }),
    ]

    expect(
      classifyProviderRecovery(
        accounts,
        'anthropic',
        DEFAULT_CONFIG,
        NOW,
        POLL_MS,
      ),
    ).toEqual({ state: 'available' })
  })

  test('disabled, re-login, auth, and transient accounts are unusable rather than pending', () => {
    const accounts = [
      testAccount({ id: 'disabled', disabledReason: 'manually disabled' }),
      testAccount({ id: 'relogin', disabledReason: 're-login required' }),
      testAccount({
        id: 'auth',
        cooldownUntil: NOW + 60_000,
        cooldownKind: 'auth',
      }),
      testAccount({
        id: 'transient',
        cooldownUntil: NOW + 60_000,
        cooldownKind: 'transient',
      }),
    ]

    expect(
      classifyProviderRecovery(
        accounts,
        'anthropic',
        DEFAULT_CONFIG,
        NOW,
        POLL_MS,
      ),
    ).toEqual({ state: 'unusable' })
  })

  test('a quota-recoverable account can pending alongside non-quota unusable accounts', () => {
    const resumeAt = NOW + 60_000
    const accounts = [
      testAccount({
        id: 'quota',
        cooldownUntil: resumeAt,
        cooldownKind: 'quota',
      }),
      testAccount({
        id: 'auth',
        cooldownUntil: NOW + 30_000,
        cooldownKind: 'auth',
      }),
      testAccount({ id: 'disabled', disabledReason: 'manually disabled' }),
    ]

    expect(
      classifyProviderRecovery(
        accounts,
        'anthropic',
        DEFAULT_CONFIG,
        NOW,
        POLL_MS,
      ),
    ).toEqual({
      state: 'quota-blocked',
      nextCheckAt: resumeAt,
      resumeAt,
    })
  })

  test('an unclassified legacy cooldown is quota only when usage proves exhaustion', () => {
    const cooldownUntil = NOW + 2 * 60_000
    const usageReset = NOW + 60_000
    const exhausted = testAccount({
      id: 'legacy-full',
      cooldownUntil,
      usage: {
        hourly: { utilization: 1, resetAt: usageReset },
        weekly: null,
        capturedAt: NOW,
      },
    })
    const unknown = testAccount({ id: 'legacy-only', cooldownUntil })

    expect(
      classifyProviderRecovery(
        [exhausted],
        'anthropic',
        DEFAULT_CONFIG,
        NOW,
        POLL_MS,
      ),
    ).toEqual({
      state: 'quota-blocked',
      nextCheckAt: cooldownUntil,
      resumeAt: cooldownUntil,
    })
    expect(
      classifyProviderRecovery(
        [unknown],
        'anthropic',
        DEFAULT_CONFIG,
        NOW,
        POLL_MS,
      ),
    ).toEqual({ state: 'unusable' })
  })

  test('ignores per-model limits and accounts owned by another provider', () => {
    const accounts = [
      testAccount({
        id: 'tier-only',
        modelCooldownsUntil: { opus: NOW + 60_000 },
      }),
      testAccount({
        id: 'other',
        providerID: 'openai',
        cooldownUntil: NOW + 60_000,
        cooldownKind: 'quota',
      }),
    ]

    expect(
      classifyProviderRecovery(
        accounts,
        'anthropic',
        DEFAULT_CONFIG,
        NOW,
        POLL_MS,
      ),
    ).toEqual({ state: 'available' })
  })
})
