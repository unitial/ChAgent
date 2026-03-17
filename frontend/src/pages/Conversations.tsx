import { useEffect, useState, useRef } from 'react'
import { Input, DatePicker, Typography, Tag, Spin, Empty } from 'antd'
import { SearchOutlined } from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
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

interface ParsedCitation {
  name: string
  page: number
  text: string
}

function parseCitationsFromPrompt(prompt: string): ParsedCitation[] {
  const refIdx = prompt.indexOf('## 参考教材')
  if (refIdx === -1) return []
  const block = prompt.slice(refIdx)
  const citations: ParsedCitation[] = []
  // Match 《book》第 N 页：\n"text"
  const re = /《(.+?)》第\s*(\d+)\s*页：\n"([^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(block)) !== null) {
    citations.push({ name: m[1], page: Number(m[2]), text: m[3] })
  }
  return citations
}

function SystemPromptModal({ prompt, onClose }: { prompt: string; onClose: () => void }) {
  return (
    <div style={modalStyles.overlay} onClick={onClose}>
      <div style={modalStyles.box} onClick={e => e.stopPropagation()}>
        <div style={modalStyles.header}>
          <span style={modalStyles.title}>完整系统提示词</span>
          <button style={modalStyles.closeBtn} onClick={onClose}>✕</button>
        </div>
        <div style={modalStyles.body}>
          <pre style={modalStyles.pre}>{prompt}</pre>
        </div>
      </div>
    </div>
  )
}

