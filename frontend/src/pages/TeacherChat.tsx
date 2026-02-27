import { useState, useRef, useEffect, KeyboardEvent } from 'react'
import { Button, Input, Typography, Tooltip } from 'antd'
import { SendOutlined, ClearOutlined, RobotOutlined } from '@ant-design/icons'
import { teacherChat } from '../api'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

const EXAMPLES = [
  '张三最近学习情况如何？',
  '提问最积极的 5 个学生是哪些？',
  '哪些学生最近一周完全没有活跃？',
  '虚拟内存这个知识点哪些学生掌握不好？',
]

export default function TeacherChat() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function handleSend(text?: string) {
    const msg = (text ?? input).trim()
    if (!msg || loading) return
    setInput('')
    const next: Message[] = [...messages, { role: 'user', content: msg }]
    setMessages(next)
    setLoading(true)
    try {
      const res = await teacherChat(msg, messages)
      setMessages([...next, { role: 'assistant', content: res.data.reply }])
    } catch {
      setMessages([...next, { role: 'assistant', content: '出错了，请重试' }])
    } finally {
      setLoading(false)
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 168px)' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          <RobotOutlined style={{ marginRight: 8, color: '#1677ff' }} />
          教师助手
        </Typography.Title>
        <Tooltip title="清空对话">
          <Button size="small" icon={<ClearOutlined />} onClick={() => setMessages([])} disabled={messages.length === 0}>
            清空
          </Button>
        </Tooltip>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
        {messages.length === 0 && !loading && (
          <div style={{ marginTop: 40, textAlign: 'center' }}>
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              可以直接提问，例如：
            </Typography.Text>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center', marginTop: 12 }}>
              {EXAMPLES.map((ex) => (
                <Button
                  key={ex}
                  size="small"
                  style={{ borderRadius: 16, fontSize: 13 }}
                  onClick={() => handleSend(ex)}
                >
                  {ex}
                </Button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
              marginBottom: 12,
            }}
          >
            <div
              style={{
                maxWidth: '78%',
                padding: '10px 14px',
                borderRadius: msg.role === 'user' ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                background: msg.role === 'user' ? '#1677ff' : '#f5f5f5',
                color: msg.role === 'user' ? '#fff' : '#222',
                fontSize: 14,
                lineHeight: 1.7,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {msg.content}
            </div>
          </div>
        ))}

        {loading && (
          <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 12 }}>
            <div style={{ background: '#f5f5f5', borderRadius: '16px 16px 16px 4px', padding: '10px 14px', color: '#999', fontSize: 14 }}>
              分析中...
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={{ display: 'flex', gap: 8, paddingTop: 12, borderTop: '1px solid #f0f0f0', alignItems: 'flex-end' }}>
        <Input.TextArea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="提问关于学生的任何问题… Enter 发送，Shift+Enter 换行"
          autoSize={{ minRows: 2, maxRows: 5 }}
          disabled={loading}
        />
        <Button
          type="primary"
          icon={<SendOutlined />}
          onClick={() => handleSend()}
          disabled={loading || !input.trim()}
          style={{ height: 'auto', minHeight: 44, padding: '8px 18px' }}
        >
          发送
        </Button>
      </div>
    </div>
  )
}
