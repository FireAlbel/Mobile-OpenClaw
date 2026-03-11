// 测试设备模块功能
const { exec } = require('child_process')
const { promisify } = require('util')

const execAsync = promisify(exec)

async function testDeviceModule() {
  console.log('=== 测试设备模块功能 ===\n')

  try {
    // 1. 测试ADB是否可用
    console.log('1. 测试ADB可用性...')
    const adbResult = await execAsync('adb version')
    console.log('✅ ADB可用:', adbResult.stdout.trim())

    // 2. 测试设备列表
    console.log('\n2. 测试设备列表...')
    const devicesResult = await execAsync('adb devices')
    console.log('📱 设备列表:')
    console.log(devicesResult.stdout)

    // 3. 测试scrcpy
    console.log('\n3. 测试Scrcpy...')
    const scrcpyResult = await execAsync('scrcpy --version')
    console.log('✅ Scrcpy可用:', scrcpyResult.stdout.split('\n')[0])

    // 4. 测试ADB命令
    console.log('\n4. 测试ADB基本命令...')
    const propsResult = await execAsync('adb shell getprop ro.product.model')
    console.log('📱 设备型号:', propsResult.stdout.trim())

    console.log('\n🎉 所有测试通过！设备模块可以正常工作。')

  } catch (error) {
    console.error('❌ 测试失败:', error.message)
    console.log('\n💡 建议:')
    console.log('- 确保ADB和scrcpy已正确安装')
    console.log('- 确保设备已连接并启用USB调试')
    console.log('- 如果使用模拟器，请确保模拟器已启动')
  }
}

testDeviceModule()
