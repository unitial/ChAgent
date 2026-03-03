import { useState, useEffect, useRef } from 'react'
import { Table, Button, Input, Space, Tag, Typography, message, Popconfirm } from 'antd'
import { UploadOutlined, DeleteOutlined, ReloadOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { getTextbooks, uploadTextbook, deleteTextbook, Textbook } from '../api'

const STATUS_COLOR: Record<string, string> = {
  pending: 'default',
  indexing: 'processing',
  ready: 'success',
  error: 'error',
}

const STATUS_LABEL: Record<string, string> = {
  pending: '等待中',
  indexing: '索引中',
  ready: '就绪',
  error: '错误',
}

export default function Textbooks() {
  const [textbooks, setTextbooks] = useState<Textbook[]>([])
  const [loading, setLoading] = useState(false)
  const [uploadName, setUploadName] = useState('')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    fetchTextbooks()
    return () => stopPolling()
  }, [])

  async function fetchTextbooks() {
    setLoading(true)
    try {
      const res = await getTextbooks()
      setTextbooks(res.data)
      maybeStartPolling(res.data)
    } catch {
      message.error('获取教材列表失败')
    } finally {
      setLoading(false)
    }
  }

  function maybeStartPolling(items: Textbook[]) {
    const hasPending = items.some(t => t.status === 'pending' || t.status === 'indexing')
    if (hasPending && !pollingRef.current) {
      pollingRef.current = setInterval(async () => {
        const res = await getTextbooks()
        setTextbooks(res.data)
        const stillPending = res.data.some((t: Textbook) => t.status === 'pending' || t.status === 'indexing')
        if (!stillPending) stopPolling()
      }, 3000)
    }
  }

  function stopPolling() {
    if (pollingRef.current) {
      clearInterval(pollingRef.current)
      pollingRef.current = null
    }
  }

  async function handleUpload() {
    if (!selectedFile) {
      message.warning('请先选择 PDF 文件')
      return
    }
    const name = uploadName.trim() || selectedFile.name
    setUploading(true)
    try {
      const res = await uploadTextbook(name, selectedFile)
      setTextbooks(prev => [res.data, ...prev])
      setUploadName('')
      setSelectedFile(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
      message.success('上传成功，正在后台索引')
      maybeStartPolling([res.data])
    } catch {
      message.error('上传失败')
    } finally {
      setUploading(false)
    }
  }

  async function handleDelete(id: number) {
    try {
      await deleteTextbook(id)
      setTextbooks(prev => prev.filter(t => t.id !== id))
      message.success('已删除')
    } catch {
      message.error('删除失败')
    }
  }

  const columns: ColumnsType<Textbook> = [
    {
      title: '教材名称',
      dataIndex: 'name',
      key: 'name',
      render: (name: string) => <Typography.Text strong>{name}</Typography.Text>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status: string) => (
        <Tag color={STATUS_COLOR[status] || 'default'}>{STATUS_LABEL[status] || status}</Tag>
      ),
    },
    {
      title: '分块数',
      dataIndex: 'chunk_count',
      key: 'chunk_count',
      width: 90,
      render: (n: number) => n || '—',
    },
    {
      title: '上传时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 180,
      render: (s: string) => s ? new Date(s).toLocaleString('zh-CN') : '—',
    },
    {
      title: '备注',
      dataIndex: 'error_msg',
      key: 'error_msg',
      render: (msg: string | null) => msg ? (
        <Typography.Text type="danger" style={{ fontSize: 12 }}>{msg}</Typography.Text>
      ) : null,
    },
    {
      title: '操作',
      key: 'actions',
      width: 80,
      render: (_: unknown, record: Textbook) => (
        <Popconfirm title="确认删除该教材？" onConfirm={() => handleDelete(record.id)} okText="删除" cancelText="取消">
          <Button danger size="small" icon={<DeleteOutlined />} />
        </Popconfirm>
      ),
    },
  ]

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>教材管理</Typography.Title>
      <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
        上传 PDF 教材后，系统将自动提取文本并建立向量索引（首次启动需下载嵌入模型 ~471 MB）。
        学生提问时会自动检索相关片段作为 AI 回答依据。
      </Typography.Paragraph>

      {/* Upload form */}
      <Space style={{ marginBottom: 16 }} wrap>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf"
          style={{ display: 'none' }}
          onChange={e => {
            const f = e.target.files?.[0]
            if (f) setSelectedFile(f)
          }}
        />
        <Button icon={<UploadOutlined />} onClick={() => fileInputRef.current?.click()}>
          {selectedFile ? selectedFile.name : '选择 PDF 文件'}
        </Button>
        <Input
          placeholder="教材显示名称（可选，默认用文件名）"
          value={uploadName}
          onChange={e => setUploadName(e.target.value)}
          style={{ width: 280 }}
          onPressEnter={handleUpload}
        />
        <Button type="primary" loading={uploading} onClick={handleUpload} disabled={!selectedFile}>
          上传并索引
        </Button>
      </Space>

      <Table
        columns={columns}
        dataSource={textbooks}
        rowKey="id"
        loading={loading}
        pagination={false}
        size="middle"
        title={() => (
          <Space>
            <span>共 {textbooks.length} 本教材</span>
            <Button size="small" icon={<ReloadOutlined />} onClick={fetchTextbooks}>刷新</Button>
          </Space>
        )}
      />
    </div>
  )
}
