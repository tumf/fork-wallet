# fork-wallet DeFi E2E v1 Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** 開発者が管理するEVM DeFiフロントを、アプリの業務コードを変更せず、試験設定だけで接続・送信・署名・障害復旧まで検証できるPlaywright用製品にする。

**Architecture:** 既存の注入Providerを拡張し、試験プロセスが所有するAnvilへ明示的な許可リストで仲介する。ウォレット以外の読取りRPCも同じforkへ統一し、バックエンドはローカル試験環境に置く。承認・送信・署名と障害注入はNode側に残し、ページには鍵・管理RPC・制御ハンドルを渡さない。

**Tech Stack:** Node.js 22以上、既存Playwright、Anvil、node:test。ethers/viem/wagmiはまず互換試験のdevDependenciesのみ。暗号処理はAnvilの署名RPCを第一候補とし、自作しない。

---

## 状態と結論

- 設計案。承認済み仕様でも実装済み機能でもない。今回、コード変更・依存追加・commit・push・署名実行・fork起動はしていない。
- 調査元: `2b33f33215bf086e2e3f691a11f70d08f0760133`、`fork-wallet@0.1.1`。`src/index.js` 286行、実行時依存なし。現在は4 RPCと5 transaction fieldsのみ。
- **実現可能。ただし完成の定義を「試験設定可能なEVM/EOA DeFiフロントのE2E」に限定する。インターネット上の任意のDeFiサイトを設定不要で試験できる製品にはしない。**
- Fableの読取り・取引フィールド・署名・SDK実例の案は採用。ただしそれだけでは足りない。Provider外のRPC、接続権限とイベント、Provider発見、署名の隔離、Anvilの起動終了と証拠まで製品範囲へ含める。
- プロトコル実装、取引作成、残高管理、ABI解釈、取引の正当性判断はdApp/試験側。パッケージにDEXやレンディング固有の処理を持ち込まない。

## 1. 「そのまま使える」の契約

### v1の対象

- 開発者がローカル起動できるEVM dApp。Injected EIP-1193またはEIP-6963経由でEOA接続できること。
- SDKの対象系列はethers v6、viem v2、wagmi v2。実装時にexact versionとlockfileを固定し、結果に記録する。系列全体や将来版の互換性を無条件には主張しない。
- HTTP JSON-RPCを使うpublic client。WebSocket購読が必須ならv1対象外と診断する。HTTP pollingへ試験設定で切替可能なアプリは対象。
- ソースの業務ロジックを変更しない。RPC URL・chain・backend URL・試験口座・fork block・初期状態・期待する要求/結果は試験設定として指定する。
- UI操作のselectorや期待する取引データはアプリごとに必要。これらを自動生成する製品ではない。
- Ethereum、Polygonを最初のfork受入対象とする。L2固有動作は別の受入行を設け、単なるchainId変更で対応済みとしない。

### v1で提供しないもの

- 本番で使うウォレット、ブラウザ拡張、実MetaMask/RabbyのUI・内部挙動の完全再現。
- WalletConnect専用サイト、スマートアカウント/4337、7702認可、5792バッチ実行、blob transaction。
- 実注文API、実リレイヤー、実ブリッジ、実SIWEサーバーへの接続。
- 公開サイトの内部RPC/バックエンドを万能にforkへ置換する機構。
- 最初から複数アカウントのUI再現や任意pluginシステム。アカウント変更試験は同runの予め作成した試験口座間で制御し、実口座importはしない。

### 導入完了の目標

新規利用先は、公開API・README・試験設定だけで動く。パッケージ内部やP-256コードのimport、所有確認のコピペ、SDK側の独自mock connectorは不要とする。インストール手順の再現は、別ディレクトリにpackを導入する試験で証明する。

## 2. 最小構成

```text
Playwright試験プロセス
  - owned Anvilの起動/所有確認/終了、run識別、試験状態の設定
  - 承認制御・要求記録・RPC allowlist・origin検査
  - 必要時だけpublic HTTP RPC用のread-only gateway

ブラウザのdApp
  - EIP-6963でFork Walletを発見（window.ethereumも互換用に提供）
  - request()をNode bindingへ渡す
  - public clientは試験設定で同じforkのread-only gatewayを使う

所有Anvil
  - fresh試験口座、fork状態、実EVM実行と署名
  - fork upstreamは読み取り限定proxy経由

ローカルbackend（利用先の責任）
  - quote / SIWE / order / indexer等を必要な操作に応じて用意
  - 同じforkと試験環境へ接続
```

