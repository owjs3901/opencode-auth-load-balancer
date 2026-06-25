#!/usr/bin/env bun
// Standalone dashboard: prints the pool's in-use account + usage + ranking.
//   bun run src/cli/status.ts   (or `bun run status` via the package script)
import { readStatus, renderStatus } from '../status'

console.info(renderStatus(await readStatus()))
