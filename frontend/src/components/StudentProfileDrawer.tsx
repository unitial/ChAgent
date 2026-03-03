import { useEffect, useState } from 'react'
import {
  Drawer, Descriptions, Tag, List, Typography, Tabs,
  Button, Space, Modal, Form, Input, Popconfirm, message, Spin, Empty,
} from 'antd'
import { EditOutlined, DeleteOutlined, SyncOutlined, PlusOutlined, EyeOutlined } from '@ant-design/icons'
import type { Student, Conversation, ProfileAspect } from '../api'
import {
  getStudentProfile,
  updateProfileAspect,
  deleteProfileAspect,
  triggerStudentProfileUpdate,
} from '../api'
import dayjs from 'dayjs'

function SystemPromptView({ prompt }: { prompt: string }) {
  const sections: { title: string; content: string }[] = []
  const skillsIdx = prompt.indexOf('\n## Teacher-Configured Skills')
  const profileIdx = prompt.search(/\n## Student (Knowledge Profile|Profile)/)

  const cut = (start: number, end: number) => prompt.slice(start, end === -1 ? undefined : end).trim()
  const baseEnd = skillsIdx !== -1 ? skillsIdx : profileIdx !== -1 ? profileIdx : -1
  sections.push({ title: '基础指令', content: cut(0, baseEnd) })
  if (skillsIdx !== -1) {
    const end = profileIdx !== -1 && profileIdx > skillsIdx ? profileIdx : -1
    sections.push({ title: 'Teacher Skills', content: cut(skillsIdx, end) })
  }
  if (profileIdx !== -1) {
    sections.push({ title: '学生画像', content: cut(profileIdx, -1) })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxHeight: '60vh', overflowY: 'auto' }}>
      {sections.map((s, i) => (
        <div key={i}>
          <Typography.Text type="secondary" style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1 }}>
            {s.title}
          </Typography.Text>
          <pre style={{ margin: '4px 0 0', background: '#f6f8fa', borderRadius: 6, padding: '10px 12px', fontSize: 12, lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word', border: '1px solid #e8e8e8', fontFamily: 'ui-monospace, Consolas, monospace' }}>
            {s.content}
          </pre>
        </div>
      ))}
    </div>
  )
}

interface Props {
  student: Student | null
  conversations: Conversation[]
  open: boolean
  onClose: () => void
}