独立したdaemon、DB、HTTP承認サーバー、ブラウザ拡張は追加しない。既存`installForkWallet`をlow-level APIとして残し、既存サンプルharnessから共通部分を一つの`src/anvil.js`に移す。別entry `fork-wallet/anvil`でowned nodeの起動・終了とread-only URLを提供する。Playwright fixtureは最初はREADMEに一例とし、数十行で足りる限り新たなfixtureフレームワークを作らない。

### 必要な利用設定（概念。まだAPIではない）

```text
origin: local appの完全一致origin
chains: [{ chainId, forkBlock, upstreamRPC }]（複数はswitch試験時だけ）
accounts: fresh generated（通常） / impersonated address（送信のみ）
validateTransaction: 正確なfrom/to/value/data等の期待条件
validateSignature: domain/primaryType/内容、またはpersonal_signの期待bytes
publicRpc: chainId別のローカルread-only URL
network: app/backend/資産の許可先と、明示的なRPC URL対応表
```

既存`beforeSend`はlow-level APIでは保持。owned node helper利用時だけhelperが生成する所有確認をそのまま渡し、一般利用者にlsofコードを書かせない。

接続権限の初期状態、要求記録、release引数は0.1.1との差分が生じる。暗黙互換とはせず次の明示的な非互換リリースとしてmigration例を用意する。既存P-256 consumerは古いtgzのまま維持し、別worktreeで新APIへの移行と回帰試験を通す。移行のために権限検査を無効化する隠れたcompat modeは追加しない。

## 3. Provider/RPCの対応契約

### A. 発見・接続・権限（読取り拡張と同じ優先度）

- `window.ethereum`とEIP-6963のannounce/requestProvider。独自名Fork Wallet、UUIDv4、安全なdata icon、固有rdns。MetaMaskを名乗るflagは追加しない。
- Node側でoriginごとのアカウント公開権限を管理。初期`eth_accounts=[]`。`eth_requestAccounts`で承認後にのみ公開。
- ネットワークに接続していることと、口座公開権限を分離。revokeしても読取り可能ならEIP-1193のdisconnectとはしない。未認可の署名/送信は4100、全chain到達不能は4900、特定chainのみ到達不能は4901とする。4001は明示的な利用者拒否、4200は未対応method、-32602は不正paramsと分ける。
- `connect`、`accountsChanged`、`chainChanged`、`disconnect`、`on/removeListener`とlistener例外の分離。reload/new pageにもNode側の状態を反映する。
- `wallet_getPermissions`/`wallet_requestPermissions`のeth_accountsに限定した実装。revoke互換APIが採用SDKで必要なら公式仕様確認と試験を伴って追加する。
- 非許可originからのbinding呼出しをNodeで拒否。ページに制御権を持たせない。v1はmain frameのみ。iframeはoriginが同じでも自動で許可せず、必要になったとき明示的契約を追加する。

### B. HTTP read RPC

初期allowlist:

```text
eth_chainId, net_version, eth_blockNumber,
eth_getBalance, eth_getCode, eth_getStorageAt, eth_getTransactionCount,
eth_call, eth_estimateGas,
eth_gasPrice, eth_maxPriorityFeePerGas, eth_feeHistory,
eth_getBlockByNumber, eth_getBlockByHash,
eth_getTransactionByHash, eth_getTransactionReceipt, eth_getLogs
```

- `eth_accounts`はAnvilへ素通しせずProviderの許可状態から返す。
- 未知method、`anvil_*`/`evm_*`/`debug_*`/`admin_*`/`personal_*`の総括許可はしない。署名は下記個別methodのみ。
- `eth_call`のfromは、権限があるwallet accountだけに制限しない（任意アドレスで読む用途がある）。送信時のfrom検査と混同しない。state override等は初版の個別schemaが扱わない限り明示拒否。
- JSON-RPCのrevert `error.data`をProviderエラーへ保存し、SDKがrevert理由を解釈できるようにする。現在bindingでdataが落ちる点を修正する。
- パラメータはmethodごとに検証。数値はhex quantityとして扱い、JS numberへ雑に変換しない。JSONサイズ・batch件数・logs範囲・実行timeoutを制限する。
- HTTP gatewayはread allowlistのみ。JSON-RPC batchの各項目を検査し、各idに応じた実結果/エラーを返す。書込みをread gatewayに混ぜない。
- node所有確認とchain整合性はreadにも適用。socket再利用・所有PID・run識別の限界を含めTOCTOU対策を試験する。readデータを取得できたことは送信承認を意味しない。
- `eth_subscribe`/WebSocketは初版非対応。必要なfilter RPCは採用SDKのtraceで確認したものだけ追加する。SDK専用の成功stubは使わない。

