# tools

对接与测试工具（架构设计第 3 节）。在仓库根目录用 uv 运行，Python 3.10。

## 样例数据 `sample_data`

生成符合接口文档第 10、11 节的工件模型和规划文件，供性能验证、mock 服务端和测试使用。工件放在 i5H 的工作范围内，关节轨迹按开发用 URDF（`app/public/robot/aubo_i5H_dev.urdf`）逆解求出，工具末端沿 TCP 路径运动。

```bash
uv run python -m tools.sample_data --size small   # 29 个表面、930 个三角面、665 点
uv run python -m tools.sample_data --size large   # 483 个表面、292,834 个三角面、98,459 点
```

输出到 `samples/<规模>/`（不提交）：`models/<model_id>.glb`、`plans/<plan_id>.json` 和 `manifest.json`，目录结构与接口文档第 9 节一致。

## 文件校验 `validate`

按接口文档第 10、11 节检查 GLB 和规划文件（接口文档 15.1），服务端可以用它自测导出功能。

```bash
uv run python -m tools.validate --model 模型.glb --plan 规划.json --urdf 机械臂.urdf --tcp-link TCP连杆名
```

- 同时给出模型和规划文件时做交叉检查：ID、表面是否存在且可清洗、工艺段 TCP 点是否贴近模型表面。最后一项能发现 Y-up 转换、单位或坐标系不一致。
- 给出 URDF 时检查关节名和关节范围；再给出 TCP 连杆名时，按正运动学核对工具末端是否沿 TCP 路径。
- 有错误时退出码为 1。同一问题只列出前 5 处，其余计数。

| 参数 | 说明 |
| --- | --- |
| `--model-id`、`--plan-id` | 期望的 ID |
| `--tcp-tolerance` | 工艺段 TCP 点到模型表面的允许距离，默认 0.05 米。TCP 不在工件表面上时调大 |
| `--fk-tolerance` | 正运动学与 TCP 路径的允许偏差，默认 0.005 米 |
| `--json` | 以 JSON 输出结果 |

## 接口检查 `interface_check`

经 rosbridge 和 HTTP 检查服务端是否符合接口文档（阶段 5）。
