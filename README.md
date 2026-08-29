# ORIAI — 伊藤PJ 2026

未踏ジュニア2026「LLMを用いた折り紙展開図作成ソフト」のブラウザ版プロトタイプです。
公開先は [GitHub Pages](https://yuka-718.github.io/oriai-stepwise/) です。

## What works

- プロンプト入力
- 参考画像アップロード
- CodexによるOriedita MCPの実操作と、99点到達まで回数上限なしの画像評価
- COrigami-inspired clean-room生成器による、検証後FOLDの最終状態プレビュー
- Origami Search 625作品と5,157件の構造知識を生成時だけ検索するRAG
- Orieditaで検証した展開図と2D平坦折り
- 同一CPに折角を与えた、ドラッグ回転対応の3Dプレビュー
- simple foldによる首・翼・脚などの姿勢調整
- 山谷1組のnarrowingによる先端部位の細部造形
- 第1〜4段階それぞれのFOLD保存、cpHash、操作trace、検証範囲表示
- 失効する公開トンネルURLをruntimeブランチから自動検出

## Local development

```bash
npm install
npm run dev
```

`http://localhost:3000/` で確認できます。
localhostでは `http://localhost:8788` のローカル生成サービスへ直接接続します。

## COrigami-inspired final-state pipeline

公開画面は、RAGで選んだ初期FOLDをCodexとOrieditaで反復改善し、Orieditaの2D折り上がり画像に
対するCodexの見た目評価が99点以上になった時だけ結果を表示します。表示する最終FOLDから、
折順を生成せず最終状態を次の4段階で作ります。

1. 展開図 + Orieditaの折り上がり2D
2. 同じCPへ部分折り角を与えた3Dプレビュー
3. 意味部位を対象にしたsimple fold姿勢調整
4. 山谷のcrease pairを使うnarrowing細部造形

base FOLDには `SemanticTree`、radial flapへのpacking trace、`faces_vertices`、
`edges_foldAngle`、安定edge ID、意味部位を保存します。
第2〜4段階は頂点・辺・面を変えず、角度と山谷を段階的に更新します。99点の評価対象は
第1段階のOriedita 2D折り上がり画像です。第1段階だけが
Orieditaの2D平坦折り検証済みで、後続段階はOrigami Simulatorによるゼロ厚み・全折線同時の
角度プレビューです。自己衝突、紙厚、手の到達可能性、折順は検証済みとは表示しません。

論文の非公開コード・重み・データを複製したものではないため、実装名は
`COrigami-inspired clean-room` としています。現状の対象は単頂点base familyと
`radial_single_vertex` adapterに限定され、論文型のbox-pleat packingは未実装として記録します。

## Codex × Oriedita worker

公開画面はリクエストごとに `codex_mcp_stepwise` モードを指定し、検証用MacのAPIを通じてCodex CLIを起動します。Codexは
Oriedita MCPへ接続し、議事録の方針に沿って「折り線を1本追加 → 平坦折りを計算 →
折り上がり画像を評価 → 改善しなければ直前のFOLDへ戻す」を実行します。一手ごとに新しい
`codex exec --ephemeral` プロセスを開始し、会話セッションは再開しません。実証済み最高点、最良FOLD、
試行済み操作など必要なジョブ状態だけを構造化データとして次の一手へ引き継ぎ、99点以上になるまで継続します。
Codex CLIはMacでログイン済みの認証を使用するため、OpenAI APIキーをフロントエンドへ保存しません。

実行中の画面にはAPIの `job.progress` が返す評価済み手数、確定済み最高点、目標点を表示します。
ここでいう一手は累積展開図への折り線追加と、その時点の展開図全体に対するOriedita 2D平坦折り計算です。
折られた紙の3D状態を次の一手へ保持する逐次物理シミュレーションとは表示しません。

```bash
npm run local:oriedita
```

Macへのログイン時に自動起動させる場合:

```bash
npm run local:install
```

ローカルサーバーは `127.0.0.1:8788` のみに接続し、Orieditaを同時操作しないよう一手ずつ処理します。
一手の評価が終わるたびに待ち行列の末尾へ戻すため、99点へ届かない1件が他のジョブを永久に
塞ぎません。各ジョブは `job-state.json` と一手ごとのチェックポイントへ保存され、API再起動後も
最後に確定した一手から再開します。不要になった設計ジョブは `POST /jobs/{jobId}/cancel` で停止できます。
ブラウザ側も実行中ジョブIDを端末内へ保存するため、同じ端末でページを再読み込みしても監視を再開します。
失敗した候補ではGUIのundoに依存せず、変更前の最良FOLDを開き直します。各手の開始FOLDと
最良FOLDを別々に保存するため、処理失敗時も直前の最良版を上書きしません。CodexのMCP操作ログ、
各回の評価、最終FOLD、展開図PNG、折り上がりPNGはジョブ内へ保存します。99点未満では公開結果を
組み立てず、画面には経過秒、評価済み手数、確定済み最高点、目標点だけを表示します。

これは累積展開図を一手ずつ設計する探索です。折られた紙の3Dレイヤー状態を次の一手へ保持する
逐次物理シミュレーションではなく、その実現可能性は未検証として結果へ記録します。
Origami Searchの作品は基本形・特徴・部位・比率・対称性・面積配分の参考にだけ使い、
作品そのものを複製しません。構造パックは完成作品や人間検証済み手順として扱わず、
Orieditaの2D平坦折り検証を通った構造だけを `initial.fold` に使用します。適切な候補が
ない場合は正方形から開始します。どちらの場合も完成結果を即返さず、CodexとOrieditaの反復を
99点到達まで継続します。これはCodexによる2D画像の見た目評価であり、後段の3Dプレビューが
99%の物理的一致を証明するものではありません。

## Oriedita HTTP API

ローカルワーカーには、Orieditaを直接呼び出す非同期APIも含まれます。

- `GET /v1/oriedita/health` — APIとOrieditaの状態
- `POST /v1/oriedita/fold` — FOLD形式の展開図を送信
- `GET /v1/oriedita/jobs/{jobId}` — 状態・展開図画像・折り上がり画像を取得
- `GET /openapi.json` — OpenAPI 3.1仕様

```bash
curl -X POST http://127.0.0.1:8788/v1/oriedita/fold \
  -H 'Content-Type: application/json' \
  --data-binary @request.json
```

`request.json` は `{"fold": { ...FOLD形式のJSON... }}` です。受付時に返る
`job.id` を `/v1/oriedita/jobs/{jobId}` で取得します。公開環境では
`ORI_AI_API_TOKEN` を設定し、`Authorization: Bearer ...` を付けます。

検証用Macの公開トンネルは `npm run local:tunnel:install` で常駐します。
トンネルURLが失効した場合は自動的に再作成してruntimeブランチへ通知するため、
サイト側の接続先を手作業で更新する必要はありません。

## Validation

```bash
npm run build
npm test
```

## Oracle Cloud API

公開利用時は、Oracle Cloud Always FreeのAmpere A1 VMでOrieditaとGroq連携APIを
常時起動します。VMはHTTPSのAPIだけを公開し、Groq APIキーをサーバーの
環境変数として保持します。構築手順は `deploy/oracle/README.md` にあります。

## Publishing

`main` ブランチへのpushでGitHub Actionsが静的サイトをビルドし、
GitHub Pagesへ公開します。

```bash
npm run build:pages
```

- Site: https://yuka-718.github.io/oriai-stepwise/
- Repository: https://github.com/yuka-718/oriai-stepwise

個人連絡先、会議URL、移動・健康など公開に不要な私的情報はサイトへ含めていません。
