import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { Layout as AntLayout, Menu, Button, Typography, Space } from 'antd'
import {
  DashboardOutlined,
  TeamOutlined,
  BulbOutlined,
  MessageOutlined,
  LogoutOutlined,
  SettingOutlined,
  RobotOutlined,
  BookOutlined,
  ExperimentOutlined,
} from '@ant-design/icons'

const { Header, Sider, Content } = AntLayout

const menuItems = [
  { key: '/dashboard', icon: <DashboardOutlined />, label: 'Dashboard' },
  { key: '/students', icon: <TeamOutlined />, label: '学生管理' },
  { key: '/skills', icon: <BulbOutlined />, label: 'Skills' },
  { key: '/conversations', icon: <MessageOutlined />, label: '对话记录' },
  { key: '/teacher-chat', icon: <RobotOutlined />, label: '教师助手' },
  { key: '/textbooks', icon: <BookOutlined />, label: '教材管理' },
  { key: '/cases', icon: <ExperimentOutlined />, label: '案例' },
  { key: '/model-settings', icon: <SettingOutlined />, label: '模型设置' },
]

export default function Layout() {
  const navigate = useNavigate()
  const location = useLocation()

  const handleLogout = () => {
    localStorage.removeItem('token')
    navigate('/login')
  }

  return (
    <AntLayout style={{ minHeight: '100vh' }}>
      <Sider theme="dark" width={200}>
        <div style={{ padding: '16px', textAlign: 'center' }}>
          <Typography.Title level={4} style={{ color: '#fff', margin: 0 }}>
            ChAgent
          </Typography.Title>
          <Typography.Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12 }}>
            OS 课程助教
          </Typography.Text>
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[location.pathname]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
        />
      </Sider>
      <AntLayout>
        <Header style={{ background: '#fff', padding: '0 24px', display: 'flex', justifyContent: 'flex-end', alignItems: 'center' }}>
          <Space>
            <Button icon={<LogoutOutlined />} onClick={handleLogout} type="text">
              退出登录
            </Button>
          </Space>
        </Header>
        <Content style={{ margin: '24px', background: '#fff', padding: 24, borderRadius: 8 }}>
          <Outlet />
        </Content>
      </AntLayout>
    </AntLayout>
  )
}
