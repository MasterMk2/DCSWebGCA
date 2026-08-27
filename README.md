<div align="center">

<img src="public/icon.svg" width="120" alt="DCS Web GCA logo" />

# DCS Web GCA

**Web-based ATC console (GCA / GCI / TWR) for DCS World dedicated servers**

</div>

DCS World Dedicated Server 向けのブラウザベース管制コンソールです。
導入済みの **Tacview** のリアルタイム ACMI テレメトリを TCP で購読し、進入誘導を計算して
WebSocket でブラウザの管制画面に配信します。DCS 側に追加の Lua や MOD は要りません。

## アーキテクチャ

```
[DCS Server 1..N] --(Tacview real-time telemetry, TCP)--> +---------------------+
                                                          |  dcs-web-gca (Node) |
[DCSServerBot RestAPI] --(滑走路ジオメトリ, HTTP)-------->  |  ACMI parse         |
                                                          |  トラック状態管理    |
                                                          |  進入誘導計算        |
                                                          +----------+----------+
                                                                     |
                                        HTTP (静的 + REST) / WS (5Hz スナップショット)
                                                                     v
                                                      [ブラウザ] GCA / GCI / TWR
```

- 1 プロセスで **複数の DCS サーバ** を同時購読する (`sources[]`)。ブラウザ側で切り替える。
- HD / ワイド画面ではスコープとテーブルを左右 2 カラムに並べる (CSS grid)。
- ブラウザごとに (サーバ, 滑走路) を選ぶ。他の管制官の画面には影響しない。
- 滑走路は **DCS 実データ**から取得する (下記)。マップが変わっても設定を書き換えなくてよい。

## 管制モード

| モード | 概要 |
|---|---|
| **GCA (PAR)** | 精密進入レーダー。方位スコープ + 仰角スコープ + 進入諸元テーブル。**トークダウン文** ("Viper-1, 5.2 miles from touchdown, on course, on glidepath, altitude should be 1900 feet.") を自動生成し Talk-down Log に流す |
| **GCI** | 迎撃管制。PPI スコープ (10/20/40/80 nm + ホイールズーム、速度ベクトル付き)。**ドラッグでスコープをパン** (CENTER ボタンで滑走路末端に戻る)、**カーソル位置の Bullseye 方位/距離**を常時表示。自機 (OWN) と目標 (TARGET) を指定すると STEER / CLOSURE / TTI / 高度差を表示 |
| **TWR** | 飛行場管制。滑走路と進入センターラインを描いたスコープ (既定 6 nm、ホイールで 1〜15 nm ズーム) + 場周トラフィック一覧 (対地高度付き) |
| **LSO** | 空母着艦支援。空母 (Sea) トラックを基準に、グライドスロープ偏差 (3° 対 HIGH/LOW)、ラインアップ (R/L)、距離・対デッキ高度・AoA (対応ストリームのみ) をラインアップ断面 + 側面 GP 断面の 2 パネルと Approach Data に表示。CARRIER / AIRCRAFT はドロップダウンかブラー選択、ホイール/ピンチで 1〜8 nm ズーム |

## マップ背景とレイテンシー表示

- ヘッダーの **MAP** ボタンで GCI/TWR のレーダー画面に OpenStreetMap タイルの地図背景を重ねられる
  (ON/OFF は `localStorage` に記憶)。タイルは薄く (α35%) 描画され、取得失敗時 (オフライン等) は
  自動的に従来通りのレーダーのみ表示にフォールバックする。
- ヘッダーの **LAT** 表示は WebSocket メッセージの受信レイテンシー (サーバー送信時刻 `sentAt` →
  ブラウザ受信)。時計差が大きい場合はスナップショット経過時間へフォールバックする。

## Bullseye (GCI)

ACMI ストリーム中の `Type=Navaid+Static+Bullseye` オブジェクトを連合ごとに保持し、GCI 画面で
カーソル位置の **BULLS(色) 方位/距離** (真方位・nm) を表示します。マーカーもスコープ上に描画します。

- Bullseye は**ミッション開始時に一度だけ**送られる静的オブジェクトなので、トラックの stale 削除
  (`staleAfterSec`) の対象外として別に保持する。ストリーム再接続時のみクリアされる。
- 連合ごとに複数ある場合は GCI 画面の **BULLS** セレクタで切り替える (1 つだけなら非表示)。
- 座標は DCS ネイティブ (u/v) が両側にあればそのまま平面計算し、無ければ lat/lon で中点緯度の
  スケールを使う (Bullseye は 50 nm 以上離れることがあり、末端の cos(lat) では誤差が出るため)。