function CitationsPanel({ citations }: { citations: ParsedCitation[] }) {
  const [open, setOpen] = useState(false)
  if (citations.length === 0) return null
  return (
    <div style={citStyles.wrapper}>
      <button style={citStyles.toggle} onClick={() => setOpen(o => !o)}>
        📖 参考教材 {open ? '▲' : '▼'}
      </button>
      {open && (
        <div style={citStyles.list}>
          {citations.map((c, i) => (
            <div key={i} style={citStyles.item}>
              <div style={citStyles.itemHeader}>《{c.name}》第 {c.page} 页</div>
              <div style={citStyles.itemText}>"{c.text}"</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function Conversations() {
  const [students, setStudents] = useState<Student[]>([])
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [loading, setLoading] = useState(false)
  const [studentsLoading, setStudentsLoading] = useState(true)
  const [dateRange, setDateRange] = useState<[string, string] | null>(null)
  const [modeFilter, setModeFilter] = useState<'all' | 'normal' | 'onboarding' | 'challenge'>('all')
  const [viewingPrompt, setViewingPrompt] = useState<string | null>(null)
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
    fetchConversations(selectedId, dateRange, modeFilter)
  }, [selectedId, dateRange, modeFilter])

  useEffect(() => {
    const el = chatBodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [conversations])

  const fetchConversations = async (sid: number, range: [string, string] | null, mode: string) => {
    setLoading(true)
    try {
      const res = await getConversations({
        student_id: sid,
        date_from: range?.[0],
        date_to: range?.[1],
        mode: mode === 'all' ? undefined : mode,
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
    <>
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
          <div style={styles.modeTabs}>
            {([['all', '全部'], ['normal', '💬 普通'], ['onboarding', '🎯 初心'], ['challenge', '⚔️ 挑战']] as const).map(([key, label]) => (
              <button
                key={key}
                style={{
                  ...styles.modeTab,
                  ...(modeFilter === key ? styles.modeTabActive : {}),
                }}
                onClick={() => setModeFilter(key as typeof modeFilter)}
              >
                {label}
              </button>
            ))}
          </div>
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
                    {sg.messages[0].session_mode === 'onboarding' && <span style={styles.modeBadgeOnboarding}>🎯 初心</span>}
                    {sg.messages[0].session_mode === 'challenge' && <span style={styles.modeBadgeChallenge}>⚔️ 挑战</span>}
                  </span>
                </div>
                {/* Messages */}
                {sg.messages.map((msg) => (
                  <div key={msg.id} style={msg.role === 'user' ? styles.userRow : styles.aiRow}>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '65%' }}>
                      <div style={msg.role === 'user' ? styles.userBubble : styles.aiBubble}>
                        <div style={styles.bubbleContent}>
                          {msg.role === 'user' ? msg.content : (
                            <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                              {msg.content}
                            </ReactMarkdown>
                          )}
                        </div>
                        <div style={styles.bubbleTime}>{dayjs(msg.created_at).format('HH:mm:ss')}</div>
                      </div>
                      {msg.role === 'assistant' && msg.system_prompt && (
                        <button
                          style={styles.promptBtn}
                          onClick={() => setViewingPrompt(msg.system_prompt!)}
                        >
                          完整请求
                        </button>
                      )}
                      {msg.role === 'assistant' && msg.system_prompt && (
                        <CitationsPanel citations={parseCitationsFromPrompt(msg.system_prompt)} />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
    {viewingPrompt && (
      <SystemPromptModal prompt={viewingPrompt} onClose={() => setViewingPrompt(null)} />
    )}
    </>
  )
}

const mdComponents = {
  p: ({ children }: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p style={{ margin: '4px 0' }}>{children}</p>
  ),
  table: ({ children }: React.HTMLAttributes<HTMLTableElement>) => (
    <div style={{ overflowX: 'auto', margin: '8px 0' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>{children}</table>
    </div>
  ),
  th: ({ children }: React.HTMLAttributes<HTMLTableCellElement>) => (
    <th style={{ border: '1px solid #d9d9d9', padding: '5px 10px', background: '#f5f5f5', fontWeight: 600, textAlign: 'left' }}>{children}</th>
  ),
  td: ({ children }: React.HTMLAttributes<HTMLTableCellElement>) => (
    <td style={{ border: '1px solid #e8e8e8', padding: '5px 10px' }}>{children}</td>
  ),
  code: ({ inline, children, ...props }: React.HTMLAttributes<HTMLElement> & { inline?: boolean }) =>
    inline ? (
      <code style={{ background: '#f0f0f0', borderRadius: 4, padding: '1px 5px', fontSize: '0.9em', fontFamily: 'monospace' }} {...props}>{children}</code>
    ) : (
      <pre style={{ background: '#f6f8fa', borderRadius: 8, padding: '10px 14px', overflowX: 'auto', margin: '8px 0', fontSize: 12, lineHeight: 1.6 }}>
        <code style={{ fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace' }} {...props}>{children}</code>
      </pre>
    ),
  ul: ({ children }: React.HTMLAttributes<HTMLUListElement>) => <ul style={{ paddingLeft: 20, margin: '4px 0' }}>{children}</ul>,
  ol: ({ children }: React.HTMLAttributes<HTMLOListElement>) => <ol style={{ paddingLeft: 20, margin: '4px 0' }}>{children}</ol>,
  li: ({ children }: React.HTMLAttributes<HTMLLIElement>) => <li style={{ margin: '2px 0' }}>{children}</li>,
  blockquote: ({ children }: React.HTMLAttributes<HTMLElement>) => (
    <blockquote style={{ borderLeft: '3px solid #d9d9d9', margin: '6px 0', paddingLeft: 12, color: '#666' }}>{children}</blockquote>
  ),
  h1: ({ children }: React.HTMLAttributes<HTMLHeadingElement>) => <h3 style={{ margin: '6px 0 4px', fontSize: 15, fontWeight: 700 }}>{children}</h3>,
  h2: ({ children }: React.HTMLAttributes<HTMLHeadingElement>) => <h4 style={{ margin: '6px 0 4px', fontSize: 14, fontWeight: 700 }}>{children}</h4>,
  h3: ({ children }: React.HTMLAttributes<HTMLHeadingElement>) => <h5 style={{ margin: '6px 0 4px', fontSize: 13, fontWeight: 600 }}>{children}</h5>,
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
    flexWrap: 'wrap',
  },
  modeTabs: {
    display: 'flex',
    gap: 4,
    marginLeft: 12,
  },
  modeTab: {
    background: 'none',
    border: '1px solid #d9d9d9',
    borderRadius: 6,
    padding: '3px 10px',
    cursor: 'pointer',
    fontSize: 12,
    color: '#666',
    fontWeight: 500,
    transition: 'all 0.15s',
  },
  modeTabActive: {
    background: '#1677ff',
    color: '#fff',
    borderColor: '#1677ff',
  },
  modeBadgeOnboarding: {
    marginLeft: 6,
    background: '#fff7e6',
    color: '#d46b08',
    border: '1px solid #ffd591',
    borderRadius: 4,
    padding: '0 5px',
    fontSize: 11,
    fontWeight: 600,
  },
  modeBadgeChallenge: {
    marginLeft: 6,
    background: '#fff1f0',
    color: '#cf1322',
    border: '1px solid #ffa39e',
    borderRadius: 4,
    padding: '0 5px',
    fontSize: 11,
    fontWeight: 600,
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
  promptBtn: {
    marginTop: 4,
    background: 'none',
    border: 'none',
    color: '#aaa',
    fontSize: 11,
    cursor: 'pointer',
    padding: '2px 4px',
    textDecoration: 'underline',
  },
}

const citStyles: Record<string, React.CSSProperties> = {
  wrapper: { marginTop: 6, maxWidth: '100%' },
  toggle: { background: 'none', border: '1px solid #d9d9d9', borderRadius: 6, padding: '3px 10px', cursor: 'pointer', fontSize: 12, color: '#666', fontWeight: 500 },
  list: { marginTop: 6, display: 'flex', flexDirection: 'column', gap: 8 },
  item: { background: '#f6f8fa', border: '1px solid #e8e8e8', borderRadius: 8, padding: '8px 12px' },
  itemHeader: { fontSize: 12, fontWeight: 600, color: '#1677ff', marginBottom: 4 },
  itemText: { fontSize: 12, color: '#555', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
}

const modalStyles: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 },
  box: { background: '#fff', borderRadius: 12, width: '100%', maxWidth: 720, maxHeight: '85vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 40px rgba(0,0,0,0.2)' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid #f0f0f0' },
  title: { fontWeight: 700, fontSize: 15 },
  closeBtn: { background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#888', lineHeight: '1' },
  body: { overflowY: 'auto', padding: '16px 20px' },
  pre: { margin: 0, background: '#f6f8fa', borderRadius: 8, padding: '12px 14px', fontSize: 12, lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#333', border: '1px solid #e8e8e8', fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace' },
}
