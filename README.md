# Dispatcher（调度员）

[Paseo](https://paseo.sh) 插件：常驻调度员按登记分管项目，按角色把活派给执行会话，并行会话线、换班、巡检和工作区清理都由插件管。功能说明见 [OVERVIEW.md](OVERVIEW.md)。

## 安装

需要 Paseo 0.16.0 及以上，并在 **Settings → Plugins** 里打开插件。

```bash
paseo plugin install github:SpiderManii/dispatcher
```

更新到最新版：`paseo plugin update dispatcher`。

## 第一次使用（约 15 分钟）

1. **装好后打开侧边栏的「调度员」。** 插件在调度目录 `~/.paseo/dispatch-center`（可用环境变量 `PASEO_DISPATCH_HOME` 改）生成：
   - `registry.json`：项目登记，一个调度员、没有项目；
   - `rules.md`：调度规则，从插件自带的通用模板 [templates/rules.md](templates/rules.md) 复制过来。已经有 `rules.md` 时不覆盖。
2. **给角色选模型。** 在「维护」→「Agent 分工」→「设置」里，给调度员和每个角色（拆分、后端、前端、设计、测试、审查、架构）选 provider 和模型，可以排几个备选。没设的用第一个就绪的 provider，能跑但不一定合适。建议：调度员用便宜、快的模型；拆分、审查、架构用推理强的；前端、后端用你最顺手的编程模型。
3. **登记项目。** 在「指派任务」里添加项目文件夹。插件读仓库，在调度目录下生成一份草稿 `PROJECT.md` 和进度目录，并登记进 `registry.json`。
4. **核对 PROJECT.md。** 标「待核对」的逐条改掉，至少：
   - 「运行与测试」：本地怎么启动、跑哪条测试命令；
   - 「红线」：哪些目录和文件不能碰、代码能放到哪里；
   - 「提交」：提交用的名字和邮箱（不写就用仓库现有的 git 配置）；
   - 「部署」：不部署就写「不部署」。
   二三十行就够，目的是让调度员和执行会话不用猜、不用扫全仓。
5. **派第一单。** 在「指派任务」里选项目，写一句需求和「怎么算做完」，发出去。之后在页面上看进度、答复待拍板、点「同意合回」「推送」。

## 按需调整

- **规则**：直接改 `rules.md`，改完在页面点「同步规则」，之后新开的调度员会话用新规则；在跑的会话不会中途换规则，要用就在对话里让它重读自己的 AGENTS.md。插件只按节号引用规则（第 2、3、4、5、6、9、11、13 节），改内容时保留 14 节的编号和标题。只跟自己电脑有关的东西（代理、服务器、提交身份）写进 PROJECT.md 或下面的 `workerMust`，规则就能原样分享给别人。
- **部署**：默认没有部署角色，部署和连服务器的事会交给你。要让调度员部署，在「Agent 分工」里添加角色 `deploy`，把步骤、回滚方法写进项目 PROJECT.md 的「部署」，服务名写进登记里该项目的 `deployTargets`，页面「部署」按钮就能点选。凭据各人用自己的，不要共用一套。
- **`registry.json` 里的可选字段**：
  - `limits`：并行上限，默认会话线 5 条（同项目 3 条），执行会话 3 个（其中 Claude 2 个）；
  - `workerMust`：附加到每张任务卡「必守」里的话，比如提交身份、禁止的命令；
  - `quotaUrl`：额度接口，配了派单前会查额度、跳过用完的家，不配就不查；
  - `quotaStopBelow`：停单线（剩余百分比，如 `20`），某家低于它就不再接新的施工卡，只派收尾的卡，适合隔夜无人值守；要配 `quotaUrl` 才生效；
  - `keep`：工作区清理永远不提供的工作区 ID 或分支名。

## 多人使用

每人装自己的一份，调度目录、规则、登记都在各自电脑上。插件的「改动范围」冲突检查只看本机的会话线，几个人改同一个仓库时，靠分支约定避开同一批文件。

## 本地开发

```bash
npm install
npm run typecheck
npm test
paseo plugin install /absolute/path/to/dispatcher
paseo plugin reload dispatcher   # 改完代码后
```

## 许可证

[MIT](LICENSE) © SpiderManii