- 実サーバで Bullseye が流れているかは `TACVIEW_DEBUG=1` + `GET /api/diagnostics` の
  `types.counts` に `Bullseye` を含む Type があるかで確認できる。

## 滑走路データ

GCA の精度は滑走路末端の座標精度そのものなので、手打ちせず **DCS 自身から取得**します。
DCSServerBot の RestAPI 経由で `Airbase.getRunways()` の結果 (滑走路中心の DCS 座標・course・
length・width) を引き、両端の末端座標を計算します。

```
GET {baseUrl}{prefix}/servers                                -> theatre / status / 地上風
GET {baseUrl}{prefix}/airbases?server_name=...               -> 飛行場一覧 (bot のキャッシュ)
GET {baseUrl}{prefix}/airbase?server_name=&airbase_name=...  -> 滑走路 (ミッションスレッドで Lua 実行)
```

- 最後の 1 本はシムスレッドを触るので **1.5 秒間隔**で舐め、結果は **theatre 単位で
  `cache/runways_<theatre>.json` に保存**する。同じマップなら 2 回目以降は sweep しない
  (別サーバが同じマップを開いた場合もキャッシュを共有する)。
- ミッション変更 (ACMI の `Title` 変化) を検知して 15 秒後に再取得。サーバが停止中の場合は
  sweep せず、キャッシュがあればそれを使う。
- DCSSB が無い環境では `sources[].runways[]` に手書きした滑走路がそのまま使われる
  (両方ある場合は手書きが優先)。
- 初期表示の滑走路は `defaultAirbase` の両端のうち**向かい風側**を自動選択する。

## ACMI / Tacview プロトコル実装メモ

DCS + Tacview 1.9.5 の実ストリームに合わせてある。ハマりどころ:

- ハンドシェイクは `XtraLib.Stream.0\nTacview.RealTimeTelemetry.0\n<client>\n<password>\0`。
  これを送らないとホストは 1 バイトも返さない。
- 行は `<id>,<key>=<value>,...`。**プロパティはカンマ区切り、`T=` の中身はパイプ区切り**。
- `T=` のフィールド数で意味が変わる:
  `3 = lon|lat|alt` / `5 = lon|lat|alt|u|v` / `9 = lon|lat|alt|roll|pitch|yaw|u|v|heading`。
  9 フィールド前提で決め打ちすると 5 フィールド時に u/v が roll/pitch に化ける。
- lon/lat はヘッダの `ReferenceLongitude` / `ReferenceLatitude` からの**相対値**。
- `u`/`v` は記録のネイティブ直交座標 = **DCS のミッション座標 (メートル)**。`u = DCS z (東)`、
  `v = DCS x (北)`。DCSSB から取る滑走路座標と同じ系なので、投影誤差ゼロで進入計算ができる。
- 値の中のカンマ・改行はバックスラッシュエスケープ。ブリーフィングは複数行にまたがる。
- 機体タイプは `Air+FixedWing` / `Air+Rotorcraft` のようなタグ列。`Airplane` ではない。
- **DCS は IAS/TAS を出さない**。速度は連続する位置サンプルから対地速度として算出している。

## 設定

`config/config.json` (無ければ `config/config.example.json` にフォールバック)。

| キー | 意味 |
|---|---|
| `server.port` / `server.bind` | HTTP/WS の待受 |
| `server.broadcastIntervalMs` | スナップショット配信間隔 (既定 200ms = 5Hz) |
| `dcssb.enabled` / `baseUrl` / `prefix` / `apiKey` | DCSServerBot RestAPI |
| `dcssb.requestSpacingMs` | airbase sweep の間隔 (シム負荷対策、既定 1500ms) |
| `gca.azToleranceDeg` / `gsToleranceDeg` | ON COURSE / ON GLIDEPATH と判定する幅 |
| `gca.talkdownIntervalSec` / `talkdownMaxRangeNm` | トークダウンの再送間隔と対象距離 |
| `sources[].tacview` | 各 DCS サーバの Tacview リアルタイムポート |
| `sources[].dcssbServerName` | DCSServerBot 上のサーバ名 (servers.yaml と一致させる) |
| `sources[].defaultAirbase` | 初期表示の飛行場 (向かい風側の末端が選ばれる) |
| `sources[].runways[]` | 手書き滑走路 (任意) |

