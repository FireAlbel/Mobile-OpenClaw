import { deviceServiceProxy } from '@renderer/services/DeviceServiceProxy'

async function testDeviceService() {
  console.log('Testing Device Service...')

  try {
    // 获取设备列表
    const devices = await deviceServiceProxy.getDevices()
    console.log('Devices:', devices)

    // 如果有设备，尝试获取设备信息
    if (devices.length > 0) {
      for (const device of devices) {
        console.log(`Device Info for ${device.id}:`, device)
      }
    }
  } catch (error) {
    console.error('Test failed:', error)
  }
}

// 运行测试
testDeviceService().catch(console.error)