### C. transaction

- `eth_sendTransaction`。既存from/to/value/data/chainIdにgas、gasPrice、maxFeePerGas、maxPriorityFeePerGas、nonce、type、accessListを追加する。legacy/type1/type2のみ初版対応。
- gasPriceとEIP-1559 feesの競合、負数/不正quantity、wrong chain/from、不正accessList、unknown fieldsを拒否。`gasLimit`/`input`の別名が必要なら実traceに基づき明示正規化し、元bytesと正規化後を両方記録する。黙って削らない。
- contract deploymentのto不在は仕様として許容し、data必須と利用側policyで制約する。
- SDK指定nonce/feeは保持。省略時はAnvilの補完に委ねる。アプリのnonce再送/replacementを勝手に修正しない。
- `wallet_sendTransaction`は採用viem exact版がfallbackに使うなら、公式契約を確認し同じ送信ゲートへの明示aliasを追加する。今回確認したviem mainソースはこのfallbackを含むが、リリース互換性は未検証。
- `eth_sendRawTransaction`、`eth_signTransaction`、`eth_sign`は初版非対応。ページから署名済取引を投入してpolicyを迂回する経路は作らない。
- `wallet_getCapabilities`は対応していない能力を広告しない。未実装5792は4200としfallbackを試験。成功していないbatchのreceiptを捏造しない。

### D. signing

- `personal_sign([hexBytes, address])`、`eth_signTypedData_v4([address, json])`を対象。対象SDKがobject typed dataを送る場合もschemaが確認できたものだけ受ける。曖昧な順序推測はしない。
- まずowned Anvilの当該RPCを使用できるか、固定版でspikeする。SDKでrecoverし、別の検証器/実コントラクトで検証して初めて採用。eth_signをpersonal_signとして使う推測実装はしない。
- 対応Anvil版で必要な署名RPCがなければ、成熟ライブラリ一つを追加してtest process内でfresh keyを保持する案を比較する。crypto、EIP-712 encode/hashを手書きしない。
- origin/許可account、入力サイズ、domain.chainId（存在する場合）、expected domain/primaryType/messageを送信同様に検証する。EIP-712はchainIdが常に必須とは限らないため、正規のdomain-less形式を無条件で不正扱いせず、利用側policyの明示許可を要求する。
- ABIやPermit2型はcoreに固定しない。coreは正確なtyped payloadとpolicy callbackを仲介し、プロトコル固有のdeadline/spender/nonce検査は試験fixtureが担う。
- SIWEのdomain/scheme/address/chainとrequest originを照合。nonce/expiry/replayのサーバー検証はローカルbackendの責任として実試験する。
- impersonated口座では送信可能でも対応する秘密鍵がない。署名を偽造せず明示的エラー。署名試験にはfresh generated口座を使い、必要なtoken/gasをfork上だけで付与する。

## 4. 障害注入と状態機械

