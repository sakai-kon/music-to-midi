# Music to MIDI

Spotify Basic Pitch を使って、音声ファイルからポリフォニック（和音を含む）MIDIを作るローカルWebアプリです。

## Features

- MP3 / WAV / FLAC / M4A / OGG / AIFF をドラッグ＆ドロップまたはファイル選択で読み込み
- Spotify Basic Pitch による複数音の推定
- オンセット・音の長さ・ベロシティを含むMIDIを書き出し
- 感度スライダー（オンセット／フレームのしきい値と最小音価に反映）
- ノイズ低減スライダー
- BPM自動推定または手動指定、拍子設定
- ピアノロール表示、ブラウザ内プレビュー、MIDダウンロード
- 音声ファイルはサーバーへ保存せず、一時ディレクトリで処理後に削除

## Requirements

- Python **3.10** 推奨
- Windows 10/11、macOS、Ubuntu Linux
- インターネット接続（初回のPythonパッケージ導入用）
- 数分の音源を処理する場合は、十分なメモリとCPU時間

Basic Pitch のモデルと依存ライブラリは、初回実行時またはパッケージ導入時に取得されます。推論はローカルPC上で実行されます。

## Setup

### Windows (PowerShell)

~~~powershell
py -3.10 -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
python -m uvicorn app:app --host 127.0.0.1 --port 8000
~~~

### macOS / Linux

~~~bash
python3.10 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -r requirements.txt
python -m uvicorn app:app --host 127.0.0.1 --port 8000
~~~

ブラウザで **http://127.0.0.1:8000** を開きます。

終了するときはターミナルで Ctrl + C を押してください。

## How to use

1. 音源をドロップするか「ファイルを選択」を押します。
2. BPMを自動検出するか、手動でBPMを指定します。
3. 必要に応じて拍子、感度、ノイズ低減を調整します。
4. 「MIDIに変換」を押します。長い音源や初回推論では数十秒以上かかる場合があります。
5. ピアノロールとプレビューを確認し、「MIDIをダウンロード」を押します。

## Accuracy notes

このアプリはSpotify Basic Pitchを使用します。Basic Pitchはポリフォニック音符推定に対応していますが、**どの音源でも完全・極めて正確に復元できるわけではありません**。公式説明でも、特に単一楽器に近い音源で良好に動作するとされています。複数楽器が重なった完成済みミックス、強い残響、歪み、ドラム、声や効果音が混在する音源では、誤検出・音抜け・音価のずれが生じることがあります。最終的な譜面や演奏データとして使う前に、DAWや譜面ソフトで確認してください。

感度を上げると小さな音や短い音を拾いやすくなりますが、誤検出も増えやすくなります。ノイズ低減も音色によっては弱い音を削るため、設定を変えて複数回比較するのがおすすめです。

## Limits and privacy

- アップロード上限: **50 MB**
- 音源の長さ上限: **6分**
- 音声データは変換処理用の一時ディレクトリにのみ書き込み、処理終了後に削除します。
- デフォルトでは 127.0.0.1 だけで待ち受けます。インターネットに公開する設定にはしていません。
- 公開サーバーに配置する場合は、認証、レート制限、ストレージ分離、HTTPS、長時間ジョブ管理などを追加してください。

## Tech stack

- FastAPI / Uvicorn
- Spotify Basic Pitch 0.4.0
- librosa / noisereduce / soundfile
- imageio-ffmpeg (音声デコード)
- pretty_midi (MIDIデータ)

## References

- Basic Pitch: https://github.com/spotify/basic-pitch
- Basic Pitch inference API: https://github.com/spotify/basic-pitch/blob/main/basic_pitch/inference.py
- FastAPI: https://fastapi.tiangolo.com/

## License

このリポジトリのアプリコードはMIT Licenseです。Basic Pitchおよび各依存パッケージは、それぞれのライセンスに従います。
