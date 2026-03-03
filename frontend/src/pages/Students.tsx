import { useEffect, useState } from 'react'
import { Table, Button, Typography, Input, Space, Modal, InputNumber, Progress, message, Tooltip, Tag, Badge, Dropdown } from 'antd'
import { EyeOutlined, ControlOutlined, SyncOutlined, DownOutlined } from '@ant-design/icons'
import {
  getStudents, setStudentLimit, getStudentConversations,
  triggerAllProfileUpdates, triggerStudentProfileUpdate,
  getProfileUpdateStatus,
  type Student, type Conversation,
} from '../api'
import StudentProfileDrawer from '../components/StudentProfileDrawer'
import dayjs from 'dayjs'

export default function Students() {
  const [students, setStudents] = useState<Student[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [selectedStudent, setSelectedStudent] = useState<Student | null>(null)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [updatingAll, setUpdatingAll] = useState(false)
  const [updateStatus, setUpdateStatus] = useState<{ total: number; needs_update: number } | null>(null)

  // Limit modal state
  const [limitStudent, setLimitStudent] = useState<Student | null>(null)
  const [limitValue, setLimitValue] = useState<number | null>(null)
  const [savingLimit, setSavingLimit] = useState(false)

  const fetchStudents = () => {
    setLoading(true)
    getStudents()
      .then((res) => setStudents(res.data))
      .finally(() => setLoading(false))
  }

  const fetchUpdateStatus = () => {
    getProfileUpdateStatus()
      .then((res) => setUpdateStatus(res.data))
      .catch(() => {})
  }

  useEffect(() => {
    fetchStudents()
    fetchUpdateStatus()
  }, [])

  const openDrawer = async (student: Student) => {
    setSelectedStudent(student)
    setDrawerOpen(true)
    const res = await getStudentConversations(student.id)
    setConversations(res.data)
  }

  const openLimitModal = (student: Student) => {
    setLimitStudent(student)
    setLimitValue(student.daily_token_limit ?? null)
  }

  const handleUpdateAll = async (force = false) => {
    setUpdatingAll(true)
    try {
      await triggerAllProfileUpdates(force)
      message.success(force ? '强制更新全部画像任务已启动' : '智能更新画像任务已启动（仅更新有新对话的学生）')
      fetchUpdateStatus()
    } catch {
      message.error('启动失败')
    } finally {
      setUpdatingAll(false)
    }
  }

  const handleSaveLimit = async () => {
    if (!limitStudent) return
    setSavingLimit(true)
    try {
      await setStudentLimit(limitStudent.id, limitValue)
      message.success('用量上限已更新')
      setLimitStudent(null)
      fetchStudents()
    } catch {
      message.error('更新失败')
    } finally {
      setSavingLimit(false)
    }
  }

  const filtered = students.filter((s) =>
    s.name.toLowerCase().includes(search.toLowerCase()),
  )

  const columns = [
    { title: '姓名', dataIndex: 'name', key: 'name' },
    {
      title: '飞书 ID',
      dataIndex: 'feishu_user_id',
      key: 'feishu_user_id',
      ellipsis: true,
      render: (v: string | null) => v || '(网页用户)',
    },
    {
      title: '注册时间',
      dataIndex: 'created_at',
      key: 'created_at',
      render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm'),
    },
    {
      title: '画像维度',
      key: 'style',
      render: (_: unknown, record: Student) => {
        if (record.profile_aspects && record.profile_aspects.length > 0) {
          return (
            <Space size={4} wrap>
              {record.profile_aspects.map(a => (
                <Tag key={a} color="blue" style={{ fontSize: 11, margin: 0 }}>{a}</Tag>
              ))}
            </Space>
          )
        }
        const style = record.profile_json?.learning_style
        return style ? <span>{style}</span> : <span style={{ color: '#bbb' }}>—</span>
      },
    },
    {
      title: '画像更新',
      key: 'profile_updated',
      width: 160,
      render: (_: unknown, record: Student) => {
        const timeText = record.profile_updated_at
          ? dayjs(record.profile_updated_at).format('MM-DD HH:mm')
          : '未更新'
        return record.needs_profile_update ? (
          <Badge color="orange" text={<span style={{ fontSize: 12 }}>{timeText}</span>} />
        ) : (
          <span style={{ fontSize: 12, color: '#888' }}>{timeText}</span>
        )
      },
    },
    {
      title: '今日用量',
      key: 'usage',
      width: 180,
      render: (_: unknown, record: Student) => {
        const used = record.today_tokens
        const limit = record.daily_token_limit
        if (!limit) {
          return (
            <Space size={4}>
              <span style={{ fontSize: 12, color: '#888' }}>{used.toLocaleString()} tokens</span>
              <span style={{ fontSize: 11, color: '#bbb' }}>（无限制）</span>
            </Space>
          )
        }
        const pct = Math.min(100, Math.round((used / limit) * 100))
        return (
          <div style={{ minWidth: 140 }}>
            <Progress
              percent={pct}
              size="small"
              status={pct >= 100 ? 'exception' : pct >= 80 ? 'active' : 'normal'}
              format={() => `${pct}%`}
            />
            <span style={{ fontSize: 11, color: '#888' }}>
              {used.toLocaleString()} / {limit.toLocaleString()}
            </span>
          </div>
        )
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 120,
      render: (_: unknown, record: Student) => (
        <Space size={4}>
          <Tooltip title="详情">
            <Button icon={<EyeOutlined />} size="small" onClick={() => openDrawer(record)} />
          </Tooltip>
          <Tooltip title="用量上限">
            <Button icon={<ControlOutlined />} size="small" onClick={() => openLimitModal(record)} />
          </Tooltip>
          <Tooltip title="更新画像">
            <Button
              icon={<SyncOutlined />}
              size="small"
              onClick={async () => {
                try {
                  await triggerStudentProfileUpdate(record.id)
                  message.success(`${record.name} 的画像更新任务已启动`)
                } catch {
                  message.error('启动失败')
                }
              }}
            />
          </Tooltip>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <Space style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between' }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          学生管理
        </Typography.Title>
        <Space>
          <Dropdown.Button
            icon={<DownOutlined />}
            loading={updatingAll}
            onClick={() => handleUpdateAll(false)}
            menu={{
              items: [
                {
                  key: 'force',
                  label: '强制更新全部',
                  icon: <SyncOutlined />,
                  onClick: () => handleUpdateAll(true),
                },
              ],
            }}
          >
            <SyncOutlined spin={updatingAll} />
            更新全部画像
            {updateStatus && updateStatus.needs_update > 0 && (
              <Tag color="orange" style={{ marginLeft: 6, fontSize: 11 }}>
                需更新 {updateStatus.needs_update} 人
              </Tag>
            )}
          </Dropdown.Button>
          <Input.Search
            placeholder="搜索学生姓名"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 240 }}
            allowClear
          />
        </Space>
      </Space>
      <Table
        rowKey="id"
        columns={columns}
        dataSource={filtered}
        loading={loading}
        pagination={{ pageSize: 20 }}
      />
      <StudentProfileDrawer
        student={selectedStudent}
        conversations={conversations}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />

      <Modal
        title={`设置每日 Token 上限 — ${limitStudent?.name}`}
        open={!!limitStudent}
        onOk={handleSaveLimit}
        onCancel={() => setLimitStudent(null)}
        confirmLoading={savingLimit}
        okText="保存"
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            留空表示使用全局默认上限；设为 0 表示该学生无限制。
          </Typography.Text>
          <InputNumber
            min={0}
            step={1000}
            value={limitValue ?? undefined}
            onChange={(v) => setLimitValue(v)}
            placeholder="留空 = 全局默认"
            addonAfter="tokens / 天"
            style={{ width: '100%' }}
          />
        </Space>
      </Modal>
    </div>
  )
}
