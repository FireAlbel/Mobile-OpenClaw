import type { RpaAppRole } from './RpaAppRole'

export type RpaRolePackImportMode = 'install' | 'replace' | 'fork' | 'cancel'
export type RpaRolePackTrust = 'trusted' | 'unsigned' | 'untrusted' | 'invalid'

export interface RpaRolePackFileEntry {
  path: string
  sha256: string
  sizeBytes: number
  kind: 'role' | 'prompt' | 'knowledge' | 'skill' | 'template' | 'artifact' | 'provider'
}
export interface RpaRolePackManifest {
  schemaVersion: 1
  packId: string
  roleId: string
  roleVersion: number
  name: string
  publisher?: string
  baseVersion?: number
  createdAt: number
  appPackages: string[]
  permissions: string[]
  dependencies: Array<{ roleId: string; versionRange?: string }>
  compatibility: { minAppVersion?: string; maxAppVersion?: string }
  files: RpaRolePackFileEntry[]
  signature?: { algorithm: string; keyId: string; value: string }
}

export interface RpaRolePack {
  manifest: RpaRolePackManifest
  files: Record<string, string>
}
export interface RpaRolePackTrustStore {
  verify(input: {
    publisher: string
    keyId: string
    algorithm: string
    signature: string
    payload: string
  }): Promise<boolean>
  isTrustedPublisher(publisher: string): Promise<boolean>
}
export interface RpaRolePackRepositorySnapshot {
  values: Record<string, unknown[]>
}
export interface RpaRolePackTransactionAdapter {
  snapshot(): Promise<RpaRolePackRepositorySnapshot>
  restore(snapshot: RpaRolePackRepositorySnapshot): Promise<void>
  findRole(roleId: string): Promise<RpaAppRole | undefined>
  hasActiveRun(roleId: string): Promise<boolean>
  apply(staged: RpaRolePackStagedContent): Promise<void>
}
export interface RpaRolePackStagedContent {
  role: RpaAppRole
  prompts: unknown[]
  knowledge: unknown[]
  skills: unknown[]
  templates: unknown[]
  artifacts: unknown[]
  providers: unknown[]
  quarantine: boolean
}
export interface RpaRolePackValidationReport {
  valid: boolean
  trust: RpaRolePackTrust
  errors: string[]
  warnings: string[]
  permissions: string[]
  conflicts: string[]
  changes: string[]
}
export interface RpaRolePackImportResult {
  mode: Exclude<RpaRolePackImportMode, 'cancel'>
  roleId: string
  quarantined: boolean
  backup: RpaRolePackRepositorySnapshot
  report: RpaRolePackValidationReport
}
export interface RpaRolePackHash {
  sha256(content: string): Promise<string>
}

export class RpaRolePackService {
  constructor(
    private readonly hash: RpaRolePackHash,
    private readonly trustStore: RpaRolePackTrustStore
  ) {}

  async export(
    input: Omit<RpaRolePackStagedContent, 'quarantine'>,
    metadata: {
      packId: string
      publisher?: string
      permissions?: string[]
      dependencies?: RpaRolePackManifest['dependencies']
      compatibility?: RpaRolePackManifest['compatibility']
    }
  ): Promise<RpaRolePack> {
    const safe = stripSecrets(input)
    const files: Record<string, string> = {
      'role.json': stableStringify(safe.role),
      'prompts.json': stableStringify(safe.prompts),
      'knowledge.json': stableStringify(safe.knowledge),
      'skills.json': stableStringify(safe.skills),
      'templates.json': stableStringify(safe.templates),
      'artifacts.json': stableStringify(safe.artifacts),
      'providers.json': stableStringify(safe.providers)
    }
    const entries: RpaRolePackFileEntry[] = []
    for (const [path, content] of Object.entries(files))
      entries.push({
        path,
        sha256: await this.hash.sha256(content),
        sizeBytes: new TextEncoder().encode(content).byteLength,
        kind: fileKind(path)
      })
    return {
      manifest: {
        schemaVersion: 1,
        packId: metadata.packId,
        roleId: safe.role.id,
        roleVersion: safe.role.version,
        name: safe.role.name,
        publisher: metadata.publisher,
        createdAt: Date.now(),
        appPackages: safe.role.appPackages,
        permissions: metadata.permissions ?? [],
        dependencies: metadata.dependencies ?? safe.role.supportingRoleIds.map((roleId) => ({ roleId })),
        compatibility: metadata.compatibility ?? {},
        files: entries
      },
      files
    }
  }

