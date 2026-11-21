import type { Config } from './support/types'
import type {} from '@luckylillia-dev/plugin-sdk'

/** The config service is injected by the Bot; no implementation is imported or bundled here. */
declare module 'cordis' {
  interface Context {
    config: { get(): Config }
  }
  interface Events {
    'llob/config-updated': (config: Config) => void
  }
}
