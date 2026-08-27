/** @type {import('stylelint').Config} */
export default {
  extends: ['stylelint-config-standard'],
  ignoreFiles: ['**/dist/**', '**/node_modules/**'],
  rules: {
    'selector-class-pattern': [
      '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:__[a-z0-9]+(?:-[a-z0-9]+)*)?(?:--[a-z0-9]+(?:-[a-z0-9]+)*)?$',
      { message: 'Expected a kebab-case or BEM class selector' },
    ],
    'value-keyword-case': ['lower', { ignoreKeywords: ['optimizeLegibility'] }],
  },
}
