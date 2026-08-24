# Issue #8 実機検証手順（1フライトで全項目採取）

Issue: [#8 実機DCS+Tacview環境での実測検証](https://github.com/MasterMk2/DCSWebGCA/issues/8)

本リポジトリには「観測モード（プロトコル診断）」が実装されており、**実フライト1回分のログで
Issue #8 の未検証7項目すべてのエビデンスを採取**できます。

## 0. 事前準備と採取手順

### 起動

DCS サーバと同じ要領で、観測モードを有効にして GCA サーバを起動します。

```bash
TACVIEW_DEBUG=1 TACVIEW_DEBUG_DUMP=diagnostics.json npm start
```

- `TACVIEW_DEBUG=1` … 観測モード有効化（無効時は集計処理自体が走らない＝オーバーヘッドゼロ）
- `TACVIEW_DEBUG_DUMP=path` … 集計結果を5秒間隔で JSON ファイルへ自動ダンプ（任意。
  Windows ではシグナルが使えないため環境変数方式。指定しない場合は HTTP API で取得）

config.json で設定する場合の Tacview 接続先（host / port / password）は従来どおりです。

### フライト中

通常どおり GCA コンソールでアプローチ誘導を行います。裏で以下が自動蓄積されます。

### 採取（フライト後すぐに）

ブラウザまたは curl で診断スナップショットを取得して保存します。

```bash
curl -s http://127.0.0.1:8080/api/diagnostics -o diagnostics-api.json
curl -s "http://127.0.0.1:8080/api/state" -o state.json
```

認証トークンを設定している場合は `?token=...` または `Authorization: Bearer ...` を付けてください。

以降の「確認箇所」は `GET /api/diagnostics` のレスポンス（＝ `TACVIEW_DEBUG_DUMP` のダンプ内容、
形式は同一）の JSON パス、および `GET /api/state` のフィールド名です。

---

## 1. ハンドシェイク（パスワードあり/なし）

**確認箇所:** `sources[0].handshake`

ホスト（DCS Tacview エクスポータ）からのハンドシェイク応答の生文字列（初回のみ保存）。
`XtraLib.Stream.0` / `Tacview.RealTimeTelemetry.0` / ホスト名 / パスワード行 の4行構成をそのまま確認できる。

- **パスワードなし環境:** `handshake` が取得でき、その後 `transforms.total` が増え続ければ OK
- **パスワードあり環境:** 正しいパスワードで起動した場合のみ上記と同じ結果になること。
  誤パスワードでは `handshake` 自体が取得できない／`/api/health` の `connected` が false のまま
  （ローカルでの再現には `MOCK_PASSWORD=<pass> node tools/mock-tacview.js` +
  `TACVIEW_PASSWORD=<pass>` / `<誤り>` で確認可能。モックは不一致時に接続を切断する）

## 2. ReferenceLongitude / ReferenceLatitude の有無と値

**確認箇所:** `sources[0].reference.declared` / `sources[0].reference.longitude` / `sources[0].reference.latitude`

- `declared` にキーが現れれば「そのグローバルプロパティがストリームで宣言された」ことを意味する
- `longitude` / `latitude` は実数値（例: Batumi なら lon≈41.6, lat≈37.3 程度）
- 両方 `null` のままなら「参照点なし（絶対座標ストリーム）」という実測事実になる

## 3. u/v 軸仮説の実証

**確認箇所:** `sources[0].uvSamples`（最初の5機体分）

各サンプルは同一時点の3組を並べて記録している:

| フィールド | 意味 |
|---|---|
| `lonRel`, `latRel` | ホストから受信した生の相対経緯度（Reference* 未適用） |
| `lon`, `lat` | Reference* 適用後の絶対経緯度 |
| `u`, `v` | ネイティブ直交座標（メートル） |

仮説「u = DCS z（東方向）, v = DCS x（北方向）」は次の手順で検証する:

1. `uvSamples[i]` の `(lonRel, latRel)` をメートル換算する:
   `東距離 ≈ lonRel × 111320 × cos(reference.latitude)`, `北距離 ≈ latRel × 111320`
2. 換算値と `u`, `v` が一致し、かつ符号も一致すれば仮説を実ログで実証できたことになる
3. 可能なら DCS 内の既知地点（滑走路端など）の mission 座標 (x, z) と突き合わせる

あわせて `sources[0].transforms.histogram` に `9`（9フィールド形 = u/v を含む形）が出現している
ことも確認する。

## 4. transform フィールド数

**確認箇所:** `sources[0].transforms.histogram`（出現分布）/ `sources[0].transforms.total`（合計）

例: `{"9": 4521, "5": 12}` → 9フィールド形が支配的で、部分更新（空フィールド圧縮後の5フィールド等）
が混在する、という実態がヒストグラムで分かる。ACMI 仕様上の 3/5/9 以外の値が出た場合は
パーサの想定外であり、その値を Issue に記録する。

## 5. Type 文字列の実値

**確認箇所:** `sources[0].types.counts`（全件数一覧）/ `types.distinct`（種類数）/ `types.total`（合計）

実環境で流れた Type 文字列（例: `Air+FixedWing`, `Ground+Static+Aerodrome`, `Sea+Watercraft` 等）
と出現回数がすべて分かる。コンソールに表示される機体だけを抽出したい場合は
`GET /api/state` の `tracks[].category` も参照（`FixedWing` / `Rotorcraft` 等に正規化済み）。

## 6. 対地速度 vs DCS 表示

**確認箇所:** `sources[0].groundSpeed.samples` / `groundSpeed.meanMs` / `groundSpeed.meanKt`

u/v 差分から求めた対地速度の統計（サンプル数・平均 m/s・平均ノット）。
フライト中に DCS 画面（HUD / F3 視点の速度表示など）を読み上げ、平均ノットと比較する:

- 差が概ね ±10 kt 以内 → u/v 差分方式の妥当性確認 OK
- 大きく乖離する場合は風の影響（IAS/TAS/GS の違い）を考慮し、`uvSamples` の座標から
  手計算で再確認する

個別機体の瞬時値は `GET /api/state` の `tracks[].gsKt` を参照。

## 7. AZ/GS 偏差の外部照合

**確認箇所:** `GET /api/state` の `tracks[].approach.azDevDeg` / `approach.gsDevDeg` / `approach.rangeNm`

フライト中にパイロット（または別クライアントの Tacview 再生等の外部ツール）と照合する:

1. 進入中の機体を選び、コンソール表示の AZ/GS 偏差とレンジを読み取る
2. 外部ツール（Tacview デスクトップ版で同ストリームを再生、または DCS 内 F10 マップ等）で
   同一機体のセンターlineからのずれ・降下角を測る
3. 両者の差が許容範囲（AZ ±0.8°, GS ±0.4° の設定値に対して有意に大きくない）なら OK

`state.json` を保存しておけば、時刻 `sentAt` 付きで後から照合できる。

---

## 全項目採取のチェックリスト（クローズ条件）

| # | 項目 | エビデンス | 判定 |
|---|------|-----------|------|
| ① | ハンドシェイク | `diagnostics.handshake` 生文字列（あり/なし両環境） | ☐ |
| ② | Reference* | `reference.declared` + `reference.longitude/latitude` | ☐ |
| ③ | u/v 軸仮説 | `uvSamples` の座標換算一致 + `transforms.histogram["9"] > 0` | ☐ |
| ④ | transform フィールド数 | `transforms.histogram` 分布 | ☐ |
| ⑤ | Type 文字列 | `types.counts` 一覧 | ☐ |
| ⑥ | 対地速度 | `groundSpeed.meanKt` vs DCS 表示速度 | ☐ |
| ⑦ | AZ/GS 偏差 | `/api/state` の `azDevDeg/gsDevDeg` vs 外部照合 | ☐ |

7項目すべてのエビデンス（`diagnostics.json` / `diagnostics-api.json` / `state.json` と
比較メモ）が揃ったら、Issue #8 に貼り付けてクローズできる。

## 補足: ローカルでの予行演習

実機の前にモックで手順を通せる:

```bash
node tools/mock-tacview.js            # 端末1（MOCK_PASSWORD=xxx でパスワード保護も可）
TACVIEW_PORT=34251 TACVIEW_DEBUG=1 npm start   # 端末2
curl http://127.0.0.1:8080/api/diagnostics     # 端末3
```
