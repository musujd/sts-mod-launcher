import asyncio
import json
import re
import sys
from pathlib import Path

import edge_tts

ROOT = Path(__file__).resolve().parent
SCRIPT = (ROOT / "script.txt").read_text(encoding="utf-8").strip()
VOICE = "zh-CN-YunxiNeural"
RATE = "+3%"
CUE_OFFSET = 3.0
ASSETS = ROOT / "assets"
ASSETS.mkdir(parents=True, exist_ok=True)

PUNCT = set(" \t\r\n，。！？；：、“”‘’（）《》…—,.!?;:")


def visible_len(text: str) -> int:
    return sum(1 for ch in text if ch not in PUNCT)


def wrap_text(text: str, limit: int = 24) -> str:
    tokens = re.findall(r"[A-Za-z0-9_.\-]+|\s+|.", text)
    lines = []
    current = ""
    for token in tokens:
        if token.isspace() and not current:
            continue
        candidate = current + token
        if visible_len(candidate) <= limit:
            current = candidate
            continue
        if token.isspace():
            lines.append(current.strip())
            current = ""
            continue
        break_at = max(
            current.rfind(" "),
            current.rfind("，"),
            current.rfind("；"),
            current.rfind("。"),
            current.rfind("、"),
            current.rfind("："),
        )
        if break_at > 0:
            break_char = current[break_at]
            if break_char in "，。；、：":
                lines.append(current[: break_at + 1].rstrip())
                current = current[break_at + 1 :].strip() + token
            else:
                lines.append(current[:break_at].rstrip())
                current = current[break_at + 1 :].strip() + token
        else:
            lines.append(current.strip())
            current = token
    if current.strip():
        lines.append(current.strip())
    return r"\N".join(lines) if lines else text


def ass_time(seconds: float) -> str:
    seconds = max(0.0, seconds)
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = seconds % 60
    return f"{hours}:{minutes:02d}:{secs:05.2f}"


async def main() -> None:
    communicator = edge_tts.Communicate(SCRIPT, VOICE, rate=RATE)
    audio = bytearray()
    word_boundaries = []
    sentence_boundaries = []

    async for chunk in communicator.stream():
        if chunk["type"] == "audio":
            audio.extend(chunk["data"])
        elif chunk["type"] == "WordBoundary":
            word_boundaries.append(
                {
                    "text": chunk.get("text", ""),
                    "start": chunk["offset"] / 10_000_000,
                    "end": (chunk["offset"] + chunk["duration"]) / 10_000_000,
                }
            )
        elif chunk["type"] == "SentenceBoundary":
            sentence_boundaries.append(
                {
                    "text": chunk.get("text", ""),
                    "start": chunk["offset"] / 10_000_000,
                    "end": (chunk["offset"] + chunk["duration"]) / 10_000_000,
                }
            )

    voice_path = ASSETS / "voice.mp3"
    voice_path.write_bytes(audio)

    boundaries = sentence_boundaries if sentence_boundaries else word_boundaries
    duration = max((boundary["end"] for boundary in boundaries), default=0.0)
    if duration <= 0:
        raise RuntimeError("Edge TTS 没有返回音频时长")

    if sentence_boundaries:
        cues = [
            {
                "text": item["text"],
                "start": round(item["start"] + CUE_OFFSET, 3),
                "end": round(max(item["end"], item["start"] + 0.8) + CUE_OFFSET, 3),
            }
            for item in sentence_boundaries
        ]
    else:
        sentences = [part.strip() for part in re.split(r"(?<=[。！？；])", SCRIPT) if part.strip()]
        cues = []
        boundary_index = 0
        for sentence in sentences:
            target = visible_len(sentence)
            if target == 0:
                continue
            start = None
            end = None
            consumed = 0
            while boundary_index < len(word_boundaries) and consumed < target:
                boundary = word_boundaries[boundary_index]
                boundary_index += 1
                consumed += visible_len(boundary["text"])
                if start is None:
                    start = boundary["start"]
                end = boundary["end"]
            if start is None:
                continue
            if end is None:
                end = start + 1.5
            cues.append(
                {
                    "text": sentence,
                    "start": round(start + CUE_OFFSET, 3),
                    "end": round(max(end, start + 0.8) + CUE_OFFSET, 3),
                }
            )

    # 如果分句和边界数量不一致，按字符比例补齐/裁剪，保证字幕覆盖全片。

    ass_lines = [
        "[Script Info]",
        "ScriptType: v4.00+",
        "PlayResX: 1920",
        "PlayResY: 1080",
        "WrapStyle: 2",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        "Style: Default,Microsoft YaHei,38,&H00FFFFFF,&H000000FF,&H00000000,&H99000000,0,0,0,0,100,100,0.5,0,1,2,0,2,100,100,36,1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    for cue in cues:
        text = wrap_text(cue["text"].rstrip("。！？；"))
        ass_lines.append(
            f"Dialogue: 0,{ass_time(cue['start'])},{ass_time(cue['end'])},Default,,0,0,0,,{text}"
        )

    (ASSETS / "subtitles.ass").write_text("\n".join(ass_lines) + "\n", encoding="utf-8")
    (ASSETS / "timing.json").write_text(
        json.dumps(
            {
                "voice": VOICE,
                "rate": RATE,
                "duration": round(duration, 3),
                "cues": cues,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(json.dumps({"voice": str(voice_path), "duration": round(duration, 3), "cues": len(cues)}, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
