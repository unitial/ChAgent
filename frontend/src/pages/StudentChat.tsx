import { useState, useEffect, useRef, KeyboardEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { studentLogin, studentRegister, studentChangePassword, studentChat, studentChatWithFile, studentNewSession, studentHistory, startChallenge, getActiveChallenge, studentListSessions, StudentHistoryMessage, Citation, StudentSession } from '../api'

type Stage = 'unregistered' | 'chatting'
type AuthTab = 'login' | 'register'

interface Message {
  id?: number
  session_id?: number
  role: 'user' | 'assistant'
  content: string
  system_prompt?: string
  attachedFile?: string  // filename shown in bubble
  citations?: Citation[]
}

interface ChallengeState {
  session_id: number
  started_at: string
}

const ALLOWED_EXTENSIONS = ['.pdf', '.pptx', '.ppt']
const MAX_FILE_MB = 20

function parseCitationsFromPrompt(prompt: string): Citation[] {
  const refIdx = prompt.indexOf('## 参考教材')
  if (refIdx === -1) return []
  const block = prompt.slice(refIdx)
  const re = /《(.+?)》第\s*(\d+)\s*页：\n"([^"]+)"/g
  const results: Citation[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(block)) !== null) {
    results.push({ textbook_name: m[1], page_num: Number(m[2]), text: m[3], score: 0 })
  }
  return results
}

