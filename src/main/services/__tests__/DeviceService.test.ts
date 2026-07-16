import { describe, expect, it } from 'vitest'

import {
  normalizeAdbStatus,
  parseAdbDevicesOutput,
  parseForegroundAppInfo,
  parseResolvedActivity
} from '../DeviceService'

describe('DeviceService utilities', () => {
  it('parses adb devices output', () => {
    const output = [
      'List of devices attached',
      'emulator-5554 device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 transport_id:1',
      'R58M12345 unauthorized usb:1-1 transport_id:2',
      '192.168.1.5:5555 offline transport_id:3'
    ].join('\n')

    expect(parseAdbDevicesOutput(output)).toEqual([
      { serial: 'emulator-5554', status: 'device', transportId: '1' },
      { serial: 'R58M12345', status: 'unauthorized', transportId: '2' },
      { serial: '192.168.1.5:5555', status: 'offline', transportId: '3' }
    ])
  })

  it('ignores adb daemon messages and blank lines', () => {
    const output = [
      '* daemon not running; starting now at tcp:5037',
      '* daemon started successfully',
      '',
      'List of devices attached',
      '',
      'device-1 device'
    ].join('\n')

    expect(parseAdbDevicesOutput(output)).toEqual([{ serial: 'device-1', status: 'device', transportId: undefined }])
  })

  it('normalizes adb statuses for the renderer', () => {
    expect(normalizeAdbStatus('device')).toBe('online')
    expect(normalizeAdbStatus('unauthorized')).toBe('unauthorized')
    expect(normalizeAdbStatus('offline')).toBe('offline')
    expect(normalizeAdbStatus('bootloader')).toBe('offline')
    expect(normalizeAdbStatus('anything-else')).toBe('offline')
  })

  it('parses foreground app info from dumpsys output', () => {
    expect(
      parseForegroundAppInfo('topResumedActivity=ActivityRecord{abc u0 com.example.app/.MainActivity t12}')
    ).toEqual({
      packageName: 'com.example.app',
      activity: '.MainActivity'
    })

    expect(
      parseForegroundAppInfo('mCurrentFocus=Window{abc u0 com.android.settings/com.android.settings.Settings}')
    ).toEqual({
      packageName: 'com.android.settings',
      activity: 'com.android.settings.Settings'
    })

    expect(parseForegroundAppInfo('  ACTIVITY com.example.top/.TopActivity 2650ddb pid=28897 userId=0')).toEqual({
      packageName: 'com.example.top',
      activity: '.TopActivity'
    })

    expect(
      parseForegroundAppInfo('ResumedActivity: ActivityRecord{123 u0 com.sankuai.meituan/.activity.MainActivity t42}')
    ).toEqual({
      packageName: 'com.sankuai.meituan',
      activity: '.activity.MainActivity'
    })

    expect(parseForegroundAppInfo('topActivity=ComponentInfo{com.sankuai.meituan/.home.HomeActivity}')).toEqual({
      packageName: 'com.sankuai.meituan',
      activity: '.home.HomeActivity'
    })

    expect(
      parseForegroundAppInfo(
        [
          '  ACTIVITY com.old.app/.OldActivity 2650ddb pid=28897 userId=0',
          '  topResumedActivity=ActivityRecord{123 u0 com.sankuai.meituan/.MainActivity t42}'
        ].join('\n')
      )
    ).toEqual({
      packageName: 'com.sankuai.meituan',
      activity: '.MainActivity'
    })
  })

  it('parses resolved launcher activity from cmd package output', () => {
    expect(
      parseResolvedActivity(
        [
          'priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=false',
          'com.sankuai.meituan/com.meituan.android.pt.homepage.activity.MainActivity'
        ].join('\n')
      )
    ).toBe('com.sankuai.meituan/com.meituan.android.pt.homepage.activity.MainActivity')
  })
})
