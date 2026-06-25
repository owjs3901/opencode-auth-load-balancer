import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test } from 'bun:test'

/**
 * The TUI view can't import `src/` (it's installed standalone), so it loads a
 * byte-identical copy of the scoring core installed alongside it. `bun run build`
 * regenerates that copy (`sync:tui`); this test fails loudly if the two ever drift,
 * which is exactly the silent divergence that once made the dashboard rank accounts
 * differently from the scheduler.
 */
test('tui/auth-load-balancer-scoring.ts is byte-identical to src/scheduler/score-core.ts', () => {
  const root = join(import.meta.dir, '..', '..')
  const core = readFileSync(
    join(root, 'src', 'scheduler', 'score-core.ts'),
    'utf8',
  )
  const copy = readFileSync(
    join(root, 'tui', 'auth-load-balancer-scoring.ts'),
    'utf8',
  )
  expect(copy).toBe(core)
})
