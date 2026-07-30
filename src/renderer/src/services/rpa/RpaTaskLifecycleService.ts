import type { RpaDslSession, RpaDslSessionRepository } from './RpaDslSession'
import { rpaDslSessionRepository } from './RpaDslSession'

export class RpaTaskLifecycleService {
  constructor(private readonly repository: RpaDslSessionRepository = rpaDslSessionRepository) {}

  async duplicate(session: RpaDslSession, topicCompatibilityId: string): Promise<RpaDslSession> {
    if (session.status === 'executing') throw new Error('Pause or stop the active run before duplicating this task')
    return this.repository.duplicate(session.id, session.version, topicCompatibilityId)
  }

  async end(session: RpaDslSession): Promise<RpaDslSession> {
    return this.repository.end(session.id, session.version)
  }
}

export const rpaTaskLifecycleService = new RpaTaskLifecycleService()
