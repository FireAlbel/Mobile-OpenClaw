export interface RpaDebugExportEntry {
  path: string
  content: string
  encoding: 'utf8' | 'base64'
}

export interface RpaDebugExportPayload {
  fileName: string
  entries: RpaDebugExportEntry[]
}

export interface RpaDebugExportResult {
  cancelled: boolean
  filePath?: string
}