- 要求にNode側requestId、method、origin、chainId、account、sessionEpoch、受付時刻を付与。承認を必要とする接続/切替/署名/送信に共通の最小機構を使う。readには承認モードを適用しない。
- グローバルmodeだけでなく`nextRequest`のmethod指定を用意する。SDKの事前readが「次の拒否」を消費しないようにする。
- 状態は admitted / held / rejected / dispatching / submitted（署名はsigned）/ response-lost / unknown / failed。requestの記録とchain上の実結果を分ける。
- releaseはrequestIdに対し一度だけ。二重releaseはエラー。複数の承認要求は自動承認せずqueueまたは-32002の一貫した契約で制限する。初版は承認待ち1件、並行read許可とする。
- 切替/account変更/revoke/resetはepochを更新し、未dispatch要求を取消し、古い承認で新chainへ送らない。dispatch後の送信は取消し不能。UI切断とオンチェーン実行を別々に記録する。
- 承認はorigin/account/chainId/sessionEpoch/fork世代と不変の要求内容に束縛する。非同期policy/preflight完了後、dispatch直前に再照合し、照合とdispatch状態への遷移の間に別の状態更新を割り込ませない。送信先endpointも受付時の世代に固定する。resetは進行中のdispatchと直列化し、結果不明のまま同じnodeをresetして追跡先を失わない。中止する場合は旧世代のunknown記録を保持してrunを終了する。
- lostは『Anvilがhashを返し記録済みだがページへ返さない』ケース。RPC timeoutでhashを得られない場合はunknownとし、受付前失敗と混同しない。
- dispatch前にrequestId/from/指定nonceを記録する。hash取得後は実取引のsender/nonceを照会して結び付ける。hashや実nonceが取得できなければunknownのままにし、最新nonceから送信成功や失敗を推測しない。
- 送信/署名/承認をwallet内部で自動再試行しない。readの限定retryは別設定とする。SDKやアプリが新しいRPCを送れば新しい要求であり、同じtx bytesを一律dedupeしない（正当な反復操作を壊す）。**exactly-onceは保証しない。**
- lost後のUI再操作で実nonce/イベント/残高を確認し、重複送信が起きたらテストを失敗にする。walletがアプリの不具合を隠さない。
- raw signatureは本物なので、署名lostの際も外部流出を避ける。通常ログにsignatureやpersonal message全文を残さず、hash/サイズと必要最小限の安全なmetadataを残す。
- 署名非保存はwalletログだけでなく、Playwright trace/HAR、console、ページdump、backendログ、Permit署名を含むcalldataにも適用する。署名runでは秘密を含む自動収集を無効化するか、保存前に除去する。証拠はreceipt/イベント/状態差分とpayload hashを中心にし、成果物への署名混入があれば受入を失敗にする。
- accountsのrevoke、transport disconnect、タブclose、reload、node死活停止を別操作として試験し、同じdisconnectで代用しない。

## 5. public RPC・backendを含む整合性

ProviderのRPCを増やしても、wagmiの`transports`やviem Public Clientが元のpublic RPCへ接続する限り、UIの残高/receiptがfork上の実行と食い違う。

1. 推奨: dAppの既存試験設定/envでpublic HTTP RPCをowned read-only gatewayへ指定する。mainnetと同じchainIdを保つforkでもURLを明示する。
2. URLが固定されている場合に限り、試験コードでexact URLをNode側gatewayへrouteする。chainごとの明示mappingのみ。全RPCを一つのAnvilへ無差別転送しない。
3. default-denyのブラウザ通信。新規BrowserContext、serviceWorkers block、実拡張なし。WSは明示拒否。redirect、popups、iframe、sendBeacon、fetch、画像URLへの署名混入も負の試験に含める。
4. Playwright routeだけをセキュリティ境界としない。redirectでの脱出やbrowser以外の通信は別制御が必要。隔離runはOS/container側でbrowser/test backendのegressを拒否する。Anvilからのfork読み取りのみ別経路のallowlist proxyで許可する。
5. Anvilのupstream読み取り用proxyはmethod/endpoint/redirectを制限し、APIキーをbrowser・ログへ渡さない。proxyは公共RPCを送信先として露出しない。
6. 本番quote/order/SIWE/indexerは使わない。必要ならローカルbackendを同じforkへつなぐ。recorded quote等を使う場合は『UI/API seamのみ』と表示し、実約定/決済までPASSとしない。
7. ネットワーク監視結果に未分類の外向き通信があれば受入を失敗にする。安全で整合した環境を用意できないdAppは『設定不足/対象外』で止める。

**重要:** loopbackやforkは暗号学的な安全境界ではない。主チェーンID・同じverifyingContractのEIP-712署名は、実チェーンでも有効になり得る。personal_signはchain-boundでないこともある。実口座鍵を取り込まずrunごとに新規口座を作成し、本番口座として再利用しない。署名を生成するrunは外部backendへ出さない。Anvil管理RPCをページから直接呼べないようにする（read gateway以外のローカルportもブラウザegressで拒否）。同一ホストにいる悪意ある特権プロセスまで防ぐ製品ではない。

## 6. chain switchingの最小対応

