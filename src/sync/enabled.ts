/** On unless `OPENCODE_AUTH_LB_SYNC` is `0` / `false` / `no` / `off`. */
export function syncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.OPENCODE_AUTH_LB_SYNC?.trim().toLowerCase()
  return raw !== '0' && raw !== 'false' && raw !== 'no' && raw !== 'off'
}
