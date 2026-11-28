import { existsSync } from "fs"

export function isDockerEnvironment(): boolean {
    try {
        return existsSync('/.dockerenv')
    } catch {
        return false
    }
}

export type ProtocolMode = 'direct' | 'native'
export type ProtocolId = 'linux' | 'windows' | 'macos' | 'watch' | 'ipad' | 'iphone' | 'harmonypad' | 'harmony'
export type Cdn = 'cf' | 'china'

/**
 * How the NT protocol plugin logs in, from its settings: the pure protocol speaking `protocol`, or NativeQQ bridging
 * an official QQ client. Launch flags (`--ntqq-mode` and the others in package.json `llbot.args`) are saved into
 * those settings by LLBot before the plugin starts, so this is all there is.
 */
export interface ProtocolSelection {
    mode: ProtocolMode
    protocol: ProtocolId
    nativeQQ: { qqPath: string; hookMode: string }
    signCDN: Cdn
}

let selection: ProtocolSelection | undefined

/** Set by the NT protocol plugin before it mounts the protocol, and again when its settings change. */
export function setProtocolSelection(value: ProtocolSelection) {
    selection = value
}

export function isNativeQQMode(): boolean {
    return selection?.mode === 'native'
}

/** The QQ the bridge starts (empty: the one NativeQQ finds), and how NativeQQ hooks it (empty: its default). */
export function currentNativeQQ(): { qqPath: string; hookMode: string } {
    return selection?.nativeQQ ?? { qqPath: '', hookMode: '' }
}

/**
 * `--dev`: run against a local manager -- loads the development native bundle and reads data/auth_token.dev.txt.
 * argv only, no env fallback: a stray variable on a deployment must never switch it on.
 */
export function isDevMode(argv: string[] = process.argv): boolean {
    return argv.includes('--dev')
}

/** `--instance <name>` / `--instance=<name>`, else `LLBOT_INSTANCE`. Resolved against data/ in common/instance.ts. */
export function getInstanceArg(argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env): string | undefined {
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        if (a === '--instance' && argv[i + 1] && !argv[i + 1].startsWith('-')) return argv[i + 1]
        if (a.startsWith('--instance=')) return a.slice('--instance='.length) || undefined
    }
    return env.LLBOT_INSTANCE || undefined
}

/** The signing service's CDN, from the settings (`signCDN`). cf = api-auth.luckylillia.com, china = llbot-api-auth.wumiao.wang */
export function getCdn(): Cdn {
    return selection?.signCDN === 'china' ? 'china' : 'cf'
}

/** The manager frontend, on a different domain from the API host the native signing module talks to. */
export function getAuthTokenPageUrl(cdn: Cdn = getCdn()): string {
    return cdn === 'china' ? 'https://llbot.wumiao.wang' : 'https://auth.luckylillia.com'
}

/**
 * The profile the protocol layer runs with. The pure protocol follows the settings' choice (default linux);
 * NativeQQ runs with linux (highway appId, SsoInfoSync).
 */
export function getProtocol(): ProtocolId {
    if (selection?.mode === 'native') return 'linux'
    return selection?.protocol ?? 'linux'
}
