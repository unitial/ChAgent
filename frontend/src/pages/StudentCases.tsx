import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { getCases, Case } from '../api'

function CaseList() {
    const [cases, setCases] = useState<Case[]>([])
    const [loading, setLoading] = useState(true)
    const navigate = useNavigate()

    useEffect(() => {
        getCases()
            .then(res => setCases(res.data))
            .finally(() => setLoading(false))
    }, [])

    if (loading) {
        return (
            <div style={styles.center}>
                <div style={styles.spinner} />
                <p style={{ color: '#888', marginTop: 16 }}>加载中…</p>
            </div>
        )
    }

    if (cases.length === 0) {
        return (
            <div style={styles.center}>
                <p style={{ color: '#888', fontSize: 16 }}>暂无案例</p>
            </div>
        )
    }

    return (
        <div style={styles.container}>
            <h2 style={styles.pageTitle}>📚 案例学习</h2>
            <div style={styles.grid}>
                {cases.map(c => (
                    <div
                        key={c.slug}
                        style={styles.card}
                        onClick={() => navigate(`/learn/cases/${c.slug}`)}
                        onMouseEnter={e => {
                            (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-4px)'
                                ; (e.currentTarget as HTMLDivElement).style.boxShadow = '0 8px 24px rgba(0,0,0,0.12)'
                        }}
                        onMouseLeave={e => {
                            (e.currentTarget as HTMLDivElement).style.transform = 'none'
                                ; (e.currentTarget as HTMLDivElement).style.boxShadow = '0 2px 8px rgba(0,0,0,0.06)'
                        }}
                    >
                        <div style={styles.cardIcon}>🧪</div>
                        <div style={styles.cardTitle}>{c.name}</div>
                        <div style={styles.cardAction}>开始学习 →</div>
                    </div>
                ))}
            </div>
        </div>
    )
}

function CasePlayer() {
    const { slug } = useParams<{ slug: string }>()
    const navigate = useNavigate()

    return (
        <div style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column' }}>
            <div style={styles.playerHeader}>
                <button onClick={() => navigate('/learn/cases')} style={styles.backBtn}>
                    ← 返回案例列表
                </button>
            </div>
            <iframe
                src={`/api/cases/${slug}/player`}
                style={{ flex: 1, border: 'none', width: '100%' }}
                title="Case Player"
            />
        </div>
    )
}

export { CaseList, CasePlayer }

const styles: Record<string, React.CSSProperties> = {
    container: {
        maxWidth: 960,
        margin: '0 auto',
        padding: '32px 24px',
    },
    center: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
    },
    spinner: {
        width: 36,
        height: 36,
        border: '3px solid #e5e5e5',
        borderTopColor: '#1677ff',
        borderRadius: '50%',
        animation: 'spin 0.8s linear infinite',
    },
    pageTitle: {
        fontSize: 24,
        fontWeight: 600,
        marginBottom: 24,
        color: '#1a1a1a',
    },
    grid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
        gap: 20,
    },
    card: {
        padding: 24,
        borderRadius: 12,
        background: '#fff',
        boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
        cursor: 'pointer',
        transition: 'transform 0.2s, box-shadow 0.2s',
        border: '1px solid #f0f0f0',
    },
    cardIcon: {
        fontSize: 32,
        marginBottom: 12,
    },
    cardTitle: {
        fontSize: 16,
        fontWeight: 600,
        color: '#1a1a1a',
        marginBottom: 12,
    },
    cardAction: {
        fontSize: 13,
        color: '#1677ff',
        fontWeight: 500,
    },
    playerHeader: {
        padding: '8px 16px',
        background: '#fafafa',
        borderBottom: '1px solid #e8e8e8',
    },
    backBtn: {
        background: 'none',
        border: '1px solid #d9d9d9',
        borderRadius: 6,
        padding: '6px 16px',
        cursor: 'pointer',
        fontSize: 14,
        color: '#333',
    },
}