  async validate(pack: RpaRolePack): Promise<RpaRolePackValidationReport> {
    const errors: string[] = []
    const warnings: string[] = []
    const conflicts: string[] = []
    const changes: string[] = []
    if (pack.manifest.schemaVersion !== 1 || !pack.manifest.packId || !pack.manifest.roleId)
      errors.push('Invalid Role Pack manifest')
    const expectedPaths = new Set(pack.manifest.files.map((entry) => entry.path))
    for (const entry of pack.manifest.files) {
      if (!isSafePackPath(entry.path)) {
        errors.push(`Unsafe pack path: ${entry.path}`)
        continue
      }
      const content = pack.files[entry.path]
      if (content === undefined) {
        errors.push(`Missing pack file: ${entry.path}`)
        continue
      }
      const bytes = new TextEncoder().encode(content).byteLength
      if (bytes !== entry.sizeBytes) errors.push(`Size mismatch: ${entry.path}`)
      if ((await this.hash.sha256(content)) !== entry.sha256) errors.push(`Checksum mismatch: ${entry.path}`)
      try {
        JSON.parse(content)
      } catch {
        errors.push(`Invalid JSON: ${entry.path}`)
      }
    }
    for (const path of Object.keys(pack.files))
      if (!expectedPaths.has(path)) errors.push(`Undeclared pack file: ${path}`)
    let trust: RpaRolePackTrust = 'unsigned'
    const signature = pack.manifest.signature
    if (signature && pack.manifest.publisher) {
      const payload = signingPayload(pack.manifest)
      const valid = await this.trustStore.verify({
        publisher: pack.manifest.publisher,
        keyId: signature.keyId,
        algorithm: signature.algorithm,
        signature: signature.value,
        payload
      })
      if (!valid) {
        trust = 'invalid'
        errors.push('Invalid Role Pack signature')
      } else trust = (await this.trustStore.isTrustedPublisher(pack.manifest.publisher)) ? 'trusted' : 'untrusted'
    } else warnings.push('Role Pack is unsigned and will be quarantined')
    return {
      valid: !errors.length,
      trust,
      errors,
      warnings,
      permissions: [...pack.manifest.permissions],
      conflicts,
      changes
    }
  }

  async import(
    pack: RpaRolePack,
    mode: RpaRolePackImportMode,
    adapter: RpaRolePackTransactionAdapter,
    options: { forkRoleId?: string; approveReplace?: boolean } = {}
  ): Promise<RpaRolePackImportResult> {
    if (mode === 'cancel') throw new Error('Role Pack import cancelled')
    const report = await this.validate(pack)
    if (!report.valid) throw new Error(report.errors.join('; '))
    const staged = parseStaged(pack)
    const existing = await adapter.findRole(pack.manifest.roleId)
    if (mode === 'install' && existing) throw new Error(`Role already exists: ${pack.manifest.roleId}`)
    if (mode === 'replace') {
      if (!existing) throw new Error('Cannot replace a Role that is not installed')
      if (!options.approveReplace) throw new Error('Role replacement requires impact approval')
      if (await adapter.hasActiveRun(existing.id)) throw new Error('Role replacement is blocked by an active run')
      if (report.trust !== 'trusted' || !pack.manifest.publisher)
        throw new Error('Role replacement requires a trusted publisher')
      if (pack.manifest.baseVersion !== undefined && pack.manifest.baseVersion !== existing.version)
        throw new Error('Role Pack baseVersion does not match the installed Role')
      report.changes.push(`replace ${existing.id}@${existing.version} with @${pack.manifest.roleVersion}`)
    }
    if (mode === 'fork') {
      const forkRoleId = options.forkRoleId?.trim()
      if (!forkRoleId) throw new Error('Fork Role ID is required')
      if (await adapter.findRole(forkRoleId)) throw new Error(`Fork Role already exists: ${forkRoleId}`)
      staged.role = rewriteRoleNamespace(staged.role, pack.manifest.roleId, forkRoleId)
      staged.prompts = rewriteReferences(staged.prompts, pack.manifest.roleId, forkRoleId)
      staged.knowledge = rewriteReferences(staged.knowledge, pack.manifest.roleId, forkRoleId)
      staged.skills = rewriteReferences(staged.skills, pack.manifest.roleId, forkRoleId)
      staged.templates = rewriteReferences(staged.templates, pack.manifest.roleId, forkRoleId)
      staged.artifacts = rewriteReferences(staged.artifacts, pack.manifest.roleId, forkRoleId)
      staged.providers = rewriteReferences(staged.providers, pack.manifest.roleId, forkRoleId)
    }
    staged.quarantine = report.trust !== 'trusted'
    if (staged.quarantine) {
      staged.role = { ...staged.role, status: 'draft' }
      staged.providers = staged.providers.map(disableImportedProvider)
    }
    const backup = await adapter.snapshot()
    try {
      await adapter.apply(staged)
    } catch (error) {
      await adapter.restore(backup)
      throw new Error(`Role Pack transaction rolled back: ${error instanceof Error ? error.message : 'unknown error'}`)
    }
    return { mode, roleId: staged.role.id, quarantined: staged.quarantine, backup, report }
  }
}

