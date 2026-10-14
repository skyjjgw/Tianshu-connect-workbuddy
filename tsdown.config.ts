import type { UserConfig } from 'tsdown'

/**
 * Tianshu installs plugins with dev dependencies omitted and does not provide
 * DSH peer packages. Bundle every WorkBuddy module into the two entry files;
 * only Node built-ins remain external at runtime.
 */
export default {
  entry: {
    index: 'src/tianshu-plugin.ts',
    cli: 'src/tianshu-cli.ts',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  fixedExtension: false,
  dts: false,
  clean: true,
} satisfies UserConfig
