/** 配置文件的结构与校验（需求 10.2）。保存覆盖配置前、启动合并后都用它检查。 */
import { z } from 'zod'

const positiveMs = z.number().int().positive()
const vec3 = z.tuple([z.number(), z.number(), z.number()])

export const configSchema = z
  .object({
    config_version: z.number().int().positive(),
    server: z.object({
      rosbridge_url: z.string().regex(/^wss?:\/\/[^/\s]+/, '应以 ws:// 或 wss:// 开头'),
      http_base_url: z.string().regex(/^https?:\/\/[^/\s]+/, '应以 http:// 或 https:// 开头'),
    }),
    timing: z.object({
      state_timeout_ms: positiveMs,
      reconnect_interval_ms: positiveMs,
      service_timeout_ms: positiveMs,
      estop_timeout_ms: positiveMs,
    }),
    robot: z.object({
      urdf: z.string().min(1),
      packages: z.record(z.string(), z.string()),
      joint_name_map: z.record(z.string(), z.string()),
    }),
    scene: z.object({
      default_view_direction: vec3.refine((v) => v.some((x) => x !== 0), '观察方向不能为零向量'),
      default_target: vec3,
      tap_threshold_px: z.number().nonnegative(),
      zoom_min_ratio: z.number().positive(),
      zoom_max_ratio: z.number().positive(),
      path_arrow_spacing_m: z.number().positive(),
      grid_size_m: z.number().positive(),
      grid_cell_m: z.number().positive(),
    }),
    animation: z.object({ speeds: z.array(z.number().positive()).min(1) }),
  })
  .refine((c) => c.scene.zoom_min_ratio < c.scene.zoom_max_ratio, {
    message: 'zoom_min_ratio 应小于 zoom_max_ratio',
    path: ['scene', 'zoom_min_ratio'],
  })

export type Config = z.infer<typeof configSchema>

/** 校验失败时的说明，每个问题一行，写明字段路径。 */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(根)'}：${issue.message}`)
    .join('\n')
}