export default function StudentProfileDrawer({ student, conversations, open, onClose }: Props) {
  const [aspects, setAspects] = useState<ProfileAspect[]>([])
  const [profileLoading, setProfileLoading] = useState(false)
  const [updating, setUpdating] = useState(false)

  // Edit modal state
  const [editAspect, setEditAspect] = useState<ProfileAspect | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [editForm] = Form.useForm()
  const [editSaving, setEditSaving] = useState(false)
  const [viewingPrompt, setViewingPrompt] = useState<string | null>(null)

  const fetchProfile = () => {
    if (!student) return
    setProfileLoading(true)
    getStudentProfile(student.id)
      .then((res) => setAspects(res.data))
      .catch(() => setAspects([]))
      .finally(() => setProfileLoading(false))
  }

  useEffect(() => {
    if (open && student) fetchProfile()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, student?.id])

  if (!student) return null

  const handleUpdate = async () => {
    setUpdating(true)
    try {
      await triggerStudentProfileUpdate(student.id)
      message.info('画像更新已在后台启动，完成后请点击「刷新」查看结果')
    } catch {
      message.error('启动更新失败')
    } finally {
      setUpdating(false)
    }
  }

  const openEdit = (aspect: ProfileAspect | null) => {
    setIsNew(aspect === null)
    setEditAspect(aspect)
    editForm.setFieldsValue(
      aspect
        ? { slug: aspect.slug, name: aspect.name, content: aspect.content }
        : { slug: '', name: '', content: '' }
    )
  }

  const handleEditSave = async () => {
    const values = await editForm.validateFields()
    setEditSaving(true)
    try {
      await updateProfileAspect(student.id, values.slug, { name: values.name, content: values.content })
      message.success(isNew ? '已新增维度' : '已更新')
      setEditAspect(null)
      fetchProfile()
    } catch {
      message.error('保存失败')
    } finally {
      setEditSaving(false)
    }
  }

  const handleDelete = async (slug: string) => {
    try {
      await deleteProfileAspect(student.id, slug)
      message.success('已删除')
      fetchProfile()
    } catch {
      message.error('删除失败')
    }
  }

  // ── Knowledge profile tab ──
  const knowledgeTab = (
    <div>
      <Space style={{ marginBottom: 12 }}>
        <Button
          icon={<SyncOutlined spin={updating} />}
          size="small"
          loading={updating}
          onClick={handleUpdate}
        >
          AI 更新画像
        </Button>
        <Button icon={<PlusOutlined />} size="small" onClick={() => openEdit(null)}>
          手动添加维度
        </Button>
        <Button size="small" onClick={fetchProfile}>
          刷新
        </Button>
      </Space>

      {profileLoading ? (
        <Spin />
      ) : aspects.length === 0 ? (
        <Empty description="暂无画像数据，点击「AI 更新画像」生成" />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {aspects.map((aspect) => (
            <div
              key={aspect.slug}
              style={{
                border: '1px solid #f0f0f0',
                borderRadius: 8,
                padding: '12px 16px',
              }}
            >
              <Space style={{ marginBottom: 6, width: '100%', justifyContent: 'space-between' }}>
                <Space>
                  <Typography.Text strong>{aspect.name}</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    {aspect.slug}
                  </Typography.Text>
                  {aspect.updated_at && (
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                      · 更新于 {dayjs(aspect.updated_at).format('MM-DD HH:mm')}
                    </Typography.Text>
                  )}
                </Space>
                <Space size={4}>
                  <Button
                    icon={<EditOutlined />}
                    size="small"
                    type="text"
                    onClick={() => openEdit(aspect)}
                  />
                  <Popconfirm title="确认删除此维度？" onConfirm={() => handleDelete(aspect.slug)}>
                    <Button icon={<DeleteOutlined />} size="small" type="text" danger />
                  </Popconfirm>
                </Space>
              </Space>
              <Typography.Paragraph
                style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 13 }}
              >
                {aspect.content}
              </Typography.Paragraph>
            </div>
          ))}
        </div>
      )}
    </div>
  )

  // ── Legacy profile tab ──
  const profile = student.profile_json || {}
  const mastery = profile.topic_mastery || {}
  const mistakes = profile.common_mistakes || []
  const getMasteryColor = (level: number) => (level >= 8 ? 'green' : level >= 5 ? 'orange' : 'red')

  const legacyTab = (
    <Descriptions column={1} bordered size="small">
      <Descriptions.Item label="学习风格">{profile.learning_style || '暂无数据'}</Descriptions.Item>
      <Descriptions.Item label="最近摘要">{profile.recent_summary || '暂无数据'}</Descriptions.Item>
      <Descriptions.Item label="知识点掌握">
        {Object.keys(mastery).length === 0 ? (
          <Typography.Text type="secondary">暂无数据</Typography.Text>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {Object.entries(mastery).map(([topic, level]) => (
              <Tag color={getMasteryColor(level as number)} key={topic}>
                {topic}: {level as number}/10
              </Tag>
            ))}
          </div>
        )}
      </Descriptions.Item>
      <Descriptions.Item label="常见错误">
        {mistakes.length === 0 ? (
          <Typography.Text type="secondary">暂无数据</Typography.Text>
        ) : (
          <List size="small" dataSource={mistakes} renderItem={(item) => <List.Item>{item as string}</List.Item>} />
        )}
      </Descriptions.Item>
    </Descriptions>
  )

  // ── Conversations tab ──
  const sessionMap = new Map<number, Conversation[]>()
  for (const c of conversations) {
    if (!sessionMap.has(c.session_id)) sessionMap.set(c.session_id, [])
    sessionMap.get(c.session_id)!.push(c)
  }

  const convTab = (
    <div style={{ maxHeight: 500, overflowY: 'auto' }}>
      {Array.from(sessionMap.entries()).map(([sessionId, msgs]) => (
        <div key={sessionId} style={{ marginBottom: 16 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Session #{sessionId}
          </Typography.Text>
          {msgs.map((msg) => (
            <div
              key={msg.id}
              style={{
                padding: '8px 12px',
                margin: '4px 0',
                borderRadius: 8,
                background: msg.role === 'user' ? '#f0f0f0' : '#e6f4ff',
                textAlign: msg.role === 'user' ? 'left' : 'right',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Typography.Text style={{ fontSize: 12, color: '#888' }}>
                  {msg.role === 'user' ? student.name : 'ChAgent'}
                </Typography.Text>
                {msg.role === 'assistant' && msg.system_prompt && (
                  <Button
                    icon={<EyeOutlined />}
                    size="small"
                    type="text"
                    style={{ fontSize: 11, color: '#aaa' }}
                    onClick={() => setViewingPrompt(msg.system_prompt!)}
                  >
                    查看请求
                  </Button>
                )}
              </div>
              <div style={{ textAlign: 'left' }}>{msg.content}</div>
            </div>
          ))}
        </div>
      ))}
    </div>
  )

  return (
    <>
      <Drawer title={`学生详情：${student.name}`} width={640} open={open} onClose={onClose}>
        <Tabs
          items={[
            { key: 'knowledge', label: '知识画像', children: knowledgeTab },
            { key: 'profile', label: '会话档案', children: legacyTab },
            { key: 'conversations', label: `对话记录 (${conversations.length})`, children: convTab },
          ]}
        />
      </Drawer>

      <Modal
        title={isNew ? '添加画像维度' : `编辑：${editAspect?.name}`}
        open={editAspect !== null || isNew}
        onOk={handleEditSave}
        onCancel={() => { setEditAspect(null); setIsNew(false) }}
        confirmLoading={editSaving}
        width={560}
        destroyOnClose
      >
        <Form form={editForm} layout="vertical">
          <Form.Item name="slug" label="维度 Slug（英文小写连字符）" rules={[{ required: true }]}>
            <Input placeholder="e.g. process-management" disabled={!isNew} />
          </Form.Item>
          <Form.Item name="name" label="维度名称" rules={[{ required: true }]}>
            <Input placeholder="e.g. 进程管理" />
          </Form.Item>
          <Form.Item name="content" label="内容" rules={[{ required: true }]}>
            <Input.TextArea rows={8} placeholder="描述学生在该方面的掌握情况、典型问题及学习建议..." />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="完整系统提示词"
        open={!!viewingPrompt}
        onCancel={() => setViewingPrompt(null)}
        footer={null}
        width={700}
      >
        {viewingPrompt && <SystemPromptView prompt={viewingPrompt} />}
      </Modal>
    </>
  )
}
