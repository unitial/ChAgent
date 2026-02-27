import { useEffect, useState, useRef } from 'react'
import { Input, DatePicker, Typography, Tag, Spin, Empty } from 'antd'
import { SearchOutlined } from '@ant-design/icons'
import { getConversations, getStudents, type Conversation, type Student } from '../api'
import dayjs from 'dayjs'

interface SessionGroup {
  sessionId: number
  messages: Conversation[]
}

function groupBySessions(convs: Conversation[]): SessionGroup[] {
  const map = new Map<number, Conversation[]>()
  for (const c of convs) {
    if (!map.has(c.session_id)) map.set(c.session_id, [])
    map.get(c.session_id)!.push(c)
  }
  return Array.from(map.entries()).map(([sessionId, messages]) => ({ sessionId, messages }))
}

export default function Conversations() {
  const [students, setStudents] = useState<Student[]>([])
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [loading, setLoading] = useState(false)
  const [studentsLoading, setStudentsLoading] = useState(true)
  const [dateRange, setDateRange] = useState<[string, string] | null>(null)
  const chatBodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    getStudents()
      .then((res) => {
        setStudents(res.data)
        if (res.data.length > 0) setSelectedId(res.data[0].id)
      })
      .finally(() => setStudentsLoading(false))
  }, [])

  useEffect(() => {
    if (selectedId == null) return
    fetchConversations(selectedId, dateRange)
  }, [selectedId, dateRange])

  useEffect(() => {
    const el = chatBodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [conversations])

  const fetchConversations = async (sid: number, range: [string, string] | null) => {
    setLoading(true)
    try {
      const res = await getConversations({
        student_id: sid,
        date_from: range?.[0],
        date_to: range?.[1],
      })
      setConversations(res.data)
    } finally {
      setLoading(false)
    }
  }

  const filteredStudents = students.filter((s) =>
    s.name.toLowerCase().includes(search.toLowerCase()),
  )

  const sessions = groupBySessions(conversations)
  const selectedStudent = students.find((s) => s.id === selectedId)

  return (
    <div style={styles.page}>
      {/* Left panel */}
      <div style={styles.sidebar}>
        <div style={styles.sidebarHeader}>
          <Typography.Text strong>学生列表</Typography.Text>
          <Input
            prefix={<SearchOutlined style={{ color: '#bbb' }} />}
            placeholder="搜索姓名"
            size="small"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            allowClear
            style={{ marginTop: 8 }}
          />
        </div>
        <div style={styles.studentList}>
          {studentsLoading ? (
            <div style={styles.centerHint}><Spin size="small" /></div>
          ) : filteredStudents.length === 0 ? (
            <div style={styles.centerHint}>暂无学生</div>
          ) : (
            filteredStudents.map((s) => (
              <div
                key={s.id}
                style={{
                  ...styles.studentItem,
                  background: s.id === selectedId ? '#e6f4ff' : undefined,
                  borderLeft: s.id === selectedId ? '3px solid #1677ff' : '3px solid transparent',
                }}
                onClick={() => setSelectedId(s.id)}
              >
                <span style={styles.studentName}>{s.name}</span>
                {!s.feishu_user_id && (
                  <Tag color="purple" style={{ fontSize: 11, padding: '0 4px', lineHeight: '18px' }}>网页</Tag>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Right panel */}
      <div style={styles.chatPanel}>
        <div style={styles.chatHeader}>
          <Typography.Text strong style={{ fontSize: 15 }}>
            {selectedStudent ? `${selectedStudent.name} 的对话记录` : '对话记录'}
          </Typography.Text>
          <DatePicker.RangePicker
            size="small"
            onChange={(_, strs) => setDateRange(strs[0] ? [strs[0], strs[1]] : null)}
            style={{ marginLeft: 'auto' }}
          />
        </div>

        <div style={styles.chatBody} ref={chatBodyRef}>
          {loading ? (
            <div style={styles.centerHint}><Spin /></div>
          ) : !selectedId ? (
            <Empty description="请选择左侧学生" style={{ marginTop: 80 }} />
          ) : sessions.length === 0 ? (
            <Empty description="暂无对话记录" style={{ marginTop: 80 }} />
          ) : (
            sessions.map((sg) => (
              <div key={sg.sessionId}>
                {/* Session divider */}
                <div style={styles.sessionDivider}>
                  <span style={styles.sessionLabel}>
                    Session #{sg.sessionId} · {dayjs(sg.messages[0].created_at).format('YYYY-MM-DD HH:mm')}
                  </span>
                </div>
                {/* Messages */}
                {sg.messages.map((msg) => (
                  <div key={msg.id} style={msg.role === 'user' ? styles.userRow : styles.aiRow}>
                    <div style={msg.role === 'user' ? styles.userBubble : styles.aiBubble}>
                      <div style={styles.bubbleContent}>{msg.content}</div>
                      <div style={styles.bubbleTime}>{dayjs(msg.created_at).format('HH:mm:ss')}</div>
                    </div>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    display: 'flex',
    height: 'calc(100vh - 120px)',
    gap: 0,
    background: '#fff',
    borderRadius: 8,
    overflow: 'hidden',
    border: '1px solid #f0f0f0',
    boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
  },
  sidebar: {
    width: 220,
    borderRight: '1px solid #f0f0f0',
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 0,
    overflow: 'hidden',
  },
  sidebarHeader: {
    padding: '14px 12px 10px',
    borderBottom: '1px solid #f0f0f0',
  },
  studentList: {
    flex: 1,
    overflowY: 'auto',
  },
  studentItem: {
    padding: '10px 12px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    transition: 'background 0.15s',
  },
  studentName: {
    fontSize: 14,
    fontWeight: 500,
  },
  centerHint: {
    display: 'flex',
    justifyContent: 'center',
    paddingTop: 32,
    color: '#bbb',
    fontSize: 13,
  },
  chatPanel: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    overflow: 'hidden',
  },
  chatHeader: {
    padding: '12px 20px',
    borderBottom: '1px solid #f0f0f0',
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    background: '#fafafa',
  },
  chatBody: {
    flex: 1,
    overflowY: 'auto',
    padding: '16px 20px',
    background: '#f5f5f5',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  sessionDivider: {
    display: 'flex',
    justifyContent: 'center',
    margin: '20px 0 12px',
  },
  sessionLabel: {
    background: '#e0e0e0',
    color: '#666',
    fontSize: 12,
    padding: '3px 12px',
    borderRadius: 12,
  },
  userRow: {
    display: 'flex',
    justifyContent: 'flex-end',
    marginBottom: 6,
  },
  aiRow: {
    display: 'flex',
    justifyContent: 'flex-start',
    marginBottom: 6,
  },
  userBubble: {
    background: '#1677ff',
    color: '#fff',
    borderRadius: '16px 16px 4px 16px',
    padding: '8px 14px',
    maxWidth: '65%',
  },
  aiBubble: {
    background: '#fff',
    color: '#222',
    borderRadius: '16px 16px 16px 4px',
    padding: '8px 14px',
    maxWidth: '65%',
    boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
  },
  bubbleContent: {
    fontSize: 14,
    lineHeight: 1.6,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  bubbleTime: {
    fontSize: 11,
    opacity: 0.6,
    marginTop: 4,
    textAlign: 'right',
  },
}
