import { Context } from 'cordis'
import type { Event } from '@satorijs/protocol'
import type { ObjectToSnake } from 'ts-case-convert'

export type SatoriEvent = ObjectToSnake<Event>

/**
 * What the NT event converters need from the bot that
 * builds the envelope.
 */
export interface NormalizeHost {
  readonly ctx: Context
  event(type: string, data: Partial<SatoriEvent>): SatoriEvent
}
