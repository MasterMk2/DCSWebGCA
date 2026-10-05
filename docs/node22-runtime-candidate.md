# Node 22 実行環境の移行候補

状態: **レビュー用の移行候補。既存main/latestの更新を伴うmergeは保留。**
アプリ本体と ws の固定依存を変えず、サポート終了したNode20からの移行を検証する。
リリース先・権限・資格情報・実サーバの設定は変更しない。

## 現行から変わる点

- CI: Node20から `.nvmrc` の22.23.3へ
- Docker: `node:20-alpine` から `node:22.23.3-alpine3.24` へ。NodeだけでなくAlpineの基準も明示する
- `npm run doctor` / `npm run check` の共通入口を追加
- smokeは固定の合成fixture・loopback・専用の一時cacheだけを使う。継承されたGCA/Tacview/DCSSB/mock設定を使わない
- package-lock.jsonはbyte単位で維持し、ws8.21.3の版・integrityを変更しない
- package.jsonの歴史的なengines>=18宣言とlock内のアプリ版0.3.0（package.jsonは0.6.0）は今回変更せず、別の整合性確認事項として残す

開発コピーでは次を使う。

```text
node --version
npm --version
npm ci
npm run doctor
npm run check
```

`check` はテストを列挙して実行し、続いて合成TacviewからTCP→REST→WebSocketを通す。
設定は `tests/fixtures/smoke-config.json` に固定し、外部DCSServerBotは無効。
アプリ環境変数だけを除去し、実行環境の制御・proxy等を迂回しない。
`npm run smoke` だけでも同じ分離を使う。通常の `npm start` や本番設定の読み方は変えない。

## Dockerの検証境界

PR CIの `container-candidate` は、実際のAlpine/muslイメージをlinux/amd64としてローカルbuildし、
`--network none`、read-only root、専用tmpfsの下で同じcheckを実行する。
tests/toolsはread-onlyでmountする。外部へ接続できず、portを公開せず、GHCRにlogin/pushしない。
Node/npmの実版をログに残す。実稼働の設定・volume・秘密情報は使わない。

この検査はarm64/Pi、実Tacview/認証/TLS、長時間・多接続負荷を検証しない。
Linux/glibc上のテスト成功だけをAlpine/muslの成功と扱わず、両方の結果をPRに記録する。

## 互換性の観点

Node22は現役LTS、Node20はEOL。Node22.23.3とAlpine3.24の組合せはDocker公式のtag一覧で確認した。
ただしNode公式Docker文書はmuslのplatform support条件を分けているため、実コンテナの検査を省かない。

- `fetch` はNode22でも提供される。本アプリのrunway取得とDocker healthcheckはその実装に依存する
- Node22ではglobal WebSocketが既定で有効。本アプリのサーバとsmokeは明示的にwsをrequireするので、組込み実装へ勝手に切り替えない
- Node22でstreamの既定highWaterMarkが16KiBから64KiBへ変わる。多接続時のメモリ・backpressureは合成の短時間smokeと分けて確認する
- V8/OpenSSL/UndiciとOSライブラリの実版も変わり得る。テスト成功だけで実接続先のTLSや性能まで保証しない

## mergeの公開影響

既存 `.github/workflows/docker.yml` は、このPRでは変更しない。
現行のmain push、v* tag、manual実行でGHCRへimageをpushし、mainではmain/latestタグが更新される。
このpublisherは検査CIと別workflowで、CI成功を待つ依存は定義されていない。
そのため、このruntime変更をmergeすると本番利用候補のimageが変わる。

composeは `ghcr.io/mastermk2/dcswebgca:latest` を参照する。
タグを次に取得する利用側へ新runtimeが波及し得るが、GitHubのimage公開は実サーバの再起動/更新を意味しない。
systemdの `/usr/bin/node` はrepoのpinでは変わらないため、別途実行版を確認する。

## 反映前の残条件

1. Node22/glibcとAlpine/musl双方の全テスト・smokeを確認する
2. 実運用で必要なOS/CPU、TLS/認証、負荷、cache互換性を確認する
3. 今回のmain/latest更新という公開影響をレビューし、runtime変更として反映を決める
4. 現在の稼働image digest・設定・永続cacheを把握し、旧digestへ戻す手順を検証する
5. それまではDraftを維持。新しい公開先、権限、secret、ARM配布をこの候補から追加しない

## 一次資料

- [Node release status](https://nodejs.org/en/about/previous-releases)
- [Node22 global APIs](https://nodejs.org/download/release/latest-v22.x/docs/api/globals.html)
- [Node22 release changes](https://nodejs.org/en/blog/announcements/v22-release-announce)
- [Docker official Node tags](https://raw.githubusercontent.com/docker-library/official-images/master/library/node)
- [Node Docker platform support](https://github.com/nodejs/docker-node/blob/main/README.md)

2026-10-04 UTCに確認。実テストの結果と制約はこの変更のPRに記録する。
