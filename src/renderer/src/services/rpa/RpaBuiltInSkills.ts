import type { RpaSkillRecord } from './RpaSkillRepository'

const createdAt = Date.UTC(2026, 7, 4)

export const androidSettingsAboutDeviceSkill: RpaSkillRecord = {
  id: 'android-settings-about-device',
  version: '1.0.0',
  name: 'Android 设置 - 关于本机',
  description: '通过确定性列表扫描打开 Android/OnePlus 设置中的关于本机页面。',
  status: 'ready',
  appPackage: 'com.android.settings',
  goals: ['打开关于本机', '进入关于手机', '查看设备信息', 'open about phone', 'open about device'],
  tags: ['android', 'settings', 'oneplus', 'oplus', 'zh-CN'],
  parameters: [],
  states: [
    {
      stateId: 'SETTINGS_ENTRY',
      label: '设置入口',
      aliases: [],
      priority: 0,
      packageNames: ['com.android.settings', 'com.oplus.multiapp'],
      activityIncludes: [],
      requiredTexts: [],
      anyTexts: [],
      excludedTexts: [],
      requireScreenshot: false,
      blockingCondition: 'none',
      recoveryScope: 'none',
      suggestedTransitions: ['SETTINGS_HOME']
    },
    {
      stateId: 'SETTINGS_HOME',
      label: '设置首页',
      aliases: ['SETTINGS_MAIN'],
      priority: 10,
      packageNames: ['com.android.settings'],
      activityIncludes: ['Settings', 'OplusSettingsHomepageActivity'],
      requiredTexts: [],
      anyTexts: ['设置', 'WLAN', '蓝牙', '移动网络'],
      excludedTexts: ['关于本机'],
      requireScreenshot: false,
      blockingCondition: 'none',
      recoveryScope: 'navigate',
      suggestedTransitions: ['ABOUT_ENTRY_VISIBLE']
    },
    {
      stateId: 'ABOUT_ENTRY_VISIBLE',
      label: '关于本机入口可见',
      aliases: [],
      priority: 20,
      packageNames: ['com.android.settings'],
      activityIncludes: [],
      requiredTexts: [],
      anyTexts: ['关于本机', '关于手机', '关于设备'],
      excludedTexts: [],
      requireScreenshot: false,
      blockingCondition: 'none',
      recoveryScope: 'navigate',
      suggestedTransitions: ['ABOUT_DEVICE']
    },
    {
      stateId: 'ABOUT_DEVICE',
      label: '关于本机',
      aliases: ['ABOUT_PHONE'],
      priority: 100,
      packageNames: ['com.android.settings'],
      activityIncludes: ['About', 'DeviceInfo'],
      requiredTexts: [],
      anyTexts: ['设备名称', 'Android 版本', '版本信息', '关于本机', '关于手机'],
      excludedTexts: [],
      requireScreenshot: true,
      blockingCondition: 'none',
      recoveryScope: 'none',
      suggestedTransitions: []
    }
  ],
  locators: [
    {
      id: 'about-device-entry',
      stateIds: ['SETTINGS_HOME', 'ABOUT_ENTRY_VISIBLE'],
      strategy: 'ui_text',
      value: '关于本机',
      aliases: ['关于手机', '关于设备', '设备信息', 'About phone', 'About device'],
      resourceIds: [],
      searchPolicy: {
        searchMode: 'current_then_exhaustive',
        resetToBoundary: true,
        resetDirection: 'down',
        scanDirection: 'up',
        maxResetSwipes: 10,
        maxScanSwipes: 24,
        noProgressLimit: 2,
        includeOcr: false,
        fallbackToVlm: true
      },
      fallbackLocatorIds: [],
      minConfidence: 0.8
    }
  ],
  entryStateIds: ['SETTINGS_ENTRY'],
  successStateIds: ['ABOUT_DEVICE'],
  transitions: [
    {
      id: 'launch-settings',
      fromStateIds: ['SETTINGS_ENTRY'],
      toStateId: 'SETTINGS_HOME',
      priority: 100,
      steps: [
        {
          id: 'launch-settings',
          name: '打开设置',
          moduleId: 'launch_app',
          params: { packageName: 'com.android.settings' },
          verify: { type: 'foreground_app', packageName: 'com.android.settings', settleMs: 800 },
          continueOnFailure: false
        }
      ]
    },
    {
      id: 'scan-about-entry',
      fromStateIds: ['SETTINGS_HOME'],
      toStateId: 'ABOUT_ENTRY_VISIBLE',
      priority: 100,
      steps: [
        {
          id: 'scan-about-entry',
          name: '完整扫描关于本机入口',
          moduleId: 'list.scan_target',
          params: { locatorId: 'about-device-entry' },
          verify: { type: 'module_result_success' },
          continueOnFailure: false
        }
      ]
    },
    {
      id: 'open-about-device',
      fromStateIds: ['ABOUT_ENTRY_VISIBLE'],
      toStateId: 'ABOUT_DEVICE',
      priority: 100,
      steps: [
        {
          id: 'tap-about-entry',
          name: '点击关于本机',
          moduleId: 'tap_by_vlm_target',
          params: { locatorId: 'about-device-entry', fallbackToVlm: true },
          verify: {
            type: 'app_state',
            packageName: 'com.android.settings',
            stateId: 'ABOUT_DEVICE',
            anyTexts: ['设备名称', 'Android 版本', '版本信息', '关于本机', '关于手机'],
            activityIncludes: ['About', 'DeviceInfo'],
            requiredTexts: [],
            minConfidence: 0.7
          },
          continueOnFailure: false
        },
        {
          id: 'capture-about-device',
          name: '截取关于本机页面',
          moduleId: 'screenshot',
          params: {},
          verify: { type: 'screenshot_exists' },
          continueOnFailure: false
        }
      ]
    }
  ],
  fallbackRules: [
    {
      stateId: 'SETTINGS_HOME',
      resumeStateId: 'SETTINGS_HOME',
      steps: [
        {
          id: 'back-to-settings-home',
          name: '返回设置上一级',
          moduleId: 'press_back',
          params: {},
          continueOnFailure: false
        }
      ]
    }
  ],
  successVerification: {
    type: 'app_state',
    packageName: 'com.android.settings',
    stateId: 'ABOUT_DEVICE',
    activityIncludes: ['About', 'DeviceInfo'],
    requiredTexts: [],
    anyTexts: ['设备名称', 'Android 版本', '版本信息', '关于本机', '关于手机'],
    minConfidence: 0.7
  },
  prohibitedModuleIds: ['app.ensure_foreground', 'app.ensure_home', 'app.ensure_state', 'restart_app'],
  metadata: {
    builtIn: true,
    localeScopes: ['zh-CN', 'en-US'],
    vendorScopes: ['oneplus', 'oplus', 'android'],
    navigationKind: 'deterministic_skill'
  },
  validationIssues: [],
  revisions: [],
  createdAt,
  updatedAt: createdAt
}

export const builtInRpaSkills: RpaSkillRecord[] = [androidSettingsAboutDeviceSkill]