環境変数で上書きできるもの: `GCA_CONFIG` `GCA_PORT` `GCA_BIND` `GCA_CACHE_DIR`
`DCSSB_BASE_URL` `DCSSB_API_PREFIX` `DCSSB_API_KEY` `TACVIEW_HOST` `TACVIEW_PORT`
`TACVIEW_PASSWORD` (後者 3 つは 1 番目の source に適用、開発用)。

**API キーは設定ファイルに書かず `DCSSB_API_KEY` で渡すこと。**

## API

| エンドポイント | 内容 |
|---|---|
| `GET /api/config` | source 一覧と誘導パラメータ |
| `GET /api/runways?source=` | 滑走路定義と取得状態 |
| `GET /api/state?source=&runway=` | 現在のスナップショット (REST フォールバック) |
| `GET /api/health` | source ごとの接続状態 (200 / 503) |
| `WS /ws` | `hello` / `sources` / `runways` / `tracks` / `transcript`。クライアントから `subscribe` `selectRunway` `refreshRunways` |

静的ファイルの参照はすべて相対パスなので、`/gca/` のようなサブパス配下に
リバースプロキシしても動く。

## ローカル開発

```bash
npm install

# ターミナル1: モック Tacview サーバ (本物と同じハンドシェイク + ACMI 2.2 を喋る)
npm run mock

# ターミナル2:
TACVIEW_PORT=34251 npm start     # http://localhost:8080
```

テスト:

```bash
npm run test:parser   # ACMI パーサ / 進入計算のユニットテスト (実ストリームの行を使用)
npm run smoke         # mock + サーバを起動して REST と WS を検証
npm test              # 両方
```

## デプロイ (Docker)

GitHub Actions (`.github/workflows/docker.yml`) が `main` への push と `v*` タグで
`ghcr.io/mastermk2/dcswebgca` を自動ビルドする。リポジトリが private の間は
package も private なので、pull 側で `docker login ghcr.io` (read:packages 権限の PAT) が要る。

```bash
# 1) 公開イメージを使う
docker compose up -d          # docker-compose.yml は ghcr.io の latest を参照

# 2) 手元のコードで動かす (fork/改造中はこちら)
docker compose up -d --build  # docker-compose.yml の build: . を有効化
# あるいは
docker build -t dcs-web-gca .
docker run -d --name dcs-web-gca \
  -p 8080:8080 \
  -e DCSSB_API_KEY=xxxxx \
  -v $PWD/config/config.json:/app/config/config.json:ro \
  -v dcs_web_gca_cache:/app/cache \
  dcs-web-gca
```

- `/app/cache` は滑走路キャッシュ。volume を当てないと再作成のたびに airbase sweep
  (= シムスレッドでの Lua 実行) をやり直すので、必ず永続化する。
- DCS / DCSServerBot と同じ Docker ネットワークに載せると、`dcs-server-1:18131` のような
  コンテナ名で Tacview ポートに到達できる。複数サーバ構成の実例は
  `ffs-dcs-server/docker-compose.yml` の `dcs-web-gca` サービスを参照。

## デプロイ (systemd)

```bash
sudo mkdir -p /opt/dcs-web-gca && sudo chown $USER /opt/dcs-web-gca
git clone https://github.com/MasterMk2/DCSWebGCA.git /opt/dcs-web-gca
cd /opt/dcs-web-gca && npm install --omit=dev
cp config/config.example.json config/config.json   # 編集する
sudo cp deploy/dcswebgca.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now dcswebgca
```

HTTPS で出す場合は `deploy/nginx-gca.conf` (nginx) か、Caddy なら:

```caddy
redir /gca /gca/
handle_path /gca/* {
    reverse_proxy dcs-web-gca:8080
}
```

## 誘導ロジック

滑走路末端を原点、進入コースを軸とした座標系で各機について計算する:

- **RNG**: 末端までの水平距離 (nm)
- **AZ DEV**: 進入コースからの方位偏差 (deg, R/L)
- **GS DEV**: グライドパス角に対する仰角偏差 (deg, HIGH/LOW)
- **GP ALT**: その距離でのグライドパス上の高度 (ft)
- **Guidance**: `ON COURSE / FLY LEFT / FLY RIGHT` × `ON GLIDEPATH / COMING HIGH / COMING LOW`
- **Talk-down**: 初回・偏差状態の変化時・15 秒ごとに PAR 型の誘導文を生成

既定のしきい値は方位 ±0.8°、グライドパス ±0.4°。

## ライセンス

MIT
