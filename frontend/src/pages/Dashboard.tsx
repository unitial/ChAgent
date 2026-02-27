import { useEffect, useState } from 'react'
import { Row, Col, Card, Statistic, Tag, Typography, Spin, Empty } from 'antd'
import { TeamOutlined, MessageOutlined, FireOutlined } from '@ant-design/icons'
import { getDashboardStats, getHotTopics, type DashboardStats, type HotTopic } from '../api'

export default function Dashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [topics, setTopics] = useState<HotTopic[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([getDashboardStats(), getHotTopics()])
      .then(([statsRes, topicsRes]) => {
        setStats(statsRes.data)
        setTopics(topicsRes.data)
      })
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <Spin size="large" style={{ display: 'block', margin: '100px auto' }} />

  const maxCount = topics[0]?.count || 1

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        数据概览
      </Typography.Title>
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={8}>
          <Card>
            <Statistic
              title="注册学生数"
              value={stats?.total_students ?? 0}
              prefix={<TeamOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card>
            <Statistic
              title="今日活跃"
              value={stats?.active_today ?? 0}
              prefix={<FireOutlined />}
              valueStyle={{ color: '#cf1322' }}
            />
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card>
            <Statistic
              title="消息总数"
              value={stats?.total_messages ?? 0}
              prefix={<MessageOutlined />}
            />
          </Card>
        </Col>
      </Row>

      <Typography.Title level={4} style={{ marginTop: 24 }}>
        高频知识点
      </Typography.Title>
      <Card>
        {topics.length === 0 ? (
          <Empty description="暂无数据" />
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            {topics.map(({ topic, count }) => {
              const ratio = count / maxCount
              const fontSize = 12 + Math.round(ratio * 14)
              return (
                <Tag
                  key={topic}
                  color={ratio > 0.7 ? 'red' : ratio > 0.4 ? 'orange' : 'blue'}
                  style={{ fontSize, padding: '4px 10px', cursor: 'default' }}
                >
                  {topic} ({count})
                </Tag>
              )
            })}
          </div>
        )}
      </Card>
    </div>
  )
}
