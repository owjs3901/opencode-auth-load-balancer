import config from 'eslint-plugin-devup/oxlint-config'

// Exclude the experimental TUI plugin (tui/): it is SolidJS/JSX compiled by
// opencode's own TUI runtime, so it can't be linted/typechecked in this repo.
export default {
  ...config,
  ignorePatterns: [...(config.ignorePatterns ?? []), 'tui/**'],
}
