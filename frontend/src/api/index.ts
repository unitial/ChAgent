import api from './client'
import axios from 'axios'

const studentApi = axios.create({ baseURL: '/api' })

studentApi.interceptors.request.use((config) => {
  const token = localStorage.getItem('student_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

export interface Student {
  id: number
  name: string
  feishu_user_id: string | null
  profile_json: {
    topic_mastery?: Record<string, number>
    common_mistakes?: string[]
    learning_style?: string
    recent_summary?: string
  }
  profile_aspects: string[]
  daily_token_limit: number | null
  today_tokens: number
  created_at: string
  updated_at: string
  profile_updated_at: string | null
  needs_profile_update: boolean
}

export interface Conversation {
  id: number
  student_id: number
  student_name: string
  session_id: number
  role: 'user' | 'assistant'
  content: string
  system_prompt?: string
  created_at: string
}

export interface Skill {
  id: string
  name: string
  type: 'knowledge_point' | 'teaching_strategy' | 'global' | 'profile_update' | 'challenge'
  content: string
  enabled: boolean
  description: string
  source: string
  created_at: string
}

export interface DashboardStats {
  total_students: number
  active_today: number
  total_messages: number
}

export interface HotTopic {
  topic: string
  count: number
}

// Auth
export const login = (username: string, password: string) =>
  api.post<{ access_token: string; token_type: string }>('/auth/login', new URLSearchParams({ username, password }), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  })

export const getMe = () => api.get('/auth/me')
export const changePassword = (current_password: string, new_password: string) =>
  api.post('/auth/change-password', { current_password, new_password })

// Students
export const getStudents = () => api.get<Student[]>('/students')
export const getStudent = (id: number) => api.get<Student>(`/students/${id}`)
export const getStudentConversations = (id: number) => api.get<Conversation[]>(`/students/${id}/conversations`)

// Skills
export const getSkills = () => api.get<Skill[]>('/skills')
export const createSkill = (data: Omit<Skill, 'id' | 'created_at'>) => api.post<Skill>('/skills', data)
export const updateSkill = (id: string, data: Partial<Skill>) => api.put<Skill>(`/skills/${id}`, data)
export const deleteSkill = (id: string) => api.delete(`/skills/${id}`)

export interface SkillAutofillResult {
  name: string
  type: string
  description: string
  content: string
  source: string
}
export const autofillSkill = (text: string) =>
  api.post<SkillAutofillResult>('/skills/autofill', { text })

// Model Settings
export interface ModelSettings {
  provider: 'anthropic' | 'openrouter'
  model: string
  openrouter_api_key_set: boolean
  default_daily_token_limit: number
}
export const getModelSettings = () => api.get<ModelSettings>('/settings/model')
export const updateModelSettings = (data: {
  provider?: string
  model?: string
  openrouter_api_key?: string
  default_daily_token_limit?: number
}) => api.put('/settings/model', data)

// Student usage / limit
export const setStudentLimit = (id: number, daily_token_limit: number | null) =>
  api.put(`/students/${id}/limit`, { daily_token_limit })

// Student profile (file-based)
export interface ProfileAspect {
  slug: string
  name: string
  content: string
  updated_at: string
}
export const getStudentProfile = (id: number) => api.get<ProfileAspect[]>(`/students/${id}/profile`)
export const updateProfileAspect = (studentId: number, slug: string, data: { name?: string; content: string }) =>
  api.put(`/students/${studentId}/profile/${slug}`, data)
export const deleteProfileAspect = (studentId: number, slug: string) =>
  api.delete(`/students/${studentId}/profile/${slug}`)
export const triggerStudentProfileUpdate = (id: number) =>
  api.post(`/students/${id}/profile/update`)
export const triggerAllProfileUpdates = (force = false) =>
  api.post('/profiles/update-all', null, { params: force ? { force: true } : {} })
export const getProfileUpdateStatus = () =>
  api.get<{ total: number; needs_update: number }>('/profiles/update-status')

// Model Settings - Profile
export interface ProfileModelSettings {
  raw_provider: 'inherit' | 'anthropic' | 'openrouter'
  raw_model: string
  effective_provider: string
  effective_model: string
  openrouter_api_key_set: boolean
}
export const getProfileModelSettings = () => api.get<ProfileModelSettings>('/settings/profile-model')
export const updateProfileModelSettings = (data: { provider?: string; model?: string; openrouter_api_key?: string }) =>
  api.put('/settings/profile-model', data)

// Dashboard
export const getDashboardStats = () => api.get<DashboardStats>('/dashboard/stats')
export const getHotTopics = () => api.get<HotTopic[]>('/dashboard/hot-topics')

// Conversations
export const getConversations = (params?: { student_id?: number; date_from?: string; date_to?: string }) =>
  api.get<Conversation[]>('/conversations', { params })

// Teacher chat
export interface TeacherChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export const teacherChat = (message: string, history: TeacherChatMessage[]) =>
  api.post<{ reply: string }>('/teacher/chat', { message, history })
export interface StudentLoginResponse {
  access_token: string
  token_type: string
  name: string
}

export interface StudentChatResponse {
  reply: string
  session_id: number
  session_mode: string | null
  system_prompt: string
  citations: Citation[]
}

export interface Citation {
  textbook_name: string
  page_num: number
  text: string
  score: number
}

export interface Textbook {
  id: number
  name: string
  status: 'pending' | 'indexing' | 'ready' | 'error'
  chunk_count: number
  error_msg: string | null
  created_at: string
}

export interface StudentHistoryMessage {
  id: number
  session_id: number
  role: 'user' | 'assistant'
  content: string
  created_at: string
  system_prompt?: string
}

export const studentLogin = (name: string, password?: string) =>
  studentApi.post<StudentLoginResponse>('/student/login', { name, password })

export const studentRegister = (name: string, password: string) =>
  studentApi.post<StudentLoginResponse>('/student/register', { name, password })

export const studentChangePassword = (current_password: string, new_password: string) =>
  studentApi.post('/student/change-password', { current_password, new_password })

export const studentNewSession = () =>
  studentApi.post<{ session_id: number }>('/student/session/new')

export const studentChat = (message: string, session_id?: number) =>
  studentApi.post<StudentChatResponse>('/student/chat', { message, session_id })

export const studentChatWithFile = (message: string, file: File, session_id?: number) => {
  const form = new FormData()
  form.append('message', message)
  form.append('file', file)
  if (session_id != null) form.append('session_id', String(session_id))
  return studentApi.post<StudentChatResponse>('/student/chat/upload', form)
}

export const studentHistory = (session_id?: number) =>
  studentApi.get<StudentHistoryMessage[]>('/student/history', { params: session_id != null ? { session_id } : undefined })

export interface StudentSession {
  id: number
  started_at: string
  message_count: number
  last_message: string | null
  mode: string | null
}

export const studentListSessions = () =>
  studentApi.get<StudentSession[]>('/student/sessions')

export interface ChallengeSession {
  session_id: number
  mode: string
  started_at: string
}

export const startChallenge = () =>
  studentApi.post<ChallengeSession>('/student/challenge/start')

export const getActiveChallenge = () =>
  studentApi.get<ChallengeSession | null>('/student/challenge/active')

export const startOnboarding = () =>
  studentApi.post<ChallengeSession>('/student/onboarding/start')

export const getActiveOnboarding = () =>
  studentApi.get<ChallengeSession | null>('/student/onboarding/active')

// Textbooks (teacher)
export const getTextbooks = () => api.get<Textbook[]>('/textbooks')
export const getTextbook = (id: number) => api.get<Textbook>(`/textbooks/${id}`)
export const deleteTextbook = (id: number) => api.delete(`/textbooks/${id}`)
export const uploadTextbook = (name: string, file: File) => {
  const form = new FormData()
  form.append('name', name)
  form.append('file', file)
  return api.post<Textbook>('/textbooks', form)
}

// Cases
export interface Case {
  slug: string
  name: string
}
export const getCases = () => axios.get<Case[]>('/api/cases')

