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
  daily_token_limit: number | null
  today_tokens: number
  created_at: string
  updated_at: string
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

// Students
export const getStudents = () => api.get<Student[]>('/students')
export const getStudent = (id: number) => api.get<Student>(`/students/${id}`)
export const getStudentConversations = (id: number) => api.get<Conversation[]>(`/students/${id}/conversations`)

// Skills
export const getSkills = () => api.get<Skill[]>('/skills')
export const createSkill = (data: Omit<Skill, 'id' | 'created_at'>) => api.post<Skill>('/skills', data)
export const updateSkill = (id: string, data: Partial<Skill>) => api.put<Skill>(`/skills/${id}`, data)
export const deleteSkill = (id: string) => api.delete(`/skills/${id}`)

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
export const triggerAllProfileUpdates = () =>
  api.post('/profiles/update-all')

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
}

export interface StudentHistoryMessage {
  id: number
  session_id: number
  role: 'user' | 'assistant'
  content: string
  created_at: string
  system_prompt?: string
}

export const studentLogin = (name: string) =>
  studentApi.post<StudentLoginResponse>('/student/login', { name })

export const studentChat = (message: string, session_id?: number) =>
  studentApi.post<StudentChatResponse>('/student/chat', { message, session_id })

export const studentHistory = (session_id?: number) =>
  studentApi.get<StudentHistoryMessage[]>('/student/history', { params: session_id != null ? { session_id } : undefined })

export interface ChallengeSession {
  session_id: number
  mode: string
  started_at: string
}

export const startChallenge = () =>
  studentApi.post<ChallengeSession>('/student/challenge/start')

export const getActiveChallenge = () =>
  studentApi.get<ChallengeSession | null>('/student/challenge/active')
