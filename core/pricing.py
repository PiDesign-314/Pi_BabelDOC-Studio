"""Token pricing used to estimate the cost of a translation run.

Prices are *reference* values (per 1M tokens) collected around 2025-11 and can
be overridden in the UI, because every provider changes them regularly and
self-hosted gateways differ entirely.
"""

from __future__ import annotations

CURRENCY_SYMBOLS = {"CNY": "¥", "USD": "$"}

# model prefix -> (input, output, cached_input, currency)
PRICES: dict[str, tuple[float, float, float, str]] = {
    # 智谱 GLM（元 / 百万 tokens）
    "glm-4-flash": (0.0, 0.0, 0.0, "CNY"),
    "glm-4.5-flash": (0.0, 0.0, 0.0, "CNY"),
    "glm-4-air": (0.5, 0.5, 0.5, "CNY"),
    "glm-4-plus": (5.0, 5.0, 5.0, "CNY"),
    "glm-4.6": (4.0, 16.0, 4.0, "CNY"),
    # DeepSeek（元 / 百万 tokens）
    "deepseek-chat": (2.0, 8.0, 0.5, "CNY"),
    "deepseek-reasoner": (4.0, 16.0, 1.0, "CNY"),
    # 阿里云百炼 Qwen（元 / 百万 tokens）
    "qwen-flash": (0.3, 0.6, 0.3, "CNY"),
    "qwen-plus": (0.8, 2.0, 0.8, "CNY"),
    "qwen-max": (2.4, 9.6, 2.4, "CNY"),
    "qwen3-max": (6.0, 24.0, 6.0, "CNY"),
    # Moonshot（元 / 百万 tokens）
    "moonshot-v1-8k": (12.0, 12.0, 12.0, "CNY"),
    "moonshot-v1-32k": (24.0, 24.0, 24.0, "CNY"),
    "kimi-k2-turbo-preview": (4.0, 16.0, 4.0, "CNY"),
    # OpenAI（美元 / 百万 tokens）
    "gpt-4o-mini": (0.15, 0.60, 0.075, "USD"),
    "gpt-4.1-mini": (0.40, 1.60, 0.10, "USD"),
    "gpt-4.1": (2.00, 8.00, 0.50, "USD"),
    "gpt-4o": (2.50, 10.00, 1.25, "USD"),
    # OpenRouter
    "openai/gpt-4o-mini": (0.15, 0.60, 0.075, "USD"),
    "openai/gpt-4o": (2.50, 10.00, 1.25, "USD"),
    "anthropic/claude-sonnet-4": (3.00, 15.00, 0.30, "USD"),
    "google/gemini-2.5-flash": (0.30, 2.50, 0.075, "USD"),
}

PROVIDER_CURRENCY = {
    "zhipu": "CNY",
    "deepseek": "CNY",
    "qwen": "CNY",
    "moonshot": "CNY",
    "openai": "USD",
    "openrouter": "USD",
    "custom": "USD",
}


def _match(model: str) -> tuple[float, float, float, str] | None:
    name = (model or "").strip().lower()
    if not name:
        return None
    if name in PRICES:
        return PRICES[name]
    for key in sorted(PRICES, key=len, reverse=True):
        if name.startswith(key):
            return PRICES[key]
    return None


def estimate(
    usage: dict,
    model: str,
    provider: str = "",
    overrides: dict | None = None,
) -> dict:
    """Estimate cost from token usage.

    ``usage`` keys: prompt_tokens, completion_tokens, cached_tokens.
    ``overrides`` keys: input, output, currency (price per 1M tokens).
    """
    prompt = int(usage.get("prompt_tokens") or 0)
    completion = int(usage.get("completion_tokens") or 0)
    cached = min(int(usage.get("cached_tokens") or 0), prompt)

    override = overrides or {}
    input_price = override.get("input")
    output_price = override.get("output")
    currency = override.get("currency") or PROVIDER_CURRENCY.get(provider) or "CNY"

    source = "override"
    if input_price in (None, "") or output_price in (None, ""):
        rule = _match(model)
        if not rule:
            return {
                "known": False,
                "prompt_tokens": prompt,
                "completion_tokens": completion,
                "cached_tokens": cached,
                "currency": currency,
                "symbol": CURRENCY_SYMBOLS.get(currency, ""),
                "amount": 0.0,
                "source": "unknown",
            }
        input_price, output_price, cached_price, rule_currency = rule
        currency = rule_currency
        source = "table"
    else:
        input_price = float(input_price)
        output_price = float(output_price)
        cached_price = float(override.get("cached") or input_price)

    billable = max(0, prompt - cached)
    amount = (
        billable / 1_000_000 * float(input_price)
        + cached / 1_000_000 * float(cached_price)
        + completion / 1_000_000 * float(output_price)
    )
    return {
        "known": True,
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "cached_tokens": cached,
        "input_price": float(input_price),
        "output_price": float(output_price),
        "currency": currency,
        "symbol": CURRENCY_SYMBOLS.get(currency, ""),
        "amount": round(amount, 6),
        "source": source,
    }