function CitationsPanel({ citations }: { citations: Citation[] }) {
  const [open, setOpen] = useState(false)
  if (!citations || citations.length === 0) return null
  return (
    <div style={citationStyles.wrapper}>
      <button style={citationStyles.toggle} onClick={() => setOpen(o => !o)}>
        📖 参考教材 {open ? '▲' : '▼'}
      </button>
      {open && (
        <div style={citationStyles.list}>
          {citations.map((c, i) => (
            <div key={i} style={citationStyles.item}>
              <div style={citationStyles.itemHeader}>《{c.textbook_name}》第 {c.page_num} 页</div>
              <div style={citationStyles.itemText}>"{c.text}"</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function StudentChat() {
  const [stage, setStage] = useState<Stage>(() =>
    localStorage.getItem('student_token') ? 'chatting' : 'unregistered'
  )
  const [authTab, setAuthTab] = useState<AuthTab>('login')
  const [name, setName] = useState(() => localStorage.getItem('student_name') || '')
  const [nameInput, setNameInput] = useState('')
  const [passwordInput, setPasswordInput] = useState('')
  const [confirmPasswordInput, setConfirmPasswordInput] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [loginError, setLoginError] = useState('')
  const [challenge, setChallenge] = useState<ChallengeState | null>(null)
  const [hasActiveChallenge, setHasActiveChallenge] = useState(false)
  const [currentSessionId, setCurrentSessionId] = useState<number | null>(null)
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [fileError, setFileError] = useState('')
  const [isDragging, setIsDragging] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [sessions, setSessions] = useState<StudentSession[]>([])
  const [sidebarOpen, setSidebarOpen] = useState(false)

  // Change password modal state
  const [pwModalOpen, setPwModalOpen] = useState(false)
  const [pwCurrent, setPwCurrent] = useState('')
  const [pwNew, setPwNew] = useState('')
  const [pwConfirm, setPwConfirm] = useState('')
  const [pwError, setPwError] = useState('')
  const [pwLoading, setPwLoading] = useState(false)

  useEffect(() => {
    const prev = document.title
    document.title = 'ChAgent 课程助教'
    return () => { document.title = prev }
  }, [])

  useEffect(() => {
    if (stage === 'chatting') {
      loadHistory()
      checkActiveChallenge()
    }
  }, [stage])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    if (sidebarOpen && stage === 'chatting') loadSessions()
  }, [sidebarOpen])

  async function loadHistory(session_id?: number) {
    try {
      const res = await studentHistory(session_id)
      setMessages(res.data.map((m: StudentHistoryMessage) => ({
        id: m.id,
        session_id: m.session_id,
        role: m.role,
        content: m.content,
        system_prompt: m.system_prompt,
        citations: m.system_prompt ? parseCitationsFromPrompt(m.system_prompt) : [],
      })))
    } catch {
      // ignore
    }
  }

  async function checkActiveChallenge() {
    try {
      const res = await getActiveChallenge()
      setHasActiveChallenge(!!res.data)
    } catch {
      // ignore
    }
  }

  async function loadSessions() {
    try {
      const res = await studentListSessions()
      setSessions(res.data)
    } catch {
      // ignore
    }
  }

  async function handleSelectSession(sessionId: number) {
    setCurrentSessionId(sessionId)
    setSidebarOpen(false)
    await loadHistory(sessionId)
  }

  async function handleLogin() {
    const trimmed = nameInput.trim()
    if (!trimmed) return
    setLoginError('')
    setLoading(true)
    try {
      const res = await studentLogin(trimmed, passwordInput || undefined)
      localStorage.setItem('student_token', res.data.access_token)
      localStorage.setItem('student_name', res.data.name)
      setName(res.data.name)
      setPasswordInput('')
      setStage('chatting')
    } catch (err: any) {
      setLoginError(err?.response?.data?.detail || '登录失败，请重试')
    } finally {
      setLoading(false)
    }
  }

  async function handleRegister() {
    const trimmed = nameInput.trim()
    if (!trimmed) return
    if (passwordInput.length < 6) {
      setLoginError('密码至少需要 6 位')
      return
    }
    if (passwordInput !== confirmPasswordInput) {
      setLoginError('两次输入的密码不一致')
      return
    }
    setLoginError('')
    setLoading(true)
    try {
      const res = await studentRegister(trimmed, passwordInput)
      localStorage.setItem('student_token', res.data.access_token)
      localStorage.setItem('student_name', res.data.name)
      setName(res.data.name)
      setPasswordInput('')
      setConfirmPasswordInput('')
      setStage('chatting')
    } catch (err: any) {
      setLoginError(err?.response?.data?.detail || '注册失败，请重试')
    } finally {
      setLoading(false)
    }
  }

  async function handleChangePassword() {
    if (pwNew.length < 6) {
      setPwError('新密码至少需要 6 位')
      return
    }
    if (pwNew !== pwConfirm) {
      setPwError('两次输入的密码不一致')
      return
    }
    setPwError('')
    setPwLoading(true)
    try {
      await studentChangePassword(pwCurrent, pwNew)
      setPwModalOpen(false)
      setPwCurrent('')
      setPwNew('')
      setPwConfirm('')
    } catch (err: any) {
      setPwError(err?.response?.data?.detail || '修改失败，请重试')
    } finally {
      setPwLoading(false)
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!e.target.files) return
    e.target.value = ''  // reset so same file can be re-selected
    if (!file) return
    applyFile(file)
  }

  function applyFile(file: File) {
    setFileError('')
    const ext = '.' + file.name.split('.').pop()?.toLowerCase()
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      setFileError(`不支持的文件类型，请上传 PDF 或 PPTX 文件`)
      return
    }
    if (file.size > MAX_FILE_MB * 1024 * 1024) {
      setFileError(`文件不能超过 ${MAX_FILE_MB} MB`)
      return
    }
    setPendingFile(file)
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = e.clipboardData.files
    if (files.length > 0) {
      e.preventDefault()
      applyFile(files[0])
    }
    // If no files, let normal text paste proceed
  }

  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    if (e.dataTransfer.types.includes('Files')) setIsDragging(true)
  }

  function handleDragLeave(e: React.DragEvent<HTMLDivElement>) {
    // Only clear when leaving the wrapper itself, not a child
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragging(false)
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) applyFile(file)
  }

  function handleRemoveFile() {
    setPendingFile(null)
    setFileError('')
  }

  async function handleSend() {
    const text = input.trim()
    if ((!text && !pendingFile) || loading) return
    if (pendingFile && !text) {
      setFileError('请输入消息后再发送文件')
      return
    }

    const fileToSend = pendingFile
    setInput('')
    setPendingFile(null)
    setFileError('')

    const userMsg: Message = {
      role: 'user',
      content: text,
      attachedFile: fileToSend?.name,
    }
    setMessages(prev => [...prev, userMsg])
    setLoading(true)

    try {
      let res
      const sessionId = challenge ? challenge.session_id : currentSessionId ?? undefined
      if (fileToSend) {
        res = await studentChatWithFile(text, fileToSend, sessionId)
      } else {
        res = await studentChat(text, sessionId)
      }
      if (!challenge) setCurrentSessionId(res.data.session_id)
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: res.data.reply,
        session_id: res.data.session_id,
        system_prompt: res.data.system_prompt,
        citations: res.data.citations ?? [],
      }])
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: '出错了，请重试' }])
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

  function handleSwitchName() {
    localStorage.removeItem('student_token')
    localStorage.removeItem('student_name')
    setMessages([])
    setNameInput('')
    setPasswordInput('')
    setConfirmPasswordInput('')
    setName('')
    setChallenge(null)
    setHasActiveChallenge(false)
    setCurrentSessionId(null)
    setPendingFile(null)
    setFileError('')
    setSessions([])
    setSidebarOpen(false)
    setStage('unregistered')
  }

  async function handleEnterChallenge() {
    setLoading(true)
    try {
      const res = await startChallenge()
      const cs: ChallengeState = { session_id: res.data.session_id, started_at: res.data.started_at }
      setChallenge(cs)
      setHasActiveChallenge(false)
      await loadHistory(res.data.session_id)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  async function handleNewSession() {
    setLoading(true)
    try {
      const res = await studentNewSession()
      setCurrentSessionId(res.data.session_id)
      setMessages([])
      setPendingFile(null)
      setFileError('')
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  function handleExitChallenge() {
    setChallenge(null)
    setHasActiveChallenge(false)
    setPendingFile(null)
    loadHistory()
  }

  if (stage === 'unregistered') {
    const isLogin = authTab === 'login'
    return (
      <div style={styles.loginWrapper}>
        <div style={styles.loginCard}>
          <h2 style={styles.loginTitle}>ChAgent 课程助教</h2>
          <div style={styles.tabBar}>
            <button
              style={{ ...styles.tabBtn, ...(isLogin ? styles.tabBtnActive : {}) }}
              onClick={() => { setAuthTab('login'); setLoginError('') }}
            >
              登录
            </button>
            <button
              style={{ ...styles.tabBtn, ...(!isLogin ? styles.tabBtnActive : {}) }}
              onClick={() => { setAuthTab('register'); setLoginError('') }}
            >
              注册
            </button>
          </div>
          <input
            style={styles.loginInput}
            placeholder="请输入姓名"
            value={nameInput}
            onChange={e => setNameInput(e.target.value)}
            autoFocus
          />
          <input
            style={styles.loginInput}
            type="password"
            placeholder={isLogin ? '请输入密码' : '请设置密码（至少 6 位）'}
            value={passwordInput}
            onChange={e => setPasswordInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && (isLogin ? handleLogin() : handleRegister())}
          />
          {!isLogin && (
            <input
              style={styles.loginInput}
              type="password"
              placeholder="再次输入密码"
              value={confirmPasswordInput}
              onChange={e => setConfirmPasswordInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleRegister()}
            />
          )}
          {loginError && <p style={styles.error}>{loginError}</p>}
          <button
            style={{ ...styles.loginBtn, opacity: loading ? 0.6 : 1 }}
            onClick={isLogin ? handleLogin : handleRegister}
            disabled={loading}
          >
            {loading ? (isLogin ? '登录中...' : '注册中...') : (isLogin ? '登录' : '注册')}
          </button>
        </div>
      </div>
    )
  }

  const accentColor = challenge ? '#fa8c16' : '#1677ff'

  return (
    <>
      {/* Session history sidebar */}
      {sidebarOpen && !challenge && (
        <>
          <div style={sidebarStyles.backdrop} onClick={() => setSidebarOpen(false)} />
          <div style={sidebarStyles.panel}>
            <div style={sidebarStyles.header}>
              <span style={sidebarStyles.title}>历史对话</span>
              <button style={sidebarStyles.closeBtn} onClick={() => setSidebarOpen(false)}>✕</button>
            </div>
            <div style={sidebarStyles.list}>
              {sessions.length === 0 ? (
                <p style={sidebarStyles.empty}>暂无对话记录</p>
              ) : sessions.map(s => (
                <div
                  key={s.id}
                  style={{
                    ...sidebarStyles.item,
                    ...(s.id === currentSessionId ? sidebarStyles.itemActive : {}),
                  }}
                  onClick={() => handleSelectSession(s.id)}
                >
                  <div style={sidebarStyles.itemDate}>
                    {formatSessionDate(s.started_at)}
                    {s.mode === 'challenge' && <span style={sidebarStyles.modeBadge}>⚡挑战</span>}
                  </div>
                  {s.last_message && (
                    <div style={sidebarStyles.itemPreview}>{s.last_message}</div>
                  )}
                  <div style={sidebarStyles.itemCount}>{s.message_count} 条消息</div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      <div
        style={{ ...styles.chatWrapper, ...(isDragging ? styles.chatWrapperDragging : {}) }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Drag-and-drop overlay */}
        {isDragging && (
          <div style={styles.dropOverlay}>
            <div style={styles.dropOverlayBox}>
              <div style={{ fontSize: 40 }}>📎</div>
              <div style={{ fontSize: 16, fontWeight: 600 }}>松开以上传文件</div>
              <div style={{ fontSize: 13, color: '#888' }}>支持 PDF、PPTX</div>
            </div>
          </div>
        )}

        {/* Header */}
        <div style={{ ...styles.header, background: challenge ? '#fff7e6' : '#fff', borderBottom: `1px solid ${challenge ? '#ffd591' : '#e8e8e8'}` }}>
          <span style={styles.headerName}>{name}</span>
          {challenge ? (
            <>
              <span style={styles.challengeBadge}>⚡ 挑战模式</span>
              <button style={styles.exitChallengeBtn} onClick={handleExitChallenge}>退出挑战</button>
            </>
          ) : (
            <>
              <button style={styles.historyBtn} onClick={() => setSidebarOpen(o => !o)} title="查看历史对话">
                📜 历史
              </button>
              <button style={styles.historyBtn} onClick={() => window.location.href = '/learn/cases'} title="查看案例">
                📚 案例
              </button>
              <button style={styles.newSessionBtn} onClick={handleNewSession} disabled={loading} title="清空当前对话，开启新会话">
                + 新对话
              </button>
              {hasActiveChallenge && (
                <button style={{ ...styles.challengeBtn, background: '#fa8c16' }} onClick={handleEnterChallenge} disabled={loading}>
                  ↩ 继续挑战
                </button>
              )}
              <button style={styles.challengeBtn} onClick={handleEnterChallenge} disabled={loading}>
                ⚡ 挑战模式
              </button>
            </>
          )}
          <button style={styles.switchBtn} onClick={handleSwitchName}>换个账号</button>
          <button style={styles.switchBtn} onClick={() => { setPwError(''); setPwModalOpen(true) }}>修改密码</button>
        </div>

        {/* Message list */}
        <div style={styles.messageList}>
          {messages.length === 0 && !loading && (
            <p style={styles.emptyHint}>
              {challenge ? '挑战模式已就绪，发送任意消息开始！' : '发送消息开始对话，或点击 📎 上传教案文件'}
            </p>
          )}
          {messages.map((msg, i) => (
            <div key={i} style={msg.role === 'user' ? styles.userRow : styles.aiRow}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '72%' }}>
                {msg.attachedFile && (
                  <div style={styles.fileBadgeMsg}>
                    📎 {msg.attachedFile}
                  </div>
                )}
                <div style={msg.role === 'user' ? styles.userBubble : styles.aiBubble}>
                  {msg.role === 'user' ? msg.content : (
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                      {msg.content}
                    </ReactMarkdown>
                  )}
                </div>
                {msg.role === 'assistant' && msg.citations && msg.citations.length > 0 && (
                  <CitationsPanel citations={msg.citations} />
                )}
              </div>
            </div>
          ))}
          {loading && (
            <div style={styles.aiRow}>
              <div style={{ ...styles.aiBubble, color: '#999' }}>思考中...</div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* File attachment preview */}
        {(pendingFile || fileError) && (
          <div style={styles.filePreviewBar}>
            {pendingFile && (
              <div style={styles.fileChip}>
                <span style={styles.fileChipIcon}>📎</span>
                <span style={styles.fileChipName}>{pendingFile.name}</span>
                <span style={styles.fileChipSize}>({(pendingFile.size / 1024).toFixed(0)} KB)</span>
                <button style={styles.fileChipRemove} onClick={handleRemoveFile} title="移除文件">✕</button>
              </div>
            )}
            {fileError && <span style={styles.fileErrorText}>{fileError}</span>}
          </div>
        )}

        {/* Input area */}
        <div style={{ ...styles.inputArea, borderTop: `1px solid ${challenge ? '#ffd591' : '#e8e8e8'}` }}>
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.pptx,.ppt"
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />
          <button
            style={{ ...styles.attachBtn, color: pendingFile ? accentColor : '#999', borderColor: pendingFile ? accentColor : '#d9d9d9' }}
            onClick={() => fileInputRef.current?.click()}
            disabled={loading}
            title="上传 PDF / PPTX 文件"
          >
            📎
          </button>
          <textarea
            style={styles.textarea}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={pendingFile ? '输入关于此文件的问题，Enter 发送' : '输入消息，Enter 发送，Shift+Enter 换行'}
            rows={3}
            disabled={loading}
          />
          <button
            style={{ ...styles.sendBtn, opacity: loading || (!input.trim() && !pendingFile) ? 0.5 : 1, background: accentColor }}
            onClick={handleSend}
            disabled={loading || (!input.trim() && !pendingFile)}
          >
            发送
          </button>
        </div>
      </div>

      {/* Change password modal */}
      {pwModalOpen && (
        <>
          <div style={modalStyles.backdrop} onClick={() => setPwModalOpen(false)} />
          <div style={modalStyles.box}>
            <div style={modalStyles.header}>
              <span style={modalStyles.title}>修改密码</span>
              <button style={modalStyles.closeBtn} onClick={() => setPwModalOpen(false)}>✕</button>
            </div>
            <div style={modalStyles.body}>
              <label style={modalStyles.label}>当前密码</label>
              <input
                style={modalStyles.input}
                type="password"
                placeholder="当前密码"
                value={pwCurrent}
                onChange={e => setPwCurrent(e.target.value)}
                autoFocus
              />
              <label style={modalStyles.label}>新密码</label>
              <input
                style={modalStyles.input}
                type="password"
                placeholder="至少 6 位"
                value={pwNew}
                onChange={e => setPwNew(e.target.value)}
              />
              <label style={modalStyles.label}>确认新密码</label>
              <input
                style={modalStyles.input}
                type="password"
                placeholder="再次输入新密码"
                value={pwConfirm}
                onChange={e => setPwConfirm(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleChangePassword()}
              />
              {pwError && <p style={modalStyles.error}>{pwError}</p>}
              <button
                style={{ ...modalStyles.btn, opacity: pwLoading ? 0.6 : 1 }}
                onClick={handleChangePassword}
                disabled={pwLoading}
              >
                {pwLoading ? '修改中...' : '确认修改'}
              </button>
            </div>
          </div>
        </>
      )}
    </>
  )
}

// Markdown component overrides for the AI bubble
const mdComponents = {
  // Remove top/bottom margin on paragraphs so they don't bloat the bubble
  p: ({ children }: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p style={{ margin: '4px 0' }}>{children}</p>
  ),
  // Tables
  table: ({ children }: React.HTMLAttributes<HTMLTableElement>) => (
    <div style={{ overflowX: 'auto', margin: '8px 0' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 14 }}>{children}</table>
    </div>
  ),
  th: ({ children }: React.HTMLAttributes<HTMLTableCellElement>) => (
    <th style={{ border: '1px solid #d9d9d9', padding: '6px 12px', background: '#f5f5f5', fontWeight: 600, textAlign: 'left' }}>{children}</th>
  ),
  td: ({ children }: React.HTMLAttributes<HTMLTableCellElement>) => (
    <td style={{ border: '1px solid #e8e8e8', padding: '6px 12px' }}>{children}</td>
  ),
  // Code blocks
  code: ({ inline, children, ...props }: React.HTMLAttributes<HTMLElement> & { inline?: boolean }) =>
    inline ? (
      <code style={{ background: '#f0f0f0', borderRadius: 4, padding: '1px 5px', fontSize: '0.9em', fontFamily: 'monospace' }} {...props}>{children}</code>
    ) : (
      <pre style={{ background: '#f6f8fa', borderRadius: 8, padding: '10px 14px', overflowX: 'auto', margin: '8px 0', fontSize: 13, lineHeight: 1.6 }}>
        <code style={{ fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace' }} {...props}>{children}</code>
      </pre>
    ),
  // Lists
  ul: ({ children }: React.HTMLAttributes<HTMLUListElement>) => (
    <ul style={{ paddingLeft: 20, margin: '4px 0' }}>{children}</ul>
  ),
  ol: ({ children }: React.HTMLAttributes<HTMLOListElement>) => (
    <ol style={{ paddingLeft: 20, margin: '4px 0' }}>{children}</ol>
  ),
  li: ({ children }: React.HTMLAttributes<HTMLLIElement>) => (
    <li style={{ margin: '2px 0' }}>{children}</li>
  ),
  // Blockquote
  blockquote: ({ children }: React.HTMLAttributes<HTMLElement>) => (
    <blockquote style={{ borderLeft: '3px solid #d9d9d9', margin: '6px 0', paddingLeft: 12, color: '#666' }}>{children}</blockquote>
  ),
  // Headings — scale down since they're inside a chat bubble
  h1: ({ children }: React.HTMLAttributes<HTMLHeadingElement>) => <h3 style={{ margin: '6px 0 4px', fontSize: 16, fontWeight: 700 }}>{children}</h3>,
  h2: ({ children }: React.HTMLAttributes<HTMLHeadingElement>) => <h4 style={{ margin: '6px 0 4px', fontSize: 15, fontWeight: 700 }}>{children}</h4>,
  h3: ({ children }: React.HTMLAttributes<HTMLHeadingElement>) => <h5 style={{ margin: '6px 0 4px', fontSize: 14, fontWeight: 600 }}>{children}</h5>,
}

const styles: Record<string, React.CSSProperties> = {
  loginWrapper: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#f0f2f5' },
  loginCard: { background: '#fff', borderRadius: 12, padding: '40px 48px', boxShadow: '0 4px 20px rgba(0,0,0,0.1)', width: 360, display: 'flex', flexDirection: 'column', gap: 16 },
  loginTitle: { margin: 0, fontSize: 24, fontWeight: 700, textAlign: 'center' },
  loginSubtitle: { margin: 0, color: '#666', textAlign: 'center', fontSize: 14 },
  tabBar: { display: 'flex', borderRadius: 8, overflow: 'hidden', border: '1px solid #d9d9d9' },
  tabBtn: { flex: 1, padding: '8px 0', fontSize: 14, fontWeight: 500, background: '#fff', border: 'none', cursor: 'pointer', color: '#666', transition: 'background 0.15s' },
  tabBtnActive: { background: '#1677ff', color: '#fff' },
  loginInput: { padding: '10px 14px', fontSize: 15, border: '1px solid #d9d9d9', borderRadius: 8, outline: 'none' },
  loginBtn: { padding: '10px 0', fontSize: 15, background: '#1677ff', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600 },
  error: { margin: 0, color: '#ff4d4f', fontSize: 13 },
  chatWrapper: { display: 'flex', flexDirection: 'column', height: '100vh', background: '#f0f2f5', position: 'relative' },
  chatWrapperDragging: { outline: '3px dashed #1677ff', outlineOffset: -3 },
  dropOverlay: { position: 'absolute', inset: 0, background: 'rgba(22,119,255,0.08)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' },
  dropOverlayBox: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, background: '#fff', borderRadius: 16, padding: '32px 48px', boxShadow: '0 4px 24px rgba(22,119,255,0.2)', border: '2px dashed #1677ff' },
  header: { display: 'flex', alignItems: 'center', gap: 10, padding: '12px 24px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)', transition: 'background 0.2s' },
  headerName: { fontWeight: 600, fontSize: 16, marginRight: 4 },
  challengeBadge: { background: '#fff7e6', color: '#d46b08', border: '1px solid #ffd591', borderRadius: 12, padding: '2px 12px', fontSize: 13, fontWeight: 600 },
  newSessionBtn: { background: 'none', border: '1px solid #d9d9d9', borderRadius: 6, padding: '4px 12px', cursor: 'pointer', fontSize: 13, color: '#555', fontWeight: 500 },
  historyBtn: { background: 'none', border: '1px solid #d9d9d9', borderRadius: 6, padding: '4px 12px', cursor: 'pointer', fontSize: 13, color: '#555', fontWeight: 500 },
  challengeBtn: { background: '#1677ff', color: '#fff', border: 'none', borderRadius: 6, padding: '5px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 600 },
  exitChallengeBtn: { background: 'none', border: '1px solid #d9d9d9', borderRadius: 6, padding: '4px 12px', cursor: 'pointer', fontSize: 13, color: '#666' },
  switchBtn: { background: 'none', border: '1px solid #d9d9d9', borderRadius: 6, padding: '4px 12px', cursor: 'pointer', fontSize: 13, color: '#666', marginLeft: 'auto' },
  messageList: { flex: 1, overflowY: 'auto', padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: 12 },
  emptyHint: { textAlign: 'center', color: '#bbb', marginTop: 40 },
  userRow: { display: 'flex', justifyContent: 'flex-end' },
  aiRow: { display: 'flex', justifyContent: 'flex-start' },
  userBubble: { background: '#1677ff', color: '#fff', borderRadius: '18px 18px 4px 18px', padding: '10px 16px', fontSize: 15, lineHeight: 1.6, wordBreak: 'break-word', whiteSpace: 'pre-wrap' },
  aiBubble: { background: '#fff', color: '#222', borderRadius: '18px 18px 18px 4px', padding: '10px 16px', fontSize: 15, lineHeight: 1.6, wordBreak: 'break-word', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' },
  promptBtn: { marginTop: 4, background: 'none', border: 'none', color: '#aaa', fontSize: 11, cursor: 'pointer', padding: '2px 4px', textDecoration: 'underline' },
  fileBadgeMsg: { fontSize: 12, color: '#666', background: '#f0f0f0', borderRadius: 6, padding: '3px 10px', marginBottom: 4, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  filePreviewBar: { background: '#fafafa', borderTop: '1px solid #f0f0f0', padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  fileChip: { display: 'flex', alignItems: 'center', gap: 6, background: '#e6f0ff', border: '1px solid #91caff', borderRadius: 20, padding: '4px 12px', fontSize: 13 },
  fileChipIcon: { fontSize: 14 },
  fileChipName: { fontWeight: 500, color: '#1677ff', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  fileChipSize: { color: '#888', fontSize: 12 },
  fileChipRemove: { background: 'none', border: 'none', cursor: 'pointer', color: '#999', fontSize: 14, padding: '0 0 0 4px', lineHeight: 1 },
  fileErrorText: { color: '#ff4d4f', fontSize: 13 },
  inputArea: { display: 'flex', gap: 8, padding: '12px 16px', background: '#fff', alignItems: 'flex-end', transition: 'border-color 0.2s' },
  attachBtn: { background: '#fff', border: '1px solid #d9d9d9', borderRadius: 8, width: 40, height: 44, cursor: 'pointer', fontSize: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'color 0.2s, border-color 0.2s' },
  textarea: { flex: 1, padding: '10px 14px', fontSize: 15, border: '1px solid #d9d9d9', borderRadius: 8, resize: 'none', outline: 'none', lineHeight: 1.5, fontFamily: 'inherit' },
  sendBtn: { padding: '10px 24px', fontSize: 15, color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, height: 44, transition: 'background 0.2s' },
}

const citationStyles: Record<string, React.CSSProperties> = {
  wrapper: { marginTop: 6, maxWidth: '100%' },
  toggle: { background: 'none', border: '1px solid #d9d9d9', borderRadius: 6, padding: '3px 10px', cursor: 'pointer', fontSize: 12, color: '#666', fontWeight: 500 },
  list: { marginTop: 6, display: 'flex', flexDirection: 'column', gap: 8 },
  item: { background: '#f6f8fa', border: '1px solid #e8e8e8', borderRadius: 8, padding: '8px 12px' },
  itemHeader: { fontSize: 12, fontWeight: 600, color: '#1677ff', marginBottom: 4 },
  itemText: { fontSize: 12, color: '#555', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
}

function formatSessionDate(iso: string): string {
  const d = new Date(iso)
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const modalStyles: Record<string, React.CSSProperties> = {
  backdrop: { position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.35)' },
  box: { position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 201, background: '#fff', borderRadius: 12, width: 340, boxShadow: '0 8px 32px rgba(0,0,0,0.18)' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid #f0f0f0' },
  title: { fontWeight: 600, fontSize: 16 },
  closeBtn: { background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#888', lineHeight: 1 },
  body: { padding: '20px', display: 'flex', flexDirection: 'column', gap: 10 },
  label: { fontSize: 13, color: '#555', fontWeight: 500 },
  input: { padding: '9px 12px', fontSize: 14, border: '1px solid #d9d9d9', borderRadius: 7, outline: 'none' },
  error: { margin: 0, color: '#ff4d4f', fontSize: 13 },
  btn: { marginTop: 4, padding: '10px 0', fontSize: 15, background: '#1677ff', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600 },
}

const sidebarStyles: Record<string, React.CSSProperties> = {
  backdrop: { position: 'fixed', inset: 0, zIndex: 99, background: 'rgba(0,0,0,0.15)' },
  panel: { position: 'fixed', left: 0, top: 0, width: 260, height: '100vh', background: '#fff', zIndex: 100, display: 'flex', flexDirection: 'column', boxShadow: '4px 0 16px rgba(0,0,0,0.12)' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px', borderBottom: '1px solid #f0f0f0', flexShrink: 0 },
  title: { fontWeight: 600, fontSize: 15 },
  closeBtn: { background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#888', lineHeight: 1 },
  list: { flex: 1, overflowY: 'auto' },
  empty: { textAlign: 'center', color: '#bbb', padding: '24px 16px', margin: 0, fontSize: 13 },
  item: { padding: '12px 16px', cursor: 'pointer', borderBottom: '1px solid #f5f5f5', borderLeft: '3px solid transparent' },
  itemActive: { background: '#e6f4ff', borderLeft: '3px solid #1677ff' },
  itemDate: { fontSize: 12, color: '#888', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 },
  itemPreview: { fontSize: 13, color: '#333', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 2 },
  itemCount: { fontSize: 11, color: '#bbb' },
  modeBadge: { background: '#fff7e6', color: '#d46b08', border: '1px solid #ffd591', borderRadius: 4, padding: '0 4px', fontSize: 11 },
}
