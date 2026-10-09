import { execFile } from 'node:child_process'

const GH_TIMEOUT_MS = 5_000

/** Runs `gh auth token`; resolves its stdout, rejects when gh is missing, logged out, or slow. */
export type GhRunner = () => Promise<string>

/** The slice of `execFile` used here, so tests never spawn the real gh. */
export type ExecFn = (
  file: string,
  args: string[],
  options: { timeout: number; windowsHide: boolean; maxBuffer: number },
  callback: (error: Error | null, stdout: string) => void,
) => unknown

/** `execFile` with no shell: nothing to inject into, and the token never touches a command line. */
export function ghAuthToken(exec: ExecFn = execFile): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(
      'gh',
      ['auth', 'token'],
      { timeout: GH_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    )
  })
}

/**
 * The GitHub token to upload with: `GITHUB_TOKEN`, then `GH_TOKEN`, then the
 * gh CLI's. Null when none exists. Only uploading needs it.
 */
export async function discoverGithubToken(
  run: GhRunner = ghAuthToken,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  for (const name of ['GITHUB_TOKEN', 'GH_TOKEN']) {
    const value = env[name]?.trim()
    if (value) return value
  }
  const token = (await run().catch(() => '')).trim()
  return token || null
}
