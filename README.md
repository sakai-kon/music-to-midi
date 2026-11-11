# Music to MIDI

Spotify Basic Pitch の公式TypeScript版を使って、音声ファイルをブラウザ内でポリフォニックMIDIへ変換するWebアプリです。**GitHub Pagesで公開でき、PythonサーバーやAPIキーは不要です。**

## Live site

公開後のURL:

https://sakai-kon.github.io/music-to-midi/

GitHub Pagesの初回有効化が必要な場合は、リポジトリの **Settings → Pages → Build and deployment → Source → GitHub Actions** を選択してください。**main** へのpush後、Actionsのデプロイが成功すると公開されます。

## Features

- MP3 / WAV / FLAC / M4A / OGG / AIFF の読み込み（実際にデコード可能な形式はブラウザに依存）
- Spotify Basic Pitchによるポリフォニック音符推定
- オンセット・音の長さ・ベロシティを含むMIDIノート
- BPMの簡易自動推定または手動設定
- 拍子、検出感度、簡易ノイズゲートの設定
- ピアノロール、ブラウザ内サウンドプレビュー、MIDIダウンロード
- 音声を外部サーバーへ送信しないローカル処理
- モデルは初回に読み込まれ、同じブラウザではキャッシュが利用されます

## How it works

1. ブラウザが音声ファイルを読み込み、モノラル化して22,050 Hzへリサンプリングします。
2. TensorFlow.jsとSpotify Basic Pitchモデルをブラウザ内で実行します。
3. 推定したフレーム・オンセット・ピッチ情報からノートイベントを作ります。
4. MIDIファイルをブラウザ内で生成し、ダウンロードします。

音声ファイル本体はGitHubや外部APIへアップロードされません。GitHub PagesはHTML/JavaScript/モデルファイルの配信だけを行います。AIモデルは初回アクセス時にダウンロードされるため、その時点ではインターネット接続が必要です。

## Run locally

Node.js 20以上を推奨します。

~~~bash
git clone https://github.com/sakai-kon/music-to-midi.git
cd music-to-midi
npm install
npm run dev
~~~

表示されたローカルURL（通常は http://localhost:5173/）をブラウザで開きます。

本番ビルドの確認:

~~~bash
npm run check
npm run build
npm run preview
~~~

npm run build はBasic Pitchのモデルファイルを public/models/ にコピーしてから、Viteで dist/ を生成します。

## GitHub Pages deployment

.github/workflows/pages.yml が main へのpushを検出し、次を自動実行します。

1. Node.jsのセットアップ
2. npm依存パッケージのインストール
3. JavaScript構文チェック
4. Basic Pitchモデルを含む静的ビルド
5. GitHub Pagesへのデプロイ

Viteのbase pathは /music-to-midi/ に設定しています。ユーザー側にPythonやサーバーの起動は必要ありません。

## Limits and accuracy

- ファイルサイズ上限: 30 MB
- 音源の長さ上限: 3分
- 変換は端末のCPU/GPUと利用可能メモリに依存します。スマートフォンでは長い音源や多数のノートの処理に時間がかかることがあります。
- 対応コーデックはブラウザの decodeAudioData 実装に依存します。読み込みに失敗する形式はWAVまたはMP3へ変換してからお試しください。
- 自動BPMは波形のエネルギー変化から求める簡易推定です。複雑なリズムやテンポ変化がある曲は、手動設定を使ってください。
- ノイズ低減は弱い音を抑える簡易ノイズゲートです。音源によっては弱いノートも小さくなるため、0%から調整してください。
- Basic Pitchはポリフォニック推定に対応しますが、完成済みのフルミックス（複数楽器・ボーカル・ドラムが重なった音源）では誤検出や音抜けが発生することがあります。特に単一楽器に近い音源の方が良好な結果を得やすいモデルです。必要に応じてDAWで編集してください。

## Dependencies

- @spotify/basic-pitch 1.0.1 (Apache-2.0)
- @tensorflow/tfjs 3.2.0
- vite 6.4.1
- Node.js 20+

Basic Pitch: https://github.com/spotify/basic-pitch-ts
Python Basic Pitch: https://github.com/spotify/basic-pitch
Vite: https://vite.dev/

## License

アプリ固有のコードはMIT Licenseです。Basic PitchはApache License 2.0で提供されています。各依存パッケージはそれぞれのライセンスに従います。
