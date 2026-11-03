"""Language codes understood by BabelDOC (passed through to `--lang-in/--lang-out`)."""

from __future__ import annotations

LANGUAGES: list[dict] = [
    {"code": "zh", "label": "简体中文"},
    {"code": "zh-TW", "label": "繁体中文"},
    {"code": "en", "label": "英语"},
    {"code": "ja", "label": "日语"},
    {"code": "ko", "label": "韩语"},
    {"code": "fr", "label": "法语"},
    {"code": "de", "label": "德语"},
    {"code": "es", "label": "西班牙语"},
    {"code": "pt", "label": "葡萄牙语"},
    {"code": "ru", "label": "俄语"},
    {"code": "it", "label": "意大利语"},
    {"code": "ar", "label": "阿拉伯语"},
    {"code": "th", "label": "泰语"},
    {"code": "vi", "label": "越南语"},
    {"code": "id", "label": "印尼语"},
    {"code": "ms", "label": "马来语"},
    {"code": "tr", "label": "土耳其语"},
    {"code": "nl", "label": "荷兰语"},
    {"code": "pl", "label": "波兰语"},
    {"code": "uk", "label": "乌克兰语"},
    {"code": "cs", "label": "捷克语"},
    {"code": "ro", "label": "罗马尼亚语"},
    {"code": "sv", "label": "瑞典语"},
    {"code": "da", "label": "丹麦语"},
    {"code": "fi", "label": "芬兰语"},
    {"code": "el", "label": "希腊语"},
    {"code": "he", "label": "希伯来语"},
    {"code": "hi", "label": "印地语"},
    {"code": "fa", "label": "波斯语"},
    {"code": "hu", "label": "匈牙利语"},
]

DEFAULT_LANG_IN = "en"
DEFAULT_LANG_OUT = "zh"


def label_of(code: str) -> str:
    for item in LANGUAGES:
        if item["code"].lower() == (code or "").lower():
            return item["label"]
    return code or "未知"
