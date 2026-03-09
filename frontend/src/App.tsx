import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Students from './pages/Students'
import Skills from './pages/Skills'
import Conversations from './pages/Conversations'
import ModelSettingsPage from './pages/ModelSettings'
import TeacherChat from './pages/TeacherChat'
import Textbooks from './pages/Textbooks'
import Cases from './pages/Cases'
import { CaseList, CasePlayer } from './pages/StudentCases'
import Layout from './components/Layout'
import StudentChat from './pages/StudentChat'

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const token = localStorage.getItem('token')
  return token ? <>{children}</> : <Navigate to="/login" replace />
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/chat" element={<StudentChat />} />
        <Route path="/learn/cases" element={<CaseList />} />
        <Route path="/learn/cases/:slug" element={<CasePlayer />} />
        <Route
          path="/"
          element={
            <PrivateRoute>
              <Layout />
            </PrivateRoute>
          }
        >
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="students" element={<Students />} />
          <Route path="skills" element={<Skills />} />
          <Route path="conversations" element={<Conversations />} />
          <Route path="model-settings" element={<ModelSettingsPage />} />
          <Route path="teacher-chat" element={<TeacherChat />} />
          <Route path="textbooks" element={<Textbooks />} />
          <Route path="cases" element={<Cases />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
