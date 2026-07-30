import { loggerService } from '@logger'
import { Navbar, NavbarCenter } from '@renderer/components/app/Navbar'
import JsonEditor from '@renderer/pages/device/JsonEditor'
import RpaTimelineEditor from '@renderer/pages/device/RpaTimelineEditor'
import { type RpaAppRole, rpaAppRoleRepository } from '@renderer/services/rpa/RpaAppRole'
import { defaultRpaModuleRegistry } from '@renderer/services/rpa/RpaDefaultRegistry'
import { RpaTaskValidator } from '@renderer/services/rpa/RpaTaskValidator'
import {
  getTemplateTask,
  type RpaTemplateRecord,
  rpaTemplateRepository
} from '@renderer/services/rpa/RpaTemplateRepository'
import type { RpaTask, RpaValidationIssue } from '@renderer/services/rpa/RpaTypes'
import { Alert, Button, Input, message, Select, Tag, Typography } from 'antd'
import { ArrowLeft, Save } from 'lucide-react'
import type { FC } from 'react'
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import styled from 'styled-components'

const logger = loggerService.withContext('RpaTemplateEditor')
const validator = new RpaTaskValidator(defaultRpaModuleRegistry, { requireDeviceIds: false })

const RpaTemplateEditor: FC = () => {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [template, setTemplate] = useState<RpaTemplateRecord>()
  const [task, setTask] = useState<RpaTask>(createDefaultTask)
  const [name, setName] = useState(task.name)
  const [goal, setGoal] = useState(task.goal)
  const [tags, setTags] = useState<string[]>([])
  const [json, setJson] = useState(() => JSON.stringify(task, null, 2))
  const [issues, setIssues] = useState<RpaValidationIssue[]>([])
  const [jsonError, setJsonError] = useState<string>()
  const [loading, setLoading] = useState(Boolean(id))
  const [roles, setRoles] = useState<RpaAppRole[]>([])
  const [roleId, setRoleId] = useState<string>()

  useEffect(() => {
    let disposed = false
    void rpaAppRoleRepository
      .getAll()
      .then((items) => {
        if (disposed) return
        setRoles(items)
      })
      .catch((error) => {
        logger.error('Failed to load RPA Roles for task flow editor', { error })
        message.error('加载 RPA 角色失败')
      })
    return () => {
      disposed = true
    }
  }, [])

  useEffect(() => {
    setRoleId((current) => (current && roles.some((role) => role.id === current) ? current : roles[0]?.id))
  }, [roles])

  useEffect(() => {
    if (!id) return
    void rpaTemplateRepository
      .getById(id)
      .then((record) => {
        if (!record) {
          message.error('任务流不存在')
          navigate('/rpa-workflows')
          return
        }
        setTemplate(record)
        setName(record.name)
        setGoal(record.goal)
        setTags(record.tags)
        setJson(JSON.stringify(record.dsl, null, 2))
        setIssues(record.validationIssues)
        if (record.role?.id) setRoleId(record.role.id)
        const validated = getTemplateTask(record)
        if (validated) setTask(validated)
      })
      .catch((error) => {
        logger.error('Failed to load RPA template', { error, templateId: id })
        message.error('加载任务流失败')
      })
      .finally(() => setLoading(false))
  }, [id, navigate])

  const applyJson = (value = json) => {
    try {
      const parsed = JSON.parse(value)
      setJsonError(undefined)
      const validation = validator.validate(parsed)
      setIssues(validation.issues)
      if (validation.task) {
        setTask(validation.task)
        setName(validation.task.name)
        setGoal(validation.task.goal)
      }
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : String(error))
    }
  }

  const updateTask = (next: RpaTask) => {
    setTask(next)
    setName(next.name)
    setGoal(next.goal)
    setJson(JSON.stringify(next, null, 2))
    setIssues(validator.validate(next).issues)
  }

  const save = async () => {
    const selectedRole = roles.find((role) => role.id === roleId)
    if (!selectedRole) {
      message.error('请先选择执行该任务流的 RPA Role')
      return
    }
    let dsl: unknown
    try {
      dsl = JSON.parse(json)
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : String(error))
      message.error('JSON 语法错误，无法保存')
      return
    }
    if (dsl && typeof dsl === 'object' && !Array.isArray(dsl)) dsl = { ...dsl, name, goal }
    try {
      const saved = await rpaTemplateRepository.save({
        id: template?.id,
        name,
        goal,
        dsl,
        tags,
        skillLinks: template?.skillLinks,
        role: { id: selectedRole.id, version: selectedRole.version }
      })
      setTemplate(saved)
      setIssues(saved.validationIssues)
      message.success(saved.status === 'executable' ? '可执行任务流已保存' : '任务流已保存为不可执行草稿')
      if (!id) navigate(`/rpa-workflows/edit/${saved.id}`, { replace: true })
    } catch (error) {
      logger.error('Failed to save RPA template', { error, templateId: template?.id })
      message.error('保存任务流失败')
    }
  }

  return (
    <Page>
      <Navbar>
        <NavbarCenter style={{ borderRight: 'none' }}>{id ? '编辑 RPA 任务流' : '新建 RPA 任务流'}</NavbarCenter>
      </Navbar>
      <ContentContainer id="content-container">
        <Content>
          <Header>
            <Button type="text" icon={<ArrowLeft size={17} />} onClick={() => navigate('/rpa-workflows')}>
              返回
            </Button>
            <Button icon={<Save size={16} />} onClick={() => void save()}>
              保存
            </Button>
          </Header>
          <Metadata>
            <label>
              <Typography.Text type="secondary">任务流名称</Typography.Text>
              <Input value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label>
              <Typography.Text type="secondary">任务目标</Typography.Text>
              <Input.TextArea
                value={goal}
                autoSize={{ minRows: 3, maxRows: 8 }}
                onChange={(event) => setGoal(event.target.value)}
              />
            </label>
            <label>
              <Typography.Text type="secondary">标签</Typography.Text>
              <Input
                value={tags.join(', ')}
                placeholder="逗号分隔"
                onChange={(event) =>
                  setTags(
                    event.target.value
                      .split(',')
                      .map((value) => value.trim())
                      .filter(Boolean)
                  )
                }
              />
            </label>
            <label>
              <Typography.Text type="secondary">执行 Role</Typography.Text>
              <Select
                placeholder="选择任务流所需的 RPA Role"
                value={roleId}
                options={roles.map((role) => ({ value: role.id, label: `${role.name} · v${role.version}` }))}
                onChange={setRoleId}
              />
            </label>
          </Metadata>
          {template?.skillLinks.length ? (
            <SkillLinks>
              <Typography.Text type="secondary">关联 Skill（只读）</Typography.Text>
              {template.skillLinks.map((link) => (
                <Tag key={`${link.skillId}@${link.version}`}>
                  {link.skillId}@{link.version}
                </Tag>
              ))}
            </SkillLinks>
          ) : null}
          {issues.length > 0 && (
            <Alert
              type="warning"
              showIcon
              message={`当前草稿有 ${issues.length} 个校验问题`}
              description={issues
                .slice(0, 5)
                .map((issue) => `${issue.path}: ${issue.message}`)
                .join('\n')}
            />
          )}
          {!loading && !jsonError && issues.length === 0 && (
            <RpaTimelineEditor task={task} issues={issues} onChange={updateTask} />
          )}
          <DslSection>
            <Typography.Title level={5}>高级 DSL 编辑器</Typography.Title>
            <JsonEditor
              value={json}
              onChange={setJson}
              onBlur={applyJson}
              error={jsonError}
              height="420px"
              minHeight="260px"
              maxHeight="70vh"
              resizable
              ariaLabel="RPA DSL JSON 编辑器"
            />
          </DslSection>
        </Content>
      </ContentContainer>
    </Page>
  )
}

