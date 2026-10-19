import { homedir, tmpdir } from 'node:os'

import { afterEach, expect, test } from 'bun:test'

import { poolFilePath, syncStateFilePath } from '../pool/paths'

afterEach(() => {
  delete process.env.OPENCODE_AUTH_LB_DIR
})

test('the preload gives the suite a throwaway home', () => {
  expect(process.env.USERPROFILE?.startsWith(tmpdir())).toBe(true)
  expect(process.env.HOME).toBe(process.env.USERPROFILE)
  expect(process.env.XDG_DATA_HOME).toBeUndefined()
})

test.skipIf(process.platform !== 'win32')(
  'on Windows, with no data directory set, the default paths resolve into the throwaway home',
  () => {
    delete process.env.OPENCODE_AUTH_LB_DIR

    expect(homedir().startsWith(tmpdir())).toBe(true)
    expect(poolFilePath().startsWith(homedir())).toBe(true)
    expect(syncStateFilePath().startsWith(homedir())).toBe(true)
  },
)
