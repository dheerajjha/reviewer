# reviewer

[English](../README.md) · **简体中文** · [日本語](README.ja.md)

> 这是英文 README 的精简翻译。完整、最新的说明以[英文版](../README.md)为准。

当代码由智能体来写，读代码就成了瓶颈。而专门用来读 diff 的工具，也就是
Pull Request，偏偏要你先建分支、配远程、再推送，而这一步你此刻还不想做。

reviewer 直接把工作目录里的改动变成 Pull Request 式的审阅界面：评论精确地挂在
你指的那一行上，还能跟帖回复；不需要分支、不需要远程仓库、不需要推送，也不需要
账号。审阅写完后，它把这份带批注的审阅交还给智能体去执行。

```bash
npm install -g git-reviewer

cd ~/your-project
git reviewer | claude -p "Apply this review."
```

`git reviewer` 会在浏览器中打开审阅页面。你点击 **Submit Review** 时，审阅内容
写到标准输出，命令随即退出，于是管道另一端的智能体立刻开始工作。不用复制，不用
第二条命令，也不用去找文件。

不想安装的话，`npx git-reviewer` 效果相同。它不会往项目里装任何东西，无需登录，
数据不会离开你的电脑。

## 在智能体内部使用

作为插件安装后，智能体会自己打开审阅页面，等你阅读和评论，并在你点击
**Submit Review** 后逐条处理你的评论。

```
/plugin install git-reviewer --marketplace dheerajjha/reviewer
```

以上是 Claude Code。装好后让它“审阅一下改动”，或运行 `/git-reviewer:review`。
同一个技能也能装到别的智能体里：

| 智能体 | 安装 |
|---|---|
| Codex CLI | `codex plugin marketplace add dheerajjha/reviewer`，然后 `codex plugin add git-reviewer@git-reviewer` |
| Cursor | **Customize** → **From GitHub Repository** → `dheerajjha/reviewer` |
| Copilot CLI | `copilot plugin marketplace add dheerajjha/reviewer`，然后 `copilot plugin install git-reviewer@git-reviewer` |
| 其他 | `npx skills add dheerajjha/reviewer` |

## 分两步交接

审阅和交接不在同一时间进行时：

```bash
git reviewer                                        # 阅读 diff，写评论
git reviewer export . --format prompt | claude -p "Apply this review."
```

评论会跨会话保存。即使代码在下面移动，包括智能体自己的修改让后面所有行号都发生
偏移，评论也能找回原来的位置：昨天写的审阅，今天依然指向正确的行。

## 常用选项

| 命令或选项 | 作用 |
|---|---|
| `git reviewer [路径]` | 审阅某个仓库，默认是当前目录 |
| `--staged` | 只审阅已暂存的改动 |
| `--no-open` | 只打印地址，不打开浏览器 |
| `-p, --port <n>` | 监听的端口，默认 4500 |
| `git reviewer export . --format prompt` | 打印已保存的审阅，交给智能体 |

更多内容，比如比较分支和提交、HTTP API、安全设计，请看[英文 README](../README.md)。

## 许可证

MIT
