import { useEffect, useState } from 'react'
import {
  Card, Form, Input, Select, InputNumber, Button, Switch,
  Typography, Space, message, Divider, Alert,
} from 'antd'
import { SaveOutlined } from '@ant-design/icons'
import { getModelSettings, updateModelSettings, type ModelSettings } from '../api'

const PROVIDER_OPTIONS = [
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
  }, [form])

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

  const modelOptions =
    provider === 'anthropic'
      ? ANTHROPIC_MODELS.map((m) => ({ value: m, label: m }))
      : OPENROUTER_EXAMPLE_MODELS.map((m) => ({ value: m, label: m }))

  return (
    <div>
      <Typography.Title level={4} style={{ marginBottom: 24 }}>
        模型设置
      </Typography.Title>

      <Card loading={loading} style={{ maxWidth: 640 }}>
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
              mode="combobox"
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
    </div>
  )
}