function createDefaultTask(): RpaTask {
  return {
    id: `rpa-task-${Date.now()}`,
    name: '新 RPA 任务',
    goal: '描述任务完成后的业务结果',
    deviceIds: [],
    steps: [
      {
        id: 'step-1',
        name: '打开应用',
        moduleId: 'launch_app',
        params: { packageName: 'com.example.app' },
        verify: { type: 'foreground_app', packageName: 'com.example.app' },
        continueOnFailure: false
      }
    ],
    metadata: {}
  }
}

const Page = styled.div`display: flex; min-width: 0; min-height: 0; flex: 1; flex-direction: column;`
const ContentContainer = styled.div`display: flex; min-width: 0; min-height: 0; flex: 1; overflow: auto;`
const Content = styled.main`display: flex; width: 100%; max-width: 1120px; min-width: 0; margin: 0 auto; padding: 18px 24px 40px; box-sizing: border-box; flex-direction: column; gap: 14px;`
const Header = styled.div`display: flex; width: 100%; min-width: 0; align-items: center; justify-content: space-between; gap: 12px; button { flex: none; }`
const Metadata = styled.div`
  display: flex; min-width: 0; flex-direction: column; gap: 12px;
  label { display: flex; min-width: 0; flex-direction: column; gap: 5px; }
  .ant-input, .ant-input-textarea, .ant-select { width: 100%; min-width: 0; }
`
const SkillLinks = styled.div`display: flex; align-items: center; gap: 6px; flex-wrap: wrap;`
const DslSection = styled.section`.ant-typography { margin: 0 0 6px; }`

export default RpaTemplateEditor
