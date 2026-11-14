import type { NativeSign, RelayPacket, SignLog } from './sign-types'

interface RelayBinding {
  sendPacket: (packet: RelayPacket) => Promise<Buffer>
  logger: (log: SignLog) => void
  initialized: boolean
}
// Native init keeps its first callback. The JS package may be reloaded without replacing the same .node image.
// Key by the native function, shared by require() wrappers, so each binary has its own mutable dispatch target.
const key = Symbol.for('@luckylillia/plugin-nt-protocol/native-relays')
const registry = globalThis as typeof globalThis & { [key]?: WeakMap<NativeSign['init'], RelayBinding> }
const bindings = registry[key] ??= new WeakMap()

export function nativeRelay(native: NativeSign, sendPacket: RelayBinding['sendPacket'], logger: RelayBinding['logger']) {
  let binding = bindings.get(native.init)
  if (!binding) {
    binding = { sendPacket, logger, initialized: false }
    bindings.set(native.init, binding)
  } else {
    binding.sendPacket = sendPacket
    binding.logger = logger
  }
  return binding
}

export function nativeWasInitialized(native: NativeSign): boolean {
  return bindings.get(native.init)?.initialized ?? false
}
