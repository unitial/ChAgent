import { useEffect, useState } from 'react'
import {
  Card, Form, Input, Select, InputNumber, Button,
  Typography, Space, message, Divider, Alert,
} from 'antd'
import { SaveOutlined, UndoOutlined, LockOutlined } from '@ant-design/icons'
import {
  getModelSettings, updateModelSettings,
  getProfileModelSettings, updateProfileModelSettings,
  changePassword,
} from '../api'

const PROVIDER_OPTIONS = [
  { value: 'anthropic', label: 'Anthropic (直连)' },
  { value: 'openrouter', label: 'OpenRouter' },
]

const PROFILE_PROVIDER_OPTIONS = [
  { value: 'inherit', label: '继承全局' },
  { value: 'anthropic', label: 'Anthropic (直连)' },
  { value: 'openrouter', label: 'OpenRouter' },
]

const ANTHROPIC_MODELS = [
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-haiku-4-5-20251001',
]

const OPENROUTER_EXAMPLE_MODELS = [
  'openai/gpt-4o',
  'openai/gpt-4o-mini',
  'google/gemini-pro-1.5',
  'meta-llama/llama-3.1-70b-instruct',
]

export default function ModelSettingsPage() {
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [provider, setProvider] = useState<'anthropic' | 'openrouter'>('anthropic')
  const [keySet, setKeySet] = useState(false)
  const [changeKey, setChangeKey] = useState(false)

  // Profile model state
  const [profileForm] = Form.useForm()
  const [profileLoading, setProfileLoading] = useState(true)
  const [profileSaving, setProfileSaving] = useState(false)
  const [profileProvider, setProfileProvider] = useState<'inherit' | 'anthropic' | 'openrouter'>('inherit')
  const [profileKeySet, setProfileKeySet] = useState(false)
  const [changeProfileKey, setChangeProfileKey] = useState(false)
  const [profileEffective, setProfileEffective] = useState({ provider: '', model: '' })

  // Change password state
  const [pwForm] = Form.useForm()
  const [pwSaving, setPwSaving] = useState(false)

  useEffect(() => {
    getModelSettings()
      .then((res) => {
        const d = res.data
        form.setFieldsValue({
          provider: d.provider,
          model: d.model,
          default_daily_token_limit: d.default_daily_token_limit,
        })
        setProvider(d.provider)
        setKeySet(d.openrouter_api_key_set)
      })
      .finally(() => setLoading(false))

    getProfileModelSettings()
      .then((res) => {
        const d = res.data
        profileForm.setFieldsValue({
          provider: d.raw_provider,
          model: d.raw_model === 'inherit' ? '' : d.raw_model,
        })
        setProfileProvider(d.raw_provider)
        setProfileKeySet(d.openrouter_api_key_set)
        setProfileEffective({ provider: d.effective_provider, model: d.effective_model })
      })
      .finally(() => setProfileLoading(false))
  }, [form, profileForm])

  const handleSave = async () => {
    const values = await form.validateFields()
    setSaving(true)
    try {
      const payload: Parameters<typeof updateModelSettings>[0] = {
        provider: values.provider,
        model: values.model,
        default_daily_token_limit: values.default_daily_token_limit ?? 0,
      }
      if (changeKey && values.openrouter_api_key) {
        payload.openrouter_api_key = values.openrouter_api_key
      }
      await updateModelSettings(payload)
      message.success('设置已保存')
      setChangeKey(false)
      setKeySet(payload.openrouter_api_key ? true : keySet)
    } catch {
      message.error('保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleProfileSave = async () => {
    const values = await profileForm.validateFields()
    setProfileSaving(true)
    try {
      const payload: Parameters<typeof updateProfileModelSettings>[0] = {
        provider: values.provider,
        model: values.provider === 'inherit' ? 'inherit' : (values.model || 'inherit'),
      }
      if (changeProfileKey && values.openrouter_api_key) {
        payload.openrouter_api_key = values.openrouter_api_key
      }
      await updateProfileModelSettings(payload)
      message.success('画像模型设置已保存')
      setChangeProfileKey(false)
      // Refresh effective values
      const res = await getProfileModelSettings()
      setProfileEffective({ provider: res.data.effective_provider, model: res.data.effective_model })
      setProfileKeySet(res.data.openrouter_api_key_set)
    } catch {
      message.error('保存失败')
    } finally {
      setProfileSaving(false)
    }
  }

  const handleProfileReset = async () => {
    setProfileSaving(true)
    try {
      await updateProfileModelSettings({ provider: 'inherit', model: 'inherit' })
      profileForm.setFieldsValue({ provider: 'inherit', model: '' })
      setProfileProvider('inherit')
      message.success('已恢复继承全局设置')
      const res = await getProfileModelSettings()
      setProfileEffective({ provider: res.data.effective_provider, model: res.data.effective_model })
    } catch {
      message.error('重置失败')
    } finally {
      setProfileSaving(false)
    }
  }

  const handleChangePassword = async () => {
    const values = await pwForm.validateFields()
    setPwSaving(true)
    try {
      await changePassword(values.current_password, values.new_password)
      message.success('密码已修改')
      pwForm.resetFields()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || '修改失败')
    } finally {
      setPwSaving(false)
    }
  }

  const modelOptions =
    provider === 'anthropic'
      ? ANTHROPIC_MODELS.map((m) => ({ value: m, label: m }))
      : OPENROUTER_EXAMPLE_MODELS.map((m) => ({ value: m, label: m }))

  const profileModelOptions =
    profileProvider === 'anthropic'
      ? ANTHROPIC_MODELS.map((m) => ({ value: m, label: m }))
      : OPENROUTER_EXAMPLE_MODELS.map((m) => ({ value: m, label: m }))

  return (
    <div>
      <Typography.Title level={4} style={{ marginBottom: 24 }}>
        模型设置
      </Typography.Title>

      <Card loading={loading} style={{ maxWidth: 640, marginBottom: 24 }}>
        <Form form={form} layout="vertical" onFinish={handleSave}>
          <Form.Item name="provider" label="LLM 提供商" rules={[{ required: true }]}>
            <Select
              options={PROVIDER_OPTIONS}
              onChange={(v) => {
                setProvider(v)
                form.setFieldValue('model', v === 'anthropic' ? ANTHROPIC_MODELS[0] : OPENROUTER_EXAMPLE_MODELS[0])
              }}
            />
          </Form.Item>

          <Form.Item name="model" label="模型名称" rules={[{ required: true }]}>
            <Select
              options={modelOptions}
              showSearch
              placeholder={provider === 'openrouter' ? '输入 OpenRouter 模型 ID，如 openai/gpt-4o' : undefined}
            />
          </Form.Item>

          {provider === 'openrouter' && (
            <>
              <Divider />
              {keySet && !changeKey ? (
                <Form.Item label="OpenRouter API Key">
                  <Space>
                    <Alert message="API Key 已设置" type="success" showIcon style={{ flex: 1 }} />
                    <Button size="small" onClick={() => setChangeKey(true)}>更换</Button>
                  </Space>
                </Form.Item>
              ) : (
                <Form.Item
                  name="openrouter_api_key"
                  label="OpenRouter API Key"
                  rules={!keySet ? [{ required: true, message: '请输入 OpenRouter API Key' }] : []}
                >
                  <Input.Password placeholder="sk-or-..." />
                </Form.Item>
              )}
            </>
          )}

          <Divider />

          <Form.Item
            name="default_daily_token_limit"
            label="全局每日 Token 上限（0 = 无限制）"
            tooltip="适用于未单独设置上限的学生"
          >
            <InputNumber min={0} step={1000} style={{ width: 240 }} addonAfter="tokens" />
          </Form.Item>

          <Form.Item>
            <Button
              type="primary"
              icon={<SaveOutlined />}
              loading={saving}
              onClick={handleSave}
            >
              保存设置
            </Button>
          </Form.Item>
        </Form>
      </Card>

      <Card
        title="画像更新专用模型"
        loading={profileLoading}
        style={{ maxWidth: 640, marginBottom: 24 }}
        extra={
          <Button size="small" icon={<UndoOutlined />} onClick={handleProfileReset} loading={profileSaving}>
            恢复继承
          </Button>
        }
      >
        <Alert
          message={`当前生效：${profileEffective.provider} / ${profileEffective.model}`}
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
        />
        <Form form={profileForm} layout="vertical">
          <Form.Item name="provider" label="提供商" rules={[{ required: true }]}>
            <Select
              options={PROFILE_PROVIDER_OPTIONS}
              onChange={(v) => {
                setProfileProvider(v)
                if (v !== 'inherit') {
                  profileForm.setFieldValue('model', v === 'anthropic' ? ANTHROPIC_MODELS[0] : OPENROUTER_EXAMPLE_MODELS[0])
                } else {
                  profileForm.setFieldValue('model', '')
                }
              }}
            />
          </Form.Item>

          {profileProvider === 'inherit' ? (
            <Form.Item label="模型名称">
              <Input disabled value={profileEffective.model} />
            </Form.Item>
          ) : (
            <Form.Item name="model" label="模型名称" rules={[{ required: true }]}>
              <Select
                options={profileModelOptions}
                showSearch
                placeholder={profileProvider === 'openrouter' ? '输入 OpenRouter 模型 ID' : undefined}
              />
            </Form.Item>
          )}

          {profileProvider === 'openrouter' && (
            <>
              <Divider />
              {profileKeySet && !changeProfileKey ? (
                <Form.Item label="画像专用 OpenRouter API Key">
                  <Space>
                    <Alert message="API Key 已设置" type="success" showIcon style={{ flex: 1 }} />
                    <Button size="small" onClick={() => setChangeProfileKey(true)}>更换</Button>
                  </Space>
                </Form.Item>
              ) : (
                <Form.Item
                  name="openrouter_api_key"
                  label="画像专用 OpenRouter API Key（留空则继承全局）"
                >
                  <Input.Password placeholder="sk-or-... （可选）" />
                </Form.Item>
              )}
            </>
          )}

          <Form.Item>
            <Button
              type="primary"
              icon={<SaveOutlined />}
              loading={profileSaving}
              onClick={handleProfileSave}
            >
              保存画像模型设置
            </Button>
          </Form.Item>
        </Form>
      </Card>

      <Card title="修改管理员密码" style={{ maxWidth: 640 }}>
        <Form form={pwForm} layout="vertical">
          <Form.Item
            name="current_password"
            label="当前密码"
            rules={[{ required: true, message: '请输入当前密码' }]}
          >
            <Input.Password placeholder="请输入当前密码" />
          </Form.Item>
          <Form.Item
            name="new_password"
            label="新密码"
            rules={[
              { required: true, message: '请输入新密码' },
              { min: 6, message: '新密码至少需要 6 位' },
            ]}
          >
            <Input.Password placeholder="至少 6 位" />
          </Form.Item>
          <Form.Item
            name="confirm_password"
            label="确认新密码"
            dependencies={['new_password']}
            rules={[
              { required: true, message: '请再次输入新密码' },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('new_password') === value) {
                    return Promise.resolve()
                  }
                  return Promise.reject(new Error('两次输入的密码不一致'))
                },
              }),
            ]}
          >
            <Input.Password placeholder="再次输入新密码" />
          </Form.Item>
          <Form.Item>
            <Button
              type="primary"
              icon={<LockOutlined />}
              loading={pwSaving}
              onClick={handleChangePassword}
            >
              修改密码
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  )
}
