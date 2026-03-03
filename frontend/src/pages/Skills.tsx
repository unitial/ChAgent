import { useEffect, useState } from 'react'
import {
  Table, Button, Space, Typography, Tag, Modal, Form,
  Input, Select, Switch, message, Popconfirm,
} from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { getSkills, createSkill, updateSkill, deleteSkill, autofillSkill, type Skill } from '../api'
import dayjs from 'dayjs'

const TYPE_LABELS: Record<string, string> = {
  knowledge_point: '知识点',
  teaching_strategy: '教学策略',
  global: '全局指令',
  profile_update: 'Profile更新',
  challenge: '挑战模式',
}

const TYPE_COLORS: Record<string, string> = {
  knowledge_point: 'blue',
  teaching_strategy: 'purple',
  global: 'gold',
  profile_update: 'geekblue',
  challenge: 'volcano',
}

export default function Skills() {
  const [skills, setSkills] = useState<Skill[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingSkill, setEditingSkill] = useState<Skill | null>(null)
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)
  const [filterType, setFilterType] = useState<string | undefined>(undefined)
  const [filterSource, setFilterSource] = useState<string | undefined>(undefined)
  const [autofillOpen, setAutofillOpen] = useState(false)
  const [autofillText, setAutofillText] = useState('')
  const [autofilling, setAutofilling] = useState(false)

  const fetchSkills = () => {
    setLoading(true)
    getSkills()
      .then((res) => setSkills(res.data))
      .finally(() => setLoading(false))
  }

  useEffect(fetchSkills, [])

  const openCreate = () => {
    setEditingSkill(null)
    form.resetFields()
    form.setFieldsValue({ enabled: true })
    setAutofillOpen(true)
    setAutofillText('')
    setModalOpen(true)
  }

  const openEdit = (skill: Skill) => {
    setEditingSkill(skill)
    form.setFieldsValue(skill)
    setAutofillOpen(false)
    setAutofillText('')
    setModalOpen(true)
  }

  const handleAutofill = async () => {
    if (!autofillText.trim()) return
    setAutofilling(true)
    try {
      const res = await autofillSkill(autofillText)
      form.setFieldsValue(res.data)
      message.success('已自动填充，请检查并按需调整')
    } catch {
      message.error('自动填充失败，请重试')
    } finally {
      setAutofilling(false)
    }
  }

  const handleSave = async () => {
    const values = await form.validateFields()
    setSaving(true)
    try {
      if (editingSkill) {
        await updateSkill(editingSkill.id, values)
        message.success('更新成功')
      } else {
        await createSkill(values)
        message.success('创建成功')
      }
      setModalOpen(false)
      fetchSkills()
    } catch {
      message.error('操作失败')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await deleteSkill(id)
      message.success('删除成功')
      fetchSkills()
    } catch {
      message.error('删除失败')
    }
  }

  const handleToggle = async (skill: Skill) => {
    try {
      await updateSkill(skill.id, { enabled: !skill.enabled })
      fetchSkills()
    } catch {
      message.error('操作失败')
    }
  }

  // Derive unique sources for filter dropdown
  const sourceOptions = Array.from(new Set(skills.map((s) => s.source).filter(Boolean))).map((s) => ({
    value: s,
    label: s,
  }))

  const filtered = skills.filter((s) => {
    if (filterType && s.type !== filterType) return false
    if (filterSource && s.source !== filterSource) return false
    return true
  })

  const columns = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      width: 220,
      render: (v: string, record: Skill) => (
        <Space direction="vertical" size={2}>
          <Space>
            {v}
            <Tag color={TYPE_COLORS[record.type]}>{TYPE_LABELS[record.type]}</Tag>
          </Space>
          {record.source && (
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {record.source}
            </Typography.Text>
          )}
        </Space>
      ),
    },
    {
      title: '内容预览',
      dataIndex: 'content',
      key: 'content',
      ellipsis: true,
      render: (v: string) => v.slice(0, 120) + (v.length > 120 ? '…' : ''),
    },
    {
      title: '启用',
      dataIndex: 'enabled',
      key: 'enabled',
      width: 64,
      render: (_: unknown, record: Skill) => (
        <Switch checked={record.enabled} onChange={() => handleToggle(record)} size="small" />
      ),
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 104,
      render: (v: string) => v ? dayjs(v).format('YYYY-MM-DD') : '-',
    },
    {
      title: '操作',
      key: 'action',
      width: 80,
      render: (_: unknown, record: Skill) => (
        <Space>
          <Button icon={<EditOutlined />} size="small" onClick={() => openEdit(record)} />
          <Popconfirm title="确认删除？" onConfirm={() => handleDelete(record.id)}>
            <Button icon={<DeleteOutlined />} size="small" danger />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <Space style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between' }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          Skills 管理
        </Typography.Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          新建 Skill
        </Button>
      </Space>

      <Space style={{ marginBottom: 12 }} wrap>
        <Select
          allowClear
          placeholder="按类型筛选"
          style={{ width: 140 }}
          value={filterType}
          onChange={setFilterType}
          options={Object.entries(TYPE_LABELS).map(([v, l]) => ({ value: v, label: l }))}
        />
        <Select
          allowClear
          placeholder="按来源筛选"
          style={{ width: 160 }}
          value={filterSource}
          onChange={setFilterSource}
          options={sourceOptions}
        />
      </Space>

      <Table rowKey="id" columns={columns} dataSource={filtered} loading={loading} />

      <Modal
        title={editingSkill ? '编辑 Skill' : '新建 Skill'}
        open={modalOpen}
        onOk={handleSave}
        onCancel={() => setModalOpen(false)}
        confirmLoading={saving}
        width={640}
      >
        {/* Auto-fill panel */}
        <div style={{ marginBottom: 16, padding: 12, background: '#f6f9ff', borderRadius: 8, border: '1px solid #d6e4ff' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Typography.Text strong style={{ fontSize: 13, color: '#1677ff' }}>
              <ThunderboltOutlined style={{ marginRight: 6 }} />
              AI 自动填充
            </Typography.Text>
            <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setAutofillOpen(o => !o)}>
              {autofillOpen ? '收起' : '展开'}
            </Button>
          </div>
          {autofillOpen && (
            <div style={{ marginTop: 10 }}>
              <Input.TextArea
                rows={5}
                placeholder="粘贴原始文本（讲义、论文、教材片段等），AI 将自动提取并填充下方字段"
                value={autofillText}
                onChange={e => setAutofillText(e.target.value)}
                style={{ marginBottom: 8 }}
              />
              <Button
                type="primary"
                ghost
                size="small"
                icon={<ThunderboltOutlined />}
                loading={autofilling}
                disabled={!autofillText.trim()}
                onClick={handleAutofill}
              >
                自动填充
              </Button>
            </div>
          )}
        </div>

        <Form form={form} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true }]}>
            <Input placeholder="例：进程调度算法解析" />
          </Form.Item>
          <Form.Item name="type" label="类型" rules={[{ required: true }]}>
            <Select options={Object.entries(TYPE_LABELS).map(([v, l]) => ({ value: v, label: l }))} />
          </Form.Item>
          <Form.Item name="content" label="内容" rules={[{ required: true }]}>
            <Input.TextArea
              rows={6}
              placeholder="输入教学内容、知识要点或指导策略..."
            />
          </Form.Item>
          <Form.Item name="description" label="简短说明">
            <Input placeholder="可选：对该 skill 的简短描述" />
          </Form.Item>
          <Form.Item name="source" label="来源">
            <Input placeholder="可选：如 Butler Lampson、课程教材等" />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
