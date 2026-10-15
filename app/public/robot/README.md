# 机械臂模型（开发用）

APP 在服务端交付正式 URDF 之前使用的 AUBO i5H 模型（阶段规划第 3 节）。

| 文件 | 说明 |
| --- | --- |
| `aubo_description/urdf/aubo_i5H.urdf` | 遨博官方 URDF，未修改 |
| `aubo_description/meshes/aubo_i5H/visual/link0.DAE`–`link6.DAE` | 官方显示网格。官方仓库中它们是指向 `aubo_i5`、`aubo_i3H` 的符号链接，这里是实际文件 |
| `aubo_i5H_dev.urdf` | 由官方 URDF 生成：去掉碰撞网格（未随附），增加示意工具 `tool_link`（沿法兰 Z 轴 0.15 米的圆柱）和 TCP 坐标系 `tcp_link` |

- 来源：[AuboRobot/aubo_description](https://github.com/AuboRobot/aubo_description) 提交 `47fa5e02fa873f27f7e812d31f31e3f4cf5e56b1`（包版本 1.3.3）。
- 许可证：BSD（以该包 `package.xml` 的声明为准）。
- 配置中 `package://aubo_description/` 映射到本目录下的 `aubo_description/`（需求文档 10.2）。
- 官方 DAE 网格在 three.js 中默认完全透明，加载后需要修正材质（架构设计 5.6）。
