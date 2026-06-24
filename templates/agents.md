# {{AGENT_FILE_NAME}}

{{PROJECT_PURPOSE}}

## 启动流程

写代码前，按顺序完成：

1. **确认工作目录**：运行 `pwd`
2. **完整读完本文件**
3. **读项目文档**（若存在）：`docs/ARCHITECTURE.md`、`docs/PRODUCT.md`、README 或同类文件
4. **运行 `./init.sh`** 验证环境健康
5. **读 `feature_list.json`** 了解当前功能状态
6. **看最近提交**：`git log --oneline -5`

如果基线验证失败，先修好它，再加新功能。

## 工作规则

- **一次一个功能**：从 `feature_list.json` 里挑且只挑一个未完成功能
{{WORKING_RULES}}
- **必须验证**：不跑验证命令不许声称完成
- **更新产物**：会话结束前更新 `progress.md` 和 `feature_list.json`
- **守住范围**：不碰与当前功能无关的文件
- **留干净状态**：下次会话能立刻跑 `./init.sh`

## 关键产物

- `feature_list.json` —— 功能状态追踪（唯一事实源）
- `progress.md` —— 会话连续性日志
- `init.sh` —— 标准启动与验证路径
- `session-handoff.md` —— 可选，用于较大的会话

## 完成的定义

一个功能只有在以下全部为真时才算完成：

{{DONE_CRITERIA}}

## 会话结束流程

结束会话前：

{{END_OF_SESSION}}

## 验证命令

```bash
# 完整验证（推荐）
{{PRIMARY_VERIFICATION_COMMAND}}
```

需要执行的检查：
{{VERIFICATION_COMMANDS}}

## 升级处理

遇到以下情况：
- **架构决策**：查项目架构文档，没有就问用户
- **需求不清**：查产品/需求文档，没有就问用户
- **反复测试失败**：更新 `progress.md`，标记给人审查
- **范围含糊**：重读 `feature_list.json` 的完成定义
