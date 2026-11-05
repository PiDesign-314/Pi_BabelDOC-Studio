"""LLM provider presets for BabelDOC Studio.

BabelDOC talks to any OpenAI-compatible endpoint, so every preset only needs a
base URL plus a list of suggested model ids.  Users can always overwrite both.
"""

from __future__ import annotations

PRESETS: list[dict] = [
    {
        "id": "zhipu",
        "name": "智谱 GLM",
        "base_url": "https://open.bigmodel.cn/api/paas/v4",
        "models": ["glm-4-flash", "glm-4-air", "glm-4-plus", "glm-4.6", "glm-4.5-air"],
        "hint": "glm-4-flash 价格低、速度快，适合长文档；glm-4-plus 质量更高。",
    },
    {
        "id": "openai",
        "name": "OpenAI",
        "base_url": "https://api.openai.com/v1",
        "models": ["gpt-4o-mini", "gpt-4.1-mini", "gpt-4o", "gpt-4.1"],
        "hint": "gpt-4o-mini / gpt-4.1-mini 性价比高。",
    },
    {
        "id": "deepseek",
        "name": "DeepSeek",
        "base_url": "https://api.deepseek.com",
        "models": ["deepseek-chat", "deepseek-reasoner"],
        "hint": "deepseek-chat 速度快、成本低，适合整篇论文翻译。",
    },
    {
        "id": "qwen",
        "name": "通义千问（阿里云百炼）",
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "models": ["qwen-plus", "qwen-flash", "qwen-max", "qwen3-max"],
        "hint": "百炼兼容模式，qwen-plus 综合表现稳定。",
    },
    {
        "id": "openrouter",
        "name": "OpenRouter",
        "base_url": "https://openrouter.ai/api/v1",
        "models": [
            "openai/gpt-4o-mini",
            "anthropic/claude-sonnet-4",
            "google/gemini-2.5-flash",
        ],
        "hint": "一个 Key 调用多家模型，模型名需带厂商前缀。",
    },
    {
        "id": "moonshot",
        "name": "Moonshot Kimi",
        "base_url": "https://api.moonshot.cn/v1",
        "models": ["kimi-k2-turbo-preview", "moonshot-v1-32k"],
        "hint": "长上下文友好，适合书籍级长文档。",
    },
    {
        "id": "google_free",
        "name": "Google 翻译（免费）",
        "base_url": "",
        "models": ["google-translate"],
        "hint": "内置免费 Google 翻译接口，无需 Key；速度一般，术语/公式保留不如大模型，可能被限流。",
        "free": True,
    },
    {
        "id": "gemini",
        "name": "Google Gemini（免费额度）",
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai/",
        "models": ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
        "hint": "Google AI Studio 提供免费额度，需要申请 API Key；部分地区访问需要代理。",
        "free": True,
    },
    {
        "id": "openrouter_free",
        "name": "OpenRouter 免费模型",
        "base_url": "https://openrouter.ai/api/v1",
        "models": [
            "deepseek/deepseek-chat-v3-0324:free",
            "google/gemini-2.0-flash-exp:free",
            "meta-llama/llama-3.3-70b-instruct:free",
        ],
        "hint": "模型名以 :free 结尾即免费，通常限速/排队；需要 OpenRouter API Key。",
        "free": True,
    },
    {
        "id": "ollama",
        "name": "Ollama 本地（免费）",
        "base_url": "http://127.0.0.1:11434/v1",
        "models": ["qwen2.5:7b", "llama3.1:8b", "gemma3:4b"],
        "hint": "本机运行、完全免费；需先安装 Ollama 并 ollama pull 对应模型。",
        "free": True,
    },
    {
        "id": "custom",
        "name": "自定义（OpenAI 兼容）",
        "base_url": "",
        "models": [],
        "hint": "填写自建或第三方网关的 /v1 兼容地址与模型名。",
    },
]

PRESET_MAP = {item["id"]: item for item in PRESETS}
DEFAULT_PROVIDER = "zhipu"


def get_preset(provider_id: str) -> dict:
    return PRESET_MAP.get(provider_id, PRESET_MAP["custom"])
