import { useState, useEffect } from 'react'
import { List, Typography, Card, Empty, Spin } from 'antd'
import { ExperimentOutlined } from '@ant-design/icons'
import { getCases, Case } from '../api'

export default function Cases() {
    const [cases, setCases] = useState<Case[]>([])
    const [loading, setLoading] = useState(false)
    const [selected, setSelected] = useState<Case | null>(null)

    useEffect(() => {
        setLoading(true)
        getCases()
            .then(res => {
                setCases(res.data)
                if (res.data.length > 0) setSelected(res.data[0])
            })
            .finally(() => setLoading(false))
    }, [])

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 112px)' }}>
            <Typography.Title level={4} style={{ marginTop: 0, marginBottom: 16 }}>案例管理</Typography.Title>

            {loading ? (
                <div style={{ textAlign: 'center', padding: 48 }}><Spin size="large" /></div>
            ) : cases.length === 0 ? (
                <Empty description="暂无案例" />
            ) : (
                <div style={{ display: 'flex', flex: 1, gap: 16, minHeight: 0 }}>
                    {/* Case list sidebar */}
                    <Card
                        size="small"
                        style={{ width: 220, flexShrink: 0, overflow: 'auto' }}
                        bodyStyle={{ padding: 0 }}
                    >
                        <List
                            dataSource={cases}
                            renderItem={(item) => (
                                <List.Item
                                    onClick={() => setSelected(item)}
                                    style={{
                                        cursor: 'pointer',
                                        padding: '10px 16px',
                                        background: selected?.slug === item.slug ? '#e6f4ff' : undefined,
                                    }}
                                >
                                    <List.Item.Meta
                                        avatar={<ExperimentOutlined style={{ fontSize: 18, color: '#1677ff' }} />}
                                        title={<span style={{ fontSize: 13 }}>{item.name}</span>}
                                    />
                                </List.Item>
                            )}
                        />
                    </Card>

                    {/* Player iframe */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                        {selected ? (
                            <iframe
                                key={selected.slug}
                                src={`/api/cases/${selected.slug}/player`}
                                style={{
                                    width: '100%',
                                    height: '100%',
                                    border: '1px solid #d9d9d9',
                                    borderRadius: 8,
                                }}
                                title={selected.name}
                            />
                        ) : (
                            <Empty description="请从左侧选择一个案例" />
                        )}
                    </div>
                </div>
            )}
        </div>
    )
}
