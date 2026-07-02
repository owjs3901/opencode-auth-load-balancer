#!/usr/bin/env bun
// Standalone dashboard: prints the pool's in-use account + usage + ranking.
//   bun run src/cli/status.ts   (or `bun run status` via the package script)
import { readStatus, renderStatus } from '../status'

// ONE clock for ranking AND rendering (mirrors the auth_lb_status tool): two
// Date.now() stamps can render a just-expired cooldown as `exhausted` and skew
// countdowns from the ranks printed beside them.
const now = Date.now()
console.info(renderStatus(await readStatus(now), now))