- 起動前にchainIdごとのowned nodeとread gatewayを定義。`wallet_switchEthereumChain`はこの表の中だけで切り替え、結果はnull、イベントはhex chainId。
- 未知chainは互換試験で確認した4902、到達不能chainは4901、ユーザー拒否は4001として区別する。4902はEIP-1193標準エラーと混同せずwallet慣行として説明する。
- `wallet_addEthereumChain`はv1では4200で明示拒否する。事前登録済みchainへのswitchで対象操作を試験する。3085はrpcUrlsと実chainIdの照合やURL制約を要求するため、単にmetadataを受け取って成功を返す実装はしない。add必須のdAppは初版の互換表から除外する。将来追加する場合は指定URLの安全な検証と隔離を別設計し、dApp指定URLへ無制限にfetchしない。
- pending transaction/署名を古いchainに保持してから新chainへ承認することは不可。送信済みは元chain上で照会する。
- 二つのfork間を切替可能でもブリッジのクロスチェーン決済は再現していない。

## 7. 完成判定（実行前、すべて未達）

### 互換試験行

| 行 | 固定するもの | 合格の実証 |
|---|---|---|
| ethers BrowserProvider | v6 exact、Anvil版、Chromium版 | 接続/残高/call/estimate/send/receipt/revert data/署名 |
| viem custom | v2 exact、public transportも指定 | 同じ操作。標準retry設定でlost時に何が起きるか記録 |
| wagmi injected | v2 exact、React fixture、通常discovery | 6963で発見、接続/再接続、account/revoke/switch、send/read同一fork |
| 別利用先 | 上記と別の既存dAppの固定commit | アプリ本体無改変、試験設定だけで主要操作が動く |
| pack consumer | 作成tgz、integrity | 別directoryで導入し公開APIだけで実行 |

補足: SDK fixtureは当該操作のブラウザ経路を本当に通す。NodeでSDKを動かしてBrowserContextの成功に見せない。multicall用contractがfork blockに存在するか、必要ならローカルchainへ正規に配備し、欠落時に成功stubへ置換しない。SDKの標準retryで重複が出た場合は、その挙動を不具合/制限として記録し、retryを無効化した行だけで一般互換を主張しない。

SDK系列を列挙するだけではPASSにしない。各exact版のtrace、raw Node policy decisions、receiptとイベントを保存する。未対応methodはmethod名・SDK版・理由を示し、黙って成功させない。

### DeFiシナリオ

- ERC-20 approve + swap: allowance、in/out token残高、minOut、recipient、DEXイベントを照合。
- lending supply + withdraw: underlying/share残高、プロトコルイベント、期待する手数料を照合。最初はborrow/清算まで広げない。
- ERC-2612 permit: 実permit呼出し、allowance/nonce変化、期限切れ・再利用・異domainで失敗。
- Permit2: AllowanceTransferとSignatureTransferを混同せず各1例。実Permit2の検証と転送で成功/不正nonce/再利用/期限切れを確認。
- personal_sign / SIWE: 別ライブラリのrecover、ローカルbackendでnonce・origin・expiry・二重使用検証。
- forkプロトコルはUniswap系swap・Aave系supplyを初期候補とするが、対象chain/blockに実配備されたcontractの正確なaddress/code/versionを調べて固定するまでは試験設計を確定扱いしない。利用可能なローカルcontract fixturesとfork受入を区別する。

### 障害・安全性シナリオ

拒否時に送信/署名ゼロ、hold/release一回、二重release、lost後照会と再操作、node timeout/死亡、broadcast済み切断、revert理由、reload、多タブ、chain/account変更中の承認、unknown処理。別chain/from/origin、悪意のtyped payload、管理RPC、read gateway書込み、public RPC漏れ、redirect/WS/SW/iframe、impersonated署名はすべて負の試験にする。

署名正当性は単にsignatureの長さで判定しない。message recoverとプロトコルcontractの実状態変化で検証する。送信PASSはhash取得だけではなくreceipt.status、必要イベント、nonce/期待状態差分まで必要。

### 製品としての受入

- READMEの一経路でowned node起動・Provider注入・public RPC設定・一取引・後片付けまで実行できる。
- macOS/Linuxを最初の対応ホストにする。各ホストで所有確認・停止を実試験し、Windows未検証を明記する。
- test終了時に所有プロセス/portの停止、隔離解除を確認。失敗時にもcleanupが動く。
- parallel workerごとにAnvil/口座/BrowserContextを分離。時刻・mining設定を固定してdeadline試験を再現する。snapshot/revert/resetはtest processの管理操作のみとし、epochを更新して承認待ち・read cache・nonce状態を破棄する。runを越えてsignature/承認/receipt cacheを再利用しない。
- run metadata: source commit、tgz integrity、SDK/Anvil/Node/Playwright版、fork chain/block/hash、口座種別、requestId、redacted policy結果、tx hash/receipt/state差分、通信遮断の結果。
- 公開ライセンス、npm公開、外部配布、実ウォレット差分検証は別承認。現行private/UNLICENSEDのまま、内部向け完成判定とは分ける。

