/** OneBot connection operations do not belong to the account's bot.internal API. */
const CONNECTION_ONLY = new Set(['.handle_quick_operation', 'get_event'])

/** The neutral API name of an account action; undefined for connection operations and scheduling aliases. */
export function internalMethodName(action: string): string | undefined {
  if (action.endsWith('_async') || action.endsWith('_rate_limited') || CONNECTION_ONLY.has(action)) return
  return action.replace(/^[._]+/, '').replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase())
}
