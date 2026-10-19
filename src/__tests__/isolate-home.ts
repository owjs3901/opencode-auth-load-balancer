import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'auth-lb-home-'))

process.env.HOME = home
process.env.USERPROFILE = home
delete process.env.XDG_DATA_HOME
