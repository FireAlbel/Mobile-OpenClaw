import { loggerService } from '@logger'
import { rpaMcpSupplementProviderBridge } from '@renderer/services/rpa/RpaMcpSupplementProviderBridge'
import { useAppSelector } from '@renderer/store'
import type { FC } from 'react'
import { useEffect } from 'react'

const logger = loggerService.withContext('RpaSupplementProviderBootstrap')

const RpaSupplementProviderBootstrap: FC = () => {
  const servers = useAppSelector((state) => state.mcp.servers)

  useEffect(() => {
    void rpaMcpSupplementProviderBridge.synchronize(servers).catch((error) => {
      logger.warn('Failed to synchronize RPA Supplemental Providers', { error })
    })
  }, [servers])

  return null
}

export default RpaSupplementProviderBootstrap