## 8. 段階別の実装手順と対象ファイル

以下は将来の実装手順。今回は実行しない。各項目は該当する最小ケースを失敗させてから実装し、成功と負の試験を残す。大きなframeworkを先に作らない。

### Task 0: 成立性spike（実装に進む前の中止条件）

**Files:** Create `test/sdk-compat.test.js`、`examples/sdk-compat/`。

1. SDK exact版を一つずつdevDependencyで固定する。
2. 既存Providerにethers/viem/wagmiの標準経路を接続し、失敗method/field/イベントを採取する。
3. owned Anvilのpersonal_sign/v4署名を独立recoverとcontract検証にかける。ランダム口座取得と機密情報なしの起動も確認する。
4. read分離・署名・接続の最小修正で成立するか確認し、非対応SDKの内部偽装が必要なら範囲を狭めるか中止する。
5. 同じシナリオをSynpress EthereumWalletMockで実現できるか比較する。障害注入/所有確認の差分だけ薄く載せる方が小さければ既存機能の再実装を止める。公式APIの存在は確認したが、現在の対応method/実動作は未検証。

### Task 1: 正規RPC/エラー契約

**Files:** Modify `src/index.js`, `index.d.ts`, `test/unit.test.js`; Create `test/provider.test.js`。

1. 接続権限とネットワーク接続を分けた失敗テスト。
2. error.data保持、不正入力、listener例外分離、origin/main-frame判定を実装。
3. read allowlistとtx fieldsをspikeの必要順に追加。未知method拒否は維持。
4. Run: `npm test`。SDKなしでもschema/エラー/権限の回帰試験が走るようにする。

### Task 2: owned Anvil helperと整合するpublic read経路

**Files:** Create `src/anvil.js`, `test/anvil.test.js`; Modify `examples/local-anvil/harness.js`, `package.json`, `index.d.ts`, `test/pack-consumer.js`。

1. 起動失敗/timeout/ownership喪失/終了失敗を先にテスト。
2. 現harnessの最小所有管理を移し、fresh口座・固定fork block・read-only gateway・upstream制限を追加。
3. browserから管理RPCへ直接到達できない隔離例を構築。read gatewayへsend/batch悪用/redirectが拒否されることを確認。
4. 既存low-level利用とpackage導入試験を維持。

### Task 3: 接続発見と安全なchain操作

**Files:** Modify `src/index.js`, `index.d.ts`, `test/provider.test.js`, `test/sdk-compat.test.js`。

1. EIP-6963の初期announce/遅延request/重複/再描画の失敗テスト。
2. legacy injectionと同一Providerをannounceし、名前偽装しない。
3. permission承認/拒否/revokeとNode state復元を追加。
4. 事前定義二node間のswitch、未知chain拒否、pending invalidationを実装。未知URLへ接続しない負の試験。

### Task 4: 要求制御と署名

**Files:** Modify `src/index.js`, `index.d.ts`, `test/unit.test.js`; Create `test/signing.test.js`。

1. requestId/epoch/二重release/同時要求とlost/unknownを先にテスト。
2. dispatch前の再policy/所有確認と、dispatch後取消不能の記録を実装。
3. Task 0で確認したAnvil署名経路を利用し、personal_sign/v4を追加。
4. 同じfixtureで別SDKのrecoverと実permit検証を行い、不正domain/口座/期限/nonceを失敗させる。

### Task 5: 独立DeFi受入

**Files:** Create `test/defi-fork.test.js`, `examples/defi/`（必要な最小contracts/設定/画面のみ）; Modify `test/integration.test.js`, `ACCEPTANCE.md`, `README.md`, `package.json`。

1. 対象プロトコル・chain・block・contract bytecodeとfixtureのライセンスを固定。
2. approve/swap、supply/withdraw、Permit/Permit2、SIWEの証拠を収集。
3. 少なくとも別の既存dAppで、本体に変更を加えず試験設定だけで操作する。
4. SDK traceに合わせ必要なmethodだけ追加し、全method wildcardは導入しない。
5. Run（将来追加するscript）: `npm run test:sdk`, `npm run test:defi`。外部upstream不達はSKIP/blockedで記録し、fixtureの成功でfork成功と代用しない。

