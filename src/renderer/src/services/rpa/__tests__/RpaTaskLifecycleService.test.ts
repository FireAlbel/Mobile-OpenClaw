import { describe, expect, it, vi } from 'vitest'

import type { RpaDslSession, RpaDslSessionRepository } from '../RpaDslSession'
import { RpaTaskLifecycleService } from '../RpaTaskLifecycleService'

const session = { id: 'session-1', version: 3, status: 'validated' } as RpaDslSession

describe('RpaTaskLifecycleService', () => {
  it('delegates duplicate and end with optimistic session versions', async () => {
    const duplicate = vi.fn(async () => session)
    const end = vi.fn(async () => ({ ...session, status: 'ended' as const }))
    const service = new RpaTaskLifecycleService({ duplicate, end } as unknown as RpaDslSessionRepository)

    await service.duplicate(session, 'topic-2')
    await service.end(session)

    expect(duplicate).toHaveBeenCalledWith('session-1', 3, 'topic-2')
    expect(end).toHaveBeenCalledWith('session-1', 3)
  })

  it('rejects duplicating a task while it is executing', async () => {
    const duplicate = vi.fn()
    const service = new RpaTaskLifecycleService({ duplicate } as unknown as RpaDslSessionRepository)

    await expect(service.duplicate({ ...session, status: 'executing' }, 'topic-2')).rejects.toThrow('Pause or stop')
    expect(duplicate).not.toHaveBeenCalled()
  })
})
