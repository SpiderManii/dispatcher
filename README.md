# Dispatcher（调度员）

[Paseo](https://paseo.sh) 插件：常驻调度员按登记分管项目，按角色把活派给执行会话，并行会话线、换班、巡检和工作区清理都由插件管。功能说明见 [OVERVIEW.md](OVERVIEW.md)。

## 安装

需要 Paseo 0.15.3 及以上，并在 **Settings → Plugins** 里打开插件。

```bash
paseo plugin install github:SpiderManii/dispatcher
```

本地开发：

```bash
npm install
npm run typecheck
npm test
paseo plugin install /absolute/path/to/dispatcher
paseo plugin reload dispatcher   # 改完代码后
```

## 第一次使用

1. 插件第一次运行时在 `~/Paseo调度中心`（或 `PASEO_DISPATCH_HOME`）生成 `项目登记.json`：一个调度员，没有项目。
2. 在同一目录写调度员规则 `调度员.md`。插件不带规则模板，没有这个文件就不会创建调度员会话。
3. 在 `项目登记.json` 的 `projects` 里登记项目，或在「调度员」页面的「指派任务」里添加项目文件夹。
4. 在「Agent 分工」→「设置」里给调度员和各角色选模型。不设就用第一个就绪的 provider。

## 许可证

[MIT](LICENSE) © SpiderManii