### Task 6: 回帰と導入文書

**Files:** Modify `README.md`, `ACCEPTANCE.md`, `test/pack-consumer.js`, `package.json`。

1. `npm test`, `npm run test:integration`, `npm run test:pack`、新SDK/DeFi試験を実行。
2. P-256側の既存登録/鍵変更fork試験を新tgzで別worktreeから実行。既存0.1.1の証拠を新機能の証拠に流用しない。
3. 互換表、非対応method、導入設定、RPCとbackendの責任、署名の危険性、cleanup手順をREADMEへ統合。
4. 実装・検証後に、別承認の範囲でリリース/commit/公開を判断する。今回は行わない。

## 9. 未決事項と止める条件

- 対象SDKのexact versionとそれが実際に必要とするRPCはspikeで確定する。現在の公式docs/source調査は実行互換性の証拠ではない。
- Anvil版によるpersonal_sign/v4・ランダム口座・fork EVM動作の違い。署名をAnvilで完結できなければ成熟library一つを選ぶ判断が必要。
- 固定fork block/address/code、upstream可用性、protocol fixtureライセンスと必要なtoken初期化。
- 隔離runのOS/container実装。Playwright interceptionだけで外部への署名流出を防げるとはしない。隔離できないrunでは署名/本番chainId互換の完成試験を実行しない。
- Fableの実装レビューは過去版の評価。今回の設計は別の設計案でありFable承認済みと表現しない。
- 一般dAppのadapterが大型化したら、万能互換を追うより対応範囲を狭める。既存Synpress等の再利用の方が小さければ切替を優先する。

## 10. 根拠（2026-10-27に公式資料を参照）

- 現行実装: `src/index.js`, `index.d.ts`, `package.json`, `examples/local-anvil/harness.js`。
- EIP-1193: https://eips.ethereum.org/EIPS/eip-1193 （Provider接続と口座公開、error/events）
- EIP-6963: https://eips.ethereum.org/EIPS/eip-6963 （発見/announce）
- EIP-2255: https://eips.ethereum.org/EIPS/eip-2255 （権限）
- EIP-3326 / 3085: https://eips.ethereum.org/EIPS/eip-3326 / https://eips.ethereum.org/EIPS/eip-3085 （chain switch/add。現時点のstatusはFinalではなくStagnant）
- EIP-712 / ERC-2612: https://eips.ethereum.org/EIPS/eip-712 / https://eips.ethereum.org/EIPS/eip-2612 （署名・replay・permit）
- EIP-4361: https://eips.ethereum.org/EIPS/eip-4361 （SIWE request origin/nonce/expiry）
- EIP-5792: https://eips.ethereum.org/EIPS/eip-5792 （capabilitiesとfallback、非対応能力を偽装しない）
- wagmi config: https://wagmi.sh/react/api/createConfig （別transports、EIP-6963 discoveryは既定true）
- wagmi injected: https://wagmi.sh/react/api/connectors/injected （shimDisconnectと実Providerの区別）
- viem custom: https://viem.sh/docs/clients/transports/custom （retryCount等）
- viem send/sign: https://viem.sh/docs/actions/wallet/sendTransaction / https://viem.sh/docs/actions/wallet/signTypedData
- viem current main source: https://raw.githubusercontent.com/wevm/viem/main/src/actions/wallet/sendTransaction.ts （wallet_sendTransaction fallback、リリース版と同一と断定しない）
- ethers pinned source example: https://raw.githubusercontent.com/ethers-io/ethers.js/v6.15.0/src.ts/providers/provider-jsonrpc.ts （gas推定、personal_sign/v4、receipt等）
- Anvil: https://getfoundry.sh/anvil/reference/ / https://getfoundry.sh/anvil/custom-methods （fork block/impersonation/管理RPC）
- Permit2: https://docs.uniswap.org/contracts/permit2/overview （二系統のnonce/expiry）
- Playwright: https://playwright.dev/docs/network （route、redirect、WS、service workerの制限）
- Synpress EthereumWalletMock: https://docs.synpress.io/api-reference/playwright/classes/EthereumWalletMock.md （既存代替のAPI存在を確認。機能比較・実動作は未実施）

検索APIはクレジット不足で失敗したため、公式URLの直接読取りに切り替えた。競合を網羅した調査や実行benchmarksは行っていない。
