import { useState, useEffect, useRef, KeyboardEvent } from 'react'
import { studentLogin, studentChat, studentChatWithFile, studentNewSession, studentHistory, startChallenge, getActiveChallenge, StudentHistoryMessage } from '../api'

type Stage = 'unregistered' | 'chatting'

interface Message {
  id?: number
  session_id?: number
  role: 'user' | 'assistant'
  content: string
  system_prompt?: string
  attachedFile?: string  // filename shown in bubble
}

interface ChallengeState {
  session_id: number
  started_at: string
}

const ALLOWED_EXTENSIONS = ['.pdf', '.pptx', '.ppt']
const MAX_FILE_MB = 20

function SystemPromptModal({ prompt, onClose }: { prompt: string; onClose: () => void }) {
  const sections: { title: string; content: string }[] = []
  const skillsIdx = prompt.indexOf('\n## Teacher-Configured Skills')
  const challengeIdx = prompt.indexOf('\n## Challenge Mode Instructions')
  const profileIdx = prompt.search(/\n## Student (Knowledge Profile|Profile)/)

  const cut = (start: number, end: number) =>
    prompt.slice(start, end === -1 ? undefined : end).trim()

  const baseEnd = skillsIdx !== -1 ? skillsIdx : challengeIdx !== -1 ? challengeIdx : profileIdx !== -1 ? profileIdx : -1
  sections.push({ title: '基础指令', content: cut(0, baseEnd) })

  if (skillsIdx !== -1) {
    const skillsEnd = challengeIdx !== -1 && challengeIdx > skillsIdx ? challengeIdx : profileIdx !== -1 && profileIdx > skillsIdx ? profileIdx : -1
    sections.push({ title: 'Teacher Skills', content: cut(skillsIdx, skillsEnd) })
  }
  if (challengeIdx !== -1) {
    const challengeEnd = profileIdx !== -1 && profileIdx > challengeIdx ? profileIdx : -1
    sections.push({ title: '挑战模式指令', content: cut(challengeIdx, challengeEnd) })
  }
  if (profileIdx !== -1) {
    sections.push({ title: '学生画像', content: cut(profileIdx, -1) })
  }

  return (
    <div style={modalStyles.overlay} onClick={onClose}>
      <div style={modalStyles.box} onClick={e => e.stopPropagation()}>
        <div style={modalStyles.header}>
          <span style={modalStyles.title}>完整系统提示词</span>
          <button style={modalStyles.closeBtn} onClick={onClose}>✕</button>
        </div>
        <div style={modalStyles.body}>
          {sections.map((s, i) => (
            <div key={i} style={modalStyles.section}>
              <div style={modalStyles.sectionTitle}>{s.title}</div>
              <pre style={modalStyles.pre}>{s.content}</pre>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default function StudentChat() {
  const [stage, setStage] = useState<Stage>(() =>
    localStorage.getItem('student_token') ? 'chatting' : 'unregistered'
  )
  const [name, setName] = useState(() => localStorage.getItem('student_name') || '')
  const [nameInput, setNameInput] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [loginError, setLoginError] = useState('')
  const [viewingPrompt, setViewingPrompt] = useState<string | null>(null)
  const [challenge, setChallenge] = useState<ChallengeState | null>(null)
  const [hasActiveChallenge, setHasActiveChallenge] = useState(false)
  const [currentSessionId, setCurrentSessionId] = useState<number | null>(null)
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [fileError, setFileError] = useState('')
  const [isDragging, setIsDragging] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

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

  async function loadHistory(session_id?: number) {
    try {
      const res = await studentHistory(session_id)
      setMessages(res.data.map((m: StudentHistoryMessage) => ({
        id: m.id,
        session_id: m.session_id,
        role: m.role,
        content: m.content,
        system_prompt: m.system_prompt,
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

  async function handleLogin() {
    const trimmed = nameInput.trim()
    if (!trimmed) return
    setLoginError('')
    setLoading(true)
    try {
      const res = await studentLogin(trimmed)
      localStorage.setItem('student_token', res.data.access_token)
      localStorage.setItem('student_name', res.data.name)
      setName(res.data.name)
      setStage('chatting')
    } catch {
      setLoginError('登录失败，请重试')
    } finally {
      setLoading(false)
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
    setName('')
    setChallenge(null)
    setHasActiveChallenge(false)
    setCurrentSessionId(null)
    setPendingFile(null)
    setFileError('')
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
    return (
      <div style={styles.loginWrapper}>
        <div style={styles.loginCard}>
          <h2 style={styles.loginTitle}>ChAgent 课程助教</h2>
          <p style={styles.loginSubtitle}>输入你的姓名开始对话</p>
          <input
            style={styles.loginInput}
            placeholder="请输入姓名"
            value={nameInput}
            onChange={e => setNameInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleLogin()}
            autoFocus
          />
          {loginError && <p style={styles.error}>{loginError}</p>}
          <button
            style={{ ...styles.loginBtn, opacity: loading ? 0.6 : 1 }}
            onClick={handleLogin}
            disabled={loading}
          >
            {loading ? '登录中...' : '开始对话'}
          </button>
        </div>
      </div>
    )
  }

  const accentColor = challenge ? '#fa8c16' : '#1677ff'

  return (
    <>
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
          <button style={styles.switchBtn} onClick={handleSwitchName}>换个姓名</button>
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
                  {msg.content}
                </div>
                {msg.role === 'assistant' && msg.system_prompt && (
                  <button
                    style={styles.promptBtn}
                    onClick={() => setViewingPrompt(msg.system_prompt!)}
                    title="查看提交给模型的完整请求"
                  >
                    完整请求
                  </button>
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

      {viewingPrompt && (
        <SystemPromptModal prompt={viewingPrompt} onClose={() => setViewingPrompt(null)} />
      )}
    </>
  )
}

const styles: Record<string, React.CSSProperties> = {
  loginWrapper: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#f0f2f5' },
  loginCard: { background: '#fff', borderRadius: 12, padding: '40px 48px', boxShadow: '0 4px 20px rgba(0,0,0,0.1)', width: 360, display: 'flex', flexDirection: 'column', gap: 16 },
  loginTitle: { margin: 0, fontSize: 24, fontWeight: 700, textAlign: 'center' },
  loginSubtitle: { margin: 0, color: '#666', textAlign: 'center', fontSize: 14 },
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
  challengeBtn: { background: '#1677ff', color: '#fff', border: 'none', borderRadius: 6, padding: '5px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 600 },
  exitChallengeBtn: { background: 'none', border: '1px solid #d9d9d9', borderRadius: 6, padding: '4px 12px', cursor: 'pointer', fontSize: 13, color: '#666' },
  switchBtn: { background: 'none', border: '1px solid #d9d9d9', borderRadius: 6, padding: '4px 12px', cursor: 'pointer', fontSize: 13, color: '#666', marginLeft: 'auto' },
  messageList: { flex: 1, overflowY: 'auto', padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: 12 },
  emptyHint: { textAlign: 'center', color: '#bbb', marginTop: 40 },
  userRow: { display: 'flex', justifyContent: 'flex-end' },
  aiRow: { display: 'flex', justifyContent: 'flex-start' },
  userBubble: { background: '#1677ff', color: '#fff', borderRadius: '18px 18px 4px 18px', padding: '10px 16px', fontSize: 15, lineHeight: 1.6, wordBreak: 'break-word', whiteSpace: 'pre-wrap' },
  aiBubble: { background: '#fff', color: '#222', borderRadius: '18px 18px 18px 4px', padding: '10px 16px', fontSize: 15, lineHeight: 1.6, wordBreak: 'break-word', whiteSpace: 'pre-wrap', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' },
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

const modalStyles: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 },
  box: { background: '#fff', borderRadius: 12, width: '100%', maxWidth: 720, maxHeight: '85vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 40px rgba(0,0,0,0.2)' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid #f0f0f0' },
  title: { fontWeight: 700, fontSize: 15 },
  closeBtn: { background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#888', lineHeight: 1 },
  body: { overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 16 },
  section: { display: 'flex', flexDirection: 'column', gap: 6 },
  sectionTitle: { fontSize: 12, fontWeight: 600, color: '#1677ff', textTransform: 'uppercase', letterSpacing: 1 },
  pre: { margin: 0, background: '#f6f8fa', borderRadius: 8, padding: '12px 14px', fontSize: 12, lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#333', border: '1px solid #e8e8e8', fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace' },
}
