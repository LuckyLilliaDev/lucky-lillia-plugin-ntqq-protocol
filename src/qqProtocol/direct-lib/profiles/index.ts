import { getProtocol, type ProtocolId } from '../../../support/utils/environment'
import type { ProtocolProfile, ProtocolName, ProtocolFamily } from './types'
import { LINUX_PROFILE } from './linux'
import { WINDOWS_PROFILE } from './windows'
import { MACOS_PROFILE } from './macos'
import { WATCH_PROFILE } from './watch'
import { IPAD_PROFILE, IPHONE_PROFILE } from './ios'
import { HARMONY_PAD_PROFILE, HARMONY_PHONE_PROFILE } from './harmony'

export type { ProtocolProfile, ProtocolName, ProtocolFamily, ProtocolLoginMethod, ReserveVariant, MobileProfileExtra } from './types'

export const PROFILES: Partial<Record<ProtocolName, ProtocolProfile>> = {
  linux: LINUX_PROFILE,
  windows: WINDOWS_PROFILE,
  macos: MACOS_PROFILE,
  watch: WATCH_PROFILE,
  ipad: IPAD_PROFILE,
  iphone: IPHONE_PROFILE,
  harmonypad: HARMONY_PAD_PROFILE,
  harmony: HARMONY_PHONE_PROFILE,
}

export function isMobileFamily(family: ProtocolFamily): boolean {
  return family === 'ios' || family === 'harmony'
}

export function isMobileProtocol(id: ProtocolId | string): boolean {
  return id === 'ipad' || id === 'iphone' || id === 'harmonypad' || id === 'harmony'
}

export function supportsQrLogin(profile: ProtocolProfile = getActiveProfile()): boolean {
  return profile.family === 'nt' || profile.family === 'watch'
}

export function supportsPasswordLogin(profile: ProtocolProfile = getActiveProfile()): boolean {
  return profile.family === 'nt' || isMobileFamily(profile.family)
}

export function getSupportedLoginMethods(id?: ProtocolId | string): ('qr' | 'password')[] {
  const profile = (id ? PROFILES[id as ProtocolName] : undefined) ?? getActiveProfile()
  const methods: ('qr' | 'password')[] = []
  if (supportsQrLogin(profile)) methods.push('qr')
  if (supportsPasswordLogin(profile)) methods.push('password')
  return methods
}

export const DEFAULT_PROFILE = LINUX_PROFILE

let _active: { id: ProtocolId; profile: ProtocolProfile } | null = null

/** Follows getProtocol() dynamically as the active protocol selection changes. */
export function getActiveProfile(): ProtocolProfile {
  const id = getProtocol()
  if (_active?.id === id) return _active.profile
  let profile = PROFILES[id]
  if (!profile) {
    console.warn(`[profile] protocol "${id}" 尚未实现, 回退 linux`)
    profile = DEFAULT_PROFILE
  }
  _active = { id, profile }
  return profile
}

export function _resetActiveProfileForTest(): void {
  _active = null
}
