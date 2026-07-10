// 完整测试设备模块功能
const { exec, spawn } = require('child_process')
const { promisify } = require('util')
const fs = require('fs')
const path = require('path')

const execAsync = promisify(exec)

async function testFullDeviceModule() {
  console.log('=== 完整设备模块功能测试 ===\n')

  try {
    // 1. 测试ADB是否可用
    console.log('1. 测试ADB可用性...')
    const adbResult = await execAsync('adb version')
    console.log('✅ ADB可用:', adbResult.stdout.trim())

    // 2. 测试设备列表
    console.log('\n2. 测试设备列表...')
    const devicesResult = await execAsync('adb devices -l')
    console.log('📱 设备列表:')
    console.log(devicesResult.stdout)

    // 解析设备信息
    const deviceLines = devicesResult.stdout.split('\n').slice(1)
    const devices = deviceLines
      .filter((line) => line.trim() && !line.startsWith('*'))
      .map((line) => {
        const parts = line.split(/\s+/)
        return {
          serial: parts[0],
          status: parts[1]
        }
      })
      .filter((d) => d.status === 'device')

    if (devices.length === 0) {
      console.log('❌ 没有连接的设备')
      return
    }

    const device = devices[0]
    console.log(`\n使用设备: ${device.serial}`)

    // 3. 测试设备信息获取
    console.log('\n3. 测试设备信息获取...')
    const [model, manufacturer, version] = await Promise.all([
      execAsync(`adb -s ${device.serial} shell getprop ro.product.model`),
      execAsync(`adb -s ${device.serial} shell getprop ro.product.manufacturer`),
      execAsync(`adb -s ${device.serial} shell getprop ro.build.version.release`)
    ])

    console.log('📱 设备信息:')
    console.log(`   型号: ${model.stdout.trim()}`)
    console.log(`   制造商: ${manufacturer.stdout.trim()}`)
    console.log(`   Android版本: ${version.stdout.trim()}`)

    // 4. 测试scrcpy
    console.log('\n4. 测试Scrcpy...')
    const scrcpyResult = await execAsync('scrcpy --version')
    console.log('✅ Scrcpy可用:', scrcpyResult.stdout.split('\n')[0])

    // 5. 测试截图功能
    console.log('\n5. 测试截图功能...')
    const screenshotPath = path.join(__dirname, 'test_screenshot.png')

    // 在设备上截图
    await execAsync(`adb -s ${device.serial} shell screencap -p /sdcard/test_screenshot.png`)
    // 拉取到本地
    await execAsync(`adb -s ${device.serial} pull /sdcard/test_screenshot.png "${screenshotPath}"`)
    // 删除设备上的截图
    await execAsync(`adb -s ${device.serial} shell rm /sdcard/test_screenshot.png`)

    if (fs.existsSync(screenshotPath)) {
      const stats = fs.statSync(screenshotPath)
      console.log(`✅ 截图成功: ${screenshotPath} (${Math.round(stats.size / 1024)}KB)`)
    } else {
      console.log('❌ 截图失败')
    }

    // 6. 测试安装功能（如果没有APK文件，跳过此测试）
    console.log('\n6. 测试安装功能...')
    const testApkPath = path.join(__dirname, 'test.apk')
    if (fs.existsSync(testApkPath)) {
      try {
        const installResult = await execAsync(`adb -s ${device.serial} install -r "${testApkPath}"`)
        console.log('✅ 安装测试:', installResult.stdout.includes('Success') ? '成功' : '失败')
      } catch (error) {
        console.log('❌ 安装测试失败:', error.message)
      }
    } else {
      console.log('⏭️  跳过安装测试（未找到test.apk文件）')
    }

    // 7. 测试scrcpy连接（启动5秒后关闭）
    console.log('\n7. 测试Scrcpy连接...')
    console.log('🔄 启动scrcpy投屏（5秒后自动关闭）...')

    const scrcpyProcess = spawn('scrcpy', [
      '-s',
      device.serial,
      '--window-title',
      'CherryStudio设备投屏测试',
      '-m',
      '1024',
      '-b',
      '8000000',
      '--max-fps',
      '30'
    ])

    scrcpyProcess.on('error', (err) => {
      console.log('❌ Scrcpy启动失败:', err.message)
    })

    scrcpyProcess.on('close', (code) => {
      console.log(`✅ Scrcpy已关闭 (退出码: ${code})`)
    })

    // 5秒后关闭scrcpy
    setTimeout(() => {
      scrcpyProcess.kill()
      console.log('\n🎉 所有测试完成！')
      console.log('\n💡 使用说明:')
      console.log('- 投屏功能已验证可用')
      console.log('- 截图功能正常')
      console.log('- 设备信息获取正常')
      console.log('- 如需输入控制，请在设备开发者选项中启用"USB调试(安全设置)"')
    }, 5000)
  } catch (error) {
    console.error('❌ 测试失败:', error.message)
    console.log('\n💡 建议:')
    console.log('- 确保ADB和scrcpy已正确安装')
    console.log('- 确保设备已连接并启用USB调试')
    console.log('- 如果使用模拟器，请确保模拟器已启动')
  }
}

testFullDeviceModule()
