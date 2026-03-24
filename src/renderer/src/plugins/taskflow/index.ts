// 注意：在实际项目中需要正确导入
// import { registerPlugin } from '@renderer/core/plugins'

// 临时定义
const registerPlugin = (plugin: any) => {
  console.log('注册插件:', plugin.name)
}
import TaskFlowEditor from './components/TaskFlowEditor'
import TaskList from './components/TaskList'
import TaskLogs from './components/TaskLogs'
import taskStore from './store/taskStore'

const TaskFlowPlugin = {
  id: 'taskflow',
  name: 'AI自动化任务流',
  description: '安卓微信消息监听与自动回复任务流',
  version: '1.0.0',
  icon: 'Flow',

  menu: {
    name: '任务流',
    path: '/taskflow',
    children: [
      {
        name: '任务列表',
        path: '/taskflow/list',
        component: TaskList
      },
      {
        name: '创建任务',
        path: '/taskflow/create',
        component: TaskFlowEditor
      },
      {
        name: '任务日志',
        path: '/taskflow/logs',
        component: TaskLogs
      }
    ]
  },

  routes: [
    {
      path: '/taskflow',
      redirect: '/taskflow/list'
    },
    {
      path: '/taskflow/list',
      component: TaskList
    },
    {
      path: '/taskflow/create',
      component: TaskFlowEditor
    },
    {
      path: '/taskflow/edit/:id',
      component: TaskFlowEditor
    },
    {
      path: '/taskflow/logs',
      component: TaskLogs
    }
  ],

  // 插件初始化
  init: () => {
    console.log('TaskFlow plugin initialized')
    // 初始化任务存储
    taskStore.init()
  },

  // 插件卸载
  destroy: () => {
    console.log('TaskFlow plugin destroyed')
  }
}

// 注册插件
registerPlugin(TaskFlowPlugin)

export default TaskFlowPlugin
