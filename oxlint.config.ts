import config from 'eslint-plugin-devup/oxlint-config'

// The TUI plugin (tui/) is SolidJS/JSX rendered by opencode's own TUI runtime.
// Its JSX deps are installed as devDependencies so it CAN be linted/typechecked
// here (typecheck via tsconfig.tui.json). Type-check catches type/import/signature
// breaks; runtime rendering still needs a live opencode TUI (manual QA).
//
// The shared config's React-DOM rules don't fit @opentui/solid's intrinsic
// elements (<box>/<text> with fg=/gap=/wrapMode= props) — tsconfig.tui.json's
// JSX types already enforce valid props, so turn the DOM-only rules off for the
// SolidJS view; formatting / import-sort / dead-code rules stay on.
export default {
  ...config,
  overrides: [
    ...(config.overrides ?? []),
    {
      files: ['tui/**/*.tsx'],
      rules: {
        'react/no-unknown-property': 'off',
        'jsdoc/check-tag-names': 'off',
      },
    },
  ],
}
