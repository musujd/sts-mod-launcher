# 分享视频工程

成片：`out/尖塔Mod启动器-分享视频.mp4`

- 67 秒，1920×1080，30fps
- AI 中文配音（Edge TTS `zh-CN-YunxiNeural`）+ 硬字幕
- 演示数据来自 `setup-demo.js` 创建的 `%TEMP%\video-demo`，不会暴露真实 mod 列表

## 重新生成

```powershell
# 需要 Python + edge-tts，以及 FFmpeg
$env:FFMPEG_PATH = 'C:\path\to\ffmpeg.exe'

# 1. 生成配音和字幕
python tts.py

# 2. 创建干净演示环境（需要已安装启动器）
node setup-demo.js

# 3. 关闭所有启动器后，录制 57 秒演示画面
node capture-ui.js --duration 57

# 4. 合成片头、演示、片尾、配音和字幕
node render.js
```

`render.js` 会从 `C:\Windows\Fonts` 临时复制微软雅黑到 `assets/fonts` 给 libass 使用，这些字体不会随项目分发。

## 修改内容

- 解说词：`script.txt`
- 片头/片尾文案：`assets/title.html`、`assets/outro.html`
- 配音音色/语速：`tts.py` 里的 `VOICE`、`RATE`
- 演示动作：`capture-ui.js`
- 片尾下载地址目前是「见简介 / GitHub Releases」占位，可在 `assets/outro.html` 改成实际链接。