function parseStaged(pack: RpaRolePack): RpaRolePackStagedContent {
  const read = (path: string, fallback: unknown) => (pack.files[path] ? JSON.parse(pack.files[path]) : fallback)
  const role = read('role.json', undefined) as RpaAppRole | undefined
  if (!role || role.id !== pack.manifest.roleId || role.version !== pack.manifest.roleVersion)
    throw new Error('Role content does not match manifest identity')
  return {
    role,
    prompts: array(read('prompts.json', [])),
    knowledge: array(read('knowledge.json', [])),
    skills: array(read('skills.json', [])),
    templates: array(read('templates.json', [])),
    artifacts: array(read('artifacts.json', [])),
    providers: array(read('providers.json', [])),
    quarantine: false
  }
}
function stripSecrets<T>(value: T): T {
  const walk = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(walk)
    if (!candidate || typeof candidate !== 'object') return candidate
    return Object.fromEntries(
      Object.entries(candidate)
        .filter(([key]) => !/(secret|credential|api.?key|token|password)/i.test(key))
        .map(([key, item]) => [key, walk(item)])
    )
  }
  return walk(value) as T
}
function rewriteRoleNamespace(role: RpaAppRole, source: string, target: string): RpaAppRole {
  return {
    ...rewriteReferences(role, source, target),
    id: target,
    name: `${role.name} (Fork)`,
    status: 'draft',
    version: 1,
    compatibility: undefined
  } as RpaAppRole
}
function rewriteReferences<T>(value: T, source: string, target: string): T {
  const walk = (candidate: unknown): unknown => {
    if (candidate === source) return target
    if (Array.isArray(candidate)) return candidate.map(walk)
    if (!candidate || typeof candidate !== 'object') return candidate
    return Object.fromEntries(Object.entries(candidate).map(([key, item]) => [key, walk(item)]))
  }
  return walk(value) as T
}
function disableImportedProvider(value: unknown): unknown {
  return value && typeof value === 'object'
    ? { ...(value as Record<string, unknown>), status: 'disabled', credentialRef: undefined }
    : value
}
function signingPayload(manifest: RpaRolePackManifest): string {
  const unsigned = { ...manifest }
  Reflect.deleteProperty(unsigned, 'signature')
  return stableStringify(unsigned)
}
function stableStringify(value: unknown): string {
  const normalize = (candidate: unknown): unknown =>
    Array.isArray(candidate)
      ? candidate.map(normalize)
      : candidate && typeof candidate === 'object'
        ? Object.fromEntries(
            Object.entries(candidate)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, item]) => [key, normalize(item)])
          )
        : candidate
  return JSON.stringify(normalize(value))
}
function isSafePackPath(value: string): boolean {
  return (
    Boolean(value) &&
    !value.includes('..') &&
    !value.startsWith('/') &&
    !value.startsWith('\\') &&
    !/^[A-Za-z]:/.test(value) &&
    value.split(/[\\/]/).every((part) => Boolean(part) && part !== '.' && part !== '..')
  )
}
function fileKind(path: string): RpaRolePackFileEntry['kind'] {
  return (
    (
      {
        'role.json': 'role',
        'prompts.json': 'prompt',
        'knowledge.json': 'knowledge',
        'skills.json': 'skill',
        'templates.json': 'template',
        'artifacts.json': 'artifact',
        'providers.json': 'provider'
      } as const
    )[path as 'role.json'] ?? 'artifact'
  )
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
