# reviewer

[English](../README.md) · [简体中文](README.zh-CN.md) · **日本語**

> 英語版 README の要約翻訳です。正確で最新の内容は[英語版](../README.md)を参照してください。

コードをエージェントが書くようになると、ボトルネックはコードを読むことになります。
ところが diff を読むための道具であるプルリクエストは、ブランチを切り、リモートを
用意し、プッシュすることを求めます。まだその段階ではないのに。

reviewer は作業ディレクトリの変更を、そのままプルリクエスト風のレビュー画面で
開きます。コメントは指した行にぴったり付き、スレッドで返信もできます。ブランチも
リモートもプッシュもアカウントも要りません。書き終えたレビューは、エージェントに
そのまま渡して対応させられます。

```bash
npm install -g git-reviewer

cd ~/your-project
git reviewer | claude -p "Apply this review."
```

`git reviewer` はブラウザでレビュー画面を開きます。**Submit Review** を押すと
レビューが標準出力に書き出されてコマンドが終了し、パイプの先のエージェントが
すぐに作業を始めます。コピーも、二つ目のコマンドも、ファイル探しも要りません。

インストールしたくなければ `npx git-reviewer` でも同じように動きます。プロジェクトに
何もインストールせず、ログインも不要で、データはあなたのマシンから出ていきません。

## エージェントの中から使う

プラグインとして入れると、エージェントが自分でレビュー画面を開き、あなたが読んで
コメントするのを待ち、**Submit Review** を押した瞬間からコメントを一つずつ
片付けていきます。

```
/plugin install git-reviewer --marketplace dheerajjha/reviewer
```

これは Claude Code の場合です。入れたら「変更をレビューさせて」と頼むか、
`/git-reviewer:review` を実行します。同じスキルは他のエージェントにも入ります。

| エージェント | インストール |
|---|---|
| Codex CLI | `codex plugin marketplace add dheerajjha/reviewer` のあと `codex plugin add git-reviewer@git-reviewer` |
| Cursor | **Customize** → **From GitHub Repository** → `dheerajjha/reviewer` |
| Copilot CLI | `copilot plugin marketplace add dheerajjha/reviewer` のあと `copilot plugin install git-reviewer@git-reviewer` |
| その他 | `npx skills add dheerajjha/reviewer` |

## 二段階で渡す

レビューと引き渡しのタイミングが違うときは:

```bash
git reviewer                                        # diff を読んでコメントする
git reviewer export . --format prompt | claude -p "Apply this review."
```

コメントはセッションをまたいで保存されます。コードが動いても、エージェント自身の
編集で下の行番号がすべてずれても、元の場所を見つけ直します。昨日書いたレビューは
今日も正しい行を指しています。

## よく使うオプション

| コマンド・オプション | 内容 |
|---|---|
| `git reviewer [パス]` | リポジトリをレビューする(既定はカレントディレクトリ) |
| `--staged` | ステージ済みの変更だけをレビューする |
| `--no-open` | ブラウザを開かず URL だけ表示する |
| `-p, --port <n>` | 待ち受けポート(既定は 4500) |
| `git reviewer export . --format prompt` | 保存したレビューを出力してエージェントに渡す |

ブランチやコミットの比較、HTTP API、セキュリティ設計などの詳細は
[英語版 README](../README.md) をご覧ください。

## ライセンス

MIT
