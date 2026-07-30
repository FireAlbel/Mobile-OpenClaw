export interface RpaSessionDraftHandle {
  isDirty(): boolean
  save(): Promise<boolean>
  discard(): void
}

export class RpaSessionDraftRegistry {
  private readonly handles = new Map<string, Map<string, RpaSessionDraftHandle>>()

  register(sessionId: string, ownerId: string, handle: RpaSessionDraftHandle): () => void {
    const owners = this.handles.get(sessionId) ?? new Map<string, RpaSessionDraftHandle>()
    owners.set(ownerId, handle)
    this.handles.set(sessionId, owners)
    return () => {
      const current = this.handles.get(sessionId)
      current?.delete(ownerId)
      if (!current?.size) this.handles.delete(sessionId)
    }
  }

  hasUnsavedChanges(sessionId: string): boolean {
    return [...(this.handles.get(sessionId)?.values() ?? [])].some((handle) => handle.isDirty())
  }

  async save(sessionId: string): Promise<boolean> {
    const dirty = [...(this.handles.get(sessionId)?.values() ?? [])].filter((handle) => handle.isDirty())
    for (const handle of dirty) {
      if (!(await handle.save())) return false
    }
    return true
  }

  discard(sessionId: string): void {
    for (const handle of this.handles.get(sessionId)?.values() ?? []) {
      if (handle.isDirty()) handle.discard()
    }
  }
}

export const rpaSessionDraftRegistry = new RpaSessionDraftRegistry()
